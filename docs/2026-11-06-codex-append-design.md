# Append-Only Indexing of Growing Codex Rollouts Design

## Context

Since 0.2.8 (commit `59cf911`, design `docs/2026-11-06-append-index-design.md`), `runIndex()` indexes only the lines appended to a Claude Code transcript (`appendNewLines`, `src/indexer/append.ts`) and re-derives the session only when the index cannot prove the result equals a re-derivation. Codex rollouts were left on the full path: every change to a rollout re-reads the file from its first byte and re-derives its session. On this machine 17 of 1,344 rollouts under `~/.codex/sessions` are over 5 MB and the largest is 57.8 MB; re-deriving it takes 508–540 ms per change (experiment C5).

A Claude Code line can be parsed alone; a Codex line cannot. `parseCodexFileBody` carries a `SessionState` from line to line (`src/indexer/codex_parser.ts:497-545`): the model from `turn_context`, token counts until `task_complete`, open exec calls, running processes and cells, and the calls seen so far. A later line also changes what earlier lines produced: a call's output adds a hook block to the call's event (`codex_parser.ts:881`), a `CommandExecution` item adds file ops to an open exec call (`readCommandExecution`, `codex_parser.ts:1114-1136`), and a later `wait` or `write_stdin` output rewrites an earlier call's result (`codex_parser.ts:847, 866`). No later line assigns a field of an earlier event (searched: no assignment to `event.*` or `tool_calls[0].*` of an earlier event).

Goal: index only the lines appended to a Codex rollout, with rows identical to a re-derivation, falling back to the full path whenever that cannot be guaranteed.

Success criteria:

1. An index run that only sees appended lines of a rollout takes time proportional to those lines, not to the file (C5: 2.7–11.8 ms against 508–540 ms on the 57.8 MB rollout).
2. Gate 2 holds after every run: the digest of an index grown run by run equals the digest of a rebuild on the same files (`digestAllTables`, `src/indexer/digest.ts:53`).
3. No schema change and no `SCHEMA_VERSION` bump.
4. The Claude Code append path keeps its behavior: every Claude Code test in `test/driver_append.spec.ts` passes unchanged. Its one Codex test, T6 (`test/driver_append.spec.ts:367-386`, "re-derives a grown Codex rollout", `files_appended` 0), asserts the behavior this design replaces; step 5 changes it to expect the append (`files_appended` 1), and nothing else in the file is edited.

Decisions:

- The parser state a parse ends with is kept in the watcher's memory, per rollout, and the next run resumes from it (conversation, 2026-11-06; experiments C1–C9). Storing it in the index was set aside because it changes the schema.
- The result must not differ from a full index (the user, 2026-11-06: "전체 색인할떄랑 다른점이 있음 안된다"). For a rollout that only grew since its last index, this holds whatever else changed on disk, skill folders included: every input outside the new lines that a full index reads is checked again, and a change sends the run the full way (the skill guard, C8 and C10). A rollout whose already-indexed bytes were rewritten in place is outside the append contract, as on the Claude Code path approved for 0.2.8; the guards catch a rewrite that leaves a trace at the cursor (Known Limits).
- The structure follows the Claude Code path: same fallback vocabulary (`AppendFallback`), same outcome type, same writes for the session row, anomalies and cursor, shared rather than copied (the user asked to match the two).

Out of scope: storing parser state across watcher restarts; pretty-printed rollouts (they stay on the full path); the watcher debounce; Claude Code behavior.

## Checked Behavior

Code (read on 2026-11-06 at commit `7a7fbf2`):

