import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { alreadyTold, failureHint, failureKey, hintKey, rememberTold } from "../src/hooks/failure_hint.js";
import { applySchema } from "../src/indexer/schema.js";
import { UTC_TIME, withTz } from "./tz.js";

let db: Database.Database;
let n = 0;

function failed(session: string, ts: string, command: string, excerpt: string, name = "Bash"): void {
  const uuid = `t${n++}`;
  db.prepare("INSERT INTO event (uuid, session_id, ts, role) VALUES (?, ?, ?, 'assistant')").run(uuid, session, ts);
  db.prepare(
    "INSERT INTO tool_call (event_uuid, session_id, ts, name, input_json, is_error, error_excerpt) VALUES (?, ?, ?, ?, ?, 1, ?)",
  ).run(uuid, session, ts, name, name === "exec" ? command : JSON.stringify(name === "Bash" ? { command } : { cmd: command }), excerpt);
}
function reply(session: string, ts: string, text: string): void {
  const uuid = `r${n++}`;
  db.prepare("INSERT INTO event (uuid, session_id, ts, role) VALUES (?, ?, ?, 'assistant')").run(uuid, session, ts);
  db.prepare("INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES (?, ?, ?, ?, 'assistant', 'assistant_message')").run(
    uuid, session, ts, text,
  );
}

const NOW = Date.parse("2026-10-23T10:00:00Z");
const GH = "Exit code 127\nzsh:1: command not found: gh";

beforeEach(() => {
  n = 0;
  db = new Database(":memory:");
  applySchema(db);
  db.exec(`
    INSERT INTO project (id, cwd) VALUES ('-w-app', '/w/app'), ('-w-web', '/w/web');
    INSERT INTO session (id, project_id, kind, parent_id, cwd, source) VALUES
      ('now', '-w-app', 'interactive', NULL, '/w/app', 'claude'),
      ('app1', '-w-app', 'interactive', NULL, '/w/app', 'codex'),
      ('web1', '-w-web', 'interactive', NULL, '/w/web', 'claude'),
      ('web2', '-w-web', 'interactive', NULL, '/w/web', 'claude'),
      ('web3', '-w-web', 'interactive', NULL, '/w/web', 'claude'),
      ('bench', '-w-app', 'exec', NULL, '/w/app', 'claude'),
      ('judge', '-w-app', 'pipeline', NULL, '/w/app', 'claude');
  `);
});

afterEach(() => db.close());

describe("failureKey", () => {
  it("names the missing command, whatever the shell says", () => {
    expect(failureKey(GH)).toEqual({ kind: "missing", key: "missing:gh" });
    expect(failureKey("(eval):1: command not found: gh")).toEqual({ kind: "missing", key: "missing:gh" });
    expect(failureKey("bash: gh: command not found")).toEqual({ kind: "missing", key: "missing:gh" });
    expect(failureKey("bash: line 1: gh: command not found")).toEqual({ kind: "missing", key: "missing:gh" });
    expect(failureKey("/bin/sh: 1: gh: not found")).toEqual({ kind: "missing", key: "missing:gh" });
    expect(failureKey("error: 'cargo-fmt' is not installed for the toolchain 'stable-aarch64-apple-darwin'.")).toEqual({
      kind: "missing",
      key: "missing:cargo-fmt",
    });
  });

  it("names the host that did not resolve", () => {
    expect(
      failureKey("fatal: unable to access 'https://git.example.com/one/x/': Could not resolve host: git.example.com"),
    ).toEqual({ kind: "network", key: "network:git.example.com" });
    expect(failureKey("ssh: Could not resolve hostname git.example.com: nodename nor servname provided, or not known")).toEqual({
      kind: "network",
      key: "network:git.example.com",
    });
    expect(failureKey("npm error getaddrinfo ENOTFOUND registry.npmjs.org")).toEqual({ kind: "network", key: "network:registry.npmjs.org" });
  });

  it("keys a refused operation by its line, numbers aside", () => {
    expect(failureKey("Exit code 1\nzsh:1: operation not permitted: ps")).toEqual({
      kind: "permission",
      key: "permission:zsh:#: operation not permitted: ps",
    });
  });

  it("leaves out failures that a retry or a search can fix", () => {
    expect(failureKey("Exit code 1\nls: compare/: No such file or directory")).toBeNull();
    expect(failureKey("process exited with code 1")).toBeNull();
    expect(failureKey("FAIL test/a.spec.ts > adds")).toBeNull();
  });

  // Codex runs the hook after every command, so a successful command whose
  // output quotes such an error (a search hit, a diff, a file) reaches it too.
  it("ignores the error text a command's output only quotes", () => {
    expect(failureKey('test/failure_hint.spec.ts:26:const GH = "Exit code 127\\nzsh:1: command not found: gh";')).toBeNull();
    expect(failureKey('+      tool_input: { command: "gh run list" }, error: "Exit code 127\\n(eval):1: command not found: gh",')).toBeNull();
    expect(failureKey("Package 'gh' is not installed, so not removed")).toBeNull();
    expect(failureKey("src/auth.ts:12:  throw new Error('permission denied')")).toBeNull();
    // grep -n over one file prints no path, only the line number.
    expect(failureKey("12:    echo 'permission denied'")).toBeNull();
    expect(failureKey("docs/net.md:3: curl: (6) Could not resolve host: example.com")).toBeNull();
  });
});

