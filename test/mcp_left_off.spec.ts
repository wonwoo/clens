import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySchema } from "../src/indexer/schema.js";
import { commandOf, formatLeftOff, formatSessionRecord, leftOff, sessionRecord } from "../src/mcp/left_off.js";

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
