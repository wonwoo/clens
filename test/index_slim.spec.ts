import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyzeHealth } from "../src/analyzer/health.js";
import { analyzeIdentity } from "../src/analyzer/identity.js";
import type { Scope } from "../src/analyzer/scope.js";
import { analyzeTimeline } from "../src/analyzer/timeline.js";
import { digestAllTables } from "../src/indexer/digest.js";
import { runIndex } from "../src/indexer/driver.js";
import { applySchema, getSchemaVersion } from "../src/indexer/schema.js";
import { projectStats } from "../src/mcp/stats.js";

// v23 (docs/2026-11-16-index-slim-design.md): event rows no longer hold their
// transcript's path, session_file holds the (session, file) pairs, and a
// Claude Code attachment line that yields no other row gets no event row.
// An index grown run by run in `a` is compared with one rebuilt from scratch
// in `b` over the same files (gate 2).

interface Env {
  root: string;
  proj: string;
  a: string;
  b: string;
}

let env: Env;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "clens-index-slim-"));
  const proj = join(root, ".claude", "projects", "-repo");
  const a = join(root, "a");
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(root, ".codex"), { recursive: true });
  mkdirSync(a, { recursive: true });
  process.env.CLENS_HOME = join(root, ".claude");
  process.env.CLENS_CODEX_HOME = join(root, ".codex");
  process.env.CLENS_INDEX_DIR = a;
  env = { root, proj, a, b: join(root, "b") };
});

afterEach(() => {
  rmSync(env.root, { recursive: true, force: true });
  delete process.env.CLENS_HOME;
  delete process.env.CLENS_CODEX_HOME;
  delete process.env.CLENS_INDEX_DIR;
});

/** Give a file a later mtime than everything written before it, so the next
 *  run sees it changed. */
let clock = 1_900_000_000;
function bump(path: string): void {
  clock += 10;
  utimesSync(path, clock, clock);
}

const file = (sid: string) => join(env.proj, `${sid}.jsonl`);

function write(sid: string, lines: object[]): void {
  writeFileSync(file(sid), lines.map((l) => JSON.stringify(l) + "\n").join(""));
  bump(file(sid));
}

function add(sid: string, lines: object[]): void {
  appendFileSync(file(sid), lines.map((l) => JSON.stringify(l) + "\n").join(""));
  bump(file(sid));
}

