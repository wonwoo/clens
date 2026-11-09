# Per-Session Event Rows Design

## Context

When a Claude Code conversation is resumed into a new session, the new transcript starts with the earlier session's lines, copied with the same `uuid` under the new `sessionId` (`test/resumed_copies.spec.ts:14-16`). The index stores every child row of such a line (`user_text`, `tool_call`, `file_op`, …) once per session, but the `event` table has `uuid TEXT PRIMARY KEY` (`src/indexer/schema.ts:165-187`) and is written with `INSERT OR REPLACE` (`src/indexer/writer.ts:100-111`), so the event row of a copied line belongs to whichever of the two files was written last. Indexed run by run that is the newest file; a rebuild reads files in directory order. The two orders give different rows, which breaks Gate 2 (incremental == rebuild, `AGENTS.md`). Experiment E0a reproduces it: run by run, `a1`/`a2` belong to `aa-resumed`, after a rebuild to `zz-first`, and the `event` digest differs. The losing session has no event rows for those lines, so its turn numbers, token counts, timeline and model are computed without them.

The same shared key causes three more order-dependent results:

- The Claude append path counts models from the event rows the session still owns (`src/indexer/append.ts:272-284`); after a rebuild handed the copies to the other session, an append stores `model_primary` `m-b` where a rebuild stores `m-a` (E0b).
- `applyToolResults` fills `tool_call` rows by `call_id` alone, in any session (`writer.ts:153-160`, `325-332`). Copies share call ids, so one file's result fills another session's empty call row, and re-deriving that other session empties it again.
- `event_unknown_block` is keyed `(event_uuid, block_index)` (`schema.ts:194-200`) and wiped through the session's event uuids (`writer.ts:209-211`), so wiping one session deletes the other session's block for a shared uuid.

On this machine's index (E1): 2,473 uuids have child rows in more than one session, over 15 sessions; 1,228 call ids are in more than one session, 5 with different results; 12 unknown-block rows have a shared uuid.

Goal: every row of a session depends only on the files that write that session, so the index grown run by run equals a rebuild for resumed sessions.

Success criteria:

1. E0a prints `digests equal: true`, and E0b prints the same `model_primary` after the append and after a fresh rebuild.
2. Scopes over more than one session (project, global, since) still count a copied line once, for event rows as well as child rows; session scope keeps the whole session.
3. The migration of an existing index keeps every row and takes seconds, not minutes, on an index of this size (E3: 857,893 events).
4. `npm run typecheck` and `npm test` pass.

Decisions:

