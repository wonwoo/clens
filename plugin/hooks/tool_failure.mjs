#!/usr/bin/env node
import { createRequire as __clensRequire } from 'node:module'; const require = __clensRequire(import.meta.url);

// src/hooks/failure_hint.ts
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// src/analyzer/scope.ts
function workKindClause(alias) {
  const col = (c) => alias ? `${alias}.${c}` : c;
  return `(${col("kind")} IS NOT 'pipeline' AND ${col("kind")} IS NOT 'exec' AND (${col("parent_id")} IS NULL OR ${col("parent_id")} NOT IN (SELECT id FROM session WHERE kind IN ('pipeline', 'exec'))))`;
}
var WORK_SESSIONS = `SELECT id FROM session WHERE ${workKindClause()}`;

// src/indexer/shell_writes.ts
var STR = String.raw`'([^'\n]*)'|"([^"\n]*)"|` + "`([^`$]*)`";
var ARG = String.raw`\s*(?:(?:${STR})|([A-Za-z_]\w*)(?=\s*[,)]))`;
var WRITE_CALLS = [
  // open(p, 'w') and open(p, encoding=…, mode='a'); the mode is checked below.
  new RegExp(String.raw`\bopen\(${ARG}\s*,\s*(?:mode\s*=\s*)?(?:${STR})`, "g"),
  new RegExp(String.raw`\bopen\(${ARG}\s*,[^)]{0,300}?\bmode\s*=\s*(?:${STR})`, "g"),
  // Path(p) and pathlib.Path(p) alike: \b falls before the P in both.
  new RegExp(String.raw`\bPath\(${ARG}\s*\)\.write_(?:text|bytes)\(`, "g"),
  new RegExp(String.raw`\b([A-Za-z_]\w*)\.write_(?:text|bytes)\(`, "g"),
  new RegExp(String.raw`\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\(${ARG}`, "g")
];

// src/indexer/claude_parser.ts
function codepointLength(s) {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}
var TRUNCATE_MARKER = "\n\u2026[truncated]\u2026\n";
var ERROR_HEAD_CHARS = 100;
var ERROR_TAIL_CHARS = 200;
function errorExcerpt(text) {
  const t = text.trim();
  if (t === "") return null;
  if (codepointLength(t) <= ERROR_HEAD_CHARS + ERROR_TAIL_CHARS) return t;
  const head = [...t.slice(0, ERROR_HEAD_CHARS * 2)].slice(0, ERROR_HEAD_CHARS).join("");
  const tail = [...t.slice(-ERROR_TAIL_CHARS * 2)].slice(-ERROR_TAIL_CHARS).join("");
  return head + TRUNCATE_MARKER + tail;
}

