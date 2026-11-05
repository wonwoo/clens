import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySchema } from "../src/indexer/schema.js";
import {
  branchChecks, branchParamsError, checksOfCall, formatBranchChecks, formatRecentBranches, recentBranches, whereOfUrl,
} from "../src/mcp/checks.js";
import { UTC_TIME, withTz } from "./tz.js";

const bash = (command: string) => checksOfCall("Bash", JSON.stringify({ command }));
const kinds = (command: string) => bash(command).map((c) => c.kind);

describe("checksOfCall — test runs", () => {
  it.each([
    ['./gradlew :core:test --tests "a.B"', './gradlew :core:test --tests "a.B"'],
    ["timeout 580 ./gradlew --offline -q :core:test", "./gradlew --offline -q :core:test"],
    ["npm test 2>&1 | tail", "npm test 2>&1"],
    ["npx vitest run x", "npx vitest run x"],
    ["cd app && pytest -q", "pytest -q"],
    ["(cd app && npm test)", "npm test"],
    ["L=/tmp/g.log; ./gradlew :core:test > $L 2>&1", "./gradlew :core:test > $L 2>&1"],
    ["go test ./...", "go test ./..."],
    ["./gradlew check", "./gradlew check"],
  ])("%s is one local test run", (command, target) => {
    expect(bash(command)).toEqual([{ kind: "test", where: "local", host: null, target }]);
  });

  it.each([
    "./gradlew spotlessCheck",
    'grep -n "a\\|vitest" f',
    'echo "npm test"',
    "echo '$(pytest -q)'",
    "python3 - <<'EOF'\nimport os; npx vitest\nEOF",
    // A comment is not part of the command.
    "./gradlew tasks # test",
  ])("%s is no check", (command) => {
    expect(bash(command)).toEqual([]);
  });

  it("reads the command a whole-command sh -c runs", () => {
    expect(bash("/bin/zsh -lc 'npm test'")).toEqual([{ kind: "test", where: "local", host: null, target: "npm test" }]);
    expect(bash('bash -lc "cd app && pytest -q"')).toEqual([{ kind: "test", where: "local", host: null, target: "pytest -q" }]);
    // A backslash ending a line continues the command on the next.
    expect(bash('bash -lc "npm \\\ntest"')).toEqual([{ kind: "test", where: "local", host: null, target: "npm test" }]);
    // '\'' closes the quote, adds a quote and opens it again: one shell word.
    expect(bash("bash -lc 'npm test -- --testNamePattern='\\''login'\\'''")).toEqual([
      { kind: "test", where: "local", host: null, target: "npm test -- --testNamePattern='login'" },
    ]);
  });
});

describe("checksOfCall — HTTP calls", () => {
  it.each([
    ["curl -s http://localhost:8282/x", "local", "localhost:8282", "http://localhost:8282/x"],
    ["curl https://search-prod.es.example.net:9200/_cat", "prod", "search-prod.es.example.net:9200",
      "https://search-prod.es.example.net:9200/_cat"],
    // "dev" here is the top-level domain, not an environment.
    ["curl -sL https://technical-writing.dev/a", "other", "technical-writing.dev", "https://technical-writing.dev/a"],
    ["wget https://cbt-shop.example.com/", "cbt", "cbt-shop.example.com", "https://cbt-shop.example.com/"],
    ["curl http://10.0.0.1/", "other", "10.0.0.1", "http://10.0.0.1/"],
  ])("%s is an api check on %s", (command, where, host, target) => {
    expect(bash(command)).toEqual([{ kind: "api", where, host, target }]);
  });

  it("takes the URL whole when it is quoted, ending at the quote", () => {
    expect(bash("curl -s 'http://localhost:8080/a?b=1' | jq .")).toEqual([
      { kind: "api", where: "local", host: "localhost:8080", target: "http://localhost:8080/a?b=1" },
    ]);
  });

  it("is no check when curl is only quoted text", () => {
    expect(bash('echo "curl http://localhost/"')).toEqual([]);
  });

  it("reads a command continued over lines", () => {
    expect(bash("curl -s \\\nhttp://localhost:8080/h")).toEqual([
      { kind: "api", where: "local", host: "localhost:8080", target: "http://localhost:8080/h" },
    ]);
    expect(bash("./gradlew \\\n:core:test")).toEqual([{ kind: "test", where: "local", host: null, target: "./gradlew :core:test" }]);
    // Inside '…' a backslash and a line break are text, and the quote still closes.
    expect(kinds("echo 'a\\\nb'; npm test")).toEqual(["test"]);
    // A comment ends at its line, backslash or not; so does a heredoc body line.
    expect(kinds("# explanation \\\nnpm test")).toEqual(["test"]);
    expect(kinds("cat <<'EOF'\ntext\\\nEOF\nnpm test")).toEqual(["test"]);
  });

  it("takes no URL from a comment", () => {
    expect(bash("curl --version # https://api.prod.example.com/health")).toEqual([]);
  });
});

