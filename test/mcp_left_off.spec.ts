import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySchema } from "../src/indexer/schema.js";
import {
  commandOf, formatLeftOff, formatSessionRecord, formatSessionRecordWithin, leftOff, leftOffWithMore, sessionRecord,
} from "../src/mcp/left_off.js";

let db: Database.Database;

function msg(uuid: string, session: string, ts: string, role: "user" | "assistant", text: string): void {
  db.prepare("INSERT INTO event (uuid, session_id, ts, role) VALUES (?, ?, ?, ?)").run(uuid, session, ts, role);
  db.prepare("INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES (?, ?, ?, ?, ?, ?)").run(
    uuid, session, ts, text, role, role === "user" ? "user_message" : "assistant_message",
  );
}
function edit(uuid: string, session: string, ts: string, tool: string, path: string): void {
  db.prepare("INSERT INTO file_op (event_uuid, session_id, ts, tool, path) VALUES (?, ?, ?, ?, ?)").run(uuid, session, ts, tool, path);
}

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  db.exec(`
    INSERT INTO project (id, cwd) VALUES ('-w-app', '/w/app'), ('-w-web', '/w/web');
    INSERT INTO session (id, project_id, kind, cwd, source) VALUES
      ('old', '-w-app', 'interactive', '/w/app', 'claude'),
      ('mid', '-w-app', 'interactive', '/w/app', 'codex'),
      ('new', '-w-app', 'interactive', '/w/app', 'claude'),
      ('judge', '-w-app', 'pipeline', '/w/app', 'claude'),
      ('web', '-w-web', 'interactive', '/w/web', 'claude');
  `);
  msg("o1", "old", "2026-09-01T10:00:00Z", "user", "add the cache");
  msg("o2", "old", "2026-09-01T10:05:00Z", "assistant", "Cache added; tests pass.");
  edit("o3", "old", "2026-09-01T10:04:00Z", "Edit", "/w/app/src/cache.ts");
  msg("m1", "mid", "2026-09-02T10:00:00Z", "user", "fix the login bug");
  msg("m2", "mid", "2026-09-02T10:05:00Z", "assistant", "Login fixed. Next: add a regression test.");
  edit("m3", "mid", "2026-09-02T10:03:00Z", "apply_patch", "/w/app/src/login.ts");
  edit("m4", "mid", "2026-09-02T10:04:00Z", "apply_patch", "/w/app/src/cache.ts");
  edit("m5", "mid", "2026-09-02T10:04:30Z", "Read", "/w/app/README.md");
  msg("n1", "new", "2026-09-03T10:00:00Z", "user", "where did I leave off");
  msg("n2", "new", "2026-09-03T10:00:30Z", "user", "[Request interrupted by user]");
  msg("n3", "new", "2026-09-03T10:00:40Z", "user", "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>");
  msg("n4", "new", "2026-09-03T10:00:50Z", "user", "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>");
  msg("j1", "judge", "2026-09-04T10:00:00Z", "user", "USER: add the cache USER: fix the login bug");
  msg("w1", "web", "2026-09-05T10:00:00Z", "user", "style the header");
});

afterEach(() => db.close());

