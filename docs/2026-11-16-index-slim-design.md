# Index Slimming Design

## Context

The index on the author's machine is 1.47 GB (`~/.clens/index.db`, 2026-11-16) and grows by about 250 MB a month (`docs/BACKLOG.md`, "The index grows without bound"). Two kinds of rows hold nothing any reader uses:

1. **`event.source_file`.** Every event row stores the absolute path of the transcript that wrote it, about 120 bytes, and `event_source_file_idx` indexes it (`src/indexer/schema.ts:161`, `:241`). Only the indexer reads it, and only to ask which sessions a file wrote and which files wrote a session (K3). On the real index the 953,799 event rows hold 6,878 distinct (session, file) pairs (E1).
2. **Bare attachment rows.** A Claude Code `attachment` line (hook output, environment notes, reminders) gets an event row whose only content is its uuid and time. 411,704 of 953,799 events have role `attachment`; 1,496 of them own a child row (a Stop hook refusal or a message the user queued mid-turn, `src/indexer/claude_parser.ts:674-704`), the rest own none and carry no tokens, text flags or turn number (E1).

Separately, `clens_stats` reads the list of copied event rows (`notCopiedEventClause`, `src/analyzer/scope.ts:71-76`) once per statement that applies it: three times in one project-scope call, 186 ms each on the real index (E4, E6).

Goal: the index stops storing both kinds of rows, existing indexes lose them on upgrade, and `clens_stats` reads the copied rows at most once per call, while search results, conversation text, session spans and every tool's output stay as they are except where Known Limits says.

Success criteria:

1. On a copy of the real index, the upgraded file after its post-rebuild VACUUM is at least 25% smaller than the copy after a plain VACUUM (E3b measured 29%).
2. A fresh index of a transcript with bare attachment lines has no event row with role `attachment` that owns no child row, keeps every attachment row that owns one, and gives each session the same `started_at`/`ended_at` as before.
3. Gate 2 (incremental == rebuild digest, `AGENTS.md`) and gate 1 (line accounting, `test/driver.spec.ts:63-81`) hold.
4. `projectStats` runs the copied-rows query at most once per call, and none in session scope.
5. `npm run typecheck` and `npm test` pass.

Decisions:

- Both changes ship together under one `SCHEMA_VERSION` bump (the user, 2026-11-16: "같이 할껀데"; "버전 올리는건 상관없고").
- Bare attachment lines are dropped at write time only. Their content (hook name, duration, exit code, output) was never stored and is not stored now; storing it later needs its own parse change and reads the transcripts again (conversation 2026-11-16). Ledger item `bf2259da` (held 2026-11-05) is this change.
- The project and all-project spans of `clens_stats` keep today's values by reading `session.started_at/ended_at`, which come from every parsed line including attachments (offered on 2026-11-05 and taken in the 2026-11-16 plan the user approved).
- The `source_file` column stays in the `event` table, always NULL, and only its index goes. An older clens then still opens the index and `clens index --rebuild` stays the way back after a downgrade (`src/indexer/driver.ts:462-470`); dropping the column makes an older clens fail in `applySchema` (E5 (3)). The same pattern keeps `file_cursor.live` (`schema.ts:199-200`).
- Skipped bare attachment lines are counted in the anomaly table as `attachment_line_skipped`, as `writableEvents` counts the lines it skips "so line accounting still adds up" (`driver.ts:347-348`).

Out of scope: storing attachment content; `system` lines (BACKLOG mentions them); the Korean FTS `_content` table (search reads it, `src/mcp/search.ts:564`); any other `clens_stats` cost.

## Checked Behavior

Code read at commit `a4d0f70`.

