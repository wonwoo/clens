import { describe, expect, it } from "vitest";

import { parseCodexFileBody } from "../src/indexer/codex_parser.js";
import type { AnomalyBatch } from "../src/indexer/types.js";

function freshBatch(): AnomalyBatch {
  return {
    counters: new Map(),
    session_id: null,
    ts: new Date(0).toISOString(),
    source_file: "codex-test.jsonl",
  };
}

describe("parseCodexFileBody", () => {
  it("parses response_item function_call/function_call_output into tool_call + tool_results", () => {
    const body = [
      {
        timestamp: "2026-07-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "sess-1", cwd: "/repo", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-07-01T00:00:01Z",
        type: "turn_context",
        payload: { model: "gpt-5", cwd: "/repo" },
      },
      {
        timestamp: "2026-07-01T00:00:02Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call-1",
          name: "exec_command",
          arguments: "{\"cmd\":\"pwd\"}",
        },
      },
      {
        timestamp: "2026-07-01T00:00:03Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "ok",
        },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";

    const result = parseCodexFileBody({
      body,
      source_file: "codex-test.jsonl",
      batch: freshBatch(),
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.tool_calls).toHaveLength(1);
    expect(result.events[0]!.tool_calls[0]).toMatchObject({
      call_id: "call-1",
      name: "exec_command",
      input_json: "{\"cmd\":\"pwd\"}",
    });
    expect(result.tool_results.get("call-1")).toEqual({
      ts: "2026-07-01T00:00:03Z",
      is_error: 0,
      result_chars: 2,
      error_excerpt: null,
    });
  });

  it("stores on each tool call the branch the rollout's session_meta names, and null when it names none", () => {
    const rollout = (git?: Record<string, unknown>) => [
      { timestamp: "2026-07-01T00:00:00Z", type: "session_meta", payload: { id: "sess-b", cwd: "/repo", ...(git ? { git } : {}) } },
      {
        timestamp: "2026-07-01T00:00:01Z",
        type: "response_item",
        payload: { type: "function_call", call_id: "call-b", name: "exec_command", arguments: "{\"cmd\":\"npm test\"}" },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const branches = (body: string) => parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch: freshBatch() })
      .events.flatMap((e) => e.tool_calls).map((t) => [t.name, t.git_branch]);
    expect(branches(rollout({ branch: "feature/y", commit_hash: "abc" }))).toEqual([["exec_command", "feature/y"]]);
    expect(branches(rollout())).toEqual([["exec_command", null]]);
  });

  it("parses response_item custom_tool_call/custom_tool_call_output (freeform tools such as apply_patch)", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch\n";
    const body = [
      { timestamp: "2026-07-01T00:00:00Z", type: "session_meta", payload: { id: "sess-c", cwd: "/repo", cli_version: "1.0.0" } },
      {
        timestamp: "2026-07-01T00:00:02Z",
        type: "response_item",
        payload: { type: "custom_tool_call", status: "completed", call_id: "call-p", name: "apply_patch", input: patch },
      },
      {
        timestamp: "2026-07-01T00:00:03Z",
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "call-p", output: "{\"output\":\"Success.\"}" },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";

    const result = parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch: freshBatch() });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.tool_calls[0]).toMatchObject({ call_id: "call-p", name: "apply_patch", input_json: patch });
    expect(result.tool_results.get("call-p")).toEqual({ ts: "2026-07-01T00:00:03Z", is_error: 0, result_chars: 21, error_excerpt: null });
  });

  it("derives file_op rows from response_item arguments for file tools", () => {
    const body = [
      {
        timestamp: "2026-07-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "sess-2", cwd: "/repo", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-07-01T00:00:01Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call-2",
          name: "Edit",
          arguments: "{\"file_path\":\"/tmp/app.ts\",\"old_string\":\"a\",\"new_string\":\"b\"}",
        },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";

    const result = parseCodexFileBody({
      body,
      source_file: "codex-test.jsonl",
      batch: freshBatch(),
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.file_ops).toEqual([
      {
        event_uuid: "codex:codex-test.jsonl:2",
        session_id: "sess-2",
        ts: "2026-07-01T00:00:01Z",
        tool: "Edit",
        path: "/tmp/app.ts",
      },
    ]);
  });

  it("marks mcp_tool_call_end with nested Ok.isError as a tool error", () => {
    const body = [
      {
        timestamp: "2026-07-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "sess-3", cwd: "/repo", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-07-01T00:00:01Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call-3",
          name: "codegraph_explore",
          arguments: "{\"query\":\"x\"}",
        },
      },
      {
        timestamp: "2026-07-01T00:00:02Z",
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "call-3",
          invocation: { server: "codegraph", tool: "codegraph_explore", arguments: { query: "x" } },
          result: {
            Ok: {
              content: [{ type: "text", text: "Error: workspace missing" }],
              isError: true,
            },
          },
        },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";

    const result = parseCodexFileBody({
      body,
      source_file: "codex-test.jsonl",
      batch: freshBatch(),
    });

    expect(result.tool_results.get("call-3")).toEqual({
      ts: "2026-07-01T00:00:02Z",
      is_error: 1,
      result_chars: null,
      error_excerpt: null,
    });
  });

  it("extracts every $name candidate from a user_message unconditionally (no validation here)", () => {
    const body = [
      {
        timestamp: "2026-07-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "sess-4", cwd: "/repo", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-07-01T00:00:01Z",
        type: "event_msg",
        payload: { type: "user_message", message: "$code-review 리뷰해줘, echo $HOME 이거 봐바" },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";

    const result = parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch: freshBatch() });

    expect(result.events).toHaveLength(1);
    const names = result.events[0]!.skill_calls.map((sc) => sc.skill).sort();
    // Both a real-looking name and an obvious false positive (a shell env
    // var, not a skill) are extracted — filtering against installed skills
    // happens downstream in the driver, not in the parser.
    expect(names).toEqual(["HOME", "code-review"]);
  });

  it("does not extract a digit-led candidate like $100 or $1 (shell positional args / money, never a skill name)", () => {
    const body = [
      {
        timestamp: "2026-07-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "sess-7", cwd: "/repo", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-07-01T00:00:01Z",
        type: "event_msg",
        payload: { type: "user_message", message: "예산은 $100, 인자는 $1로 받자" },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";

    const result = parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch: freshBatch() });

    expect(result.events[0]!.skill_calls).toEqual([]);
  });

  it("does not duplicate a candidate mentioned twice in the same message", () => {
    const body = [
      {
        timestamp: "2026-07-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "sess-5", cwd: "/repo", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-07-01T00:00:01Z",
        type: "event_msg",
        payload: { type: "user_message", message: "$fact-check 다시 $fact-check 해바" },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";

    const result = parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch: freshBatch() });

    expect(result.events[0]!.skill_calls.map((sc) => sc.skill)).toEqual(["fact-check"]);
  });

  it("produces no skill_calls for a user_message with no $ markers", () => {
    const body = [
      {
        timestamp: "2026-07-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "sess-6", cwd: "/repo", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-07-01T00:00:01Z",
        type: "event_msg",
        payload: { type: "user_message", message: "그냥 평범한 메시지" },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";

    const result = parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch: freshBatch() });

    expect(result.events[0]!.skill_calls).toEqual([]);
  });

  /**
   * Regression: a turn with multiple tool round-trips emits one token_count
   * event per round-trip. input_tokens/cached_input_tokens are running
   * snapshots of the turn's context so far (each later one already includes
   * everything the earlier ones counted) — summing them across N round-trips
   * inflated a turn's recorded context by ~Nx. output_tokens is genuinely
   * incremental per round-trip, so summing is correct there.
   */
  it("takes the latest input/cached_input token_count instead of summing across a turn's round-trips, but still sums output_tokens", () => {
    const body = [
      {
        timestamp: "2026-07-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "sess-7", cwd: "/repo", cli_version: "1.0.0" },
      },
      {
        timestamp: "2026-07-01T00:00:01Z",
        type: "turn_context",
        payload: { model: "gpt-5", cwd: "/repo" },
      },
      {
        timestamp: "2026-07-01T00:00:02Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t1" },
      },
      {
        timestamp: "2026-07-01T00:00:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 100000, cached_input_tokens: 99000, output_tokens: 50 } },
        },
      },
      {
        timestamp: "2026-07-01T00:00:04Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 335164, cached_input_tokens: 334720, output_tokens: 336 } },
        },
      },
      {
        timestamp: "2026-07-01T00:00:05Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t1", last_agent_message: "done" },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";

    const result = parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch: freshBatch() });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.event.in_tok).toBe(335164);
    expect(result.events[0]!.event.cache_r).toBe(334720);
    expect(result.events[0]!.event.out_tok).toBe(50 + 336);
  });
});

