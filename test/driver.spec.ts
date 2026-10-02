import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runIndex } from "../src/indexer/driver.js";
import { registerLanguage, resetLanguageRegistry } from "../src/indexer/lang/registry.js";

const FIXTURE = join(process.cwd(), "test/fixtures/brainstorm-session.jsonl");

/** Build a fake ~/.claude/projects/<proj>/ + ~/.clens/ pair under a tmp dir
 *  and point env vars at them so the driver writes its index in isolation. */
function setupFakeHome(): { tmpRoot: string; claude: string; clens: string } {
  const tmpRoot = mkdtempSync(join(tmpdir(), "clens-drv-"));
  const claude = join(tmpRoot, ".claude");
  const clens = join(tmpRoot, ".clens");
  mkdirSync(join(claude, "projects", "fixture-project"), { recursive: true });
  mkdirSync(clens, { recursive: true });
  copyFileSync(FIXTURE, join(claude, "projects", "fixture-project", "test.jsonl"));
  process.env.CLENS_HOME = claude;
  process.env.CLENS_INDEX_DIR = clens;
  return { tmpRoot, claude, clens };
}

describe("indexer driver — full build", () => {
  let env: ReturnType<typeof setupFakeHome>;

  beforeAll(async () => {
    env = setupFakeHome();
    await runIndex({ rebuild: true });
  });

  afterAll(() => {
    rmSync(env.tmpRoot, { recursive: true, force: true });
    delete process.env.CLENS_HOME;
    delete process.env.CLENS_INDEX_DIR;
  });

  it("creates index.db and populates event rows", () => {
    const db = new Database(join(env.clens, "index.db"));
    const ev = db.prepare("SELECT COUNT(*) AS c FROM event").get() as { c: number };
    expect(ev.c).toBeGreaterThan(700);
    db.close();
  });

  it("populates file_cursor with mtime, size, lines, last_ok", () => {
    const db = new Database(join(env.clens, "index.db"));
    const rows = db.prepare("SELECT * FROM file_cursor").all() as Array<{
      path: string;
      mtime: number;
      size: number;
      lines: number;
      last_ok: number;
      live: number;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.lines).toBeGreaterThan(900);
    expect(rows[0]!.last_ok).toBeGreaterThan(0);
    db.close();
  });

  it("gate 1: line accounting — file_cursor.lines == event_rows_for_file + non_event_anomalies", () => {
    const db = new Database(join(env.clens, "index.db"));
    const cursor = db.prepare("SELECT * FROM file_cursor LIMIT 1").get() as {
      path: string;
      lines: number;
    };
    const events = db
      .prepare("SELECT COUNT(*) AS c FROM event WHERE source_file = ?")
      .get(cursor.path) as { c: number };
    // Anomalies that map to skipped lines (non_event_line, json_parse_error, non_object_line).
    const skipKinds = ["non_event_line", "json_parse_error", "non_object_line"];
    const placeholders = skipKinds.map(() => "?").join(",");
    const skipped = db
      .prepare(`SELECT COALESCE(SUM(count), 0) AS c FROM anomaly WHERE kind IN (${placeholders})`)
      .get(...skipKinds) as { c: number };
    expect(events.c + skipped.c).toBe(cursor.lines);
    db.close();
  });

  it("derives session.kind correctly (top-level JSONL → interactive)", () => {
    const db = new Database(join(env.clens, "index.db"));
    const row = db.prepare("SELECT kind FROM session WHERE id = ?").get("test") as { kind: string } | undefined;
    expect(row?.kind).toBe("interactive");
    db.close();
  });

  it("upserts project from path", () => {
    const db = new Database(join(env.clens, "index.db"));
    const row = db.prepare("SELECT id FROM project WHERE id = ?").get("fixture-project") as { id: string } | undefined;
    expect(row?.id).toBe("fixture-project");
    db.close();
  });

  it("preserves user_turn_no {3,4,6} round-trip via SQL", () => {
    const db = new Database(join(env.clens, "index.db"));
    const rows = db
      .prepare(
        `SELECT e.user_turn_no AS turn, u.text
         FROM user_text u JOIN event e ON u.event_uuid = e.uuid
         WHERE e.user_turn_no IN (3, 4, 6) ORDER BY e.user_turn_no`,
      )
      .all() as { turn: number; text: string }[];
    expect(rows.find((r) => r.turn === 3)?.text).toContain("대화 검색은 아니야");
    expect(rows.find((r) => r.turn === 4)?.text).toContain("나혼자 쓸꺼는 아니야");
    expect(rows.find((r) => r.turn === 6)?.text).toContain("API 키 이거필요");
    db.close();
  });
});

