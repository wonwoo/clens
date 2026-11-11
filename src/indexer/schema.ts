/**
 * SQLite schema for clens index. Follows ExecPlan §7, minus the task, telemetry
 * and plan tables it lists: nothing ever populated them, so they were dropped.
 *
 * All CREATE statements are IF NOT EXISTS so the same code path
 * works for fresh init and re-open. The schema_version table is
 * seeded with the current SCHEMA_VERSION constant on init only.
 *
 * Upgrades: a column added to an existing table is added with ALTER TABLE
 * in applySchema(), a changed key is migrated by copying the table
 * (migrateToSessionKeys); anything else bumps SCHEMA_VERSION, and runIndex()
 * rebuilds on the mismatch. Down-migration is not supported.
 */

import type Database from "better-sqlite3";

import { languageFtsTable, listKnownLanguageCodes } from "./lang/registry.js";

// v2: added session.source (multi-source indexing — Claude/Codex/...).
// v3: added one user_text_fts_lang_<code> table + delete trigger per code in
// listKnownLanguageCodes() (optional-install morphological search layers —
// see indexer/lang/). Generated from that list, not hand-written per
// language, so adding a language later needs no schema rewrite here.
// CREATE TABLE IF NOT EXISTS does not add columns to an existing table, so
// runIndex() compares this against the stored schema_version and forces a
// full rebuild on mismatch. The rebuild keeps sessions whose transcripts are
// gone: the index is their only copy, so index.db is not safe to delete.
// v4: user_text_fts_trigram switched to external content mode (content =
// 'user_text'), eliminating ~39MB of duplicated raw text it previously kept
// in its own shadow table but never actually read (search.ts always JOINs
// back to user_text regardless of which layer matched). CAVEAT: unlike v2/v3
// (new tables/columns only), this is a structural change to an EXISTING
// virtual table. runIndex()'s version-mismatch "rebuild" only DELETEs row
// data — it does not DROP/recreate virtual tables or triggers, so on an
// index.db already at v3, bumping to v4 alone will NOT actually migrate this
// table (CREATE VIRTUAL TABLE/TRIGGER IF NOT EXISTS are no-ops against the
// old structure that already exists under the same names). The index.db
// file itself must be deleted so applySchema() creates the v4 structure
// fresh — confirmed by testing this exact scenario before deciding it was
// safe to ship this way rather than teaching runIndex() to drop-and-recreate
// virtual tables on a version mismatch.
// v5: tool_call.result_chars and the hook_block table. A v4 index.db is
// upgraded in place: applySchema() adds the column, and the version-mismatch
// rebuild in runIndex() re-reads every transcript still on disk to fill it.
// v7: file_op rows with tool 'Bash' for the files a Bash command wrote, read
// off its text (shell_writes.ts). No structural change; the version-mismatch
// rebuild re-reads every transcript still on disk to add them. (v6 was the
// same rows from an earlier cut of shell_writes.ts and was never released.)
// v8: Codex rows. A tool call's is_error and result_chars from its output
// text, file_op rows with tool 'exec_command' for the files a Codex shell
// command wrote (a direct exec_command call or one inside exec code), and
// hook_block rows from HookPrompt items and PreToolUse block messages. No
// structural change; the version-mismatch rebuild re-reads every transcript
// still on disk.
// v9: an exec call is failed when a command its code ran exited nonzero (a
// CommandExecution item naming one of its literal commands while it is
// open). v8 was released, so this needs its own rebuild.
// v10: a command still running when its exec_command call returned fails
// that call when a later write_stdin reports its nonzero exit; a command
// exec code built at run time counts from its CommandExecution item
// (written files, failure); a shell tool's stored input is kept up to 64 KB.
// v11: one system_reminder row with category 'compaction' per compaction,
// from a Claude Code compact_boundary line (excerpt: its trigger) and a Codex
// `compacted` item (a new event row, role 'system'). The reminder-text rule
// that was meant to find compactions never matched a row.
// v12: an MCP call Codex exec code made (a McpToolCall item with an "exec-"
// id) is a tool call of its own, mcp__<server>__<tool>; only the exec call
// was recorded before.
// v13: tool_call.error_excerpt, the start and end of a failed call's output
// (errorExcerpt in claude_parser.ts), added in place like result_chars in v5;
// the version-mismatch rebuild re-reads every transcript still on disk to
// fill it.
// v14: a message the user sent while Claude Code was working (a
// queued_command attachment from a human) is a user_text row. No structural
// change; the version-mismatch rebuild re-reads every transcript still on
// disk to add them.
// v15: a failed Codex shell call's error_excerpt leaves out its output
// header but the exit line (failedOutputText in codex_parser.ts).
// v16: a Codex exec (code mode) call fails when a command result it printed
// exited nonzero, its error_excerpt is that result's output and the script
// error without the script header or the result's JSON (or, when the script
// printed none of it, the failed command's CommandExecution output), and a
// script still running when its exec call returned fails that call when a
// later wait on its cell reports the failure (codeModeOutput in
// codex_parser.ts).
// v17: tool_call.git_branch, the branch checked out when the call ran (the
// checks on a branch, src/mcp/checks.ts), added in place like result_chars
// in v5; the version-mismatch rebuild re-reads every transcript still on
// disk to fill it, and a session whose transcript is gone keeps NULL.
// v18: the Japanese layer indexes each word's dictionary form (lang/ja.ts),
// so a search for a verb finds it conjugated; the version-mismatch rebuild
// re-reads every transcript still on disk, and a session whose transcript is
// gone keeps the forms it was indexed with.
// v19: event and event_unknown_block are keyed per session, so a line copied
// into a resumed session has its own rows there
// (docs/2026-11-09-per-session-events-design.md).
// v20: an assistant reply is stored whole up to 64 KB, not cut at 4 KB
// (ASSISTANT_TEXT_BYTE_CAP); the version-mismatch rebuild re-reads every
// transcript still on disk, and a session whose transcript is gone keeps
// its replies as they were cut.
// v21: a Codex turn that ends at turn_aborted, or is cut off by the next
// task_started, keeps its token counts (pushTurnTokens in codex_parser.ts);
// the version-mismatch rebuild re-reads every rollout still on disk, and a
// session whose rollout is gone keeps the rows it has.
// v22: a Codex session's project id is the one Claude Code gives its cwd
// (projectIdOf); the version-mismatch rebuild re-reads every rollout still
// on disk and gives a session whose rollout is gone the id of its stored cwd.
export const SCHEMA_VERSION = 22;