describe("failureHint", () => {
  const ghNow = { sessionId: "now", cwd: "/w/app", output: GH };

  it("shows an earlier session's failure of the same missing command, from any project, with the reply after it", () => {
    failed("web1", "2026-10-20T01:00:00Z", "gh pr list", GH);
    reply("web1", "2026-10-20T01:00:30Z", "gh is not installed here, so I pushed with git and opened the PR in the browser.");
    const hint = failureHint(db, ghNow, NOW);
    expect(hint).toContain("web1");
    expect(hint).toContain("gh pr list");
    expect(hint).toContain("gh is not installed here, so I pushed with git");
    expect(hint).toContain("2026-10-20T01:00:00Z");
  });

  it("prints the earlier failure's date and time in the server's zone", () => {
    failed("web1", "2026-10-19T16:00:00Z", "gh pr list", GH);
    const hint = withTz("Asia/Seoul", () => failureHint(db, ghNow, NOW))!;
    expect(hint).toContain("- 2026-10-20 in web: `gh pr list` (session web1, around_ts 2026-10-20T01:00:00+09:00)");
    expect(hint).not.toMatch(UTC_TIME);
  });

  it("keeps a refused operation to the same project", () => {
    const ps = "Exit code 1\nzsh:1: operation not permitted: ps";
    failed("web1", "2026-10-20T01:00:00Z", "ps -ax", ps);
    expect(failureHint(db, { sessionId: "now", cwd: "/w/app", output: ps }, NOW)).toBeNull();
    failed("app1", "2026-10-21T01:00:00Z", "ps -ax", ps, "exec_command");
    expect(failureHint(db, { sessionId: "now", cwd: "/w/app", output: ps }, NOW)).toContain("app1");
  });

  it("finds a failure inside Codex exec code, showing the command that failed", () => {
    failed(
      "app1",
      "2026-10-23T01:41:05Z",
      'const a = await tools.exec_command({cmd:"cat copyright.txt"});text(a);\nconst r = await tools.exec_command({cmd:"gh --version"});text(r);',
      "Process exited with code 127\nzsh:1: command not found: gh",
      "exec",
    );
    const hint = failureHint(db, ghNow, NOW);
    expect(hint).toContain("app1");
    expect(hint).toContain("`gh --version`");
  });

  it("finds the project of a cwd no session's project id spells", () => {
    db.exec("UPDATE session SET project_id = '-w-app-renamed' WHERE id = 'app1'");
    const ps = "zsh:1: operation not permitted: ps";
    failed("app1", "2026-10-21T01:00:00Z", "ps -ax", ps);
    expect(failureHint(db, { sessionId: "elsewhere", cwd: "/w/app", output: ps }, NOW)).toContain("app1");
  });

  it("leaves out one-shot runs and judge transcripts", () => {
    failed("bench", "2026-10-20T01:00:00Z", "gh pr list", GH);
    failed("judge", "2026-10-20T02:00:00Z", "gh pr list", GH);
    expect(failureHint(db, ghNow, NOW)).toBeNull();
  });

  it("says nothing when no earlier session had the failure", () => {
    expect(failureHint(db, ghNow, NOW)).toBeNull();
    expect(failureHint(db, { ...ghNow, output: "ls: x: No such file or directory" }, NOW)).toBeNull();
  });

  it("says it once per session: an earlier same failure in this session means the hint was given", () => {
    failed("web1", "2026-10-20T01:00:00Z", "gh pr list", GH);
    failed("now", "2026-10-23T09:50:00Z", "gh auth status", GH);
    expect(failureHint(db, ghNow, NOW)).toBeNull();
  });

  it("does not take the failure being reported, already indexed, for an earlier one", () => {
    failed("web1", "2026-10-20T01:00:00Z", "gh pr list", GH);
    failed("now", "2026-10-23T09:59:55Z", "gh run list", GH);
    const hint = failureHint(db, ghNow, NOW);
    expect(hint).toContain("web1");
    expect(hint).not.toContain("session now");
  });

  it("counts this session's own earlier failure in a one-shot run too", () => {
    db.exec("UPDATE session SET kind = 'exec' WHERE id = 'now'");
    failed("web1", "2026-10-20T01:00:00Z", "gh pr list", GH);
    failed("now", "2026-10-23T09:50:00Z", "gh auth status", GH);
    expect(failureHint(db, ghNow, NOW)).toBeNull();
  });

  it("counts a failure in this session's own subagent as this session's", () => {
    db.exec("INSERT INTO session (id, project_id, kind, parent_id, cwd, source) VALUES ('now-agent', '-w-app', 'subagent', 'now', '/w/app', 'claude')");
    failed("web1", "2026-10-20T01:00:00Z", "gh pr list", GH);
    failed("now-agent", "2026-10-23T09:50:00Z", "gh auth status", GH);
    expect(failureHint(db, ghNow, NOW)).toBeNull();
  });

  // The stored excerpt keeps the first 100 and last 200 characters of the
  // output; the failure being reported is keyed from the same cut, or a key
  // found only in the middle of a long output would never match its own
  // stored copy, and the hint would repeat.
  it("keys the failure from the same excerpt the index stores", () => {
    const missing = "sh: 1: node-gyp: not found";
    failed("web1", "2026-10-20T01:00:00Z", "node-gyp rebuild", missing);
    const filler = "npm warn deprecated some-package@1.0.0\n".repeat(10);
    const output = `Exit code 1\n${filler}${missing}\n${filler}npm error A complete log of this run can be found in: /tmp/x.log`;
    expect(failureHint(db, { sessionId: "now", cwd: "/w/app", output }, NOW)).toBeNull();
    expect(failureHint(db, { sessionId: "now", cwd: "/w/app", output: missing }, NOW)).toContain("web1");
  });

  it("lists at most two earlier sessions, newest first, and a reply only from the minutes after the failure", () => {
    failed("web1", "2026-10-18T01:00:00Z", "gh a", GH);
    failed("web2", "2026-10-19T01:00:00Z", "gh b", GH);
    reply("web2", "2026-10-19T03:00:00Z", "Much later, about something else.");
    failed("web3", "2026-10-20T01:00:00Z", "gh c", GH);
    failed("web3", "2026-10-20T01:01:00Z", "gh d", GH);
    const hint = failureHint(db, ghNow, NOW)!;
    expect(hint.indexOf("web3")).toBeGreaterThanOrEqual(0);
    expect(hint.indexOf("web3")).toBeLessThan(hint.indexOf("web2"));
    expect(hint).not.toContain("web1");
    expect(hint).not.toContain("Much later");
    expect(hint.match(/web3/g)).toHaveLength(1);
  });

  // The first reply after a failure is often a progress note about the task
  // as a whole; one that names what failed is more likely about the failure.
  it("takes the first reply that names the missing command, as a word", () => {
    failed("web1", "2026-10-20T01:00:00Z", "gh pr list", GH);
    reply("web1", "2026-10-20T01:00:10Z", "Checking the git config and the keychain now.");
    reply("web1", "2026-10-20T01:00:20Z", "Opened it on github.com instead.");
    reply("web1", "2026-10-20T01:00:30Z", "`gh` is missing, so I used the GitHub MCP tools.");
    const hint = failureHint(db, ghNow, NOW)!;
    expect(hint).toContain("next reply: `gh` is missing, so I used the GitHub MCP tools.");
    expect(hint).not.toContain("keychain");
    expect(hint).not.toContain("github.com instead");
  });

  it("leaves the reply out when none names what failed", () => {
    failed("web1", "2026-10-20T01:00:00Z", "gh pr list", GH);
    reply("web1", "2026-10-20T01:00:10Z", "Checking the git config and the keychain now.");
    const hint = failureHint(db, ghNow, NOW)!;
    expect(hint).toContain("web1");
    expect(hint).not.toContain("next reply");
  });

  it("goes by the program of the refused command, and by the host of a network failure", () => {
    const ps = "zsh:1: operation not permitted: ps";
    failed("app1", "2026-10-21T01:00:00Z", "ps -ax | rg codex", ps);
    reply("app1", "2026-10-21T01:00:10Z", "Looking at the process list another way.");
    reply("app1", "2026-10-21T01:00:20Z", "The sandbox blocks ps, so I read the PID file instead.");
    expect(failureHint(db, { sessionId: "now", cwd: "/w/app", output: ps }, NOW)).toContain(
      "next reply: The sandbox blocks ps, so I read the PID file instead.",
    );
    const host = "curl: (6) Could not resolve host: registry.example.com";
    failed("app1", "2026-10-21T02:00:00Z", "curl -sS https://registry.example.com/x", host);
    reply("app1", "2026-10-21T02:00:10Z", "Retrying with a longer timeout.");
    reply("app1", "2026-10-21T02:00:20Z", "registry.example.com only resolves on the VPN.");
    expect(failureHint(db, { sessionId: "now", cwd: "/w/app", output: host }, NOW)).toContain(
      "next reply: registry.example.com only resolves on the VPN.",
    );
  });
});

