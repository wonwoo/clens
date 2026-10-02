import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runIndex } from "../src/indexer/driver.js";
import { analyzeTools } from "../src/analyzer/tools.js";
import { analyzeTimeline } from "../src/analyzer/timeline.js";
import { analyzeFiles } from "../src/analyzer/files.js";
import type { Scope } from "../src/analyzer/scope.js";

const FIXTURE = join(process.cwd(), "test/fixtures/brainstorm-session.jsonl");

function setupFakeHome() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "clens-b2-"));
  const claude = join(tmpRoot, ".claude");
  const clens = join(tmpRoot, ".clens");
  mkdirSync(join(claude, "projects", "p1"), { recursive: true });
  mkdirSync(clens, { recursive: true });
  copyFileSync(FIXTURE, join(claude, "projects", "p1", "test.jsonl"));
  process.env.CLENS_HOME = claude;
  process.env.CLENS_INDEX_DIR = clens;
  return { tmpRoot, claude, clens };
}

const SESSION: Scope = { mode: "session", params: { session_id: "test" } };

describe("Phase B.2 analyzers (D4-D7) on fixture", () => {
  let env: ReturnType<typeof setupFakeHome>;
  let db: Database.Database;

  beforeAll(async () => {
    env = setupFakeHome();
    await runIndex({ rebuild: true });
    db = new Database(join(env.clens, "index.db"), { readonly: true });
  });

  afterAll(() => {
    db.close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
    delete process.env.CLENS_HOME;
    delete process.env.CLENS_INDEX_DIR;
  });

  it("D4 tools: Edit is the most-called tool in the fixture", () => {
    const r = analyzeTools(db, SESSION);
    expect(r.counts["Edit"]).toBeGreaterThanOrEqual(70);
    expect(r.counts["Agent"]).toBe(5);
  });

  it("D4 tools: errors match the error rows and counts run by count desc, then name", () => {
    const r = analyzeTools(db, SESSION);
    const errorRows = (db
      .prepare("SELECT COUNT(*) AS c FROM tool_call WHERE session_id = ? AND is_error = 1")
      .get("test") as { c: number }).c;
    expect(r.errors).toBe(errorRows);
    const keys = Object.keys(r.counts);
    const expected = [...keys].sort((a, b) => r.counts[b]! - r.counts[a]! || (a < b ? -1 : a > b ? 1 : 0));
    expect(keys).toEqual(expected);
  });

  it("D6 timeline: wall ≥ think ≥ 0, idle ≥ 0, sum ≤ wall", () => {
    const r = analyzeTimeline(db, SESSION);
    expect(r.wall_min).toBeGreaterThanOrEqual(0);
    expect(r.think_min).toBeGreaterThanOrEqual(0);
    expect(r.idle_min).toBeGreaterThanOrEqual(0);
    expect(r.think_min + r.idle_min).toBeLessThanOrEqual(r.wall_min + 0.01);
  });

  it("D7 files: top is sorted desc by count and limited to ≤50", () => {
    const r = analyzeFiles(db, SESSION);
    expect(r.top.length).toBeGreaterThan(0);
    expect(r.top.length).toBeLessThanOrEqual(50);
    for (let i = 1; i < r.top.length; i++) {
      expect(r.top[i]!.count <= r.top[i - 1]!.count).toBe(true);
    }
  });
});

describe("D7 files counts the files a shell command wrote, but not temporary ones", () => {
  it("counts Bash and Codex exec_command paths, leaving out a temporary folder outside the session's own", async () => {
    const { applySchema } = await import("../src/indexer/schema.js");
    const mem = new Database(":memory:");
    applySchema(mem);
    mem.exec("INSERT INTO session (id, cwd) VALUES ('test', '/tmp/work')");
    const add = mem.prepare("INSERT INTO file_op (event_uuid, session_id, ts, tool, path) VALUES (?, 'test', ?, ?, ?)");
    add.run("e1", "2026-01-01T00:00:00Z", "Edit", "/w/a.ts");
    add.run("e2", "2026-01-01T00:00:01Z", "Edit", "/w/a.ts");
    add.run("e3", "2026-01-01T00:00:02Z", "Bash", "/w/b.ts");
    add.run("e4", "2026-01-01T00:00:03Z", "Bash", "/w/a.ts");
    add.run("e5", "2026-01-01T00:00:04Z", "exec_command", "/w/a.ts");
    add.run("e6", "2026-01-01T00:00:05Z", "exec_command", "/w/c.ts");
    for (const k of [1, 2, 3]) add.run(`t${k}`, "2026-01-01T00:00:06Z", "Bash", "/private/tmp/claude-1/scratchpad/run.log");
    add.run("t4", "2026-01-01T00:00:07Z", "exec_command", "/tmp/out.txt");
    add.run("t5", "2026-01-01T00:00:08Z", "Bash", "/tmp/work/main.go");
    add.run("t6", "2026-01-01T00:00:09Z", "Edit", "/tmp/notes.md");
    expect(analyzeFiles(mem, SESSION).top).toEqual([
      { path: "/w/a.ts", tool: "Edit", count: 2 },
      { path: "/tmp/notes.md", tool: "Edit", count: 1 },
      { path: "/tmp/work/main.go", tool: "Bash", count: 1 },
      { path: "/w/a.ts", tool: "Bash", count: 1 },
      { path: "/w/a.ts", tool: "exec_command", count: 1 },
      { path: "/w/b.ts", tool: "Bash", count: 1 },
      { path: "/w/c.ts", tool: "exec_command", count: 1 },
    ]);
    mem.close();
  });
});
