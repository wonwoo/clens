/**
 * SQLite schema for clens index. Follows ExecPlan §7, minus the task, telemetry
 * and plan tables it lists: nothing ever populated them, so they were dropped.
 *
 * All CREATE statements are IF NOT EXISTS so the same code path
 * works for fresh init and re-open. The schema_version table is
 * seeded with the current SCHEMA_VERSION constant on init only.
 *
 * Migration path: append-only files in src/indexer/migrations/<n>-<slug>.sql,
 * each idempotent. Down-migration is not supported in v1 (rebuild instead).
 */
import { languageFtsTable, listKnownLanguageCodes } from "./lang/registry.js";
// v2: added session.source (multi-source indexing — Claude/Codex/...).
// v3: added one user_text_fts_lang_<code> table + delete trigger per code in
// listKnownLanguageCodes() (optional-install morphological search layers —
// see indexer/lang/). Generated from that list, not hand-written per
// language, so adding a language later needs no schema rewrite here.
// CREATE TABLE IF NOT EXISTS does not add columns to an existing table, so
// runIndex() compares this against the stored schema_version and forces a
// full rebuild on mismatch (index.db is a derived cache, safe to regenerate).
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
export const SCHEMA_VERSION = 12;
/** One FTS5 table + delete trigger for a known language code. There is no
 *  AFTER INSERT trigger (unlike the trigram layer) because population
 *  requires the JS-side language adapter (see lang/registry.ts) — writer.ts
 *  inserts explicitly, alongside user_text, only when that adapter is
 *  actually registered (i.e. installed). The table itself always exists so
 *  installing the adapter later needs no migration. The delete trigger
 *  mirrors the trigram layer's so wiping user_text rows (rebuild or
 *  per-session re-derivation) cleans this table up the same way. */
function languageTableStatements(code) {
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
/** Statement list in declaration order. Splitter knows each ends in `;`. */
const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)`,
    // ----- File cursor (incremental indexing state) -----
    `CREATE TABLE IF NOT EXISTS file_cursor (
     path     TEXT PRIMARY KEY,
     mtime    REAL NOT NULL,
     size     INTEGER NOT NULL,
     lines    INTEGER NOT NULL,
     last_ok  INTEGER NOT NULL,
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
    // ----- Event (one row per JSONL line, multi-block messages stay as one) -----
    `CREATE TABLE IF NOT EXISTS event (
     uuid              TEXT PRIMARY KEY,
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
     FOREIGN KEY (session_id) REFERENCES session(id)
   )`,
    `CREATE INDEX IF NOT EXISTS event_user_turn_idx ON event(session_id, user_turn_no)`,
    `CREATE INDEX IF NOT EXISTS event_session_idx ON event(session_id, ts)`,
    `CREATE INDEX IF NOT EXISTS event_ts_idx ON event(ts)`,
    `CREATE INDEX IF NOT EXISTS event_source_file_idx ON event(source_file)`,
    // ----- Event-unknown-block (forensic store for unrecognized block types) -----
    `CREATE TABLE IF NOT EXISTS event_unknown_block (
     event_uuid  TEXT NOT NULL,
     block_index INTEGER NOT NULL,
     raw_json    TEXT NOT NULL,
     PRIMARY KEY (event_uuid, block_index),
     FOREIGN KEY (event_uuid) REFERENCES event(uuid)
   )`,
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
export function applySchema(db) {
    db.pragma("journal_mode = WAL");
    // 30s, matching acquireLock()'s own default wait (driver.ts) — a 5s
    // SQLite-level busy_timeout was too short whenever a concurrent writer
    // (e.g. the MCP server's watcher reindexing on its own) legitimately held
    // a write for longer than that, producing a raw "database is locked"
    // error instead of letting SQLite's own retry wait it out.
    db.pragma("busy_timeout = 30000");
    db.pragma("foreign_keys = OFF"); // we manage FK integrity at parse time; OFF avoids reorder constraints
    db.pragma("synchronous = NORMAL");
    const initTx = db.transaction(() => {
        for (const stmt of SCHEMA_STATEMENTS)
            db.exec(stmt);
        // v5 upgrade: CREATE TABLE IF NOT EXISTS leaves a v4 tool_call without
        // result_chars. is_error is its last column, so the added column lands
        // where a fresh CREATE puts it and SELECT * reads the same either way.
        const toolCallColumns = db.prepare("PRAGMA table_info(tool_call)").all();
        if (!toolCallColumns.some((c) => c.name === "result_chars")) {
            db.exec("ALTER TABLE tool_call ADD COLUMN result_chars INTEGER");
        }
        const row = db.prepare("SELECT v FROM schema_version LIMIT 1").get();
        if (!row) {
            db.prepare("INSERT INTO schema_version (v) VALUES (?)").run(SCHEMA_VERSION);
        }
    });
    initTx();
}
/** Read the currently stored schema version (or null if uninitialized). */
export function getSchemaVersion(db) {
    try {
        const row = db.prepare("SELECT v FROM schema_version LIMIT 1").get();
        return row?.v ?? null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=schema.js.map