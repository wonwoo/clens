import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  assignTurnNumbers,
  codepointLength,
  errorExcerpt,
  parseFileBody,
  utf8SafeTruncate,
} from "../src/indexer/claude_parser.js";
import type { AnomalyBatch } from "../src/indexer/types.js";
import { commandOf } from "../src/mcp/left_off.js";

const FIXTURE = join(process.cwd(), "test/fixtures/brainstorm-session.jsonl");

function freshBatch(): AnomalyBatch {
  return {
    counters: new Map(),
    session_id: null,
    ts: new Date(0).toISOString(),
    source_file: null,
  };
}

describe("parser utilities", () => {
  it("codepointLength counts unicode codepoints", () => {
    expect(codepointLength("abc")).toBe(3);
    expect(codepointLength("한글")).toBe(2);
    expect(codepointLength("👋🌍")).toBe(2);
    expect(codepointLength("")).toBe(0);
  });

  it("utf8SafeTruncate keeps codepoint boundary", () => {
    const s = "abc한글xyz";
    const r1 = utf8SafeTruncate(s, 1000);
    expect(r1.truncated).toBe(false);
    expect(r1.out).toBe(s);

    // '한' is 3 bytes utf-8. Truncate to 4 bytes → 'abc' (4 leaves us mid-한)
    const r2 = utf8SafeTruncate(s, 4);
    expect(r2.truncated).toBe(true);
    // Must end at a codepoint boundary (not mid-한)
    expect(Buffer.from(r2.out, "utf8").byteLength).toBeLessThanOrEqual(4);
    // Must be a prefix
    expect(s.startsWith(r2.out)).toBe(true);
  });

  it("errorExcerpt keeps a short output whole and the first 100 and last 200 codepoints of a long one", () => {
    expect(errorExcerpt("  \n")).toBeNull();
    expect(errorExcerpt("Exit code 1\nboom\n")).toBe("Exit code 1\nboom");
    const short = "가".repeat(300);
    expect(errorExcerpt(short)).toBe(short);
    // Emoji are two UTF-16 units each: the cut must count codepoints, not units.
    const long = "H".repeat(99) + "👋" + "m".repeat(500) + "🌍" + "T".repeat(199);
    expect(errorExcerpt(long)).toBe("H".repeat(99) + "👋" + "\n…[truncated]…\n" + "🌍" + "T".repeat(199));
  });
});

describe("parseFileBody on canonical fixture", () => {
  const body = readFileSync(FIXTURE, "utf8");
  const result = parseFileBody({ body, source_file: FIXTURE, batch: freshBatch() });

  it("last_ok ends at file end (fixture is fully terminated)", () => {
    expect(result.last_ok_byte_offset).toBe(Buffer.from(body, "utf8").byteLength);
  });

  it("fully_terminated_line_count matches \\n count in body", () => {
    const newlines = (body.match(/\n/g) ?? []).length;
    expect(result.fully_terminated_line_count).toBe(newlines);
  });

  it("emits at least 700 event rows (fixture is ~750 events; non-event lines like last-prompt are skipped)", () => {
    expect(result.events.length).toBeGreaterThan(700);
    expect(result.events.length).toBeLessThan(961);
  });

  it("every event has a non-empty session_id (all rewritten to 'test')", () => {
    for (const ev of result.events) {
      expect(ev.event.session_id).toBe("test");
    }
  });

  it("emits Agent tool_use rows (fixture has 5 Agent calls) with non-empty subagent_type", () => {
    const all = result.events.flatMap((e) => e.agent_calls);
    expect(all.length).toBe(5);
    for (const r of all) {
      expect(r.subagent_type.length).toBeGreaterThan(0);
    }
  });

  it("emits tool_call rows for Edit/Bash/ctx_execute (fixture distribution)", () => {
    const counts = new Map<string, number>();
    for (const ev of result.events) {
      for (const tc of ev.tool_calls) {
        counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
      }
    }
    // From inline inspection of the fixture:
    // Edit ~82, Bash 9, ctx_execute 9, Agent 5, Read 2, ToolSearch 1, Write 1
    expect(counts.get("Edit")).toBeGreaterThanOrEqual(70);
    expect(counts.get("Bash")).toBeGreaterThanOrEqual(5);
    expect(counts.get("Agent")).toBe(5);
  });

  it("file_op rows are populated for Edit/Read/Write/NotebookEdit and Bash only", () => {
    const fops = result.events.flatMap((e) => e.file_ops);
    expect(fops.length).toBeGreaterThan(0);
    for (const f of fops) {
      expect(["Edit", "Read", "Write", "NotebookEdit", "Bash"]).toContain(f.tool);
      expect(f.path.length).toBeGreaterThan(0);
    }
    // The redaction left `ls <corpus>/...`, which a shell reads as two redirects.
    expect(fops.filter((f) => f.tool === "Bash").map((f) => f.path)).toEqual(["/..."]);
  });
});

