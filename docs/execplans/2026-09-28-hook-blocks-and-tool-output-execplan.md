# Record hook blocks and tool output size, and report both in clens_stats

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This is bundle 2 of three plans written on 2026-09-28. It depends on bundle 1, `docs/execplans/2026-09-28-stats-scope-and-search-batch-execplan.md`, which must be implemented first (see "Prerequisite" under Context and Orientation). Bundle 3 (a per-session work record for use after context compaction) builds on the `hook_block` table this plan adds.


## Purpose / Big Picture

clens is a local tool that reads the conversation transcripts Claude Code writes to disk, stores them in a SQLite database, and answers questions about them through an MCP server (a process that Claude Code starts and whose "tools" the agent can call). Today an agent cannot answer two questions from clens and falls back to opening raw transcript files by hand.

The first question is "which hooks blocked what, and why". A hook is a user-configured shell command that Claude Code runs at fixed points; a PreToolUse hook can refuse a tool call before it runs, and a Stop hook can refuse to let the agent finish its turn. clens stores nothing about these refusals. In the session that motivated this plan (2026-09-28, session `abd0edc6`), the agent grepped transcripts for hook errors instead and got 5 hits, all false positives, because the phrase appeared in the middle of ordinary output.

The second question is "which tools filled the context window, and by how much". Every tool result the agent receives becomes part of its context, but clens keeps only whether a result was an error, not how large it was. The same session counted characters in a transcript by hand.

After this change, `clens_stats` gains two sections. "Hook blocks" lists how many times each hook event blocked each tool, plus the five most recent blocks with their session, time and reason. "Tool output" lists, per tool, how many results were measured and their total, average and largest size in characters. Both work for one project, all projects, a time window, or a single session, including the caller's own session through `session_id: "current"` (added by bundle 1). To see it working, index the synthetic fixture described in Concrete Steps into an empty temporary index and call `clens_stats`; the two sections print the exact numbers listed in Validation and Acceptance.

Premise check. This design holds only if three things are true, and all three were measured on 2026-09-28 over all 1,370 Claude Code transcripts on the author's machine. First, a PreToolUse block is recognizable without guessing: 60 tool results began with the text `<Event>:<Tool> hook error:` (for example `PreToolUse:WebFetch hook error:`), all 60 had `is_error: true`, and no result began with that text without `is_error`. Anchoring the match at the start of the text and requiring `is_error` is what rules out the grep false positives. Second, a Stop block is a separate JSONL line of `type: "attachment"` whose `attachment.type` is `"hook_blocking_error"`; there were 51, all with `hookEvent: "Stop"`, together with the PreToolUse ones 111 blocks in 40 sessions. Third, result size is available at the moment clens already reads each result to set `is_error`, so no new pass over the data is needed. What could break it: Claude Code changing either text shape in a future version (the parser would then silently record fewer blocks, which is why the tests pin both shapes), or a result whose text is not in `content` (images are deliberately not counted; see Decision Log).

Demand reality. The user is the author of clens, who uses Claude Code daily with many hooks installed (a fact-forcing gate, context-mode redirects, a requirements ledger Stop hook) and wants to stop using the context-mode plugin, whose per-tool usage statistics were one of its few features worth keeping. The status quo is opening transcripts by hand or grepping them, which produced false positives and cost a long detour in the motivating session. The narrowest useful version is exactly the two stats sections above, for Claude Code only. Why now: bundle 1 makes `clens_stats` work across all projects and for the current session, so these two sections become answerable in one call; and in the measured data tool results total 36,120,031 characters over 18,425 results, of which Bash alone is 17,903,455 (49%), Read 7,068,320 and context-mode's `ctx_execute` 4,322,045, so the question "what is using my context" has a large, concrete answer that clens currently cannot give.


## Progress

- [x] (2026-09-28 14:16) Confirm bundle 1 is implemented (see Prerequisite). Baseline before any change: `tsc --noEmit` clean, 341 tests in 29 files pass.
- [x] (2026-09-28 14:16) Replace the index reset with an in-place upgrade in `applySchema()` (see Decision Log).
- [x] (2026-09-28 14:21) Milestone 1: schema v5 (`tool_call.result_chars` with its in-place upgrade, `hook_block` table), types, Claude parser detection, writer, digest; parser, schema and Gate 2 tests pass. The 9 new cases failed first (missing `result_chars`, `hook_blocks`, `hook_block` table); after the change `tsc --noEmit` is clean and the six Milestone 1 spec files pass, 88 tests.
- [x] (2026-09-28 14:24) Milestone 2: analyzers `analyzeHookBlocks` and `analyzeToolOutput`, two new stats sections, formatter, tool description; stats tests pass. The new `test/mcp_stats.spec.ts` cases first failed on the missing `src/analyzer/tool_output.js`, then with the analyzers in place 7 of 8 failed on the unwired sections (the `sections: ["tools"]` case passed from the start, because it checks that the fields are absent). After wiring, `tsc --noEmit` is clean and `npm test` passes, 355 tests in 29 files; `STATS_DESCRIPTION` is 1,203 characters.
- [x] (2026-09-28 14:25) Milestone 3: end-to-end on a fresh install through the MCP server. The script printed both sections exactly as under Milestone 2 in Plan of Work, then `gate 2 ok` and `"row_count": 2` for `hook_block`.
- [x] (2026-09-28 14:31) Extra check, not in the original plan: upgraded a copy of the developer's real v4 index (made with `sqlite3 .backup` into the agent's scratch directory, `CLENS_INDEX_DIR` pointing there, transcripts read from their real place) with the new build. See Surprises & Discoveries for the numbers; the copy was deleted afterwards.
- [x] (2026-09-28 14:56) Restart the clens MCP servers so the new build upgrades the developer's own index. The user backed up the index (v4, 3,493 sessions) and restarted every server; all 9 started at 14:34, after the 14:25 build. A new server's watcher ran the upgrade itself, so the user's `node dist/cli.js index` got "indexer busy" as step 4 describes. At 14:56 the index was v5 with 3,512 sessions, 115 `hook_block` rows in 41 sessions and 19,293 measured results.
- [x] (2026-09-28 14:57) Acceptance after the upgrade: `clens_stats` with `session_id: "current"` printed a tool output section (105 calls, 192,558 chars) and without `project_id` printed `Hook blocks: 80`.
- [x] Update `docs/BACKLOG.md` only if something was deferred during implementation: nothing was deferred, so it is unchanged.
- [x] (2026-09-28 14:58) Write Outcomes & Retrospective.
- [x] (2026-09-28 15:13) Code review of this bundle only (bundle 1 was reviewed before): no blocking finding, five improvements; fixed 1, 2, 4 and 5 (see Decision Log). The new stats test first failed with `no such table: hook_block`; the two parser guard tests passed at once and failed with their guard removed. `tsc --noEmit` is clean and `npm test` passes, 358 tests. `dist/` was not rebuilt after these fixes.


## Surprises & Discoveries

- Observation: a Stop hook's `attachment.toolUseID` is not the id of any tool call.
  Evidence: in the 51 `hook_blocking_error` lines, 0 `toolUseID` values matched a `tool_use` block id in the same file. So `hook_block.call_id` is NULL for Stop blocks; it is set only for PreToolUse blocks, where it is the blocked tool call's id.