- K1. `parseCodexFileBody` (`codex_parser.ts:586-660`) rewrites a pretty-printed body (`/^\{[ \t\r]*\n/`) with `compactJsonStream` before parsing (`codex_parser.ts:595`), so its byte offsets do not match the file. For every `\n`-terminated line it calls `parseLine`; a null result with non-blank text counts `json_parse_error`; a line in copied history or a copied parent turn (`inCopiedHistory`, `inParentTurn`) counts `copied_session_line_skipped`; any other line goes to `processLine(cl, lineSeq, source_file, state, events, toolResults, batch)`, and `batch.session_id` takes `state.session_id` once set. `lineSeq` counts terminated lines from 1. The function returns `session_meta` from the state at the end: `cwd`, `git_branch`, `version`, `kind`, `parent_id`.
- K2. `processLine` sets `state.cwd`, `state.version`, `state.git_branch` on every own `session_meta` line (`codex_parser.ts:707-710`), so they can change in the middle of a file.
- K3. The driver filters each Codex `$name` skill candidate against `existsSync(<codex home>/skills/<name>)` and `existsSync(<cwd>/.codex/skills/<name>)` before commit (`isKnownCodexSkill`, `filterCodexSkillCandidates`, `src/indexer/driver.ts:207-219`), with `cwd` from `parsed.session_meta.cwd`. The decision depends on the file system at index time.
- K4. `updateToolCallResult` changes a `tool_call` row only while its `duration_ms` is NULL (`src/indexer/writer.ts:149-156`); after a re-derivation every row is new, so the newest value in the parse's `toolResults` map is the one written.
- K5. `insertFileOp` and `insertHookBlock` take `{event_uuid, session_id, ts, tool, path}` and `{event_uuid, session_id, ts, hook_event, tool, call_id, reason}` (`writer.ts:112-114, 136-138`); `toSqlBindable` (`writer.ts`, private) turns `undefined` into NULL.
- K6. `runIndex()` (`driver.ts:458`) calls `appendNewLines` for `claude` files when not rebuilding (`driver.ts:538-548`) and otherwise reads and parses the file through `getSourceAdapter(f.source).parse`, then `filterCodexSkillCandidates` for Codex, then `commitFile`. `appendNewLines` (`append.ts:69-287`) does guards 1–3 on the cursor, parses, guards 5–14, and one write transaction; its helpers `readRange` and `SessionRow` are private (`append.ts:35-62`).
- K7. The watcher process runs `runIndex()` repeatedly in one process (`src/indexer/watch.ts`), so module-level state in `src/indexer/` lives across runs; `clens index` runs it once per process.

Experiments (`docs/experiments/2026-11-06-codex-append/`, table in `results.md`; prototype `codex_append.ts` with a parser copy `codex_parser_x.ts`):