describe("assignTurnNumbers reproduces measured {3,4,6} from expected.json", () => {
  it("user_turn_no for the 3 Korean scope-change messages equals {3,4,6}", () => {
    const body = readFileSync(FIXTURE, "utf8");
    const result = parseFileBody({ body, source_file: FIXTURE, batch: freshBatch() });
    assignTurnNumbers(result.events);

    // Find user_text rows whose text matches the 3 scope-change signatures.
    const allUserTexts = result.events.flatMap((e) =>
      e.user_texts.map((u) => ({ turn: e.event.user_turn_no, text: u.text })),
    );

    const dropFts = allUserTexts.find(
      (u) => typeof u.text === "string" && u.text.includes("대화 검색은 아니야"),
    );
    const ossPivot = allUserTexts.find(
      (u) => typeof u.text === "string" && u.text.includes("나혼자 쓸꺼는 아니야"),
    );
    const skillCaller = allUserTexts.find(
      (u) => typeof u.text === "string" && u.text.includes("API 키 이거필요"),
    );

    expect(dropFts?.turn).toBe(3);
    expect(ossPivot?.turn).toBe(4);
    expect(skillCaller?.turn).toBe(6);
  });

  it("total user turns is 61 per expected.json", () => {
    const body = readFileSync(FIXTURE, "utf8");
    const result = parseFileBody({ body, source_file: FIXTURE, batch: freshBatch() });
    const { userTurns } = assignTurnNumbers(result.events);
    expect(userTurns).toBe(61);
  });
});