// Codex now records chat text only as event_msg::item_completed items
// (UserMessage / AgentMessage); every rollout file on disk is in this shape.
// The parser read only event_msg::user_message / agent_message, so it stored
// no Codex text at all, and each re-read of a file dropped what an earlier
// read had stored.
describe("parseCodexFileBody — item_completed chat items", () => {
  const item = (ts: string, it: object) => ({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "item_completed", thread_id: "sess-2", turn_id: "t1", item: it },
  });
  const body =
    [
      { timestamp: "2026-09-01T00:00:00Z", type: "session_meta", payload: { id: "sess-2", cwd: "/repo" } },
      item("2026-09-01T00:00:01Z", {
        type: "UserMessage",
        id: "item-1",
        content: [
          { type: "text", text: "리팩터링 해줘 $code-review", text_elements: [] },
          { type: "local_image", path: "/tmp/a.png" },
          { type: "text", text: "두 번째 문단" },
        ],
      }),
      item("2026-09-01T00:00:02Z", { type: "AgentMessage", id: "item-2", content: [{ type: "Text", text: "확인하겠습니다." }], phase: "commentary" }),
      item("2026-09-01T00:00:03Z", { type: "CommandExecution", id: "item-3", command: "ls" }),
      item("2026-09-01T00:00:04Z", { type: "AgentMessage", id: "item-4", content: [{ type: "Text", text: "끝났습니다." }], phase: "final_answer" }),
      item("2026-09-01T00:00:05Z", { type: "UserMessage", id: "item-5", content: [{ type: "image", url: "x" }] }),
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n";

  it("stores UserMessage and AgentMessage text with their roles, in order", () => {
    const r = parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch: freshBatch() });
    const rows = r.events.flatMap((e) => e.user_texts).map((u) => [u.role, u.type, u.text, u.session_id]);
    expect(rows).toEqual([
      ["user", "user_message", "리팩터링 해줘 $code-review\n두 번째 문단", "sess-2"],
      ["assistant", "assistant_message", "확인하겠습니다.", "sess-2"],
      ["assistant", "assistant_message", "끝났습니다.", "sess-2"],
    ]);
  });

  it("stores an AgentMessage up to 64 KB whole and keeps the start and end of a longer one", () => {
    const mid = "가".repeat(10000); // 30 KB
    const long = "A" + "나".repeat(30000) + "Z"; // 90 KB
    const b =
      [
        { timestamp: "2026-09-01T00:00:00Z", type: "session_meta", payload: { id: "sess-2", cwd: "/repo" } },
        item("2026-09-01T00:00:01Z", { type: "AgentMessage", id: "m1", content: [{ type: "Text", text: mid }], phase: "final_answer" }),
        item("2026-09-01T00:00:02Z", { type: "AgentMessage", id: "m2", content: [{ type: "Text", text: long }], phase: "final_answer" }),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n";
    const r = parseCodexFileBody({ body: b, source_file: "codex-test.jsonl", batch: freshBatch() });
    const [whole, cut] = r.events.flatMap((e) => e.user_texts).map((u) => u.text);
    expect(whole).toBe(mid);
    expect(Buffer.byteLength(cut!, "utf8")).toBeLessThanOrEqual(65536);
    expect(cut).toContain("…[truncated]…");
    expect(cut!.startsWith("A나")).toBe(true);
    expect(cut!.endsWith("나Z")).toBe(true);
  });

  it("marks the message events the way the legacy user_message / agent_message did", () => {
    const r = parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch: freshBatch() });
    const text = r.events.filter((e) => e.user_texts.length > 0).map((e) => [e.event.role, e.event.has_text]);
    expect(text).toEqual([["user", 1], ["assistant", 1], ["assistant", 1]]);
    expect(r.events.flatMap((e) => e.skill_calls).map((s) => s.skill)).toEqual(["code-review"]);
  });

  it("reads a pretty-printed rollout (each object over many lines) the same as JSONL", () => {
    const jsonl =
      body +
      JSON.stringify(item("2026-09-01T00:00:06Z", { type: "UserMessage", id: "item-6", content: [{ type: "text", text: 'a } { "b" \\ c\n{' }] })) +
      "\n";
    const pretty = jsonl.trim().split("\n").map((l) => JSON.stringify(JSON.parse(l), null, 2)).join("\n") + "\n";
    const batch = freshBatch();
    const r = parseCodexFileBody({ body: pretty, source_file: "codex-test.jsonl", batch });
    const flat = parseCodexFileBody({ body: jsonl, source_file: "codex-test.jsonl", batch: freshBatch() });
    expect(r.events.flatMap((e) => e.user_texts)).toEqual(flat.events.flatMap((e) => e.user_texts));
    expect(r.events.flatMap((e) => e.user_texts).at(-1)?.text).toBe('a } { "b" \\ c\n{');
    expect(batch.counters.has("json_parse_error")).toBe(false);
  });
});

