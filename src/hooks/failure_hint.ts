// What an earlier session did after the same failure, for the tool-failure
// hook (tool_failure.ts). Only failures a retry does not fix count: a missing
// command, a refused operation, a host that does not resolve. Failed shell
// calls are stored with the start and end of their output
// (tool_call.error_excerpt), so the hook can tell whether another session hit
// the same one, and the reply that followed it there says what that session
// did about it.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type Database from "better-sqlite3";

import { workKindClause } from "../analyzer/scope.js";
import { errorExcerpt } from "../indexer/claude_parser.js";
import { cutChars, escapeRegExp } from "../mcp/search.js";
import { execCodeCommands } from "../util/codex_exec.js";
import { projectIdOf } from "../util/project_id.js";
import { localTs } from "../util/time.js";

export type FailureKind = "missing" | "network" | "permission";

export interface FailureKey {
  kind: FailureKind;
  key: string;
}

export interface FailureInput {
  sessionId: string;
  cwd: string | null;
  output: string;
}

/** Earlier sessions shown at most. */
const MAX_SESSIONS = 2;
/** A failure of this session's this recent is the one being reported, which
 *  the watcher may have indexed already; an older one means the hint was
 *  given then. */
const OWN_FAILURE_MS = 30_000;
/** A reply this long after the failure is about something else. */
const REPLY_WITHIN_MS = 10 * 60_000;
/** A session's note of what it was told is removed after a week untouched. */
const TOLD_KEEP_MS = 7 * 24 * 60 * 60_000;

// Patterns run on a lowercased line, anchored to the line's start in the form
// the program prints it: Codex runs the hook after every command, and a
// successful command's output can quote the same words (a search hit, a diff,
// a file read).
const MISSING: RegExp[] = [
  /^(?:[\w/.-]*zsh|\(eval\))(?::\d+)?: command not found: ([\w.+-]+)$/, // zsh
  /^(?:\/bin\/)?(?:ba|da)?sh(?:: line \d+)?(?:: \d+)?: ([\w.+-]+): (?:command )?not found$/, // bash, sh
  /^error: '([\w.+-]+)' is not installed/, // rustup
];
// git, curl and ssh name the host they could not reach after their own prefix.
const NET = String.raw`^(?:fatal: unable to access '[^']*': |curl: \(\d+\) |ssh: (?:connect to host \S+ port \d+: )?)`;
const HOST = [
  new RegExp(`${NET}could not resolve host(?:name)?:? ([a-z0-9.-]+)`),
  /^(?:npm err!|npm error|error:) .*getaddrinfo enotfound ([a-z0-9.-]+)/, // npm, node
];
const NETWORK = new RegExp(`${NET}(?:ssl certificate problem|network is unreachable|received http code \\d+ from proxy|proxy connect aborted)`);
// "program: …", "zsh:1: …", "bash: line 1: …" or "user@host: …"; not a path
// such as a search hit's "src/a.ts:12: …", nor the bare line number grep -n
// prints for one file ("12: …").
const PERMISSION = /^(?:(?!\d+:)[\w-]+|\(eval\)|\/bin\/\w+|[\w.-]+@[\w.-]+)(?::(?: line)? ?\d+)?: .*(?:operation not permitted|permission denied|read-only file system)/;

function normalized(line: string): string {
  return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The failure in a command's output that a retry would not fix, keyed so the
 *  same failure in another session gets the same key: a missing command by its
 *  name, an unresolved host by the host, a refused operation by its line with
 *  numbers left out. The last such line wins; null when there is none. */
export function failureKey(output: string): FailureKey | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim().toLowerCase());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line) continue;
    for (const re of MISSING) {
      const m = re.exec(line);
      if (m) return { kind: "missing", key: `missing:${m[1]}` };
    }
    for (const re of HOST) {
      const m = re.exec(line);
      if (m) return { kind: "network", key: `network:${m[1]}` };
    }
    if (NETWORK.test(line)) return { kind: "network", key: `network:${normalized(line)}` };
    if (PERMISSION.test(line)) return { kind: "permission", key: `permission:${normalized(line)}` };
  }
  return null;
}

/** The key the hook goes by for a command's output: that of the excerpt the
 *  index stores for a failed call, so the failure being reported matches its
 *  own stored copy once indexed. */
export function hintKey(output: string): FailureKey | null {
  return failureKey(errorExcerpt(output) ?? "");
}

function toldFile(dir: string, sessionId: string): string {
  return join(dir, sessionId.replace(/[^\w-]/g, "_"));
}

/** Whether this session was already told about the failure `key`. The index
 *  cannot always say: a Codex exec (code mode) call whose script printed
 *  nothing of a failed command, and that has no CommandExecution item for it,
 *  is stored with no excerpt, so it does not key like the one being reported. */
export function alreadyTold(dir: string, sessionId: string, key: string): boolean {
  try {
    return readFileSync(toldFile(dir, sessionId), "utf8").split("\n").includes(key);
  } catch {
    return false;
  }
}

/** Notes in `dir` that this session was told about `key`, and removes the
 *  notes of sessions untouched for a week. */
export function rememberTold(dir: string, sessionId: string, key: string, now: number): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(toldFile(dir, sessionId), `${key}\n`);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > TOLD_KEEP_MS) rmSync(path, { force: true });
    } catch {
      // Removed by another hook meanwhile.
    }
  }
}

interface FailedCall {
  session_id: string;
  root: string;
  ts: string;
  input_json: string | null;
  error_excerpt: string;
  project_id: string | null;
  project_cwd: string | null;
}