describe("indexer driver — incremental no-op", () => {
  let env: ReturnType<typeof setupFakeHome>;
  beforeAll(async () => {
    env = setupFakeHome();
    await runIndex({ rebuild: true });
  });
  afterAll(() => {
    rmSync(env.tmpRoot, { recursive: true, force: true });
    delete process.env.CLENS_HOME;
    delete process.env.CLENS_INDEX_DIR;
  });

  it("second run with no source changes parses 0 files", async () => {
    const r = await runIndex({});
    expect(r.files_parsed).toBe(0);
    expect(r.files_total).toBe(1);
  });
});

describe("indexer driver — incremental after file change", () => {
  let env: ReturnType<typeof setupFakeHome>;
  beforeAll(async () => {
    env = setupFakeHome();
    await runIndex({ rebuild: true });
  });
  afterAll(() => {
    rmSync(env.tmpRoot, { recursive: true, force: true });
    delete process.env.CLENS_HOME;
    delete process.env.CLENS_INDEX_DIR;
  });

  it("touching the fixture file triggers re-parse and refreshes file_cursor", async () => {
    const filePath = join(env.claude, "projects", "fixture-project", "test.jsonl");
    // Bump mtime by appending a no-op trailing newline; size grows by 1.
    const body = readFileSync(filePath);
    writeFileSync(filePath, body);
    // Force mtime forward by waiting briefly + reopening with utime
    const fs = await import("node:fs");
    const future = (Date.now() + 5000) / 1000;
    fs.utimesSync(filePath, future, future);

    const r = await runIndex({});
    expect(r.files_parsed).toBe(1);
  });

  it("gate 1 still holds after incremental re-parse: line accounting matches", async () => {
    const filePath = join(env.claude, "projects", "fixture-project", "test.jsonl");
    const fs = await import("node:fs");
    const future = (Date.now() + 5000) / 1000;
    fs.utimesSync(filePath, future, future);
    await runIndex({});

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(join(env.clens, "index.db"));
    const cursor = db.prepare("SELECT * FROM file_cursor LIMIT 1").get() as {
      path: string;
      lines: number;
    };
    const events = db
      .prepare("SELECT COUNT(*) AS c FROM event WHERE source_file = ?")
      .get(cursor.path) as { c: number };
    const skipKinds = ["non_event_line", "json_parse_error", "non_object_line"];
    const placeholders = skipKinds.map(() => "?").join(",");
    const skipped = db
      .prepare(`SELECT COALESCE(SUM(count), 0) AS c FROM anomaly WHERE kind IN (${placeholders})`)
      .get(...skipKinds) as { c: number };
    expect(events.c + skipped.c).toBe(cursor.lines);
    db.close();
  });
});

/** Build a fake ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl + ~/.clens/ pair
 *  under a tmp dir and point env vars at them so the driver indexes Codex
 *  data in isolation, independent of any Claude fixture. */