- K1. `event` DDL is built by `eventTableStatement` with `source_file TEXT` last before the key (`schema.ts:141-165`); `EVENT_COLUMNS` lists the 20 columns (`schema.ts:168-171`); `SCHEMA_STATEMENTS` creates `event_source_file_idx ON event(source_file)` (`schema.ts:241`). `SCHEMA_VERSION` is 22 (`schema.ts:108`).
- K2. `applySchema` sets `foreign_keys = OFF`, runs `migrateToSessionKeys` (v19, its own transaction, `schema.ts:466-508`), then `SCHEMA_STATEMENTS` and the `ALTER TABLE` upgrades in one transaction (`schema.ts:426-464`). It runs only from the indexer (`openIndex`, `driver.ts:121-126`); the MCP server, hooks and the stats CLI open the index read-only.
- K3. Every read of `event.source_file` (searched `src/` and `test/`): `appendNewLines` guard 5 `SELECT DISTINCT session_id FROM event WHERE source_file = ?` (`src/indexer/append.ts:148-151`) and guard 7 `… WHERE session_id = ? AND source_file IS NOT ?` (`append.ts:185`); `appendCodexLines` `… WHERE source_file = ? AND session_id IS NOT ?` and `… WHERE session_id = ? AND source_file IS NOT ?` (`src/indexer/codex_append.ts:170`, `:174`); `sessionsOnlyInFile` (`src/indexer/writer.ts:195-199`); the rebuild's `SELECT DISTINCT session_id, source_file FROM event` (`driver.ts:479-490`, a NULL path counts as gone). Tests: `test/driver.spec.ts:70`, `:171`, `test/driver_append.spec.ts:314`, `test/driver_codex_append.spec.ts:399`, `test/schema_migration.spec.ts` (v18 fixture and M1's index list, `:155-160`). No file under `src/mcp/`, `src/analyzer/`, `src/hooks/` or `src/commands/` reads it.
- K4. `insertEvent` binds `@source_file` (`writer.ts:100-111`). `EventRow.source_file: string` (`src/indexer/types.ts:29`) is set by `parseEventLine` (`claude_parser.ts:640`) and Codex's `makeBlankEvent(uuid, session_id, ts, source_file)` (`src/indexer/codex_parser.ts:548-571`), which `pushTurnTokens`, `pushUserMessage`, `pushExecMcpCall`, `pushHookPrompt`, `pushAgentMessage` and the line handlers call with the path. better-sqlite3 accepts an object with keys the statement does not name (run 2026-11-16).
- K5. `commitFile` (`driver.ts:210-330`): `summarizeFile` over the writable events sets the session span from every one of them (`:177-201`, `:239`, `:271-272`); then upsert sessions, `knownTokens`, `wipeSessions(affected)`, drop the sessions `sessionsOnlyInFile` returns that the file no longer yields (`:285-295`), write each session's events after `assignTurnNumbers` (`:301-310`), tool results, `flushAnomalyBatch`, cursor; returns `summary.events.length` as events inserted (`:329`).
- K6. `writableEvents` writes a copied line of another session only while that session has no event row, checked with `SELECT 1 FROM event WHERE session_id = ? LIMIT 1` (`driver.ts:349-379`).
- K7. `finishAppend` (`append.ts:236-344`) numbers the new events, then in one transaction adds the stored turn offsets and writes each with `writeParsedEvent` (`:286-292`), runs `writeExtra`, sets the session span from every new event (`:295-306`), merges the batch's anomaly counters into the file's stored rows (`:308-332`), and returns `events.length` (`:343`). Codex's append path ends in the same function.
- K8. The parser makes an attachment's child rows only for a `hook_blocking_error` whose `hookEvent` is not `PreToolUse` (a `hook_blocks` row) and a `queued_command` whose `origin.kind` is `human` with non-empty text (a `user_texts` row) (`claude_parser.ts:674-704`); its event's `role` is the line's `type`, `"attachment"` (`claude_parser.ts:605`). Turn numbers count only user and assistant rows (`assignTurnNumbers`). The Codex parser never sets role `attachment` (searched).
- K9. Readers of `event` rows a bare attachment could change (searched `FROM event`/`JOIN event` in `src/`): `analyzeIdentity` project and global spans (`src/analyzer/identity.ts:82-139`); `analyzeTimeline` event gaps (`src/analyzer/timeline.ts:27-36`); `analyzeHealth` reads assistant rows only (`src/analyzer/health.ts:85-95`); `notCopiedClause` reads the event of a child row (`scope.ts:59-64`), which is never bare; `segmentsOf` joins the event of a `user_text` row (`src/mcp/left_off.ts:404`), never bare; append guards 11-14 read by uuid or numbered/assistant rows (`append.ts:205-284`, `codex_append.ts:189`); `stats_cmd.ts:29` counts rows.
- K10. `digestAllTables` hashes only the tables in `TABLE_ORDER` (`src/indexer/digest.ts:21-38`).
- K11. After a rebuild that parsed a file, `optimizeFtsIfDue` runs `vacuumIfLoose`, which VACUUMs when free pages reach 100 MB (`driver.ts:392-435`, `:598-600`).
- K12. `projectStats` (`src/mcp/stats.ts:116-195`) is the only caller of `analyzeIdentity`, `analyzeHealth` and `analyzeTimeline` in `src/` (called from `src/mcp/server.ts:575`). `eventWhere` adds `notCopiedEventClause` in global, project and since scope (`scope.ts:107-136`); `analyzeIdentity`'s project model query adds it (`identity.ts:98-106`). Tests call these analyzers directly with `(db, scope)` (`analyzer_b2`, `analyzer_b3`, `compaction`, `health_codex_ctx`, `resumed_gate2` specs).
- K13. `runIndex` refuses an index whose stored version is above its own unless `rebuild` is set (`driver.ts:462-470`).

Experiments, `docs/experiments/2026-11-16-index-slim/` (table in `results.md`):

