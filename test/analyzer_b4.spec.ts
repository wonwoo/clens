import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runIndex } from "../src/indexer/driver.js";
import { analyzeSkills } from "../src/analyzer/skills.js";
import type { Scope } from "../src/analyzer/scope.js";

const FIXTURE = join(process.cwd(), "test/fixtures/brainstorm-session.jsonl");

function setupFakeHome() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "clens-b4-"));
  const claude = join(tmpRoot, ".claude");
  const clens = join(tmpRoot, ".clens");
  mkdirSync(join(claude, "projects", "p1"), { recursive: true });
  mkdirSync(clens, { recursive: true });
  copyFileSync(FIXTURE, join(claude, "projects", "p1", "test.jsonl"));
  process.env.CLENS_HOME = claude;
  process.env.CLENS_INDEX_DIR = clens;
  return { tmpRoot, claude, clens };
}

const GLOBAL: Scope = { mode: "global", params: {} };
const SESSION: Scope = { mode: "session", params: { session_id: "test" } };

describe("Phase B.4 analyzers (D10) on fixture", () => {
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

  it("D10 skills: by_name and slash_commands are separate arrays (NEVER summed)", () => {
    const r = analyzeSkills(db, SESSION);
    // Fixture has 0 Skill tool_use calls (confirmed in A.5 baseline).
    expect(r.by_name.length).toBe(0);
    // Slash commands may or may not be 0 depending on parser regex hits.
    expect(Array.isArray(r.slash_commands)).toBe(true);
  });

});

describe("D10 skills: synthetic events with Skill tool_use exercise the by_name path", () => {
  let env: ReturnType<typeof setupFakeHome>;
  let db: Database.Database;

  beforeAll(async () => {
    env = setupFakeHome();
    // Replace fixture with a synthetic 3-line file that has 2 Skill calls and 1 slash command.
    const path = join(env.claude, "projects", "p1", "test.jsonl");
    const evts = [
      {
        uuid: "u-asst-1",
        sessionId: "test",
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", id: "tu-1", name: "Skill", input: { skill: "code-review", args: "review the diff" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 },
        },
      },
      {
        uuid: "u-asst-2",
        sessionId: "test",
        type: "assistant",
        timestamp: "2026-01-01T00:01:00Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", id: "tu-2", name: "Skill", input: { skill: "fact-check", args: "verify x" } },
          ],
          usage: { input_tokens: 80, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
        },
      },
      {
        uuid: "u-user-1",
        sessionId: "test",
        type: "user",
        timestamp: "2026-01-01T00:02:00Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "<command-name>/run-tests</command-name> please" }],
        },
      },
    ];
    writeFileSync(path, evts.map((e) => JSON.stringify(e)).join("\n") + "\n");
    await runIndex({ rebuild: true });
    db = new Database(join(env.clens, "index.db"), { readonly: true });
  });

  afterAll(() => {
    db.close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
    delete process.env.CLENS_HOME;
    delete process.env.CLENS_INDEX_DIR;
  });

  it("by_name sums Skill tool_uses; slash_commands lists /run-tests separately", () => {
    const r = analyzeSkills(db, SESSION);
    expect(r.by_name.length).toBe(2);
    const codeReview = r.by_name.find((s) => s.name === "code-review");
    expect(codeReview?.count).toBe(1);
    expect(r.slash_commands.find((s) => s.name === "run-tests")?.count).toBe(1);
  });

});