function setupFakeCodexHome(): { tmpRoot: string; codex: string; clens: string } {
  const tmpRoot = mkdtempSync(join(tmpdir(), "clens-drv-codex-"));
  const codex = join(tmpRoot, ".codex");
  const clens = join(tmpRoot, ".clens");
  const dayDir = join(codex, "sessions", "2026", "07", "01");
  mkdirSync(dayDir, { recursive: true });
  mkdirSync(clens, { recursive: true });

  const lines = [
    {
      timestamp: "2026-07-01T00:00:00Z",
      type: "session_meta",
      payload: { id: "codex-sess-1", cwd: "/Users/me/IdeaProjects/demo", cli_version: "1.0.0" },
    },
    {
      timestamp: "2026-07-01T00:00:01Z",
      type: "turn_context",
      payload: { model: "gpt-5", cwd: "/Users/me/IdeaProjects/demo" },
    },
    {
      timestamp: "2026-07-01T00:00:02Z",
      type: "event_msg",
      payload: { type: "user_message", message: "hello from an end-to-end codex fixture" },
    },
  ];
  writeFileSync(
    join(dayDir, "rollout-2026-07-01-codex-sess-1.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );

  // codexHome() falls back to a non-existent sentinel unless CLENS_CODEX_HOME
  // is explicitly set — required even though CLENS_HOME is also overridden.
  process.env.CLENS_HOME = join(tmpRoot, ".claude-unused");
  process.env.CLENS_CODEX_HOME = codex;
  process.env.CLENS_INDEX_DIR = clens;
  return { tmpRoot, codex, clens };
}

describe("indexer driver — Codex source end-to-end", () => {
  let env: ReturnType<typeof setupFakeCodexHome>;

  beforeAll(async () => {
    env = setupFakeCodexHome();
    await runIndex({ rebuild: true });
  });

  afterAll(() => {
    rmSync(env.tmpRoot, { recursive: true, force: true });
    delete process.env.CLENS_HOME;
    delete process.env.CLENS_CODEX_HOME;
    delete process.env.CLENS_INDEX_DIR;
  });

  it("tags the session with source='codex'", () => {
    const db = new Database(join(env.clens, "index.db"));
    const row = db.prepare("SELECT source FROM session WHERE id = ?").get("codex-sess-1") as
      | { source: string }
      | undefined;
    expect(row?.source).toBe("codex");
    db.close();
  });

  it("derives project_id from session cwd via slash-to-dash, not the date-sharded file path", () => {
    const db = new Database(join(env.clens, "index.db"));
    const row = db.prepare("SELECT project_id FROM session WHERE id = ?").get("codex-sess-1") as
      | { project_id: string }
      | undefined;
    expect(row?.project_id).toBe("-Users-me-IdeaProjects-demo");
    db.close();
  });

  it("routes the file through the Codex parser, not the Claude parser", () => {
    const db = new Database(join(env.clens, "index.db"));
    const row = db
      .prepare("SELECT text FROM user_text WHERE session_id = ? AND role = 'user'")
      .get("codex-sess-1") as { text: string } | undefined;
    expect(row?.text).toBe("hello from an end-to-end codex fixture");
    db.close();
  });
});

/** Same shape as setupFakeCodexHome(), plus a project-cwd directory the
 *  driver can validate a project-local "$name" skill candidate against, and
 *  a global skills dir for the globally-installed one. */
function setupCodexSkillFixture(): { tmpRoot: string; codex: string; clens: string } {
  const tmpRoot = mkdtempSync(join(tmpdir(), "clens-drv-codex-skill-"));
  const codex = join(tmpRoot, ".codex");
  const clens = join(tmpRoot, ".clens");
  const projectCwd = join(tmpRoot, "project");
  const dayDir = join(codex, "sessions", "2026", "07", "02");
  mkdirSync(dayDir, { recursive: true });
  mkdirSync(clens, { recursive: true });
  mkdirSync(join(codex, "skills", "code-review"), { recursive: true });
  mkdirSync(join(projectCwd, ".codex", "skills", "local-only"), { recursive: true });

  const lines = [
    {
      timestamp: "2026-07-02T00:00:00Z",
      type: "session_meta",
      payload: { id: "codex-skill-sess", cwd: projectCwd, cli_version: "1.0.0" },
    },
    { timestamp: "2026-07-02T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "$code-review 리뷰해줘" } },
    { timestamp: "2026-07-02T00:00:02Z", type: "event_msg", payload: { type: "user_message", message: "예산은 $100 정도로 잡자" } },
    { timestamp: "2026-07-02T00:00:03Z", type: "event_msg", payload: { type: "user_message", message: "$local-only 스킬 써바" } },
    { timestamp: "2026-07-02T00:00:04Z", type: "event_msg", payload: { type: "user_message", message: "$totally-made-up 이건 존재 안함" } },
  ];
  writeFileSync(
    join(dayDir, "rollout-2026-07-02-codex-skill-sess.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );

  process.env.CLENS_HOME = join(tmpRoot, ".claude-unused");
  process.env.CLENS_CODEX_HOME = codex;
  process.env.CLENS_INDEX_DIR = clens;
  return { tmpRoot, codex, clens };
}

describe("indexer driver — Codex explicit skill invocation ($name) validation", () => {
  let env: ReturnType<typeof setupCodexSkillFixture>;

  beforeAll(async () => {
    env = setupCodexSkillFixture();
    await runIndex({ rebuild: true });
  });

  afterAll(() => {
    rmSync(env.tmpRoot, { recursive: true, force: true });
    delete process.env.CLENS_HOME;
    delete process.env.CLENS_CODEX_HOME;
    delete process.env.CLENS_INDEX_DIR;
  });

  function skillRow(skill: string) {
    const db = new Database(join(env.clens, "index.db"));
    const row = db
      .prepare("SELECT skill FROM skill_call WHERE session_id = ? AND skill = ?")
      .get("codex-skill-sess", skill);
    db.close();
    return row;
  }

  it("confirms a candidate matching a globally-installed skill", () => {
    expect(skillRow("code-review")).toBeDefined();
  });

  it("confirms a candidate matching only this session's project-local skills dir", () => {
    expect(skillRow("local-only")).toBeDefined();
  });

  it("drops a numeric false-positive candidate ($100) that matches no installed skill", () => {
    expect(skillRow("100")).toBeUndefined();
  });

  it("drops a plausible-looking but non-existent skill name", () => {
    expect(skillRow("totally-made-up")).toBeUndefined();
  });

  it("commits exactly the 2 confirmed rows, not all 4 raw candidates", () => {
    const db = new Database(join(env.clens, "index.db"));
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM skill_call WHERE session_id = ?")
      .get("codex-skill-sess") as { c: number };
    expect(row.c).toBe(2);
    db.close();
  });
});

/**
 * Gate 2 (incremental == rebuild digest, per this file's header comment)
 * extended to the per-language FTS layer added in lang/registry.ts: a
 * registered adapter's inserts happen inside writeParsedEvent(), the same
 * per-file transaction as everything else (writer.ts), and wipeSessions()
 * deleting from user_text fires the language table's own AFTER DELETE
 * trigger (schema.ts) the same way the trigram layer's does — so a touched
 * file's per-session wipe-and-reinsert must reproduce byte-identical
 * language-layer rows, not just leave the rest of the schema untouched.
 * Uses a fake adapter (deterministic, no real model needed) registered
 * directly — see writer_lang.spec.ts for why this bypasses lang/init.ts
 * entirely and is a legitimate way to test the wiring.
 */
describe("indexer driver — language layer respects Gate 2 (incremental == rebuild)", () => {
  let env: ReturnType<typeof setupFakeHome>;

  function snapshotLangTable(): string[] {
    const db = new Database(join(env.clens, "index.db"));
    const rows = db
      .prepare("SELECT rowid, text FROM user_text_fts_lang_ko ORDER BY rowid")
      .all() as { rowid: number; text: string }[];
    db.close();
    return rows.map((r) => `${r.rowid}:${r.text}`);
  }

  beforeAll(async () => {
    registerLanguage({
      code: "ko",
      detect: (t) => t.trim().length > 0,
      tokenize: (t) => t.trim().split(/\s+/).slice(0, 3),
    });
    env = setupFakeHome();
    await runIndex({ rebuild: true });
  });

  afterAll(() => {
    resetLanguageRegistry();
    rmSync(env.tmpRoot, { recursive: true, force: true });
    delete process.env.CLENS_HOME;
    delete process.env.CLENS_INDEX_DIR;
  });

  it("full rebuild populates the ko layer for at least some user_text rows", () => {
    const db = new Database(join(env.clens, "index.db"));
    const userTextCount = (db.prepare("SELECT COUNT(*) AS c FROM user_text").get() as { c: number }).c;
    const langCount = (db.prepare("SELECT COUNT(*) AS c FROM user_text_fts_lang_ko").get() as { c: number }).c;
    db.close();
    expect(langCount).toBeGreaterThan(0);
    expect(langCount).toBeLessThanOrEqual(userTextCount);
  });

  it("incremental re-parse after touching the file reproduces byte-identical ko-layer rows", async () => {
    const before = snapshotLangTable();

    const filePath = join(env.claude, "projects", "fixture-project", "test.jsonl");
    const fs = await import("node:fs");
    const future = (Date.now() + 5000) / 1000;
    fs.utimesSync(filePath, future, future);
    await runIndex({});

    expect(snapshotLangTable()).toEqual(before);
  });
});