describe("parseEventLine on synthetic events (Skill/system-reminder/slash-command not present in fixture)", () => {
  it("emits skill_call row when tool_use name='Skill'", () => {
    const line = JSON.stringify({
      uuid: "u-skill",
      sessionId: "s",
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "Skill",
            input: { skill: "code-review", args: "review this diff" },
          },
        ],
      },
    });
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch: freshBatch() });
    const sk = r.events[0]!.skill_calls;
    expect(sk.length).toBe(1);
    expect(sk[0]!.skill).toBe("code-review");
    expect(sk[0]!.args_excerpt).toBe("review this diff");
  });

  it("stores an assistant reply up to 64 KB whole and keeps the start and end of a longer one", () => {
    const reply = (uuid: string, text: string) =>
      JSON.stringify({
        uuid,
        sessionId: "s",
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    const mid = "가".repeat(10000); // 30 KB
    const long = "A" + "나".repeat(30000) + "Z"; // 90 KB
    const r = parseFileBody({ body: reply("a1", mid) + "\n" + reply("a2", long) + "\n", source_file: "x", batch: freshBatch() });
    const [whole, cut] = r.events.map((e) => e.user_texts[0]!.text);
    expect(whole).toBe(mid);
    expect(Buffer.byteLength(cut!, "utf8")).toBeLessThanOrEqual(65536);
    expect(cut).toContain("…[truncated]…");
    expect(cut!.startsWith("A나")).toBe(true);
    expect(cut!.endsWith("나Z")).toBe(true);
  });

  it("tags <default> when Agent input.subagent_type missing", () => {
    const line = JSON.stringify({
      uuid: "u-agent",
      sessionId: "s",
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "Agent",
            input: { description: "do a thing", prompt: "x".repeat(500) },
          },
        ],
      },
    });
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch: freshBatch() });
    const a = r.events[0]!.agent_calls[0]!;
    expect(a.subagent_type).toBe("<default>");
    expect(a.prompt_excerpt!.length).toBe(256);
  });

  it("parses <system-reminder> inside user text into a system_reminder row with category", () => {
    const line = JSON.stringify({
      uuid: "u-sr",
      sessionId: "s",
      type: "user",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello\n<system-reminder>The following skills are available for use with the Skill tool</system-reminder>",
          },
        ],
      },
    });
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch: freshBatch() });
    const sr = r.events[0]!.system_reminders;
    expect(sr.length).toBe(1);
    expect(sr[0]!.category).toBe("available_skills");
  });

  it("parses <command-name> as a slash_command row and sets is_command on user_text", () => {
    const line = JSON.stringify({
      uuid: "u-cmd",
      sessionId: "s",
      type: "user",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "<command-name>code-review</command-name> review me" }],
      },
    });
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch: freshBatch() });
    expect(r.events[0]!.slash_commands.length).toBe(1);
    expect(r.events[0]!.slash_commands[0]!.name).toBe("code-review");
    expect(r.events[0]!.user_texts[0]!.is_command).toBe(1);
  });

  // Paths and URLs are what users paste when they point at something; the
  // text must stay searchable by them. A regex that removed every "/word"
  // turned "src/mcp/server.ts" into "src.ts" and a URL into "https:/.host/".
  const userLine = (content: unknown) =>
    JSON.stringify({
      uuid: "u-text",
      sessionId: "s",
      type: "user",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content },
    });
  const PLAIN =
    "src/mcp/server.ts 고쳐줘 https://blog.example.com/ai/2026/07/post-name/ 참고, /Users/a/work/app 에서 A/B 테스트\n\n둘째 줄";

  it("stores a plain user message verbatim: paths, URLs and A/B survive (text-block form)", () => {
    const r = parseFileBody({ body: userLine([{ type: "text", text: PLAIN }]) + "\n", source_file: "x", batch: freshBatch() });
    const ut = r.events[0]!.user_texts[0]!;
    expect(ut.text).toBe(PLAIN);
    expect(ut.is_command).toBe(0);
  });

  it("stores a plain user message verbatim: paths, URLs and A/B survive (string form)", () => {
    const r = parseFileBody({ body: userLine(PLAIN) + "\n", source_file: "x", batch: freshBatch() });
    expect(r.events[0]!.user_texts[0]!.text).toBe(PLAIN);
  });

  it("drops the command name/message tags but keeps the typed arguments, paths included", () => {
    const text =
      "<command-message>brainstorming</command-message>\n<command-name>/brainstorming</command-name>\n" +
      "<command-args>src/mcp/server.ts 보고 https://example.com/a/b 정리해줘</command-args>";
    for (const content of [text, [{ type: "text", text }]]) {
      const r = parseFileBody({ body: userLine(content) + "\n", source_file: "x", batch: freshBatch() });
      const ev = r.events[0]!;
      expect(ev.user_texts[0]!.text).toBe("src/mcp/server.ts 보고 https://example.com/a/b 정리해줘");
      expect(ev.user_texts[0]!.is_command).toBe(1);
      expect(ev.slash_commands.map((c) => c.name)).toEqual(["brainstorming"]);
    }
  });

  it("a command with no arguments leaves no leftover markup", () => {
    const text = "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>";
    const r = parseFileBody({ body: userLine(text) + "\n", source_file: "x", batch: freshBatch() });
    expect(r.events[0]!.user_texts[0]!.text).toBe("");
    expect(r.events[0]!.user_texts[0]!.is_command).toBe(1);
  });

  it("emits file_op rows for Read/Edit/Write/NotebookEdit with file_path", () => {
    const line = JSON.stringify({
      uuid: "u-edit",
      sessionId: "s",
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-e",
            name: "Edit",
            input: { file_path: "/x/y.ts", old_string: "a", new_string: "b" },
          },
        ],
      },
    });
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch: freshBatch() });
    expect(r.events[0]!.file_ops.length).toBe(1);
    expect(r.events[0]!.file_ops[0]!.path).toBe("/x/y.ts");
    expect(r.events[0]!.file_ops[0]!.tool).toBe("Edit");
  });

  describe("files a Bash command wrote", () => {
    const bashLine = (uuid: string, command: unknown, cwd?: string) =>
      JSON.stringify({
        uuid,
        sessionId: "s",
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        ...(cwd === undefined ? {} : { cwd }),
        message: { role: "assistant", content: [{ type: "tool_use", id: `tu-${uuid}`, name: "Bash", input: { command } }] },
      });
    const ops = (body: string) =>
      parseFileBody({ body, source_file: "x", batch: freshBatch() }).events.flatMap((e) =>
        e.file_ops.map((f) => ({ tool: f.tool, path: f.path, event_uuid: f.event_uuid })),
      );

    it("records each file as a Bash file_op, placed against the line's cwd", () => {
      const cmd = "cd sub && cat > notes.md <<'EOF'\nx > y\nEOF\nsed -i '' 's/a/b/' ../src/a.ts";
      expect(ops(bashLine("b1", cmd, "/w/app") + "\n")).toEqual([
        { tool: "Bash", path: "/w/app/sub/notes.md", event_uuid: "b1" },
        { tool: "Bash", path: "/w/app/src/a.ts", event_uuid: "b1" },
      ]);
    });

    it("keeps an absolute path but drops a relative one when the line has no cwd", () => {
      expect(ops(bashLine("b2", "echo > rel.txt; echo > /abs.txt") + "\n")).toEqual([
        { tool: "Bash", path: "/abs.txt", event_uuid: "b2" },
      ]);
    });

    it("reads the full command, not the stored input cut at 64 KB", () => {
      const cmd = `echo '${"x".repeat(70000)}' > /tmp/late.txt`;
      const r = parseFileBody({ body: bashLine("b3", cmd, "/w") + "\n", source_file: "x", batch: freshBatch() });
      expect(Buffer.byteLength(r.events[0]!.tool_calls[0]!.input_json!, "utf8")).toBeLessThanOrEqual(65536);
      expect(r.events[0]!.file_ops.map((f) => f.path)).toEqual(["/tmp/late.txt"]);
    });

    it("stores a Bash input up to 64 KB whole, so a git command late in it is still read", () => {
      const cmd = `echo '${"y".repeat(3000)}'\ngit commit -m "late"`;
      const batch = freshBatch();
      const r = parseFileBody({ body: bashLine("b8", cmd, "/w") + "\n", source_file: "x", batch });
      const stored = r.events[0]!.tool_calls[0]!.input_json;
      expect(stored).toBe(JSON.stringify({ command: cmd }));
      expect(commandOf(stored)).toBe(cmd);
      expect(batch.counters.get("tool_input_truncated")).toBeUndefined();
    });

    it("keeps the files of a command whose result is an error", () => {
      const result = JSON.stringify({
        uuid: "r4",
        sessionId: "s",
        type: "user",
        timestamp: "2026-01-01T00:00:01Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-b4", is_error: true, content: "Exit code 1" }] },
      });
      expect(ops(bashLine("b4", "echo x > out.txt && false", "/w") + "\n" + result + "\n")).toEqual([
        { tool: "Bash", path: "/w/out.txt", event_uuid: "b4" },
      ]);
    });

    it("records nothing for a read-only command or an input without a command string", () => {
      expect(ops(bashLine("b5", "git status && grep -rn foo src 2>/dev/null", "/w") + "\n")).toEqual([]);
      expect(ops(bashLine("b6", 42, "/w") + "\n")).toEqual([]);
      expect(ops(bashLine("b7", undefined, "/w") + "\n")).toEqual([]);
    });
  });

  it("truncates tool_call.input_json over 2 KB and increments anomaly", () => {
    const huge = "x".repeat(5000);
    const line = JSON.stringify({
      uuid: "u-big",
      sessionId: "s",
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu-h", name: "Write", input: { file_path: "/w/a.txt", content: huge } },
        ],
      },
    });
    const batch = freshBatch();
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch });
    const tc = r.events[0]!.tool_calls[0]!;
    expect(Buffer.byteLength(tc.input_json!, "utf8")).toBeLessThanOrEqual(2048);
    expect(batch.counters.get("tool_input_truncated")?.count).toBe(1);
  });

  it("stores on each tool call the branch its line carries, and null for a line without one", () => {
    const line = (uuid: string, ts: string, gitBranch?: string) => JSON.stringify({
      uuid,
      sessionId: "s",
      type: "assistant",
      timestamp: ts,
      ...(gitBranch === undefined ? {} : { gitBranch }),
      message: { role: "assistant", content: [{ type: "tool_use", id: `tu-${uuid}`, name: "Bash", input: { command: "ls" } }] },
    });
    const body = [
      line("b1", "2026-01-01T00:00:00Z", "main"),
      line("b2", "2026-01-01T00:00:01Z", "feature/x"),
      line("b3", "2026-01-01T00:00:02Z"),
    ].join("\n") + "\n";
    const r = parseFileBody({ body, source_file: "x", batch: freshBatch() });
    expect(r.events.flatMap((e) => e.tool_calls).map((t) => t.git_branch)).toEqual(["main", "feature/x", null]);
  });

  it("classifies tool_result pseudo-user via has_tool_res=1 + has_text=0 → no user_turn_no", () => {
    const realUser = JSON.stringify({
      uuid: "u-real",
      sessionId: "s",
      type: "user",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "hello" },
    });
    const pseudoUser = JSON.stringify({
      uuid: "u-pseudo",
      sessionId: "s",
      type: "user",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
      },
    });
    const r = parseFileBody({ body: realUser + "\n" + pseudoUser + "\n", source_file: "x", batch: freshBatch() });
    assignTurnNumbers(r.events);
    const real = r.events.find((e) => e.event.uuid === "u-real")!;
    const pseudo = r.events.find((e) => e.event.uuid === "u-pseudo")!;
    expect(real.event.user_turn_no).toBe(1);
    expect(pseudo.event.user_turn_no).toBeNull();
    expect(pseudo.event.has_tool_res).toBe(1);
    expect(pseudo.event.has_text).toBe(0);
  });
});