- Observation: attachment lines already become rows in the `event` table today.
  Evidence: they carry a `uuid`, so `parseEventLine` in `src/indexer/claude_parser.ts` does not skip them; they have no `message`, so `walkContent` bumps the `null_content` anomaly (line ~212). This plan leaves both behaviors unchanged, so existing anomaly counts do not move.

- Observation: all 60 PreToolUse block results store `content` as a plain string, not an array of blocks.
  Evidence: shape count over all transcripts: `{"string is_error=true": 60}`. The parser must still read the array form, because ordinary results use both forms.

- Observation: three existing Codex parser tests compare a tool-results map entry with `toEqual({ ts, is_error })`.
  Evidence: `test/codex_parser.spec.ts` lines ~62 (`call-1`), ~88 (`call-p`) and ~168 (`call-3`). Once every Codex entry carries `result_chars: null`, those assertions fail until `result_chars: null` is added to their expected objects. That edit is required by this plan, not a regression.

- Observation: the incremental-vs-rebuild test in `test/digest.spec.ts` (the `it` at line ~70) compares its own `tablesToCheck` list (line ~142), not `TABLE_ORDER` from `src/indexer/digest.ts`.
  Evidence: the list names 14 tables and is iterated with `SELECT * FROM <table>` per table. A table missing from it is never compared across the incremental and rebuild indexes, so `hook_block` must be added to that list explicitly.

- Observation: the MCP server that Claude Code runs keeps a file watcher that calls `runIndex` about 500 ms after any transcript change (`src/indexer/watch.ts`, "debounces 500ms then runs an incremental index").
  Evidence: a server started from the build before this change keeps the old code in memory. When it indexes an `index.db` that the new build has upgraded, it sees version 5, which differs from its own 4, rebuilds every session whose transcripts are still on disk with the old code (which leaves `result_chars` NULL and does not clear `hook_block`) and writes version 4 back (`runIndex` in `src/indexer/driver.ts`, the `needsRebuild` branch). The next run of the new build sees 4 and rebuilds again. The two builds then keep rebuilding the whole index in turn. This is why every clens MCP server is restarted after the build, a step the user runs.

- Observation: on a copy of the developer's real v4 index (1.6 GB, 3,493 sessions), `node dist/cli.js index` with the new build took 262 s, exited 0, and left 3,512 sessions (none lost; the extra ones are transcripts on disk the live index had not reached yet).
  Evidence: afterwards `schema_version` was 5 and `tool_call`'s columns ended in `is_error,result_chars`; `hook_block` held 115 rows in 41 sessions (64 PreToolUse, 51 Stop) against the 111 in 40 measured earlier that day; Claude Code calls with a measured result numbered 19,259 totalling 39,881,797 characters (Bash 20,191,671, Read 8,759,959, `ctx_execute` 4,321,815); no Codex call was measured. 27,866 answered Claude Code calls kept `result_chars` NULL, and every one of them belongs to the 1,025 sessions whose transcripts are gone, which the upgrade keeps as they were.

- Observation: the MCP server never upgrades the index by itself when it starts.
  Evidence: it opens `index.db` with `{ readonly: true }` (`getDb()` in `src/mcp/server.ts`, line ~94); only `openIndex()` in `src/indexer/driver.ts` calls `applySchema()`, and the watcher calls `runIndex` only after a transcript changes (`schedule()` in `src/indexer/watch.ts`). So between a restart and the first index run, the index has no `hook_block` table and no `result_chars` column. As first built, every `clens_stats` call that included either new section failed, and both are in the default section list, so a plain call that had worked before failed with `no such table: hook_block`; the code review found this. `projectStats` now reports those sections as not indexed yet (see Decision Log). The restart steps still run `node dist/cli.js index` once instead of waiting for a transcript change.

- Observation: tests that set only `CLENS_HOME` do not read the real `~/.codex`.
  Evidence: `codexHome()` in `src/util/paths.ts` (lines ~40 to ~47) returns `<CLENS_HOME>/__no_codex__` when `CLENS_HOME` is set and `CLENS_CODEX_HOME` is not, so `test/digest.spec.ts` needs no `CLENS_CODEX_HOME`. The hand-run commands in Concrete Steps set it anyway, because there `CLENS_HOME` is set explicitly too and being explicit costs nothing.

- Observation: the reason text of a Stop block is nested one level deeper than its name suggests.
  Evidence: observed line shape `{"type":"attachment","uuid":…,"timestamp":…,"sessionId":…,"attachment":{"type":"hook_blocking_error","hookName":"Stop","toolUseID":…,"hookEvent":"Stop","blockingError":{"blockingError":"<reason text>","command":"<hook command>"}}}`.


## Decision Log

- Decision: store the result size as a new column `result_chars INTEGER` on the existing `tool_call` table, not as a new table.
  Rationale: the size belongs to exactly one tool call and is set at the same place `is_error` and `duration_ms` are already set (`updateToolCallResult` in `src/indexer/writer.ts`), so a column is the smallest change and needs no join. `CREATE TABLE IF NOT EXISTS` never adds a column to an existing table, and `runIndex`'s schema-version rebuild only deletes rows (see the v4 comment in `src/indexer/schema.ts`), so an existing index needs an explicit upgrade; see the next decision.
  Date/Author: 2026-09-28, user and Claude.

- Decision: upgrade an existing index in place. Inside `applySchema()`'s transaction, after the `CREATE` statements, read `PRAGMA table_info(tool_call)` and run `ALTER TABLE tool_call ADD COLUMN result_chars INTEGER` when no column is named `result_chars`. The version bump to 5 then makes `runIndex` re-read every transcript still on disk, which fills `result_chars` and `hook_block`. This replaces the earlier decision of the same day to move `~/.clens/index.db` aside and build a fresh one.
  Rationale: a fresh index would have lost every session whose transcript Claude Code had already deleted, because the old index is their only copy, and clens's own server instructions promise to keep those. The upgraded index keeps them; they get `result_chars` NULL and no `hook_block` rows, because their text is gone and cannot be measured. `is_error` is the last column of `tool_call`, so the added column lands where a fresh `CREATE TABLE` puts it and `SELECT *`, which the digest uses for `tool_call`, reads the same on an upgraded and on a fresh index. `hook_block` needs no upgrade code, because `CREATE TABLE IF NOT EXISTS` creates it. The upgrade does not remove the need to restart every clens MCP server after the build (see Surprises & Discoveries).
  Date/Author: 2026-09-28, suggested by another agent session and accepted by the user.

- Decision: store hook blocks in a new table `hook_block`, one row per block.
  Rationale: a Stop block is not a tool call, so it cannot live on `tool_call`. One table serves both kinds with nullable `tool` and `call_id`.
  Date/Author: 2026-09-28, user and Claude.

- Decision: `result_chars` counts Unicode code points of the result's text only. Image blocks and any other non-text blocks inside a result contribute 0.
  Rationale: clens already measures text as code points (`codepointLength` in `src/indexer/claude_parser.ts`). An image's context cost is not proportional to its base64 length, so adding that length would mislead more than it helps. The limitation is stated in the tool description.
  Date/Author: 2026-09-28, Claude.

- Decision: keep the rule that the index does not store tool output text.
  Rationale: `docs/BACKLOG.md` records "Store conversation text only" (2026-09-26). This plan stores only a number per result and, for blocks, at most 512 bytes of the hook's own reason text, the same size cap `system_reminder.text_excerpt` uses.
  Date/Author: 2026-09-28, user and Claude.