/** One FTS5 table + delete trigger for a known language code. There is no
 *  AFTER INSERT trigger (unlike the trigram layer) because population
 *  requires the JS-side language adapter (see lang/registry.ts) — writer.ts
 *  inserts explicitly, alongside user_text, only when that adapter is
 *  actually registered (i.e. installed). The table itself always exists so
 *  installing the adapter later needs no migration. The delete trigger
 *  mirrors the trigram layer's so wiping user_text rows (rebuild or
 *  per-session re-derivation) cleans this table up the same way. */
function languageTableStatements(code: string): string[] {
  const table = languageFtsTable(code);
  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(
       text,
       session_id UNINDEXED,
       ts         UNINDEXED,
       tokenize   = 'unicode61'
    )`,
    `CREATE TRIGGER IF NOT EXISTS ${table}_ad
       AFTER DELETE ON user_text BEGIN
         DELETE FROM ${table} WHERE rowid = old.rowid;
       END`,
  ];
}

/** The event table. A line copied into a resumed session keeps its uuid
 *  under the new session id, so the key is (uuid, session_id): each session
 *  holding the line has its own row. The child tables still declare
 *  `REFERENCES event(uuid)`, which no longer names a unique key; that is
 *  harmless while foreign keys are off (applySchema), and a connection with
 *  them on gets "foreign key mismatch" when it writes a child row. */
function eventTableStatement(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
     uuid              TEXT NOT NULL,
     session_id        TEXT NOT NULL,
     parent_uuid       TEXT,
     prompt_id         TEXT,
     agent_id          TEXT,
     is_sidechain      INTEGER,
     ts                TEXT NOT NULL,
     role              TEXT,
     model             TEXT,
     in_tok            INTEGER DEFAULT 0,
     out_tok           INTEGER DEFAULT 0,
     cache_r           INTEGER DEFAULT 0,
     cache_w           INTEGER DEFAULT 0,
     text_len          INTEGER DEFAULT 0,
     has_tool_use      INTEGER DEFAULT 0,
     has_text          INTEGER DEFAULT 0,
     has_tool_res      INTEGER DEFAULT 0,
     user_turn_no      INTEGER,
     assistant_turn_no INTEGER,
     source_file       TEXT,
     PRIMARY KEY (uuid, session_id),
     FOREIGN KEY (session_id) REFERENCES session(id)
   )`;
}