- The event table is keyed per session, `PRIMARY KEY (uuid, session_id)`, so a copied line has its own event row in each session (approach A, chosen by the user on 2026-11-09 over keeping one row per uuid with a deterministic owner, which would make one file's rows depend on another file).
- Among the sessions that hold a copied line, the one with the smallest `session_id` counts in multi-session scopes. This replaces "the session indexed last" (`src/analyzer/scope.ts:30-43`) and follows the existing rule for fork copies, where the smallest uuid counts (`scope.ts:45-59`). A session whose copy has no event row (a session kept from before this change whose transcript is gone) does not count over one that has it.
- Tool results fill only the call rows of the sessions the file writes.
- A parse change bumps `SCHEMA_VERSION` (`AGENTS.md`); the existing version-mismatch rebuild re-derives every session whose transcripts are on disk and keeps the others as they are (`src/indexer/driver.ts:455-497`).

Out of scope: lines that carry another session's id inside a main transcript (`writableEvents`, `driver.ts:330-377`; Known Limits); the foreign key clauses of the child tables; a guard against an older version writing a newer index; anything Codex-specific beyond the shared writer.

## Checked Behavior

Code read at commit `d2689c3`:

- K1. `event` DDL: `uuid TEXT PRIMARY KEY`, 20 columns in this order: `uuid, session_id, parent_uuid, prompt_id, agent_id, is_sidechain, ts, role, model, in_tok, out_tok, cache_r, cache_w, text_len, has_tool_use, has_text, has_tool_res, user_turn_no, assistant_turn_no, source_file`, then `FOREIGN KEY (session_id) REFERENCES session(id)`; indexes `event_user_turn_idx (session_id, user_turn_no)`, `event_session_idx (session_id, ts)`, `event_ts_idx (ts)`, `event_source_file_idx (source_file)` (`schema.ts:165-191`).
- K2. `event_unknown_block (event_uuid, block_index, raw_json)`, `PRIMARY KEY (event_uuid, block_index)` (`schema.ts:194-200`). Rows are made only by the Claude parser, inside `walkContent`, whose arguments include `session_id` (`src/indexer/claude_parser.ts:227-230`, pushes at `299` and `456`). Only the writer and `digest.ts` read the table (searched `src/`).
- K3. `applySchema` sets `foreign_keys = OFF`, then runs `SCHEMA_STATEMENTS` and the `ALTER TABLE` upgrades in one transaction (`schema.ts:382-418`). It runs only from the indexer: `openIndex()` (`driver.ts:120-125`), called by `runIndex()` under the index lock (`driver.ts:451`). The MCP server, hooks and the stats CLI open the index read-only and never run it (`src/mcp/server.ts:143`, `src/hooks/compact.ts:32`, `src/hooks/tool_failure.ts:49`, `src/commands/stats_cmd.ts:48`).
- K4. Every query that reads `event` (searched `FROM event`/`JOIN event` in `src/`): `notCopiedClause` (`scope.ts:38-43`); `eventWhere` callers `analyzeHealth` context rows (`src/analyzer/health.ts:72-78`) and `analyzeTimeline` (`src/analyzer/timeline.ts:23-30`); `analyzeIdentity` (`src/analyzer/identity.ts:89-104`, `121-127`); `segmentsOf` in `src/mcp/left_off.ts:395-399`, which joins `event` on `e.uuid = ut.event_uuid` only; `stats_cmd.ts:29` (row count); and the indexer's own queries in `driver.ts`, `writer.ts`, `append.ts`, `codex_append.ts`, all by `session_id`, `source_file` or a single `uuid` existence check.
- K5. `notCopiedClause` is used by `sessionScopedWhere` (`scope.ts:100-131`), `search.ts:387`, `recent.ts:80`, `checks.ts:202` and `line_origin.ts:142`; `eventWhere` (`scope.ts:71-96`) applies no copy rule today, since each uuid has one event row.
- K6. `applyToolResults(stmts, results)` is called from `commitFile` (`driver.ts:312`) and the Claude append path (`append.ts:224`). The Codex append path writes results with `setToolCallResult`, which already filters by `session_id` (`writer.ts:161-168`), and guards against call ids shared with other sessions (`codex_append.ts:188-226`).
- K7. `digestAllTables` orders child tables by `event_uuid` and other columns without `session_id` (`src/indexer/digest.ts:21-37`), so rows of a shared uuid tie and hash in arbitrary order; E0a's `user_text` digest differs only by that order.
- K8. Test `X7e` (`test/driver_codex_append.spec.ts:448-458`) asserts that another rollout's result fills a call row (`is_error` 1) and that appending then falls back with `shared_call_id`.
- K9. Tests that insert child rows open the database through `applySchema`, `openIndex` or `runIndex` (12 spec files, none sets `foreign_keys`).

Experiments (`docs/experiments/2026-11-09-per-session-events/`, table in `results.md`):

- E0a, E0b: the two reproductions above.
- E1: the counts above. No main session holds event rows written from another session's file.
- E2: of the 76 `copied_session_line_skipped` anomaly rows, one is a Claude Code file and that file is gone; the rest are Codex rollouts.
- E3: migrating a copy of the real index (857,893 events, 317 unknown blocks, none without its event), rows copied in key order with foreign keys off: 5.3 s, 6.9 s with SQLite's default cache. Row counts equal, PK `uuid, session_id`. `INSERT OR REPLACE` on the composite key keeps one row per (uuid, session). `SELECT MIN(session_id) FROM event WHERE uuid = ?` uses `sqlite_autoindex_event_1`. Two earlier attempts ran with foreign keys on and stalled (over 10 min; in `DROP TABLE event`).
- E4: cost of counting a copied event once, on the migrated copy. All-project timeline: 388 ms with no rule, 2,041 ms with a per-row `MIN` subquery, 524 ms with `rowid NOT IN (<copies>)`; largest project 64 / 477 / 248 ms; all-project health context rows 963 / 1,207 / 1,091 ms. Same row counts in every form.
- E5: better-sqlite3 turns `foreign_keys` on by default; once `event.uuid` is not unique alone, inserting into a table with `REFERENCES event(uuid)` fails with `foreign key mismatch` while foreign keys are on, and works with them off.

Not checked: the full rebuild time after the version bump on this machine (the same rebuild runs on every version bump); Windows.

## Design

### Data model

`event` (fresh databases and after migration):

```sql
CREATE TABLE IF NOT EXISTS event (
  uuid              TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  -- the other 18 columns exactly as today (K1)
  PRIMARY KEY (uuid, session_id),
  FOREIGN KEY (session_id) REFERENCES session(id)
)
```

with the same four indexes. Invariant: at most one event row per (uuid, session); a line copied into another session has an event row in each session that holds it.

`event_unknown_block`:

```sql
CREATE TABLE IF NOT EXISTS event_unknown_block (
  event_uuid  TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  raw_json    TEXT NOT NULL,
  session_id  TEXT,
  PRIMARY KEY (event_uuid, session_id, block_index),
  FOREIGN KEY (event_uuid) REFERENCES event(uuid)
)
```

`session_id` is last and nullable so that an older clens writing to a migrated index (its insert names the three old columns) does not fail; this version always fills it.

The child tables keep `FOREIGN KEY (event_uuid) REFERENCES event(uuid)`. That clause no longer names a unique key, which is harmless while foreign keys are off (E5); a comment above the event DDL says so.

`SCHEMA_VERSION` becomes 19, with a comment line: `// v19: event and event_unknown_block are keyed per session, so a line copied into a resumed session has its own rows there (docs/2026-11-09-per-session-events-design.md).`

### Migration (`src/indexer/schema.ts`)

New function, called by `applySchema` after the pragmas and before the existing `initTx`:

```ts
/** v19: re-key event and event_unknown_block per session in an index made
 *  before it. A no-op on a fresh or already migrated index. */
function migrateToSessionKeys(db: Database.Database): void
```

Steps, in this order:

1. Unknown blocks: when `event_unknown_block` exists without a `session_id` column: create `event_unknown_block_v19` with the new DDL, `INSERT INTO event_unknown_block_v19 (event_uuid, session_id, block_index, raw_json) SELECT k.event_uuid, e.session_id, k.block_index, k.raw_json FROM event_unknown_block k JOIN event e ON e.uuid = k.event_uuid`, `DROP TABLE event_unknown_block`, `ALTER TABLE event_unknown_block_v19 RENAME TO event_unknown_block`. The old event table has one row per uuid, so the join gives one session per block; a block whose event is missing is dropped (nothing reads it, K2).
2. When `event_unknown_block` has the `session_id` column (already migrated): `DELETE FROM event_unknown_block WHERE session_id IS NULL`. Only an older clens writes such rows (its insert leaves the column out); its writes also set the stored version back to 18, so the rebuild that follows re-derives those sessions and writes their blocks again with a session. Without this step they would stay forever, since this version wipes blocks by session.
3. Event: when `event` exists and its primary key columns (`PRAGMA table_info(event)`, `pk > 0`, ordered by `pk`) are exactly `["uuid"]`: create `event_v19` with the new event DDL, `INSERT INTO event_v19 (<the 20 columns>) SELECT <the 20 columns> FROM event ORDER BY uuid, session_id`, `DROP TABLE event`, `ALTER TABLE event_v19 RENAME TO event`. The four indexes are recreated by `SCHEMA_STATEMENTS`, which run next (`CREATE INDEX IF NOT EXISTS`).

- All steps run in one `db.transaction`. A failure rolls back to the old tables and the next run tries again. The event and unknown-block DDL text is defined once and used by both `SCHEMA_STATEMENTS` and the migration.
- Foreign keys are off when it runs (`applySchema` sets them first; E3′ shows why it matters).

Afterwards `runIndex` sees the stored version 18, rebuilds as today: rederivable sessions are wiped and re-derived (each copy now gets its own event row), kept sessions keep their rows, migrated as they were.

### Writer and parser

- `EventUnknownBlockRow` (`src/indexer/types.ts:110-114`) gains `session_id: string`; the two pushes in `claude_parser.ts` fill it from `walkContent`'s `session_id`.
- `insertEventUnknownBlock` inserts `session_id`. `wipeUnknownBlocksForSession` becomes `DELETE FROM event_unknown_block WHERE session_id = ?`.
- `insertEvent` is unchanged: `INSERT OR REPLACE` now replaces only within a session (E3).
- `updateToolCallResult` gains `AND session_id = @session_id`.
- `applyToolResults(stmts: WriterStatements, results: Map<string, ToolResultInfo>, sessionIds: readonly string[]): void` runs the update once per (result, session). `commitFile` passes `[...summary.affected_sessions]`; `appendNewLines` passes `[own]`.
- `codex_append.ts`: only comments change (lines 66-67 and 189-198) to say a re-derivation fills empty rows of the call id in the rollout's own session. Its guards stay; they are now stricter than needed, which costs only a fallback.

### Digest (`src/indexer/digest.ts`)

`TABLE_ORDER` adds `session_id` right after the uuid column:

| table | ORDER BY |
|---|---|
| event | `uuid, session_id` |
| event_unknown_block | `event_uuid, session_id, block_index` |
| tool_call | `event_uuid, session_id, call_id, name` |
| file_op | `event_uuid, session_id, tool, path` |
| user_text | `event_uuid, session_id, ts, text` |
| skill_call | `event_uuid, session_id, ts, skill` |
| agent_call | `event_uuid, session_id, ts, subagent_type` |
| slash_command | `event_uuid, session_id, ts, name` |
| system_reminder | `event_uuid, session_id, ts, category` |
| hook_block | `event_uuid, session_id, ts, hook_event, COALESCE(call_id, '')` |

The other tables keep their order.

### Readers (`src/analyzer/`, `src/mcp/`)

- `notCopiedClause(eventUuidColumn, sessionIdColumn)` keeps its signature and becomes `(IFNULL((SELECT MIN(owner.session_id) FROM event owner WHERE owner.uuid = <uuid>), <session>) = <session>)`. A child row counts when its session is the smallest that has an event row for the uuid, or when no session has one. Its doc comment states this rule in place of "the session indexed last".
- New `notCopiedEventClause(eventAlias: string): string` in `scope.ts`, for event rows: `(<alias>.rowid NOT IN (SELECT c.rowid FROM event c JOIN event o ON o.uuid = c.uuid AND o.session_id < c.session_id))`. An event row counts unless a smaller session has the same uuid, which is the same rule as above for a row that has its own event (E4: the cheapest form).
- `eventWhere` adds `AND <notCopiedEventClause(alias)>` in the global, project and since scopes; session scope is unchanged. This covers `analyzeHealth` and `analyzeTimeline`.
- `analyzeIdentity`'s primary-model query (`identity.ts:98-104`) adds `AND <notCopiedEventClause("e")>`. Its session-count and span queries are unchanged: copies do not change a distinct session count or a minimum or maximum time.
- `segmentsOf` (`left_off.ts:397`) joins `event e ON e.uuid = ut.event_uuid AND e.session_id = ut.session_id`.
- `stats_cmd.ts`'s event count is left as it is: it counts rows, now including copies.

### Documentation

`AGENTS.md`, Key invariants, Gate 2 bullet: add one sentence: "Event rows are keyed by `(uuid, session_id)`: a line copied into a resumed session has its own rows there, and scopes over several sessions count it in the smallest session id (`notCopiedClause`, `notCopiedEventClause`)."

## Assumptions To Check

- A1. `ALTER TABLE … RENAME TO event` on SQLite 3.49.2 (better-sqlite3's, E3) leaves the FTS triggers on `user_text` and every other table untouched, and no trigger or view references `event` (check `sqlite_master` after migration).
- A2. With the migration inside `applySchema`, a run on an existing v18 index takes the migration and then the version-mismatch rebuild in the same `runIndex` call, and a second `openIndex` is a no-op.
- A3. Every query that reads `event` is in K4 (re-run the search after implementing).
- A4. No test other than X7e asserts a tool result filling another session's call row, and the tests that assert which session a copied line counts in insert a single event row, so the smallest-session rule gives the same answer (`mcp_search.spec.ts:77-90`, `mcp_checks.spec.ts:198`, `mcp_line_origin.spec.ts:179-185`).

## Implementation Order

The steps start from commit `d2689c3`. A working tree where a step's files already exist (an earlier pass over this document) continues from the first step whose check does not pass; the "fail first" check of step 1 applies only when the tests are written new.

1. Gate 2 tests first, failing: new `test/resumed_gate2.spec.ts` with the cases in Acceptance R1–R6. Check: they fail on the current code (R1, R2, R3, R4 at least).
2. Schema and migration: new DDL, `migrateToSessionKeys`, `SCHEMA_VERSION = 19`. New `test/schema_migration.spec.ts` (Acceptance M1–M3). Check: `npx vitest run test/schema_migration.spec.ts test/schema.spec.ts`.
3. Parser, types and writer: `session_id` on unknown blocks, the session-filtered wipe, `applyToolResults` with sessions and its two callers, Codex append comments. Rewrite X7e as: another rollout's result for the same call id leaves this rollout's row empty (`duration_ms` null, `is_error` 0); appending a line to the first rollout is then `files_appended` 1 and the digest equals a rebuild (`expectDigestEqualsRebuild`). Check: `npx vitest run test/driver_codex_append.spec.ts test/driver_append.spec.ts test/driver_multifile.spec.ts`.
4. Digest order. Check: `npx vitest run test/digest.spec.ts`.
5. Readers: `notCopiedClause`, `notCopiedEventClause`, `eventWhere`, identity model query, `segmentsOf` join, comments. Check: `npx vitest run test/resumed_copies.spec.ts test/fork_copies.spec.ts test/mcp_search.spec.ts test/mcp_checks.spec.ts test/mcp_line_origin.spec.ts test/mcp_stats.spec.ts test/mcp_left_off.spec.ts`.
6. `AGENTS.md` sentence. Then `npm run typecheck`, `npm test`, and `npm run build` so `plugin/` matches the source (CI checks it). Check: R1–R6 and M1–M3 pass; the scenarios below print what they say.

## Acceptance

Tests in `test/resumed_gate2.spec.ts`, each in a temporary `CLENS_HOME`/`CLENS_CODEX_HOME`/`CLENS_INDEX_DIR`, project `-repo`, files `zz-first.jsonl` (session `zz-first`) and `aa-resumed.jsonl` (session `aa-resumed`, starting with copies of `zz-first`'s lines under its own session id). "Equals a rebuild" means `digestAllTables` of the index grown run by run equals that of `runIndex({ rebuild: true })` into a fresh index dir over the same files, for every table.

- R1. Index `zz-first`, then in a later run `aa-resumed` (mtimes in that order): equals a rebuild; `SELECT uuid, session_id FROM event WHERE uuid = 'a1'` gives both sessions.
- R2. E0b's case: rebuild with `aa-resumed` holding three copied `m-a` replies and one own `m-b`, append one more `m-b` reply: `files_appended` 1, `model_primary` of `aa-resumed` is `m-a`, equals a rebuild.
- R3. `zz-first` has a `Bash` call `toolu_9` with no result; `aa-resumed` copies it and has its `tool_result`. In both indexing orders: `zz-first`'s row has `duration_ms` null, `aa-resumed`'s is set; equals a rebuild.
- R4. A copied line with an unknown block type: `SELECT session_id FROM event_unknown_block ORDER BY session_id` gives `aa-resumed`, `zz-first`; re-deriving `aa-resumed` (touch its file, run) leaves `zz-first`'s row; equals a rebuild.
- R5. Event scopes count a copy once: with R1's files, `SELECT COUNT(*) FROM event e WHERE <eventWhere(project)>` is 3 (`a1`, `a2`, `b1`, all in `aa-resumed`, the smaller session id), with `eventWhere(session aa-resumed)` 3 and `session zz-first` 2; with `a2` an assistant line of model `claude-x` and no other assistant line, `analyzeIdentity` in project scope gives `primary_model` `claude-x`.
- R6. `sessionRecord(db, "aa-resumed")`: the segment requests sum to 2 (`a1`, `b1`), no message twice.

Tests in `test/schema_migration.spec.ts`:

- M1. A database created with the v18 DDL of `event` and `event_unknown_block` (written literally in the test), with rows for two sessions sharing a uuid in their child tables, the event row in one of them, one unknown block, and `schema_version` 18: after `applySchema`, the event PK columns are `uuid, session_id`, every event row is there unchanged, the block has its event's `session_id`, and the four event indexes exist.
- M2. `applySchema` a second time changes nothing (same `sqlite_master` and row counts). An `event_unknown_block` row inserted with `session_id` NULL after the migration (as an older clens writes it) is gone after the next `applySchema`.
- M3. `runIndex` on M1's database, with the transcript of one session on disk and the other's gone: the gone session's rows are kept as they were; `schema_version` is 19.

Scenarios (from the repository root; `2>/dev/null` hides npm's notices):

1. `npx tsx docs/experiments/2026-11-09-per-session-events/e0-resumed.ts 2>/dev/null` prints exactly:
   ```
   readdir order: [ 'aa-resumed.jsonl', 'zz-first.jsonl' ]
   incremental owners: [{"uuid":"a1","session_id":"aa-resumed","user_turn_no":1},{"uuid":"a1","session_id":"zz-first","user_turn_no":1},{"uuid":"a2","session_id":"aa-resumed","user_turn_no":null},{"uuid":"a2","session_id":"zz-first","user_turn_no":null},{"uuid":"b1","session_id":"aa-resumed","user_turn_no":2}]
   rebuild owners:     [{"uuid":"a1","session_id":"aa-resumed","user_turn_no":1},{"uuid":"a1","session_id":"zz-first","user_turn_no":1},{"uuid":"a2","session_id":"aa-resumed","user_turn_no":null},{"uuid":"a2","session_id":"zz-first","user_turn_no":null},{"uuid":"b1","session_id":"aa-resumed","user_turn_no":2}]
   digests equal: true
   ```
   Before this change it prints two `DIGEST DIFFERS` lines and `digests equal: false` (`e0-resumed.txt`).
2. `npx tsx docs/experiments/2026-11-09-per-session-events/e0-model.ts 2>/dev/null` prints exactly:
   ```
   files_appended: 1
   after append : [{"id":"aa-resumed","model_primary":"m-a"},{"id":"zz-first","model_primary":"m-a"}]
   fresh rebuild: [{"id":"aa-resumed","model_primary":"m-a"},{"id":"zz-first","model_primary":"m-a"}]
   ```
3. `npm test` passes.

## Known Limits

- Lines that carry another session's id inside a main transcript are still written only while that session has no rows (`writableEvents`, `driver.ts:330-377`), so whether the file gets a `copied_session_line_skipped` anomaly depends on which file was indexed first. No Claude Code transcript on this machine has such lines (E2); older transcripts elsewhere may.
- Child tables keep `REFERENCES event(uuid)`, which no longer names a unique key: a connection with foreign keys on gets `foreign key mismatch` when it writes a child row (E5). clens turns them off in `applySchema`; turning them on needs those clauses rewritten, which means recreating the child tables (out of scope).
- Which copy a multi-session scope shows changes from the session indexed last to the smallest session id: a search hit or `clens_recent` row for a copied message may name the other session than before.
- A call row whose result is in another session's file stays without a result (for example a fork subagent's copy of its parent's `Agent` call, when the fork's file has no result for it). Before, it took the other file's result when that file was indexed after it.
- An older clens (0.2.9 or earlier) still running as watcher on a v19 index sees a version mismatch and rebuilds with its own rules, writing version 18; the next run of this version rebuilds again. The same happens on every version bump; restarting open sessions after the update avoids it.
- Event scopes over several sessions cost more: the all-project timeline query took 524 ms against 388 ms (E4).
- `clens stats` (CLI) counts event rows, copies included.

## Open Questions

None.

## Goals Check

1. E0a and E0b reproduce the two failures; with per-session event rows, session-filtered results and session-ordered digests, scenarios 1 and 2 expect the equal outputs, and R1–R4 assert them in tests. Met.
2. Child rows keep the existing rule with `MIN`; event rows get `notCopiedEventClause` in `eventWhere` and the identity model query; session scope is untouched (R5, R6, and the existing `resumed_copies.spec.ts`). Met.
3. E3 migrates a copy of this index in 5.3–6.9 s with every row kept; M1–M3 check the migration code itself. Met.
4. Step 6 runs both. Met.

```skerry
{"run": "20261109-050140-71c7", "verify": ["npm run typecheck", "npm test"], "extras": []}
```
## Changes After Approval

- Acceptance R4 says to re-derive `aa-resumed` by touching its file and running. A touched file that did not shrink goes the append path with no new lines and is not re-derived (`readAppended`, `appendNewLines`). The test now writes `aa-resumed` with one more own line (`b2`) and re-derives it by writing it again without `b2` (the file shrank, so it goes the full way), and asserts `files_parsed` 1 and `files_appended` 0 for that run. Why: only this makes the run a real re-derivation of `aa-resumed`.
- Acceptance R2 says "append one more `m-b` reply"; the test appends a user line `b3` and the `m-b` reply `b4`, as E0b (`e0-model.ts`) does. Why: the same case as the reproduction it stands for.
- Acceptance R5 checks the count of 3 in project scope; the test also checks it in global and since scope, and checks that the three project-scope rows are `a1`, `a2`, `b1` all in `aa-resumed`. Why: success criterion 2 names those scopes, and a count alone does not show which session's copy counts (with the comparison in `notCopiedEventClause` reversed the count stays 3; the row check fails).
- Added test "R5: counts a copied reply once in the project's primary model": copied `claude-x` replies and more own `claude-y` replies, so `analyzeIdentity` gives `claude-y` only when the copies count once. Why: R5's identity check gives `claude-x` with or without the copy rule.
- Added test "is found once by search, in the smaller session id": `searchUserText` for a copied message returns one hit, in `aa-resumed`. Why: no test pinned which session `notCopiedClause` keeps (with `MAX` in place of `MIN` it fails).
- Acceptance M1 also checks that the `tool_call` rows are unchanged and that the stored version is still 18 after `applySchema` (the rebuild in `runIndex` moves it); M3 also checks that the session on disk was re-derived from its transcript. Why: they pin that the migration keeps the child rows and leaves the version to the rebuild.
- Design, Data model: the `SCHEMA_VERSION` comment is one line in the document; in `schema.ts` the same text is wrapped over three lines. Why: the other version comments there wrap at about 78 columns.
