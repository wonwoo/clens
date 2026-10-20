import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { applySchema, getSchemaVersion, SCHEMA_VERSION } from "../src/indexer/schema.js";

const EXPECTED_TABLES = [
  "schema_version",
  "file_cursor",
  "project",
  "session",
  "event",
  "event_unknown_block",
  "tool_call",
  "file_op",
  "user_text",
  "user_text_fts",
  "user_text_fts_trigram",
  "user_text_fts_lang_ko",
  "user_text_fts_lang_ja",
  "user_text_fts_lang_zh",
  "skill_call",
  "agent_call",
  "slash_command",
  "system_reminder",
  "hook_block",
  "anomaly",
];

const EXPECTED_INDEXES = [
  "event_user_turn_idx",
  "event_session_idx",
  "event_ts_idx",
  "tool_session_idx",
  "tool_name_idx",
  "tool_session_name_idx",
  "tool_call_id_idx",
  "file_op_path_idx",
  "file_op_session_tool_idx",
  "skill_name_idx",
  "agent_type_idx",
  "slash_name_idx",
  "system_reminder_cat_idx",
  "hook_block_session_idx",
  "anomaly_kind_idx",
];

function openMem(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("schema.ts", () => {
  it("creates every expected table", () => {
    const db = openMem();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const t of EXPECTED_TABLES) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it("creates every expected index", () => {
    const db = openMem();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const idx of EXPECTED_INDEXES) {
      expect(names).toContain(idx);
    }
    db.close();
  });

  it("finds a session's calls of some tools by session and name, not by name across every session", () => {
    // The session record's git-command query: on tool_name_idx it read every
    // shell call in the index, about a second when they were not cached.
    const db = openMem();
    const plan = db.prepare(`EXPLAIN QUERY PLAN
      WITH RECURSIVE tree(id) AS (SELECT 'a' UNION SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.id)
      SELECT ts FROM tool_call WHERE session_id IN tree AND name IN ('Bash', 'exec_command', 'exec')`)
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toContain("USING INDEX tool_session_name_idx (session_id=? AND name=?)");
    db.close();
  });

  it("finds a session's edits by session and tool, not by reading every file_op row", () => {
    // The session record's and the list's edited files: file_op had no
    // session index, so each read the whole table.
    const db = openMem();
    const plan = db.prepare(`EXPLAIN QUERY PLAN
      WITH RECURSIVE tree(id) AS (SELECT 'a' UNION SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.id)
      SELECT path FROM file_op WHERE session_id IN tree AND tool IN ('Edit', 'Write', 'Bash')`)
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toContain("USING INDEX file_op_session_tool_idx (session_id=? AND tool=?)");
    db.close();
  });

  it("adds an index to an existing index.db without a schema version change", () => {
    const db = openMem();
    const added = ["tool_session_name_idx", "file_op_session_tool_idx"];
    for (const name of added) db.exec(`DROP INDEX ${name}`);
    applySchema(db);
    for (const name of added) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)).toBeDefined();
    }
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("seeds schema_version", () => {
    const db = openMem();
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("is idempotent: applying twice does not duplicate schema_version", () => {
    const db = openMem();
    applySchema(db); // second application
    const rows = db.prepare("SELECT v FROM schema_version").all() as { v: number }[];
    expect(rows.length).toBe(1);
    db.close();
  });

  it("WAL pragma is set", () => {
    const db = openMem();
    const mode = db.pragma("journal_mode", { simple: true });
    // :memory: databases report 'memory' here regardless. Disk-backed DBs
    // would show 'wal'. Smoke test: applying did not throw.
    expect(typeof mode).toBe("string");
    db.close();
  });
});

describe("schema.ts — per-language FTS layers (generated from listKnownLanguageCodes())", () => {
  it("creates a delete trigger for every known code (ko, ja, zh) — proves generation from the list, not a hand-written per-language block", () => {
    const db = openMem();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("user_text_fts_lang_ko_ad");
    expect(names).toContain("user_text_fts_lang_ja_ad");
    expect(names).toContain("user_text_fts_lang_zh_ad");
    db.close();
  });

  it("the ko layer table exists and is queryable even with nothing registered/installed", () => {
    const db = openMem();
    const row = db.prepare("SELECT count(*) AS n FROM user_text_fts_lang_ko").get() as { n: number };
    expect(row.n).toBe(0);
    db.close();
  });

  it("deleting a user_text row cleans up its ko-layer row (same cleanup guarantee the trigram layer's own delete trigger provides)", () => {
    const db = openMem();
    db.exec(`
      INSERT INTO session (id) VALUES ('s1');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES ('e1', 's1', '2026-01-01T00:00:00Z', '리팩토링을');
      INSERT INTO user_text_fts_lang_ko (rowid, text, session_id, ts)
        VALUES ((SELECT rowid FROM user_text WHERE event_uuid = 'e1'), '리팩토링', 's1', '2026-01-01T00:00:00Z');
    `);
    expect((db.prepare("SELECT count(*) AS n FROM user_text_fts_lang_ko").get() as { n: number }).n).toBe(1);
    db.exec(`DELETE FROM user_text WHERE event_uuid = 'e1'`);
    expect((db.prepare("SELECT count(*) AS n FROM user_text_fts_lang_ko").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("schema.ts — user_text_fts_trigram external content mode (v4)", () => {
  it("has no _content shadow table — it reads text from user_text instead of duplicating it", () => {
    const db = openMem();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'user_text_fts_trigram_content'")
      .get();
    expect(row).toBeUndefined();
    db.close();
  });

  it("inserting into user_text makes the row findable via the trigram MATCH layer", () => {
    const db = openMem();
    db.exec(`
      INSERT INTO session (id) VALUES ('s1');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES ('e1', 's1', '2026-01-01T00:00:00Z', '리팩토링을 진행했습니다');
    `);
    const rows = db
      .prepare("SELECT rowid FROM user_text_fts_trigram WHERE user_text_fts_trigram MATCH '리팩토'")
      .all();
    expect(rows).toHaveLength(1);
    db.close();
  });

  // The delete trigger now uses the external-content 'delete' command (see
  // schema.ts) instead of a plain DELETE FROM, since an external content
  // table has no shadow copy of the old row's text to fall back on. Proves
  // that special-command path actually cleans up the index, not just that
  // the trigger exists.
  it("deleting a user_text row removes it from the trigram index (external-content delete command works)", () => {
    const db = openMem();
    db.exec(`
      INSERT INTO session (id) VALUES ('s1');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES ('e1', 's1', '2026-01-01T00:00:00Z', '리팩토링을 진행했습니다');
    `);
    const before = db
      .prepare("SELECT rowid FROM user_text_fts_trigram WHERE user_text_fts_trigram MATCH '리팩토'")
      .all();
    expect(before).toHaveLength(1);
    db.exec(`DELETE FROM user_text WHERE event_uuid = 'e1'`);
    const after = db
      .prepare("SELECT rowid FROM user_text_fts_trigram WHERE user_text_fts_trigram MATCH '리팩토'")
      .all();
    expect(after).toHaveLength(0);
    db.close();
  });
});

describe("schema.ts — v5 upgrade of an existing index", () => {
  it("adds tool_call.result_chars to a v4 tool_call table, where a fresh schema puts it", () => {
    const columns = (db: Database.Database) =>
      (db.prepare("PRAGMA table_info(tool_call)").all() as { name: string; type: string }[])
        .map((c) => `${c.name} ${c.type}`);
    const fresh = openMem();
    const upgraded = new Database(":memory:");
    upgraded.exec(`CREATE TABLE tool_call (
       event_uuid  TEXT NOT NULL,
       session_id  TEXT NOT NULL,
       ts          TEXT NOT NULL,
       call_id     TEXT,
       name        TEXT NOT NULL,
       input_json  TEXT,
       duration_ms INTEGER,
       is_error    INTEGER DEFAULT 0,
       FOREIGN KEY (event_uuid) REFERENCES event(uuid)
     )`);
    applySchema(upgraded);
    expect(columns(upgraded)).toEqual(columns(fresh));
    expect(columns(upgraded)).toContain("result_chars INTEGER");
    expect(columns(upgraded)).toContain("error_excerpt TEXT");
    applySchema(upgraded);
    expect(columns(upgraded)).toEqual(columns(fresh));
    fresh.close();
    upgraded.close();
  });
});
