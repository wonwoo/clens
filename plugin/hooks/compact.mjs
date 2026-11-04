#!/usr/bin/env node
import { createRequire as __clensRequire } from 'node:module'; const require = __clensRequire(import.meta.url);

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
    let key = null;
    if (code[i] === '"' || code[i] === "'") {
      const s = readQuoted(code, i);
      if (s === null) return { cmd, workdir, end: code.length, closed: false };
      key = s.value;
      i = s.end;
    } else {
      KEY_RE.lastIndex = i;
      const m = KEY_RE.exec(code);
      if (m !== null) {
        key = m[0];
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
        if (key === "cmd") cmd = lit.value;
        else if (key === "workdir") workdir = lit.value;
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

// src/util/temp_dirs.ts
var TEMP_ROOTS = ["/tmp/", "/private/tmp/", "/var/tmp/", "/private/var/tmp/", "/var/folders/", "/private/var/folders/"];

// src/analyzer/scope.ts
function workKindClause(alias) {
  const col = (c) => alias ? `${alias}.${c}` : c;
  return `(${col("kind")} IS NOT 'pipeline' AND ${col("kind")} IS NOT 'exec' AND (${col("parent_id")} IS NULL OR ${col("parent_id")} NOT IN (SELECT id FROM session WHERE kind IN ('pipeline', 'exec'))))`;
}
var WORK_SESSIONS = `SELECT id FROM session WHERE ${workKindClause()}`;

// src/mcp/search.ts
var SNIPPET_LEAD = 60;
var SNIPPET_TRAIL = 180;
var CONTEXT_LINE_CHARS = SNIPPET_LEAD + SNIPPET_TRAIL;
function cutChars(text, max) {
  const chars = Array.from(text.trim());
  return chars.length > max ? chars.slice(0, max).join("") + "\u2026" : chars.join("");
}
function notNoise(alias) {
  const t = `${alias}.text`;
  return `NOT (substr(${t}, 1, 28) = '[Request interrupted by user'
    OR trim(${t}) = ''
    OR substr(${t}, 1, 20) = '[external_agent_tool'
    OR ${t} = '<EXTERNAL SESSION IMPORTED>'
    OR ${t} = 'No response requested.'
    OR substr(${t}, 1, 15) = '<local-command-'
    OR substr(${t}, 1, 19) = '<task-notification>'
    OR substr(${t}, 1, 38) = 'Another Claude session sent a message:'
    OR substr(${t}, 1, 17) = '<teammate-message'
    OR substr(${t}, 1, 13) = '<bash-stdout>'
    OR (substr(${t}, 1, 9) = '<command-' AND instr(${t}, '<command-args></command-args>') > 0)
    OR (${alias}.is_command = 1 AND ${t} LIKE '%<command-%<>%'))`;
}

// src/mcp/left_off.ts
var EDIT_TOOLS = "('Edit', 'Write', 'NotebookEdit', 'apply_patch', 'Bash', 'exec_command')";
var REQUEST_CHARS = 500;
var BARE_COMMAND = (alias) => `(substr(${alias}.text, 1, 1) = '/' AND instr(substr(${alias}.text, 2), '/') = 0
    AND instr(${alias}.text, ' ') = 0 AND instr(${alias}.text, char(10)) = 0)`;
var TREE = `WITH RECURSIVE tree(id) AS (
    SELECT ? UNION SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.id)`;
var REAL_MESSAGE = (alias) => `${alias}.type IN ('user_message', 'assistant_message') AND ${notNoise(alias)} AND NOT ${BARE_COMMAND(alias)}`;
function shortPath(path, cwd) {
  if (!cwd) return path;
  const base = cwd.replace(/\/+$/, "") + "/";
  return path.startsWith(base) ? path.slice(base.length) : path;
}
var RECORD_LIST_CAP = 10;
var RECORD_LINE_CHARS = 120;
var FAILED_INPUT_CHARS = 100;
var RECORD_EDITS_DETAILED = 5;
var RECORD_MORE_EDITS_CHARS = 1200;
var RECORD_REPLY_CHARS = 500;
var SEGMENT_PAUSE_MS = 2 * 60 * 60 * 1e3;
var RECORD_SEGMENTS_CAP = 20;
var SEGMENT_REPLY_CHARS = 240;
var SEGMENT_TOPICS_SHOWN = 6;
var SEGMENT_TOPIC_REPLIES = 2;
var CODE_TERM = /`([^`\n]{2,40})`/g;
var NOT_A_TOPIC = /^(?:[0-9a-f]{7,40}|[\d.,%:\s-]+)$/;
var SHORT_REPLY_CHARS = 20;
var CLAUDE_CODE_NOTICE = /^(?:API Error|Prompt is too long|You've hit your |Please run \/login)/;
var COMPACT_COMMAND = /^\/compact(?:\s|$)/;
var COMPACT_ROW = (alias) => `${alias}.event_uuid IN (SELECT event_uuid FROM slash_command WHERE name = 'compact')`;
var CHANGE_GIT = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|merge|push)\b/;
function isCompact(m) {
  return m.role === "user" && (m.compact === 1 || COMPACT_COMMAND.test(m.text));
}
function commandOf(inputJson) {
  if (inputJson === null) return null;
  try {
    const parsed = JSON.parse(inputJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { command, cmd } = parsed;
    return typeof command === "string" ? command : typeof cmd === "string" ? cmd : null;
  } catch {
    const m = /"(?:command|cmd)":"((?:[^"\\]|\\.)*)/.exec(inputJson);
    if (m === null) return null;
    try {
      return JSON.parse('"' + m[1] + '"');
    } catch {
      return m[1];
    }
  }
}
function shellCommands(name, inputJson) {
  return name === "exec" ? execCodeCommands(inputJson ?? "").map((c) => c.cmd) : [commandOf(inputJson)].filter((c) => c !== null);
}
var STATE_CHANGING_GIT = /(?:^|&&|\|\||;)\s*git\s+(?:-C\s+\S+\s+)?(?:commit|checkout|switch|merge|rebase|reset|stash|push|branch)\b/g;
var HEREDOC = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/;
function gitMatches(line) {
  return [...line.matchAll(STATE_CHANGING_GIT)].map((m) => ({ at: m.index + m[0].indexOf("git"), end: m.index + m[0].length }));
}
var SHELL_C = /(?:^|[\s;&|(])(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c[A-Za-z]*\s+$/;
function codePositions(line, stack) {
  const code = new Array(line.length).fill(false);
  for (let j = 0; j < line.length; j++) {
    const top = stack.at(-1);
    const c = line[j];
    if (top === "'") {
      if (c === "'") stack.pop();
      continue;
    }
    if (top === "'c" && c === "'" || top === '"c' && c === '"') {
      stack.pop();
      continue;
    }
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (top === '"') {
      if (c === '"') stack.pop();
      else if (c === "$" && line[j + 1] === "(") {
        stack.push("(");
        j += 1;
      } else if (c === "`") stack.push("`");
      continue;
    }
    if (c === "#" && top !== "'c" && top !== '"c' && (j === 0 || /[\s;&|(]/.test(line[j - 1]))) break;
    code[j] = true;
    if (c === "'" || c === '"') stack.push(SHELL_C.test(line.slice(0, j)) ? c + "c" : c);
    else if (c === "(") stack.push(c);
    else if (c === ")" && top === "(") stack.pop();
    else if (c === "`") {
      if (top === "`") stack.pop();
      else stack.push(c);
    }
  }
  return code;
}
function stateChangingGitLines(command) {
  const lines = command.split("\n");
  const found = [];
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const code = codePositions(line, stack);
    const opener = HEREDOC.exec(line);
    const heredoc = opener !== null && code[opener.index] ? opener : null;
    const close = heredoc === null ? i : lines.findIndex((l, j) => j > i && l.trim() === heredoc[2]);
    const bodyEnd = close === -1 ? lines.length : close;
    if (gitMatches(line).some((m) => code[m.at])) {
      const subject = firstLine(lines.slice(i + 1, bodyEnd).join("\n"));
      found.push(heredoc === null || subject === "" ? line : `${line} \u23CE ${subject}`);
    }
    i = heredoc === null ? i : bodyEnd;
  }
  return found;
}
function shownGitLine(line) {
  const matches = gitMatches(line);
  const chars = (from2, to) => Array.from(line.slice(from2, to)).length;
  const first = matches[0]?.at ?? 0;
  const from = chars(0) > RECORD_LINE_CHARS && chars(0, first) > RECORD_LINE_CHARS / 2 ? first : 0;
  const hidden = matches.filter((m) => m.at > from && chars(from, m.end) > RECORD_LINE_CHARS);
  return (from > 0 ? "\u2026" : "") + cutChars(line.slice(from), RECORD_LINE_CHARS) + hidden.map((m, k) => " \u2026" + cutChars(line.slice(m.at, hidden[k + 1]?.at), RECORD_LINE_CHARS / 3)).join("");
}
function firstLine(text) {
  return text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}
