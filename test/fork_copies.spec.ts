import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyzeAgents } from "../src/analyzer/agents.js";
import type { Scope } from "../src/analyzer/scope.js";
import { analyzeTools } from "../src/analyzer/tools.js";
import { runIndex } from "../src/indexer/driver.js";

// A fork subagent's transcript starts with the `Agent` call that started it,
// copied from its parent under a new uuid but with the same call id. Counted
// over more than one session, that call counts once, also when the parent was
// resumed into another session that copied the call with its uuid; a session
// on its own keeps what its transcript holds.

let root: string;
let db: Database.Database;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "clens-fork-"));
  const claude = join(root, ".claude");
  const clens = join(root, ".clens");
  mkdirSync(join(claude, "projects", "-repo", "parent", "subagents"), { recursive: true });
  mkdirSync(join(root, ".codex"), { recursive: true });
  mkdirSync(clens, { recursive: true });

  const agentCall = { type: "tool_use", id: "toolu_f", name: "Agent", input: { subagent_type: "fork", description: "write the plan", prompt: "You are the fork." } };
  const parent = (sessionId: string) => [
    { uuid: "p1", sessionId, type: "user", timestamp: "2026-07-01T00:00:01Z", message: { role: "user", content: "plan it in a fork" } },
    { uuid: "p2", sessionId, type: "assistant", timestamp: "2026-07-01T00:00:02Z", message: { role: "assistant", model: "claude-x", content: [agentCall] } },
    { uuid: "p3", sessionId, type: "user", timestamp: "2026-07-01T00:00:03Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_f", content: "launched" }] } },
  ];
  const sidechain = { sessionId: "parent", isSidechain: true, agentId: "f1" };
  const fork = [
    { type: "fork-context-ref", agentId: "f1", parentSessionId: "parent", parentLastUuid: "p1", contextLength: 1 },
    { ...sidechain, uuid: "c2", parentUuid: null, type: "assistant", timestamp: "2026-07-01T00:00:02Z", message: { role: "assistant", model: "claude-x", content: [agentCall] } },
    { ...sidechain, uuid: "c3", parentUuid: "c2", type: "user", timestamp: "2026-07-01T00:00:04Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_f", content: "You are the fork." }] } },
    { ...sidechain, uuid: "c4", parentUuid: "c3", type: "assistant", timestamp: "2026-07-01T00:00:05Z", message: { role: "assistant", model: "claude-x", content: [{ type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "ls" } }] } },
    { ...sidechain, uuid: "c5", parentUuid: "c4", type: "user", timestamp: "2026-07-01T00:00:06Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_b", content: "plan.md" }] } },
  ];
  const write = (path: string, lines: object[]) =>
    writeFileSync(join(claude, "projects", "-repo", path), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  write("parent.jsonl", parent("parent"));
  write("resumed.jsonl", parent("resumed"));
  write("parent/subagents/agent-f1.jsonl", fork);

  process.env.CLENS_HOME = claude;
  process.env.CLENS_CODEX_HOME = join(root, ".codex");
  process.env.CLENS_INDEX_DIR = clens;
  await runIndex({ rebuild: true });
  db = new Database(join(clens, "index.db"), { readonly: true });
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env.CLENS_HOME;
  delete process.env.CLENS_CODEX_HOME;
  delete process.env.CLENS_INDEX_DIR;
});

const project: Scope = { mode: "project", params: { project_id: "-repo" } };
const global: Scope = { mode: "global", params: {} };
const since: Scope = { mode: "since", params: { since: "2026-06-01T00:00:00Z" } };
const session = (session_id: string): Scope => ({ mode: "session", params: { session_id } });

describe("the Agent call a fork subagent copied", () => {
  it("is stored in the parent, the resumed session and the fork", () => {
    const rows = db
      .prepare("SELECT session_id, event_uuid FROM tool_call WHERE call_id = 'toolu_f' ORDER BY session_id")
      .all();
    expect(rows).toEqual([
      { session_id: "agent-f1", event_uuid: "c2" },
      { session_id: "parent", event_uuid: "p2" },
      { session_id: "resumed", event_uuid: "p2" },
    ]);
  });

  it("counts once in project, global and since scopes", () => {
    for (const scope of [project, global, since]) {
      expect(analyzeTools(db, scope).counts).toEqual({ Agent: 1, Bash: 1 });
      const agents = analyzeAgents(db, scope);
      expect(agents.agent_calls_total).toBe(1);
      expect(agents.by_type).toEqual([{ type: "fork", count: 1 }]);
    }
  });

  it("stays in each session's own counts", () => {
    expect(analyzeTools(db, session("parent")).counts).toEqual({ Agent: 1 });
    expect(analyzeTools(db, session("agent-f1")).counts).toEqual({ Agent: 1, Bash: 1 });
    expect(analyzeAgents(db, session("agent-f1")).agent_calls_total).toBe(1);
  });
});