- Decision: for a PreToolUse block, `reason` is the text after the matched prefix `<Event>:<Tool> hook error:`, trimmed, then cut to 512 bytes on a UTF-8 character boundary. For a Stop block it is `attachment.blockingError.blockingError`, cut the same way, or NULL when that field is not a string.
  Rationale: the prefix repeats information already in `hook_event` and `tool`. Only the observed shapes are handled; no guessed formats.
  Date/Author: 2026-09-28, Claude.

- Decision: the attachment branch records a block only when its `hookEvent` is not `"PreToolUse"`.
  Rationale: PreToolUse blocks are taken from the blocked call's `tool_result`. No PreToolUse `hook_blocking_error` attachment was seen (all 51 were Stop), but if Claude Code ever wrote one next to the error result, recording both would count the same block twice.
  Date/Author: 2026-09-28, Claude (from spec review).

- Decision: the analyzers return full lists and `src/mcp/stats.ts` applies the display caps, printing "(+N more)" when a list is cut.
  Rationale: bundle 1 puts list caps in `src/mcp/stats.ts`, not in analyzers, so every stats section is cut and labelled the same way. `analyzeToolOutput` therefore returns every tool, and `stats.ts` keeps the first 15. `analyzeHookBlocks`'s five `recent` rows are not a cap on a longer list shown elsewhere: they are the definition of "recent", so that limit stays in the analyzer's query.
  Date/Author: 2026-09-28, Claude (from spec review).

- Decision: `StatsFacts.tool_output` is `ToolOutputFacts` with every tool, and `formatStats` cuts the printed list to `STATS_TOOL_OUTPUT_TOP = 15` with bundle 1's `moreLine()`. There is no `StatsToolOutput` type and no `more` field.
  Rationale: bundle 1 as built keeps full lists in `StatsFacts` (`tool_counts`, `skills`, `files`) and cuts them only in `formatStats`, computing N for "(+N more)" from the list lengths there (`moreLine` in `src/mcp/stats.ts`). The plan said to use bundle 1's shape if it differed from `more`; this is that shape. The 17-tool test therefore checks the printed `  (+2 more)` line and that both `analyzeToolOutput` and `projectStats` return all 17 tools.
  Date/Author: 2026-09-28, Claude (following the rule the plan set for this case).

- Decision: after the code review, fix four of its five points and leave the fifth. (1) `projectStats` runs the two new analyzers through `ifIndexed()`, which turns `no such table: hook_block` and `no such column: result_chars` into a `not_indexed` list, and `formatStats` prints `<Section>: not indexed yet (the index predates this clens version; run clens index)`; other errors still propagate. (2) Two parser tests pin the `is_error` guard (a non-error result that opens with the prefix) and the PreToolUse attachment skip; removing either guard now fails its test. (4) `skills/clens-stats/SKILL.md` names the two sections, when to ask for them, and their limits. (5) `STATS_DESCRIPTION` says that Codex sessions and sessions whose transcripts were deleted before recording began have neither section, so older totals undercount. Left for later: (3) a test of the upgrade through `runIndex`, since the reviewer's temp-dir run and the real-scale upgrade both showed it working.
  Rationale: the user chose points 1, 2, 4 and 5. Point 1 mattered most: both sections are in the default list, so without it a plain `clens_stats` call on a not-yet-upgraded index failed where it had worked before. `search.ts` already treats a missing layer table the same way.
  Date/Author: 2026-09-28, user and Claude.

- Decision: the new Gate 2 case in `test/digest.spec.ts` builds its own two fake homes instead of reusing home A from the file's `beforeEach`.
  Rationale: that home A already holds a copy of `brainstorm-session.jsonl`, so writing the hook fixture into it and into a fresh B would compare different inputs. Both new homes hold only lines 1 to 12 of the hook fixture, as the plan intends.
  Date/Author: 2026-09-28, Claude.

- Decision: in the "tool output" section, `calls` counts only calls whose `result_chars` is not NULL, and a tool with no measured calls does not appear.
  Rationale: a NULL means no result was seen (the call was interrupted, or the result sits in a file not yet indexed); counting such calls would lower the average for no real reason. Plain call counts including unmeasured calls are already in the "tools" section.
  Date/Author: 2026-09-28, Claude.

- Decision: rejected estimating per-tool context use from the growth of `event.in_tok` between consecutive assistant turns.
  Rationale: it needs no schema change, but one assistant turn often calls several tools at once and the growth cannot be split among them, and prompt caching and compaction make the numbers jump.
  Date/Author: 2026-09-28, user and Claude.

- Decision: Codex is out of scope for this plan. Codex rows keep `result_chars` NULL and produce no `hook_block` rows.
  Rationale: the user chose to build for Claude Code first and write down what Codex needs for a later plan (see Artifacts and Notes, "Later: Codex").
  Date/Author: 2026-09-28, user.


## Outcomes & Retrospective

Achieved (2026-09-28). The indexer records the size of every Claude Code tool result (`tool_call.result_chars`) and every hook refusal (`hook_block`), and `clens_stats` reports both as the "Hook blocks" and "Tool output" sections for one session, one project, all projects or a time window. Every acceptance criterion was met: the fresh-install script printed the expected text exactly, the two decoy results produced no block, `npm test` passes (355 tests, 14 of them new), the anomaly counts did not move, the hand-run Gate 2 check printed `gate 2 ok`, and on the developer's own upgraded index the current-session and all-project calls both returned data. The upgrade kept every session: 3,512 afterwards against 3,493 in the backup.

Changed from the plan as written: the developer's index is upgraded in place instead of being replaced, and the tool-output cap follows bundle 1's list shape; both are in the Decision Log. Remaining: Codex results stay unmeasured and Codex hook outcomes are unexplored (Artifacts and Notes, "Later: Codex"); 27,866 answered calls in the 1,025 sessions whose transcripts are gone will always have `result_chars` NULL.

Learned. Measuring the real data before writing the plan paid off: both block shapes were exactly as recorded, and the real-scale counts (115 blocks against 111 measured that morning) matched within the sessions added since. Upgrading a copy of the real index before touching the live one showed the upgrade time (about 4.5 minutes) and that the unmeasured calls all come from gone transcripts, which the fixture could not show. The watcher of a freshly restarted server starts the upgrade by itself on the first transcript change, so the explicit `node dist/cli.js index` step mostly reports "indexer busy"; it is still the way to force the upgrade when no transcript is changing.


## Context and Orientation

The repository is a TypeScript Node.js project (`"type": "module"`, compiled with `tsc`). All relative imports end in `.js` even though the source files are `.ts`, for example `import { analyzeTools } from "../analyzer/tools.js";`. TypeScript runs with `strict` and `noUncheckedIndexedAccess`, so indexing an array yields `T | undefined`. Tests use Vitest and live in `test/*.spec.ts`.

There are three parts that talk only through the SQLite database. The indexer (`src/indexer/`) reads transcript files and writes rows. The analyzer (`src/analyzer/`) turns SQL into typed facts, one module per topic, each taking a `Scope`. The MCP server (`src/mcp/`) exposes the `clens_*` tools and formats the facts as text. The CLI entry is `src/cli.ts`; after `npm run build`, `node dist/cli.js index` indexes and `node dist/cli.js stats --digest` prints a SHA-256 per table.

