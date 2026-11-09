import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runIndex } from "../src/indexer/driver.js";
import { applySchema, getSchemaVersion, SCHEMA_VERSION } from "../src/indexer/schema.js";

// v19 keys event and event_unknown_block per session. An index made before
// it is migrated in place by applySchema, keeping every row, and the
// version-mismatch rebuild then re-derives the sessions still on disk.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clens-schema-migration-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.CLENS_HOME;
  delete process.env.CLENS_CODEX_HOME;
  delete process.env.CLENS_INDEX_DIR;
});

const KEPT = "s-a";
const ON_DISK = "s-b";
const GONE_FILE = "/gone/-repo/s-a.jsonl";

/** A v18 index, its tables written out here as v18 created them, since the
 *  schema no longer holds that text. Two sessions hold a tool call of the
 *  copied line u1; its one event row is in s-b's, which replaced s-a's. */
function createV18(path: string, onDiskFile: string): Database.Database {
  const db = new Database(path);
  // As applySchema left them in v18.
  db.pragma("foreign_keys = OFF");
  db.exec(`
    CREATE TABLE schema_version (v INTEGER NOT NULL);
    INSERT INTO schema_version (v) VALUES (18);
    CREATE TABLE project (
      id       TEXT PRIMARY KEY,
      cwd      TEXT,
      display  TEXT
    );
    CREATE TABLE session (
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
    );
    CREATE TABLE event (
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
    );
    CREATE INDEX event_user_turn_idx ON event(session_id, user_turn_no);
    CREATE INDEX event_session_idx ON event(session_id, ts);
    CREATE INDEX event_ts_idx ON event(ts);
    CREATE INDEX event_source_file_idx ON event(source_file);
    CREATE TABLE event_unknown_block (
      event_uuid  TEXT NOT NULL,
      block_index INTEGER NOT NULL,
      raw_json    TEXT NOT NULL,
      PRIMARY KEY (event_uuid, block_index),
      FOREIGN KEY (event_uuid) REFERENCES event(uuid)
    );
    CREATE TABLE tool_call (
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
    );
    INSERT INTO project (id, cwd, display) VALUES ('-repo', '/repo', '-repo');
    INSERT INTO session (id, project_id, kind, started_at, ended_at, model_primary, source) VALUES
      ('${KEPT}', '-repo', 'interactive', '2026-07-01T00:00:02.000Z', '2026-07-01T00:00:03.000Z', 'claude-x', 'claude'),
      ('${ON_DISK}', '-repo', 'interactive', '2026-07-01T00:00:02.000Z', '2026-07-01T00:00:02.000Z', 'claude-x', 'claude');
  `);
  const event = db.prepare(
    `INSERT INTO event (uuid, session_id, ts, role, model, in_tok, has_tool_use, assistant_turn_no, source_file)
     VALUES (?, ?, ?, 'assistant', 'claude-x', ?, 1, ?, ?)`,
  );
  event.run("u1", ON_DISK, "2026-07-01T00:00:02.000Z", 7, 1, onDiskFile);
  event.run("u2", KEPT, "2026-07-01T00:00:03.000Z", 9, 2, GONE_FILE);
  const call = db.prepare(
    `INSERT INTO tool_call (event_uuid, session_id, ts, call_id, name, input_json, duration_ms)
     VALUES (?, ?, ?, ?, 'Bash', '{"command":"npm test"}', ?)`,
  );
  call.run("u1", KEPT, "2026-07-01T00:00:02.000Z", "toolu_1", 1000);
  call.run("u1", ON_DISK, "2026-07-01T00:00:02.000Z", "toolu_1", null);
  call.run("u2", KEPT, "2026-07-01T00:00:03.000Z", "toolu_2", 500);
  db.prepare("INSERT INTO event_unknown_block (event_uuid, block_index, raw_json) VALUES ('u1', 1, ?)").run('{"type":"mystery_block"}');
  return db;
}

const pkColumns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .sort((x, y) => x.pk - y.pk)
    .map((c) => c.name);