const at = (second: number) => `2026-07-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const base = (uuid: string, sessionId: string, second: number) => ({ uuid, sessionId, timestamp: at(second), cwd: "/repo" });
const user = (uuid: string, sid: string, second: number, content: unknown) =>
  ({ ...base(uuid, sid, second), type: "user", message: { role: "user", content } });
const reply = (uuid: string, sid: string, second: number, model: string, content: unknown) =>
  ({ ...base(uuid, sid, second), type: "assistant", message: { role: "assistant", model, content } });
const text = (t: string) => [{ type: "text", text: t }];
/** An attachment line that yields no row besides its event. */
const bare = (uuid: string, sid: string, second: number) => ({
  ...base(uuid, sid, second),
  type: "attachment",
  attachment: { type: "hook_success", hookName: "SessionStart:startup", hookEvent: "SessionStart", content: "", exitCode: 0 },
});
/** A Stop hook's refusal: a hook_block row. */
const stopBlock = (uuid: string, sid: string, second: number) => ({
  ...base(uuid, sid, second),
  type: "attachment",
  attachment: { type: "hook_blocking_error", hookName: "Stop", hookEvent: "Stop", blockingError: { blockingError: "tests fail" } },
});
/** A message the user queued mid-turn: a user_text row. */
const queued = (uuid: string, sid: string, second: number, prompt: string) => ({
  ...base(uuid, sid, second),
  type: "attachment",
  attachment: { type: "queued_command", prompt, origin: { kind: "human" } },
});

function open(dir: string): Database.Database {
  return new Database(join(dir, "index.db"), { readonly: true });
}

function query<T = unknown>(sql: string, ...binds: unknown[]): T[] {
  const db = open(env.a);
  try {
    return db.prepare(sql).all(...binds) as T[];
  } finally {
    db.close();
  }
}

function digestOf(dir: string): ReturnType<typeof digestAllTables> {
  const db = open(dir);
  const d = digestAllTables(db);
  db.close();
  return d;
}

/** Index the files on disk into a fresh index in `b`, then point the
 *  environment back at `a`. */
async function rebuildIntoB(): Promise<void> {
  rmSync(env.b, { recursive: true, force: true });
  mkdirSync(env.b, { recursive: true });
  process.env.CLENS_INDEX_DIR = env.b;
  try {
    await runIndex({ rebuild: true });
  } finally {
    process.env.CLENS_INDEX_DIR = env.a;
  }
}

/** Gate 2: the index grown in `a` equals one rebuilt from scratch in `b`. */
async function expectDigestEqualsRebuild(): Promise<void> {
  const grown = digestOf(env.a);
  await rebuildIntoB();
  expect(digestOf(env.b)).toEqual(grown);
}

const skippedAttachments = (path: string) =>
  query<{ count: number }>("SELECT count FROM anomaly WHERE kind = 'attachment_line_skipped' AND source_file = ?", path);

const S1_LINES = [
  bare("t0", "s1", 1),
  user("u1", "s1", 2, "question"),
  reply("a1", "s1", 3, "claude-x", text("answer")),
  bare("t1", "s1", 4),
  stopBlock("t2", "s1", 5),
  queued("t3", "s1", 6, "more"),
];

describe("a bare attachment line", () => {
  it("S1: gets no event row, while the attachments that own a row keep theirs and the span keeps every line", async () => {
    write("s1", S1_LINES);
    const r = await runIndex({});
    expect(query("SELECT uuid FROM event ORDER BY ts")).toEqual([{ uuid: "u1" }, { uuid: "a1" }, { uuid: "t2" }, { uuid: "t3" }]);
    expect(query("SELECT started_at, ended_at FROM session WHERE id = 's1'")).toEqual([{ started_at: at(1), ended_at: at(6) }]);
    expect(skippedAttachments(file("s1"))).toEqual([{ count: 2 }]);
    expect(query("SELECT session_id, source_file FROM session_file")).toEqual([{ session_id: "s1", source_file: file("s1") }]);
    expect(query("SELECT COUNT(*) AS n FROM event WHERE source_file IS NOT NULL")).toEqual([{ n: 0 }]);
    expect(r.events_inserted).toBe(4);
  });

  it("S2: a session that starts with attachments only is appended to as a rebuild writes it", async () => {
    write("s1", [bare("t0", "s1", 1), bare("t1", "s1", 2)]);
    await runIndex({});
    expect(query("SELECT uuid FROM event")).toEqual([]);
    expect(query("SELECT started_at, ended_at FROM session WHERE id = 's1'")).toEqual([{ started_at: at(1), ended_at: at(2) }]);
    expect(query("SELECT session_id, source_file FROM session_file")).toEqual([{ session_id: "s1", source_file: file("s1") }]);

    add("s1", [user("u1", "s1", 3, "question"), reply("a1", "s1", 4, "claude-x", text("answer"))]);
    const grown = await runIndex({});
    expect([grown.files_appended, grown.events_inserted]).toEqual([1, 2]);
    await expectDigestEqualsRebuild();

    add("s1", [bare("t2", "s1", 5)]);
    const touched = await runIndex({});
    expect([touched.files_appended, touched.events_inserted]).toEqual([1, 0]);
    expect(query("SELECT ended_at FROM session WHERE id = 's1'")).toEqual([{ ended_at: at(5) }]);
    expect(skippedAttachments(file("s1"))).toEqual([{ count: 3 }]);
    await expectDigestEqualsRebuild();
  });

  it("S3: none is stored from the fixture, and line accounting still adds up", async () => {
    const dir = join(env.root, ".claude", "projects", "fixture-project");
    mkdirSync(dir, { recursive: true });
    const fixture = join(dir, "test.jsonl");
    copyFileSync(join(process.cwd(), "test/fixtures/brainstorm-session.jsonl"), fixture);
    await runIndex({});
    const owned = ["tool_call", "file_op", "user_text", "skill_call", "agent_call", "slash_command", "system_reminder", "hook_block", "event_unknown_block"]
      .map((t) => `NOT EXISTS (SELECT 1 FROM ${t} c WHERE c.event_uuid = e.uuid AND c.session_id = e.session_id)`)
      .join(" AND ");
    expect(query(`SELECT COUNT(*) AS n FROM event e WHERE e.role = 'attachment' AND ${owned}`)).toEqual([{ n: 0 }]);
    const [{ lines }] = query<{ lines: number }>("SELECT lines FROM file_cursor WHERE path = ?", fixture) as [{ lines: number }];
    const [{ events }] = query<{ events: number }>("SELECT COUNT(*) AS events FROM event") as [{ events: number }];
    const [{ skipped }] = query<{ skipped: number }>(
      `SELECT COALESCE(SUM(count), 0) AS skipped FROM anomaly WHERE source_file = ?
         AND kind IN ('non_event_line', 'json_parse_error', 'non_object_line', 'attachment_line_skipped')`,
      fixture,
    ) as [{ skipped: number }];
    expect(lines).toBe(961);
    expect(events + skipped).toBe(lines);
  });

  it("S4: a session made only of bare attachments still counts as indexed for a resumed file's copies", async () => {
    const FIRST = "zz-first";
    const RESUMED = "aa-resumed";
    write(FIRST, [bare("t0", FIRST, 1), bare("t1", FIRST, 2)]);
    await runIndex({});
    write(RESUMED, [bare("t0", FIRST, 1), bare("t1", FIRST, 2), user("u1", RESUMED, 3, "go on")]);
    await runIndex({});
    expect(query(`SELECT started_at, ended_at FROM session WHERE id = '${FIRST}'`)).toEqual([{ started_at: at(1), ended_at: at(2) }]);
    expect(query("SELECT session_id, source_file FROM session_file ORDER BY session_id")).toEqual([
      { session_id: RESUMED, source_file: file(RESUMED) },
      { session_id: FIRST, source_file: file(FIRST) },
    ]);
    expect(query("SELECT count FROM anomaly WHERE kind = 'copied_session_line_skipped' AND source_file = ?", file(RESUMED))).toEqual([
      { count: 2 },
    ]);
  });
});

const KEPT_FILE = "/gone/kept.jsonl";

/** A v22 index: today's schema with event_source_file_idx and without
 *  session_file. Sessions `kept` (transcript gone) and `disk` each hold a bare
 *  attachment row, an attachment row owning a hook_block, and a user row with
 *  a user_text, every event with its path. */
function createV22(path: string, diskFile: string): Database.Database {
  const db = new Database(path);
  applySchema(db);
  db.exec(`
    DROP TABLE IF EXISTS session_file;
    CREATE INDEX IF NOT EXISTS event_source_file_idx ON event(source_file);
    UPDATE schema_version SET v = 22;
    INSERT INTO project (id, cwd, display) VALUES ('-repo', '/repo', '-repo');
  `);
  const session = db.prepare(
    `INSERT INTO session (id, project_id, kind, started_at, ended_at, cwd, source)
     VALUES (?, '-repo', 'interactive', ?, ?, '/repo', 'claude')`,
  );
  const event = db.prepare(
    "INSERT INTO event (uuid, session_id, ts, role, user_turn_no, has_text, source_file) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const hookBlock = db.prepare(
    "INSERT INTO hook_block (event_uuid, session_id, ts, hook_event, reason) VALUES (?, ?, ?, 'Stop', 'tests fail')",
  );
  const userText = db.prepare("INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES (?, ?, ?, 'hello')");
  for (const [sid, f] of [["kept", KEPT_FILE], ["disk", diskFile]] as const) {
    session.run(sid, at(1), at(3));
    event.run(`${sid}-bare`, sid, at(1), "attachment", null, 0, f);
    event.run(`${sid}-stop`, sid, at(2), "attachment", null, 0, f);
    hookBlock.run(`${sid}-stop`, sid, at(2));
    event.run(`${sid}-u`, sid, at(3), "user", 1, 1, f);
    userText.run(`${sid}-u`, sid, at(3));
  }
  return db;
}

/** disk's transcript, the lines createV22 stored for it. */
function writeDiskTranscript(): string {
  write("disk", [bare("disk-bare", "disk", 1), stopBlock("disk-stop", "disk", 2), user("disk-u", "disk", 3, "hello")]);
  return file("disk");
}

const all = (db: Database.Database, sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
const master = (db: Database.Database) => all(db, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name");
const rowCounts = (db: Database.Database) =>
  (all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%' ORDER BY name") as { name: string }[])
    .map(({ name }) => [name, (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n]);
const sourceFileIndex = (db: Database.Database) => all(db, "SELECT name FROM sqlite_master WHERE name = 'event_source_file_idx'");
const pathless = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, source_file: null }));
const CHILD_ROWS = "SELECT * FROM hook_block ORDER BY session_id, event_uuid";
const TEXT_ROWS = "SELECT * FROM user_text ORDER BY session_id, event_uuid";

describe("the v23 migration", () => {
  it("M1: moves the paths into session_file and deletes the bare attachment rows of every session", () => {
    const diskFile = join(env.proj, "disk.jsonl");
    const db = createV22(":memory:", diskFile);
    const kept = all(db, "SELECT * FROM event WHERE uuid NOT LIKE '%-bare' ORDER BY session_id, uuid");
    const blocks = all(db, CHILD_ROWS);
    const texts = all(db, TEXT_ROWS);
    expect(kept).toHaveLength(4);
    applySchema(db);
    expect(sourceFileIndex(db)).toEqual([]);
    expect(all(db, "SELECT session_id, source_file FROM session_file ORDER BY session_id")).toEqual([
      { session_id: "disk", source_file: diskFile },
      { session_id: "kept", source_file: KEPT_FILE },
    ]);
    expect(all(db, "SELECT COUNT(*) AS n FROM event WHERE source_file IS NOT NULL")).toEqual([{ n: 0 }]);
    expect(all(db, "SELECT * FROM event ORDER BY session_id, uuid")).toEqual(pathless(kept));
    expect(all(db, CHILD_ROWS)).toEqual(blocks);
    expect(all(db, TEXT_ROWS)).toEqual(texts);
    // The rebuild in runIndex, not applySchema, moves the version on.
    expect(getSchemaVersion(db)).toBe(22);
    db.close();
  });

  it("M2: a second applySchema changes nothing, and a later one takes in what an older clens wrote", () => {
    const db = createV22(":memory:", join(env.proj, "disk.jsonl"));
    applySchema(db);
    const schema = master(db);
    const counts = rowCounts(db);
    applySchema(db);
    expect(master(db)).toEqual(schema);
    expect(rowCounts(db)).toEqual(counts);

    // An older clens creates the index again when it opens the file, and
    // writes its rows with their path.
    db.exec("CREATE INDEX IF NOT EXISTS event_source_file_idx ON event(source_file)");
    db.prepare("INSERT INTO event (uuid, session_id, ts, role, source_file) VALUES ('old-u', 'old', ?, 'user', '/repo/old.jsonl')").run(at(4));
    applySchema(db);
    expect(all(db, "SELECT session_id, source_file FROM session_file WHERE session_id = 'old'")).toEqual([
      { session_id: "old", source_file: "/repo/old.jsonl" },
    ]);
    expect(all(db, "SELECT source_file FROM event WHERE uuid = 'old-u'")).toEqual([{ source_file: null }]);
    expect(sourceFileIndex(db)).toEqual([]);
    db.close();
  });

  it("M3: runIndex keeps the session whose transcript is gone as the migration left it and re-derives the other", async () => {
    const diskFile = writeDiskTranscript();
    const db = createV22(join(env.a, "index.db"), diskFile);
    const keptEvents = pathless(
      all(db, "SELECT * FROM event WHERE session_id = 'kept' AND uuid <> 'kept-bare' ORDER BY uuid"),
    );
    const keptRows = (d: Database.Database) => ({
      session: all(d, "SELECT * FROM session WHERE id = 'kept'"),
      hook_block: all(d, "SELECT * FROM hook_block WHERE session_id = 'kept'"),
      user_text: all(d, "SELECT * FROM user_text WHERE session_id = 'kept'"),
    });
    const keptBefore = keptRows(db);
    db.close();

    await runIndex({});

    const after = open(env.a);
    expect(getSchemaVersion(after)).toBe(23);
    expect(all(after, "SELECT * FROM event WHERE session_id = 'kept' ORDER BY uuid")).toEqual(keptEvents);
    expect(keptRows(after)).toEqual(keptBefore);
    expect(all(after, "SELECT session_id, source_file FROM session_file ORDER BY session_id")).toEqual([
      { session_id: "disk", source_file: diskFile },
      { session_id: "kept", source_file: KEPT_FILE },
    ]);
    const diskRows = (d: Database.Database) =>
      ["event", "hook_block", "user_text"].map((t) => all(d, `SELECT * FROM ${t} WHERE session_id = 'disk' ORDER BY rowid`))
        .concat([all(d, "SELECT * FROM session WHERE id = 'disk'")]);
    const migrated = diskRows(after);
    after.close();
    await rebuildIntoB();
    const fresh = open(env.b);
    expect(migrated).toEqual(diskRows(fresh));
    fresh.close();
  });
});

describe("clens_stats", () => {
  /** resumed_gate2's R5 files: zz-first's two lines copied at the head of
   *  aa-resumed, which adds one of its own. */
  async function indexResumed(): Promise<void> {
    const earlier = (sid: string) => [user("a1", sid, 1, "fix the flaky retry"), reply("a2", sid, 2, "claude-x", text("ok"))];
    write("zz-first", earlier("zz-first"));
    await runIndex({});
    write("aa-resumed", [...earlier("aa-resumed"), user("b1", "aa-resumed", 3, "now run the tests")]);
    await runIndex({});
  }

  /** Counts the statements `db` prepares that read the copied event rows. */
  function countCopyReads(db: Database.Database): () => number {
    let reads = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("JOIN event o ON o.uuid = c.uuid")) reads += 1;
      return prepare(sql);
    }) as typeof db.prepare;
    return () => {
      const n = reads;
      reads = 0;
      return n;
    };
  }

  it("Q1: reads the copied rows once per call over several sessions, none for one session, with the analyzers' own results", async () => {
    await indexResumed();
    const db = open(env.a);
    try {
      const reads = countCopyReads(db);
      const project = projectStats(db, { project_id: "-repo" });
      expect(reads()).toBe(1);
      const everything = projectStats(db, {});
      expect(reads()).toBe(1);
      projectStats(db, { session_id: "aa-resumed" });
      expect(reads()).toBe(0);

      const projectScope: Scope = { mode: "project", params: { project_id: "-repo" } };
      const globalScope: Scope = { mode: "global", params: {} };
      expect(project.health).toEqual(analyzeHealth(db, projectScope));
      expect(project.timeline).toEqual(analyzeTimeline(db, projectScope));
      expect(everything.health).toEqual(analyzeHealth(db, globalScope));
      expect(everything.timeline).toEqual(analyzeTimeline(db, globalScope));
      const identity = analyzeIdentity(db, projectScope);
      expect(identity.kind === "project" && identity.project.primary_model).toBe(project.primary_model);
      expect(project.primary_model).toBe("claude-x");
    } finally {
      db.close();
    }
  });

  it("Q2: takes the project and all-project spans from every parsed line, and from the stored rows with since", async () => {
    write("s1", S1_LINES);
    await runIndex({});
    const db = open(env.a);
    try {
      const span = (facts: { started_at: string | null; ended_at: string | null }) => [facts.started_at, facts.ended_at];
      expect(span(projectStats(db, { project_id: "-repo" }))).toEqual([at(1), at(6)]);
      expect(span(projectStats(db, {}))).toEqual([at(1), at(6)]);
      expect(projectStats(db, { project_id: "-repo", since: at(2) }).started_at).toBe(at(2));
    } finally {
      db.close();
    }
  });
});