- E1: the counts above. No file has more than one session and no session more than one file; no session holds only bare attachments; 1 session has no event row; `session.started_at/ended_at` equal the span of the session's events for every session whose transcript is on disk (8 kept sessions differ).
- E2: only 3,701 of 6,878 sessions have their transcript on disk, so a rebuild alone removes 184,444 bare rows and leaves 225,775 in kept sessions. A `DELETE` with a correlated `EXISTS` per child table took 56.6 s.
- E3, E3b: the one-time migration on a copy, bare rows of every session deleted through a keyed temp table: 5.1 s with the column dropped, 4.6 s with it set to NULL; after VACUUM 985.8 MB and 982.5 MB from 1,375 MB. A row-value `NOT IN (<UNION>)` form ran over 10 minutes.
- E4: on the live index the three event queries of a project-scope call take 1,046 ms with the copy subquery in each and 681 ms with the copied rowids read once (186 ms) and passed as a literal list, same rows; on the migrated copy 623 and 430 ms. Spans from `session` equal spans from events on the live index; on the migrated copy the event span starts 3 s later and the `session` one does not move. The all-project session count is 1,478 from events and 1,479 from `session`.
- E5: a read-only better-sqlite3 connection runs `db.transaction()` and keeps one snapshot while another connection commits; `DROP COLUMN` needs the index gone first; an older clens's `CREATE INDEX … ON event(source_file)` fails once the column is dropped.
- E6: `projectStats` today: project 1,349 ms with 3 copied-row reads, all projects 2,955 ms with 2; on E3's data with today's code 961 and 2,172 ms.

Not checked: an older clens actually running `--rebuild` on a migrated index (read from `driver.ts:474-490` of this version: a NULL `source_file` makes every session kept and every file on disk is re-read); Windows; indexes much larger than 1.5 GB (the migration is linear in rows, E3b: 4.6 s for 954k).

## Design

### Data model (`src/indexer/schema.ts`)

New table and index, in `SCHEMA_STATEMENTS` after the event indexes, their text defined once as `SESSION_FILE_STATEMENTS` and used by the migration too:

```sql
CREATE TABLE IF NOT EXISTS session_file (
  session_id  TEXT NOT NULL,
  source_file TEXT NOT NULL,
  PRIMARY KEY (session_id, source_file)
);
CREATE INDEX IF NOT EXISTS session_file_source_idx ON session_file(source_file);
```

Invariant: `(s, f)` is in `session_file` exactly when the last commit of file `f` wrote session `s` (its session row), or the migration below copied it from an event row of `s` with path `f`, and `s` has not been wiped since. This is the set the event rows held before, plus a session whose lines from `f` were all bare attachments, which now has a session row and no event row.

`event` keeps all 20 columns; `source_file` is always NULL in rows this version writes. A comment above `eventTableStatement` says why: an older clens opens the index and can rebuild it. `event_source_file_idx` leaves `SCHEMA_STATEMENTS`.

`SCHEMA_VERSION` becomes 23, with the comment: `// v23: event rows no longer store their transcript's path (session_file holds the (session, file) pairs) and a Claude Code attachment line that yields no other row gets no event row; an index made before is migrated in place (docs/2026-11-16-index-slim-design.md).`

### Migration (`schema.ts`)

`applySchema` calls the new `migrateIndex(db)` where it calls `migrateToSessionKeys(db)` today, then the existing `initTx`.

```ts
/** Every in-place migration of an index made by an older clens, in one
 *  transaction: v19 (migrateToSessionKeys), then v23: event.source_file
 *  moves into session_file and the bare attachment rows go. */
function migrateIndex(db: Database.Database): void
```

- In one `db.transaction`, in this order:
  1. `const v23 = <SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'event_source_file_idx' returns a row>`. Every index made before v23 has it, and an older clens re-creates it whenever it opens the index (E3b); this version never creates it. It is read before step 2 because `migrateToSessionKeys` drops a v18 event table together with its indexes. One lookup per `applySchema`, which runs on every indexer run.
  2. `migrateToSessionKeys(db)`, unchanged. Its own `db.transaction` runs nested, as a savepoint that rolls back with the outer transaction (E5 (4)).
  3. When `v23` is false, stop here. Otherwise run steps 4-8.
  4. Run `SESSION_FILE_STATEMENTS`.
  5. `INSERT OR IGNORE INTO session_file (session_id, source_file) SELECT DISTINCT session_id, source_file FROM event WHERE source_file IS NOT NULL`.
  6. `DROP INDEX IF EXISTS event_source_file_idx` (on a v18 index step 2 already dropped it).
  7. `UPDATE event SET source_file = NULL WHERE source_file IS NOT NULL`.
  8. Delete the bare attachment rows of every session, on disk or kept: create `temp.owned (event_uuid TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (event_uuid, session_id)) WITHOUT ROWID`, fill it with `INSERT OR IGNORE … SELECT event_uuid, session_id FROM <t>` joined by `UNION ALL` over those of `tool_call, file_op, user_text, skill_call, agent_call, slash_command, system_reminder, hook_block, event_unknown_block` that exist (`SELECT name FROM sqlite_master WHERE type = 'table'`; the migration runs before `SCHEMA_STATEMENTS`, so an index made by an older version, such as `createV18` in `test/schema_migration.spec.ts`, which has only `event`, `event_unknown_block` and `tool_call`, can lack some, and a missing table owns no row), run `DELETE FROM event WHERE role = 'attachment' AND NOT EXISTS (SELECT 1 FROM temp.owned o WHERE o.event_uuid = event.uuid AND o.session_id = event.session_id)`, drop `temp.owned`. (E3b; the other forms in E2/E3 took 56 s and over 10 minutes.) Step 2 has run, so `event_unknown_block` has `session_id` in every index this meets.
