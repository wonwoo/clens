import { describe, expect, it, vi } from "vitest";

// A command the shell reader cannot handle must cost only its own file list.
vi.mock("../src/indexer/shell_writes.js", () => ({
  shellWrittenFiles: () => {
    throw new RangeError("Maximum call stack size exceeded");
  },
}));

const { parseCodexFileBody } = await import("../src/indexer/codex_parser.js");

describe("a shell reader error while parsing a Codex rollout", () => {
  it("keeps the exec_command call, drops only its files, and counts the error as an anomaly", () => {
    const body = [
      { timestamp: "2026-09-01T00:00:00Z", type: "session_meta", payload: { id: "s", cwd: "/w" } },
      {
        timestamp: "2026-09-01T00:00:01Z",
        type: "response_item",
        payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "echo hi > a.txt" }) },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const batch = { counters: new Map(), session_id: null, ts: new Date(0).toISOString(), source_file: "x" };
    const r = parseCodexFileBody({ body, source_file: "x", batch });
    expect(r.events.flatMap((e) => e.tool_calls).map((t) => t.name)).toEqual(["exec_command"]);
    expect(r.events.flatMap((e) => e.file_ops)).toEqual([]);
    expect(batch.counters.get("shell_writes_error")?.count).toBe(1);
  });
});