function commandOf(inputJson: string | null, word: string | null = null): string {
  let command = "";
  try {
    const input = JSON.parse(inputJson ?? "{}") as { command?: unknown; cmd?: unknown };
    command = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
  } catch {
    // Codex exec (code mode) input is the script itself: its commands are
    // string literals in it. Of several, the one naming what failed.
    const commands = execCodeCommands(inputJson ?? "").map((c) => c.cmd);
    const names = word === null ? null : new RegExp(`(?<![\\w.-])${escapeRegExp(word)}(?![\\w-])`);
    command = (names === null ? undefined : commands.find((c) => names.test(c))) ?? commands[0] ?? "";
  }
  return cutChars(command.split("\n")[0] ?? "", 80);
}

/** The word a reply about this failure would name: the missing command, the
 *  host, or the program whose operation was refused. */
function failureWord(key: FailureKey, command: string): string | null {
  const value = key.key.slice(key.kind.length + 1);
  if (key.kind === "missing") return value;
  if (key.kind === "network") return /^[a-z0-9.-]+$/.test(value) ? value : (/https?:\/\/([^/':]+)/.exec(value)?.[1] ?? null);
  const first = command.replace(/^(?:\s*cd\s+\S+\s*(?:&&|;)\s*)+/, "").trim().split(/\s+/)[0] ?? "";
  return /^[\w./+-]+$/.test(first) ? basename(first) : null;
}

/** The first of `replies` that names `word` as a word of its own ("gh", not
 *  "github"). The first reply after a failure is often a progress note about
 *  the task as a whole; one that names what failed is more likely about it. */
function namedReply(replies: { text: string }[], word: string | null): string | undefined {
  if (word === null) return undefined;
  const named = new RegExp(`(?<![\\w.-])${escapeRegExp(word)}(?![\\w-])`, "i");
  return replies.find((r) => named.test(r.text))?.text;
}

/** The text for the hook to add when `input`'s failure is one a retry does
 *  not fix and an earlier session had it: up to two such sessions, newest
 *  first, each with its command and the first reply after it that names what
 *  failed (none when no reply does). A missing command
 *  is looked for in every project, the rest in the project of `input.cwd`.
 *  Null when there is nothing to say, or when this session had the same
 *  failure before and so was told already. */
export function failureHint(db: Database.Database, input: FailureInput, now: number): string | null {
  const key = hintKey(input.output);
  if (!key) return null;
  // Claude Code names a project after its directory and Codex after its cwd,
  // so the sessions that ran in this cwd say which project ids it has.
  const projects = new Set<string>();
  if (input.cwd !== null) {
    projects.add(projectIdOf(input.cwd));
    const rows = db.prepare("SELECT DISTINCT project_id FROM session WHERE cwd = ? AND project_id IS NOT NULL").all(input.cwd) as {
      project_id: string;
    }[];
    for (const r of rows) projects.add(r.project_id);
  }
  const anyProject = key.kind === "missing";
  if (!anyProject && projects.size === 0) return null;

  const inProject = anyProject ? "" : `AND s.project_id IN (${[...projects].map(() => "?").join(", ")})`;
  const calls = db
    .prepare(
      `SELECT t.session_id, t.ts, t.input_json, t.error_excerpt, s.project_id, p.cwd AS project_cwd,
         COALESCE(CASE WHEN s.kind = 'subagent' THEN s.parent_id END, s.id) AS root
       FROM tool_call t
       JOIN session s ON s.id = t.session_id
       LEFT JOIN project p ON p.id = s.project_id
       WHERE t.is_error = 1 AND t.error_excerpt IS NOT NULL AND t.name IN ('Bash', 'exec_command', 'exec')
         AND (s.id = ? OR s.parent_id = ? OR ${workKindClause("s")}) ${inProject}
       ORDER BY t.ts DESC`,
    )
    // This session's own rows count whatever its kind (a one-shot run is
    // `exec`): they tell whether it was told already.
    .all(input.sessionId, input.sessionId, ...(anyProject ? [] : [...projects])) as FailedCall[];

  const ownBefore = new Date(now - OWN_FAILURE_MS).toISOString();
  const picked: FailedCall[] = [];
  for (const call of calls) {
    if (failureKey(call.error_excerpt)?.key !== key.key) continue;
    if (call.root === input.sessionId || call.session_id === input.sessionId) {
      if (call.ts < ownBefore) return null;
      continue;
    }
    if (picked.length < MAX_SESSIONS && !picked.some((p) => p.root === call.root)) picked.push(call);
  }
  if (picked.length === 0) return null;

  const repliesAfter = db.prepare(
    "SELECT text FROM user_text WHERE session_id = ? AND role = 'assistant' AND ts > ? AND ts <= ? ORDER BY ts LIMIT 20",
  );
  const what = key.kind === "missing" ? `\`${key.key.slice("missing:".length)}\` not found` : key.kind === "network" ? "network" : "operation refused";
  const lines = [`clens: this failure (${what}) happened in an earlier session too. What the agent did then:`];
  const named = key.kind === "permission" ? null : key.key.slice(key.kind.length + 1);
  for (const call of picked) {
    const where = call.project_id !== null && !projects.has(call.project_id) ? ` in ${basename(call.project_cwd ?? call.project_id)}` : "";
    const command = commandOf(call.input_json, named);
    lines.push(`- ${localTs(call.ts).slice(0, 10)}${where}: \`${command}\` (session ${call.session_id}, around_ts ${localTs(call.ts)})`);
    const until = new Date(Date.parse(call.ts) + REPLY_WITHIN_MS).toISOString();
    const replies = repliesAfter.all(call.session_id, call.ts, until) as { text: string }[];
    const reply = namedReply(replies, failureWord(key, command));
    if (reply) lines.push(`  next reply: ${cutChars(reply.replace(/\s+/g, " "), 240)}`);
  }
  lines.push("Read more with clens_session. Ignore this if it does not apply.");
  return lines.join("\n");
}
