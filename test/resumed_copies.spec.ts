import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyzeFiles } from "../src/analyzer/files.js";
import type { Scope } from "../src/analyzer/scope.js";
import { analyzeTools } from "../src/analyzer/tools.js";
import { runIndex } from "../src/indexer/driver.js";
import { recentUserText } from "../src/mcp/recent.js";
import { searchUserText } from "../src/mcp/search.js";

// A conversation resumed into a new session starts with the earlier session's
// lines, copied with their uuids under the new sessionId. Counted over more
// than one session, each copied line counts once; a session on its own keeps
// what its transcript holds.

let root: string;
let db: Database.Database;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "clens-resumed-"));
  const claude = join(root, ".claude");
  const clens = join(root, ".clens");
  mkdirSync(join(claude, "projects", "-repo"), { recursive: true });
  mkdirSync(join(root, ".codex"), { recursive: true });
  mkdirSync(clens, { recursive: true });

  const earlier = (sessionId: string) => [
    { uuid: "a1", sessionId, type: "user", timestamp: "2026-07-01T00:00:01Z", message: { role: "user", content: "fix the flaky retry" } },
    { uuid: "a2", sessionId, type: "assistant", timestamp: "2026-07-01T00:00:02Z", message: { role: "assistant", model: "claude-x", content: [{ type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/repo/retry.ts", old_string: "a", new_string: "b" } }] } },
    { uuid: "a3", sessionId, type: "user", timestamp: "2026-07-01T00:00:03Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } },
    { uuid: "a4", sessionId, type: "assistant", timestamp: "2026-07-01T00:00:04Z", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "the retry waits now" }] } },
  ];
  const own = [
    { uuid: "b1", sessionId: "resumed", type: "user", timestamp: "2026-07-02T00:00:01Z", message: { role: "user", content: "now run the tests" } },
    { uuid: "b2", sessionId: "resumed", type: "assistant", timestamp: "2026-07-02T00:00:02Z", message: { role: "assistant", model: "claude-x", content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "npm test" } }] } },
    { uuid: "b3", sessionId: "resumed", type: "user", timestamp: "2026-07-02T00:00:03Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "passed" }] } },
  ];
  const write = (id: string, lines: object[]) =>
    writeFileSync(join(claude, "projects", "-repo", `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  write("first", earlier("first"));
  write("resumed", [...earlier("resumed"), ...own]);

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

describe("rows copied into a resumed session", () => {
  it("are stored in both sessions", () => {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM tool_call WHERE call_id = 'toolu_1'").get() as { n: number }).n;
    expect(n).toBe(2);
  });

  it("count once in project, global and since scopes", () => {
    for (const scope of [project, global, since]) {
      expect(analyzeTools(db, scope).counts).toEqual({ Bash: 1, Edit: 1 });
      expect(analyzeFiles(db, scope).top).toEqual([{ path: "/repo/retry.ts", tool: "Edit", count: 1 }]);
    }
  });

  it("stay in each session's own counts", () => {
    expect(analyzeTools(db, session("first")).counts).toEqual({ Edit: 1 });
    expect(analyzeTools(db, session("resumed")).counts).toEqual({ Bash: 1, Edit: 1 });
  });

  it("are found once by search", () => {
    expect(searchUserText(db, { query: "flaky retry" })).toHaveLength(1);
    expect(searchUserText(db, { query: "retry waits", role: "assistant" })).toHaveLength(1);
  });

  it("are listed once by recent", () => {
    const listed = recentUserText(db, { project_id: "-repo", since: "2026-06-01T00:00:00Z" });
    expect(listed.map((r) => r.text)).toEqual(["now run the tests", "fix the flaky retry"]);
    expect(recentUserText(db, { project_id: "-repo", query: "flaky" })).toHaveLength(1);
  });
});