describe("parseCodexFileBody — subagent rollouts", () => {
  // A subagent rollout starts with its own session_meta, then a copy of the
  // parent's history (the parent's session_meta included) up to
  // subagent_history_start_ordinal.
  const line = (ordinal: number, type: string, payload: object) =>
    JSON.stringify({ timestamp: `2026-09-15T00:00:${String(ordinal).padStart(2, "0")}Z`, ordinal, type, payload });
  const said = (ordinal: number, t: "UserMessage" | "AgentMessage", text: string) =>
    line(ordinal, "event_msg", { type: "item_completed", item: { type: t, id: `i${ordinal}`, content: [{ type: t === "UserMessage" ? "text" : "Text", text }] } });
  const body =
    [
      line(0, "session_meta", { id: "child", cwd: "/w", subagent_history_start_ordinal: 4, forked_from_id: "parent" }),
      line(1, "session_meta", { id: "parent", cwd: "/w" }),
      said(2, "UserMessage", "parent question (copy)"),
      said(3, "AgentMessage", "parent answer (copy)"),
      said(4, "UserMessage", "review this"),
      said(5, "AgentMessage", "reviewed"),
    ].join("\n") + "\n";

  it("keeps the file's own thread and skips the copied parent history", () => {
    const batch = freshBatch();
    const r = parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch });
    const rows = r.events.flatMap((e) => e.user_texts).map((u) => [u.session_id, u.text]);
    expect(rows).toEqual([
      ["child", "review this"],
      ["child", "reviewed"],
    ]);
    expect(batch.counters.get("copied_session_line_skipped")?.count).toBe(3);
  });

  it("does not take an older subagent rollout's start ordinal, which counts the parent's history, as the end of a copy", () => {
    const older =
      [
        line(0, "session_meta", { id: "child", cwd: "/w", subagent_history_start_ordinal: 131 }),
        said(1, "UserMessage", "review this"),
        said(2, "AgentMessage", "reviewed"),
      ].join("\n") + "\n";
    const batch = freshBatch();
    const r = parseCodexFileBody({ body: older, source_file: "codex-test.jsonl", batch });
    expect(r.events.flatMap((e) => e.user_texts).map((u) => [u.session_id, u.text])).toEqual([
      ["child", "review this"],
      ["child", "reviewed"],
    ]);
    expect(batch.counters.has("copied_session_line_skipped")).toBe(false);
  });

  it("skips the parent turns an older subagent rollout starts with, told by turn ids older than the thread", () => {
    // UUIDv7 ids: the first 12 hex digits are the creation time in ms.
    const meta = (source?: object) =>
      line(0, "session_meta", { id: "019d8062-d104-7402-b6e1-be4462b37d5d", cwd: "/w", subagent_history_start_ordinal: 131, source });
    const rest = [
      line(1, "event_msg", { type: "task_started", turn_id: "019d8061-6a2f-7d72-afce-986fbf5d2f9e" }),
      said(2, "UserMessage", "parent question (copy)"),
      said(3, "AgentMessage", "parent answer (copy)"),
      line(4, "event_msg", { type: "task_started", turn_id: "019d8062-d161-7321-b440-c49207e8443b" }),
      said(5, "UserMessage", "review this"),
      said(6, "AgentMessage", "reviewed"),
    ];
    const texts = (first: string, batch = freshBatch()) =>
      parseCodexFileBody({ body: [first, ...rest].join("\n") + "\n", source_file: "codex-test.jsonl", batch })
        .events.flatMap((e) => e.user_texts).map((u) => u.text);
    const batch = freshBatch();
    expect(texts(meta({ subagent: { thread_spawn: { parent_thread_id: "p" } } }), batch)).toEqual(["review this", "reviewed"]);
    expect(batch.counters.get("copied_session_line_skipped")?.count).toBe(3);
    // A thread nobody spawned keeps every line.
    expect(texts(meta("cli"))).toEqual(["parent question (copy)", "parent answer (copy)", "review this", "reviewed"]);
  });
});

describe("parseCodexFileBody — files a patch edits", () => {
  const call = (seq: number, name: string, input: string) =>
    JSON.stringify({ timestamp: `2026-09-01T00:00:0${seq}Z`, type: "response_item", payload: { type: "custom_tool_call", call_id: `c${seq}`, name, input } });

  it("records every header's file, relative ones under the session's cwd, including files past the stored-input cap", () => {
    const filler = "+" + "x".repeat(3000) + "\n";
    const patch =
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n" + filler +
      "*** Add File: /abs/new file.md\n+hi\n*** Delete File: ../other/old.ts\n" +
      "*** Update File: src/b.ts\n*** Move to: src/c.ts\n@@\n-x\n+y\n*** Update File: src/a.ts\n*** End Patch\n";
    const exec = 'await tools.apply_patch("*** Begin Patch\\n*** Update File: lib/d.ts\\n@@\\n-a\\n+b\\n*** End Patch\\n");';
    const body = [
      JSON.stringify({ timestamp: "2026-09-01T00:00:00Z", type: "session_meta", payload: { id: "sess-p", cwd: "/w/app" } }),
      call(1, "apply_patch", patch),
      call(2, "exec", exec),
      call(3, "exec", "const r = await tools.exec_command({ cmd: 'ls' });"),
    ].join("\n") + "\n";

    const r = parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch: freshBatch() });
    const ops = r.events.flatMap((e) => e.file_ops).map((f) => [f.tool, f.path]);
    expect(ops).toEqual([
      ["apply_patch", "/w/app/src/a.ts"],
      ["apply_patch", "/abs/new file.md"],
      ["apply_patch", "/w/other/old.ts"],
      ["apply_patch", "/w/app/src/b.ts"],
      ["apply_patch", "/w/app/src/c.ts"],
      ["apply_patch", "/w/app/lib/d.ts"],
    ]);
    expect(r.events[0]!.tool_calls[0]!.input_json!.length).toBeLessThan(patch.length);
  });
});