describe("D10 skills: never sum different session.source rows for the same skill name", () => {
  let env: { tmpRoot: string; claude: string; clens: string };
  let db: Database.Database;

  beforeAll(async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "clens-b4-source-"));
    const claude = join(tmpRoot, ".claude");
    const codex = join(tmpRoot, ".codex");
    const clens = join(tmpRoot, ".clens");
    mkdirSync(join(claude, "projects", "p1"), { recursive: true });
    mkdirSync(join(codex, "sessions", "2026", "07", "02"), { recursive: true });
    mkdirSync(join(codex, "skills", "code-review"), { recursive: true });
    mkdirSync(clens, { recursive: true });

    // Claude side: one structured Skill tool_use for "code-review".
    const claudeEvts = [
      {
        uuid: "u-asst-1",
        sessionId: "claude-sess",
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", id: "tu-1", name: "Skill", input: { skill: "code-review", args: "review the diff" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 },
        },
      },
    ];
    writeFileSync(
      join(claude, "projects", "p1", "test.jsonl"),
      claudeEvts.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    // Codex side: two explicit "$code-review" markers in one user_message.
    const codexLines = [
      {
        timestamp: "2026-07-02T00:00:00Z",
        type: "session_meta",
        payload: { id: "codex-sess", cwd: "/repo", cli_version: "1.0.0" },
      },
      { timestamp: "2026-07-02T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "$code-review 리뷰해줘" } },
    ];
    writeFileSync(
      join(codex, "sessions", "2026", "07", "02", "rollout-2026-07-02-codex-sess.jsonl"),
      codexLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );

    process.env.CLENS_HOME = claude;
    process.env.CLENS_CODEX_HOME = codex;
    process.env.CLENS_INDEX_DIR = clens;
    await runIndex({ rebuild: true });
    db = new Database(join(clens, "index.db"), { readonly: true });
    env = { tmpRoot, claude, clens };
  });

  afterAll(() => {
    db.close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
    delete process.env.CLENS_HOME;
    delete process.env.CLENS_CODEX_HOME;
    delete process.env.CLENS_INDEX_DIR;
  });

  it("returns two distinct (skill, source) rows for the same skill name, not one summed row", () => {
    const r = analyzeSkills(db, GLOBAL);
    const rows = r.by_name.filter((s) => s.name === "code-review");
    expect(rows.length).toBe(2);
    const bySource = Object.fromEntries(rows.map((s) => [s.source, s.count]));
    expect(bySource).toEqual({ claude: 1, codex: 1 });
  });
});

describe("mixed-source project: claude and codex sessions share one project_id", () => {
  let env: { tmpRoot: string; clens: string };
  let db: Database.Database;

  beforeAll(async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "clens-b4-projsrc-"));
    const claude = join(tmpRoot, ".claude");
    const codex = join(tmpRoot, ".codex");
    const clens = join(tmpRoot, ".clens");
    // Claude project dir slug "-repo" and a codex session with cwd "/repo"
    // both derive project_id "-repo", so the two sources collide on one project.
    mkdirSync(join(claude, "projects", "-repo"), { recursive: true });
    mkdirSync(join(codex, "sessions", "2026", "07", "02"), { recursive: true });
    mkdirSync(clens, { recursive: true });

    const claudeEvts = [
      {
        uuid: "u-asst-1",
        sessionId: "claude-sess",
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ];
    writeFileSync(
      join(claude, "projects", "-repo", "test.jsonl"),
      claudeEvts.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const codexLines = [
      { timestamp: "2026-07-02T00:00:00Z", type: "session_meta", payload: { id: "codex-sess", cwd: "/repo", cli_version: "1.0.0" } },
      { timestamp: "2026-07-02T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "hello" } },
    ];
    writeFileSync(
      join(codex, "sessions", "2026", "07", "02", "rollout-2026-07-02-codex-sess.jsonl"),
      codexLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );

    process.env.CLENS_HOME = claude;
    process.env.CLENS_CODEX_HOME = codex;
    process.env.CLENS_INDEX_DIR = clens;
    await runIndex({ rebuild: true });
    db = new Database(join(clens, "index.db"), { readonly: true });
    env = { tmpRoot, clens };
  });

  afterAll(() => {
    db.close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
    delete process.env.CLENS_HOME;
    delete process.env.CLENS_CODEX_HOME;
    delete process.env.CLENS_INDEX_DIR;
  });

  it("both sources land under project_id -repo, one session each", () => {
    const rows = db
      .prepare("SELECT source, COUNT(*) AS n FROM session WHERE project_id = '-repo' GROUP BY source")
      .all() as Array<{ source: string; n: number }>;
    expect(Object.fromEntries(rows.map((r) => [r.source, r.n]))).toEqual({ claude: 1, codex: 1 });
  });
});
