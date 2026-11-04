/**
 * Checks: the tool calls that verified a piece of work. A test run, an HTTP
 * call to a server, a browser page opened, and a git push or merge, read
 * off a stored call's input. clens keeps no output of a call that succeeded,
 * so a check says what was run, where, and whether it failed, not what it
 * returned.
 */

import type Database from "better-sqlite3";

import { notCopiedClause, TOP, workKindClause } from "../analyzer/scope.js";
import { cutChars, escapeRegExp } from "./search.js";
import { executedCommands, shellCommands } from "./shell_text.js";

export type CheckKind = "test" | "api" | "browser" | "git";

/** where: "local", an environment word from the host (whereOfUrl), "other",
 *  or "" for git. host: the URL's host with its port, null for test and git.
 *  target: the simple command for test and git, the URL for api and browser. */
export interface CallCheck { kind: CheckKind; where: string; host: string | null; target: string }

/** Words a host label can name an environment with. */
const ENVIRONMENTS = new Set([
  "dev", "develop", "development", "sandbox", "staging", "stage", "stg", "qa", "test", "cbt", "beta", "preprod", "prod",
  "production",
]);

/** Where a URL points: "local" for this machine, else the first label of the
 *  host that names an environment, else "other"; null when it is not an
 *  http or https URL. The top-level domain is not a label here: in the index,
 *  hosts such as technical-writing.dev took "dev" from it. */
export function whereOfUrl(url: string): { where: string; host: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "0.0.0.0"
    || hostname === "::1" || hostname === "host.docker.internal" || hostname.startsWith("127.");
  if (local) return { where: "local", host: parsed.host };
  const labels = hostname.split(".").slice(0, -1).flatMap((l) => l.split("-"));
  return { where: labels.find((l) => ENVIRONMENTS.has(l)) ?? "other", host: parsed.host };
}

const SHELL_TOOLS = new Set(["Bash", "exec_command", "exec"]);
/** A browser tool that opens a page: playwright's browser_navigate,
 *  chrome-devtools' navigate_page, Claude in Chrome's navigate. */
const BROWSER_TOOL = /(?:^|__)(?:browser_navigate|navigate_page|navigate)$/;
/** The first http or https URL in a word, ending before whitespace, a
 *  quote, a backslash or a closing parenthesis. */