describe("parseCodexFileBody — how the session was started", () => {
  const kindOf = (meta: object) =>
    parseCodexFileBody({
      body: JSON.stringify({ timestamp: "2026-09-01T00:00:00Z", type: "session_meta", payload: { id: "s", cwd: "/w", ...meta } }) + "\n",
      source_file: "codex-test.jsonl",
      batch: freshBatch(),
    }).session_meta.kind;

  it("records subagent threads and one-shot exec runs, and nothing for the TUI or the editor", () => {
    expect(kindOf({ source: "cli", thread_source: "user" })).toBeUndefined();
    expect(kindOf({ source: "vscode" })).toBeUndefined();
    expect(kindOf({ source: "exec", originator: "codex_exec" })).toBe("exec");
    expect(kindOf({ source: { subagent: { thread_spawn: { parent_thread_id: "p" } } } })).toBe("subagent");
    expect(kindOf({ source: "cli", thread_source: "subagent" })).toBe("subagent");
  });
});

describe("parseCodexFileBody — shell commands", () => {
  const at = (seq: number) => `2026-09-01T00:00:${String(seq).padStart(2, "0")}Z`;
  const meta = (cwd: string) => JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id: "s-sh", cwd } });
  const fcall = (seq: number, callId: string, name: string, args: unknown) =>
    JSON.stringify({ timestamp: at(seq), type: "response_item", payload: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) } });
  const fout = (seq: number, callId: string, output: unknown) =>
    JSON.stringify({ timestamp: at(seq), type: "response_item", payload: { type: "function_call_output", call_id: callId, output } });
  const parse = (lines: string[], batch: AnomalyBatch = freshBatch()) =>
    parseCodexFileBody({ body: lines.join("\n") + "\n", source_file: "codex-test.jsonl", batch });

  it("records the files an exec_command call writes, relative to its workdir or else the session's cwd", () => {
    const r = parse([
      meta("/w/app"),
      fcall(1, "c1", "exec_command", { cmd: "cat > notes.md <<'EOF'\nhi\nEOF", workdir: "/w/app/docs" }),
      fcall(2, "c2", "exec_command", { cmd: "sed -i '' 's/a/b/' src/x.ts" }),
      fcall(3, "c3", "exec_command", { cmd: "ls -la" }),
    ]);
    expect(r.events.flatMap((e) => e.file_ops).map((f) => [f.tool, f.path])).toEqual([
      ["exec_command", "/w/app/docs/notes.md"],
      ["exec_command", "/w/app/src/x.ts"],
    ]);
  });

  it("marks a Codex tool call failed from its output, and counts the output's size", () => {
    const cases: [unknown, 0 | 1][] = [
      ["Chunk ID: a\nWall time: 0.1 seconds\nProcess exited with code 1\nOriginal token count: 3\nOutput:\nboom", 1],
      ["exec_command failed for `/bin/zsh -lc 'x'`: spawn error", 1],
      ["aborted by user after 1.2s", 1],
      ["Exit code: 1\nWall time: 0.2 seconds\nOutput:\nFailed", 1],
      ['{"output":"Failed to read file","metadata":{"exit_code":1,"duration_seconds":0.0}}', 1],
      ["apply_patch verification failed: Failed to find expected lines", 1],
      ["patch rejected by user", 1],
      ["Script failed\nWall time 0.1 seconds\nOutput:\n", 1],
      ["write_stdin failed: stdin is closed for this session", 1],
      ["Command blocked by PreToolUse hook: no pushes. Command: git push", 1],
      ["Chunk ID: a\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\nboom", 0],
      ["Chunk ID: b\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nProcess exited with code 1", 0],
      ["Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess.", 0],
      ['{"output":"Success.","metadata":{"exit_code":0}}', 0],
      ["Script completed\nWall time 0.0 seconds\nOutput:\n", 0],
      [[{ type: "input_text", text: "Wall time: 1 seconds\nOutput:" }, { type: "input_text", text: "ok" }], 0],
    ];
    const lines = [meta("/w/app")];
    cases.forEach(([output], i) => lines.push(fcall(2 * i + 1, `k${i}`, "exec_command", { cmd: "true" }), fout(2 * i + 2, `k${i}`, output)));
    const r = parse(lines);
    expect(cases.map((_, i) => r.tool_results.get(`k${i}`)?.is_error)).toEqual(cases.map(([, isError]) => isError));
    expect(r.tool_results.get(`k${cases.length - 1}`)?.result_chars).toBe(30);
    expect(r.tool_results.get("k2")?.result_chars).toBe([..."aborted by user after 1.2s"].length);
  });

  it("keeps a failed shell call's exit line and output in its error excerpt, not the rest of the header", () => {
    const trace = "Error: Cannot find package 'better-sqlite3'\n" + "    at ModuleLoader.resolve (node:internal/modules/esm/loader:708:38)\n".repeat(20);
    const r = parse([
      meta("/w/app"),
      fcall(1, "s1", "exec_command", { cmd: "node check.mjs" }),
      fout(2, "s1", `Chunk ID: a\nWall time: 0.1 seconds\nProcess exited with code 1\nOriginal token count: 900\nOutput:\n${trace}`),
      fcall(3, "s2", "exec_command", { cmd: "npm test" }),
      fout(4, "s2", "Exit code: 1\nWall time: 0.2 seconds\nOutput:\nFailed"),
      fcall(5, "s3", "apply_patch", {}),
      fout(6, "s3", "apply_patch verification failed: Failed to find expected lines"),
    ]);
    expect(r.tool_results.get("s1")?.error_excerpt?.startsWith("Process exited with code 1\nError: Cannot find package 'better-sqlite3'")).toBe(true);
    expect(r.tool_results.get("s2")?.error_excerpt).toBe("Exit code: 1\nFailed");
    expect(r.tool_results.get("s3")?.error_excerpt).toBe("apply_patch verification failed: Failed to find expected lines");
  });

  it("records the files exec code writes through tools.exec_command", () => {
    const code = 'const r = await tools.exec_command({cmd:"echo hi > out.txt", workdir:"/w/app/tmp"}); await tools.exec_command({cmd:"ls"});';
    const r = parse([
      meta("/w/app"),
      JSON.stringify({ timestamp: at(1), type: "response_item", payload: { type: "custom_tool_call", call_id: "x1", name: "exec", input: code } }),
    ]);
    expect(r.events.flatMap((e) => e.file_ops).map((f) => [f.tool, f.path])).toEqual([["exec_command", "/w/app/tmp/out.txt"]]);
  });

  it("stores shell tool inputs up to 64 KB and other tools' at 2 KB", () => {
    const long = "y".repeat(5000);
    const batch = freshBatch();
    const r = parse([
      meta("/w/app"),
      fcall(1, "c1", "exec_command", { cmd: `echo ${long}` }),
      JSON.stringify({ timestamp: at(2), type: "response_item", payload: { type: "custom_tool_call", call_id: "x1", name: "exec", input: `// ${long}` } }),
      JSON.stringify({ timestamp: at(3), type: "response_item", payload: { type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: `*** Begin Patch\n${long}` } }),
    ], batch);
    const stored = r.events.flatMap((e) => e.tool_calls).map((t) => Buffer.byteLength(t.input_json!, "utf8"));
    expect(stored).toEqual([JSON.stringify({ cmd: `echo ${long}` }).length, `// ${long}`.length, 2048]);
    expect(batch.counters.get("tool_input_truncated")?.count).toBe(1);
  });

  it("ignores an exec_command whose cmd is not a string", () => {
    const batch = freshBatch();
    const r = parse([meta("/w/app"), fcall(1, "c1", "exec_command", { cmd: 42 })], batch);
    expect(r.events.flatMap((e) => e.tool_calls).map((t) => t.name)).toEqual(["exec_command"]);
    expect(r.events.flatMap((e) => e.file_ops)).toEqual([]);
    expect(batch.counters.size).toBe(0);
  });
});