Paths. Production reads Claude Code transcripts from `~/.claude/projects/**/*.jsonl` and Codex ones from `~/.codex/sessions/`, and writes the index to `~/.clens/index.db`. Tests and experiments must override all three through environment variables read in `src/util/paths.ts`: `CLENS_HOME` replaces `~/.claude`, `CLENS_CODEX_HOME` replaces `~/.codex`, and `CLENS_INDEX_DIR` replaces `~/.clens`. Never let a test or experiment touch the real `~/.claude`.

A transcript is a JSONL file: one JSON object per line. The lines that matter here look like this (shortened). An assistant line holds `message.content`, an array of blocks; a `tool_use` block has `id`, `name` and `input`. The next user line holds a `tool_result` block with `tool_use_id` (the matching `id`), `content` (a string, or an array of blocks such as `{"type":"text","text":…}` and `{"type":"image",…}`) and optionally `is_error: true`. An attachment line has `type: "attachment"` and an `attachment` object instead of a `message`.

The indexer flow, with the functions to touch:

`src/indexer/schema.ts` holds every `CREATE` statement in `SCHEMA_STATEMENTS` and the constant `SCHEMA_VERSION` (currently 4, line ~39). `applySchema()` runs them all; `getSchemaVersion()` reads the stored version. The `tool_call` table is defined at line ~140 with columns `event_uuid, session_id, ts, call_id, name, input_json, duration_ms, is_error`; `system_reminder` (line ~264) is the model for a small excerpt table.

`src/indexer/types.ts` defines the row interfaces (`ToolCallRow` at line ~32, `SystemReminderRow` at ~85), `ParsedEvent` (line ~120, one parsed JSONL line plus its child rows) and `FileParseResult` (line ~132). The map of tool results, `tool_results: Map<string, { ts: string; is_error: 0 | 1 }>` at line ~162, carries each result's time and error flag from the line where the result appears to the tool call it answers. The same inline map type is repeated in `src/indexer/claude_parser.ts` (lines ~201, ~478, ~597), `src/indexer/codex_parser.ts` (~362, ~420), `src/indexer/driver.ts` (~230) and `src/indexer/writer.ts` (~265).

`src/indexer/claude_parser.ts`: `parseFileBody()` (line ~590) splits a file into lines and calls `parseEventLine()` (line ~478) for each. `parseEventLine` builds the `event` row and a `ParsedEvent` with empty child arrays (line ~550), then calls `walkContent()` (line ~192) on `message.content`. In `walkContent`, the `tool_result` branch (line ~362) records `{ ts, is_error }` into `toolResults` under the block's `tool_use_id`. `utf8SafeTruncate(s, cap)` (line ~100) cuts a string to at most `cap` bytes without splitting a character; `codepointLength(s)` (line ~93) counts code points. The constant `SYSTEM_REMINDER_EXCERPT_CAP = 512` is at line ~41.

`src/indexer/codex_parser.ts` builds the same structures for Codex. It creates a `ParsedEvent` at line ~325 and fills its tool-results map at lines ~516, ~635 and ~676.

`src/indexer/writer.ts`: `prepareStatements()` builds all SQL statements. `insertToolCall` is at line ~89. `updateToolCallResult` (line ~126) sets `duration_ms` and `is_error` on the `tool_call` row whose `call_id` matches, only while `duration_ms IS NULL`. `wipeSessions()` (line ~176) deletes every derived row of the given sessions. `writeParsedEvent()` (line ~192) inserts one `ParsedEvent` and its child rows. `applyToolResults()` (line ~263) runs `updateToolCallResult` for every entry of the map.

`src/indexer/driver.ts`: `commitFile()` (line ~220) runs one transaction per file: upsert project and session, `wipeSessions` for the affected sessions, insert all events with `writeParsedEvent`, then `applyToolResults`, then flush anomalies. `runIndex()` (line ~398) opens the database, compares the stored schema version with `SCHEMA_VERSION`, and on a mismatch or `--rebuild` deletes the rows of every session whose transcript files still exist and re-reads those files (lines ~410 to ~455); sessions whose files are gone are kept untouched.

`src/indexer/digest.ts`: `TABLE_ORDER` (line ~21) lists every table with a deterministic `ORDER BY`; `digestAllTables()` hashes each table's rows. This is what the "Gate 2" tests compare.

Two rules from `CLAUDE.md` constrain the indexer. Gate 2: indexing one changed file incrementally must produce byte-identical table contents to a full `--rebuild`; `test/digest.spec.ts` checks it by comparing `digestAllTables` output. The anomaly counts (rows in the `anomaly` table, e.g. `null_content`) are part of the parser's contract and are asserted in `test/driver.spec.ts` and `test/claude_parser.spec.ts`; this plan must not change them.

The analyzer and MCP side, with the functions to touch:

`src/analyzer/scope.ts` defines `Scope` (a session, a project with optional `since`, all data, or all data since a date) and `sessionScopedWhere(scope, sessionIdColumn, tsColumn)`, which returns a SQL fragment and bind values for any table that has a session id and a timestamp. `src/analyzer/tools.ts` (`analyzeTools`) is the pattern to copy: it calls `sessionScopedWhere(scope, "session_id", "ts")` and queries `tool_call`.

`src/mcp/stats.ts` exports `projectStats(db, params)`, which builds a `Scope`, calls each analyzer and returns `StatsFacts`. `formatStats(facts)` turns the facts into text; before bundle 1 it is in `src/mcp/server.ts` (line ~276); find it with `grep -rn "function formatStats" src/mcp`. The `clens_stats` tool definition, including its description string, is in `src/mcp/server.ts` (line ~247). Claude Code cuts any tool description longer than 2,048 characters.

Prerequisite: bundle 1. Before starting, confirm bundle 1 is in place by running, from the repository root:

    grep -n "export type StatsSection" src/mcp/stats.ts
    ls src/mcp/current_session.ts

The first must print a line defining `StatsSection = "tools" | "skills" | "agents" | "health" | "timeline" | "files"`, and the second must list the file. If either fails, implement `docs/execplans/2026-09-28-stats-scope-and-search-batch-execplan.md` first and stop here. This plan relies on exactly these bundle 1 facts: `projectStats` accepts `sections?: StatsSection[]` (all sections when omitted) and computes only the selected sections; `project_id` may be omitted to cover all projects; `session_id: "current"` is resolved by `resolveSessionId(value, currentSessionId)` in `src/mcp/current_session.ts`; and in project and all-project scopes, sessions of kind `pipeline` and `exec` are left out. Because the new analyzers use `sessionScopedWhere` like every other analyzer, they inherit that exclusion without extra code; Milestone 2 includes a test that proves it.


## Plan of Work

Milestone 1 makes the indexer record both facts. At the end, a fresh index built from the fixture has `result_chars` filled on every answered tool call and two rows in `hook_block`, and incremental indexing still equals a rebuild.

In `src/indexer/schema.ts`, add `result_chars INTEGER` to the `tool_call` `CREATE TABLE` statement after `is_error`, and add a new statement after the `system_reminder` block:

    CREATE TABLE IF NOT EXISTS hook_block (
      event_uuid  TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      ts          TEXT NOT NULL,
      hook_event  TEXT NOT NULL,
      tool        TEXT,
      call_id     TEXT,
      reason      TEXT,
      FOREIGN KEY (event_uuid) REFERENCES event(uuid)
    )