describe("skill-body injection filter (bug-1 fix)", () => {
  it("isMeta:true message is skipped regardless of content", () => {
    const line = JSON.stringify({
      uuid: "u-skill-body",
      sessionId: "s",
      type: "user",
      isMeta: true,
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "user",
        content: "Base directory for this skill: /some/skill\n\nAlways respond in the user's language.\n\n# Brainstorming",
      },
    });
    const batch = freshBatch();
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch });
    expect(r.events[0]!.user_texts.length).toBe(0);
    expect(batch.counters.get("skill_body_skipped")?.count).toBe(1);
  });

  it("isMeta:true reviewer-prompt is skipped", () => {
    const line = JSON.stringify({
      uuid: "u-rev",
      sessionId: "s",
      type: "user",
      isMeta: true,
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "user",
        content: "Review the following code change for correctness.",
      },
    });
    const batch = freshBatch();
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch });
    expect(r.events[0]!.user_texts.length).toBe(0);
    expect(batch.counters.get("skill_body_skipped")?.count).toBe(1);
  });

  it("same content WITHOUT isMeta is NOT skipped (user pasted skill text)", () => {
    const line = JSON.stringify({
      uuid: "u-paste",
      sessionId: "s",
      type: "user",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "user",
        content: "Base directory for this skill: /some/skill\n\n# Brainstorming",
      },
    });
    const batch = freshBatch();
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch });
    expect(r.events[0]!.user_texts.length).toBe(1);
    expect(batch.counters.get("skill_body_skipped")).toBeUndefined();
  });

  it("ordinary user text is NOT skipped", () => {
    const line = JSON.stringify({
      uuid: "u-real",
      sessionId: "s",
      type: "user",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "아니 잠만 이거 다시 봐줘" },
    });
    const batch = freshBatch();
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch });
    expect(r.events[0]!.user_texts.length).toBe(1);
    expect(batch.counters.get("skill_body_skipped")).toBeUndefined();
  });

  it("slash command markers inside an isMeta:true body still emit slash_command rows", () => {
    const text = "<command-name>brainstorming</command-name>\n\nBase directory for this skill: /some/path\n\n# Brainstorming body";
    const line = JSON.stringify({
      uuid: "u-cmd-inj",
      sessionId: "s",
      type: "user",
      isMeta: true,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: text },
    });
    const batch = freshBatch();
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch });
    expect(r.events[0]!.user_texts.length).toBe(0);
    expect(r.events[0]!.slash_commands.length).toBe(1);
    expect(r.events[0]!.slash_commands[0]!.name).toBe("brainstorming");
    expect(batch.counters.get("skill_body_skipped")?.count).toBe(1);
  });
});