describe("parseCodexFileBody — hook blocks", () => {
  const at = (seq: number) => `2026-09-01T00:00:${String(seq).padStart(2, "0")}Z`;
  const meta = JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id: "s-hb", cwd: "/w/app" } });
  const fcall = (seq: number, callId: string, name: string, args: unknown) =>
    JSON.stringify({ timestamp: at(seq), type: "response_item", payload: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) } });
  const fout = (seq: number, callId: string, output: unknown) =>
    JSON.stringify({ timestamp: at(seq), type: "response_item", payload: { type: "function_call_output", call_id: callId, output } });
  const parse = (lines: string[]) =>
    parseCodexFileBody({ body: lines.join("\n") + "\n", source_file: "codex-test.jsonl", batch: freshBatch() });

  it("records a Stop hook's prompt as a hook block", () => {
    const prompt = JSON.stringify({
      timestamp: at(1),
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "HookPrompt", id: "h1", fragments: [{ text: "keep going until the tests pass", hookRunId: "stop:4:/Users/x/.codex/hooks.json" }] },
      },
    });
    const r = parse([meta, prompt]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.user_texts).toEqual([]);
    expect(r.events[0]!.hook_blocks).toEqual([{
      event_uuid: r.events[0]!.event.uuid,
      session_id: "s-hb",
      ts: at(1),
      hook_event: "Stop",
      tool: null,
      call_id: null,
      reason: "keep going until the tests pass",
    }]);
  });

  it("records a PreToolUse block from the blocked call's output", () => {
    const r = parse([
      meta,
      fcall(1, "c9", "exec_command", { cmd: "git push" }),
      fout(2, "c9", "Command blocked by PreToolUse hook: pushes need review. Command: git push"),
      fcall(3, "c10", "mcp__db__write", { sql: "x" }),
      fout(4, "c10", "Tool call blocked by PreToolUse hook: no MCP writes. Tool: mcp__db__write"),
    ]);
    const blocks = r.events.flatMap((e) => e.hook_blocks.map((b) => ({ ...b, on: e.tool_calls[0]?.call_id })));
    expect(blocks).toEqual([
      { event_uuid: r.events[0]!.event.uuid, session_id: "s-hb", ts: at(2), hook_event: "PreToolUse", tool: "exec_command", call_id: "c9", reason: "pushes need review", on: "c9" },
      { event_uuid: r.events[1]!.event.uuid, session_id: "s-hb", ts: at(4), hook_event: "PreToolUse", tool: "mcp__db__write", call_id: "c10", reason: "no MCP writes", on: "c10" },
    ]);
    expect(r.tool_results.get("c9")?.is_error).toBe(1);
    expect(r.tool_results.get("c10")?.is_error).toBe(1);
  });

  it("does not read hook-block wording inside a normal output", () => {
    const r = parse([
      meta,
      fcall(1, "c1", "exec_command", { cmd: "cat notes.txt" }),
      fout(2, "c1", "Chunk ID: a\nWall time: 0\nProcess exited with code 0\nOutput:\nCommand blocked by PreToolUse hook: x. Command: y"),
    ]);
    expect(r.events.flatMap((e) => e.hook_blocks)).toEqual([]);
    expect(r.tool_results.get("c1")?.is_error).toBe(0);
  });
});

describe("parseCodexFileBody — failures inside exec code", () => {
  const at = (seq: number) => `2026-09-01T00:00:${String(seq).padStart(2, "0")}Z`;
  const meta = JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id: "s-ex", cwd: "/w/app" } });
  const exec = JSON.stringify({
    timestamp: at(1),
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: "x1", name: "exec", input: 'await tools.exec_command({cmd:"ls /no/such/dir"})' },
  });
  const ran = (seq: number, command: unknown, exit_code: number) =>
    JSON.stringify({
      timestamp: at(seq),
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "CommandExecution", id: `exec-${seq}`, command, cwd: "file:///w/app", exit_code, status: exit_code === 0 ? "completed" : "failed" } },
    });
  const out = (seq: number) =>
    JSON.stringify({ timestamp: at(seq), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "x1", output: "Script completed\nWall time 0.3 seconds\nOutput:\n" } });
  const isError = (lines: string[]) =>
    parseCodexFileBody({ body: [meta, exec, ...lines].join("\n") + "\n", source_file: "codex-test.jsonl", batch: freshBatch() })
      .tool_results.get("x1")?.is_error;

  it("marks an exec call failed when a command it ran exited nonzero", () => {
    expect(isError([ran(2, ["/bin/zsh", "-lc", "ls /no/such/dir"], 1), out(3)])).toBe(1);
    expect(isError([ran(2, "ls /no/such/dir", 1), out(3)])).toBe(1);
  });

  it("does not for a command that succeeded, one the code does not name, or one reported after the call ended", () => {
    expect(isError([ran(2, ["/bin/zsh", "-lc", "ls /no/such/dir"], 0), out(3)])).toBe(0);
    expect(isError([ran(2, ["/bin/zsh", "-lc", "ls /other"], 1), out(3)])).toBe(0);
    expect(isError([out(2), ran(3, ["/bin/zsh", "-lc", "ls /no/such/dir"], 1)])).toBe(0);
  });
});