/** The columns of the event table, in their order. */
const EVENT_COLUMNS =
  "uuid, session_id, parent_uuid, prompt_id, agent_id, is_sidechain, ts, role, model, " +
  "in_tok, out_tok, cache_r, cache_w, text_len, has_tool_use, has_text, has_tool_res, " +
  "user_turn_no, assistant_turn_no, source_file";

/** The unknown-block table, keyed per session like the event table.
 *  session_id comes last and may be NULL so that an older clens, whose insert
 *  names only the three columns before it, can still write to a migrated
 *  index; this version always fills it. */
function unknownBlockTableStatement(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
     event_uuid  TEXT NOT NULL,
     block_index INTEGER NOT NULL,
     raw_json    TEXT NOT NULL,
     session_id  TEXT,
     PRIMARY KEY (event_uuid, session_id, block_index),
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`;
}

/** Statement list in declaration order; applySchema() runs each on its own. */
const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)`,

  // ----- File cursor (incremental indexing state) -----
  `CREATE TABLE IF NOT EXISTS file_cursor (
     path     TEXT PRIMARY KEY,
     mtime    REAL NOT NULL,
     size     INTEGER NOT NULL,
     lines    INTEGER NOT NULL,
     last_ok  INTEGER NOT NULL,
     -- no longer written or read; kept so the schema does not change
     live     INTEGER NOT NULL DEFAULT 0
   )`,

  // ----- Upkeep state (not derived from transcripts; digest.ts leaves it out) -----
  // key 'fts_optimized_at': epoch ms of the last FTS 'optimize' (driver.ts).
  // A new table and no derived rows, so no SCHEMA_VERSION bump.
  `CREATE TABLE IF NOT EXISTS maintenance (
     key    TEXT PRIMARY KEY,
     value  TEXT NOT NULL
   )`,

  // ----- Project / Session -----
  `CREATE TABLE IF NOT EXISTS project (
     id       TEXT PRIMARY KEY,
     cwd      TEXT,
     display  TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS session (
     id            TEXT PRIMARY KEY,
     project_id    TEXT,
     kind          TEXT,
     parent_id     TEXT,
     started_at    TEXT,
     ended_at      TEXT,
     cwd           TEXT,
     git_branch    TEXT,
     model_primary TEXT,
     version       TEXT,
     source        TEXT NOT NULL DEFAULT 'claude',
     FOREIGN KEY (project_id) REFERENCES project(id)
   )`,

  // ----- Event (one row per JSONL line and session, multi-block messages stay as one) -----
  eventTableStatement("event"),
  `CREATE INDEX IF NOT EXISTS event_user_turn_idx ON event(session_id, user_turn_no)`,
  `CREATE INDEX IF NOT EXISTS event_session_idx ON event(session_id, ts)`,
  `CREATE INDEX IF NOT EXISTS event_ts_idx ON event(ts)`,
  `CREATE INDEX IF NOT EXISTS event_source_file_idx ON event(source_file)`,

  // ----- Event-unknown-block (forensic store for unrecognized block types) -----
  unknownBlockTableStatement("event_unknown_block"),

  // ----- Tool calls -----
  `CREATE TABLE IF NOT EXISTS tool_call (
     event_uuid  TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     ts          TEXT NOT NULL,
     call_id     TEXT,
     name        TEXT NOT NULL,
     input_json  TEXT,
     duration_ms INTEGER,
     is_error    INTEGER DEFAULT 0,
     result_chars INTEGER,
     error_excerpt TEXT,
     git_branch  TEXT,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS tool_session_idx ON tool_call(session_id)`,
  `CREATE INDEX IF NOT EXISTS tool_name_idx ON tool_call(name)`,
  // A session's calls of some tools (the session record's git commands):
  // without it SQLite took tool_name_idx and read every shell call in the
  // index. Only an index, so no SCHEMA_VERSION bump: the next open adds it.
  `CREATE INDEX IF NOT EXISTS tool_session_name_idx ON tool_call(session_id, name)`,
  `CREATE INDEX IF NOT EXISTS tool_call_id_idx ON tool_call(call_id)`,

  // ----- File operations -----
  `CREATE TABLE IF NOT EXISTS file_op (
     event_uuid  TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     ts          TEXT NOT NULL,
     tool        TEXT NOT NULL,
     path        TEXT NOT NULL,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS file_op_path_idx ON file_op(path)`,
  // A session's edits (clens_left_off) and the indexer's per-session wipe
  // read the whole table without it. No SCHEMA_VERSION bump, as above.
  `CREATE INDEX IF NOT EXISTS file_op_session_tool_idx ON file_op(session_id, tool)`,

  // ----- User and assistant text -----
  `CREATE TABLE IF NOT EXISTS user_text (
     event_uuid  TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     ts          TEXT NOT NULL,
     text        TEXT NOT NULL,
     is_command  INTEGER DEFAULT 0,
     role        TEXT NOT NULL DEFAULT 'user',
     type        TEXT NOT NULL DEFAULT 'user_message',
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS user_text_session_ts_idx ON user_text(session_id, ts)`,

  // ----- FTS5 full-text index over user_text -----
  `CREATE VIRTUAL TABLE IF NOT EXISTS user_text_fts USING fts5(
     text,
     session_id UNINDEXED,
     ts         UNINDEXED,
     content    = 'user_text',
     content_rowid = 'rowid'
  )`,
  `CREATE TRIGGER IF NOT EXISTS user_text_fts_ai
     AFTER INSERT ON user_text BEGIN
       INSERT INTO user_text_fts(rowid, text, session_id, ts)
       VALUES (new.rowid, new.text, new.session_id, new.ts);
     END`,
  `CREATE TRIGGER IF NOT EXISTS user_text_fts_ad
     AFTER DELETE ON user_text BEGIN
       INSERT INTO user_text_fts(user_text_fts, rowid, text, session_id, ts)
       VALUES ('delete', old.rowid, old.text, old.session_id, old.ts);
     END`,

  // ----- FTS5 trigram index (substring / partial-word matching) -----
  // External content (content = 'user_text'), same as user_text_fts above —
  // this table previously kept its own full copy of every row's text in its
  // internal _content shadow table (verified: ~39MB of pure duplication of
  // data user_text already stores), never actually read by search.ts (which
  // always JOINs back to user_text for the displayed text regardless of
  // which FTS layer matched). Pointing it at user_text instead eliminates
  // that duplication with no behavior change (verified: identical MATCH/
  // rank results before and after, same rowids in the same order).
  `CREATE VIRTUAL TABLE IF NOT EXISTS user_text_fts_trigram USING fts5(
     text,
     session_id UNINDEXED,
     ts         UNINDEXED,
     tokenize      = 'trigram',
     content       = 'user_text',
     content_rowid = 'rowid'
  )`,
  `CREATE TRIGGER IF NOT EXISTS user_text_fts_trigram_ai
     AFTER INSERT ON user_text BEGIN
       INSERT INTO user_text_fts_trigram(rowid, text, session_id, ts)
       VALUES (new.rowid, new.text, new.session_id, new.ts);
     END`,
  // External content tables can't reconstruct a deleted row's old column
  // values from user_text after the fact (there's no shadow copy to fall
  // back on) — the special 'delete' command below passes them explicitly
  // from the trigger's old.* row, same pattern as user_text_fts_ad above.
  `CREATE TRIGGER IF NOT EXISTS user_text_fts_trigram_ad
     AFTER DELETE ON user_text BEGIN
       INSERT INTO user_text_fts_trigram(user_text_fts_trigram, rowid, text, session_id, ts)
       VALUES ('delete', old.rowid, old.text, old.session_id, old.ts);
     END`,

  // ----- FTS5 per-language morpheme-normalized layers (optional install) -----
  ...listKnownLanguageCodes().flatMap(languageTableStatements),

  // ----- Skill / Agent / Slash command -----
  `CREATE TABLE IF NOT EXISTS skill_call (
     event_uuid   TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     ts           TEXT NOT NULL,
     skill        TEXT NOT NULL,
     args_excerpt TEXT,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS skill_name_idx ON skill_call(skill)`,

  `CREATE TABLE IF NOT EXISTS agent_call (
     event_uuid     TEXT NOT NULL,
     session_id     TEXT NOT NULL,
     ts             TEXT NOT NULL,
     subagent_type  TEXT NOT NULL,
     description    TEXT,
     prompt_excerpt TEXT,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS agent_type_idx ON agent_call(subagent_type)`,

  `CREATE TABLE IF NOT EXISTS slash_command (
     event_uuid TEXT NOT NULL,
     session_id TEXT NOT NULL,
     ts         TEXT NOT NULL,
     name       TEXT NOT NULL,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS slash_name_idx ON slash_command(name)`,

  `CREATE TABLE IF NOT EXISTS system_reminder (
     event_uuid   TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     ts           TEXT NOT NULL,
     category     TEXT NOT NULL,
     text_excerpt TEXT,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS system_reminder_cat_idx ON system_reminder(category)`,

  // One row per hook refusal: a PreToolUse block (from the blocked call's
  // error result; tool and call_id set) or a Stop block (from its
  // hook_blocking_error attachment; tool and call_id NULL).
  `CREATE TABLE IF NOT EXISTS hook_block (
     event_uuid  TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     ts          TEXT NOT NULL,
     hook_event  TEXT NOT NULL,
     tool        TEXT,
     call_id     TEXT,
     reason      TEXT,
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS hook_block_session_idx ON hook_block(session_id)`,

  // ----- Anomaly bucket (lifecycle per §7) -----
  // `source_file` is a v1 implementation detail (not in the spec's column list)
  // so incremental re-parses can wipe their own per-file anomaly rows before
  // re-flushing — keeps `clens stats --digest` deterministic between
  // incremental and rebuild paths (gate 2). Reports still aggregate via
  // `SELECT kind, SUM(count) GROUP BY kind`, so the extra column is transparent
  // to downstream consumers.
  `CREATE TABLE IF NOT EXISTS anomaly (
     session_id   TEXT,
     ts           TEXT,
     kind         TEXT NOT NULL,
     count        INTEGER NOT NULL DEFAULT 1,
     detail       TEXT,
     source_file  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS anomaly_kind_idx ON anomaly(kind)`,
  `CREATE INDEX IF NOT EXISTS anomaly_source_file_idx ON anomaly(source_file)`,
];