// src/mcp/search.ts
var SNIPPET_LEAD = 60;
var SNIPPET_TRAIL = 180;
var CONTEXT_LINE_CHARS = SNIPPET_LEAD + SNIPPET_TRAIL;
function cutChars(text, max) {
  const chars = Array.from(text.trim());
  return chars.length > max ? chars.slice(0, max).join("") + "\u2026" : chars.join("");
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/hooks/failure_hint.ts
var MAX_SESSIONS = 2;
var OWN_FAILURE_MS = 3e4;
var REPLY_WITHIN_MS = 10 * 6e4;
var TOLD_KEEP_MS = 7 * 24 * 60 * 6e4;
var MISSING = [
  /^(?:[\w/.-]*zsh|\(eval\))(?::\d+)?: command not found: ([\w.+-]+)$/,
  // zsh
  /^(?:\/bin\/)?(?:ba|da)?sh(?:: line \d+)?(?:: \d+)?: ([\w.+-]+): (?:command )?not found$/,
  // bash, sh
  /^error: '([\w.+-]+)' is not installed/
  // rustup
];
var NET = String.raw`^(?:fatal: unable to access '[^']*': |curl: \(\d+\) |ssh: (?:connect to host \S+ port \d+: )?)`;
var HOST = [
  new RegExp(`${NET}could not resolve host(?:name)?:? ([a-z0-9.-]+)`),
  /^(?:npm err!|npm error|error:) .*getaddrinfo enotfound ([a-z0-9.-]+)/
  // npm, node
];
var NETWORK = new RegExp(`${NET}(?:ssl certificate problem|network is unreachable|received http code \\d+ from proxy|proxy connect aborted)`);
var PERMISSION = /^(?:[\w-]+|\(eval\)|\/bin\/\w+|[\w.-]+@[\w.-]+)(?::(?: line)? ?\d+)?: .*(?:operation not permitted|permission denied|read-only file system)/;
function normalized(line) {
  return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
}
function failureKey(output2) {
  const lines = output2.split(/\r?\n/).map((l) => l.trim().toLowerCase());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
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
function hintKey(output2) {
  return failureKey(errorExcerpt(output2) ?? "");
}
function toldFile(dir, sessionId2) {
  return join(dir, sessionId2.replace(/[^\w-]/g, "_"));
}
function alreadyTold(dir, sessionId2, key2) {
  try {
    return readFileSync(toldFile(dir, sessionId2), "utf8").split("\n").includes(key2);
  } catch {
    return false;
  }
}
function rememberTold(dir, sessionId2, key2, now) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(toldFile(dir, sessionId2), `${key2}
`);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > TOLD_KEEP_MS) rmSync(path, { force: true });
    } catch {
    }
  }
}
function commandOf(inputJson) {
  try {
    const input2 = JSON.parse(inputJson ?? "{}");
    const command = typeof input2.command === "string" ? input2.command : typeof input2.cmd === "string" ? input2.cmd : "";
    return cutChars(command.split("\n")[0] ?? "", 80);
  } catch {
    return "";
  }
}
function failureWord(key2, command) {
  const value = key2.key.slice(key2.kind.length + 1);
  if (key2.kind === "missing") return value;
  if (key2.kind === "network") return /^[a-z0-9.-]+$/.test(value) ? value : /https?:\/\/([^/':]+)/.exec(value)?.[1] ?? null;
  const first = command.replace(/^(?:\s*cd\s+\S+\s*(?:&&|;)\s*)+/, "").trim().split(/\s+/)[0] ?? "";
  return /^[\w./+-]+$/.test(first) ? basename(first) : null;
}
function namedReply(replies, word) {
  if (word === null) return void 0;
  const named = new RegExp(`(?<![\\w.-])${escapeRegExp(word)}(?![\\w-])`, "i");
  return replies.find((r) => named.test(r.text))?.text;
}
function failureHint(db, input2, now) {
  const key2 = hintKey(input2.output);
  if (!key2) return null;
  const projects = /* @__PURE__ */ new Set();
  if (input2.cwd !== null) {
    projects.add(input2.cwd.replace(/\//g, "-"));
    const rows = db.prepare("SELECT DISTINCT project_id FROM session WHERE cwd = ? AND project_id IS NOT NULL").all(input2.cwd);
    for (const r of rows) projects.add(r.project_id);
  }
  const anyProject = key2.kind === "missing";
  if (!anyProject && projects.size === 0) return null;
  const inProject = anyProject ? "" : `AND s.project_id IN (${[...projects].map(() => "?").join(", ")})`;
  const calls = db.prepare(
    `SELECT t.session_id, t.ts, t.input_json, t.error_excerpt, s.project_id, p.cwd AS project_cwd,
         COALESCE(CASE WHEN s.kind = 'subagent' THEN s.parent_id END, s.id) AS root
       FROM tool_call t
       JOIN session s ON s.id = t.session_id
       LEFT JOIN project p ON p.id = s.project_id
       WHERE t.is_error = 1 AND t.error_excerpt IS NOT NULL AND t.name IN ('Bash', 'exec_command')
         AND (s.id = ? OR s.parent_id = ? OR ${workKindClause("s")}) ${inProject}
       ORDER BY t.ts DESC`
  ).all(input2.sessionId, input2.sessionId, ...anyProject ? [] : [...projects]);
  const ownBefore = new Date(now - OWN_FAILURE_MS).toISOString();
  const picked = [];
  for (const call of calls) {
    if (failureKey(call.error_excerpt)?.key !== key2.key) continue;
    if (call.root === input2.sessionId || call.session_id === input2.sessionId) {
      if (call.ts < ownBefore) return null;
      continue;
    }
    if (picked.length < MAX_SESSIONS && !picked.some((p) => p.root === call.root)) picked.push(call);
  }
  if (picked.length === 0) return null;
  const repliesAfter = db.prepare(
    "SELECT text FROM user_text WHERE session_id = ? AND role = 'assistant' AND ts > ? AND ts <= ? ORDER BY ts LIMIT 20"
  );
  const what = key2.kind === "missing" ? `\`${key2.key.slice("missing:".length)}\` not found` : key2.kind === "network" ? "network" : "operation refused";
  const lines = [`clens: this failure (${what}) happened in an earlier session too. What the agent did then:`];
  for (const call of picked) {
    const where = call.project_id !== null && !projects.has(call.project_id) ? ` in ${basename(call.project_cwd ?? call.project_id)}` : "";
    lines.push(`- ${call.ts.slice(0, 10)}${where}: \`${commandOf(call.input_json)}\` (session ${call.session_id}, around_ts ${call.ts})`);
    const until = new Date(Date.parse(call.ts) + REPLY_WITHIN_MS).toISOString();
    const replies = repliesAfter.all(call.session_id, call.ts, until);
    const reply = namedReply(replies, failureWord(key2, commandOf(call.input_json)));
    if (reply) lines.push(`  next reply: ${cutChars(reply.replace(/\s+/g, " "), 240)}`);
  }
  lines.push("Read more with clens_session. Ignore this if it does not apply.");
  return lines.join("\n");
}

// src/util/paths.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";
function clensHome() {
  if (process.env.CLENS_HOME !== void 0 && process.env.CLENS_INDEX_DIR === void 0) {
    return join2(process.env.CLENS_HOME, "__no_clens__");
  }
  return process.env.CLENS_INDEX_DIR ?? join2(homedir(), ".clens");
}
function indexDbPath() {
  return join2(clensHome(), "index.db");
}
function hintsSeenDir() {
  return join2(clensHome(), "hints-seen");
}

// src/hooks/tool_failure.ts
var Database;
try {
  ({ default: Database } = await import("better-sqlite3"));
} catch {
  process.exit(0);
}
var input = "";
for await (const chunk of process.stdin) input += chunk;
var event;
try {
  event = JSON.parse(input);
} catch {
  process.exit(0);
}
var sessionId = event.session_id;
if (event.tool_name !== "Bash" || typeof sessionId !== "string") process.exit(0);
var output = typeof event.error === "string" ? event.error : typeof event.tool_response === "string" ? event.tool_response : JSON.stringify(event.tool_response ?? "");
var key = hintKey(output);
if (!key || alreadyTold(hintsSeenDir(), sessionId, key.key)) process.exit(0);
var hint;
try {
  const db = new Database(indexDbPath(), { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 2000");
  hint = failureHint(
    db,
    { sessionId, cwd: typeof event.cwd === "string" ? event.cwd : null, command: String(event.tool_input?.command ?? ""), output },
    Date.now()
  );
  db.close();
} catch {
  process.exit(0);
}
if (!hint) process.exit(0);
try {
  rememberTold(hintsSeenDir(), sessionId, key.key, Date.now());
} catch {
}
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: typeof event.hook_event_name === "string" ? event.hook_event_name : "PostToolUseFailure",
      additionalContext: hint
    }
  })
);