describe("checksOfCall — browser pages", () => {
  it("is a page check for a navigate tool with a url", () => {
    expect(checksOfCall("mcp__playwright__browser_navigate", '{"url":"http://localhost:3000/a"}')).toEqual([
      { kind: "browser", where: "local", host: "localhost:3000", target: "http://localhost:3000/a" },
    ]);
  });

  it("is no check without a url or with a cut input", () => {
    expect(checksOfCall("mcp__playwright__browser_navigate_back", "{}")).toEqual([]);
    expect(checksOfCall("mcp__playwright__browser_navigate", '{"url":"http://localh')).toEqual([]);
  });
});

describe("checksOfCall — git push and merge", () => {
  it("is one git check per push or merge command, the command alone", () => {
    expect(bash("git push origin dev-deploy")).toEqual([
      { kind: "git", where: "", host: null, target: "git push origin dev-deploy" },
    ]);
    expect(bash("git checkout sandbox-deploy && git merge --ff-only feature/x")).toEqual([
      { kind: "git", where: "", host: null, target: "git merge --ff-only feature/x" },
    ]);
  });

  it("is no check for merge-base or an aborted merge", () => {
    expect(kinds("git merge-base HEAD main")).toEqual([]);
    expect(kinds("git merge --abort")).toEqual([]);
  });
});

describe("checksOfCall — Codex exec code", () => {
  it("reads the commands exec code runs", () => {
    expect(checksOfCall("exec", 'tools.exec_command({cmd:"npm test"})')).toEqual([
      { kind: "test", where: "local", host: null, target: "npm test" },
    ]);
  });

  // Older Codex recorded a shell command as an exec_command_begin event,
  // stored as an exec call whose input is the command's words joined.
  it("reads an older Codex exec call's shell command", () => {
    expect(checksOfCall("exec", "bash -lc npm test")).toEqual([
      { kind: "test", where: "local", host: null, target: "npm test" },
    ]);
  });
});

describe("whereOfUrl", () => {
  it("is local for a loopback address", () => {
    expect(whereOfUrl("http://127.0.0.1:7777/")).toEqual({ where: "local", host: "127.0.0.1:7777" });
    expect(whereOfUrl("http://[::1]:3000/")).toEqual({ where: "local", host: "[::1]:3000" });
  });

  it("is null for what is not an http or https URL", () => {
    expect(whereOfUrl("ftp://x/")).toBeNull();
    expect(whereOfUrl("not a url")).toBeNull();
  });
});

