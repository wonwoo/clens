/**
 * Append path for a Codex rollout that only grew, beside append.ts's for
 * Claude Code transcripts. A Codex line cannot be parsed alone: the parser
 * carries the model, token counts, open calls and running commands from line
 * to line (SessionState in codex_parser.ts), and a later line can add a file
 * op or a hook block to an earlier call's event or change an earlier call's
 * result. So the state each parse of a rollout ends with is kept in memory,
 * for the last CODEX_STATES_KEPT rollouts used, and the lines after
 * file_cursor.last_ok are parsed from it. The rows are written only when the
 * guards below prove them equal to what re-deriving the session would write
 * (gate 2, see driver.ts); otherwise `full` is returned before anything is
 * written, and runIndex re-derives the file and keeps a fresh state.
 *
 * The state lives only in this process: the watcher keeps it across runs,
 * `clens index` does not, and after a restart the first change of each
 * rollout goes the full way. Keeping it in the index would change the schema.
 */

import type Database from "better-sqlite3";

import { finishAppend, readAppended, type AppendFallback, type AppendOutcome, type SessionRow } from "./append.js";
import { parseCodexLines, type CodexResume } from "./codex_parser.js";
import { filterCodexSkillCandidates, skillDecisionsHold, type SkillDecisions } from "./codex_skills.js";
import type { DiscoveredFile } from "./cursor.js";
import { toSqlBindable, type WriterStatements } from "./writer.js";
import type { AnomalyBatch, ParsedEvent, ToolResultInfo } from "./types.js";

/** How many rollouts keep their state. One state took 0.5-2.1 MB for
 *  rollouts of 2.5-37.4 MB; a few sessions are live at a time. */
export const CODEX_STATES_KEPT = 16;

interface Kept {
  resume: CodexResume;
  /** file_cursor.last_ok and .lines the state was parsed up to. */
  last_ok: number;
  lines: number;
  /** The decision taken for every "$name" candidate of those lines. */
  skills: SkillDecisions;
  /** The call ids of those lines whose tool_call row was parsed with its
   *  duration (prefilledCallIds). */
  prefilled: ReadonlySet<string>;
}

/** Path → kept state, least recently used first. */
const kept = new Map<string, Kept>();

/** Keep the state a parse of `path` ended with, as the most recently used;
 *  null forgets the path. */
export function keepCodexState(
  path: string,
  resume: CodexResume | null,
  last_ok: number,
  lines: number,
  skills: SkillDecisions,
  prefilled: ReadonlySet<string>,
): void {
  kept.delete(path);
  if (resume === null) return;
  kept.set(path, { resume, last_ok, lines, skills, prefilled });
  for (const oldest of kept.keys()) {
    if (kept.size <= CODEX_STATES_KEPT) break;
    kept.delete(oldest);
  }
}

/** Add to `into` the call ids of `events` whose tool_call row was parsed with
 *  its duration (a McpToolCall item): updateToolCallResult leaves such a row
 *  as it is. */
export function prefilledCallIds(events: ParsedEvent[], into: Set<string> = new Set()): Set<string> {
  for (const p of events) {
    for (const c of p.tool_calls) if (c.call_id !== null && c.duration_ms !== null) into.add(c.call_id);
  }
  return into;
}

/** Forget every kept state (tests). */
export function forgetCodexStates(): void {
  kept.clear();
}

/** The lengths of a parsed event's child-row arrays, in this order. */
function childCounts(p: ParsedEvent): number[] {
  return [
    p.tool_calls.length,
    p.file_ops.length,
    p.user_texts.length,
    p.skill_calls.length,
    p.agent_calls.length,
    p.slash_commands.length,
    p.system_reminders.length,
    p.hook_blocks.length,
    p.unknown_blocks.length,
  ];
}
const FILE_OPS = 1;
const HOOK_BLOCKS = 7;

/**
 * Index only the lines appended to rollout `f` since its cursor, when that
 * gives the same rows as re-deriving its session; otherwise return `full`
 * without writing. Must run under the index lock, as runIndex holds it.
 */
