# Append-Only Indexing of Growing Claude Code Transcripts Design

## Context

The watcher (`src/indexer/watch.ts:1-46`) runs `runIndex()` 500 ms after the last change to any transcript. `runIndex()` re-parses every file whose mtime moved (`src/indexer/cursor.ts:84-92`), from its first byte (`src/indexer/driver.ts`, the `readFileSync(f.path, "utf8")` in the file loop of `runIndex`), and `commitFile()` deletes every row of the sessions that file holds and inserts them again (`driver.ts:290-296`). So every line Claude Code appends to the live session's transcript (a message, a tool call, a tool result) re-derives the whole session.

Measured on 2026-11-06 with this repository's own working session (a 40 MB transcript of about 17,000 lines):

- one re-derivation took 750–844 ms in an index holding only that session and 1,043–1,551 ms in a copy of the real 1.37 GB index;
- a CPU profile of one run (705 ms in `runIndex`) split it into parsing the whole file (`parseFileBody`, 220 ms), inserting about 9,500 events (`writeParsedEvent`, 315 ms) and deleting them first (`wipeSessions`, 72 ms);
- the clens server process that runs the watcher went from 0 to 71–96 % of one core for about one second after each change, 0.94 s of CPU per run.

The cost grows with the session: every appended line pays for all lines before it.

Goal: when lines are appended to a Claude Code transcript, index only those lines, with a result identical to re-deriving the session, and fall back to the current path whenever that identity cannot be guaranteed from the index alone.

Success criteria:

1. For a growing Claude Code transcript, an index run that only sees appended lines takes time proportional to the appended lines, not to the file (A4: 6.4–11.4 ms against 810–874 ms on the 40 MB transcript).
2. Gate 2 holds after every run: the digest (`digestAllTables`, `src/indexer/digest.ts:53`) of an index grown run by run equals the digest of an index rebuilt from scratch on the same files.
3. No schema change and no `SCHEMA_VERSION` bump.

Decisions already made:

- Index appended lines only, and re-derive the whole session (today's path) when the result could differ. The user asked for line-level incremental indexing in conversation on 2026-11-06 and asked for an experiment first; A1–A4 confirmed it.
- Exactness is decided per run from the index and the new lines (guards below), not corrected later by a periodic re-derivation. The periodic correction was discussed and set aside because rows would be wrong between corrections.
- The position to resume from is `file_cursor.last_ok`, which the indexer already stores (`src/indexer/schema.ts:124-132`, written at `driver.ts:335`) and nothing reads yet (`src/indexer/claude_parser.ts:718-719`).

Out of scope:

- Codex transcripts keep the current path (see Design, "Codex").
- The watcher's debounce and the FTS optimize schedule stay as they are.

## Checked Behavior

Code (read on 2026-11-06 at commit `c94a59c`):

- C1. `discoverFiles` marks a file for parsing when it has no cursor row, its mtime is newer than the cursor's, or its size shrank (`cursor.ts:84-92`).
- C2. `parseFileBody` (`claude_parser.ts:725-787`) parses only lines that end in `\n`; `last_ok_byte_offset` is the byte after the last such line and `fully_terminated_line_count` counts them. It takes `cwd`, `gitBranch`, `version` and `entrypoint` from the first line that carries each (`claude_parser.ts:758-765`), sets `session_meta.parent_id` from the first own subagent event (`claude_parser.ts:750-755`), and marks the session `exec` when the first entrypoint starts with `sdk-` (`claude_parser.ts:778`).
- C3. `parseEventLine(line, source_file, seq, batch, toolResults)` (`claude_parser.ts:555-561`) uses `seq` only in the detail of a `json_parse_error` anomaly (`claude_parser.ts:552, 567`). A line without a string `uuid` is counted as `non_event_line` and yields no event (`claude_parser.ts:579-582`). The first event sets `batch.session_id` (`claude_parser.ts:592`). A tool result is stored in `toolResults` by `tool_use_id`, a later one replacing an earlier one (`claude_parser.ts:428`).
- C4. `bumpAnomaly` adds to the count and keeps the last non-null detail (`claude_parser.ts:160-168`). `flushAnomalyBatch` deletes the file's anomaly rows and inserts one row per kind with `batch.session_id` and `batch.ts` (`writer.ts:294-309`); `runIndex` sets `batch.ts` to the file's mtime floored to the millisecond.
- C5. `assignTurnNumbers` sorts the events by `ts` with a stable sort, so equal times keep file order, and numbers assistant events and user events except those that only carry tool results (`claude_parser.ts:800-821`).
- C6. `commitFile` (`driver.ts:219-340`): `writableEvents` keeps, in a main file, the lines of the session of the file's last event plus lines of sessions with no rows yet, and in a subagent file only the subagent's own lines, counting the rest as `copied_session_line_skipped` or `subagent_line_skipped` (`driver.ts:363-393`). `summarizeFile` takes the earliest and latest `ts`, whether any event is a sidechain, and the most frequent assistant model, a tie going to the model seen first (`driver.ts:164-191`). Every session of the file gets the same `started_at`, `ended_at`, `kind` (`deriveSessionKind`, `driver.ts:116-142`) and `model_primary` (kept when the file has none: `writer.ts:171`). Then it wipes those sessions, inserts all events with turn numbers, applies tool results, flushes anomalies and upserts the cursor, in one transaction.
- C7. `insertEvent` is `INSERT OR REPLACE` (`writer.ts:96-99`). `updateToolCallResult` changes a `tool_call` row only while its `duration_ms` is NULL (`writer.ts:149-156`), so the first result applied wins.
- C8. The digest covers `schema_version`, `file_cursor` (without `live`), `project`, `session`, `event` and the event child tables and `anomaly`, ordered by key columns, not rowid (`digest.ts:20-36, 53-75`). The FTS and language tables are not digested.
- C9. Codex parsing carries state from line to line: the model from `turn_context` goes onto later events, and token counts, open exec calls and running processes accumulate across lines (`codex_parser.ts:497-520, 716, 753, 916-919`). None of it is in the index.
- C10. Existing driver tests append to a fixture and call `runIndex({})` (`test/driver.spec.ts:423-470`); the fixture `test/fixtures/brainstorm-session.jsonl` has 961 lines, session id `test`, two models (`claude-opus-4-7`, `<synthetic>`), entrypoint `cli`, and is copied to `<projects>/fixture-project/test.jsonl`, so its file name is its session id.

Experiments (`docs/experiments/2026-11-06-append-index/`, results in `results.md`; prototype `append.ts`):

- A1. 15 real transcripts (6 main files with out-of-order lines, 4 subagent files, 5 others) grown in 40 random steps each: 548 steps, 536 appended, 12 re-derived, digest equal to a fresh rebuild at every step.
- A2. Transcripts whose numbered lines go back in time, 3 grown line by line and 2 of 1,500+ lines in 150 steps: 488 steps, 6 re-derived because of the order guard, digest equal at every step.
- A3. Negative control: dropping the turn-number offset made 9 of 9 steps differ, so the digest comparison catches a wrong rule.
- A4. The 40 MB transcript, 5 lines appended per run: 6.4–11.4 ms appended against 810–874 ms re-derived; digest equal at the end.
- A5. A scan of every transcript under `~/.claude/projects` (909 main, 979 subagent files, `scan.mjs`, `r5-scan.txt`): in every main file the last event's session is the file name; no main file holds events of two sessions; no file repeats a uuid; no tool call has two results on user lines; the entrypoint is on the first event line of every main file; 666 main files start with an `sdk-` entrypoint. Of the main files, 23 have a numbered line earlier than one before it (`pick-ooo.mjs`).
- A6. `test/fixtures/brainstorm-session.jsonl` grown in the 30 prefixes of test T1 with the prototype (`t1.ts`, `r6-t1-prefixes.txt`): the first run indexes, all 29 later runs append, and the digest equals a fresh rebuild after every run.

Not checked:

- Whether Claude Code ever rewrites a transcript in place instead of appending. No documentation was found; the guards in step 3 below catch a rewrite whose bytes at `last_ok` do not start a new line or whose events are already indexed, and Known Limits says what else is missed.
- The prototype did not take the index lock; the design runs the append path inside `runIndex`, which holds it.

## Design

### Architecture

`runIndex()` keeps its loop. For a file with `needs_parse`, source `claude`, on a run that is not a rebuild, it first calls `appendNewLines()`. When that returns `appended`, the file is done; when it returns `full`, the loop goes on with the current code for that file (read, parse, `commitFile`). Codex files and rebuilds never call it.

`appendNewLines()` lives in a new module `src/indexer/append.ts`. It reads the index through the `db` it is given and writes through `WriterStatements` and `upsertCursor`, in its own transaction. It imports from `claude_parser.ts`, `writer.ts`, `cursor.ts` and `types.ts`; `driver.ts` imports it. `SUBAGENT_FILE_RE` moves from `driver.ts:344` to `claude_parser.ts` as an export, so both modules use the same pattern without `append.ts` importing `driver.ts`.

### Interfaces

```ts
// src/indexer/append.ts
export type AppendFallback =
  | "no_cursor" | "shrunk" | "not_line_start" | "torn_first_line"
  | "no_session_row" | "several_sessions" | "other_session" | "several_files"
  | "late_meta" | "sdk_entrypoint" | "sidechain" | "known_uuid"
  | "result_exists" | "out_of_order" | "model_tie";

export type AppendOutcome =
  | { kind: "appended"; events: number; parse_errors: number }
  | { kind: "full"; reason: AppendFallback };

export function appendNewLines(
  db: Database.Database,
  stmts: WriterStatements,
  f: DiscoveredFile,
): AppendOutcome;

// src/indexer/claude_parser.ts
export const SUBAGENT_FILE_RE: RegExp; // moved unchanged from driver.ts:344

// src/indexer/driver.ts
export interface IndexResult {
  // existing fields unchanged
  files_appended: number; // files handled by appendNewLines; also counted in files_parsed
}
```

`appendNewLines` returns `full` before writing anything; it writes only after every guard passed. A thrown error propagates like an error from `commitFile` does today.

### Guards, in order

`own` is the session the file belongs to. Each guard names the fallback reason it returns.

1. `no_cursor`: no `file_cursor` row for `f.path`.
2. `shrunk`: `f.size` is smaller than the cursor's `size`.
3. `not_line_start`: the cursor's `last_ok` is above 0 and the byte at `last_ok - 1` is not `\n`.
4. Read the bytes from `last_ok` to `f.size` and split them into lines that end in `\n`; the bytes after the last `\n` are left for a later run, as `parseFileBody` does (C2). `torn_first_line`: the first such line is not valid JSON. Parse each line with `parseEventLine(line, f.path, cursor.lines + k, batch, toolResults)`, `k` counting from 1, with a fresh `batch` whose `ts` is `f.mtime` floored to the millisecond (C4) and a fresh `toolResults` map. Also note, for each line that parses as a JSON object, whether it carries a string `cwd`, `gitBranch`, `version` or `entrypoint`.
5. `own`: in a subagent file (`SUBAGENT_FILE_RE`), the one `session_id` among `event` rows with this `source_file`; drop the new events that are not the subagent's own (`agent_id` set and `session_id === agentSessionId(agent_id)`) and add their number to the batch's `subagent_line_skipped` count, as `writableEvents` does (C6). In a main file, the file name without `.jsonl` (A5). `no_session_row`: no `event` row with this `source_file`, or no `session` row for `own`. `several_sessions`: the file's `event` rows belong to more than one session, or, in a main file, to a session other than `own`.
6. `other_session`: a new event of a main file has a `session_id` other than `own`.
7. `several_files`: `own` has `event` rows from another `source_file`.
8. `late_meta`: the session row's `cwd`, `git_branch` or `version` is NULL and a new line carries `cwd`, `gitBranch` or `version` respectively; or, in a subagent file, the row's `parent_id` is NULL and a new own event exists (C2).
9. `sdk_entrypoint`: the session's `kind` is `interactive` and a new line carries an `entrypoint` that starts with `sdk-`. (If the file's first entrypoint were `sdk-`, the kind would already be `exec`; a later `sdk-` entrypoint only matters when no entrypoint came before, which the index cannot tell.)
10. `sidechain`: a new event has `is_sidechain = 1` and the session's `kind` is not `subagent`.
11. `known_uuid`: a new event's `uuid` already has an `event` row.
12. `result_exists`: a `tool_use_id` in the new `toolResults` names a `tool_call` row whose `duration_ms` is not NULL (C7: the full path would apply the newest result, the append path cannot replace the old one).
13. `out_of_order`: a new numbered event (assistant, or user that is not only tool results, as in C5) has a `ts` earlier than the latest `ts` among `own`'s events that have `user_turn_no` or `assistant_turn_no`. An equal `ts` passes: the stable sort puts the later line after it (C5).
14. `model_tie`: only when a new assistant event has a model. Count assistant events with a model by model over `own`'s rows plus the new events; the two highest counts are equal. With no new assistant model the counts do not change, and the stored `model_primary`, which a re-derivation or an earlier append with a single highest count wrote, is what a re-derivation would write again.

