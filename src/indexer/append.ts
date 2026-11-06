/**
 * Append path for a Claude Code transcript that only grew. Re-deriving a
 * session costs as much as its whole file (about 0.8 s for a 40 MB live
 * transcript, on every line Claude Code appends), so the lines after
 * file_cursor.last_ok are parsed and written on their own, but only when the
 * guards below prove the rows equal what re-deriving the session would write
 * (gate 2, see driver.ts). Otherwise `full` is returned before anything is
 * written, and runIndex re-derives the file as before.
 *
 * Codex rollouts never come here: their parser carries the model, token
 * counts and open calls from earlier lines into later events, which the
 * index does not keep.
 */

import { closeSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import type Database from "better-sqlite3";

import { agentSessionId, assignTurnNumbers, parseEventLine, SUBAGENT_FILE_RE } from "./claude_parser.js";
import { upsertCursor, type DiscoveredFile, type FileCursorRow } from "./cursor.js";
import { applyToolResults, writeParsedEvent, type WriterStatements } from "./writer.js";
import type { AnomalyBatch, ParsedEvent, ToolResultInfo } from "./types.js";

/** Why a file goes the full way, one value per guard, in the order checked. */
export type AppendFallback =
  | "no_cursor" | "shrunk" | "not_line_start" | "torn_first_line"
  | "no_session_row" | "several_sessions" | "copied_lines" | "other_session" | "several_files"
  | "late_meta" | "sdk_entrypoint" | "sidechain" | "known_uuid"
  | "result_exists" | "out_of_order" | "model_tie";

export type AppendOutcome =
  | { kind: "appended"; events: number; parse_errors: number }
  | { kind: "full"; reason: AppendFallback };

interface SessionRow {
  kind: string | null;
  parent_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  cwd: string | null;
  git_branch: string | null;
  version: string | null;
  model_primary: string | null;
}

/** The bytes of `path` from `start` to `end`, or null when the file now ends
 *  before `end` (it was cut after it was listed). */
function readRange(path: string, start: number, end: number): Buffer | null {
  const buf = Buffer.alloc(end - start);
  const fd = openSync(path, "r");
  try {
    let got = 0;
    while (got < buf.byteLength) {
      const n = readSync(fd, buf, got, buf.byteLength - got, start + got);
      if (n === 0) return null;
      got += n;
    }
  } finally {
    closeSync(fd);
  }
  return buf;
}

/**
 * Index only the lines appended to `f` since its cursor, when that gives the
 * same rows as re-deriving its session; otherwise return `full` without
 * writing. Must run under the index lock, as runIndex holds it.
 */
export function appendNewLines(
  db: Database.Database,
  stmts: WriterStatements,
  f: DiscoveredFile,
): AppendOutcome {
  const full = (reason: AppendFallback): AppendOutcome => ({ kind: "full", reason });

  // 1-3: the bytes before last_ok are the ones already indexed.
  const cursor = db.prepare("SELECT path, mtime, size, lines, last_ok FROM file_cursor WHERE path = ?").get(f.path) as
    | FileCursorRow
    | undefined;
  if (cursor === undefined) return full("no_cursor");
  // The full path stores the size listed before the read, and last_ok from
  // the read itself, so last_ok can pass `size` when the file grew between
  // the two; a file shorter than last_ok lost indexed bytes.
  if (f.size < cursor.size || f.size < cursor.last_ok) return full("shrunk");
  const from = cursor.last_ok > 0 ? cursor.last_ok - 1 : 0;
  const bytes = readRange(f.path, from, f.size);
  if (bytes === null) return full("shrunk");
  if (cursor.last_ok > 0 && bytes[0] !== 0x0a) return full("not_line_start");

  // 4: parse the new lines that end in \n, as parseFileBody does; a partial
  // last line is left for a later run.
  const batch: AnomalyBatch = {
    counters: new Map(),
    session_id: null,
    ts: new Date(Math.floor(f.mtime * 1000)).toISOString(),
    source_file: f.path,
  };
  const toolResults = new Map<string, ToolResultInfo>();
  let events: ParsedEvent[] = [];
  const meta = { cwd: false, gitBranch: false, version: false, sdkEntrypoint: false };
  // `bytes` starts at `from`: at the \n checked above, when last_ok is past 0.
  let lineStart = cursor.last_ok - from;
  let terminated = 0;
  for (let i = lineStart; i < bytes.byteLength; i++) {
    if (bytes[i] !== 0x0a) continue;
    const line = bytes.subarray(lineStart, i).toString("utf8");
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      // A first line that is not JSON is most likely the tail of a line that
      // was rewritten in place, not a line of its own.
      if (terminated === 0) return full("torn_first_line");
    }
    terminated += 1;
    const p = parseEventLine(line, f.path, cursor.lines + terminated, batch, toolResults);
    if (p !== null) events.push(p);
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>;
      if (typeof o.cwd === "string") meta.cwd = true;
      if (typeof o.gitBranch === "string") meta.gitBranch = true;
      if (typeof o.version === "string") meta.version = true;
      if (typeof o.entrypoint === "string" && o.entrypoint.startsWith("sdk-")) meta.sdkEntrypoint = true;
    }
    lineStart = i + 1;
  }

  // 5: the session this file belongs to.
  const subagentFile = SUBAGENT_FILE_RE.test(f.path);
  const fileSessions = (db.prepare("SELECT DISTINCT session_id FROM event WHERE source_file = ?").all(f.path) as {
    session_id: string;
  }[]).map((r) => r.session_id);
  if (fileSessions.length === 0) return full("no_session_row");
  // A main file is named after its session (every main transcript on disk
  // ends with a line of that session); a subagent file's own session is the
  // one its rows hold.
  const own = subagentFile ? fileSessions[0]! : basename(f.path, ".jsonl");
  if (fileSessions.length > 1 || fileSessions[0] !== own) return full("several_sessions");
  // A main file writes another session's lines only while that session has
  // no rows (writableEvents), so once it skipped some, re-deriving it can
  // write a different set of its old lines; only a re-derivation sees that.
  if (
    !subagentFile &&
    db.prepare("SELECT 1 FROM anomaly WHERE source_file = ? AND kind = 'copied_session_line_skipped' LIMIT 1").get(f.path) !== undefined
  ) {
    return full("copied_lines");
  }
  if (subagentFile) {
    // As writableEvents does: only the subagent's own lines are written.
    const kept = events.filter((p) => p.event.agent_id !== null && p.event.session_id === agentSessionId(p.event.agent_id));
    const skipped = events.length - kept.length;
    if (skipped > 0) {
      const cur = batch.counters.get("subagent_line_skipped");
      if (cur) cur.count += skipped;
      else batch.counters.set("subagent_line_skipped", { count: skipped, detail: null });
    }
    events = kept;
  }
  const session = db
    .prepare("SELECT kind, parent_id, started_at, ended_at, cwd, git_branch, version, model_primary FROM session WHERE id = ?")
    .get(own) as SessionRow | undefined;
  if (session === undefined) return full("no_session_row");

  // 6-7: re-deriving writes every session of the file and wipes every row of
  // them, so the new lines and the stored rows must all be this file's own.
  if (events.some((p) => p.event.session_id !== own)) return full("other_session");
  if (db.prepare("SELECT 1 FROM event WHERE session_id = ? AND source_file IS NOT ? LIMIT 1").get(own, f.path) !== undefined) {
    return full("several_files");
  }

  // 8-10: the session row takes cwd, gitBranch and version from the first
  // line that carries each, a subagent's parent from its first own line, and
  // its kind from the first entrypoint and from any sidechain line.
  if (
    (session.cwd === null && meta.cwd) ||
    (session.git_branch === null && meta.gitBranch) ||
    (session.version === null && meta.version) ||
    (subagentFile && session.parent_id === null && events.length > 0)
  ) {
    return full("late_meta");
  }
  // Only an interactive session can have had no entrypoint before; an exec
  // one already started with sdk-.
  if (session.kind === "interactive" && meta.sdkEntrypoint) return full("sdk_entrypoint");
  if (session.kind !== "subagent" && events.some((p) => p.event.is_sidechain === 1)) return full("sidechain");

  // 11-12: rows the new lines would replace or change after the fact.
  const knownUuid = db.prepare("SELECT 1 FROM event WHERE uuid = ?");
  if (events.some((p) => knownUuid.get(p.event.uuid) !== undefined)) return full("known_uuid");
  // Re-deriving applies the newest result of a call; here the first applied
  // one stays (updateToolCallResult only fills an empty row).
  const answered = db.prepare("SELECT 1 FROM tool_call WHERE call_id = ? AND duration_ms IS NOT NULL LIMIT 1");
  for (const callId of toolResults.keys()) {
    if (answered.get(callId) !== undefined) return full("result_exists");
  }

  // 13: turn numbers continue from the stored ones only when every new
  // numbered event sorts after them. assignTurnNumbers numbers the new events
  // here so the rule for which events get a number stays in one place; an
  // equal time passes, as the stable sort keeps the later line after it.
  assignTurnNumbers(events);
  const last = db
    .prepare(
      `SELECT MAX(ts) AS ts, MAX(user_turn_no) AS user_turn_no, MAX(assistant_turn_no) AS assistant_turn_no FROM event
       WHERE session_id = ? AND (user_turn_no IS NOT NULL OR assistant_turn_no IS NOT NULL)`,
    )
    .get(own) as { ts: string | null; user_turn_no: number | null; assistant_turn_no: number | null };
  const numbered = events.filter((p) => p.event.user_turn_no !== null || p.event.assistant_turn_no !== null);
  if (last.ts !== null && numbered.some((p) => p.event.ts < last.ts!)) return full("out_of_order");

  // 14: the primary model is the most frequent one, a tie going to the one
  // seen first in the file, which the index does not keep. Without a new
  // assistant model the counts stand and the stored value is the one a
  // re-derivation would write.
  let primaryModel = session.model_primary;
  const newModels = events.filter((p) => p.event.role === "assistant" && typeof p.event.model === "string");
  if (newModels.length > 0) {
    const counts = new Map<string, number>();
    const stored = db
      .prepare("SELECT model, COUNT(*) AS n FROM event WHERE session_id = ? AND role = 'assistant' AND model IS NOT NULL GROUP BY model")
      .all(own) as { model: string; n: number }[];
    for (const r of stored) counts.set(r.model, r.n);
    for (const p of newModels) counts.set(p.event.model!, (counts.get(p.event.model!) ?? 0) + 1);
    const ranked = [...counts].sort((x, y) => y[1] - x[1]);
    if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) return full("model_tie");
    primaryModel = ranked[0]![0];
  }

  db.transaction(() => {
    for (const p of events) {
      if (p.event.user_turn_no !== null) p.event.user_turn_no += last.user_turn_no ?? 0;
      if (p.event.assistant_turn_no !== null) p.event.assistant_turn_no += last.assistant_turn_no ?? 0;
      // No known tokens: these messages are new to the analyzer.
      writeParsedEvent(stmts, p);
    }
    applyToolResults(stmts, toolResults);

    let startedAt = session.started_at;
    let endedAt = session.ended_at;
    for (const p of events) {
      if (startedAt === null || p.event.ts < startedAt) startedAt = p.event.ts;
      if (endedAt === null || p.event.ts > endedAt) endedAt = p.event.ts;
    }
    db.prepare("UPDATE session SET started_at = ?, ended_at = ?, model_primary = ? WHERE id = ?").run(
      startedAt,
      endedAt,
      primaryModel,
      own,
    );

    // The full path counts anomalies over the whole file and stamps them with
    // its mtime and the session of the file's first event: add the new
    // counts to the stored ones, keeping the last detail as bumpAnomaly does.
    const stored = db.prepare("SELECT kind, count, detail, session_id FROM anomaly WHERE source_file = ?").all(f.path) as {
      kind: string;
      count: number;
      detail: string | null;
      session_id: string | null;
    }[];
    const merged = new Map(stored.map((r) => [r.kind, { count: r.count, detail: r.detail }]));
    for (const [kind, { count, detail }] of batch.counters) {
      const m = merged.get(kind);
      if (m === undefined) merged.set(kind, { count, detail });
      else {
        m.count += count;
        if (detail !== null) m.detail = detail;
      }
    }
    // With no stored rows no line was skipped, so the file's first event is
    // one of its own session's.
    const anomalySession = stored.length > 0 ? stored[0]!.session_id : own;
    stmts.wipeAnomaliesForFile.run(f.path);
    for (const [kind, { count, detail }] of merged) {
      stmts.insertAnomaly.run({ session_id: anomalySession, ts: batch.ts, kind, count, detail, source_file: f.path });
    }

    upsertCursor(db, {
      path: f.path,
      mtime: f.mtime,
      size: f.size,
      lines: cursor.lines + terminated,
      last_ok: from + lineStart,
    });
  })();

  return { kind: "appended", events: events.length, parse_errors: batch.counters.get("json_parse_error")?.count ?? 0 };
}