const URL_IN_TEXT = /https?:\/\/[^\s'"\\)]+/;
const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https", "xh"]);

const base = (word: string): string => word.slice(word.lastIndexOf("/") + 1);
const TEST_PROGRAMS = new Set(["vitest", "jest", "mocha", "pytest", "py.test", "tox", "nox", "rspec", "phpunit"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const JS_RUNNERS = new Set(["vitest", "jest", "mocha"]);
/** Programs whose subcommand `test` (or the word given) runs the tests. */
const TEST_SUBCOMMANDS: Record<string, string[]> = {
  go: ["test"], cargo: ["test", "nextest"], dotnet: ["test"], swift: ["test"], deno: ["test"], bun: ["test"],
  mix: ["test"], rails: ["test"], make: ["test", "check"],
};

/** Whether a program and its arguments run tests. */
function isTestRun(argv: string[]): boolean {
  const program = base(argv[0]!);
  const [second, third] = [argv[1], argv[2]];
  const isTestScript = (word: string | undefined) => word === "test" || (word?.startsWith("test:") ?? false);
  // A gradle task, not an option: `spotlessCheck` is a lint, not a test.
  if (program === "gradle" || program === "gradlew") {
    return argv.slice(1).some((a) => !a.startsWith("-")
      && (a === "test" || a === "check" || a.endsWith(":test") || a.endsWith(":check") || a.endsWith("Test")));
  }
  if (program === "mvn" || program === "mvnw") return argv.slice(1).some((a) => ["test", "verify", "integration-test"].includes(a));
  if (PACKAGE_MANAGERS.has(program) && (isTestScript(second) || (second === "run" && isTestScript(third)))) return true;
  const runner = program === "npx" || program === "yarn" || program === "bunx" ? 1
    : program === "pnpm" && (second === "exec" || second === "dlx") ? 2 : 0;
  if (runner > 0) {
    const next = argv[runner];
    if (next !== undefined && (JS_RUNNERS.has(next) || (next === "playwright" && argv[runner + 1] === "test"))) return true;
  }
  if (TEST_PROGRAMS.has(program)) return true;
  if ((program === "python" || program === "python3") && second === "-m" && third === "pytest") return true;
  if (second !== undefined && TEST_SUBCOMMANDS[program]?.includes(second)) return true;
  if (program === "bundle" && second === "exec") return third === "rspec" || (third === "rails" && argv[3] === "test");
  return false;
}

/** Whether a program and its arguments are a git push or a merge that
 *  merges: not merge-base, and not merge --abort, --continue or --quit. */
function isGitPushOrMerge(argv: string[]): boolean {
  if (base(argv[0]!) !== "git") return false;
  const sub = argv[1] === "-C" ? 3 : 1;
  if (argv[sub] === "push") return true;
  return argv[sub] === "merge" && !["--abort", "--continue", "--quit"].includes(argv[sub + 1] ?? "");
}

/** The checks one call made: a test run, an HTTP call, or a git push or
 *  merge per program its shell text runs (executedCommands, which reads it
 *  as the shell does), or the page a browser tool opened. */
export function checksOfCall(name: string, inputJson: string | null): CallCheck[] {
  if (BROWSER_TOOL.test(name)) {
    let url: unknown;
    try {
      url = (JSON.parse(inputJson ?? "") as { url?: unknown } | null)?.url;
    } catch {
      // A cut input is not valid JSON.
      return [];
    }
    const at = typeof url === "string" ? whereOfUrl(url) : null;
    return at === null ? [] : [{ kind: "browser", where: at.where, host: at.host, target: url as string }];
  }
  if (!SHELL_TOOLS.has(name)) return [];
  const checks: CallCheck[] = [];
  for (const command of shellCommands(name, inputJson)) {
    for (const { argv, text } of executedCommands(command)) {
      if (isTestRun(argv)) {
        checks.push({ kind: "test", where: "local", host: null, target: text });
      } else if (HTTP_CLIENTS.has(base(argv[0]!))) {
        const url = argv.slice(1).map((a) => URL_IN_TEXT.exec(a)?.[0]).find((u) => u !== undefined);
        const at = url === undefined ? null : whereOfUrl(url);
        if (at !== null) checks.push({ kind: "api", where: at.where, host: at.host, target: url! });
      } else if (isGitPushOrMerge(argv)) {
        checks.push({ kind: "git", where: "", host: null, target: text });
      }
    }
  }
  return checks;
}

/** One call's checks with the call's session, time and is_error. */
export interface CheckRow { session_id: string; ts: string; is_error: number; check: CallCheck }

/** Checks of one kind, where and host (git excluded). */
export interface CheckGroup {
  kind: "test" | "api" | "browser"; where: string; host: string | null;
  count: number; failed: number; last_ts: string; last_target: string; last_session: string;
}

/** Groups of the non-git rows, ordered by last_ts, oldest first; rows in ts order. */
export function groupChecks(rows: CheckRow[]): CheckGroup[] {
  const groups = new Map<string, CheckGroup>();
  for (const { session_id, ts, is_error, check } of rows) {
    if (check.kind === "git") continue;
    const key = JSON.stringify([check.kind, check.where, check.host]);
    const g = groups.get(key) ?? {
      kind: check.kind, where: check.where, host: check.host, count: 0, failed: 0, last_ts: ts, last_target: "", last_session: "",
    };
    g.count += 1;
    if (is_error === 1) g.failed += 1;
    g.last_ts = ts;
    g.last_target = check.target;
    g.last_session = session_id;
    groups.set(key, g);
  }
  // A stable sort, so groups whose last check came at the same time keep
  // the order they first came in.
  return [...groups.values()].sort((a, b) => (a.last_ts < b.last_ts ? -1 : a.last_ts > b.last_ts ? 1 : 0));
}

const TARGET_CHARS = 160;
const NOUNS: Record<CheckGroup["kind"], [string, string]> = { test: ["run", "runs"], api: ["call", "calls"], browser: ["page", "pages"] };

export function formatCheckGroup(g: CheckGroup): string {
  const noun = NOUNS[g.kind][g.count === 1 ? 0 : 1];
  return `${g.kind} ${g.where}${g.host === null ? "" : ` ${g.host}`}: ${g.count} ${noun}, ${g.failed} failed, `
    + `last ${g.last_ts}: ${cutChars(g.last_target, TARGET_CHARS)} (session ${g.last_session})`;
}

export interface BranchChecksParams { project_id: string; branch: string; since?: string; until?: string }
/** A session listed on a branch: a top session, its subagents' calls
 *  counted as its own; `subagents` is how many of them made a call on it. */
export interface BranchSession {
  session_id: string; source: string; first_ts: string; last_ts: string; start_branch_only: boolean; subagents: number;
}
export interface BranchChecks {
  project_id: string; branch: string;
  sessions: BranchSession[]; sessions_total: number;   // latest 10, oldest first
  groups: CheckGroup[]; groups_total: number;          // latest 20 by last_ts, oldest first
  git: { ts: string; session_id: string; line: string; failed: boolean }[]; git_total: number; // latest 20, oldest first
}

const SESSIONS_SHOWN = 10;
const GROUPS_SHOWN = 20;
const GIT_SHOWN = 20;
const BRANCH_LIMIT_DEFAULT = 3;
const BRANCH_LIMIT_MAX = 10;

/** The project's calls a branch query reads: in its work sessions (not
 *  exec or judge runs or their subagents), a resumed session's copies once,
 *  inside since and until. `from` puts session on the left of a CROSS JOIN,
 *  which SQLite always runs as the outer loop: as a plain JOIN the planner
 *  scanned every call in the index (session has no project_id index), about
 *  a second on a 575 MB index whose pages were not cached. */
function callScope(p: { project_id: string; since?: string; until?: string }): { from: string; where: string; args: string[] } {
  return {
    from: "session s CROSS JOIN tool_call t ON t.session_id = s.id",
    where: `s.project_id = ? AND ${workKindClause("s")} AND ${notCopiedClause("t.event_uuid", "t.session_id")}`
      + (p.since ? " AND t.ts >= ?" : "") + (p.until ? " AND t.ts <= ?" : ""),
    args: [p.project_id, ...[p.since, p.until].filter((v): v is string => Boolean(v))],
  };
}

/** Runs `run` with the SQL for the branch a call ran on (callBranch): its
 *  own, or for a call stored before tool_call had one, the branch its
 *  session started on; ownBranch is the call's own alone. The read-only
 *  server never runs applySchema(), so an index the watcher has not opened
 *  since the upgrade has no tool_call.git_branch: it is then read as NULL. */
function withBranchColumn<T>(run: (callBranch: string, ownBranch: string) => T): T {
  try {
    return run("COALESCE(t.git_branch, s.git_branch)", "t.git_branch");
  } catch (e) {
    if (!/no such column: (t\.)?git_branch/.test((e as Error).message)) throw e;
    return run("s.git_branch", "NULL");
  }
}

/** Whether a git command names the branch whole: `feature/x` matches in
 *  `origin/feature/x` and `sha:refs/heads/feature/x`, not in `feature/x-2`. */
function namesBranch(command: string, branch: string): boolean {
  return new RegExp(`(?:^|[\\s:/'"=])${escapeRegExp(branch)}(?:$|[\\s:'"~^])`).test(command);
}

/** Every session, check and git line of a branch, uncapped. */
function allBranchChecks(db: Database.Database, p: BranchChecksParams): {
  sessions: BranchSession[]; rows: CheckRow[]; git: CheckRow[];
} {
  return withBranchColumn((callBranch, ownBranch) => {
    const scope = callScope(p);
    // A subagent's calls are listed under the session at the top of its
    // tree, as clens_left_off counts its edits: a branch worked with many
    // subagents would otherwise list only them. One whose parent is not
    // indexed stays itself.
    const sessions = (db.prepare(`
      ${TOP}
      SELECT COALESCE(top.root, s.id) AS session_id, min(s.source) AS source, min(t.ts) AS first_ts, max(t.ts) AS last_ts,
        max(${ownBranch} IS NULL) AS start_branch_only,
        count(DISTINCT CASE WHEN s.id <> COALESCE(top.root, s.id) THEN s.id END) AS subagents
      FROM ${scope.from} LEFT JOIN top ON top.id = s.id
      WHERE ${scope.where} AND ${callBranch} = ?
      GROUP BY COALESCE(top.root, s.id)
      ORDER BY first_ts, session_id`).all(...scope.args, p.branch) as (Omit<BranchSession, "start_branch_only"> & {
      start_branch_only: number;
    })[]).map((s) => ({ ...s, start_branch_only: s.start_branch_only === 1 }));
    // A call run elsewhere counts only through a git command naming the
    // branch, so only a call whose input holds the name is read for that;
    // instr, not LIKE, which would take _ and % in a name as wildcards.
    const calls = db.prepare(`
      SELECT t.session_id, t.ts, t.name, t.input_json, t.is_error, ${callBranch} = ? AS on_branch
      FROM ${scope.from}
      WHERE ${scope.where}
        AND (t.name IN ('Bash', 'exec_command', 'exec') OR t.name LIKE '%navigate%')
        AND (${callBranch} = ? OR instr(t.input_json, ?) > 0)
      ORDER BY t.ts`).all(p.branch, ...scope.args, p.branch, p.branch) as {
      session_id: string; ts: string; name: string; input_json: string | null; is_error: number; on_branch: number;
    }[];
    const rows: CheckRow[] = [];
    const git: CheckRow[] = [];
    for (const c of calls) {
      for (const check of checksOfCall(c.name, c.input_json)) {
        const row = { session_id: c.session_id, ts: c.ts, is_error: c.is_error, check };
        if (check.kind === "git") {
          if (c.on_branch === 1 || namesBranch(check.target, p.branch)) git.push(row);
        } else if (c.on_branch === 1) {
          rows.push(row);
        }
      }
    }
    return { sessions, rows, git };
  });
}

/** The checks run while a branch was checked out, in every work session of
 *  the project, and the git push and merge commands on it or naming it. */
export function branchChecks(db: Database.Database, p: BranchChecksParams): BranchChecks {
  const all = allBranchChecks(db, p);
  const groups = groupChecks(all.rows);
  return {
    project_id: p.project_id,
    branch: p.branch,
    sessions: all.sessions.slice(-SESSIONS_SHOWN),
    sessions_total: all.sessions.length,
    groups: groups.slice(-GROUPS_SHOWN),
    groups_total: groups.length,
    git: all.git.slice(-GIT_SHOWN).map((g) => ({ ts: g.ts, session_id: g.session_id, line: g.check.target, failed: g.is_error === 1 })),
    git_total: all.git.length,
  };
}

// A call has is_error 0 until its result comes, and keeps it when none
// comes: the session was stopped, or the call is still running.
const CHECKS_NOTE = "A check that did not fail exited 0 or got no result (stopped or still running); clens keeps no output of a call "
  + "that succeeded, so read the reply after a check "
  + "with clens_session (its session and time) to know what it returned.";

export function formatBranchChecks(r: BranchChecks): string {
  if (r.sessions_total === 0 && r.git_total === 0) {
    return `No session in ${r.project_id} made a call on branch ${r.branch}, and no git push or merge names it. `
      + "Pass branches: true for the project's branches.";
  }
  const lines = [`Branch ${r.branch} in ${r.project_id}`];
  function section<T>(name: string, header: string, total: number, rows: T[], line: (row: T) => string): void {
    lines.push(...(total === 0 ? [`${name}: (none)`] : [header, ...rows.map((row) => `  ${line(row)}`)]));
  }
  section("Sessions on it", `Sessions on it (last ${r.sessions.length} of ${r.sessions_total}), first and last call on it:`,
    r.sessions_total, r.sessions,
    (s) => `${s.session_id}  ${s.source}  ${s.first_ts} – ${s.last_ts}`
      + (s.subagents > 0 ? `  (+${s.subagents} subagent${s.subagents === 1 ? "" : "s"})` : "")
      + (s.start_branch_only ? "  (branch from the session's start)" : ""));
  section("Checks", `Checks (last ${r.groups.length} of ${r.groups_total}, by kind and host):`, r.groups_total, r.groups, formatCheckGroup);
  section("Git push and merge on it or naming it", `Git push and merge on it or naming it (last ${r.git.length} of ${r.git_total}):`,
    r.git_total, r.git,
    (g) => `${g.ts}  ${cutChars(g.line, TARGET_CHARS)}  (session ${g.session_id})${g.failed ? "  failed" : ""}`);
  lines.push(CHECKS_NOTE);
  return lines.join("\n");
}

export interface BranchSummary { branch: string; last_ts: string; sessions: number; checks: { label: string; count: number }[] }

const KIND_ORDER: CheckGroup["kind"][] = ["test", "api", "browser"];

/** The project's branches, by their latest call, newest first, each with
 *  its sessions and its checks counted by kind and where. */
export function recentBranches(
  db: Database.Database,
  p: { project_id: string; since?: string; until?: string; limit?: number },
): { branches: BranchSummary[]; more: number } {
  const limit = Math.min(p.limit ?? BRANCH_LIMIT_DEFAULT, BRANCH_LIMIT_MAX);
  // HEAD is a detached checkout, not a branch anyone names.
  const found = withBranchColumn((callBranch) => {
    const scope = callScope(p);
    return db.prepare(`
      SELECT ${callBranch} AS branch, max(t.ts) AS last_ts
      FROM ${scope.from}
      WHERE ${scope.where}
      GROUP BY branch
      HAVING branch IS NOT NULL AND branch NOT IN ('', 'HEAD')
      ORDER BY last_ts DESC, branch`).all(...scope.args) as { branch: string; last_ts: string }[];
  });
  const branches = found.slice(0, limit).map(({ branch, last_ts }): BranchSummary => {
    const all = allBranchChecks(db, { project_id: p.project_id, branch, since: p.since, until: p.until });
    const counts = new Map<string, number>();
    const groups = groupChecks(all.rows).sort((a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.where < b.where ? -1 : a.where > b.where ? 1 : 0));
    for (const g of groups) counts.set(`${g.kind} ${g.where}`, (counts.get(`${g.kind} ${g.where}`) ?? 0) + g.count);
    const checks = [...counts].map(([label, count]) => ({ label, count }));
    if (all.git.length > 0) checks.push({ label: "git", count: all.git.length });
    return { branch, last_ts, sessions: all.sessions.length, checks };
  });
  return { branches, more: found.length - branches.length };
}

export function formatRecentBranches(project_id: string, r: { branches: BranchSummary[]; more: number }): string {
  if (r.branches.length === 0) return `No branch recorded in ${project_id}.`;
  return [
    `Branches in ${project_id}, latest first:`,
    ...r.branches.map((b, i) => {
      const checks = b.checks.length === 0 ? "none" : b.checks.map((c) => `${c.label} ${c.count}`).join(", ");
      return `[${i + 1}] ${b.branch}  last ${b.last_ts}  ${b.sessions} session${b.sessions === 1 ? "" : "s"}  checks: ${checks}`;
    }),
    ...(r.more > 0 ? [`(+${r.more} more branch${r.more === 1 ? "" : "es"}; raise limit, max ${BRANCH_LIMIT_MAX})`] : []),
    "Pass branch with one of them for its checks.",
  ].join("\n");
}

/** The error to return for branch/branches parameters, or null when they are valid. */
export function branchParamsError(p: {
  project_id?: string; branch?: string; branches?: boolean; file?: string; text?: string; commits?: string[];
}): string | null {
  if (p.branch === undefined && p.branches !== true) return null;
  if (!p.project_id) return "branch and branches need project_id, the project the branch is in";
  if (p.branch !== undefined && p.branches === true) return "pass branch or branches, not both";
  if (p.file !== undefined || p.text !== undefined || p.commits !== undefined) return "branch and branches take no file, text or commits";
  return null;
}