describe("partial-last-line handling", () => {
  it("leaves a missing-newline final line for the next run (last_ok stays at last \\n)", () => {
    const body = "{\"uuid\":\"u1\",\"sessionId\":\"s\",\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n{\"uuid\":\"u2\",\"sessionId\":\"s\",\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:01Z\"";
    const result = parseFileBody({ body, source_file: "x", batch: freshBatch() });
    expect(result.fully_terminated_line_count).toBe(1);
    expect(result.events.length).toBe(1);
    expect(result.last_ok_byte_offset).toBe(body.indexOf("\n") + 1);
  });
});

describe("hook blocks and result size", () => {
  const HOOK_FIXTURE = join(process.cwd(), "test/fixtures/hook-blocks-session.jsonl");
  const body = readFileSync(HOOK_FIXTURE, "utf8");
  const result = parseFileBody({ body, source_file: HOOK_FIXTURE, batch: freshBatch() });
  const blocks = result.events.flatMap((e) => e.hook_blocks);

  it("records the code-point length of each result's text, images not counted", () => {
    expect(result.tool_results.get("toolu_1")?.result_chars).toBe(5);
    expect(result.tool_results.get("toolu_2")?.result_chars).toBe(78);
    expect(result.tool_results.get("toolu_3")?.result_chars).toBe(5);
    expect(result.tool_results.get("toolu_4")?.result_chars).toBe(54);
    expect(result.tool_results.get("toolu_5")?.result_chars).toBe(42);
    expect(result.tool_results.has("toolu_6")).toBe(false);
  });

  it("keeps an error result's text as its excerpt, and none for a result that is not an error", () => {
    expect(result.tool_results.get("toolu_5")?.error_excerpt).toBe("exit 1: PreToolUse:Bash hook error: quoted");
    expect(result.tool_results.get("toolu_1")?.error_excerpt).toBeNull();
    expect(result.tool_results.get("toolu_4")?.error_excerpt).toBeNull();
  });

  it("records one PreToolUse block from the error result and one Stop block from the attachment", () => {
    expect(blocks).toHaveLength(2);
    expect(blocks).toContainEqual(expect.objectContaining({
      event_uuid: "h-u3",
      session_id: "hooks-s1",
      hook_event: "PreToolUse",
      tool: "Bash",
      call_id: "toolu_2",
      reason: "[policy] curl is blocked. Use the sandbox instead.",
    }));
    expect(blocks).toContainEqual(expect.objectContaining({
      event_uuid: "h-at1",
      session_id: "hooks-s1",
      hook_event: "Stop",
      tool: null,
      call_id: null,
      reason: "Unresolved items remain in the ledger.",
    }));
  });

  it("does not take the prefix in the middle of a result for a block, error or not", () => {
    expect(blocks.some((b) => b.call_id === "toolu_4" || b.call_id === "toolu_5")).toBe(false);
  });

  it("cuts a long reason to 512 bytes on a character boundary", () => {
    const line = JSON.stringify({
      type: "user", uuid: "k-u1", sessionId: "s", timestamp: "2026-09-01T00:00:00Z",
      message: { role: "user", content: [{
        type: "tool_result", tool_use_id: "toolu_k", is_error: true,
        content: "PreToolUse:Bash hook error: " + "가".repeat(300),
      }] },
    });
    const r = parseFileBody({ body: line + "\n", source_file: "x", batch: freshBatch() });
    const reason = r.events[0]!.hook_blocks[0]!.reason!;
    expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(512);
    expect(Buffer.from(reason).toString()).toBe(reason);
    expect(reason.startsWith("가")).toBe(true);
  });
});