/** Apply schema (idempotent) and PRAGMAs on a freshly opened database. */
export function applySchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  // 30s, matching runIndex()'s default lock wait (driver.ts) — a 5s
  // SQLite-level busy_timeout was too short whenever a concurrent writer
  // (e.g. the MCP server's watcher reindexing on its own) legitimately held
  // a write for longer than that, producing a raw "database is locked"
  // error instead of letting SQLite's own retry wait it out.
  db.pragma("busy_timeout = 30000");
  db.pragma("foreign_keys = OFF"); // we manage FK integrity at parse time; OFF avoids reorder constraints
  db.pragma("synchronous = NORMAL");

  migrateToSessionKeys(db);

  const initTx = db.transaction(() => {
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
    // v5 upgrade: CREATE TABLE IF NOT EXISTS leaves a v4 tool_call without
    // result_chars. is_error is its last column, so the added column lands
    // where a fresh CREATE puts it and SELECT * reads the same either way.
    const toolCallColumns = db.prepare("PRAGMA table_info(tool_call)").all() as { name: string }[];
    if (!toolCallColumns.some((c) => c.name === "result_chars")) {
      db.exec("ALTER TABLE tool_call ADD COLUMN result_chars INTEGER");
    }
    // v13 upgrade, the same way: error_excerpt follows result_chars.
    if (!toolCallColumns.some((c) => c.name === "error_excerpt")) {
      db.exec("ALTER TABLE tool_call ADD COLUMN error_excerpt TEXT");
    }
    // v17 upgrade, the same way: git_branch follows error_excerpt.
    if (!toolCallColumns.some((c) => c.name === "git_branch")) {
      db.exec("ALTER TABLE tool_call ADD COLUMN git_branch TEXT");
    }
    const row = db.prepare("SELECT v FROM schema_version LIMIT 1").get() as
      | { v: number }
      | undefined;
    if (!row) {
      db.prepare("INSERT INTO schema_version (v) VALUES (?)").run(SCHEMA_VERSION);
    }
  });
  initTx();
}