describe("parseCodexFileBody — exec (code mode) results", () => {
  const at = (seq: number) => `2026-10-23T00:00:${String(seq).padStart(2, "0")}Z`;
  const meta = JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id: "s-cm", cwd: "/w/app" } });
  const exec = (seq: number, callId: string, code: string) =>
    JSON.stringify({ timestamp: at(seq), type: "response_item", payload: { type: "custom_tool_call", call_id: callId, name: "exec", input: code } });
  const wait = (seq: number, callId: string, cell: string) =>
    JSON.stringify({
      timestamp: at(seq),
      type: "response_item",
      payload: { type: "function_call", call_id: callId, name: "wait", arguments: JSON.stringify({ cell_id: cell, yield_time_ms: 10000, max_tokens: 1000 }) },
    });
  const out = (seq: number, callId: string, type: string, output: unknown) =>
    JSON.stringify({ timestamp: at(seq), type: "response_item", payload: { type, call_id: callId, output } });
  const text = (t: string) => ({ type: "input_text", text: t });
  const done = (header: string, ...printed: string[]) => [text(`${header}\nWall time 0.8 seconds\nOutput:\n`), ...printed.map(text)];
  const result = (exit_code: number, output: string) =>
    JSON.stringify({ chunk_id: "263313", wall_time_seconds: 0.02, exit_code, original_token_count: 8, output });
  const parse = (lines: string[]) =>
    parseCodexFileBody({ body: [meta, ...lines].join("\n") + "\n", source_file: "codex-test.jsonl", batch: freshBatch() }).tool_results;
  const GH = 'const r = await tools.exec_command({cmd:"gh --version"});text(r);';

  it("fails an exec call from the exit code of a command result it printed, and keeps only that output", () => {
    const r = parse([
      exec(1, "x1", GH),
      out(2, "x1", "custom_tool_call_output", done("Script completed", result(127, "zsh:1: command not found: gh\n"))),
      exec(3, "x2", 'const r = await tools.exec_command({cmd:"ls"});text(r);'),
      out(4, "x2", "custom_tool_call_output", done("Script completed", result(0, "README.md\n"))),
    ]);
    expect(r.get("x1")).toMatchObject({ is_error: 1, error_excerpt: "Process exited with code 127\nzsh:1: command not found: gh" });
    expect(r.get("x2")).toMatchObject({ is_error: 0, error_excerpt: null });
  });

  it("keeps a failed script's error, not what its successful commands printed", () => {
    const r = parse([
      exec(1, "x1", 'await tools.exec_command({cmd:"git checkout main"}); await tools.exec_command({cmd:"git pull"});'),
      out(2, "x1", "custom_tool_call_output", done(
        "Script failed",
        result(0, "Switched to branch 'main'\n"),
        "Script error:\nCommand blocked by PreToolUse hook: no pulls. Command: git pull",
      )),
    ]);
    expect(r.get("x1")).toMatchObject({ is_error: 1, error_excerpt: "Command blocked by PreToolUse hook: no pulls. Command: git pull" });
  });

  it("reads command results the code printed inside other JSON", () => {
    const settled = JSON.stringify([
      { status: "fulfilled", value: JSON.parse(result(0, "ok\n")) },
      { status: "fulfilled", value: JSON.parse(result(2, "ls: x: No such file or directory\n")) },
    ]);
    const r = parse([
      exec(1, "x1", 'text(JSON.stringify(await Promise.allSettled([tools.exec_command({cmd:"true"}), tools.exec_command({cmd:"ls x"})])));'),
      out(2, "x1", "custom_tool_call_output", done("Script completed", settled)),
    ]);
    expect(r.get("x1")).toMatchObject({ is_error: 1, error_excerpt: "Process exited with code 2\nls: x: No such file or directory" });
  });

  it("takes a failed command's output from its CommandExecution item when the script printed none of it", () => {
    const ran = JSON.stringify({
      timestamp: at(2),
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "CommandExecution", id: "exec-2", command: ["/bin/zsh", "-lc", "gh --version ."], cwd: "file:///w/app", exit_code: 127, aggregated_output: "zsh:1: command not found: gh\n", status: "failed" },
      },
    });
    const r = parse([
      exec(1, "x1", 'await tools.exec_command({cmd:"gh --version ."});'),
      ran,
      out(3, "x1", "custom_tool_call_output", "Script completed\nWall time 0.9 seconds\nOutput:\n"),
    ]);
    expect(r.get("x1")).toMatchObject({ is_error: 1, error_excerpt: "Process exited with code 127\nzsh:1: command not found: gh" });
  });

  it("does not take printed JSON that is not a command result for one", () => {
    const r = parse([
      exec(1, "x1", 'text(JSON.stringify({exit_code: 1, output: "x"}));'),
      out(2, "x1", "custom_tool_call_output", done("Script completed", '{"exit_code":1,"output":"x"}')),
    ]);
    expect(r.get("x1")?.is_error).toBe(0);
  });

  it("gives a running script's failure, reported by a later wait on its cell, to the exec call", () => {
    const running = [
      exec(1, "x1", 'const r = await tools.exec_command({cmd:"sleep 35; gh --version",yield_time_ms:1000});text(r);'),
      out(2, "x1", "custom_tool_call_output", "Script running with cell ID 3\nWall time 31.0 seconds\nOutput:\n"),
    ];
    const failed = parse([...running, wait(3, "w1", "3"), out(4, "w1", "function_call_output", done("Script completed", result(127, "zsh:1: command not found: gh\n")))]);
    expect(failed.get("x1")).toMatchObject({ is_error: 1, error_excerpt: "Process exited with code 127\nzsh:1: command not found: gh" });
    expect(failed.get("w1")).toMatchObject({ is_error: 0, error_excerpt: null });

    const passed = parse([...running, wait(3, "w1", "3"), out(4, "w1", "function_call_output", done("Script completed", result(0, "gh version 2.80.0\n")))]);
    expect([passed.get("x1")?.is_error, passed.get("w1")?.is_error]).toEqual([0, 0]);

    const later = parse([
      ...running,
      wait(3, "w1", "3"),
      out(4, "w1", "function_call_output", "Script running with cell ID 3\nWall time 10.0 seconds\nOutput:\n"),
      wait(5, "w2", "3"),
      out(6, "w2", "function_call_output", done("Script completed", result(127, "zsh:1: command not found: gh\n"))),
    ]);
    expect([later.get("x1")?.is_error, later.get("w1")?.is_error, later.get("w2")?.is_error]).toEqual([1, 0, 0]);
  });

  it("marks the wait itself when its cell's exec call is not in the file", () => {
    const r = parse([wait(1, "w1", "9"), out(2, "w1", "function_call_output", done("Script completed", result(1, "FAIL\n")))]);
    expect(r.get("w1")).toMatchObject({ is_error: 1, error_excerpt: "Process exited with code 1\nFAIL" });
  });
});