- C1. 14 real rollouts (exec code, write_stdin, wait, hook output, subagent, compaction, exec run, MCP, CommandExecution, 5 others), 40 random steps: 503 steps, 436 appended, 0 mismatches.
- C2. 4 small rollouts line by line: 276 steps, 0 mismatches, 31 results written to earlier calls.
- C3. 4 exec rollouts line by line, and the one rollout whose hook block comes from a later output line split between call and output: 101 steps, 0 mismatches; a hook block written to an earlier call.
- C4. Negative controls: dropping rows added to earlier events, or applying results only to calls without one, each produced digest mismatches.
- C5. 57.8 MB rollout, 5 lines per run: 2.7–11.8 ms appended, 508–540 ms full; digest equal.
- C6. Kept state: 0.5–2.1 MB per rollout of 2.5–37.4 MB.
- C7. A `CommandExecution` adding a file op to an exec call indexed in an earlier run: appended, digest equal.
- C8. A skill folder appearing between runs: without a guard the digest differed (`skill_call`); with a guard the run went the full way and the digest was equal.
- C10. The guard as designed below (each `$name` candidate's decision recorded and checked again): a dangling skill symlink whose target appears between runs, a skill folder removed between runs, a project-local skill created between runs, and C8 each went the full way with the digest equal; with the guard switched off (`CODEX_NEG=skills`) each of the four differed in `skill_call`. An unrelated skill folder created between runs, and a new line naming a skill installed between runs, appended with the digest equal. C2 and C3 rerun with this guard: 0 mismatches, 1 hook block and 37 results written to earlier calls. A guard comparing only the folders' entry names (C8's first version) misses the dangling symlink, since the names do not change.
- C9. C2 and C3 again with the guard: 0 mismatches.

Not checked: whether Codex ever rewrites already-written lines of a rollout (Known Limits).

## Design

### Architecture

- `codex_parser.ts` exposes its line loop so a parse can start from a kept state: `parseCodexFile` (whole body, returns the end state) and `parseCodexLines` (lines from a byte position with a given state). `parseCodexFileBody` stays the adapter's parse and calls `parseCodexFile`.
- New `src/indexer/codex_skills.ts` holds the skill filter moved from `driver.ts:207-219`, which now also records each decision, and the check of recorded decisions, so both `driver.ts` and the new module use one copy.
- `append.ts` splits out what both sources share: reading the bytes after the cursor (guards 1–3) and finishing an append (guards 13–14 and the write transaction). `appendNewLines` keeps its behavior on top of them, passing `() => applyToolResults(stmts, toolResults)` as `writeExtra`.
- New `src/indexer/codex_append.ts` keeps the states (`CODEX_STATES_KEPT` most recently used rollouts) and implements `appendCodexLines`.
- `driver.ts` calls `appendCodexLines` for Codex files as it calls `appendNewLines` for Claude Code files, and hands the end state of every Codex full parse to `keepCodexState`.

Dependencies: `driver.ts` → `codex_append.ts` → `append.ts`, `codex_parser.ts`, `codex_skills.ts`, `writer.ts`; `driver.ts` → `codex_skills.ts`. None of them imports `driver.ts`.

### Interfaces

```ts
// src/indexer/codex_parser.ts
export type { SessionState };                      // the interface at codex_parser.ts:497, exported unchanged
export interface CodexResume {
  state: SessionState;
  toolResults: Map<string, ToolResultInfo>;        // every result the parse has seen, newest per call_id
}
export function parseCodexFile(args: { body: string; source_file: string; batch: AnomalyBatch }):
  { result: FileParseResult; resume: CodexResume | null };   // resume is null when the body was pretty-printed (K1)
export function parseCodexFileBody(args: { body: string; source_file: string; batch: AnomalyBatch }): FileParseResult;
  // = parseCodexFile(args).result
export function parseCodexLines(args: {
  buf: Buffer;            // bytes to read
  start: number;          // index in buf of the first byte of the first line
  first_seq: number;      // lineSeq of that line (1 for a whole file)
  source_file: string;
  resume: CodexResume;    // mutated: the state and results go on from here
  batch: AnomalyBatch;
  events: ParsedEvent[];  // new events are pushed here
}): { terminated: number; last_ok: number };   // lines ended by \n; index in buf after the last \n (start when none)

// src/indexer/codex_skills.ts
export type SkillDecisions = Map<string, boolean>;   // "$name" candidate -> kept (true) or dropped (false)
export function filterCodexSkillCandidates(events: ParsedEvent[], cwd: string | null,
  decisions: SkillDecisions = new Map()): SkillDecisions;
  // moved from driver.ts:213. For each candidate whose name is not yet in `decisions`, records
  // isKnownCodexSkill(name, cwd) (moved unchanged from driver.ts:207); drops every candidate recorded false;
  // returns `decisions`. Deciding once per name instead of once per occurrence gives the same rows,
  // since the folders are read within one run either way.
export function skillDecisionsHold(decisions: SkillDecisions, cwd: string | null): boolean;
  // true when isKnownCodexSkill(name, cwd) equals the recorded value for every entry

// src/indexer/append.ts
export type AppendFallback = /* existing 16 values */ | "no_state" | "skills_changed" | "meta_changed" | "earlier_event_changed";
export interface SessionRow { /* the existing private interface, exported unchanged */ }
export function readAppended(db: Database.Database, f: DiscoveredFile):
  { cursor: FileCursorRow; from: number; bytes: Buffer; start: number } | AppendFallback;
  // guards 1-3 as appendNewLines does them now; start = cursor.last_ok - from
export function finishAppend(db: Database.Database, stmts: WriterStatements, args: {
  f: DiscoveredFile; cursor: FileCursorRow; own: string; session: SessionRow;
  events: ParsedEvent[]; batch: AnomalyBatch; terminated: number; last_ok: number; // last_ok: absolute file offset
  writeExtra: () => void;  // runs inside the transaction, after the new events are written
}): AppendOutcome;
  // guard 13 (out_of_order) and 14 (model_tie) as now, then the transaction: turn-number offsets and
  // writeParsedEvent, writeExtra(), the session row, the anomaly merge, upsertCursor

// src/indexer/writer.ts
export function toSqlBindable(row: object): Record<string, unknown>;   // was private
// new statement in WriterStatements:
setToolCallResult: Database.Statement;
  // UPDATE tool_call SET duration_ms = CAST((julianday(@result_ts) - julianday(ts)) * 86400000 AS INTEGER),
  //   is_error = @is_error, result_chars = @result_chars, error_excerpt = @error_excerpt
  //   WHERE call_id = @call_id AND session_id = @session_id

// src/indexer/codex_append.ts
export const CODEX_STATES_KEPT = 16;
export function keepCodexState(path: string, resume: CodexResume | null, last_ok: number, lines: number,
  skills: SkillDecisions): void;
  // resume null: forget the path. Otherwise store {resume, last_ok, lines, skills}
  // as the most recently used entry, and drop the least recently used beyond CODEX_STATES_KEPT.
export function forgetCodexStates(): void;      // empties the store (tests)
export function appendCodexLines(db: Database.Database, stmts: WriterStatements, f: DiscoveredFile): AppendOutcome;
```

### appendCodexLines: guards, in order

The store is a `Map<string, Kept>` in insertion order (least recently used first). `appendCodexLines` removes the file's entry from the store before anything else and puts it back, as the most recent, only after a successful append. Parsing mutates the state, so on every `full` the entry stays removed and the full path keeps a fresh one. Reasons in quotes are `AppendFallback` values.

1–3. `readAppended`: `no_cursor`, `shrunk`, `not_line_start`.
- `no_state`: no entry, or its `last_ok` or `lines` differs from the cursor's.
- `skills_changed`: `skillDecisionsHold(entry.skills, state.cwd)` is false (C8, C10). The entry holds a decision for every candidate of the lines parsed so far, so a full index now would decide each of them the same way.
4. `torn_first_line`: the first `\n`-terminated line after `start` does not parse as JSON (checked before parsing, as `appendNewLines` does).
- Snapshot `[session_id, cwd, git_branch, version, kind, parentId]` of the state, the lengths of the nine child arrays of every event in `state.callEvents`, and a copy of `toolResults`. Then `parseCodexLines` with `first_seq = cursor.lines + 1`, a fresh batch whose `ts` is `f.mtime` floored to the millisecond, and a new `events` array. Then `skills = filterCodexSkillCandidates(events, state.cwd, new Map(entry.skills))`.
- `meta_changed`: any value of the snapshot differs (K2: the session row and project come from them).
5. `own` is `state.session_id`. `no_session_row`: it is null or has no `session` row.
6. `other_session`: a new event's `session_id` is not `own`.
7. `several_files`: `own` has `event` rows from another `source_file`.
- `earlier_event_changed`: an event in the snapshot gained elements in an array other than `file_ops` and `hook_blocks` (no code does this today; the guard keeps the write below complete).
11. `known_uuid`: a new event's `uuid` already has an `event` row.
13–14. `finishAppend` (`out_of_order`, `model_tie`), with `writeExtra`:
- for each snapshot event whose `file_ops` or `hook_blocks` grew, insert the new elements with `insertFileOp` / `insertHookBlock` through `toSqlBindable`;
- for each `call_id` whose `toolResults` value is new or not the same object as in the copy, run `setToolCallResult` with that value and `session_id = own`.
- After the commit, put the entry back with `last_ok` and `lines` from the cursor just written and `skills`.

Guards 8–10 and 12 of `appendNewLines` (session meta filled late, sdk entrypoint, sidechain, result already applied) do not apply: a Codex session's meta and kind come from the state, which `meta_changed` covers, and results are rewritten by `setToolCallResult`.

### runIndex changes

- Before reading a file, when `!needsRebuild && f.source === "codex"`, call `appendCodexLines` and count an `appended` outcome exactly as the Claude branch does (`files_parsed`, `files_appended`, `events_inserted`, `parse_errors`).
- On the full path, Codex files are parsed with `parseCodexFile` instead of the adapter's `parse`; after `commitFile` returns, call `keepCodexState(f.path, resume, parsed.last_ok_byte_offset, parsed.fully_terminated_line_count, skills)`, where `skills` is what `filterCodexSkillCandidates(parsed.events, parsed.session_meta.cwd)` returned before `commitFile`. This also runs on a rebuild, so the store ends with the last `CODEX_STATES_KEPT` rollouts parsed.
- `filterCodexSkillCandidates` is imported from `codex_skills.ts`.

### Documentation

`AGENTS.md`, Key invariants, Gate 2: extend the sentence on the append path to Codex rollouts, naming `src/indexer/codex_append.ts` and that it resumes from the parser state the watcher keeps in memory for the last `CODEX_STATES_KEPT` rollouts.

## Assumptions To Check

1. Moving the line loop into `parseCodexLines` keeps `parseCodexFileBody`'s output identical: `test/codex_parser.spec.ts` passes unchanged.
2. Moving `readRange`/guards 1–3 and the write transaction out of `appendNewLines` keeps its behavior: `test/driver_append.spec.ts` passes unchanged after step 3, before step 5 changes T6.
3. Parsing a rollout in two parts with the kept state gives the same events, results and child rows as parsing it whole (C1–C3, C7, C9).
4. The only input outside a rollout's own bytes that the full path reads for it is the skill check `isKnownCodexSkill` (K3); every other row comes from the parse, which reads nothing else but `homedir()` (`codex_parser.ts:341`), fixed for the process. The other disk reads of `driver.ts` (`existsSync` at `:496`, `:506`, `:511`) run only on a rebuild. Checked by reading `src/indexer/*.ts` on 2026-11-06; C8 and C10 cover the skill check.

## Implementation Order

1. `codex_parser.ts`: export `SessionState`, add `CodexResume`, `parseCodexLines`, `parseCodexFile`; `parseCodexFileBody` calls `parseCodexFile`. Verify: `npm run typecheck`; `npx vitest run test/codex_parser.spec.ts` passes unchanged.
2. `codex_skills.ts`: move `isKnownCodexSkill` and `filterCodexSkillCandidates` from `driver.ts`, record decisions as in Interfaces, add `skillDecisionsHold`; `driver.ts` imports the filter. Verify: typecheck; `npx vitest run test/driver.spec.ts` (its Codex skill tests in the describe block at `test/driver.spec.ts:303`) passes unchanged.
3. `append.ts`: export `SessionRow`, add `readAppended` and `finishAppend`, rewrite `appendNewLines` on them; extend `AppendFallback`. `writer.ts`: export `toSqlBindable`, add `setToolCallResult`. Verify: typecheck; `npx vitest run test/driver_append.spec.ts` passes unchanged.
4. Write `test/driver_codex_append.spec.ts`, failing until step 5. Setup as `test/driver_append.spec.ts` (temporary `CLENS_HOME`, `CLENS_CODEX_HOME`, index dirs `a` and `b`, `expectDigestEqualsRebuild`), rollouts under `<codex home>/sessions/2026/09/01/`, `forgetCodexStates()` in `beforeEach`. Lines are built as in `test/codex_parser.spec.ts` (session meta and messages: `:15-60`; hook output: `:609-668`; exec code results and cells: `:702-810`; running commands and write_stdin: `:811-842`; commands built at run time: `:844-872`).
   - X1 growth: one rollout holding session_meta, turn_context, user and agent messages, token_count and task_complete, an exec_command call and output, a PreToolUse hook output, an exec call whose code builds its command with its CommandExecution item and output, a running exec_command ended by write_stdin, an exec call left running and ended by a wait, and a compacted line; grown one line per run. Every run after the first that has the session row: `files_appended` 1. Digest equal after every run.
   - X2 earlier events: split between an exec call and its CommandExecution item (C7 lines), and between a call and its PreToolUse output: `files_appended` 1, the file op / hook block row exists with the call's `event_uuid`, digest equal.
   - X3 later result: split a running exec_command from the write_stdin that reports its nonzero exit: `files_appended` 1, the exec_command's `tool_call.is_error` is 1, digest equal.
   - X4 fallbacks, each `files_appended` 0 and digest equal, the reason asserted by calling `appendCodexLines` directly as `driver_append.spec.ts` does with `appendNewLines`: `no_state` (after `forgetCodexStates()`), `skills_changed` (three cases, each with an earlier message naming `$<name>`: `<codex home>/skills/<name>` created between runs; that folder present at the first run and removed between runs; a symlink at that path, created before the first run, whose missing target folder is created between runs), `meta_changed` (append a second own `session_meta` with another `git.branch`), `torn_first_line`, `out_of_order`, `model_tie` (two turn_contexts with different models), `shrunk`, `not_line_start`, `several_files`, and a pretty-printed rollout (`no_state`).
   - X5 store bound: index `CODEX_STATES_KEPT + 1` rollouts, then grow the first: `no_state`; grow the last: appended.
   - X6 Claude unchanged: in `test/driver_append.spec.ts` only T6 is edited (step 5).
5. `codex_append.ts` and the `runIndex` changes; in T6 (`test/driver_append.spec.ts:367-386`) rename the test to "appends a grown Codex rollout" and change `expect(r.files_appended).toBe(0)` to `toBe(1)`, keeping its other lines. Other existing tests that grow a rollout, such as `test/driver_multifile.spec.ts:344-399`, now take the append path and pass unedited. Verify: `npx vitest run test/driver_codex_append.spec.ts test/driver_append.spec.ts` pass; `npm test` passes.
6. `AGENTS.md`; `npm run build`. Verify: `npm run typecheck`, `npm test`, `node test/scripts/plugin-smoke.mjs`.

## Acceptance

- `test/driver_codex_append.spec.ts` passes, and `npm test` passes with `test/codex_parser.spec.ts` unedited and `test/driver_append.spec.ts` edited only in T6 as step 5 says.
- A grown Codex rollout whose state is kept is indexed by `appendCodexLines` and reports only its new events; one that fails a guard is re-derived.
- The digest after every append equals a rebuild's (S1, X1–X5).
- No change to `src/indexer/schema.ts`.

S1. Two runs in one process. From the repository root:

```sh
cat > s1.tmp.ts <<'EOF'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runIndex } from "./src/indexer/driver.js";
import { digestAllTables } from "./src/indexer/digest.js";
const T = mkdtempSync(join(tmpdir(), "clens-s1-"));
const dir = join(T, "codex/sessions/2026/09/01");
mkdirSync(dir, { recursive: true }); mkdirSync(join(T, "claude/projects"), { recursive: true });
Object.assign(process.env, { CLENS_HOME: join(T, "claude"), CLENS_CODEX_HOME: join(T, "codex"), CLENS_INDEX_DIR: join(T, "a") });
const at = (s: number) => `2026-09-01T00:00:${String(s).padStart(2, "0")}Z`;
const line = (s: number, type: string, payload: object) => JSON.stringify({ timestamp: at(s), type, payload }) + "\n";
const F = join(dir, "rollout-2026-09-01T00-00-00-s1.jsonl");
writeFileSync(F, line(0, "session_meta", { id: "s1", cwd: "/w/app" }) + line(1, "turn_context", { model: "m-1" })
  + line(2, "event_msg", { type: "user_message", message: "first question" }) + line(3, "event_msg", { type: "task_complete" }));
const r1 = await runIndex();
appendFileSync(F, line(4, "event_msg", { type: "user_message", message: "second question" }) + line(5, "event_msg", { type: "task_complete" }));
const r2 = await runIndex();
const digest = (d: string) => { const db = new Database(join(d, "index.db"), { readonly: true }); const x = digestAllTables(db); db.close(); return JSON.stringify(x); };
const grown = digest(join(T, "a"));
process.env.CLENS_INDEX_DIR = join(T, "b");
await runIndex({ rebuild: true });
console.log(`first run: appended ${r1.files_appended}, events ${r1.events_inserted}`);
console.log(`second run: appended ${r2.files_appended}, events ${r2.events_inserted}`);
console.log(grown === digest(join(T, "b")) ? "digest-equal" : "digest-differs");
rmSync(T, { recursive: true, force: true });
EOF
npx tsx s1.tmp.ts 2>&1 | grep -E "^(first|second) run|^digest"
rm s1.tmp.ts
```

Expected:

```
first run: appended 0, events 2
second run: appended 1, events 2
digest-equal
```

Before this change the second line reads `second run: appended 0, events 4` (checked on 2026-11-06 at `7a7fbf2`).

## Known Limits

- After the watcher restarts, and for rollouts beyond the last `CODEX_STATES_KEPT` used, the first change goes the full way and keeps a state; later changes append. `clens index` keeps nothing across processes.
- Pretty-printed rollouts always go the full way.
- A rollout rewritten in place so that the byte before `last_ok` is still `\n`, a valid JSON line starts at `last_ok`, the kept state's `last_ok` and `lines` still match the cursor, and every event after it is new is indexed as an append, as for Claude Code transcripts (`docs/2026-11-06-append-index-design.md`, Known Limits): the rows of the replaced lines stay until the rollout is next re-derived. Whether Codex rewrites rollouts in place was not checked.

## Open Questions

None.

## Goals Check

- Criterion 1: met when a state is kept (C5); the first change after a restart or eviction costs a full parse, as now.
- Criterion 2: met; every case the index or the kept state cannot vouch for goes the full way, and X1–X5 compare digests with a rebuild.
- Criterion 3: met; the state lives in memory, no table or column is added.
- Criterion 4: met by step 3's verification and X6.

```skerry
{"run": "20261106-083546-a46d", "verify": ["npm run typecheck", "npm test", "node test/scripts/plugin-smoke.mjs"], "extras": []}
```

## Changes After Approval

- Design › "appendCodexLines: guards, in order", between 5 and 6: added `several_sessions` (an existing `AppendFallback` value): the run goes the full way when the rollout has `event` rows of a session other than `own`. Lines before a rollout's `session_meta` go to a `codex-unknown:<path>` session, and `commitFile` sets every session of a file to the file's whole span and primary model, so an append that updates only `own` left that session's `ended_at` stale (checked: without the guard the digest differed in `session`; with it, equal). The Claude Code path has the same guard for the same reason. No real rollout was found with an event before its `session_meta`. Tested by the X4 case "several_sessions: a line before the rollout's session_meta".
- Implementation Order step 4, X1: added a second test, "resumes each append from the state the previous append left", which grows the X1 rollout one line per run with no rebuild until the end. The rebuild in `expectDigestEqualsRebuild` parses the same rollout path and keeps its state, so in the first X1 test every run resumes from a fresh full parse; with the entry not put back after an append, the first test still passed and only this one failed.
- Implementation Order step 4, X4: added a second `no_state` case, "the kept state is ahead of the cursor, after another index read the grown rollout", the only test that fails when the `last_ok`/`lines` comparison of `no_state` is switched off.
- Interfaces › `codex_append.ts` and Design › "appendCodexLines: guards, in order" (review round 1): `keepCodexState` takes a sixth argument, `prefilled: ReadonlySet<string>`, the call ids whose `tool_call` row was parsed with its duration (new export `prefilledCallIds(events, into?)`; `runIndex` passes `prefilledCallIds(parsed.events)`). After `known_uuid`, the results to write are those the new lines set or replaced plus those earlier lines left for calls the new lines bring, and two `AppendFallback` values are added: `prefilled_result` (one of those results is for a prefilled call, which `updateToolCallResult` on the full path leaves as it is) and `shared_call_id` (another session has a `tool_call` row with that call id, which the full path's UPDATE, not limited to a session, would also change). Why: a result before its call, a result for a completed `McpToolCall` item, and a call id shared by two sessions each gave rows different from a re-derivation. Tested by X7 in `test/driver_codex_append.spec.ts` (three cases).
- Review round 2 rewrote the result guards of the entry above. `shared_call_id` now applies whenever any call id of the rollout (an own `tool_call` row, a call in the new lines, or a key of its results) is also held by another session's `tool_call` row, and whenever an own row has a duration that neither the rollout's own results nor `prefilled` gave it (another file's result filled it). Why: re-deriving a rollout also fills other sessions' empty rows with its earlier results and resets its own rows, so checking only the results the new lines changed missed a session indexed later that shares an older call id. Tested by two more X7 cases; since those rows depend on which file was indexed last, they assert the fallback, not a rebuild's digest. `runIndex` on a copy of the 57.8 MB rollout, 5 lines per run: 2.9–17.2 ms per run with the rewritten guard.
- Review round 3: `prefilled_result` also applies when a prefilled call id names more than one `tool_call` row of the rollout (stored or new), since the guard cannot then tell which row was parsed with its duration and which another file's result filled. Tested by one more X7 case.