/** A tool call, with the event row that owns it unless owner is null. */
function call(db: Database.Database, c: {
  uuid: string; session: string; ts: string; name?: string; input: unknown; branch: string | null; isError?: 0 | 1;
  owner?: string | null;
}): void {
  const owner = c.owner === undefined ? c.session : c.owner;
  if (owner !== null) db.prepare("INSERT INTO event (uuid, session_id, ts, role) VALUES (?, ?, ?, 'assistant')").run(c.uuid, owner, c.ts);
  db.prepare(`INSERT INTO tool_call (event_uuid, session_id, ts, call_id, name, input_json, is_error, git_branch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    c.uuid, c.session, c.ts, `call-${c.uuid}-${c.session}`, c.name ?? "Bash",
    typeof c.input === "string" ? c.input : JSON.stringify(c.input), c.isError ?? 0, c.branch,
  );
}

const T = (hhmm: string) => `2026-10-01T${hhmm}:00Z`;

/** Sessions A-H of the design's step 4: A, B (A's subagent), C (Codex) and E
 *  ran checks on feature/x, D merged it from main, E's calls predate the
 *  git_branch column, and F (another project), G (an exec run) and H (a
 *  resumed copy of B's call) add nothing. */
function branchFixture(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  db.exec(`
    INSERT INTO project (id, cwd) VALUES ('-w-app', '/w/app'), ('-w-web', '/w/web');
    INSERT INTO session (id, project_id, kind, parent_id, cwd, git_branch, source) VALUES
      ('A', '-w-app', 'interactive', NULL, '/w/app', 'main', 'claude'),
      ('B', '-w-app', 'subagent', 'A', '/w/app', 'feature/x', 'claude'),
      ('C', '-w-app', 'interactive', NULL, '/w/app', 'feature/x', 'codex'),
      ('D', '-w-app', 'interactive', NULL, '/w/app', 'main', 'claude'),
      ('E', '-w-app', 'interactive', NULL, '/w/app', 'feature/x', 'claude'),
      ('F', '-w-web', 'interactive', NULL, '/w/web', 'feature/x', 'claude'),
      ('G', '-w-app', 'exec', NULL, '/w/app', 'feature/x', 'claude'),
      ('H', '-w-app', 'interactive', NULL, '/w/app', 'feature/x', 'claude');
  `);
  call(db, { uuid: "a1", session: "A", ts: T("09:00"), input: { command: "ls" }, branch: "main" });
  call(db, { uuid: "a2", session: "A", ts: T("10:00"), input: { command: "npm test" }, branch: "feature/x" });
  call(db, { uuid: "a3", session: "A", ts: T("10:05"), input: { command: "curl http://localhost:8080/h" }, branch: "feature/x" });
  call(db, { uuid: "b1", session: "B", ts: T("10:10"), input: { command: "npx vitest run" }, branch: "feature/x" });
  call(db, {
    uuid: "c1", session: "C", ts: T("10:20"), name: "exec_command", input: { cmd: "curl https://api.sandbox.example.com/v1" },
    branch: "feature/x", isError: 1,
  });
  call(db, {
    uuid: "d1", session: "D", ts: T("10:30"), input: { command: "git checkout sandbox-deploy && git merge feature/x" }, branch: "main",
  });
  call(db, { uuid: "e1", session: "E", ts: T("10:40"), input: { command: "pytest" }, branch: null });
  call(db, { uuid: "f1", session: "F", ts: T("10:50"), input: { command: "npm test" }, branch: "feature/x" });
  call(db, { uuid: "g1", session: "G", ts: T("10:55"), input: { command: "npm test" }, branch: "feature/x" });
  // H resumed B's conversation: the same uuid, whose event B owns.
  call(db, { uuid: "b1", session: "H", ts: T("10:10"), input: { command: "npx vitest run" }, branch: "feature/x", owner: null });
  return db;
}

describe("branchChecks", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = branchFixture();
  });
  afterEach(() => db.close());

  it("lists the sessions that made a call on the branch, and the checks and git lines on it or naming it", () => {
    const r = branchChecks(db, { project_id: "-w-app", branch: "feature/x" });
    // B is A's subagent: its call is A's, so B is not listed on its own.
    expect(r.sessions).toEqual([
      { session_id: "A", source: "claude", first_ts: T("10:00"), last_ts: T("10:10"), start_branch_only: false, subagents: 1 },
      { session_id: "C", source: "codex", first_ts: T("10:20"), last_ts: T("10:20"), start_branch_only: false, subagents: 0 },
      { session_id: "E", source: "claude", first_ts: T("10:40"), last_ts: T("10:40"), start_branch_only: true, subagents: 0 },
    ]);
    expect(r.sessions_total).toBe(3);
    expect(r.groups).toEqual([
      { kind: "api", where: "local", host: "localhost:8080", count: 1, failed: 0, last_ts: T("10:05"),
        last_target: "http://localhost:8080/h", last_session: "A" },
      { kind: "api", where: "sandbox", host: "api.sandbox.example.com", count: 1, failed: 1, last_ts: T("10:20"),
        last_target: "https://api.sandbox.example.com/v1", last_session: "C" },
      { kind: "test", where: "local", host: null, count: 3, failed: 0, last_ts: T("10:40"), last_target: "pytest", last_session: "E" },
    ]);
    expect(r.groups_total).toBe(3);
    expect(r.git).toEqual([{ ts: T("10:30"), session_id: "D", line: "git merge feature/x", failed: false }]);
    expect(r.git_total).toBe(1);
  });

  it("lists a nested subagent under the top session, and one whose parent is not indexed as itself", () => {
    db.exec(`INSERT INTO session (id, project_id, kind, parent_id, cwd, git_branch, source) VALUES
      ('B2', '-w-app', 'subagent', 'B', '/w/app', 'feature/x', 'claude'),
      ('Z', '-w-app', 'subagent', 'GONE', '/w/app', 'feature/x', 'claude')`);
    call(db, { uuid: "b2", session: "B2", ts: T("10:12"), input: { command: "npm test" }, branch: "feature/x" });
    call(db, { uuid: "z1", session: "Z", ts: T("10:45"), input: { command: "npm test" }, branch: "feature/x" });
    const r = branchChecks(db, { project_id: "-w-app", branch: "feature/x" });
    expect(r.sessions.map((s) => [s.session_id, s.last_ts, s.subagents])).toEqual([
      ["A", T("10:12"), 2], ["C", T("10:20"), 0], ["E", T("10:40"), 0], ["Z", T("10:45"), 0],
    ]);
  });

  it("leaves out what happened before since", () => {
    const r = branchChecks(db, { project_id: "-w-app", branch: "feature/x", since: T("10:06") });
    expect(r.sessions.map((s) => [s.session_id, s.first_ts, s.subagents])).toEqual([["A", T("10:10"), 1], ["C", T("10:20"), 0], ["E", T("10:40"), 0]]);
    expect(r.groups.map((g) => [g.kind, g.where, g.count])).toEqual([["api", "sandbox", 1], ["test", "local", 2]]);
  });

  it("falls back to the session's starting branch on an index without the git_branch column", () => {
    // applySchema would add the column back, so it is not called again.
    db.exec("ALTER TABLE tool_call DROP COLUMN git_branch");
    const onX = branchChecks(db, { project_id: "-w-app", branch: "feature/x" });
    // A started on main, so only its subagent B's call puts it on feature/x.
    expect(onX.sessions.find((s) => s.session_id === "A")).toMatchObject({ first_ts: T("10:10"), subagents: 1 });
    expect(onX.sessions.find((s) => s.session_id === "E")).toMatchObject({ start_branch_only: true });
    expect(onX.groups.find((g) => g.kind === "test")).toMatchObject({ count: 2, last_session: "E" });
    const onMain = branchChecks(db, { project_id: "-w-app", branch: "main" });
    expect(onMain.sessions.map((s) => s.session_id)).toEqual(["A", "D"]);
    expect(onMain.groups.map((g) => [g.kind, g.where, g.count])).toEqual([["test", "local", 1], ["api", "local", 1]]);
  });

  it("prints sessions, checks and git lines, and one line when there is nothing", () => {
    expect(formatBranchChecks(branchChecks(db, { project_id: "-w-app", branch: "feature/x" }))).toBe([
      "Branch feature/x in -w-app",
      "Sessions on it (last 3 of 3), first and last call on it:",
      `  A  claude  ${T("10:00")} – ${T("10:10")}  (+1 subagent)`,
      `  C  codex  ${T("10:20")} – ${T("10:20")}`,
      `  E  claude  ${T("10:40")} – ${T("10:40")}  (branch from the session's start)`,
      "Checks (last 3 of 3, by kind and host):",
      `  api local localhost:8080: 1 call, 0 failed, last ${T("10:05")}: http://localhost:8080/h (session A)`,
      `  api sandbox api.sandbox.example.com: 1 call, 1 failed, last ${T("10:20")}: https://api.sandbox.example.com/v1 (session C)`,
      `  test local: 3 runs, 0 failed, last ${T("10:40")}: pytest (session E)`,
      "Git push and merge on it or naming it (last 1 of 1):",
      `  ${T("10:30")}  git merge feature/x  (session D)`,
      "A check that did not fail exited 0 or got no result (stopped or still running); clens keeps no output of a call that succeeded, so read the reply after a check with clens_session (its session and time) to know what it returned.",
    ].join("\n"));
    expect(formatBranchChecks(branchChecks(db, { project_id: "-w-app", branch: "nope" }))).toBe(
      "No session in -w-app made a call on branch nope, and no git push or merge names it. Pass branches: true for the project's branches.",
    );
  });

  it("prints sessions, checks and git lines in the server's zone", () => {
    const out = withTz("Asia/Seoul", () => formatBranchChecks(branchChecks(db, { project_id: "-w-app", branch: "feature/x" })));
    expect(out).toContain("  A  claude  2026-10-01T19:00:00+09:00 – 2026-10-01T19:10:00+09:00  (+1 subagent)");
    expect(out).toContain("1 call, 0 failed, last 2026-10-01T19:05:00+09:00: http://localhost:8080/h (session A)");
    expect(out).toContain("  2026-10-01T19:30:00+09:00  git merge feature/x  (session D)");
    expect(out).not.toMatch(UTC_TIME);
  });
});