describe("parseCodexFileBody — commands still running when their call returned", () => {
  const at = (seq: number) => `2026-09-01T00:00:${String(seq).padStart(2, "0")}Z`;
  const meta = JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id: "s-run", cwd: "/w/app" } });
  const fcall = (seq: number, callId: string, name: string, args: unknown) =>
    JSON.stringify({ timestamp: at(seq), type: "response_item", payload: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) } });
  const fout = (seq: number, callId: string, output: string) =>
    JSON.stringify({ timestamp: at(seq), type: "response_item", payload: { type: "function_call_output", call_id: callId, output } });
  const started = [
    meta,
    fcall(1, "c1", "exec_command", { cmd: "npm test" }),
    fout(2, "c1", "Chunk ID: a\nWall time: 1.0 seconds\nProcess running with session ID 88693\nOriginal token count: 0\nOutput:\n"),
  ];
  const errors = (lines: string[]) => {
    const r = parseCodexFileBody({ body: lines.join("\n") + "\n", source_file: "codex-test.jsonl", batch: freshBatch() });
    return { c1: r.tool_results.get("c1")?.is_error, w1: r.tool_results.get("w1")?.is_error };
  };
  const exited = (code: number) => `Chunk ID: b\nWall time: 5.0 seconds\nProcess exited with code ${code}\nOriginal token count: 3\nOutput:\nFAIL`;

  it("gives a running command's later exit to the exec_command call that started it", () => {
    expect(errors([...started, fcall(3, "w1", "write_stdin", { session_id: 88693, chars: "" }), fout(4, "w1", exited(1))])).toEqual({ c1: 1, w1: 0 });
    expect(errors([...started, fcall(3, "w1", "write_stdin", { session_id: 88693, chars: "" }), fout(4, "w1", exited(0))])).toEqual({ c1: 0, w1: 0 });
  });

  it("keeps the old reading for an unknown session and for write_stdin's own failure", () => {
    expect(errors([...started, fcall(3, "w1", "write_stdin", { session_id: 12345, chars: "" }), fout(4, "w1", exited(1))])).toEqual({ c1: 0, w1: 1 });
    expect(errors([
      ...started,
      fcall(3, "w1", "write_stdin", { session_id: 88693, chars: "x" }),
      fout(4, "w1", "write_stdin failed: stdin is closed for this session"),
    ])).toEqual({ c1: 0, w1: 1 });
  });
});

describe("parseCodexFileBody — exec commands built at run time", () => {
  const at = (seq: number) => `2026-09-01T00:00:${String(seq).padStart(2, "0")}Z`;
  const meta = JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id: "s-bt", cwd: "/w/app" } });
  const exec = (seq: number, callId: string, code: string) =>
    JSON.stringify({ timestamp: at(seq), type: "response_item", payload: { type: "custom_tool_call", call_id: callId, name: "exec", input: code } });
  const execOut = (seq: number, callId: string) =>
    JSON.stringify({ timestamp: at(seq), type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId, output: "Script completed\nOutput:\n" } });
  const ran = (seq: number, command: string, exit_code: number, extra: object = {}) =>
    JSON.stringify({
      timestamp: at(seq),
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "CommandExecution", id: `e${seq}`, command: ["/bin/zsh", "-lc", command], cwd: "file:///w/app/sub", exit_code, source: "unified_exec_startup", ...extra },
      },
    });
  const built = 'const c = "echo hi > out.txt"; await tools.exec_command({cmd: c})';
  const parse = (lines: string[]) =>
    parseCodexFileBody({ body: [meta, ...lines].join("\n") + "\n", source_file: "codex-test.jsonl", batch: freshBatch() });
  const opsOf = (r: ReturnType<typeof parse>, callId: string) =>
    r.events.filter((e) => e.tool_calls[0]?.call_id === callId).flatMap((e) => e.file_ops).map((f) => [f.tool, f.path]);

  it("reads a command exec code built at run time from its CommandExecution item", () => {
    const ok = parse([exec(1, "x1", built), ran(2, "echo hi > out.txt", 0), execOut(3, "x1")]);
    expect(opsOf(ok, "x1")).toEqual([["exec_command", "/w/app/sub/out.txt"]]);
    expect(ok.tool_results.get("x1")?.is_error).toBe(0);
    const failed = parse([exec(1, "x1", built), ran(2, "echo hi > out.txt", 1), execOut(3, "x1")]);
    expect(failed.tool_results.get("x1")?.is_error).toBe(1);
  });

  it("leaves a CommandExecution item alone when it belongs elsewhere or cannot be placed", () => {
    // The command of an open direct exec_command call is that call's.
    const direct = parse([
      exec(1, "x1", built),
      JSON.stringify({ timestamp: at(2), type: "response_item", payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "echo hi > out.txt" }) } }),
      ran(3, "echo hi > out.txt", 1),
      execOut(4, "x1"),
    ]);
    expect(opsOf(direct, "x1")).toEqual([]);
    expect(direct.tool_results.get("x1")?.is_error).toBe(0);
    // A command the user ran in their own shell.
    const user = parse([exec(1, "x1", built), ran(2, "echo hi > out.txt", 1, { source: "user_shell" }), execOut(3, "x1")]);
    expect(opsOf(user, "x1")).toEqual([]);
    expect(user.tool_results.get("x1")?.is_error).toBe(0);
    // Two exec calls open and neither names the command.
    const two = parse([exec(1, "x1", built), exec(2, "x2", built), ran(3, "echo hi > out.txt", 1), execOut(4, "x1"), execOut(5, "x2")]);
    expect([...opsOf(two, "x1"), ...opsOf(two, "x2")]).toEqual([]);
    expect([two.tool_results.get("x1")?.is_error, two.tool_results.get("x2")?.is_error]).toEqual([0, 0]);
    // A literal command already gave its file from the code: not twice.
    const literal = parse([exec(1, "x1", 'await tools.exec_command({cmd:"echo hi > out.txt"})'), ran(2, "echo hi > out.txt", 0), execOut(3, "x1")]);
    expect(opsOf(literal, "x1")).toEqual([["exec_command", "/w/app/out.txt"]]);
  });

  it("leaves alone an item that arrives after the call that ran its command returned", () => {
    // A direct exec_command call returned while its command still ran; the
    // item comes when the command ends, with an exec call open by then.
    const running = parse([
      JSON.stringify({ timestamp: at(1), type: "response_item", payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "echo hi > out.txt" }) } }),
      JSON.stringify({ timestamp: at(2), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "Chunk ID: a\nWall time: 1.0 seconds\nProcess running with session ID 7\nOutput:\n" } }),
      exec(3, "x1", built),
      ran(4, "echo hi > out.txt", 1),
      execOut(5, "x1"),
    ]);
    expect(opsOf(running, "x1")).toEqual([]);
    expect(running.tool_results.get("x1")?.is_error).toBe(0);
    // A literal command of an exec call that has ended.
    const ended = parse([
      exec(1, "x0", 'await tools.exec_command({cmd:"echo hi > out.txt"})'),
      execOut(2, "x0"),
      exec(3, "x1", built),
      ran(4, "echo hi > out.txt", 1),
      execOut(5, "x1"),
    ]);
    expect(opsOf(ended, "x1")).toEqual([]);
    expect(ended.tool_results.get("x1")?.is_error).toBe(0);
  });
});