describe("hintKey", () => {
  it("keys an output by the excerpt the index stores for it", () => {
    expect(hintKey("Exit code 127\nzsh:1: command not found: gh")).toEqual({ kind: "missing", key: "missing:gh" });
    const filler = "npm warn deprecated some-package@1.0.0\n".repeat(10);
    expect(hintKey(`${filler}sh: 1: node-gyp: not found\n${filler}npm error code 127`)).toBeNull();
  });
});

// Codex stores the commands it runs in code mode as `exec` calls whose output
// is wrapped in JSON, so the index cannot tell that a session was told.
describe("alreadyTold / rememberTold", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clens-told-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("remembers per session which failures it told about", () => {
    expect(alreadyTold(dir, "s1", "missing:gh")).toBe(false);
    rememberTold(dir, "s1", "missing:gh", NOW);
    expect(alreadyTold(dir, "s1", "missing:gh")).toBe(true);
    expect(alreadyTold(dir, "s1", "missing:cargo-fmt")).toBe(false);
    expect(alreadyTold(dir, "s2", "missing:gh")).toBe(false);
  });

  it("creates its folder, and keeps a session id from naming a path", () => {
    const nested = join(dir, "hints-seen");
    rememberTold(nested, "../escape", "missing:gh", NOW);
    expect(alreadyTold(nested, "../escape", "missing:gh")).toBe(true);
    expect(existsSync(join(dir, "escape"))).toBe(false);
  });

  it("removes the notes of sessions untouched for a week when it writes", () => {
    const old = join(dir, "old-session");
    writeFileSync(old, "missing:gh\n");
    const eightDaysAgo = (NOW - 8 * 24 * 60 * 60_000) / 1000;
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    rememberTold(dir, "new-session", "missing:gh", NOW);
    expect(existsSync(old)).toBe(false);
    expect(alreadyTold(dir, "new-session", "missing:gh")).toBe(true);
  });
});
