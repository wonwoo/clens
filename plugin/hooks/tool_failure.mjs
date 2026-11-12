#!/usr/bin/env node
import { createRequire as __clensRequire } from 'node:module'; const require = __clensRequire(import.meta.url);

// src/hooks/failure_hint.ts
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// src/analyzer/scope.ts
function workKindClause(alias) {
  return `(${alias}.id NOT IN (WITH RECURSIVE program(id) AS (SELECT id FROM session WHERE kind IN ('pipeline', 'exec') UNION SELECT c.id FROM session c JOIN program ON c.parent_id = program.id) SELECT id FROM program))`;
}
var WORK_SESSIONS = `SELECT w.id FROM session w WHERE ${workKindClause("w")}`;

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

// src/util/time.ts
var pad = (n) => String(n).padStart(2, "0");
var STORED_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
function localTs(ts) {
  const m = STORED_TS.exec(ts);
  const t = Date.parse(ts);
  if (!m || Number.isNaN(t)) return ts;
  const d = new Date(t);
  const off = -d.getTimezoneOffset();
  const zone = off === 0 ? "Z" : `${off > 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${m[2] ?? ""}${zone}`;
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

// src/util/codex_exec.ts
var CALL_RE = /tools\s*\.\s*exec_command\s*\(\s*\{/y;
var KEY_RE = /[A-Za-z_$][\w$]*/y;
var WORD_CHAR_RE = /[\w$.]/;
function execCodeCommands(code) {
  return execCodeScan(code).commands;
}
function execCodeScan(code) {
  const out = [];
  let built = 0;
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const skipped = skipNonCode(code, i);
    if (skipped !== i) {
      i = skipped;
    } else if (c === "t" && (i === 0 || !WORD_CHAR_RE.test(code[i - 1]))) {
      CALL_RE.lastIndex = i;
      const m = CALL_RE.exec(code);
      if (m === null) {
        i += 1;
        continue;
      }
      const obj = readObject(code, i + m[0].length);
      if (obj.closed && obj.cmd !== null) out.push({ cmd: obj.cmd, workdir: obj.workdir });
      else if (obj.closed) built += 1;
      i = obj.end;
    } else {
      i += 1;
    }
  }
  return { commands: out, built };
}
function skipNonCode(code, i) {
  const c = code[i];
  if (c === "/" && code[i + 1] === "/") {
    const end = code.indexOf("\n", i);
    return end === -1 ? code.length : end + 1;
  }
  if (c === "/" && code[i + 1] === "*") {
    const end = code.indexOf("*/", i + 2);
    return end === -1 ? code.length : end + 2;
  }
  if (c === '"' || c === "'") return readQuoted(code, i)?.end ?? code.length;
  if (c === "`") return readTemplate(code, i)?.end ?? code.length;
  return i;
}
function skipSpace(code, i) {
  for (; ; ) {
    while (i < code.length && /\s/.test(code[i])) i += 1;
    if (code[i] === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) i = skipNonCode(code, i);
    else return i;
  }
}
function readObject(code, start) {
  let cmd = null;
  let workdir = null;
  let i = start;
  for (; ; ) {
    i = skipSpace(code, i);
    if (i >= code.length) return { cmd, workdir, end: code.length, closed: false };
    if (code[i] === "}") return { cmd, workdir, end: i + 1, closed: true };
    if (code[i] === ",") {
      i += 1;
      continue;
    }
    let key2 = null;
    if (code[i] === '"' || code[i] === "'") {
      const s = readQuoted(code, i);
      if (s === null) return { cmd, workdir, end: code.length, closed: false };
      key2 = s.value;
      i = s.end;
    } else {
      KEY_RE.lastIndex = i;
      const m = KEY_RE.exec(code);
      if (m !== null) {
        key2 = m[0];
        i += m[0].length;
      }
    }
    i = skipSpace(code, i);
    if (code[i] !== ":") {
      i = skipValue(code, i);
      if (code[i] !== "," && code[i] !== "}") return { cmd, workdir, end: i, closed: false };
      continue;
    }
    i = skipSpace(code, i + 1);
    const lit = code[i] === '"' || code[i] === "'" ? readQuoted(code, i) : code[i] === "`" ? readTemplate(code, i) : void 0;
    if (lit === null) return { cmd, workdir, end: code.length, closed: false };
    if (lit !== void 0) {
      const after = skipSpace(code, lit.end);
      if (lit.value !== null && (code[after] === "," || code[after] === "}")) {
        if (key2 === "cmd") cmd = lit.value;
        else if (key2 === "workdir") workdir = lit.value;
        i = after;
        continue;
      }
    }
    i = skipValue(code, i);
    if (code[i] !== "," && code[i] !== "}") return { cmd, workdir, end: i, closed: false };
  }
}
function skipValue(code, i) {
  let depth = 0;
  while (i < code.length) {
    const skipped = skipNonCode(code, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (c === "," && depth === 0) return i;
    i += 1;
  }
  return code.length;
}
function readQuoted(code, i) {
  const quote = code[i];
  let value = "";
  let j = i + 1;
  while (j < code.length) {
    const c = code[j];
    if (c === quote) return { value, end: j + 1 };
    if (c === "\\") {
      const e = unescape(code, j);
      value += e.text;
      j = e.end;
    } else {
      value += c;
      j += 1;
    }
  }
  return null;
}
function readTemplate(code, i) {
  let value = "";
  let j = i + 1;
  while (j < code.length) {
    const c = code[j];
    if (c === "`") return { value, end: j + 1 };
    if (c === "\\") {
      const e = unescape(code, j);
      if (value !== null) value += e.text;
      j = e.end;
    } else if (c === "$" && code[j + 1] === "{") {
      value = null;
      j = skipPlaceholder(code, j + 2);
    } else {
      if (value !== null) value += c;
      j += 1;
    }
  }
  return null;
}
function skipPlaceholder(code, i) {
  let depth = 0;
  while (i < code.length) {
    const skipped = skipNonCode(code, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = code[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      if (depth === 0) return i + 1;
      depth -= 1;
    }
    i += 1;
  }
  return code.length;
}
function unescape(code, i) {
  const n = code[i + 1];
  if (n === void 0) return { text: "", end: i + 1 };
  const simple = { n: "\n", t: "	", r: "\r", b: "\b", f: "\f", v: "\v" };
  if (n in simple) return { text: simple[n], end: i + 2 };
  if (n === "0" && !/[0-9]/.test(code[i + 2] ?? "")) return { text: "\0", end: i + 2 };
  if (n === "x") {
    const hex = code.slice(i + 2, i + 4);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) return { text: String.fromCharCode(parseInt(hex, 16)), end: i + 4 };
  }
  if (n === "u") {
    const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(code.slice(i + 2, i + 10));
    if (braced !== null) {
      const cp = parseInt(braced[1], 16);
      if (cp <= 1114111) return { text: String.fromCodePoint(cp), end: i + 2 + braced[0].length };
    }
    const hex = code.slice(i + 2, i + 6);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) return { text: String.fromCharCode(parseInt(hex, 16)), end: i + 6 };
  }
  if (n === "\r" && code[i + 2] === "\n") return { text: "", end: i + 3 };
  if (n === "\n" || n === "\r" || n === "\u2028" || n === "\u2029") return { text: "", end: i + 2 };
  return { text: n, end: i + 2 };
}

// src/util/project_id.ts
var MAX_NAME = 200;
function projectIdOf(path) {
  const name = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_NAME) return name;
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h << 5) - h + path.charCodeAt(i) | 0;
  return `${name.slice(0, MAX_NAME)}-${Math.abs(h).toString(36)}`;
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
var PERMISSION = /^(?:(?!\d+:)[\w-]+|\(eval\)|\/bin\/\w+|[\w.-]+@[\w.-]+)(?::(?: line)? ?\d+)?: .*(?:operation not permitted|permission denied|read-only file system)/;
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
function commandOf(inputJson, word = null) {
  let command = "";
  try {
    const input2 = JSON.parse(inputJson ?? "{}");
    command = typeof input2.command === "string" ? input2.command : typeof input2.cmd === "string" ? input2.cmd : "";
  } catch {
    const commands = execCodeCommands(inputJson ?? "").map((c) => c.cmd);
    const names = word === null ? null : new RegExp(`(?<![\\w.-])${escapeRegExp(word)}(?![\\w-])`);
    command = (names === null ? void 0 : commands.find((c) => names.test(c))) ?? commands[0] ?? "";
  }
  return cutChars(command.split("\n")[0] ?? "", 80);
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
    projects.add(projectIdOf(input2.cwd));
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
       WHERE t.is_error = 1 AND t.error_excerpt IS NOT NULL AND t.name IN ('Bash', 'exec_command', 'exec')
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
  const named = key2.kind === "permission" ? null : key2.key.slice(key2.kind.length + 1);
  for (const call of picked) {
    const where = call.project_id !== null && !projects.has(call.project_id) ? ` in ${basename(call.project_cwd ?? call.project_id)}` : "";
    const command = commandOf(call.input_json, named);
    lines.push(`- ${localTs(call.ts).slice(0, 10)}${where}: \`${command}\` (session ${call.session_id}, around_ts ${localTs(call.ts)})`);
    const until = new Date(Date.parse(call.ts) + REPLY_WITHIN_MS).toISOString();
    const replies = repliesAfter.all(call.session_id, call.ts, until);
    const reply = namedReply(replies, failureWord(key2, command));
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
    { sessionId, cwd: typeof event.cwd === "string" ? event.cwd : null, output },
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