describe("clens_left_off", () => {
  it("lists a project's sessions by their last message, newest first, without judge sessions", () => {
    expect(leftOff(db, { project_id: "-w-app", limit: 10 }).map((s) => s.session_id)).toEqual(["new", "mid", "old"]);
  });

  it("leaves the asking conversation out", () => {
    expect(leftOff(db, { project_id: "-w-app" }, { currentSessionId: "new" }).map((s) => s.session_id)).toEqual(["mid", "old"]);
  });

  it("gives each session's last real request and reply, and the files it edited, newest edit first", () => {
    const [mid] = leftOff(db, { project_id: "-w-app" }, { currentSessionId: "new" });
    expect(mid).toMatchObject({
      started_at: "2026-09-02T10:00:00Z",
      ended_at: "2026-09-02T10:05:00Z",
      last_request: "fix the login bug",
      last_reply: "Login fixed. Next: add a regression test.",
      files: ["/w/app/src/cache.ts", "/w/app/src/login.ts"],
    });
    const [newest] = leftOff(db, { project_id: "-w-app" });
    expect(newest!.last_request).toBe("where did I leave off");
  });

  it("skips a bare slash command as the last request, but not a pasted path", () => {
    msg("m6", "mid", "2026-09-02T10:06:00Z", "user", "/compact");
    msg("o4", "old", "2026-09-01T10:06:00Z", "user", "/w/app/src/cache.ts");
    const byId = Object.fromEntries(leftOff(db, { project_id: "-w-app", limit: 10 }).map((s) => [s.session_id, s]));
    expect(byId.mid).toMatchObject({ last_request: "fix the login bug", ended_at: "2026-09-02T10:05:00Z" });
    expect(byId.old!.last_request).toBe("/w/app/src/cache.ts");
  });

  it("keeps to a time window: the sessions active in it, each as it stood at the window's end", () => {
    const inWindow = leftOff(db, { project_id: "-w-app", since: "2026-09-02", until: "2026-09-02T10:04:00Z", limit: 10 });
    expect(inWindow).toHaveLength(1);
    expect(inWindow[0]).toMatchObject({
      session_id: "mid",
      started_at: "2026-09-02T10:00:00Z",
      ended_at: "2026-09-02T10:00:00Z",
      last_request: "fix the login bug",
      last_reply: null,
      files: ["/w/app/src/cache.ts", "/w/app/src/login.ts"],
    });
    const fromMidway = leftOff(db, { project_id: "-w-app", since: "2026-09-02T10:01:00Z" });
    expect(fromMidway.find((s) => s.session_id === "mid")!.started_at).toBe("2026-09-02T10:05:00Z");
    expect(leftOff(db, { project_id: "-w-app", since: "2026-09-02T12:00:00Z" }).map((s) => s.session_id)).toEqual(["new"]);
    expect(leftOff(db, { file: "src/cache.ts", since: "2026-09-02" }).map((s) => s.session_id)).toEqual(["mid"]);
  });

  it("counts a file a Bash command wrote as an edit, in the list, the file lookup and the record", () => {
    edit("n5", "new", "2026-09-03T10:00:20Z", "Bash", "/w/app/src/shell.ts");
    expect(leftOff(db, { project_id: "-w-app" }).find((s) => s.session_id === "new")!.files).toEqual(["/w/app/src/shell.ts"]);
    expect(leftOff(db, { file: "src/shell.ts" }).map((s) => s.session_id)).toEqual(["new"]);
    expect(sessionRecord(db, "new")!.edits.map((e) => e.path)).toEqual(["/w/app/src/shell.ts"]);
  });

  it("orders files last edited at the same time by path, in the list and the record", () => {
    // One patch or command writes several files at one timestamp; without a
    // tie-breaker their order followed the query plan.
    for (const [i, name] of ["z", "b", "y", "a"].entries()) {
      edit(`t${i}`, "new", "2026-09-03T10:00:20Z", i % 2 ? "Bash" : "apply_patch", `/w/app/src/${name}.ts`);
    }
    const paths = ["a", "b", "y", "z"].map((name) => `/w/app/src/${name}.ts`);
    expect(leftOff(db, { project_id: "-w-app" }).find((s) => s.session_id === "new")!.files).toEqual(paths);
    expect(sessionRecord(db, "new")!.edits.map((e) => e.path)).toEqual(paths);
  });

  it("finds the sessions that edited a file by its tail or full path, not ones that only read it", () => {
    expect(leftOff(db, { file: "src/cache.ts" }).map((s) => s.session_id)).toEqual(["mid", "old"]);
    expect(leftOff(db, { file: "/w/app/src/login.ts" }).map((s) => s.session_id)).toEqual(["mid"]);
    expect(leftOff(db, { file: "README.md" })).toEqual([]);
    expect(leftOff(db, { file: "ache.ts" })).toEqual([]);
  });

  it("leaves out subagent threads and one-shot exec and SDK runs", () => {
    db.exec(`INSERT INTO session (id, project_id, kind, cwd, source) VALUES
      ('child', '-w-app', 'subagent', '/w/app', 'codex'), ('run', '-w-app', 'exec', '/w/app', 'codex')`);
    msg("c1", "child", "2026-09-07T10:00:00Z", "user", "review src/cache.ts");
    msg("x1", "run", "2026-09-08T10:00:00Z", "user", "reply ok");
    edit("c2", "child", "2026-09-07T10:01:00Z", "apply_patch", "/w/app/src/cache.ts");
    expect(leftOff(db, { project_id: "-w-app" }).map((s) => s.session_id)).toEqual(["new", "mid", "old"]);
    expect(leftOff(db, { file: "src/cache.ts" }).map((s) => s.session_id)).toEqual(["mid", "old"]);
  });

  it("counts a subagent's edits, at any depth, as its parent session's", () => {
    db.exec(`INSERT INTO session (id, project_id, kind, parent_id, cwd, source) VALUES
      ('agent-a1', '-w-app', 'subagent', 'mid', '/w/app', 'claude'),
      ('agent-a2', '-w-app', 'subagent', 'agent-a1', '/w/app', 'claude')`);
    edit("a1", "agent-a1", "2026-09-02T10:04:40Z", "Edit", "/w/app/src/api.ts");
    edit("a2", "agent-a2", "2026-09-02T10:04:45Z", "Write", "/w/app/src/api.test.ts");
    const [mid] = leftOff(db, { project_id: "-w-app" }, { currentSessionId: "new" });
    expect(mid!.files).toEqual(["/w/app/src/api.test.ts", "/w/app/src/api.ts", "/w/app/src/cache.ts", "/w/app/src/login.ts"]);
    expect(leftOff(db, { file: "src/api.test.ts" }).map((s) => s.session_id)).toEqual(["mid"]);
  });

  it("looks across every project without project_id", () => {
    expect(leftOff(db, {}).map((s) => s.session_id)).toEqual(["web", "new", "mid"]);
  });

  it("formats files relative to the session's working directory", () => {
    const out = formatLeftOff(leftOff(db, { project_id: "-w-app" }, { currentSessionId: "new" }).slice(0, 1));
    expect(out.split("\n")).toEqual([
      "[1] 2026-09-02T10:05:00Z  session:mid  project:-w-app  codex  started:2026-09-02T10:00:00Z",
      "Last request: fix the login bug",
      "Last reply: Login fixed. Next: add a regression test.",
      "Edited: src/cache.ts, src/login.ts",
    ]);
    expect(formatLeftOff([])).toBe("No sessions found.");
  });

  it("counts the sessions active in the listed span that the limit left out", () => {
    db.exec("INSERT INTO session (id, project_id, kind, cwd, source) VALUES ('par', '-w-app', 'interactive', '/w/app', 'claude')");
    msg("p1", "par", "2026-09-02T09:00:00Z", "user", "update the docs");
    msg("p2", "par", "2026-09-02T10:01:00Z", "assistant", "Docs updated.");
    const two = leftOffWithMore(db, { project_id: "-w-app", limit: 2 });
    expect(two.sessions.map((s) => s.session_id)).toEqual(["new", "mid"]);
    // old ended before mid started, and judge is not the user's session.
    expect(two.more).toEqual({ count: 1, since: "2026-09-02T10:00:00Z" });
    expect(formatLeftOff(two.sessions, two.more).split("\n").at(-1)).toBe(
      "(+1 more session active since 2026-09-02T10:00:00Z is not listed; raise limit (max 10) or narrow since/until to see it)",
    );
    expect(leftOffWithMore(db, { project_id: "-w-app", limit: 3 }).more.count).toBe(0);
    // The asking conversation is not counted either.
    expect(leftOffWithMore(db, { project_id: "-w-app", limit: 1 }, { currentSessionId: "new" }).more.count).toBe(1);
    expect(formatLeftOff(leftOff(db, { project_id: "-w-app", limit: 3 }), { count: 0, since: "" })).not.toContain("more session");
  });

  it("lists the project's own files before files outside it", () => {
    edit("m6", "mid", "2026-09-02T10:04:50Z", "Write", "/tmp/scratch/probe.js");
    const [mid] = leftOff(db, { project_id: "-w-app" }, { currentSessionId: "new" });
    expect(mid!.files[0]).toBe("/tmp/scratch/probe.js");
    expect(formatLeftOff([mid!]).split("\n").at(-1)).toBe("Edited: src/cache.ts, src/login.ts, /tmp/scratch/probe.js");
  });
});

