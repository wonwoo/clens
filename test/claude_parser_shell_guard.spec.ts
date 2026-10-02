import { describe, expect, it, vi } from "vitest";

// A command the shell reader cannot handle must cost only its own file list.
vi.mock("../src/indexer/shell_writes.js", () => ({
  shellWrittenFiles: () => {
    throw new RangeError("Maximum call stack size exceeded");
  },
}));

const { parseFileBody } = await import("../src/indexer/claude_parser.js");

describe("a shell reader error while parsing", () => {
  it("keeps the event and its other rows, and counts the error as an anomaly", () => {
    const line = JSON.stringify({
      uuid: "g1",
      sessionId: "s",
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: "/w",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "echo x > out.txt" } },
          { type: "tool_use", id: "tu-2", name: "Edit", input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" } },
        ],
      },
    });
    const batch = { counters: new Map(), session_id: null, ts: new Date(0).toISOString(), source_file: null };
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.tool_calls.map((t) => t.name)).toEqual(["Bash", "Edit"]);
    expect(r.events[0]!.file_ops.map((f) => [f.tool, f.path])).toEqual([["Edit", "/w/a.ts"]]);
    expect([...batch.counters.keys()].some((k) => k.includes("shell_writes_error"))).toBe(true);
  });
});