function joinedLines(text) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "").join(" \u23CE ");
}
function latest(rows) {
  return rows.slice(0, RECORD_LIST_CAP).reverse();
}
function segmentsOf(db, sessionId2, changes) {
  const messages = db.prepare(`
    SELECT ut.ts, ut.role, ut.text, e.model, ${COMPACT_ROW("ut")} AS compact
    FROM user_text ut LEFT JOIN event e ON e.uuid = ut.event_uuid
    WHERE ut.session_id = ? AND ${REAL_MESSAGE("ut")}
    ORDER BY ut.ts`).all(sessionId2).filter((m) => !isCompact(m));
  const breaks = db.prepare(`
    SELECT ts FROM system_reminder WHERE session_id = ? AND category = 'compaction'
    UNION SELECT ts FROM user_text WHERE session_id = ? AND type = 'continuation_summary'
    ORDER BY ts`).all(sessionId2, sessionId2).map((b) => Date.parse(b.ts));
  const segments = [];
  const terms = [];
  const turns = [];
  let next = 0;
  let previous = -Infinity;
  let lastIsFiller = false;
  for (const m of messages) {
    const at = Date.parse(m.ts);
    let cut = segments.length === 0 || at - previous > SEGMENT_PAUSE_MS;
    while (next < breaks.length && breaks[next] <= at) {
      next += 1;
      cut = true;
    }
    if (cut) {
      segments.push({
        started_at: m.ts,
        ended_at: m.ts,
        requests: 0,
        first_request: null,
        last_reply: null,
        closing: null,
        topics: [],
        last_change: null
      });
      terms.push(/* @__PURE__ */ new Map());
      turns.push([]);
    }
    const segment = segments.at(-1);
    segment.ended_at = m.ts;
    if (m.role === "user") {
      segment.requests += 1;
      segment.first_request ??= joinedLines(m.text);
      turns.at(-1).push({ at, reply: null, filler: false });
    } else {
      const text = joinedLines(m.text);
      const filler = Array.from(text).length <= SHORT_REPLY_CHARS || m.model === "<synthetic>" && CLAUDE_CODE_NOTICE.test(text);
      if (!filler || segment.last_reply === null || lastIsFiller) {
        segment.last_reply = text;
        segment.closing = null;
        lastIsFiller = filler;
      } else {
        segment.closing = text;
      }
      const turn = turns.at(-1).at(-1);
      if (turn !== void 0 && (!filler || turn.reply === null || turn.filler)) {
        turn.reply = text;
        turn.filler = filler;
      }
      const counts = terms.at(-1);
      for (const term of new Set(Array.from(m.text.matchAll(CODE_TERM), (t) => t[1].trim()))) {
        if (term !== "" && !NOT_A_TOPIC.test(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
      }
    }
    previous = at;
  }
  segments.forEach((g, i) => {
    g.topics = [...terms[i]].filter(([, n]) => n >= SEGMENT_TOPIC_REPLIES).sort((a, b) => b[1] - a[1]).slice(0, SEGMENT_TOPICS_SHOWN).map(([term]) => term);
    g.last_change = lastChange(turns[i], Date.parse(g.ended_at), changes);
    if (g.last_change?.reply === g.last_reply) g.last_change = null;
  });
  return segments;
}
function lastChange(turns, end, changes) {
  for (let k = turns.length - 1; k >= 0; k--) {
    const from = turns[k].at;
    const to = turns[k + 1]?.at ?? end + 1;
    let lo = 0;
    let hi = changes.length;
    while (lo < hi) {
      const mid = lo + hi >> 1;
      if (changes[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    if (lo === changes.length || changes[lo] >= to) continue;
    const reply = turns[k].reply;
    return k === turns.length - 1 || reply === null ? null : { request: k + 1, reply };
  }
  return null;
}
function sessionRecord(db, sessionId2) {
  const s = db.prepare("SELECT id, project_id, kind, source, cwd FROM session WHERE id = ?").get(sessionId2);
  if (!s) return null;
  const span = db.prepare(`
    SELECT min(ut.ts) AS started_at, max(ut.ts) AS ended_at FROM user_text ut
    WHERE ut.session_id = ? AND ${REAL_MESSAGE("ut")}`).get(sessionId2);
  const requests = s.kind === "subagent" ? [] : db.prepare(`
    SELECT ut.ts, ut.role, ut.text, ${COMPACT_ROW("ut")} AS compact FROM user_text ut
    WHERE ut.session_id = ? AND ut.role = 'user' AND ${REAL_MESSAGE("ut")}
    ORDER BY ut.ts DESC`).all(sessionId2).filter((r) => !isCompact(r));
  const reply = db.prepare(`
    SELECT ts, text FROM user_text ut
    WHERE ut.session_id = ? AND ut.role = 'assistant' AND ${REAL_MESSAGE("ut")}
    ORDER BY ts DESC LIMIT 1`).get(sessionId2);
  const edits = db.prepare(`
    ${TREE}
    SELECT path, count(*) AS count, max(ts) AS last_ts FROM file_op
    WHERE session_id IN tree AND tool IN ${EDIT_TOOLS}
    GROUP BY path ORDER BY last_ts DESC, path`).all(sessionId2);
  const git = db.prepare(`
    ${TREE}
    SELECT ts, name, input_json FROM tool_call
    WHERE session_id IN tree AND name IN ('Bash', 'exec_command', 'exec') AND input_json LIKE '%git %'
    ORDER BY ts DESC`).all(sessionId2).flatMap(({ ts, name, input_json }) => shellCommands(name, input_json).flatMap(stateChangingGitLines).reverse().map((line) => ({ ts, command: line })));
  const failedCalls = (excerpt) => db.prepare(`
    ${TREE}
    SELECT t.ts, t.name, t.input_json, ${excerpt} AS error_excerpt FROM tool_call t
    WHERE t.session_id IN tree AND t.is_error = 1
      AND NOT EXISTS (SELECT 1 FROM hook_block h WHERE h.call_id = t.call_id)
    ORDER BY t.ts DESC`).all(sessionId2);
  let failedRows;
  try {
    failedRows = failedCalls("t.error_excerpt");
  } catch (e) {
    if (!/no such column: (t\.)?error_excerpt/.test(e.message)) throw e;
    failedRows = failedCalls("NULL");
  }
  const failures = failedRows.map((r) => ({
    ts: r.ts,
    tool: r.name,
    input: firstLine(commandOf(r.input_json) ?? r.input_json ?? ""),
    error: r.error_excerpt === null ? null : joinedLines(r.error_excerpt)
  }));
  const hookBlocks = db.prepare(`
    ${TREE}
    SELECT ts, hook_event, tool, reason FROM hook_block
    WHERE session_id IN tree
    ORDER BY ts DESC`).all(sessionId2).map((r) => ({
    ts: r.ts,
    hook_event: r.hook_event,
    tool: r.tool,
    // NULL when the block carried no message; the prefix repeats hook_event and tool.
    reason: firstLine(r.reason ?? "").replace(/^\w+:\S+ hook error: /, "")
  }));
  const tempRoot = (path) => shortPath(path, s.cwd).startsWith("/") ? TEMP_ROOTS.find((root) => path.startsWith(root))?.slice(0, -1) : void 0;
  const kept = edits.filter((e) => tempRoot(e.path) === void 0);
  const temp = /* @__PURE__ */ new Map();
  for (const e of edits) {
    const root = tempRoot(e.path);
    if (root !== void 0) temp.set(root, (temp.get(root) ?? 0) + 1);
  }
  let segments = [];
  if (s.kind !== "subagent") {
    const editTimes = db.prepare(`
      ${TREE}
      SELECT ts, path FROM file_op
      WHERE session_id IN tree AND tool IN ${EDIT_TOOLS}`).all(sessionId2).filter((e) => tempRoot(e.path) === void 0).map((e) => e.ts);
    const changes = [...editTimes, ...git.filter((g) => CHANGE_GIT.test(g.command)).map((g) => g.ts)].map((ts) => Date.parse(ts)).sort((a, b) => a - b);
    segments = segmentsOf(db, sessionId2, changes);
  }
  return {
    session_id: s.id,
    project_id: s.project_id,
    source: s.source,
    cwd: s.cwd,
    started_at: span.started_at,
    ended_at: span.ended_at,
    requests: latest(requests).map((r) => ({ ts: r.ts, text: joinedLines(r.text) })),
    requests_total: requests.length,
    segments: segments.slice(-RECORD_SEGMENTS_CAP),
    segments_total: segments.length,
    last_reply: reply === void 0 ? null : { ts: reply.ts, text: joinedLines(reply.text) },
    edits: kept.slice(0, RECORD_EDITS_DETAILED),
    more_edits: kept.slice(RECORD_EDITS_DETAILED).map((e) => e.path),
    temp_edits: [...temp].map(([root, count]) => ({ root, count })).sort((a, b) => b.count - a.count),
    edits_total: edits.length,
    git: latest(git),
    git_total: git.length,
    failures: latest(failures),
    failures_total: failures.length,
    hook_blocks: latest(hookBlocks),
    hook_blocks_total: hookBlocks.length
  };
}
function byFolder(paths) {
  const folders = /* @__PURE__ */ new Map();
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const dir = slash === -1 ? "." : p.slice(0, slash) || "/";
    folders.set(dir, [...folders.get(dir) ?? [], p.slice(slash + 1)]);
  }
  const out = [];
  let room2 = RECORD_MORE_EDITS_CHARS;
  let shown = 0;
  for (const [dir, names] of folders) {
    let line = `${dir}: `;
    let taken = 0;
    for (const name of names) {
      const piece = (taken === 0 ? "" : ", ") + name;
      if (line.length + piece.length > room2) break;
      line += piece;
      taken += 1;
    }
    if (taken === 0) break;
    out.push(line);
    room2 -= line.length;
    shown += taken;
    if (taken < names.length) break;
  }
  if (shown < paths.length) out.push(`(+${paths.length - shown} more files)`);
  return out;
}
function formatSessionRecord(r) {
  const lines = [
    `session:${r.session_id}  project:${r.project_id ?? "?"}  ${r.source}  started:${r.started_at ?? "?"}  ended:${r.ended_at ?? "?"}`
  ];
  function section(name, header, total, rows, line) {
    if (total === 0) {
      lines.push(`${name}: (none)`);
      return;
    }
    lines.push(header, ...rows.map((row) => `  ${line(row)}`));
  }
  section(
    "Requests",
    `Requests (last ${r.requests.length} of ${r.requests_total}):`,
    r.requests_total,
    r.requests,
    (q) => `${q.ts}  ${cutChars(q.text, REQUEST_CHARS)}`
  );
  lines.push(r.last_reply === null ? "Last reply: (none)" : `Last reply: ${r.last_reply.ts}  ${cutChars(r.last_reply.text, RECORD_REPLY_CHARS)}`);
  const change = r.segments_total === 1 ? r.segments[0]?.last_change : null;
  if (change) lines.push(`Last change (request ${change.request} of ${r.segments[0].requests}): ${cutChars(change.reply, SEGMENT_REPLY_CHARS)}`);
  section(
    "Edited",
    `Edited (${r.edits_total} files):`,
    r.edits_total,
    r.edits,
    (e) => `${shortPath(e.path, r.cwd)}  ${e.count} edits, last ${e.last_ts}`
  );
  if (r.more_edits.length > 0) {
    lines.push("  Also edited, by folder:", ...byFolder(r.more_edits.map((p) => shortPath(p, r.cwd))).map((l) => `    ${l}`));
  }
  if (r.temp_edits.length > 0) {
    const count = r.temp_edits.reduce((n, t) => n + t.count, 0);
    lines.push(`  Temporary: ${count} files (${r.temp_edits.map((t) => `${t.root} ${t.count}`).join(", ")})`);
  }
  section(
    "Git",
    `Git (last ${r.git.length} of ${r.git_total}):`,
    r.git_total,
    r.git,
    (g) => `${g.ts}  ${shownGitLine(g.command)}`
  );
  section(
    "Failed tool calls",
    `Failed tool calls (last ${r.failures.length} of ${r.failures_total}):`,
    r.failures_total,
    r.failures,
    (f) => `${f.ts}  ${f.tool}: ${cutChars(f.input, FAILED_INPUT_CHARS)}${f.error === null ? "" : `
    ${f.error}`}`
  );
  section(
    "Hook blocks",
    `Hook blocks (last ${r.hook_blocks.length} of ${r.hook_blocks_total}):`,
    r.hook_blocks_total,
    r.hook_blocks,
    (b) => `${b.ts}  ${b.hook_event}${b.tool === null ? "" : ` ${b.tool}`}: ${cutChars(b.reason, RECORD_LINE_CHARS)}`
  );
  if (r.segments_total > 1) {
    const shown = r.segments.length === r.segments_total ? `${r.segments_total}` : `last ${r.segments.length} of ${r.segments_total}`;
    lines.push(`Segments (${shown}, split at compactions and pauses over 2 hours):`);
    for (const g of r.segments) {
      lines.push(
        `  ${g.started_at} \u2013 ${g.ended_at}  ${g.requests} requests`,
        `    First request: ${g.first_request === null ? "(none)" : cutChars(g.first_request, RECORD_LINE_CHARS)}`,
        ...g.topics.length === 0 ? [] : [`    Topics: ${cutChars(g.topics.join(", "), SEGMENT_REPLY_CHARS)}`],
        ...g.last_change === null ? [] : [
          `    Last change (request ${g.last_change.request} of ${g.requests}): ${cutChars(g.last_change.reply, SEGMENT_REPLY_CHARS)}`
        ],
        // The latest segment's last reply is most often the session's, which
        // the record shows above, and longer.
        `    Last reply: ${g.last_reply === null ? "(none)" : g.last_reply === r.last_reply?.text ? "(the Last reply above)" : cutChars(g.last_reply, SEGMENT_REPLY_CHARS)}` + (g.closing === null ? "" : ` (then: "${cutChars(g.closing, RECORD_LINE_CHARS)}")`)
      );
    }
  }
  return lines.join("\n");
}
function formatSessionRecordWithin(r, chars) {
  let text = formatSessionRecord(r);
  for (let drop = 1; text.length > chars && drop < r.segments.length; drop++) {
    text = formatSessionRecord({ ...r, segments: r.segments.slice(drop) });
  }
  return text;
}

// src/util/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function clensHome() {
  if (process.env.CLENS_HOME !== void 0 && process.env.CLENS_INDEX_DIR === void 0) {
    return join(process.env.CLENS_HOME, "__no_clens__");
  }
  return process.env.CLENS_INDEX_DIR ?? join(homedir(), ".clens");
}
function indexDbPath() {
  return join(clensHome(), "index.db");
}

// src/hooks/compact.ts
var Database;
try {
  ({ default: Database } = await import("better-sqlite3"));
} catch {
  process.exit(0);
}
var MAX_CHARS = 9e3;
var END = "END-OF-CLENS-RECORD";
var input = "";
for await (const chunk of process.stdin) input += chunk;
var { session_id: sessionId, source } = JSON.parse(input);
if (source !== "compact" || typeof sessionId !== "string") process.exit(0);
var record;
try {
  const db = new Database(indexDbPath(), { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  record = sessionRecord(db, sessionId);
  db.close();
} catch {
  process.exit(0);
}
if (!record) process.exit(0);
var head = "clens work record of this session, from its transcript (the conversation was just compacted). Read more of it with clens_session.\n";
var room = MAX_CHARS - head.length - END.length - 80;
var body = formatSessionRecordWithin(record, room);
if (body.length > room) body = body.slice(0, room) + `
\u2026 cut; clens_left_off session_id "current" gives it whole.`;
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${head}${body}
${END}` }
  })
);
