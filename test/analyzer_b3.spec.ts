import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runIndex } from "../src/indexer/driver.js";
import { analyzeAgents } from "../src/analyzer/agents.js";
import { analyzeHealth } from "../src/analyzer/health.js";
import type { Scope } from "../src/analyzer/scope.js";

const FIXTURE = join(process.cwd(), "test/fixtures/brainstorm-session.jsonl");

function setupFakeHome() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "clens-b3-"));
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

describe("Phase B.3 analyzers (D8/D9) on fixture", () => {
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

  it("D8 agents: fixture has 5 Agent tool_use rows total", () => {
    const r = analyzeAgents(db, SESSION);
    expect(r.agent_calls_total).toBe(5);
    expect(r.by_type.length).toBeGreaterThan(0);
    expect(r.by_type.reduce((acc, b) => acc + b.count, 0)).toBe(5);
  });

  it("D8 agents: by_type sorted desc by count", () => {
    const r = analyzeAgents(db, SESSION);
    for (let i = 1; i < r.by_type.length; i++) {
      expect(r.by_type[i]!.count <= r.by_type[i - 1]!.count).toBe(true);
    }
  });

  it("D8 agents: default_rate in [0,1]", () => {
    const r = analyzeAgents(db, SESSION);
    expect(r.default_rate).toBeGreaterThanOrEqual(0);
    expect(r.default_rate).toBeLessThanOrEqual(1);
  });

  it("D9 health: tool_errors is a non-negative int", () => {
    const r = analyzeHealth(db, SESSION);
    expect(r.tool_errors).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(r.tool_errors)).toBe(true);
  });

  it("D9 health: compaction_events ≥ 0", () => {
    const r = analyzeHealth(db, SESSION);
    expect(r.compaction_events).toBeGreaterThanOrEqual(0);
  });

  it("D9 health: context_bloat_ratio is null OR ≥ 1.0", () => {
    const r = analyzeHealth(db, SESSION);
    if (r.context_bloat_ratio !== null) {
      // max / median is always ≥ 1
      expect(r.context_bloat_ratio).toBeGreaterThanOrEqual(1);
    }
  });
});