and `CREATE INDEX IF NOT EXISTS hook_block_session_idx ON hook_block(session_id)`. One index is enough: every read and the wipe filter by `session_id` (the scope helper produces `session_id = ?` or `session_id IN (SELECT id FROM session …)`), and the table is small (111 rows on the author's machine), so sorting by `ts` needs no index. In `applySchema()`, inside its transaction right after the loop over `SCHEMA_STATEMENTS`, add the column to an index created before this change: read `PRAGMA table_info(tool_call)` and, when no column is named `result_chars`, run `ALTER TABLE tool_call ADD COLUMN result_chars INTEGER` (see Decision Log). Set `SCHEMA_VERSION = 5` and add a comment line in the version history above it: "v5: tool_call.result_chars and the hook_block table. A v4 index.db is upgraded in place: applySchema() adds the column, and the version-mismatch rebuild in runIndex() re-reads every transcript still on disk to fill it."

In `src/indexer/types.ts`, add `result_chars: number | null` to `ToolCallRow`; add `export interface HookBlockRow { event_uuid: string; session_id: string; ts: string; hook_event: string; tool: string | null; call_id: string | null; reason: string | null; }`; add `hook_blocks: HookBlockRow[]` to `ParsedEvent`; and add `export type ToolResultInfo = { ts: string; is_error: 0 | 1; result_chars: number | null };`. Replace every inline `Map<string, { ts: string; is_error: 0 | 1 }>` listed in Context and Orientation with `Map<string, ToolResultInfo>`, importing the type where needed. Run `npm run typecheck`; the compiler now points at every place that builds a `ToolCallRow`, a `ParsedEvent` or a map entry.

Fix those places. Every `ToolCallRow` literal gets `result_chars: null` (the claude parser's `tool_use` branch at line ~301 and the Codex parser at lines ~492, ~622, ~662). Every `ParsedEvent` literal gets `hook_blocks: []` (`claude_parser.ts` ~550, `codex_parser.ts` ~325, `test/writer_lang.spec.ts` ~56). Every Codex map entry gets `result_chars: null` (lines ~516, ~635, ~676). Because of that, update the three expectations in `test/codex_parser.spec.ts` that compare a map entry with `toEqual`: line ~62 (`call-1`), line ~88 (`call-p`, `{ ts: "2026-07-01T00:00:03Z", is_error: 0 }`) and line ~168 (`call-3`). Add `result_chars: null` to each expected object and change nothing else in them.

In `src/indexer/claude_parser.ts`, add near the other constants `const HOOK_REASON_BYTE_CAP = 512;` and `const HOOK_ERROR_PREFIX_RE = /^(\w+):(\S+) hook error:/;`. Add a helper `toolResultText(content: unknown): string` that returns `content` when it is a string, the concatenation of `text` fields of blocks whose `type` is `"text"` when it is an array, and `""` otherwise. In the `tool_result` branch of `walkContent`, compute `const text = toolResultText(b.content)` and store `result_chars: codepointLength(text)` in the map entry alongside `ts` and `is_error`. Then, when `is_error === 1` and `tool_use_id !== null` and `HOOK_ERROR_PREFIX_RE` matches `text`, push onto `out.hook_blocks` a row with `hook_event` = first capture, `tool` = second capture, `call_id` = `tool_use_id`, and `reason` = the rest of `text` after the match, trimmed and cut with `utf8SafeTruncate(…, HOOK_REASON_BYTE_CAP).out` (NULL when the rest is empty). In `parseEventLine`, after `walkContent` returns, add: when `o.type === "attachment"` and `o.attachment` is an object whose `type` is `"hook_blocking_error"` and whose `hookEvent` is a string other than `"PreToolUse"` (PreToolUse blocks come from the tool result above; see Decision Log), push a row with that `hookEvent`, `tool: null`, `call_id: null`, and `reason` = `attachment.blockingError.blockingError` cut to 512 bytes when that is a string, else NULL. Do not add or remove any anomaly bump; the attachment line keeps its existing `null_content` bump.

In `src/indexer/writer.ts`, change `insertToolCall` to include `result_chars` / `@result_chars`; change `updateToolCallResult` to also `SET result_chars = @result_chars` (keep the `duration_ms IS NULL` condition, so `result_chars` follows exactly the same rule `is_error` already follows and inherits its Gate 2 behavior); make `applyToolResults` pass `result_chars`. Add `insertHookBlock` (`INSERT INTO hook_block (event_uuid, session_id, ts, hook_event, tool, call_id, reason) VALUES (@event_uuid, …)`) and `wipeHookBlocksForSession` (`DELETE FROM hook_block WHERE session_id = ?`). Call the wipe in `wipeSessions` next to `wipeSystemRemindersForSession` (before `wipeEventsForSession`), and insert `p.hook_blocks` in `writeParsedEvent` next to the system reminders.

In `src/indexer/digest.ts`, add `["hook_block", "event_uuid, ts, hook_event, COALESCE(call_id, '')"]` to `TABLE_ORDER` after `system_reminder`, so the Gate 2 tests cover the new table. `tool_call` is hashed with `SELECT *`, so `result_chars` is covered already.

Add the fixture `test/fixtures/hook-blocks-session.jsonl` with the exact content in Artifacts and Notes. It is synthetic: do not copy any real transcript text into it.

Tests for Milestone 1. In `test/schema.spec.ts`, add `"hook_block"` to the expected table list (line ~23) and `"hook_block_session_idx"` to the expected index list (line ~38). Also add a case for the upgrade: in an empty in-memory database, create `tool_call` with the v4 statement (the current one, without `result_chars`), run `applySchema`, and assert that `PRAGMA table_info(tool_call)` lists the same columns in the same order as a database `applySchema` created from nothing, and that running `applySchema` a second time leaves them unchanged. In `test/claude_parser.spec.ts`, add a `describe("hook blocks and result size", …)` that reads the fixture with `readFileSync`, parses it with `parseFileBody({ body, source_file, batch: freshBatch() })` (the file already defines `freshBatch()` at line ~14 and uses this call at line ~49), and asserts on `result.tool_results` and on the `hook_blocks` of `result.events`: the map entry for `toolu_1` has `result_chars` 5, `toolu_2` 78, `toolu_3` 5 (image not counted), `toolu_4` 54, `toolu_5` 42, and there is no entry for `toolu_6`; exactly two hook block rows exist across all events, one `{hook_event: "PreToolUse", tool: "Bash", call_id: "toolu_2", reason: "[policy] curl is blocked. Use the sandbox instead."}` and one `{hook_event: "Stop", tool: null, call_id: null, reason: "Unresolved items remain in the ledger."}`; and `toolu_4` (prefix mid-text, not an error) and `toolu_5` (an error, prefix mid-text) produce no block. Add one case with a synthetic PreToolUse error whose reason is 300 Korean characters (900 bytes) and assert the stored reason is at most 512 bytes and still valid UTF-8 (`Buffer.from(reason).toString() === reason`). In `test/digest.spec.ts`, first add `"hook_block"` to the `tablesToCheck` array in the existing test "rebuild after a real append matches incremental after the same append" (the array at line ~142; that test compares only the tables in this list, not `TABLE_ORDER`). Then add a new `it("hook blocks: rebuild after an append matches incremental", …)` that follows the same four steps as that test (lines ~70 to ~185), with these differences. Instead of copying `brainstorm-session.jsonl`, write only lines 1 to 12 of `test/fixtures/hook-blocks-session.jsonl` into both fake homes A and B, as `projects/proj-H/hooks-s1.jsonl`. After both initial rebuilds, append line 13 (the Stop attachment, uuid `h-at1`) to both copies; do not append any other line, so no uuid appears twice. Push both files' mtime forward as the existing test does, run A incremental and B rebuild, and compare every table in `tablesToCheck` (including `hook_block`) the same way. Finally assert `SELECT COUNT(*) FROM hook_block` is 2 in both A and B. `CLENS_CODEX_HOME` does not need to be set here; see Surprises & Discoveries.

Milestone 2 reports the facts. At the end, `projectStats` returns `hook_blocks` and `tool_output`, and the MCP text output shows them by default.

Create `src/analyzer/hook_blocks.ts` exporting `analyzeHookBlocks(db, scope): HookBlocksFacts`, where `HookBlocksFacts = { total: number; by_hook: Array<{ hook_event: string; tool: string | null; count: number }>; recent: Array<{ session_id: string; ts: string; hook_event: string; tool: string | null; reason_line: string | null }> }`. Build the filter with `sessionScopedWhere(scope, "session_id", "ts")` against `hook_block`. `by_hook` groups by `hook_event, tool`, ordered by `count DESC, hook_event, tool`. `recent` is the five newest rows by `ts DESC, event_uuid`; `reason_line` is the reason's first line cut to 150 code points with "…" appended when cut (`cutChars` in `src/mcp/search.ts` does the cutting, but analyzers must not import from `src/mcp/`, so write the four-line cut locally).

Create `src/analyzer/tool_output.ts` exporting `analyzeToolOutput(db, scope): ToolOutputFacts`, where `ToolOutputFacts = { measured_calls: number; total_chars: number; by_tool: Array<{ name: string; calls: number; total_chars: number; avg_chars: number; max_chars: number }> }`. Query `tool_call` with the same scope helper and `result_chars IS NOT NULL`, group by `name`, order by `total_chars DESC, name`, and return every tool (no cap here; `src/mcp/stats.ts` cuts the list, see below). `avg_chars` is `Math.round(total_chars / calls)`. `measured_calls` and `total_chars` at the top are over all tools.

In `src/mcp/stats.ts`, extend `StatsSection` with `"hook_blocks"` and `"tool_output"`, include both in the default list used when `sections` is omitted, add optional `hook_blocks?: HookBlocksFacts` and `tool_output?: ToolOutputFacts` to `StatsFacts` (follow the optional-field pattern bundle 1 used for the other sections), and call the two analyzers only when their section is selected. `tool_output` keeps every tool, as bundle 1's lists do; put `STATS_TOOL_OUTPUT_TOP = 15` in `src/mcp/stats.ts` next to the caps bundle 1 added there, and have `formatStats` print that many tools and add the "(+N more)" line with bundle 1's `moreLine()` (see Decision Log). In `formatStats`, print, after "Files touched":

    Hook blocks: 2
      PreToolUse Bash: 1
      Stop: 1
      Recent:
        2026-09-01T10:00:12.000Z session:hooks-s1 Stop: Unresolved items remain in the ledger.
        2026-09-01T10:00:04.000Z session:hooks-s1 PreToolUse Bash: [policy] curl is blocked. Use the sandbox instead.

    Tool output (characters of tool results, text only): 5 calls, 184 chars
      Bash: 4 calls, total 179, avg 45, max 78
      Read: 1 calls, total 5, avg 5, max 5

A recent block whose `reason_line` is NULL prints without the trailing part, for example `2026-09-01T10:00:12.000Z session:hooks-s1 Stop`. When more than 15 tools were measured, print one more line under the tool list, `  (+N more)`, with N the number of tools not listed. When there are no blocks, print `Hook blocks: 0`; when no call is measured, print `Tool output: (none measured)`.

Make the two new names selectable in the `clens_stats` input schema. If bundle 1 builds the JSON-schema `sections` enum from a `STATS_SECTIONS` array in `src/mcp/stats.ts`, adding the names to `StatsSection` and to `STATS_SECTIONS` is enough; otherwise add them to the enum written in `src/mcp/server.ts`. Check with `grep -n "STATS_SECTIONS" src/mcp/stats.ts src/mcp/server.ts`.

Update the tool description. If `src/mcp/instructions.ts` already exports `STATS_DESCRIPTION` (bundle 1 moves it there), edit it there; otherwise move the `clens_stats` description string from `src/mcp/server.ts` into `src/mcp/instructions.ts` as `STATS_DESCRIPTION`, reference it from `server.ts`, and add `expect(STATS_DESCRIPTION.length).toBeLessThanOrEqual(2048);` to `test/mcp_instructions.spec.ts` if that assertion is not there yet. Append this sentence: "For Claude Code sessions it also reports hook blocks (which hook stopped which tool, with the latest reasons) and tool output size per tool (characters of text each tool's results added to the conversation; images are not counted); Codex sessions have neither yet."

Tests for Milestone 2, in `test/mcp_stats.spec.ts` (it seeds an in-memory database with `applySchema` and raw `INSERT`s; follow that pattern): seed `hook_block` and `tool_call.result_chars` rows in two projects and assert `projectStats` returns the grouped counts, the five-row cap on `recent`, the 150-character cut, a NULL reason, the rounding of `avg_chars`, the 15-tool cap (seed 17 tools and expect 15 listed and a `  (+2 more)` line; also expect `analyzeToolOutput` itself and `projectStats` to return all 17), and that rows with NULL `result_chars` are excluded. Add one case with a session of kind `exec` in the same project holding a block and a measured call, and assert both are absent in project scope and present when that session is asked for by `session_id`. Add one case asserting that `sections: ["tools"]` returns neither new field.

Milestone 3 proves it end to end on a fresh install; after that the user, not the agent, restarts every clens MCP server so the new build upgrades the developer's own index. It adds no code; see Concrete Steps.


## Concrete Steps

All commands run from the repository root, `/Users/me/IdeaProjects/clens` on the author's machine.

After Milestone 1:

    npm run typecheck
    npx vitest run test/schema.spec.ts test/claude_parser.spec.ts test/codex_parser.spec.ts test/driver.spec.ts test/digest.spec.ts test/writer_lang.spec.ts

Expect no type errors and every test passing. Two kinds of failure mean different things. The three `toEqual` expectations in `test/codex_parser.spec.ts` (lines ~62, ~88, ~168) fail until you add `result_chars: null` to them as Plan of Work says; that edit is required. Any anomaly-count assertion that fails in `test/driver.spec.ts` or `test/claude_parser.spec.ts` means the parser change added or removed an anomaly bump; undo that parser change and do not edit the expected count.

After Milestone 2:

    npm run typecheck
    npx vitest run test/mcp_stats.spec.ts test/mcp_instructions.spec.ts
    npm test

Expect all tests passing.

Milestone 3, fresh install end to end. Run the whole block below as one shell script, in a single command invocation, from the repository root: an agent's separate Bash calls do not keep environment variables, so splitting it loses `$T` and the `CLENS_*` variables. When copying from this document, remove the four-space indentation; the `EOF` line that closes the heredoc must start at the first column. The script builds, indexes the fixture into empty temporary directories, calls `clens_stats` through the real MCP server using the SDK client that is already a dependency (a `node --input-type=module` heredoc run from the repository root resolves `@modelcontextprotocol/sdk` through `node_modules`, so nothing is written into the repository), then checks Gate 2 by hand and deletes the temporary directory:

    set -e
    npm run build
    T=$(mktemp -d)
    mkdir -p "$T/claude/projects/-tmp-proj-H" "$T/codex" "$T/index"
    cp test/fixtures/hook-blocks-session.jsonl "$T/claude/projects/-tmp-proj-H/hooks-s1.jsonl"
    export CLENS_HOME="$T/claude" CLENS_CODEX_HOME="$T/codex" CLENS_INDEX_DIR="$T/index"
    node dist/cli.js index
    node --input-type=module <<'EOF'
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
    const transport = new StdioClientTransport({ command: "node", args: ["dist/mcp/server.js"], env: { ...process.env } });
    const client = new Client({ name: "check", version: "0" });
    await client.connect(transport);
    const r = await client.callTool({ name: "clens_stats", arguments: { project_id: "-tmp-proj-H", sections: ["hook_blocks", "tool_output"] } });
    console.log(r.content[0].text);
    await client.close();
    EOF
    node dist/cli.js stats --digest > "$T/inc.json"
    node dist/cli.js index --rebuild
    node dist/cli.js stats --digest > "$T/reb.json"
    diff "$T/inc.json" "$T/reb.json" && echo "gate 2 ok"
    grep -A1 '"table": "hook_block"' "$T/reb.json"
    rm -rf "$T"

The text printed by the heredoc must contain the two sections exactly as shown under Milestone 2 in Plan of Work. The project id is `-tmp-proj-H` because clens names a Claude Code project after the directory its transcript sits in. The script then prints `gate 2 ok` and the digest lines for `hook_block`. `clens stats --digest` pretty-prints its JSON (`src/commands/stats_cmd.ts` line ~53), so each table is a block of lines and the `grep -A1` prints:

    "table": "hook_block",
    "row_count": 2,

Restart the clens MCP servers. The user runs this step, not the agent: the agent asks the user to do it, records "waiting on the user" in Progress, and waits for their confirmation. The reason is that every clens MCP server running now, including the one serving the agent's own session, was started from the build before this change, and only the user can restart all of them. While an old server is left running, it and the new build keep rebuilding the whole index in turn (see Surprises & Discoveries). Nothing is deleted: the new build upgrades `~/.clens/index.db` in place and keeps the sessions whose transcripts are gone (see Decision Log). The steps for the user:

1. Back up the index. SQLite's `.backup` is safe while servers are running:

        mkdir -p ~/.clens-backup-v4 && sqlite3 ~/.clens/index.db ".backup '$HOME/.clens-backup-v4/index.db'" && ls -l ~/.clens-backup-v4

2. Restart every clens MCP server: in each open Claude Code session run `/mcp` and reconnect the clens server, or quit and restart the session; restart Codex sessions that use clens. New servers load the new build.
3. In a terminal, check that no server from before the build is left. Every process listed must have started after the time `ls -lT` prints for the build output; end any other one with `kill <pid>`:

        ls -lT dist/mcp/server.js
        ps -o pid=,lstart=,command= -p "$(pgrep -d, -f 'dist/mcp/server.js|dist/cli.js mcp')"

4. From the repository root, upgrade the index now instead of waiting for the next transcript change. It adds the column, re-reads every transcript on disk and exits with status 0; on the author's machine this took about 4 to 5 minutes, and while it runs, search results lack the sessions not yet re-read. Status 4 ("indexer busy") means a server's watcher is running the upgrade at that moment; run the command again when it is done, and it exits 0:

        node dist/cli.js index

Until step 4 has run, `clens_stats` prints `Hook blocks: not indexed yet …` and `Tool output: not indexed yet …` in place of those two sections, because the MCP server opens the index read-only and does not upgrade it (see Surprises & Discoveries); every other section works as before.


## Validation and Acceptance

The change is accepted when all of the following hold.

On a fresh install (the Milestone 3 steps, starting from empty directories), `clens_stats` for the fixture project prints `Hook blocks: 2` with the lines `PreToolUse Bash: 1` and `Stop: 1` and two recent entries, newest first; and `Tool output (characters of tool results, text only): 5 calls, 184 chars` with `Bash: 4 calls, total 179, avg 45, max 78` and `Read: 1 calls, total 5, avg 5, max 5`. `Grep` does not appear under tool output because its call has no result.

The two decoy results in the fixture (a non-error result that contains `PreToolUse:Bash hook error:` mid-text, and an error result that contains it mid-text) produce no block. This is the case that produced 5 false positives with grep.

`npm test` passes, including the new cases in `test/claude_parser.spec.ts`, `test/schema.spec.ts`, `test/digest.spec.ts` and `test/mcp_stats.spec.ts`. The new parser test fails before Milestone 1 (no `result_chars`, no `hook_blocks`) and passes after it. The existing anomaly-count assertions in `test/driver.spec.ts` pass unchanged.

The hand-run Gate 2 check prints `gate 2 ok`.

After the servers are restarted and the developer's own index is upgraded, `clens_stats` with `session_id: "current"` inside a Claude Code session shows a tool output section for that session, and without `project_id` shows hook blocks across all projects. Accept any total greater than 0: on the author's machine on 2026-09-28 the raw transcripts held 111 blocks in 40 sessions, and the indexed total differs from that because bundle 1 leaves `exec` and `pipeline` sessions out of the all-project scope, sessions whose transcripts are gone have no `hook_block` rows, and sessions since then add their own blocks.

The upgrade keeps every session: `sqlite3 ~/.clens/index.db "SELECT COUNT(*) FROM session"` prints a number no lower than `sqlite3 ~/.clens-backup-v4/index.db "SELECT COUNT(*) FROM session"`.


## Idempotence and Recovery

Every step can be repeated. The schema statements use `IF NOT EXISTS` and the column is added only when it is missing; indexing the same files again rewrites the same rows, because each file commit wipes and re-inserts its sessions inside one transaction. The temporary directory `$T` can be deleted and recreated at any time. No step deletes data: the upgrade adds a column and a table and re-derives rows from the transcripts still on disk, and sessions whose transcripts are gone keep their rows. The backup at `~/.clens-backup-v4/index.db` is for the case where the upgrade goes wrong. To go back, check out the previous commit and run `npm run build`, stop every clens MCP server, delete `~/.clens/index.db-wal` and `~/.clens/index.db-shm`, copy the backup over `~/.clens/index.db`, and start the servers again. Repeating the backup step overwrites the backup with the upgraded file, so check `~/.clens-backup-v4/` before repeating it.


## Artifacts and Notes

The fixture `test/fixtures/hook-blocks-session.jsonl`, one JSON object per line, 13 lines, ending with a newline:

    {"type":"user","uuid":"h-u1","parentUuid":null,"sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:00.000Z","cwd":"/tmp/proj-H","version":"2.1.0","gitBranch":"main","isSidechain":false,"message":{"role":"user","content":"check the repo"}}
    {"type":"assistant","uuid":"h-a1","parentUuid":"h-u1","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:01.000Z","isSidechain":false,"message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}
    {"type":"user","uuid":"h-u2","parentUuid":"h-a1","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:02.000Z","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"a\nb\nc","is_error":false}]}}
    {"type":"assistant","uuid":"h-a2","parentUuid":"h-u2","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:03.000Z","isSidechain":false,"message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"toolu_2","name":"Bash","input":{"command":"curl https://example.com"}}]}}
    {"type":"user","uuid":"h-u3","parentUuid":"h-a2","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:04.000Z","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"PreToolUse:Bash hook error: [policy] curl is blocked. Use the sandbox instead.","is_error":true}]}}
    {"type":"assistant","uuid":"h-a3","parentUuid":"h-u3","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:05.000Z","isSidechain":false,"message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"toolu_3","name":"Read","input":{"file_path":"/tmp/proj-H/a.png"}}]}}
    {"type":"user","uuid":"h-u4","parentUuid":"h-a3","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:06.000Z","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_3","content":[{"type":"text","text":"hello"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}]}}
    {"type":"assistant","uuid":"h-a4","parentUuid":"h-u4","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:07.000Z","isSidechain":false,"message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"toolu_4","name":"Bash","input":{"command":"grep hook log.txt"}}]}}
    {"type":"user","uuid":"h-u5","parentUuid":"h-a4","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:08.000Z","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_4","content":"grep output: PreToolUse:Bash hook error: seen in a log","is_error":false}]}}
    {"type":"assistant","uuid":"h-a5","parentUuid":"h-u5","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:09.000Z","isSidechain":false,"message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"toolu_5","name":"Bash","input":{"command":"false"}}]}}
    {"type":"user","uuid":"h-u6","parentUuid":"h-a5","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:10.000Z","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_5","content":"exit 1: PreToolUse:Bash hook error: quoted","is_error":true}]}}
    {"type":"assistant","uuid":"h-a6","parentUuid":"h-u6","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:11.000Z","isSidechain":false,"message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"toolu_6","name":"Grep","input":{"pattern":"x"}}]}}
    {"type":"attachment","uuid":"h-at1","parentUuid":"h-a6","sessionId":"hooks-s1","timestamp":"2026-09-01T10:00:12.000Z","isSidechain":false,"attachment":{"type":"hook_blocking_error","hookName":"Stop","toolUseID":"stop-hook-1","hookEvent":"Stop","blockingError":{"blockingError":"Unresolved items remain in the ledger.","command":"bash check.sh"}}}

Code-point lengths of the result texts, used by the expected numbers: `toolu_1` 5, `toolu_2` 78, `toolu_3` 5 (the text part only), `toolu_4` 54, `toolu_5` 42. Bash total 5 + 78 + 54 + 42 = 179, maximum 78, average 179 / 4 = 44.75, rounded to 45. All measured calls: 5, 184 characters.

Numbers measured on 2026-09-28 over the author's 1,370 Claude Code transcripts, for comparison after the upgrade: 18,425 tool results totalling 36,120,031 characters (counted with a script that took text parts, so the indexed totals will be close but not identical); Bash 17,903,455, Read 7,068,320, `mcp__plugin_context-mode_context-mode__ctx_execute` 4,322,045; 60 PreToolUse blocks and 51 Stop blocks in 40 sessions.

Later: Codex. A later plan for Codex needs to look at `src/indexer/codex_parser.ts`, where tool results are recorded at lines ~516, ~635 and ~676 (these now set `result_chars: null`); measure the text length of each Codex tool output item there the same way. For hook blocks, first measure whether Codex rollout files under `~/.codex/sessions/` record hook outcomes at all and in what shape, over the real files and by reading only, before writing any detection; this plan found no evidence either way.


## Interfaces and Dependencies

No new libraries. Use `better-sqlite3` (already used everywhere in the indexer and analyzer), Vitest for tests, and `@modelcontextprotocol/sdk` only in the throwaway end-to-end script.

At the end of Milestone 1, `src/indexer/types.ts` exports:

    export interface ToolCallRow { event_uuid: string; session_id: string; ts: string; call_id: string | null; name: string; input_json: string | null; duration_ms: number | null; is_error: 0 | 1; result_chars: number | null; }
    export interface HookBlockRow { event_uuid: string; session_id: string; ts: string; hook_event: string; tool: string | null; call_id: string | null; reason: string | null; }
    export type ToolResultInfo = { ts: string; is_error: 0 | 1; result_chars: number | null };
    // ParsedEvent gains: hook_blocks: HookBlockRow[];
    // FileParseResult.tool_results becomes Map<string, ToolResultInfo>;

`src/indexer/schema.ts` exports `SCHEMA_VERSION = 5`. `src/indexer/writer.ts`'s statements include `insertHookBlock` and `wipeHookBlocksForSession`, and `applyToolResults(stmts, results: Map<string, ToolResultInfo>)`.

At the end of Milestone 2:

    // src/analyzer/hook_blocks.ts
    export interface HookBlocksFacts {
      total: number;
      by_hook: Array<{ hook_event: string; tool: string | null; count: number }>;
      recent: Array<{ session_id: string; ts: string; hook_event: string; tool: string | null; reason_line: string | null }>;
    }
    export function analyzeHookBlocks(db: Database.Database, scope: Scope): HookBlocksFacts;

    // src/analyzer/tool_output.ts
    export interface ToolOutputFacts {
      measured_calls: number;
      total_chars: number;
      by_tool: Array<{ name: string; calls: number; total_chars: number; avg_chars: number; max_chars: number }>;
    }
    export function analyzeToolOutput(db: Database.Database, scope: Scope): ToolOutputFacts;

    // src/mcp/stats.ts
    export type StatsSection = "tools" | "skills" | "agents" | "health" | "timeline" | "files" | "hook_blocks" | "tool_output";
    export const STATS_TOOL_OUTPUT_TOP = 15; // formatStats lists this many tools, then "(+N more)"
    // StatsFacts gains: hook_blocks?: HookBlocksFacts; tool_output?: ToolOutputFacts;
    //   not_indexed?: StatsSection[]; // asked-for sections the index cannot answer yet


Revision note (2026-09-28): first version, written from the design agreed with the user in the brainstorming session that also produced the bundle 1 and bundle 3 plans.

Revision note (2026-09-28, after spec review): required the three Codex `toEqual` test edits and separated them from the anomaly-count rule; made the Gate 2 case concrete (lines 1 to 12 of the fixture, then append line 13, `hook_block` added to `tablesToCheck`, two rows asserted in both indexes); turned the index reset into a step the user runs with every clens MCP server stopped, moving the old file aside instead of deleting it, because an old-build server's watcher would rewrite the new file; moved the 15-tool cap into `src/mcp/stats.ts` with a "(+N more)" line; said how a recent block without a reason prints; made the attachment branch skip PreToolUse to avoid double counting; said in the tool description that both sections cover Claude Code only; put the end-to-end steps into one script with a module heredoc instead of a file in the repository root; fixed the digest sample to the pretty-printed JSON; widened the all-project acceptance to more than 0 and at most 111. Rejected: the claim that `test/digest.spec.ts` reads the real `~/.codex`; `codexHome()` returns a sentinel when only `CLENS_HOME` is set (recorded in Surprises & Discoveries).

Revision note (2026-09-28, before implementation): replaced the index reset with an in-place upgrade, a conditional `ALTER TABLE` in `applySchema()`, at the user's request, so that sessions whose transcripts are gone survive; the user step is now a restart of the clens MCP servers with a backup first, followed by one `node dist/cli.js index`. Added the upgrade test to Milestone 1, a session-count check to acceptance, and the observation that the MCP server opens the index read-only and never upgrades it itself.