- A failure anywhere rolls back every step, v19's included, and the next run tries again from step 1. The stored version is left to the rebuild, which `runIndex` starts on the mismatch (22 ≠ 23, or 18 ≠ 23).
- Cases: a fresh database has no `event_source_file_idx`, so only step 2 runs and finds nothing. A v19-v22 index runs every step. A v18 index: step 1 sees the index, step 2 re-keys the tables (`EVENT_COLUMNS` still names `source_file`, so the paths are copied), steps 4-8 run on the re-keyed tables. An index an older clens wrote into after v23 (a downgrade, then an upgrade): its rows with a path add their pairs to the ones `session_file` already holds; the rebuild that follows wipes every re-derivable session's pairs and writes them again, and a pair left for a session that no longer exists names a file whose session is re-derived or kept like any other.

Space comes back at the VACUUM that follows the rebuild (K11): the migration frees about 390 MB on this index (E3b), well over the 100 MB threshold.

### Writer (`src/indexer/writer.ts`)

- `insertEvent` no longer names `source_file` (the column takes its default NULL).
- New statements: `insertSessionFile`: `INSERT OR IGNORE INTO session_file (session_id, source_file) VALUES (?, ?)`; `wipeSessionFilesForSession`: `DELETE FROM session_file WHERE session_id = ?`.
- `sessionsOnlyInFile` becomes `SELECT sf.session_id FROM session_file sf WHERE sf.source_file = ? AND NOT EXISTS (SELECT 1 FROM session_file o WHERE o.session_id = sf.session_id AND o.source_file <> sf.source_file)`.
- `wipeSessions` also runs `wipeSessionFilesForSession` for each session, after the event wipe.
- New:

```ts
/** A Claude Code attachment line that yields no row besides its event: the
 *  index stores nothing of it (docs/2026-11-16-index-slim-design.md). */
export function isBareAttachment(p: ParsedEvent): boolean
/** Write the events that hold a row; count each bare attachment skipped as
 *  "attachment_line_skipped" in `batch`. Returns the number written. */
export function writeEvents(stmts: WriterStatements, events: readonly ParsedEvent[], batch: AnomalyBatch, known?: KnownTokens): number
```

  `isBareAttachment` is true when `p.event.role === "attachment"` and `tool_calls`, `file_ops`, `user_texts`, `skill_calls`, `agent_calls`, `slash_commands`, `system_reminders`, `hook_blocks` and `unknown_blocks` are all empty. `writeEvents` calls `writeParsedEvent` for the others and adds 1 to the `attachment_line_skipped` counter (count, detail null) for each skipped one. `writeParsedEvent` is unchanged and still writes whatever it is given.

### Types and parsers

- `EventRow` loses `source_file` (`types.ts:29`); nothing reads it once `insertEvent` stops binding it.
- `parseEventLine` stops setting it (`claude_parser.ts:640`); its `source_file` parameter stays (anomaly details use it).
- `makeBlankEvent` loses its `source_file` parameter; each Codex function that passed the path only to `makeBlankEvent` loses that parameter too, and its callers stop passing it. A function that also uses the path for something else (`syntheticUuid`) keeps it.

### Driver (`src/indexer/driver.ts`)

- `commitFile`: after the dropped-session wipe (`:295`), run `insertSessionFile(sid, source_file)` for every session in `summary.affected_sessions`. In step 4, replace `for (const p of list) writeParsedEvent(stmts, p, known)` with `inserted += writeEvents(stmts, list, batch, known)`, before `flushAnomalyBatch` (step 6) as today; return `{ eventsInserted: inserted }`. `summarizeFile` still runs over every writable event, so the span and the affected set include bare attachments.
- `writableEvents`: `hasRows` becomes `SELECT 1 FROM session_file WHERE session_id = ? LIMIT 1`. A session whose rows came only from bare attachments then still counts as indexed, as it did when those rows existed; otherwise a resumed file's copies of it would be written or skipped depending on which file was indexed first.
- Rebuild (`:479-490`): the session-to-files map is read from `SELECT session_id, source_file FROM session_file`. A session with no pair is not in the map and is kept, as a session whose rows had a NULL path was.

### Append paths

- `appendNewLines`: guard 5 reads `SELECT session_id FROM session_file WHERE source_file = ?`; guard 7 reads `SELECT 1 FROM session_file WHERE session_id = ? AND source_file <> ? LIMIT 1`. The fallback reasons and their order stay.
- `appendCodexLines`: `several_sessions` reads `SELECT 1 FROM session_file WHERE source_file = ? AND session_id <> ? LIMIT 1`; `several_files` as guard 7 above.
- `finishAppend`: first add the stored turn offsets to every new event, then `const written = writeEvents(stmts, events, batch)` in place of the write loop, still before `writeExtra` and the anomaly merge, which then merges `attachment_line_skipped` like any other counter. The span loop keeps reading every new event. Returns `{ kind: "appended", events: written, … }`.
- No append path inserts a pair: guard 5 only lets through a file whose one pair is its own session, which its first full commit wrote.