describe("parseCodexFileBody — MCP calls exec code made", () => {
  const at = (seq: number) => `2026-09-30T00:00:${String(seq).padStart(2, "0")}Z`;
  const line = (seq: number, type: string, payload: unknown) => JSON.stringify({ timestamp: at(seq), type, payload });
  const mcpItem = (seq: number, item: Record<string, unknown>) =>
    line(seq, "event_msg", { type: "item_completed", item: { type: "McpToolCall", ...item } });
  const calls = (lines: string[]) =>
    parseCodexFileBody({ body: [line(0, "session_meta", { id: "s-mcp", cwd: "/w/app" }), ...lines].join("\n") + "\n", source_file: "codex-test.jsonl", batch: freshBatch() })
      .events.flatMap((e) => e.tool_calls)
      .map(({ call_id, name, input_json, is_error, duration_ms, result_chars }) => ({ call_id, name, input_json, is_error, duration_ms, result_chars }));

  it("records each one as its own tool call, beside the exec call", () => {
    expect(calls([
      line(1, "response_item", { type: "custom_tool_call", call_id: "x1", name: "exec", input: 'await tools.mcp__clens__clens_search({query:"outputStyle"})' }),
      mcpItem(2, { id: "exec-a", server: "clens", tool: "clens_search", arguments: { query: "outputStyle" }, status: "completed", result: { content: [] }, duration: { secs: 0, nanos: 205000000 } }),
      mcpItem(3, { id: "exec-b", server: "context-mode", tool: "ctx_search", arguments: {}, status: "failed", result: { content: [], isError: true }, duration: { secs: 1, nanos: 0 } }),
      mcpItem(4, { id: "exec-c", server: "clens", tool: "clens_stats", arguments: {}, status: "failed", error: { message: "timed out" }, duration: { secs: 60, nanos: 0 } }),
      line(5, "response_item", { type: "custom_tool_call_output", call_id: "x1", output: "Script completed\nWall time 0.3 seconds\nOutput:\n" }),
    ])).toEqual([
      { call_id: "x1", name: "exec", input_json: 'await tools.mcp__clens__clens_search({query:"outputStyle"})', is_error: 0, duration_ms: null, result_chars: null },
      { call_id: "exec-a", name: "mcp__clens__clens_search", input_json: '{"query":"outputStyle"}', is_error: 0, duration_ms: 205, result_chars: null },
      { call_id: "exec-b", name: "mcp__context_mode__ctx_search", input_json: "{}", is_error: 1, duration_ms: 1000, result_chars: null },
      { call_id: "exec-c", name: "mcp__clens__clens_stats", input_json: "{}", is_error: 1, duration_ms: 60000, result_chars: null },
    ]);
  });

  it("leaves a direct MCP call's item to the call itself", () => {
    expect(calls([
      line(1, "response_item", { type: "function_call", call_id: "call_1", name: "mcp__clens__clens_search", arguments: '{"query":"x"}' }),
      mcpItem(2, { id: "call_1", server: "clens", tool: "clens_search", arguments: { query: "x" }, status: "completed", result: { content: [] } }),
      line(3, "response_item", { type: "function_call_output", call_id: "call_1", output: "[1] hit" }),
    ]).map((c) => c.name)).toEqual(["mcp__clens__clens_search"]);
  });
});

// The parser wrote a turn's token counts only at task_complete. A turn the
// user interrupted (turn_aborted), or one a new task_started cut off, lost
// its counts: 773 + 77 of 13,404 turns in the rollouts on disk on 2026-11-10.
describe("parseCodexFileBody — token counts of a turn that does not complete", () => {
  const ev = (s: number, payload: object) => ({
    timestamp: `2026-07-01T00:00:${String(s).padStart(2, "0")}Z`,
    type: "event_msg",
    payload,
  });
  const usage = (input_tokens: number, cached_input_tokens: number, output_tokens: number) => ({
    type: "token_count",
    info: { last_token_usage: { input_tokens, cached_input_tokens, output_tokens } },
  });

  it("writes them at turn_aborted, or at the task_started that cuts the turn off", () => {
    const body = [
      { timestamp: "2026-07-01T00:00:00Z", type: "session_meta", payload: { id: "sess-ab", cwd: "/repo", cli_version: "1.0.0" } },
      { timestamp: "2026-07-01T00:00:01Z", type: "turn_context", payload: { model: "gpt-5", cwd: "/repo" } },
      ev(2, { type: "task_started", turn_id: "t1" }),
      ev(3, usage(1000, 800, 50)),
      ev(4, { type: "turn_aborted", turn_id: "t1", reason: "interrupted" }),
      ev(5, { type: "task_started", turn_id: "t2" }),
      ev(6, usage(2000, 1500, 60)),
      ev(7, { type: "task_started", turn_id: "t3" }),
      ev(8, usage(3000, 2500, 70)),
      ev(9, { type: "task_complete", turn_id: "t3", last_agent_message: "done" }),
      // Interrupted before any model call: nothing to write.
      ev(10, { type: "task_started", turn_id: "t4" }),
      ev(11, { type: "turn_aborted", turn_id: "t4", reason: "interrupted" }),
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";

    const result = parseCodexFileBody({ body, source_file: "codex-test.jsonl", batch: freshBatch() });

    expect(
      result.events.map((p) => [p.event.ts, p.event.role, p.event.in_tok, p.event.cache_r, p.event.out_tok]),
      "token rows of interrupted turns",
    ).toEqual([
      ["2026-07-01T00:00:04Z", "assistant", 1000, 800, 50],
      ["2026-07-01T00:00:07Z", "assistant", 2000, 1500, 60],
      ["2026-07-01T00:00:09Z", "assistant", 3000, 2500, 70],
    ]);
  });
});