describe("hook block detection guards", () => {
  const parseLine = (o: object) => parseFileBody({ body: JSON.stringify(o) + "\n", source_file: "x", batch: freshBatch() });

  it("does not take a non-error result that opens with the prefix for a block (cat of a hook log)", () => {
    const r = parseLine({
      type: "user", uuid: "g-u1", sessionId: "s", timestamp: "2026-09-01T00:00:00Z",
      message: { role: "user", content: [{
        type: "tool_result", tool_use_id: "toolu_g", is_error: false,
        content: "PreToolUse:Bash hook error: a line from hook.log",
      }] },
    });
    expect(r.events[0]!.hook_blocks).toEqual([]);
    expect(r.tool_results.get("toolu_g")?.result_chars).toBe(48);
  });

  it("skips a PreToolUse hook_blocking_error attachment, since the blocked call's result already counts it", () => {
    const batch = freshBatch();
    const r = parseFileBody({
      body: JSON.stringify({
        type: "attachment", uuid: "g-at1", sessionId: "s", timestamp: "2026-09-01T00:00:01Z",
        attachment: {
          type: "hook_blocking_error", hookName: "PreToolUse:Bash", toolUseID: "toolu_g",
          hookEvent: "PreToolUse", blockingError: { blockingError: "blocked", command: "check.sh" },
        },
      }) + "\n",
      source_file: "x",
      batch,
    });
    expect(r.events[0]!.hook_blocks).toEqual([]);
    // The attachment line keeps the null_content bump every attachment line gets.
    expect(batch.counters.get("null_content")?.count).toBe(1);
  });
});