`IndexResult.events_inserted` therefore counts rows written, in both paths; the `clens index` line prints that number.

### Digest (`src/indexer/digest.ts`)

`TABLE_ORDER` gains `["session_file", "session_id, source_file"]` after `session`.

### Readers (`src/analyzer/`, `src/mcp/stats.ts`)

- `scope.ts`:

```ts
/** Rowids of the event rows copied from a smaller session id (the rows
 *  notCopiedEventClause leaves out); none in session scope, which keeps a
 *  session whole. Read once per clens_stats call. */
export function copiedEventRowids(db: Database.Database, scope: Scope): number[]
export function notCopiedEventClause(eventAlias: string, copied: readonly number[]): string
export function eventWhere(scope: Scope, eventAlias: string, copied: readonly number[]): { sql: string; binds: unknown[] }
```

  `copiedEventRowids` returns `[]` for session scope, else the rowids from `SELECT c.rowid AS rowid FROM event c JOIN event o ON o.uuid = c.uuid AND o.session_id < c.session_id`. `notCopiedEventClause` returns `(1)` for an empty list, else `(<alias>.rowid NOT IN (<rowids joined by ",">))`; the rowids are integers SQLite returned, so the text holds no outside input. `eventWhere` uses it in the scopes it uses it today. The rule (a copy counts in the smallest session id) and its doc comment stay.
- `analyzeHealth(db, scope, copied = copiedEventRowids(db, scope))`, `analyzeTimeline(db, scope, copied = …)` and `analyzeIdentity(db, scope, copied = …)` take the list as an optional third argument, so the tests that call them with two keep working; `analyzeIdentity` uses it only in its project model query. Each computes the default only when called without it.
- `analyzeIdentity` spans, project scope without `since`: `SELECT COUNT(DISTINCT <rootSessionExpr("s")>) AS sessions, MIN(s.started_at) AS started_at, MAX(s.ended_at) AS ended_at FROM session s WHERE s.project_id = ? AND <workKindClause("s")>`. Global scope: the same from all work sessions (`WHERE <workKindClause("s")>`). With `since` (project or `since` mode) both queries stay as today, on event rows. The model query stays on event rows.
- `projectStats`: its body runs in one `db.transaction(() => …)()`, so every query of the call reads one snapshot and the rowids stay valid (E5 (1)). It computes `copied` once, only when the scope is not session scope and the call runs a query that applies the rule (project scope, or the `health` or `timeline` section), else `[]`, and passes it to the three analyzers.

### Documentation

- `AGENTS.md`, Key invariants, a new bullet after Gate 2: "**Event rows.** A Claude Code `attachment` line that yields no other row gets no event row (`isBareAttachment`, counted as `attachment_line_skipped`); the session span still comes from every parsed line. The files that wrote each session are in `session_file`, not on event rows: `event.source_file` stays as an always-NULL column so an older clens can open and rebuild the index."
- `docs/BACKLOG.md`, the "index grows without bound" entry: replace "One way looked at, not taken while other ways are considered: …" through the end of that sentence group with one sentence saying v23 stops storing bare attachment rows and event paths (this document, about 390 MB of 1.37 GB on 2026-11-16), keeping the `system` lines remark.

## Fitting The Existing Code

- Conventions: schema changes follow the existing upgrade pattern, a version comment and an in-place migration in `applySchema` beside `migrateToSessionKeys` (`schema.ts:9-12`, `:466-508`), with the DDL text defined once for both uses (`eventTableStatement`, `unknownBlockTableStatement`). Writer statements are prepared in `prepareStatements` and wiped in `wipeSessions` (`writer.ts:80-229`). Skipped lines are anomaly counters (`driver.ts:357-362`). Tests are vitest specs with temporary `CLENS_HOME`/`CLENS_CODEX_HOME`/`CLENS_INDEX_DIR` (`test/driver_append.spec.ts`, `test/schema_migration.spec.ts`). No formatter or linter is configured beyond `tsc --noEmit` (`package.json` scripts).
- Reuse: `writeParsedEvent` stays the one place a row is written; `writeEvents` is the one place the bare-attachment rule lives, used by both the full and the append path. `wipeSessions` keeps owning everything a session's wipe removes. The copy rule keeps one definition (`copiedEventRowids` holds the query `notCopiedEventClause` held). `summarizeFile` and the append span loop keep computing spans from every parsed line, which is what keeps `session.started_at/ended_at` unchanged.
- Extension: no registry fits; the indexer has one writer and one schema. Nothing new is made extensible.
- Changes to existing code: `insertEvent`, `sessionsOnlyInFile`, `wipeSessions` (new table); `commitFile`, `finishAppend` (call `writeEvents`, count written rows); `writableEvents`, the rebuild map, append guards 5/7 and the Codex guards (read `session_file`); `EventRow` and the parsers (the field nobody reads); `scope.ts`, the three analyzers and `projectStats` (one copied-row read per call; spans from `session`). Each keeps what its callers get except the documented events-inserted count and the Known Limits.

