import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import { SOURCE_ADAPTERS, getSourceAdapter } from "../src/indexer/sources.js";
import type { AnomalyBatch } from "../src/indexer/types.js";

function freshBatch(): AnomalyBatch {
  return {
    counters: new Map(),
    session_id: null,
    ts: new Date(0).toISOString(),
    source_file: null,
  };
}

afterEach(() => {
  delete process.env.CLENS_HOME;
  delete process.env.CLENS_CODEX_HOME;
});

const claudeAdapter = getSourceAdapter("claude");
const codexAdapter = getSourceAdapter("codex");

describe("getSourceAdapter", () => {
  it("resolves the claude adapter by name", () => {
    expect(claudeAdapter.name).toBe("claude");
  });

  it("resolves the codex adapter by name", () => {
    expect(codexAdapter.name).toBe("codex");
  });

  it("throws for an unregistered source name", () => {
    expect(() => getSourceAdapter("cursor")).toThrow(/cursor/);
  });
});

describe("SOURCE_ADAPTERS registry", () => {
  it("registers exactly claude and codex today", () => {
    expect(SOURCE_ADAPTERS.map((a) => a.name).sort()).toEqual(["claude", "codex"]);
  });
});

describe("adapter sessionsDir", () => {
  it("claudeAdapter.sessionsDir() resolves under CLENS_HOME/projects", () => {
    process.env.CLENS_HOME = "/tmp/fake-home";
    expect(claudeAdapter.sessionsDir()).toBe(join("/tmp/fake-home", "projects"));
  });

  it("codexAdapter.sessionsDir() resolves under CLENS_CODEX_HOME/sessions", () => {
    process.env.CLENS_CODEX_HOME = "/tmp/fake-codex-home";
    expect(codexAdapter.sessionsDir()).toBe(join("/tmp/fake-codex-home", "sessions"));
  });
});

describe("adapter deriveProjectId", () => {
  it("codexAdapter derives project_id from cwd via slash-to-dash", () => {
    expect(codexAdapter.deriveProjectId!("any/path.jsonl", "/Users/x/proj")).toBe(
      "-Users-x-proj",
    );
  });

  // Claude Code names a project's directory by turning every character
  // other than a letter or digit into a dash, and cuts a name over 200
  // characters to 200 plus a dash and a hash of the path (Claude Code
  // 2.1.322). A Codex session in the same directory must get the same id.
  it("codexAdapter derives the project id Claude Code gives the same directory", () => {
    const ids = ["/Users/x/.claude/mascot", "/Users/x/Documents/New project", "/w/" + "a".repeat(250) + "/b.c"].map((cwd) =>
      codexAdapter.deriveProjectId!("any/path.jsonl", cwd),
    );
    expect(ids, "Codex project ids of /Users/x/.claude/mascot, a path with a space, a 257-character path").toEqual([
      "-Users-x--claude-mascot",
      "-Users-x-Documents-New-project",
      "-w-" + "a".repeat(197) + "-nio7yp",
    ]);
  });

  it("codexAdapter returns null when cwd is unavailable, signalling fallback", () => {
    expect(codexAdapter.deriveProjectId!("any/path.jsonl", null)).toBeNull();
  });

  it("claudeAdapter uses the path-based default, except for a subagent transcript under its parent's directory", () => {
    expect(claudeAdapter.deriveProjectId!("/h/.claude/projects/-w-app/s1.jsonl", "/w/app")).toBeNull();
    expect(claudeAdapter.deriveProjectId!("/h/.claude/projects/-w-app/s1/subagents/agent-x.jsonl", "/w/app")).toBe("-w-app");
    expect(claudeAdapter.deriveProjectId!("/h/.claude/projects/-w-app/s1/subagents/workflows/wf_1/agent-y.jsonl", null)).toBe("-w-app");
  });
});

describe("adapter parse delegation", () => {
  it("claudeAdapter.parse extracts user_text from a Claude-shaped line", () => {
    const line = JSON.stringify({
      uuid: "u-1",
      sessionId: "s-1",
      type: "user",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "hello from claude" },
    });
    const result = claudeAdapter.parse({ body: line + "\n", source_file: "x", batch: freshBatch() });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.user_texts[0]!.text).toBe("hello from claude");
  });

  it("codexAdapter.parse extracts user_text from a Codex-shaped line", () => {
    const line = JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      type: "event_msg",
      payload: { type: "user_message", message: "hello from codex" },
    });
    const result = codexAdapter.parse({ body: line + "\n", source_file: "x", batch: freshBatch() });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.user_texts[0]!.text).toBe("hello from codex");
  });

  it("adapters are not swapped: claudeAdapter.parse does not understand Codex event_msg lines", () => {
    const line = JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      type: "event_msg",
      payload: { type: "user_message", message: "hello from codex" },
    });
    const result = claudeAdapter.parse({ body: line + "\n", source_file: "x", batch: freshBatch() });
    // Claude's parser requires a top-level `uuid`; a Codex-shaped line has none,
    // so it must be skipped as a non-event line, not silently misparsed.
    expect(result.events).toHaveLength(0);
    expect(result.anomalies.counters.get("non_event_line")?.count).toBe(1);
  });
});