export function appendCodexLines(db: Database.Database, stmts: WriterStatements, f: DiscoveredFile): AppendOutcome {
  const full = (reason: AppendFallback): AppendOutcome => ({ kind: "full", reason });
  // Parsing changes the kept state, so it is put back only after the rows
  // are written; on `full` the full path keeps a fresh one.
  const entry = kept.get(f.path);
  kept.delete(f.path);

  // 1-3: the bytes before last_ok are the ones already indexed.
  const read = readAppended(db, f);
  if (typeof read === "string") return full(read);
  const { cursor, from, bytes, start } = read;
  if (entry === undefined || entry.last_ok !== cursor.last_ok || entry.lines !== cursor.lines) return full("no_state");
  const { state, toolResults } = entry.resume;
  // A full index now would decide every earlier candidate again; the rows
  // stand only while each decision comes out the same.
  if (!skillDecisionsHold(entry.skills, state.cwd)) return full("skills_changed");

  // 4: a first line that is not JSON is most likely the tail of a line that
  // was rewritten in place, not a line of its own.
  const firstEnd = bytes.indexOf(0x0a, start);
  if (firstEnd !== -1) {
    try {
      JSON.parse(bytes.subarray(start, firstEnd).toString("utf8"));
    } catch {
      return full("torn_first_line");
    }
  }

  // What the new lines may change in what is already written: the session
  // row and project come from the state's meta, file ops and hook blocks are
  // added to earlier calls' events, and later lines change earlier results.
  const metaOf = () => [state.session_id, state.cwd, state.git_branch, state.version, state.kind, state.parentId];
  const metaBefore = metaOf();
  const countsBefore = new Map<ParsedEvent, number[]>();
  for (const p of state.callEvents.values()) countsBefore.set(p, childCounts(p));
  const resultsBefore = new Map<string, ToolResultInfo>(toolResults);

  const batch: AnomalyBatch = {
    counters: new Map(),
    session_id: null,
    ts: new Date(Math.floor(f.mtime * 1000)).toISOString(),
    source_file: f.path,
  };
  const events: ParsedEvent[] = [];
  const parsed = parseCodexLines({
    buf: bytes,
    start,
    first_seq: cursor.lines + 1,
    source_file: f.path,
    resume: entry.resume,
    batch,
    events,
  });
  const skills = filterCodexSkillCandidates(events, state.cwd, new Map(entry.skills));
  if (metaOf().some((v, i) => v !== metaBefore[i])) return full("meta_changed");

  // 5-7: re-deriving writes every session of the file and wipes every row of
  // them, so the new lines and the stored rows must all be this rollout's own.
  const own = state.session_id;
  if (own === null) return full("no_session_row");
  const session = db
    .prepare("SELECT kind, parent_id, started_at, ended_at, cwd, git_branch, version, model_primary FROM session WHERE id = ?")
    .get(own) as SessionRow | undefined;
  if (session === undefined) return full("no_session_row");
  // Lines before the rollout's session_meta go to a session of their own,
  // whose span and primary model a re-derivation sets from the whole file.
  if (db.prepare("SELECT 1 FROM event WHERE source_file = ? AND session_id IS NOT ? LIMIT 1").get(f.path, own) !== undefined) {
    return full("several_sessions");
  }
  if (events.some((p) => p.event.session_id !== own)) return full("other_session");
  if (db.prepare("SELECT 1 FROM event WHERE session_id = ? AND source_file IS NOT ? LIMIT 1").get(own, f.path) !== undefined) {
    return full("several_files");
  }

  // Only file ops and hook blocks are written to earlier events below; no
  // line adds anything else to one today.
  const grown: [ParsedEvent, number[]][] = [];
  for (const [p, before] of countsBefore) {
    const now = childCounts(p);
    if (now.every((n, i) => n === before[i])) continue;
    if (now.some((n, i) => i !== FILE_OPS && i !== HOOK_BLOCKS && n !== before[i])) return full("earlier_event_changed");
    grown.push([p, before]);
  }

  // 11: rows the new lines would replace.
  const knownUuid = db.prepare("SELECT 1 FROM event WHERE uuid = ?");
  if (events.some((p) => knownUuid.get(p.event.uuid) !== undefined)) return full("known_uuid");

  // Results. Re-deriving this rollout deletes its tool_call rows, writes
  // them again, and runs its results through applyToolResults: each call's
  // newest result fills every row of that call id whose duration is still
  // empty, in any session. So the rows written below equal a re-derivation's
  // only while no call id of this rollout, of a row, a new call or a result,
  // is held by another session's row (that row would take this rollout's
  // result too), and while each own row holds only what this rollout's own
  // results gave it (another file's result can fill an empty own row).
  const prefilled = prefilledCallIds(events, new Set(entry.prefilled));
  const elsewhere = db.prepare("SELECT 1 FROM tool_call WHERE call_id = ? AND session_id IS NOT ? LIMIT 1");
  const ownRows = db
    .prepare(
      `SELECT o.call_id AS call_id, o.duration_ms IS NOT NULL AS filled,
              EXISTS (SELECT 1 FROM tool_call x WHERE x.call_id = o.call_id AND x.session_id IS NOT o.session_id) AS shared
       FROM tool_call o WHERE o.session_id = ? AND o.call_id IS NOT NULL`,
    )
    .all(own) as { call_id: string; filled: number; shared: number }[];
  const ownIds = new Set<string>();
  for (const r of ownRows) {
    if (r.shared || (r.filled && !resultsBefore.has(r.call_id) && !prefilled.has(r.call_id))) return full("shared_call_id");
    ownIds.add(r.call_id);
  }
  // A prefilled call id must name one row, or the check above cannot tell
  // which of its rows was parsed with its duration.
  const rowsOf = new Map<string, number>();
  for (const r of ownRows) rowsOf.set(r.call_id, (rowsOf.get(r.call_id) ?? 0) + 1);
  for (const p of events) for (const c of p.tool_calls) if (c.call_id !== null) rowsOf.set(c.call_id, (rowsOf.get(c.call_id) ?? 0) + 1);
  for (const id of prefilled) if ((rowsOf.get(id) ?? 0) > 1) return full("prefilled_result");
  for (const p of events) {
    for (const c of p.tool_calls) if (c.call_id !== null && !ownIds.has(c.call_id) && elsewhere.get(c.call_id, own) !== undefined) return full("shared_call_id");
  }
  for (const id of toolResults.keys()) if (!ownIds.has(id) && elsewhere.get(id, own) !== undefined) return full("shared_call_id");

  // With no call id shared, a result changes only this rollout's rows: the
  // ones the new lines set or replaced, and the ones earlier lines left for
  // calls the new lines bring.
  const newCalls = new Set(events.flatMap((p) => p.tool_calls.map((c) => c.call_id)));
  const results = [...toolResults].filter(([id, r]) => resultsBefore.get(id) !== r || newCalls.has(id));
  // A row parsed with its duration keeps it, which setToolCallResult would not.
  if (results.some(([id]) => prefilled.has(id))) return full("prefilled_result");

  const last_ok = from + parsed.last_ok;
  const lines = cursor.lines + parsed.terminated;
  const outcome = finishAppend(db, stmts, {
    f,
    cursor,
    own,
    session,
    events,
    batch,
    terminated: parsed.terminated,
    last_ok,
    writeExtra: () => {
      for (const [p, before] of grown) {
        for (const r of p.file_ops.slice(before[FILE_OPS])) stmts.insertFileOp.run(toSqlBindable(r));
        for (const r of p.hook_blocks.slice(before[HOOK_BLOCKS])) stmts.insertHookBlock.run(toSqlBindable(r));
      }
      for (const [call_id, r] of results) {
        stmts.setToolCallResult.run({
          call_id,
          session_id: own,
          result_ts: r.ts,
          is_error: r.is_error,
          result_chars: r.result_chars,
          error_excerpt: r.error_excerpt,
        });
      }
    },
  });
  if (outcome.kind === "appended") keepCodexState(f.path, entry.resume, last_ok, lines, skills, prefilled);
  return outcome;
}