### Writes, in one transaction

1. `assignTurnNumbers(newEvents)`, then add `MAX(user_turn_no)` and `MAX(assistant_turn_no)` of `own` (0 when NULL) to the numbers it set.
2. `writeParsedEvent(stmts, p)` for each new event, without known tokens: these messages are new to the analyzer.
3. `applyToolResults(stmts, toolResults)`.
4. Update the session row: `started_at` to the earlier of itself and the new events' earliest `ts`, `ended_at` to the later of itself and their latest `ts`, `model_primary` to the model with the highest count from guard 14 when guard 14 counted, else unchanged.
5. Anomalies: read the file's anomaly rows, add the new batch's counts kind by kind, take the new detail where it is not NULL, delete the file's rows and insert the merged ones with `ts` set to the new batch `ts` and `session_id` set to the old rows' `session_id`, or `own` when there were none (with no old rows, no line was skipped, so the file's first event belongs to `own`).
6. `upsertCursor` with `f.mtime`, `f.size`, `lines` the cursor's `lines` plus the new terminated lines, `last_ok` the cursor's `last_ok` plus the byte after the last new `\n`.

With no new terminated lines (a touch, or only a partial line), guards 1–3, 5 and 7 still apply, since they look at the cursor, the file's bytes before `last_ok` and the index; guards 4, 6 and 8–14 look only at new lines, events or results and cannot fire. When the guards pass, the writes change only the anomaly `ts` and the cursor, which is all a re-derivation changes in that case.

The outcome's `events` is the number of new events written, and `parse_errors` the new batch's `json_parse_error` count.

### runIndex changes

In the file loop, before `readFileSync`, when `!needsRebuild && f.source === "claude"`: call `appendNewLines(db, stmts, f)`. On `appended`, add 1 to `files_parsed` and `files_appended`, add `events` to `events_inserted` and `parse_errors` to `parse_errors`, and continue with the next file. On `full`, run the current code. `files_appended` starts at 0 and is returned in `IndexResult`. The CLI output (`src/commands/index_cmd.ts:25-27`) stays as it is; for an appended file its event count is the number of new events.

### Codex

Codex files keep the full path. Their parser carries the current model, token counts and open calls from earlier lines into later events (C9), so the new lines cannot be parsed alone without storing that state, which would change the schema. A Codex append path would be a separate design.

### Documentation

- `AGENTS.md`, Key invariants, Gate 2: say that a Claude Code transcript that only grew is indexed by appending its new lines when `appendNewLines` can prove the result equals a re-derivation, and that every other change re-derives the affected sessions as before.
- `driver.ts` header comment: the same, in one sentence.

## Assumptions To Check

1. `parseEventLine` called line by line with `seq` continuing from `file_cursor.lines` yields the same events and anomaly counts as `parseFileBody` over the whole file for those lines (C2, C3; A1, A2).
2. No other cross-line state of the Claude parser affects the rows: `parseFileBody`'s only state besides `toolResults` and `session_meta` is byte and line counting (`claude_parser.ts:728-742`).
3. The digest of an index grown through `appendNewLines` equals the digest of a rebuild for every guard outcome (A1–A3), including subagent files (A1) and an equal `ts` (to be covered by test T4).
4. `runIndex` holds the index lock for the whole file loop, so the append path needs no lock of its own (`driver.ts:454-470`).
5. Moving `SUBAGENT_FILE_RE` changes no behavior: it is used at `driver.ts:124, 264, 377` only.

## Implementation Order

1. Move `SUBAGENT_FILE_RE` to `claude_parser.ts` as an export and import it in `driver.ts`. Verify: `npm run typecheck`, `npx vitest run test/driver.spec.ts test/driver_multifile.spec.ts`.
2. Write `test/driver_append.spec.ts`, failing until step 4. Each test builds a temporary `CLENS_HOME`, `CLENS_CODEX_HOME` and `CLENS_INDEX_DIR` as `setupFakeHome` in `test/driver.spec.ts:13-24` does, grows a transcript with `appendFileSync`, calls `runIndex({})`, checks `files_appended`, then compares `digestAllTables` of that index with a fresh index built by `runIndex({ rebuild: true })` in a second `CLENS_INDEX_DIR` over the same files. Main transcripts are named `<sessionId>.jsonl`.
   - T1 growth: `brainstorm-session.jsonl` copied to `test.jsonl` in 30 prefixes, its first 32, 64, …, 928 lines and then all 961, each run after appending the next part. Every run after the first: `files_appended` 1 (A6: no guard fires at these prefixes). Digest equal after every run.
   - T2 subagent file: a parent session file and `<parent>/subagents/agent-x.jsonl` holding a parent line and own lines; append own lines and one parent line. `files_appended` 1, the skipped line counted in `subagent_line_skipped`, digest equal.
   - T3 fallbacks, each `files_appended` 0 and digest equal: `out_of_order` (an assistant line 1 s before the last numbered line), `model_tie` (session with one `m-a` reply, append one `m-b` reply), `late_meta` (prefix lines without `gitBranch`, append one with it), `sdk_entrypoint` (prefix without entrypoint, append `sdk-cli`), `sidechain` (append `isSidechain: true` with an `agentId` to a main file), `other_session`, `known_uuid` (append a copy of an existing line), `result_exists` (append a second `tool_result` for an answered call), `not_line_start` (rewrite the file in place, longer, with the old `last_ok` falling inside a line), `shrunk`, `several_files` (a second main file with lines of the same session).
   - T4 equal time: append a user line whose `ts` equals the last numbered line's. `files_appended` 1, digest equal.
   - T5 no new line: touch the file, then append half a line, then the rest of it. `files_appended` 1 each time, cursor `mtime` updated, `last_ok` unchanged until the line is complete, digest equal.
   - T6 Codex: grow a Codex fixture (as in `test/driver.spec.ts:224-260`). `files_appended` 0.
   - T7 rebuild: `runIndex({ rebuild: true })` after an append. `files_appended` 0.
   Verify: the tests fail (no `files_appended`, or 0 where 1 is expected).
3. Write `src/indexer/append.ts` with the guards and writes above. Verify: `npm run typecheck`.
4. Wire it into `runIndex` and add `files_appended` to `IndexResult`. Verify: `npx vitest run test/driver_append.spec.ts` passes; `npm test` passes (existing tests that append, such as `test/driver.spec.ts:459`, now go through the append path and must still pass).
5. Update `AGENTS.md` and the `driver.ts` header comment. Run `npm run build` so `plugin/` matches the source. Verify: `npm run typecheck`, `npm test`, `node test/scripts/plugin-smoke.mjs`.

## Acceptance

- Every test in `test/driver_append.spec.ts` passes, and `npm test` passes.
- An appended Claude Code transcript is indexed by `appendNewLines` and reports only its new events; a change that fails a guard is re-derived and reports all events.
- The digest after appending equals the digest of a rebuild (S1, T1–T7).
- No change to `src/indexer/schema.ts`.

S1. Append to the fixture after a build. Run from the repository root after `npm run build`:

```sh
T=$(mktemp -d); mkdir -p $T/claude/projects/p $T/codex $T/a $T/b
F=$T/claude/projects/p/test.jsonl
head -n 900 test/fixtures/brainstorm-session.jsonl > $F
export CLENS_HOME=$T/claude CLENS_CODEX_HOME=$T/codex CLENS_INDEX_DIR=$T/a
node plugin/dist/cli.js index 2>&1 | head -1
tail -n 61 test/fixtures/brainstorm-session.jsonl >> $F
node plugin/dist/cli.js index 2>&1 | head -1
node plugin/dist/cli.js stats --digest > $T/a.json
CLENS_INDEX_DIR=$T/b node plugin/dist/cli.js index > /dev/null 2>&1
CLENS_INDEX_DIR=$T/b node plugin/dist/cli.js stats --digest > $T/b.json
cmp $T/a.json $T/b.json && echo digest-equal
rm -rf $T
```

`clens index` writes its summary and a `db:` line to stderr (`src/commands/index_cmd.ts:24-27`), hence `2>&1 | head -1`; `stats --digest` writes the digest JSON to stdout (`src/commands/stats_cmd.ts:53`). Expected output (the times vary):

```
clens index: parsed 1/1 files, 692 events, 0 parse_errors, <n>ms
clens index: parsed 1/1 files, 49 events, 0 parse_errors, <n>ms
digest-equal
```

Before this change the second line reads `741 events`: the whole session is re-derived (checked on 2026-11-06 at `c94a59c`). The 61 appended lines hold 49 lines with a `uuid`.

S2. An out-of-order line goes the full way. Run from the repository root after `npm run build`:

```sh
T=$(mktemp -d); mkdir -p $T/claude/projects/p $T/codex $T/a
F=$T/claude/projects/p/test.jsonl
cp test/fixtures/brainstorm-session.jsonl $F
export CLENS_HOME=$T/claude CLENS_CODEX_HOME=$T/codex CLENS_INDEX_DIR=$T/a
node plugin/dist/cli.js index > /dev/null 2>&1
printf '%s\n' '{"type":"user","uuid":"s2-early","sessionId":"test","timestamp":"2000-01-01T00:00:00.000Z","message":{"role":"user","content":"early"}}' >> $F
node plugin/dist/cli.js index 2>&1 | head -1
rm -rf $T
```

Expected: `clens index: parsed 1/1 files, 742 events, 0 parse_errors, <n>ms`: the line is dated before every message, so the session is re-derived and all 741 events plus the new one are written.

## Known Limits

- Codex transcripts are re-derived on every change, as today (Design, "Codex").
- A transcript rewritten in place so that the byte before `last_ok` is still `\n`, a valid JSON line starts at `last_ok`, and every event after it is new is indexed as an append: the rows of the replaced lines stay until the file is next re-derived (a change that fails a guard, `clens index --rebuild`, or a `SCHEMA_VERSION` bump). Whether Claude Code rewrites transcripts in place was not checked; A5 found no trace of it (no repeated uuid in any file).
- `events_inserted` and the CLI's event count mean "events written by this run": for an appended file, only the new events.
- FTS still collects deleted entries from re-derived sessions; with fewer re-derivations it collects fewer, and the hourly optimize stays.

## Open Questions

None.

## Goals Check

- Criterion 1 (time proportional to appended lines): met for Claude Code transcripts by the append path (A4); not for Codex, which stays on the full path for the reason in Design.
- Criterion 2 (Gate 2 after every run): met; each guard returns to the full path exactly where the index alone cannot reproduce a re-derivation, and T1–T7 compare digests with a rebuild.
- Criterion 3 (no schema change): met; the design reads `file_cursor.last_ok` and `lines`, which exist, and adds no column or table.

```skerry
{"run": "20261106-071925-be0e", "verify": ["npm run typecheck", "npm test", "node test/scripts/plugin-smoke.mjs"], "extras": []}
```

## Changes After Approval

- Implementation Order step 2, T3 `sidechain`: the document appends `isSidechain: true` with an `agentId` to a main file. The test appends it without an `agentId`. With an `agentId`, `parseEventLine` stores the line under the agent's own session, so guard 6 (`other_session`) fires before guard 10 and the sidechain guard is never reached; `other_session` has its own test.
- Implementation Order step 2, T3 `several_files`: the document builds it from "a second main file with lines of the same session". The test indexes a second main file and moves one of the session's `event` rows to it by hand. Every commit wipes a session and refills it from one file, so the current code never leaves one session with rows from two files; only an index written some other way holds that state, which is what the guard protects against.
- Implementation Order step 2, T3 (added check): each fallback case also calls `appendNewLines` directly on the grown file and asserts the reason it returns, so a case that fell back for another guard would fail.
- Implementation Order step 2, T1, T2, T4, T5 (added check): `events_inserted` is asserted to be the number of new events (T1: the lines with a `uuid` in each part; T2: 2; T4: 1; T5: 0, 0, 1), which pins Acceptance "reports only its new events".
- Implementation Order step 2 (added tests): "re-derives a subagent file that gains another agent's own line" (`other_session` in a subagent file) and "shrunk: the file is shorter than the bytes already indexed". They cover two guards the implementation applies beyond the document's text; the implementer's report gives the reasons.
- Design, Interfaces (`AppendFallback`) and Guards (after guard 5), review round 1: a new fallback `copied_lines`. A main file whose anomaly rows include `copied_session_line_skipped` goes the full way. `writableEvents` writes another session's lines of a main file only while that session has no rows, so once a file skipped such lines, re-deriving it can write a different set of its old lines (for example after that session's own file lost them); the append path never revisits old lines. Test: "copied_lines: the file skipped another session's lines, whose own file later lost them".