const all = (db: Database.Database, sql: string) => db.prepare(sql).all();
const master = (db: Database.Database) => all(db, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name");
const rowCounts = (db: Database.Database) =>
  (all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%' ORDER BY name") as { name: string }[])
    .map(({ name }) => [name, (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n]);

describe("migration to per-session event keys (v19)", () => {
  it("M1: re-keys event and event_unknown_block, keeping every row", () => {
    const db = createV18(":memory:", "/repo/s-b.jsonl");
    expect(pkColumns(db, "event")).toEqual(["uuid"]);
    const events = all(db, "SELECT * FROM event ORDER BY uuid");
    const calls = all(db, "SELECT * FROM tool_call ORDER BY event_uuid, session_id");
    applySchema(db);
    expect(pkColumns(db, "event")).toEqual(["uuid", "session_id"]);
    expect(pkColumns(db, "event_unknown_block")).toEqual(["event_uuid", "session_id", "block_index"]);
    expect(all(db, "SELECT * FROM event ORDER BY uuid")).toEqual(events);
    expect(all(db, "SELECT * FROM tool_call ORDER BY event_uuid, session_id")).toEqual(calls);
    expect(all(db, "SELECT * FROM event_unknown_block")).toEqual([
      { event_uuid: "u1", block_index: 1, raw_json: '{"type":"mystery_block"}', session_id: ON_DISK },
    ]);
    const indexes = all(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event' AND sql IS NOT NULL ORDER BY name");
    expect(indexes).toEqual([
      { name: "event_session_idx" },
      { name: "event_source_file_idx" },
      { name: "event_ts_idx" },
      { name: "event_user_turn_idx" },
    ]);
    // The rebuild in runIndex, not applySchema, moves the version on.
    expect(getSchemaVersion(db)).toBe(18);
    db.close();
  });

  it("M2: a second applySchema changes nothing, and drops a block an older clens wrote without a session", () => {
    const db = createV18(":memory:", "/repo/s-b.jsonl");
    applySchema(db);
    const schema = master(db);
    const counts = rowCounts(db);
    applySchema(db);
    expect(master(db)).toEqual(schema);
    expect(rowCounts(db)).toEqual(counts);

    // An older clens names only the three v18 columns.
    db.prepare("INSERT OR REPLACE INTO event_unknown_block (event_uuid, block_index, raw_json) VALUES ('u2', 0, '{}')").run();
    expect(all(db, "SELECT event_uuid, session_id FROM event_unknown_block ORDER BY event_uuid")).toEqual([
      { event_uuid: "u1", session_id: ON_DISK },
      { event_uuid: "u2", session_id: null },
    ]);
    applySchema(db);
    expect(all(db, "SELECT event_uuid, session_id FROM event_unknown_block ORDER BY event_uuid")).toEqual([
      { event_uuid: "u1", session_id: ON_DISK },
    ]);
    db.close();
  });

  it("M3: runIndex keeps a session whose transcript is gone as it was and re-derives the other", async () => {
    const claude = join(root, ".claude");
    const indexDir = join(root, ".clens");
    const proj = join(claude, "projects", "-repo");
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    mkdirSync(indexDir, { recursive: true });
    process.env.CLENS_HOME = claude;
    process.env.CLENS_CODEX_HOME = join(root, ".codex");
    process.env.CLENS_INDEX_DIR = indexDir;
    const onDisk = join(proj, `${ON_DISK}.jsonl`);
    writeFileSync(
      onDisk,
      JSON.stringify({
        uuid: "u1", sessionId: ON_DISK, type: "assistant", timestamp: "2026-07-01T00:00:02.000Z",
        message: { role: "assistant", model: "claude-x", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] },
      }) + "\n",
    );
    const kept = (db: Database.Database) => ({
      session: all(db, `SELECT * FROM session WHERE id = '${KEPT}'`),
      event: all(db, `SELECT * FROM event WHERE session_id = '${KEPT}' ORDER BY uuid`),
      tool_call: all(db, `SELECT * FROM tool_call WHERE session_id = '${KEPT}' ORDER BY event_uuid`),
    });
    const db = createV18(join(indexDir, "index.db"), onDisk);
    const before = kept(db);
    expect(before.event).toHaveLength(1);
    expect(before.tool_call).toHaveLength(2);
    db.close();

    await runIndex({});

    const after = new Database(join(indexDir, "index.db"), { readonly: true });
    expect(kept(after)).toEqual(before);
    expect(getSchemaVersion(after)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(19);
    expect(all(after, `SELECT uuid, session_id FROM event WHERE session_id = '${ON_DISK}'`)).toEqual([{ uuid: "u1", session_id: ON_DISK }]);
    // Re-derived from the transcript, which holds no unknown block.
    expect(all(after, "SELECT * FROM event_unknown_block")).toEqual([]);
    after.close();
  });
});