## Assumptions To Check

- A1. Every read of `event.source_file` is in K3 and every query that bare attachment rows could change is in K9 (re-run the searches after implementing).
- A2. In `commitFile`, inserting the pairs after the dropped-session wipe gives the same `session_file` rows as a rebuild for every case in `test/driver_multifile.spec.ts`, `test/resumed_gate2.spec.ts` and `test/driver_append.spec.ts` (their digests now include `session_file`).
- A3. `migrateIndex` inside `applySchema` takes the migration and the version-mismatch rebuild in the same `runIndex` call, and a second `applySchema` is a no-op.
- A4. A read transaction around `projectStats` on the server's shared read-only connection does not conflict with anything else that connection runs (`src/mcp/server.ts`, `getDb()`): every tool handler is synchronous on it.

## Implementation Order

1. Failing tests first, new `test/index_slim.spec.ts` with Acceptance S1-S4, M1-M3 and Q1-Q2. Check: they fail on the current code.
2. Schema: `SESSION_FILE_STATEMENTS`, the index removed from `SCHEMA_STATEMENTS`, the `eventTableStatement` comment, `migrateIndex` in place of the `migrateToSessionKeys` call, `SCHEMA_VERSION = 23`. Update `test/schema_migration.spec.ts`: in M1 the event index list no longer has `event_source_file_idx`, the event rows equal the ones before with `source_file` NULL, and `session_file` holds exactly `(s-a, /gone/-repo/s-a.jsonl)` and `(s-b, /repo/s-b.jsonl)`; in M3 the kept session's event row equals the one before with `source_file` NULL. M2 and the rest stay. Check: `npx vitest run test/schema_migration.spec.ts test/schema.spec.ts test/index_slim.spec.ts -t "M"`.
3. Types, parsers, writer, driver, append paths, digest. Update `test/driver.spec.ts` gate 1 at `:63-81` and `:157-179` to count the file's events through `session_file` and to add `attachment_line_skipped` to the skipped kinds; `test/driver_append.spec.ts:306-318` and `test/driver_codex_append.spec.ts:393-405` (several_files) to insert the second pair with `INSERT INTO session_file` instead of updating `event.source_file`; the T1 growth test (`driver_append.spec.ts:153-154`) to expect `events_inserted` equal to the rows the run added to `event`; `test/writer_lang.spec.ts:37` (no `source_file` on the row). Check: `npx vitest run test/driver.spec.ts test/driver_append.spec.ts test/driver_codex_append.spec.ts test/driver_multifile.spec.ts test/resumed_gate2.spec.ts test/digest.spec.ts test/writer_lang.spec.ts test/index_slim.spec.ts`.
4. Readers: `scope.ts`, the three analyzers, `projectStats`. Check: `npx vitest run test/mcp_stats.spec.ts test/analyzer_b2.spec.ts test/analyzer_b3.spec.ts test/compaction.spec.ts test/health_codex_ctx.spec.ts test/resumed_gate2.spec.ts test/index_slim.spec.ts`.
5. `AGENTS.md`, `docs/BACKLOG.md`. Then `npm run typecheck`, `npm test`, and `npm run build` so `plugin/` matches the source (CI compares them). Check: all pass; scenario 2 prints what it says.

## Acceptance

Tests in `test/index_slim.spec.ts`, each in temporary `CLENS_HOME`/`CLENS_CODEX_HOME`/`CLENS_INDEX_DIR`. "Equals a rebuild" means `digestAllTables` of the index grown run by run equals that of `runIndex({ rebuild: true })` into a fresh index dir over the same files, as `expectDigestEqualsRebuild` does in `test/driver_append.spec.ts:92-104`. A transcript line below is a Claude Code JSONL line; "a bare attachment" is `{"type":"attachment","attachment":{"type":"hook_success",…},"uuid":…,"sessionId":…,"timestamp":…}`.