/** v19: re-key event and event_unknown_block per session in an index made
 *  before it. A no-op on a fresh or already migrated index. Runs with foreign
 *  keys off, as applySchema sets them: with them on, dropping the old event
 *  table checked every child row and ran for minutes on a real index. Rows
 *  are copied in key order, which took 5-7 s for 857,893 events. One
 *  transaction, so a failure leaves the old tables for the next run. */
function migrateToSessionKeys(db: Database.Database): void {
  const columns = (table: string) =>
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
  db.transaction(() => {
    const blockColumns = columns("event_unknown_block");
    if (blockColumns.length > 0 && !blockColumns.some((c) => c.name === "session_id")) {
      // The old event table has one row per uuid, so each block gets one
      // session; a block whose event is missing is dropped (nothing reads it).
      db.exec(unknownBlockTableStatement("event_unknown_block_v19"));
      db.exec(
        `INSERT INTO event_unknown_block_v19 (event_uuid, session_id, block_index, raw_json)
         SELECT k.event_uuid, e.session_id, k.block_index, k.raw_json
         FROM event_unknown_block k JOIN event e ON e.uuid = k.event_uuid`,
      );
      db.exec("DROP TABLE event_unknown_block");
      db.exec("ALTER TABLE event_unknown_block_v19 RENAME TO event_unknown_block");
    } else if (blockColumns.length > 0) {
      // Only an older clens writes a block without a session. Its writes also
      // set the stored version back, so the rebuild that follows writes the
      // block again with one; this version wipes blocks by session and would
      // never delete these.
      db.exec("DELETE FROM event_unknown_block WHERE session_id IS NULL");
    }
    const eventKey = columns("event")
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    if (eventKey.length === 1 && eventKey[0] === "uuid") {
      // The event indexes go with the old table; SCHEMA_STATEMENTS, which run
      // next, create them again.
      db.exec(eventTableStatement("event_v19"));
      db.exec(`INSERT INTO event_v19 (${EVENT_COLUMNS}) SELECT ${EVENT_COLUMNS} FROM event ORDER BY uuid, session_id`);
      db.exec("DROP TABLE event");
      db.exec("ALTER TABLE event_v19 RENAME TO event");
    }
  })();
}

/** Read the currently stored schema version (or null if uninitialized). */
export function getSchemaVersion(db: Database.Database): number | null {
  try {
    const row = db.prepare("SELECT v FROM schema_version LIMIT 1").get() as
      | { v: number }
      | undefined;
    return row?.v ?? null;
  } catch {
    return null;
  }
}