describe("clens_left_off session record", () => {
  function call(uuid: string, session: string, ts: string, name: string, input: string, isError = 0, callId: string | null = null): void {
    db.prepare("INSERT INTO tool_call (event_uuid, session_id, ts, call_id, name, input_json, is_error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uuid, session, ts, callId, name, input, isError);
  }
  function block(uuid: string, session: string, ts: string, hookEvent: string, tool: string | null, callId: string | null, reason: string | null): void {
    db.prepare("INSERT INTO hook_block (event_uuid, session_id, ts, hook_event, tool, call_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uuid, session, ts, hookEvent, tool, callId, reason);
  }
  /** The rows of "gives one session's requests, …", reused by the format test. */
  function seedMid(): void {
    call("g1", "mid", "2026-09-02T10:04:50Z", "Bash", '{"command":"git add -A && git commit -m \\"fix login\\""}');
    call("g2", "mid", "2026-09-02T10:04:51Z", "Bash", '{"command":"git status"}');
    call("f1", "mid", "2026-09-02T10:04:52Z", "Bash", '{"command":"npm test\\nnpm run lint"}', 1);
    block("b1", "mid", "2026-09-02T10:04:53Z", "Stop", null, null, "req-harness: you cannot finish yet.\nmore detail");
  }

  it("returns null for a session that is not in the index", () => {
    expect(sessionRecord(db, "nope")).toBeNull();
  });

  it("gives one session's requests, edits, git commands, failed calls and hook blocks", () => {
    seedMid();
    const r = sessionRecord(db, "mid")!;
    expect(r.requests).toEqual([{ ts: "2026-09-02T10:00:00Z", text: "fix the login bug" }]);
    expect(r.edits.map((e) => e.path)).toEqual(["/w/app/src/cache.ts", "/w/app/src/login.ts"]);
    expect(r.git).toEqual([{ ts: "2026-09-02T10:04:50Z", command: 'git add -A && git commit -m "fix login"' }]);
    expect(r.failures).toEqual([{ ts: "2026-09-02T10:04:52Z", tool: "Bash", input: "npm test" }]);
    expect(r.hook_blocks).toEqual([
      { ts: "2026-09-02T10:04:53Z", hook_event: "Stop", tool: null, reason: "req-harness: you cannot finish yet." },
    ]);
  });

  it("lists a hook-blocked call under hook blocks only", () => {
    call("p1", "mid", "2026-09-02T10:04:54Z", "Write", '{"file_path":"/w/app/x.md"}', 1, "toolu_1");
    block("p2", "mid", "2026-09-02T10:04:54Z", "PreToolUse", "Write", "toolu_1",
      "PreToolUse:Write hook error: [Fact-Forcing Gate] Before creating x.md\nstate the facts");
    const r = sessionRecord(db, "mid")!;
    expect(r.failures.some((f) => f.tool === "Write")).toBe(false);
    expect(r.hook_blocks.map((b) => b.reason)).toContain("[Fact-Forcing Gate] Before creating x.md");
  });

  it("shows a hook block whose reason is NULL", () => {
    block("n1", "mid", "2026-09-02T10:04:56Z", "Stop", null, null, null);
    const r = sessionRecord(db, "mid")!;
    expect(r.hook_blocks).toContainEqual({ ts: "2026-09-02T10:04:56Z", hook_event: "Stop", tool: null, reason: "" });
    expect(formatSessionRecord(r).split("\n")).toContain("  2026-09-02T10:04:56Z  Stop: ");
  });

  it("counts a subagent's edits, git commands, failures and hook blocks as the parent's, but not its requests", () => {
    db.exec("INSERT INTO session (id, project_id, kind, parent_id, cwd, source) VALUES ('agent-a1', '-w-app', 'subagent', 'mid', '/w/app', 'claude')");
    msg("s1", "agent-a1", "2026-09-02T10:04:40Z", "user", "review the login fix");
    edit("s2", "agent-a1", "2026-09-02T10:04:41Z", "Edit", "/w/app/src/api.ts");
    call("s3", "agent-a1", "2026-09-02T10:04:42Z", "Bash", '{"command":"git -C /w/app switch -c fix"}');
    const r = sessionRecord(db, "mid")!;
    expect(r.edits.map((e) => e.path)).toContain("/w/app/src/api.ts");
    expect(r.git.map((g) => g.command)).toContain("git -C /w/app switch -c fix");
    expect(r.requests.map((q) => q.text)).not.toContain("review the login fix");
    expect(sessionRecord(db, "agent-a1")!.requests).toEqual([]);
  });

  it("shows the latest five edited files, the rest by folder, and temporary files as a count per folder", () => {
    const files = ["src/a.ts", "src/b.ts", "README.md", "test/a.spec.ts", "src/c.ts", "src/d.ts", "CLAUDE.md", "test/b.spec.ts"];
    files.forEach((f, k) => edit(`p${k}`, "new", `2026-09-03T09:0${k}:00Z`, "Edit", `/w/app/${f}`));
    edit("u1", "new", "2026-09-03T08:00:00Z", "Edit", "/home/u/.codex/hooks.json");
    for (let k = 1; k <= 11; k++) {
      edit(`t${k}`, "new", `2026-09-03T09:${String(10 + k)}:00Z`, "Bash", `/private/tmp/claude-1/scratchpad/run${k}.log`);
    }
    edit("t12", "new", "2026-09-03T09:30:00Z", "Bash", "/tmp/out.txt");
    const r = sessionRecord(db, "new")!;
    expect(r.edits_total).toBe(21);
    const lines = formatSessionRecord(r).split("\n");
    const at = lines.indexOf("Edited (21 files):");
    expect(lines.slice(at, at + 11)).toEqual([
      "Edited (21 files):",
      "  test/b.spec.ts  1 edits, last 2026-09-03T09:07:00Z",
      "  CLAUDE.md  1 edits, last 2026-09-03T09:06:00Z",
      "  src/d.ts  1 edits, last 2026-09-03T09:05:00Z",
      "  src/c.ts  1 edits, last 2026-09-03T09:04:00Z",
      "  test/a.spec.ts  1 edits, last 2026-09-03T09:03:00Z",
      "  Also edited, by folder:",
      "    .: README.md",
      "    src: b.ts, a.ts",
      "    /home/u/.codex: hooks.json",
      "  Temporary: 12 files (/private/tmp 11, /tmp 1)",
    ]);
  });

  it("cuts the by-folder list and says how many files it left out", () => {
    for (let k = 0; k < 205; k++) {
      edit(`f${k}`, "new", `2026-09-03T09:00:${String(k % 60).padStart(2, "0")}.${String(k).padStart(3, "0")}Z`, "Edit",
        `/w/app/src/generated/file_${String(k).padStart(3, "0")}.ts`);
    }
    const lines = formatSessionRecord(sessionRecord(db, "new")!).split("\n");
    const at = lines.indexOf("  Also edited, by folder:");
    expect(lines[at + 1]!.startsWith("    src/generated: ")).toBe(true);
    expect(lines[at + 1]!.length).toBeLessThanOrEqual(1200 + 4);
    const shown = lines[at + 1]!.split(", ").length;
    expect(lines[at + 2]).toBe(`    (+${200 - shown} more files)`);
  });

  it("does not count files under the session's own folder as temporary", () => {
    db.exec("INSERT INTO session (id, project_id, kind, cwd, source) VALUES ('tmpwork', '-tmp-work', 'interactive', '/tmp/work', 'codex')");
    edit("tw1", "tmpwork", "2026-09-03T09:00:00Z", "apply_patch", "/tmp/work/main.go");
    edit("tw2", "tmpwork", "2026-09-03T09:01:00Z", "exec_command", "/tmp/other.log");
    const r = sessionRecord(db, "tmpwork")!;
    expect(r.edits.map((e) => e.path)).toEqual(["/tmp/work/main.go"]);
    expect(r.temp_edits).toEqual([{ root: "/tmp", count: 1 }]);
  });

  it("keeps the latest ten of each list, oldest first, and reports the total", () => {
    for (let i = 1; i <= 12; i++) {
      msg(`r${i}`, "old", `2026-09-01T11:${String(i - 1).padStart(2, "0")}:00Z`, "user", `request ${i}`);
    }
    const r = sessionRecord(db, "old")!;
    expect(r.requests_total).toBe(13);
    expect(r.requests).toHaveLength(10);
    expect(r.requests[0]!.text).toBe("request 3");
    expect(r.requests.at(-1)!.text).toBe("request 12");
  });

  it("shows the session's own last reply, its lines joined, cut at 500 characters", () => {
    msg("lr1", "mid", "2026-09-02T10:06:00Z", "assistant", `Rebuilt.\n\n${"x".repeat(600)}`);
    db.exec("INSERT INTO session (id, project_id, kind, parent_id, cwd, source) VALUES ('agent-r', '-w-app', 'subagent', 'mid', '/w/app', 'claude')");
    msg("lr2", "agent-r", "2026-09-02T10:07:00Z", "assistant", "subagent report");
    const r = sessionRecord(db, "mid")!;
    expect(r.last_reply).toEqual({ ts: "2026-09-02T10:06:00Z", text: `Rebuilt. ⏎ ${"x".repeat(600)}` });
    expect(formatSessionRecord(r).split("\n")).toContain(`Last reply: 2026-09-02T10:06:00Z  Rebuilt. ⏎ ${"x".repeat(489)}…`);
  });

  it("shows a request whole, its lines joined, cut at the list's request length", () => {
    msg("ml1", "new", "2026-09-03T10:10:00Z", "user", "write the README in English and Korean\n\n  link them to each other\n");
    msg("ml2", "new", "2026-09-03T10:11:00Z", "user", `${"가".repeat(499)}\n나다`);
    const r = sessionRecord(db, "new")!;
    expect(r.requests.map((q) => q.text).slice(-2)).toEqual([
      "write the README in English and Korean ⏎ link them to each other",
      `${"가".repeat(499)} ⏎ 나다`,
    ]);
    const lines = formatSessionRecord(r).split("\n");
    expect(lines).toContain("  2026-09-03T10:10:00Z  write the README in English and Korean ⏎ link them to each other");
    expect(lines).toContain(`  2026-09-03T10:11:00Z  ${"가".repeat(499)} …`);
  });

  it("reads a Codex exec_command's git commands and edits", () => {
    call("cx1", "mid", "2026-09-02T10:04:58Z", "exec_command", '{"cmd":"git add -A && git commit -m \\"codex fix\\"","workdir":"/w/app"}');
    edit("cx2", "mid", "2026-09-02T10:04:59Z", "exec_command", "/w/app/src/codex.ts");
    const r = sessionRecord(db, "mid")!;
    expect(r.git.map((g) => g.command)).toContain('git add -A && git commit -m "codex fix"');
    expect(r.edits.map((e) => e.path)).toContain("/w/app/src/codex.ts");
    expect(commandOf('{"cmd":"ls","workdir":"/w"}')).toBe("ls");
    const cut = '{"cmd":"git commit -m \\"' + "x".repeat(3000);
    expect(commandOf(cut.slice(0, 2048))!.startsWith('git commit -m "xxx')).toBe(true);
  });

  it("lists a Codex PreToolUse block under hook blocks, not failures", () => {
    call("cb1", "mid", "2026-09-02T10:05:02Z", "exec_command", '{"cmd":"git push"}', 1, "c-block");
    block("cb2", "mid", "2026-09-02T10:05:02Z", "PreToolUse", "exec_command", "c-block", "pushes need review");
    const r = sessionRecord(db, "mid")!;
    expect(r.failures.some((f) => f.tool === "exec_command")).toBe(false);
    expect(r.hook_blocks.map((b) => b.reason)).toContain("pushes need review");
  });

  it("reads the git commands exec code runs", () => {
    call("cx3", "mid", "2026-09-02T10:05:01Z", "exec", 'await tools.exec_command({cmd:"git switch -c codex-branch"});');
    expect(sessionRecord(db, "mid")!.git.map((g) => g.command)).toContain("git switch -c codex-branch");
  });

  it("reads a git command out of an input cut at 2,048 bytes", () => {
    const cut = '{"command":"git commit -m \\"' + "x".repeat(3000);
    expect(commandOf(cut.slice(0, 2048))!.startsWith('git commit -m "xxx')).toBe(true);
    call("c1", "mid", "2026-09-02T10:04:55Z", "Bash", cut.slice(0, 2048));
    expect(sessionRecord(db, "mid")!.git.some((g) => g.command.startsWith('git commit -m "'))).toBe(true);
    expect(commandOf('{"command":"ls","description":"list"}')).toBe("ls");
    expect(commandOf('{"query":"x"}')).toBeNull();
    call("c2", "mid", "2026-09-02T10:04:57Z", "Bash", '{"command":"cd /w/app\\ngit commit -m \\"second\\""}');
    expect(sessionRecord(db, "mid")!.git.map((g) => g.command)).toContain('git commit -m "second"');
  });

  it("starts a long git line at its git command when the cut would hide it", () => {
    const long = "cd /w/app; echo " + "x".repeat(100) + "; git branch --show-current";
    call("l1", "mid", "2026-09-02T10:04:58Z", "Bash", JSON.stringify({ command: long }));
    const r = sessionRecord(db, "mid")!;
    // The record keeps the whole line; only the printed line starts at git.
    expect(r.git.map((g) => g.command)).toContain(long);
    expect(formatSessionRecord(r).split("\n")).toContain("  2026-09-02T10:04:58Z  …git branch --show-current");
  });

  it("lists every state-changing git line of a call, with a heredoc commit's subject, and skips heredoc bodies", () => {
    const commit = "git add -A && git commit -m \"$(cat <<'EOF'\nfix: keep the session id\n\nCo-Authored-By: x\nEOF\n)\" && git push";
    call("h1", "mid", "2026-09-02T10:04:56Z", "Bash", JSON.stringify({ command: "cat > t.ts <<'EOF'\nrun('git add -A && git commit -m x');\nEOF" }));
    call("h2", "mid", "2026-09-02T10:04:57Z", "Bash", JSON.stringify({ command: commit }));
    call("h3", "mid", "2026-09-02T10:04:58Z", "Bash", JSON.stringify({ command: "git stash\ngit reset --hard origin/main" }));
    const r = sessionRecord(db, "mid")!;
    expect(r.git).toEqual([
      { ts: "2026-09-02T10:04:57Z", command: "git add -A && git commit -m \"$(cat <<'EOF' ⏎ fix: keep the session id" },
      { ts: "2026-09-02T10:04:57Z", command: ')" && git push' },
      { ts: "2026-09-02T10:04:58Z", command: "git stash" },
      { ts: "2026-09-02T10:04:58Z", command: "git reset --hard origin/main" },
    ]);
    expect(r.git_total).toBe(4);
  });

  it("leaves out git text inside quotes and comments, but not inside $( ) in quotes", () => {
    const script = 'node -e \'for (const cmd of ["git add -A && git commit -m \\"fix login\\""]) run(cmd)\'';
    call("q1", "mid", "2026-09-02T10:04:56Z", "Bash", JSON.stringify({ command: script }));
    call("q2", "mid", "2026-09-02T10:04:56Z", "Bash", JSON.stringify({ command: "python3 -c \"\nprint('x; git push')\n\"\necho done # && git reset --hard" }));
    call("q3", "mid", "2026-09-02T10:04:57Z", "Bash", JSON.stringify({ command: 'echo "it\'s $(git stash)" && echo \'a "b\' && git switch main' }));
    const r = sessionRecord(db, "mid")!;
    expect(r.git.map((g) => g.command)).toEqual([
      'echo "it\'s $(git stash)" && echo \'a "b\' && git switch main',
    ]);
  });

  it("reads the script of sh -c, bash -c or zsh -lc as commands", () => {
    const zsh = '/bin/zsh -lc \'new=$(git commit-tree HEAD^{tree} -m "init") && git reset --hard "$new"\'';
    call("z1", "mid", "2026-09-02T10:04:56Z", "exec_command", JSON.stringify({ cmd: zsh }));
    call("z2", "mid", "2026-09-02T10:04:57Z", "Bash", JSON.stringify({ command: "bash -c \"cd /w/app && git commit -m 'x'\"" }));
    expect(sessionRecord(db, "mid")!.git.map((g) => g.command)).toEqual([zsh, "bash -c \"cd /w/app && git commit -m 'x'\""]);
  });

  it("adds a later git command on a long line that the cut would hide", () => {
    const line = 'git add src/a.ts && git commit -m "' + "x".repeat(120) + '" && git push origin main';
    call("k1", "mid", "2026-09-02T10:04:58Z", "Bash", JSON.stringify({ command: line }));
    expect(formatSessionRecord(sessionRecord(db, "mid")!).split("\n"))
      .toContain(`  2026-09-02T10:04:58Z  ${line.slice(0, 120)}… …git push origin main`);
  });

  it("splits the session into segments at compactions and at pauses over two hours", () => {
    db.exec("INSERT INTO session (id, project_id, kind, cwd, source) VALUES ('long', '-w-app', 'interactive', '/w/app', 'claude')");
    msg("l1", "long", "2026-09-10T09:00:00.000Z", "user", "add the cache");
    msg("l2", "long", "2026-09-10T09:05:00.000Z", "assistant", "Cache added.\nTests pass.");
    db.exec(`INSERT INTO system_reminder (event_uuid, session_id, ts, category) VALUES ('lc', 'long', '2026-09-10T09:10:00.000Z', 'compaction')`);
    msg("l3", "long", "2026-09-10T09:20:00.000Z", "user", "now the login bug");
    msg("l4", "long", "2026-09-10T09:25:00.000Z", "user", "[Request interrupted by user]");
    msg("l5", "long", "2026-09-10T09:26:00.000Z", "user", "and its test");
    msg("l6", "long", "2026-09-10T09:30:00.000Z", "assistant", "Login fixed; committed.");
    // A pause of exactly two hours does not split; one over it does.
    msg("l7", "long", "2026-09-10T11:30:01.000Z", "user", "push it");
    msg("l8", "long", "2026-09-10T13:30:01.000Z", "assistant", "Pushed to main.");
    const r = sessionRecord(db, "long")!;
    expect(r.segments).toEqual([
      { started_at: "2026-09-10T09:00:00.000Z", ended_at: "2026-09-10T09:05:00.000Z", requests: 1, first_request: "add the cache", last_reply: "Cache added. ⏎ Tests pass.", closing: null, topics: [], last_change: null },
      { started_at: "2026-09-10T09:20:00.000Z", ended_at: "2026-09-10T09:30:00.000Z", requests: 2, first_request: "now the login bug", last_reply: "Login fixed; committed.", closing: null, topics: [], last_change: null },
      { started_at: "2026-09-10T11:30:01.000Z", ended_at: "2026-09-10T13:30:01.000Z", requests: 1, first_request: "push it", last_reply: "Pushed to main.", closing: null, topics: [], last_change: null },
    ]);
    expect(r.segments_total).toBe(3);
    const lines = formatSessionRecord(r).split("\n");
    const at = lines.indexOf("Segments (3, split at compactions and pauses over 2 hours):");
    expect(lines.slice(at, at + 4)).toEqual([
      "Segments (3, split at compactions and pauses over 2 hours):",
      "  2026-09-10T09:00:00.000Z – 2026-09-10T09:05:00.000Z  1 requests",
      "    First request: add the cache",
      "    Last reply: Cache added. ⏎ Tests pass.",
    ]);
    // After every other section, so the compaction hook's cut drops it first.
    expect(lines.indexOf("Hook blocks: (none)")).toBe(at - 1);
  });

  it("shows the code terms two or more of a segment's replies mention, most mentioned first", () => {
    db.exec("INSERT INTO session (id, project_id, kind, cwd, source) VALUES ('top', '-w-app', 'interactive', '/w/app', 'claude')");
    msg("p1", "top", "2026-09-10T09:00:00.000Z", "user", "why is `search` slow");
    msg("p2", "top", "2026-09-10T09:01:00.000Z", "assistant", "`locale` is dropped: `SearchCache` misses because `cacheKey` ignores it; see `a1b2c3d`.");
    msg("p3", "top", "2026-09-10T09:02:00.000Z", "assistant", "Fixed `cacheKey` to keep `locale`; `SearchCache` hits now in `42` ms, commit `a1b2c3d`.");
    msg("p4", "top", "2026-09-10T09:03:00.000Z", "user", "and `search` itself?");
    msg("p5", "top", "2026-09-10T09:04:00.000Z", "assistant", "`search` calls `SearchCache` once, and `cacheKey` twice: `cacheKey`. `42` ms.");
    // Over two hours later: a segment whose replies share no term.
    msg("p6", "top", "2026-09-10T12:00:00.000Z", "user", "thanks");
    msg("p7", "top", "2026-09-10T12:01:00.000Z", "assistant", "You are welcome; `once` is enough.");
    const r = sessionRecord(db, "top")!;
    // Counted once per reply; not a user's terms, a commit hash or a number.
    expect(r.segments.map((g) => g.topics)).toEqual([["SearchCache", "cacheKey", "locale"], []]);
    const lines = formatSessionRecord(r).split("\n");
    const at = lines.indexOf("    First request: why is `search` slow");
    expect(lines.slice(at, at + 3)).toEqual([
      "    First request: why is `search` slow",
      "    Topics: SearchCache, cacheKey, locale",
      "    Last reply: `search` calls `SearchCache` once, and `cacheKey` twice: `cacheKey`. `42` ms.",
    ]);
    expect(lines.filter((l) => l.startsWith("    Topics:"))).toHaveLength(1);
  });

  it("shows the reply after a segment's latest edit or commit when a later request followed", () => {
    db.exec("INSERT INTO session (id, project_id, kind, cwd, source) VALUES ('chg', '-w-app', 'interactive', '/w/app', 'claude')");
    msg("c1", "chg", "2026-09-10T09:00:00.000Z", "user", "fix the login bug");
    edit("c1e", "chg", "2026-09-10T09:00:30.000Z", "Edit", "/w/app/src/login.ts");
    msg("c2", "chg", "2026-09-10T09:01:00.000Z", "assistant", "Fixed the expiry check in src/login.ts; tests pass.");
    msg("c3", "chg", "2026-09-10T09:01:10.000Z", "assistant", "Done.");
    msg("c4", "chg", "2026-09-10T09:02:00.000Z", "user", "what does the expiry do?");
    // A scratch file is not a change.
    edit("c4e", "chg", "2026-09-10T09:02:30.000Z", "Write", "/tmp/probe.js");
    msg("c5", "chg", "2026-09-10T09:03:00.000Z", "assistant", "It logs a user out after an hour without requests.");
    // A commit is one; a checkout is not.
    msg("d1", "chg", "2026-09-10T12:00:00.000Z", "user", "commit it");
    call("d1g", "chg", "2026-09-10T12:00:30.000Z", "Bash", JSON.stringify({ command: "git add -A && git commit -m 'fix expiry'" }));
    msg("d2", "chg", "2026-09-10T12:01:00.000Z", "assistant", "Committed as abc1234; nothing pushed.");
    msg("d3", "chg", "2026-09-10T12:02:00.000Z", "user", "switch to main");
    call("d3g", "chg", "2026-09-10T12:02:30.000Z", "Bash", JSON.stringify({ command: "git checkout main" }));
    msg("d4", "chg", "2026-09-10T12:03:00.000Z", "assistant", "On main now, and the tree is clean.");
    // A change in the last request: the last reply already tells it.
    msg("e1", "chg", "2026-09-10T15:00:00.000Z", "user", "add a test");
    edit("e1e", "chg", "2026-09-10T15:00:30.000Z", "Write", "/w/app/test/login.spec.ts");
    msg("e2", "chg", "2026-09-10T15:01:00.000Z", "assistant", "Added test/login.spec.ts; it passes.");
    const r = sessionRecord(db, "chg")!;
    expect(r.segments.map((g) => g.last_change)).toEqual([
      { request: 1, reply: "Fixed the expiry check in src/login.ts; tests pass." },
      { request: 1, reply: "Committed as abc1234; nothing pushed." },
      null,
    ]);
    const lines = formatSessionRecord(r).split("\n");
    const at = lines.indexOf("    First request: fix the login bug");
    expect(lines.slice(at, at + 3)).toEqual([
      "    First request: fix the login bug",
      "    Last change (request 1 of 2): Fixed the expiry check in src/login.ts; tests pass.",
      "    Last reply: It logs a user out after an hour without requests.",
    ]);
    expect(lines.filter((l) => l.startsWith("    Last change"))).toHaveLength(2);
  });

  it("also splits at a compaction summary, and keeps a segment with no request", () => {
    db.exec("INSERT INTO session (id, project_id, kind, cwd, source) VALUES ('sum', '-w-app', 'interactive', '/w/app', 'claude')");
    msg("u1", "sum", "2026-09-10T09:00:00.000Z", "user", "refactor the parser");
    db.exec(`INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES
      ('u2', 'sum', '2026-09-10T09:10:00.000Z', 'This session is being continued from a previous conversation', 'user', 'continuation_summary')`);
    msg("u3", "sum", "2026-09-10T09:11:00.000Z", "assistant", "Continuing the refactor: done.");
    const r = sessionRecord(db, "sum")!;
    expect(r.segments.map((s) => [s.requests, s.first_request, s.last_reply])).toEqual([
      [1, "refactor the parser", null],
      [0, null, "Continuing the refactor: done."],
    ]);
    const lines = formatSessionRecord(r).split("\n");
    expect(lines).toContain("    First request: (none)");
    expect(lines).toContain("    Last reply: (none)");
  });

  it("shows a segment's last reply of over 20 characters, with a shorter one after it as how it closed", () => {
    db.exec("INSERT INTO session (id, project_id, kind, cwd, source) VALUES ('ack', '-w-app', 'interactive', '/w/app', 'claude')");
    msg("k1", "ack", "2026-09-10T09:00:00.000Z", "user", "commit it");
    msg("k2", "ack", "2026-09-10T09:01:00.000Z", "assistant", "Committed as abc1234; nothing pushed.");
    msg("k3", "ack", "2026-09-10T09:02:00.000Z", "user", "wait for me");
    msg("k4", "ack", "2026-09-10T09:03:00.000Z", "assistant", "알겠습니다.");
    msg("k5", "ack", "2026-09-10T09:04:00.000Z", "assistant", "알겠습니다. 기다리겠습니다.");
    // Only short replies: the last one is shown as it is.
    msg("k6", "ack", "2026-09-10T12:00:00.000Z", "user", "done?");
    msg("k7", "ack", "2026-09-10T12:01:00.000Z", "assistant", "네.");
    msg("k8", "ack", "2026-09-10T12:02:00.000Z", "assistant", "완료.");
    const r = sessionRecord(db, "ack")!;
    expect(r.segments.map((s) => [s.last_reply, s.closing])).toEqual([
      ["Committed as abc1234; nothing pushed.", "알겠습니다. 기다리겠습니다."],
      ["완료.", null],
    ]);
    expect(formatSessionRecord(r).split("\n")).toContain('    Last reply: Committed as abc1234; nothing pushed. (then: "알겠습니다. 기다리겠습니다.")');
  });

  it("does not count /compact with instructions as a request or a segment", () => {
    db.exec("INSERT INTO session (id, project_id, kind, cwd, source) VALUES ('cmp', '-w-app', 'interactive', '/w/app', 'claude')");
    msg("c1", "cmp", "2026-09-10T09:00:00.000Z", "user", "tag the keywords");
    msg("c2", "cmp", "2026-09-10T09:05:00.000Z", "assistant", "Tagged them; tests pass.");
    msg("c3", "cmp", "2026-09-10T12:10:00.000Z", "user", "/compact keep the tag notes");
    // Claude Code also stores the instructions alone, as the command's message.
    db.exec(`INSERT INTO event (uuid, session_id, ts, role) VALUES ('c4', 'cmp', '2026-09-10T12:10:00.001Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text, is_command, role, type)
        VALUES ('c4', 'cmp', '2026-09-10T12:10:00.001Z', 'keep the tag notes', 1, 'user', 'user_message');
      INSERT INTO slash_command (event_uuid, session_id, ts, name) VALUES ('c4', 'cmp', '2026-09-10T12:10:00.001Z', 'compact')`);
    msg("c7", "cmp", "2026-09-10T12:10:30.000Z", "user", "/compact\nkeep the tag notes");
    db.exec(`INSERT INTO system_reminder (event_uuid, session_id, ts, category) VALUES ('cc', 'cmp', '2026-09-10T12:11:00.000Z', 'compaction')`);
    msg("c5", "cmp", "2026-09-10T12:20:00.000Z", "user", "go on with the tags");
    msg("c6", "cmp", "2026-09-10T12:30:00.000Z", "assistant", "All tags are judged now.");
    const r = sessionRecord(db, "cmp")!;
    expect(r.segments.map((s) => [s.requests, s.first_request, s.last_reply])).toEqual([
      [1, "tag the keywords", "Tagged them; tests pass."],
      [1, "go on with the tags", "All tags are judged now."],
    ]);
    // Nor in the requests, so the segments' counts add up to their total.
    expect(r.requests.map((q) => q.text)).toEqual(["tag the keywords", "go on with the tags"]);
    expect(r.requests_total).toBe(2);
  });

  it("shows the reply before a Claude Code notice such as a session limit, with the notice as how it closed", () => {
    db.exec("INSERT INTO session (id, project_id, kind, cwd, source) VALUES ('lim', '-w-app', 'interactive', '/w/app', 'claude')");
    msg("lm1", "lim", "2026-09-10T09:00:00.000Z", "user", "write the docs");
    msg("lm2", "lim", "2026-09-10T09:05:00.000Z", "assistant", "Docs written for all nine pages.");
    msg("lm3", "lim", "2026-09-10T09:06:00.000Z", "assistant", "You've hit your session limit · resets 5:10am (Asia/Seoul)");
    msg("lm4", "lim", "2026-09-10T12:00:00.000Z", "user", "why did it fail");
    msg("lm5", "lim", "2026-09-10T12:01:00.000Z", "assistant", "Short answer first.");
    msg("lm6", "lim", "2026-09-10T12:02:00.000Z", "assistant", "API Error: 500 came from the proxy, not from our code; retrying fixed it.");
    db.prepare("UPDATE event SET model = '<synthetic>' WHERE uuid IN ('lm3')").run();
    const r = sessionRecord(db, "lim")!;
    expect(r.segments.map((s) => [s.last_reply, s.closing])).toEqual([
      ["Docs written for all nine pages.", "You've hit your session limit · resets 5:10am (Asia/Seoul)"],
      // A reply the model wrote is a reply, whatever it starts with.
      ["API Error: 500 came from the proxy, not from our code; retrying fixed it.", null],
    ]);
  });

  it("shows the latest twenty segments, oldest first, and no section for a single segment or a subagent", () => {
    db.exec(`INSERT INTO session (id, project_id, kind, parent_id, cwd, source) VALUES
      ('many', '-w-app', 'interactive', NULL, '/w/app', 'claude'),
      ('agent-m', '-w-app', 'subagent', 'many', '/w/app', 'claude')`);
    for (let d = 1; d <= 22; d++) {
      msg(`d${d}`, "many", `2026-09-${String(d).padStart(2, "0")}T09:00:00.000Z`, "user", `day ${d}`);
      msg(`a${d}`, "agent-m", `2026-09-${String(d).padStart(2, "0")}T09:00:01.000Z`, "user", `task ${d}`);
    }
    const r = sessionRecord(db, "many")!;
    expect(r.segments_total).toBe(22);
    expect(r.segments.map((s) => s.first_request)).toEqual(Array.from({ length: 20 }, (_, k) => `day ${k + 3}`));
    expect(formatSessionRecord(r).split("\n")).toContain("Segments (last 20 of 22, split at compactions and pauses over 2 hours):");
    expect(sessionRecord(db, "agent-m")!.segments_total).toBe(0);
    expect(formatSessionRecord(sessionRecord(db, "mid")!)).not.toContain("Segments");
  });

  it("leaves out the oldest segments first to fit a record in a length, down to the latest one", () => {
    db.exec("INSERT INTO session (id, project_id, kind, cwd, source) VALUES ('many', '-w-app', 'interactive', '/w/app', 'claude')");
    for (let d = 1; d <= 22; d++) msg(`d${d}`, "many", `2026-09-${String(d).padStart(2, "0")}T09:00:00.000Z`, "user", `day ${d}`);
    const r = sessionRecord(db, "many")!;
    const whole = formatSessionRecord(r);
    expect(formatSessionRecordWithin(r, whole.length)).toBe(whole);
    const fit = formatSessionRecordWithin(r, whole.length - 1);
    expect(fit.length).toBeLessThan(whole.length);
    const lines = fit.split("\n");
    expect(lines).toContain("Segments (last 19 of 22, split at compactions and pauses over 2 hours):");
    expect(lines).not.toContain("    First request: day 3");
    expect(lines).toContain("    First request: day 22");
    // What still does not fit is the caller's to cut.
    const tight = formatSessionRecordWithin(r, 10).split("\n");
    expect(tight).toContain("Segments (last 1 of 22, split at compactions and pauses over 2 hours):");
    expect(tight).toContain("    First request: day 22");
    expect(r.segments).toHaveLength(20);
  });

  it("formats a record with its section headers", () => {
    seedMid();
    expect(formatSessionRecord(sessionRecord(db, "mid")!).split("\n")).toEqual([
      "session:mid  project:-w-app  codex  started:2026-09-02T10:00:00Z  ended:2026-09-02T10:05:00Z",
      "Requests (last 1 of 1):",
      "  2026-09-02T10:00:00Z  fix the login bug",
      "Last reply: 2026-09-02T10:05:00Z  Login fixed. Next: add a regression test.",
      "Edited (2 files):",
      "  src/cache.ts  1 edits, last 2026-09-02T10:04:00Z",
      "  src/login.ts  1 edits, last 2026-09-02T10:03:00Z",
      "Git (last 1 of 1):",
      '  2026-09-02T10:04:50Z  git add -A && git commit -m "fix login"',
      "Failed tool calls (last 1 of 1):",
      "  2026-09-02T10:04:52Z  Bash: npm test",
      "Hook blocks (last 1 of 1):",
      "  2026-09-02T10:04:53Z  Stop: req-harness: you cannot finish yet.",
    ]);
    const old = formatSessionRecord(sessionRecord(db, "old")!).split("\n");
    expect(old).toContain("Last reply: 2026-09-01T10:05:00Z  Cache added; tests pass.");
    expect(formatSessionRecord(sessionRecord(db, "new")!).split("\n")).toContain("Last reply: (none)");
    expect(old).toContain("Git: (none)");
    expect(old).toContain("Failed tool calls: (none)");
    expect(old).toContain("Hook blocks: (none)");
  });
});