- S1. A transcript of session `s1`: bare attachment `t0` (time 1), user line `u1` (2), assistant reply `a1` (3), bare attachment `t1` (4), a `hook_blocking_error` attachment with `hookEvent` `Stop` `t2` (5), a `queued_command` attachment with `origin.kind` `human` and text `more` `t3` (6). After `runIndex`: `SELECT uuid FROM event ORDER BY ts` is `u1, a1, t2, t3`; `session.started_at` is time 1 and `ended_at` time 6; `anomaly` has `attachment_line_skipped` count 2 for the file; `session_file` is exactly `(s1, <file>)`; every `event.source_file` is NULL; `events_inserted` is 4.
- S2. Gate 2 for a session that starts with attachments only: write a transcript of two bare attachments, `runIndex`: no event row, a session row whose span is the two times, `session_file` `(s1, <file>)`. Append `u1` and `a1`, `runIndex`: `files_appended` 1, `events_inserted` 2, equals a rebuild. Append another bare attachment, `runIndex`: `files_appended` 1, `events_inserted` 0, `ended_at` is its time, `attachment_line_skipped` 3, equals a rebuild.
- S3. `test/fixtures/brainstorm-session.jsonl` (961 lines, 239 attachment lines) indexed whole: no event row with role `attachment` lacks a child row (`NOT EXISTS` over the nine child tables keyed `(event_uuid, session_id)`); the event row count plus the `non_event_line`, `json_parse_error`, `non_object_line` and `attachment_line_skipped` counts equals `file_cursor.lines`.
- S4. A session made only of bare attachments still counts as indexed for `writableEvents`: `zz-first.jsonl` holds two bare attachments of session `zz-first` (times 1, 2); `aa-resumed.jsonl` holds copies of those two lines (same uuids, `sessionId` `zz-first`) followed by `aa-resumed`'s own user line (time 3). Index `zz-first.jsonl`, then in a later run `aa-resumed.jsonl`: `session` `zz-first` keeps `started_at` time 1 and `ended_at` time 2 from its own file, `session_file` is exactly `(aa-resumed, <aa file>)` and `(zz-first, <zz file>)`, and `aa-resumed.jsonl` has a `copied_session_line_skipped` count of 2. (With `hasRows` reading `event`, `zz-first` would have no row, the copies would be written, and its pair would move to the other file.)
- M1. A v22 index, made in the test by running `applySchema` on an empty database, then `DROP TABLE session_file`, `CREATE INDEX event_source_file_idx ON event(source_file)` and `schema_version` set to 22, holding sessions `kept` (file `/gone/kept.jsonl`, not on disk) and `disk` (a file on disk), each with a bare attachment row, an attachment row owning a `hook_block`, and a user row with a `user_text`, every event with its `source_file`: after `applySchema`, `event_source_file_idx` does not exist, `session_file` is `(disk, <file>)` and `(kept, /gone/kept.jsonl)`, every `source_file` is NULL, both bare rows are gone, the other four event rows and every child row are unchanged, `schema_version` is still 22.
- M2. `applySchema` a second time changes nothing (same `sqlite_master`, same row counts). Then, as an older clens does: `CREATE INDEX event_source_file_idx ON event(source_file)` and an event row inserted with a `source_file` for a new session `old`: the next `applySchema` adds `(old, <its file>)` to `session_file`, sets that `source_file` to NULL and drops the index.
- M3. `runIndex` on M1's database: `schema_version` 23; `kept`'s rows are as M1 left them; `disk` is re-derived from its file (its rows equal a fresh index of that file); `session_file` is as in M1.
- Q1. `projectStats` with every section, counting the statements it prepares whose SQL contains `JOIN event o ON o.uuid = c.uuid`: 1 for a project, 1 for all projects, 0 for one session. On an index with copied rows (`test/resumed_gate2.spec.ts` R5's two files), the `health` and `timeline` facts `projectStats` returns for the project and for all projects equal what `analyzeHealth` and `analyzeTimeline` return when called with `(db, scope)` alone, and its `primary_model` equals `analyzeIdentity(db, scope)`'s.
- Q2. With S1's transcript: `projectStats` for the project gives `started_at` time 1 and `ended_at` time 6, and the same for all projects; with `since` time 2 it gives `started_at` time 2.

Scenarios (from the repository root, after `npm run build`; `2>/dev/null` hides npm's notices):

1. `npm test` passes.
2. (costly: a full re-index of `~/.claude` and `~/.codex`, several minutes) Upgrade a copy of the real index with the built CLI:
   ```sh
   D=$(mktemp -d) && node -e 'const D=require("better-sqlite3");new D(require("os").homedir()+"/.clens/index.db",{readonly:true}).backup(process.argv[1]).then(()=>{})' "$D/index.db" \
     && node -e 'const D=require("better-sqlite3");const d=new D(process.argv[1]);d.exec("VACUUM");console.log("before", require("fs").statSync(process.argv[1]).size)' "$D/index.db" \
     && CLENS_INDEX_DIR=$D node plugin/dist/cli.js index \
     && node -e 'const D=require("better-sqlite3");const d=new D(process.argv[1],{readonly:true});const one=s=>Object.values(d.prepare(s).get())[0];console.log("after", require("fs").statSync(process.argv[1]).size);console.log("version", one("SELECT v FROM schema_version"));console.log("paths", one("SELECT COUNT(*) FROM event WHERE source_file IS NOT NULL"));console.log("index", one("SELECT COUNT(*) FROM sqlite_master WHERE name = '"'"'event_source_file_idx'"'"'"));console.log("bare", one("SELECT COUNT(*) FROM event e WHERE e.role = '"'"'attachment'"'"' AND NOT EXISTS (SELECT 1 FROM hook_block h WHERE h.event_uuid = e.uuid AND h.session_id = e.session_id) AND NOT EXISTS (SELECT 1 FROM user_text u WHERE u.event_uuid = e.uuid AND u.session_id = e.session_id)"))' "$D/index.db"
   ```
   It prints `before <n>`, the `clens index` summary line, then `after <m>` with `m` at most 0.75 × `n`, `version 23`, `paths 0`, `index 0`, `bare 0`. (`CLENS_INDEX_DIR` alone reads the real transcripts and writes only `$D`, `src/util/paths.ts:21-31`.)
3. On the upgraded copy of scenario 2: `npx tsx docs/experiments/2026-11-16-index-slim/e6-stats-latency.ts "$D/index.db" 2>/dev/null` prints `copied-row reads per call 1` on both lines (3 and 2 before this change), and on this machine its two medians are lower than the ones recorded before the change, 1,349 and 2,955 ms (`docs/experiments/2026-11-16-index-slim/e6-stats-latency-before.txt`).

## Known Limits

- With `since`, the project and all-project spans of `clens_stats` still come from event rows: when the first line at or after `since` was a bare attachment, the span starts at the next stored row, seconds to minutes later.
- `clens_stats` timeline durations come from gaps between event rows; without the bare attachments the split between active, think and idle time moves. On 2026-11-05 the total since 2026-10-01 moved under 1% (3,287 to 3,268 hours, `docs/BACKLOG.md`).
- The all-project session count now counts every work session, as the project count already did, including a session with no event row (1 on this machine, E4: 1,479 against 1,478). Spans read from `session` differ from the event span for kept sessions indexed by older rules (8 on this machine, E1), by up to hours, in the earlier direction.
- A session whose lines so far are all bare attachments (a session just opened) has a session row and a pair but no event row until its first other line.
- `clens stats` (CLI) prints a larger anomaly sum: every bare attachment line of a re-derived file counts once as `attachment_line_skipped`. Bare rows of kept sessions removed by the migration count nowhere.
- The migration runs once, synchronously, under the index lock: 4.6 s on 954k events (E3b), longer on larger indexes, linear in rows. The space returns at the VACUUM after the rebuild (K11), which on this index took 3-6 s.
- An older clens left running as watcher refuses the newer index (K13) but re-creates `event_source_file_idx` when it opens it (4.7 MB, 83 ms, E3b); this version drops it again in its next `applySchema`. Restarting open sessions after the update avoids it.
- Downgrading means `clens index --rebuild` with the older clens, which keeps every session (all paths are NULL) and re-reads every file on disk; read from the code, not run.

## Open Questions

None.

## Goals Check

1. E3b: 1,375.0 MB to 982.5 MB after VACUUM (−29%), with the same steps `migrateIndex` runs after v19; scenario 2 checks the built code against ≤ 75%. Met.
2. `writeEvents` skips only bare attachments after `summarizeFile` and the append span loop read every line; S1 and S3 assert the rows and spans. Met.
3. S2, S4 and the existing gate 2 specs (now hashing `session_file`) check gate 2; S3 and the updated gate 1 tests check line accounting with the new counter. Met.
4. `projectStats` computes `copied` once and passes it on; Q1 counts the statements. Met.
5. Step 5 runs both. Met.

```skerry
{"run": "20261116-010917-66a9", "verify": ["npm run typecheck", "npm test"], "extras": []}
```

## Changes After Approval

- Implementation Order step 1 says every test of `test/index_slim.spec.ts` fails on the current code. Q2 passes there, because the bare attachment rows still give the event span its first and last time; it fails after step 3 (`expected [ '2026-07-01T00:00:02.000Z', … ] to deeply equal [ '2026-07-01T00:00:01.000Z', … ]`) and passes after step 4, which is the change it checks. S4 and M2 fail on the current code with `no such table: session_file`, the others at an assertion.
- Acceptance M1 builds the v22 index with `DROP TABLE session_file` and `CREATE INDEX event_source_file_idx ON event(source_file)`. The test runs `DROP TABLE IF EXISTS` and `CREATE INDEX IF NOT EXISTS`, so the same builder also runs on the code before the change (no `session_file`, the index already made) and the test fails there at an assertion, not in its setup. M3 asserts `schema_version` 23 as a literal.
- Readers: the document gives `analyzeIdentity(db, scope, copied = copiedEventRowids(db, scope))`. It is `analyzeIdentity(db, scope, copied?)` and reads the copied rows, when not given them, only in project scope, the one query that uses them; a global or session call reads none. `analyzeHealth` and `analyzeTimeline` take the default as written.
- Step 4's check runs `test/resumed_gate2.spec.ts`, whose R5 calls `eventWhere(scope, "e")`. With the designed signature, where `copied` is required, R5 now passes `copiedEventRowids(db, scope)`; what it asserts is unchanged.
- Step 4's check runs `test/mcp_stats.spec.ts`, whose "prints the session span, the context-bloat turn and hook blocks in the server's zone" seeds session rows with `started_at` only and expected the project span from event rows. The project span now comes from `session`, so the test sets each session's `ended_at` to the time of its last event, as the indexer writes it; the printed line it asserts is unchanged.
- `test/driver.spec.ts` "creates index.db and populates event rows" expected more than 700 event rows from the fixture, which this change drops below. It now expects exactly 502: 741 lines with a uuid less the 239 bare attachment lines (S3 counts the same lines).