describe("branchChecks — git lines naming the branch", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('-w-app', '/w/app');
      INSERT INTO session (id, project_id, kind, cwd, git_branch, source) VALUES ('N', '-w-app', 'interactive', '/w/app', 'main', 'claude');
    `);
    [
      "git push origin feature/x-2",
      "git push origin feature/x",
      "git push origin abc123:refs/heads/feature/x",
      "git merge origin/feature/x",
    ].forEach((command, i) => call(db, { uuid: `n${i}`, session: "N", ts: T(`11:0${i}`), input: { command }, branch: "main" }));
  });
  afterEach(() => db.close());

  it("keeps a git line run elsewhere that names the branch whole, and no session", () => {
    const r = branchChecks(db, { project_id: "-w-app", branch: "feature/x" });
    expect(r.git.map((g) => g.line)).toEqual([
      "git push origin feature/x",
      "git push origin abc123:refs/heads/feature/x",
      "git merge origin/feature/x",
    ]);
    expect(r.sessions).toEqual([]);
    expect(formatBranchChecks(r).split("\n").slice(0, 3)).toEqual([
      "Branch feature/x in -w-app",
      "Sessions on it: (none)",
      "Checks: (none)",
    ]);
  });
});

describe("recentBranches", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = branchFixture();
    db.exec(`
      INSERT INTO session (id, project_id, kind, cwd, git_branch, source) VALUES
        ('I', '-w-app', 'interactive', '/w/app', 'HEAD', 'claude'),
        ('J', '-w-app', 'interactive', '/w/app', NULL, 'claude');
    `);
    call(db, { uuid: "i1", session: "I", ts: T("11:00"), input: { command: "npm test" }, branch: "HEAD" });
    call(db, { uuid: "j1", session: "J", ts: T("11:05"), input: { command: "npm test" }, branch: null });
  });
  afterEach(() => db.close());

  it("lists the project's branches by their latest call, without HEAD or none, each with its sessions and checks", () => {
    const r = recentBranches(db, { project_id: "-w-app" });
    expect(r.more).toBe(0);
    expect(r.branches).toEqual([
      {
        branch: "feature/x", last_ts: T("10:40"), sessions: 3,
        checks: [
          { label: "test local", count: 3 }, { label: "api local", count: 1 }, { label: "api sandbox", count: 1 }, { label: "git", count: 1 },
        ],
      },
      { branch: "main", last_ts: T("10:30"), sessions: 2, checks: [{ label: "git", count: 1 }] },
    ]);
    expect(recentBranches(db, { project_id: "-w-app", limit: 1 })).toMatchObject({ branches: [{ branch: "feature/x" }], more: 1 });
  });

  it("prints one line per branch, how many more there are, and one line when there is none", () => {
    expect(formatRecentBranches("-w-app", recentBranches(db, { project_id: "-w-app" }))).toBe([
      "Branches in -w-app, latest first:",
      `[1] feature/x  last ${T("10:40")}  3 sessions  checks: test local 3, api local 1, api sandbox 1, git 1`,
      `[2] main  last ${T("10:30")}  2 sessions  checks: git 1`,
      "Pass branch with one of them for its checks.",
    ].join("\n"));
    expect(formatRecentBranches("-w-app", recentBranches(db, { project_id: "-w-app", limit: 1 }))).toBe([
      "Branches in -w-app, latest first:",
      `[1] feature/x  last ${T("10:40")}  3 sessions  checks: test local 3, api local 1, api sandbox 1, git 1`,
      "(+1 more branch; raise limit, max 10)",
      "Pass branch with one of them for its checks.",
    ].join("\n"));
    expect(formatRecentBranches("-w-app", recentBranches(db, { project_id: "-w-app", until: T("09:30") }))).toBe([
      "Branches in -w-app, latest first:",
      `[1] main  last ${T("09:00")}  1 session  checks: none`,
      "Pass branch with one of them for its checks.",
    ].join("\n"));
    expect(formatRecentBranches("-w-none", recentBranches(db, { project_id: "-w-none" }))).toBe("No branch recorded in -w-none.");
  });

  it("prints each branch's last time in the server's zone", () => {
    const out = withTz("Asia/Seoul", () => formatRecentBranches("-w-app", recentBranches(db, { project_id: "-w-app" })));
    expect(out).toContain("[1] feature/x  last 2026-10-01T19:40:00+09:00  3 sessions");
    expect(out).not.toMatch(UTC_TIME);
  });
});

describe("branch queries — plan", () => {
  it("reads only the project's calls, by session, not every call in the index", () => {
    // With tool_call as the outer loop they read the whole table: about a
    // second on a 575 MB index whose pages were not cached, against 0.2 s.
    const db = branchFixture();
    const prepare = db.prepare.bind(db);
    const statements: string[] = [];
    db.prepare = ((sql: string) => {
      statements.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    branchChecks(db, { project_id: "-w-app", branch: "feature/x" });
    recentBranches(db, { project_id: "-w-app" });
    const callQueries = statements.filter((sql) => sql.includes("FROM session s CROSS JOIN tool_call t") || sql.includes("tool_call t JOIN"));
    expect(new Set(callQueries).size).toBe(3);
    for (const sql of new Set(callQueries)) {
      const args = Array<null>((sql.match(/\?/g) ?? []).length).fill(null);
      const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((p) => p.detail);
      expect(plan).toContain("SEARCH t USING INDEX tool_session_idx (session_id=?)");
    }
    db.close();
  });
});

describe("branchParamsError", () => {
  it("needs project_id, one of branch and branches, and none of file, text and commits", () => {
    expect(branchParamsError({ branch: "x" })).toBe("branch and branches need project_id, the project the branch is in");
    expect(branchParamsError({ project_id: "-w", branch: "x", branches: true })).toBe("pass branch or branches, not both");
    expect(branchParamsError({ project_id: "-w", branches: true, file: "a.ts" })).toBe("branch and branches take no file, text or commits");
    expect(branchParamsError({ project_id: "-w", branch: "x", commits: ["c"] })).toBe("branch and branches take no file, text or commits");
    expect(branchParamsError({ project_id: "-w", branch: "x" })).toBeNull();
    expect(branchParamsError({ project_id: "-w", branches: true })).toBeNull();
  });
});
