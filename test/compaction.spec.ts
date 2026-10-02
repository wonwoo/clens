import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyzeHealth } from "../src/analyzer/health.js";
import { runIndex } from "../src/indexer/driver.js";

// A Claude Code compaction leaves a `compact_boundary` system line (then the
// summary as a user message); a Codex one leaves a top-level `compacted` item.
// Each counts once in clens_stats' health section.

let root: string;
let db: Database.Database;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "clens-compaction-"));
  const claude = join(root, ".claude");
  const codex = join(root, ".codex");
  const clens = join(root, ".clens");
  mkdirSync(join(claude, "projects", "-repo"), { recursive: true });
  mkdirSync(join(codex, "sessions", "2026", "07", "02"), { recursive: true });
  mkdirSync(clens, { recursive: true });

  const S = "claude-sess";
  const claudeLines = [
    { uuid: "c1", sessionId: S, type: "user", timestamp: "2026-07-01T00:00:01Z", message: { role: "user", content: "hello" } },
    { uuid: "c2", sessionId: S, type: "assistant", timestamp: "2026-07-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    // The phrase the old reminder rule looked for; not a compaction.
    { uuid: "c3", sessionId: S, type: "user", timestamp: "2026-07-01T00:00:03Z", message: { role: "user", content: "<system-reminder>The context was compacted earlier.</system-reminder> go on" } },
    { uuid: "c4", sessionId: S, type: "system", subtype: "compact_boundary", timestamp: "2026-07-01T00:00:04Z", content: "Conversation compacted", compactMetadata: { trigger: "manual", preTokens: 1000 } },
    { uuid: "c5", sessionId: S, type: "user", isCompactSummary: true, timestamp: "2026-07-01T00:00:05Z", message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." } },
    { uuid: "c6", sessionId: S, type: "assistant", timestamp: "2026-07-01T00:00:06Z", message: { role: "assistant", content: [{ type: "text", text: "continuing" }] } },
    { uuid: "c7", sessionId: S, type: "system", subtype: "compact_boundary", timestamp: "2026-07-01T00:00:07Z", content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 2000 } },
  ];
  writeFileSync(join(claude, "projects", "-repo", `${S}.jsonl`), claudeLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const codexLines = [
    { timestamp: "2026-07-02T00:00:00Z", type: "session_meta", payload: { id: "codex-sess", cwd: "/repo", cli_version: "0.155.1" } },
    { timestamp: "2026-07-02T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "hello" } },
    { timestamp: "2026-07-02T00:00:02Z", type: "compacted", payload: { message: "", replacement_history: [] } },
    { timestamp: "2026-07-02T00:00:03Z", type: "event_msg", payload: { type: "user_message", message: "go on" } },
    { timestamp: "2026-07-02T00:00:04Z", type: "compacted", payload: { message: "", replacement_history: [] } },
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
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env.CLENS_HOME;
  delete process.env.CLENS_CODEX_HOME;
  delete process.env.CLENS_INDEX_DIR;
});

const session = (session_id: string) => ({ mode: "session" as const, params: { session_id } });

describe("health — compaction_events", () => {
  it("counts each Claude Code compact_boundary once, and keeps its trigger", () => {
    expect(analyzeHealth(db, session("claude-sess")).compaction_events).toBe(2);
    const triggers = db
      .prepare("SELECT text_excerpt FROM system_reminder WHERE session_id = 'claude-sess' AND category = 'compaction' ORDER BY ts")
      .all()
      .map((r) => (r as { text_excerpt: string | null }).text_excerpt);
    expect(triggers).toEqual(["manual", "auto"]);
  });

  it("counts each Codex compacted item once", () => {
    expect(analyzeHealth(db, session("codex-sess")).compaction_events).toBe(2);
  });
});

describe("health — compactions of a session whose transcript is gone", () => {
  it("counts its summary messages where it has no compaction row", async () => {
    const { applySchema } = await import("../src/indexer/schema.js");
    const mem = new Database(":memory:");
    applySchema(mem);
    mem.exec("INSERT INTO session (id, project_id, kind) VALUES ('gone', 'p', 'interactive'), ('both', 'p', 'interactive')");
    const text = mem.prepare("INSERT INTO user_text (event_uuid, session_id, ts, text, is_command, role, type) VALUES (?, ?, ?, 'This session is being continued from a previous conversation.', 0, 'user', 'continuation_summary')");
    text.run("g1", "gone", "2026-06-01T00:00:01Z");
    text.run("g2", "gone", "2026-06-01T00:00:02Z");
    text.run("b1", "both", "2026-06-01T00:00:03Z");
    mem.prepare("INSERT INTO system_reminder (event_uuid, session_id, ts, category, text_excerpt) VALUES ('b0', 'both', '2026-06-01T00:00:03Z', 'compaction', 'auto')").run();
    expect(analyzeHealth(mem, session("gone")).compaction_events).toBe(2);
    expect(analyzeHealth(mem, session("both")).compaction_events).toBe(1);
    expect(analyzeHealth(mem, { mode: "project", params: { project_id: "p" } }).compaction_events).toBe(3);
    expect(analyzeHealth(mem, { mode: "global", params: {} }).compaction_events).toBe(3);
    mem.close();
  });
});