describe("messages sent while the agent was working", () => {
  const queued = (uuid: string, attachment: Record<string, unknown>) =>
    JSON.stringify({ type: "attachment", uuid, sessionId: "s", timestamp: "2026-10-20T00:20:01Z", attachment: { type: "queued_command", ...attachment } });

  it("stores the user's queued message as their message, text blocks only", () => {
    const body = [
      queued("q1", { prompt: "일단 테스트해보고 다음 진행하자", commandMode: "prompt", origin: { kind: "human" }, humanTurn: true }),
      queued("q2", { prompt: [{ type: "text", text: "이거 봐바" }, { type: "image", source: { type: "base64", data: "AA==" } }], commandMode: "prompt", origin: { kind: "human" } }),
    ].join("\n") + "\n";
    const r = parseFileBody({ body, source_file: "x", batch: freshBatch() });
    expect(r.events.flatMap((e) => e.user_texts).map(({ event_uuid, text, role, type, is_command }) => ({ event_uuid, text, role, type, is_command }))).toEqual([
      { event_uuid: "q1", text: "일단 테스트해보고 다음 진행하자", role: "user", type: "user_message", is_command: 0 },
      { event_uuid: "q2", text: "이거 봐바", role: "user", type: "user_message", is_command: 0 },
    ]);
  });

  it("leaves out a queued message an agent sent: a task notification, a peer's or a coordinator's", () => {
    const body = [
      queued("n1", { prompt: "<task-notification><task-id>b1</task-id></task-notification>", commandMode: "task-notification", origin: { kind: "task-notification" } }),
      queued("n2", { prompt: "<task-notification><task-id>b2</task-id></task-notification>", commandMode: "task-notification" }),
      queued("p1", { prompt: "<cross-session-message from=\"uds:/tmp/a.sock\">hi</cross-session-message>", commandMode: "prompt", origin: { kind: "peer" } }),
      queued("c1", { prompt: "Scope addition: compare both", origin: { kind: "coordinator" } }),
    ].join("\n") + "\n";
    const r = parseFileBody({ body, source_file: "x", batch: freshBatch() });
    expect(r.events.flatMap((e) => e.user_texts)).toEqual([]);
  });
});
