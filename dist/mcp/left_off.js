/**
 * clens_left_off — where work stopped: the latest sessions of a project, or
 * the sessions that edited a file, each with when its conversation ended,
 * the last request, the last reply and the files it edited. The reply is
 * returned as written; the caller reads it to say where things stand.
 * Given one session id instead, it returns that session's work record
 * (sessionRecord), for picking up after the conversation was compacted.
 */
import { execCodeCommands } from "../util/codex_exec.js";
import { TEMP_ROOTS } from "../util/temp_dirs.js";
import { cutChars, notNoise } from "./search.js";
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;
const EDIT_TOOLS = "('Edit', 'Write', 'NotebookEdit', 'apply_patch', 'Bash', 'exec_command')";
const REQUEST_CHARS = 500;
const REPLY_CHARS = 1500;
const FILES_SHOWN = 10;
/** A slash command typed with nothing after it ("/compact", "/clear") acts on
 *  the session; it is not a request. A pasted path also starts with "/" but
 *  has more slashes, and stays. */
const BARE_COMMAND = (alias) => `(substr(${alias}.text, 1, 1) = '/' AND instr(substr(${alias}.text, 2), '/') = 0
    AND instr(${alias}.text, ' ') = 0 AND instr(${alias}.text, char(10)) = 0)`;
/** A subagent's edits are its parent's work. TREE is a session and every
 *  subagent under it; TOP maps each session to the one at the top of its
 *  tree. UNION, not UNION ALL, so a cycle ends. */
const TREE = `WITH RECURSIVE tree(id) AS (
    SELECT ? UNION SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.id)`;
const TOP = `WITH RECURSIVE top(id, root) AS (
    SELECT id, id FROM session WHERE parent_id IS NULL
    UNION SELECT s.id, t.root FROM session s JOIN top t ON s.parent_id = t.id)`;
/** A conversation message worth reading. */
const REAL_MESSAGE = (alias) => `${alias}.type IN ('user_message', 'assistant_message') AND ${notNoise(alias)} AND NOT ${BARE_COMMAND(alias)}`;
export function leftOff(db, params, opts = {}) {
    return leftOffWithMore(db, params, opts).sessions;
}
/** leftOff plus how many sessions it left out that were active in the span
 *  it lists: a recap of the latest three otherwise missed one running beside
 *  them, with nothing to say it was there. Counted for a project's or every
 *  project's list, not for a file's. */
export function leftOffWithMore(db, params, opts = {}) {
    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    // Only sessions the user worked in: not judge transcripts, subagent
    // threads or one-shot exec and SDK runs (automated summaries among them),
    // which another program started.
    const conditions = ["s.kind = 'interactive'"];
    const bindings = [];
    if (params.project_id) {
        conditions.push("s.project_id = ?");
        bindings.push(params.project_id);
    }
    // In Claude Code the conversation asking is always the newest; it is not
    // where earlier work stopped.
    if (opts.currentSessionId) {
        conditions.push("s.id != ?");
        bindings.push(opts.currentSessionId);
    }
    // The window bounds every query below, so a session is listed when it was
    // active inside it and shows its last request, reply and edits there.
    const windowArgs = [params.since, params.until].filter((v) => Boolean(v));
    const inWindow = (col) => (params.since ? ` AND ${col} >= ?` : "") + (params.until ? ` AND ${col} <= ?` : "");
    const bySession = `
      SELECT s.id AS session_id, max(ut.ts) AS last_ts
      FROM session s JOIN user_text ut ON ut.session_id = s.id
      WHERE ${REAL_MESSAGE("ut")}${inWindow("ut.ts")} AND ${conditions.join(" AND ")}
      GROUP BY s.id`;
    let sessions;
    if (params.file) {
        const tail = params.file.replace(/^\.\//, "");
        const like = "%/" + tail.replace(/[\\%_]/g, (c) => "\\" + c);
        sessions = db.prepare(`
      ${TOP}
      SELECT s.id AS session_id, max(f.ts) AS edited_at
      FROM file_op f JOIN top ON top.id = f.session_id JOIN session s ON s.id = top.root
      WHERE f.tool IN ${EDIT_TOOLS} AND (f.path = ? OR f.path LIKE ? ESCAPE '\\')${inWindow("f.ts")}
        AND ${conditions.join(" AND ")}
      GROUP BY s.id
      ORDER BY edited_at DESC
      LIMIT ?`).all(params.file, like, ...windowArgs, ...bindings, limit);
    }
    else {
        sessions = db.prepare(`${bySession}
      ORDER BY last_ts DESC
      LIMIT ?`).all(...windowArgs, ...bindings, limit);
    }
    const info = db.prepare("SELECT project_id, source, cwd FROM session WHERE id = ?");
    const first = db.prepare(`
    SELECT min(ut.ts) AS ts FROM user_text ut
    WHERE ut.session_id = ? AND ${REAL_MESSAGE("ut")}${inWindow("ut.ts")}`);
    const last = db.prepare(`
    SELECT ut.text, ut.ts FROM user_text ut
    WHERE ut.session_id = ? AND ut.role = ? AND ${REAL_MESSAGE("ut")}${inWindow("ut.ts")}
    ORDER BY ut.ts DESC LIMIT 1`);
    const files = db.prepare(`
    ${TREE}
    SELECT path, max(ts) AS at FROM file_op
    WHERE session_id IN tree AND tool IN ${EDIT_TOOLS}${inWindow("ts")}
    GROUP BY path ORDER BY at DESC, path`);
    const listed = sessions.map(({ session_id }) => {
        const s = info.get(session_id);
        const request = last.get(session_id, "user", ...windowArgs);
        const reply = last.get(session_id, "assistant", ...windowArgs);
        const start = first.get(session_id, ...windowArgs);
        return {
            session_id,
            project_id: s.project_id,
            source: s.source,
            cwd: s.cwd,
            started_at: start.ts ?? "",
            ended_at: [request?.ts ?? "", reply?.ts ?? ""].sort()[1],
            last_request: request?.text ?? null,
            last_reply: reply?.text ?? null,
            files: files.all(session_id, ...windowArgs).map((r) => r.path),
        };
    });
    // Every session left out ended no later than the oldest listed one, so it
    // shares the listed span when its last message is at or after the earliest
    // listed start. The listed sessions are counted too, and subtracted.
    const more = { count: 0, since: "" };
    if (!params.file && listed.length === limit) {
        more.since = listed.map((s) => s.started_at).sort()[0];
        const { n } = db.prepare(`SELECT count(*) AS n FROM (${bySession}) WHERE last_ts >= ?`)
            .get(...windowArgs, ...bindings, more.since);
        more.count = n - listed.length;
    }
    return { sessions: listed, more };
}
/** A path under the session's working directory is shown relative to it. */
function shortPath(path, cwd) {
    if (!cwd)
        return path;
    const base = cwd.replace(/\/+$/, "") + "/";
    return path.startsWith(base) ? path.slice(base.length) : path;
}
export function formatLeftOff(sessions, more) {
    if (sessions.length === 0)
        return "No sessions found.";
    const footer = more && more.count > 0
        ? `\n\n(+${more.count} more session${more.count === 1 ? "" : "s"} active since ${more.since} ${more.count === 1 ? "is" : "are"} not listed; raise limit (max 10) or narrow since/until to see ${more.count === 1 ? "it" : "them"})`
        : "";
    return sessions
        .map((s, i) => {
        const lines = [
            `[${i + 1}] ${s.ended_at}  session:${s.session_id}  project:${s.project_id ?? "?"}  ${s.source}  started:${s.started_at}`,
        ];
        if (s.last_request)
            lines.push(`Last request: ${cutChars(s.last_request, REQUEST_CHARS)}`);
        if (s.last_reply)
            lines.push(`Last reply: ${cutChars(s.last_reply, REPLY_CHARS)}`);
        if (s.files.length > 0) {
            // The project's own files first: scratch files outside it otherwise
            // filled the list.
            const paths = s.files.map((p) => shortPath(p, s.cwd));
            const ordered = [...paths.filter((p) => !p.startsWith("/")), ...paths.filter((p) => p.startsWith("/"))];
            const shown = ordered.slice(0, FILES_SHOWN);
            const more = s.files.length - shown.length;
            lines.push(`Edited: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
        }
        return lines.join("\n");
    })
        .join("\n\n") + footer;
}
const RECORD_LIST_CAP = 10;
const RECORD_LINE_CHARS = 120;
const FAILED_INPUT_CHARS = 100;
/** Edited files shown with their edit count and time; the rest by folder,
 *  names only, up to RECORD_MORE_EDITS_CHARS. */
const RECORD_EDITS_DETAILED = 5;
const RECORD_MORE_EDITS_CHARS = 1200;
const RECORD_REPLY_CHARS = 500;
/** A pause longer than this starts a new segment, as a compaction does. */
const SEGMENT_PAUSE_MS = 2 * 60 * 60 * 1000;
const RECORD_SEGMENTS_CAP = 20;
const SEGMENT_REPLY_CHARS = 240;
const SEGMENT_TOPICS_SHOWN = 6;
const SEGMENT_TOPIC_REPLIES = 2;
/** A term in backticks: a name, a path, a command. */
const CODE_TERM = /`([^`\n]{2,40})`/g;
/** Terms that do not say what was worked on: a commit hash, a number. */
const NOT_A_TOPIC = /^(?:[0-9a-f]{7,40}|[\d.,%:\s-]+)$/;
/** A reply this short ("네.", "알겠습니다. 기다리겠습니다.") says nothing of
 *  the work: in the index, nearly every segment that ended on one did. */
const SHORT_REPLY_CHARS = 20;
/** A notice Claude Code writes as a reply of its own (model "<synthetic>"),
 *  which says nothing of the work either. Other "<synthetic>" replies hold
 *  real text, so the model alone does not decide. */
const CLAUDE_CODE_NOTICE = /^(?:API Error|Prompt is too long|You've hit your |Please run \/login)/;
/** /compact with instructions after it is stored as a message; bare
 *  /compact is left out as BARE_COMMAND already. Claude Code also stores the
 *  instructions alone, as a command message whose slash_command is compact. */
const COMPACT_COMMAND = /^\/compact(?:\s|$)/;
/** 1 when the message is a compact command's message. IN, not a correlated
 *  EXISTS: slash_command has no event_uuid index, so EXISTS scanned every
 *  compact row per message. */
const COMPACT_ROW = (alias) => `${alias}.event_uuid IN (SELECT event_uuid FROM slash_command WHERE name = 'compact')`;
/** A git command that changes what others see: with an edit, what makes a
 *  request one that changed something. */
const CHANGE_GIT = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|merge|push)\b/;
/** A /compact is not a request: one typed after a long pause made a segment
 *  of its own, with no reply. */
function isCompact(m) {
    return m.role === "user" && (m.compact === 1 || COMPACT_COMMAND.test(m.text));
}
/** The command of a shell input: a Claude Code Bash input's `command` or a
 *  Codex exec_command input's `cmd`. The parser keeps a shell input up to
 *  64 KB and cuts a longer one, which leaves it invalid JSON, so the command
 *  is then read off the front of the text, where it always sits. */
export function commandOf(inputJson) {
    if (inputJson === null)
        return null;
    try {
        const parsed = JSON.parse(inputJson);
        if (typeof parsed !== "object" || parsed === null)
            return null;
        const { command, cmd } = parsed;
        return typeof command === "string" ? command : typeof cmd === "string" ? cmd : null;
    }
    catch {
        const m = /"(?:command|cmd)":"((?:[^"\\]|\\.)*)/.exec(inputJson);
        if (m === null)
            return null;
        try {
            return JSON.parse('"' + m[1] + '"');
        }
        catch {
            // The cut fell inside an escape such as \u00.
            return m[1];
        }
    }
}
/** git followed by a subcommand that changes state, at the start of a line
 *  or after &&, || or ;. Used only through matchAll, which copies it. */
const STATE_CHANGING_GIT = /(?:^|&&|\|\||;)\s*git\s+(?:-C\s+\S+\s+)?(?:commit|checkout|switch|merge|rebase|reset|stash|push|branch)\b/g;
/** A heredoc opener (<<EOF, <<'EOF', <<-"EOF"), not a here-string (<<<). */
const HEREDOC = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/;
/** Each state-changing git command in one line: where its `git` starts and
 *  where its subcommand ends. */
function gitMatches(line) {
    return [...line.matchAll(STATE_CHANGING_GIT)].map((m) => ({ at: m.index + m[0].indexOf("git"), end: m.index + m[0].length }));
}
/** A shell run with -c (or -lc, -ec, …) before the string it runs:
 *  `/bin/zsh -lc '…'`, as older Codex wraps every command. */
const SHELL_C = /(?:^|[\s;&|(])(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c[A-Za-z]*\s+$/;
/** Which positions of `line` are shell code, not the inside of a '…' or "…"
 *  string or a comment. `stack` holds the quotes and $( ), ( ) and `…` still
 *  open from the lines before, and is updated; code in a $( ) or `…` inside
 *  "…" is code again, and so is the string a `sh -c` runs ('c or "c). */
function codePositions(line, stack) {
    const code = new Array(line.length).fill(false);
    for (let j = 0; j < line.length; j++) {
        const top = stack.at(-1);
        const c = line[j];
        if (top === "'") {
            if (c === "'")
                stack.pop();
            continue;
        }
        if ((top === "'c" && c === "'") || (top === '"c' && c === '"')) {
            stack.pop();
            continue;
        }
        if (c === "\\") {
            j += 1;
            continue;
        }
        if (top === '"') {
            if (c === '"')
                stack.pop();
            else if (c === "$" && line[j + 1] === "(") {
                stack.push("(");
                j += 1;
            }
            else if (c === "`")
                stack.push("`");
            continue;
        }
        if (c === "#" && top !== "'c" && top !== '"c' && (j === 0 || /[\s;&|(]/.test(line[j - 1])))
            break;
        code[j] = true;
        if (c === "'" || c === '"')
            stack.push(SHELL_C.test(line.slice(0, j)) ? c + "c" : c);
        else if (c === "(")
            stack.push(c);
        else if (c === ")" && top === "(")
            stack.pop();
        else if (c === "`") {
            if (top === "`")
                stack.pop();
            else
                stack.push(c);
        }
    }
    return code;
}
/** Every line of `command` that runs a state-changing git command, in order.
 *  Git text inside a quoted string or a comment is not a command: a script
 *  passed to `node -e` can hold a list of git commands as data. A heredoc's
 *  body is text (a commit message, a file being written), not commands, so
 *  it is skipped; when a git line opens one, as
 *  `git commit -m "$(cat <<'EOF'` does, the body's first line, the commit
 *  subject, is added after " ⏎ ". */
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
            found.push(heredoc === null || subject === "" ? line : `${line} ⏎ ${subject}`);
        }
        i = heredoc === null ? i : bodyEnd;
    }
    return found;
}
/** A git line as printed: cut to RECORD_LINE_CHARS, but started at its git
 *  command (after "…") when the line is too long and the command sits past
 *  its first half, where the cut would hide it. A later git command the cut
 *  still hides is added after the cut, from its git word. */
function shownGitLine(line) {
    const matches = gitMatches(line);
    const chars = (from, to) => Array.from(line.slice(from, to)).length;
    const first = matches[0]?.at ?? 0;
    const from = chars(0) > RECORD_LINE_CHARS && chars(0, first) > RECORD_LINE_CHARS / 2 ? first : 0;
    const hidden = matches.filter((m) => m.at > from && chars(from, m.end) > RECORD_LINE_CHARS);
    return (from > 0 ? "…" : "") + cutChars(line.slice(from), RECORD_LINE_CHARS)
        + hidden.map((m, k) => " …" + cutChars(line.slice(m.at, hidden[k + 1]?.at), RECORD_LINE_CHARS / 3)).join("");
}
function firstLine(text) {
    return text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}
/** Every non-empty line, joined by " ⏎ " so the text prints on one line. */
function joinedLines(text) {
    return text.split("\n").map((l) => l.trim()).filter((l) => l !== "").join(" ⏎ ");
}
/** Newest-first rows cut to the cap and put oldest first. */
function latest(rows) {
    return rows.slice(0, RECORD_LIST_CAP).reverse();
}
/** A session's messages, oldest first, cut into segments: before and after
 *  each compaction, and across each pause over SEGMENT_PAUSE_MS. The reply
 *  before a break is most often where the work stood, which the latest
 *  requests alone do not show for a session that ran for days. changes are
 *  the times something changed, in milliseconds, in order. */
function segmentsOf(db, sessionId, changes) {
    const messages = db.prepare(`
    SELECT ut.ts, ut.role, ut.text, e.model, ${COMPACT_ROW("ut")} AS compact
    FROM user_text ut LEFT JOIN event e ON e.uuid = ut.event_uuid
    WHERE ut.session_id = ? AND ${REAL_MESSAGE("ut")}
    ORDER BY ut.ts`).all(sessionId)
        .filter((m) => !isCompact(m));
    // A compaction row, or for a session indexed before those were written
    // and whose transcript is gone since, the summary the conversation starts
    // again with. A session with both has the two a moment apart, with no
    // message between them to make a segment of.
    const breaks = db.prepare(`
    SELECT ts FROM system_reminder WHERE session_id = ? AND category = 'compaction'
    UNION SELECT ts FROM user_text WHERE session_id = ? AND type = 'continuation_summary'
    ORDER BY ts`).all(sessionId, sessionId).map((b) => Date.parse(b.ts));
    const segments = [];
    // Per segment, how many of its replies mention each code term, in the
    // order the terms first came.
    const terms = [];
    // Per segment, its requests: when each came and the reply that closed it,
    // chosen as last_reply is.
    const turns = [];
    let next = 0;
    let previous = -Infinity;
    // Whether the segment's last_reply so far is a short reply or a notice.
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
                started_at: m.ts, ended_at: m.ts, requests: 0, first_request: null, last_reply: null, closing: null, topics: [], last_change: null,
            });
            terms.push(new Map());
            turns.push([]);
        }
        const segment = segments.at(-1);
        segment.ended_at = m.ts;
        if (m.role === "user") {
            segment.requests += 1;
            segment.first_request ??= joinedLines(m.text);
            turns.at(-1).push({ at, reply: null, filler: false });
        }
        else {
            const text = joinedLines(m.text);
            const filler = Array.from(text).length <= SHORT_REPLY_CHARS
                || (m.model === "<synthetic>" && CLAUDE_CODE_NOTICE.test(text));
            if (!filler || segment.last_reply === null || lastIsFiller) {
                segment.last_reply = text;
                segment.closing = null;
                lastIsFiller = filler;
            }
            else {
                segment.closing = text;
            }
            const turn = turns.at(-1).at(-1);
            if (turn !== undefined && (!filler || turn.reply === null || turn.filler)) {
                turn.reply = text;
                turn.filler = filler;
            }
            const counts = terms.at(-1);
            for (const term of new Set(Array.from(m.text.matchAll(CODE_TERM), (t) => t[1].trim()))) {
                if (term !== "" && !NOT_A_TOPIC.test(term))
                    counts.set(term, (counts.get(term) ?? 0) + 1);
            }
        }
        previous = at;
    }
    segments.forEach((g, i) => {
        // A stable sort, so a tie keeps the term that came first.
        g.topics = [...terms[i]].filter(([, n]) => n >= SEGMENT_TOPIC_REPLIES)
            .sort((a, b) => b[1] - a[1]).slice(0, SEGMENT_TOPICS_SHOWN).map(([term]) => term);
        g.last_change = lastChange(turns[i], Date.parse(g.ended_at), changes);
        // The requests after it got no reply yet, or only short ones.
        if (g.last_change?.reply === g.last_reply)
            g.last_change = null;
    });
    return segments;
}
/** A segment's last_change, from its requests and the segment's last
 *  message time. A request's work runs up to the next request, and the last
 *  request's up to that last message. */
function lastChange(turns, end, changes) {
    for (let k = turns.length - 1; k >= 0; k--) {
        const from = turns[k].at;
        const to = turns[k + 1]?.at ?? end + 1;
        // The first change at or after from.
        let lo = 0;
        let hi = changes.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (changes[mid] < from)
                lo = mid + 1;
            else
                hi = mid;
        }
        if (lo === changes.length || changes[lo] >= to)
            continue;
        const reply = turns[k].reply;
        return k === turns.length - 1 || reply === null ? null : { request: k + 1, reply };
    }
    return null;
}
/** One session's work record: its requests, and the edits, state-changing
 *  git commands, failed tool calls and hook blocks of it and every subagent
 *  under it. Null when the session is not in the index. */
export function sessionRecord(db, sessionId) {
    const s = db.prepare("SELECT id, project_id, kind, source, cwd FROM session WHERE id = ?").get(sessionId);
    if (!s)
        return null;
    const span = db.prepare(`
    SELECT min(ut.ts) AS started_at, max(ut.ts) AS ended_at FROM user_text ut
    WHERE ut.session_id = ? AND ${REAL_MESSAGE("ut")}`).get(sessionId);
    // A subagent's "user" is the agent that started it, not the user. A
    // /compact is left out as in the segments, so their counts add up.
    const requests = s.kind === "subagent" ? [] : db.prepare(`
    SELECT ut.ts, ut.role, ut.text, ${COMPACT_ROW("ut")} AS compact FROM user_text ut
    WHERE ut.session_id = ? AND ut.role = 'user' AND ${REAL_MESSAGE("ut")}
    ORDER BY ut.ts DESC`).all(sessionId)
        .filter((r) => !isCompact(r));
    const reply = db.prepare(`
    SELECT ts, text FROM user_text ut
    WHERE ut.session_id = ? AND ut.role = 'assistant' AND ${REAL_MESSAGE("ut")}
    ORDER BY ts DESC LIMIT 1`).get(sessionId);
    const edits = db.prepare(`
    ${TREE}
    SELECT path, count(*) AS count, max(ts) AS last_ts FROM file_op
    WHERE session_id IN tree AND tool IN ${EDIT_TOOLS}
    GROUP BY path ORDER BY last_ts DESC, path`).all(sessionId);
    // Never json_extract: a cut input is not valid JSON and stops the query.
    const git = db.prepare(`
    ${TREE}
    SELECT ts, name, input_json FROM tool_call
    WHERE session_id IN tree AND name IN ('Bash', 'exec_command', 'exec') AND input_json LIKE '%git %'
    ORDER BY ts DESC`).all(sessionId)
        // Newest first like the rows, so a call's lines are reversed here and
        // come back in their own order when latest() puts the list oldest first.
        // Codex exec code runs its commands through tools.exec_command; a command
        // past the stored input's 64 KB cut is not seen.
        .flatMap(({ ts, name, input_json }) => {
        const commands = name === "exec"
            ? execCodeCommands(input_json ?? "").map((c) => c.cmd)
            : [commandOf(input_json)].filter((c) => c !== null);
        return commands.flatMap(stateChangingGitLines).reverse().map((line) => ({ ts, command: line }));
    });
    // A call a hook blocked is listed under hook blocks, with its reason.
    const failures = db.prepare(`
    ${TREE}
    SELECT t.ts, t.name, t.input_json FROM tool_call t
    WHERE t.session_id IN tree AND t.is_error = 1
      AND NOT EXISTS (SELECT 1 FROM hook_block h WHERE h.call_id = t.call_id)
    ORDER BY t.ts DESC`).all(sessionId)
        .map((r) => ({ ts: r.ts, tool: r.name, input: firstLine(commandOf(r.input_json) ?? r.input_json ?? "") }));
    const hookBlocks = db.prepare(`
    ${TREE}
    SELECT ts, hook_event, tool, reason FROM hook_block
    WHERE session_id IN tree
    ORDER BY ts DESC`).all(sessionId)
        .map((r) => ({
        ts: r.ts,
        hook_event: r.hook_event,
        tool: r.tool,
        // NULL when the block carried no message; the prefix repeats hook_event and tool.
        reason: firstLine(r.reason ?? "").replace(/^\w+:\S+ hook error: /, ""),
    }));
    // Listed, scratch files took the places of the files that matter, such as
    // a settings file outside the project that the session changed.
    const tempRoot = (path) => shortPath(path, s.cwd).startsWith("/") ? TEMP_ROOTS.find((root) => path.startsWith(root))?.slice(0, -1) : undefined;
    const kept = edits.filter((e) => tempRoot(e.path) === undefined);
    const temp = new Map();
    for (const e of edits) {
        const root = tempRoot(e.path);
        if (root !== undefined)
            temp.set(root, (temp.get(root) ?? 0) + 1);
    }
    let segments = [];
    if (s.kind !== "subagent") {
        const editTimes = db.prepare(`
      ${TREE}
      SELECT ts, path FROM file_op
      WHERE session_id IN tree AND tool IN ${EDIT_TOOLS}`).all(sessionId)
            .filter((e) => tempRoot(e.path) === undefined).map((e) => e.ts);
        const changes = [...editTimes, ...git.filter((g) => CHANGE_GIT.test(g.command)).map((g) => g.ts)]
            .map((ts) => Date.parse(ts)).sort((a, b) => a - b);
        segments = segmentsOf(db, sessionId, changes);
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
        last_reply: reply === undefined ? null : { ts: reply.ts, text: joinedLines(reply.text) },
        edits: kept.slice(0, RECORD_EDITS_DETAILED),
        more_edits: kept.slice(RECORD_EDITS_DETAILED).map((e) => e.path),
        temp_edits: [...temp].map(([root, count]) => ({ root, count })).sort((a, b) => b.count - a.count),
        edits_total: edits.length,
        git: latest(git),
        git_total: git.length,
        failures: latest(failures),
        failures_total: failures.length,
        hook_blocks: latest(hookBlocks),
        hook_blocks_total: hookBlocks.length,
    };
}
/** One "folder: name, name" line per folder, folders in the order their
 *  first path comes, cut at RECORD_MORE_EDITS_CHARS with a count of the
 *  files left out. */
function byFolder(paths) {
    const folders = new Map();
    for (const p of paths) {
        const slash = p.lastIndexOf("/");
        const dir = slash === -1 ? "." : p.slice(0, slash) || "/";
        folders.set(dir, [...(folders.get(dir) ?? []), p.slice(slash + 1)]);
    }
    const out = [];
    let room = RECORD_MORE_EDITS_CHARS;
    let shown = 0;
    for (const [dir, names] of folders) {
        let line = `${dir}: `;
        let taken = 0;
        for (const name of names) {
            const piece = (taken === 0 ? "" : ", ") + name;
            if (line.length + piece.length > room)
                break;
            line += piece;
            taken += 1;
        }
        if (taken === 0)
            break;
        out.push(line);
        room -= line.length;
        shown += taken;
        if (taken < names.length)
            break;
    }
    if (shown < paths.length)
        out.push(`(+${paths.length - shown} more files)`);
    return out;
}
/** Every section says how many of how many it shows, so a cut list is never
 *  read as complete. */
export function formatSessionRecord(r) {
    const lines = [
        `session:${r.session_id}  project:${r.project_id ?? "?"}  ${r.source}  started:${r.started_at ?? "?"}  ended:${r.ended_at ?? "?"}`,
    ];
    function section(name, header, total, rows, line) {
        if (total === 0) {
            lines.push(`${name}: (none)`);
            return;
        }
        lines.push(header, ...rows.map((row) => `  ${line(row)}`));
    }
    section("Requests", `Requests (last ${r.requests.length} of ${r.requests_total}):`, r.requests_total, r.requests, (q) => `${q.ts}  ${cutChars(q.text, REQUEST_CHARS)}`);
    lines.push(r.last_reply === null
        ? "Last reply: (none)"
        : `Last reply: ${r.last_reply.ts}  ${cutChars(r.last_reply.text, RECORD_REPLY_CHARS)}`);
    section("Edited", `Edited (${r.edits_total} files):`, r.edits_total, r.edits, (e) => `${shortPath(e.path, r.cwd)}  ${e.count} edits, last ${e.last_ts}`);
    if (r.more_edits.length > 0) {
        lines.push("  Also edited, by folder:", ...byFolder(r.more_edits.map((p) => shortPath(p, r.cwd))).map((l) => `    ${l}`));
    }
    if (r.temp_edits.length > 0) {
        const count = r.temp_edits.reduce((n, t) => n + t.count, 0);
        lines.push(`  Temporary: ${count} files (${r.temp_edits.map((t) => `${t.root} ${t.count}`).join(", ")})`);
    }
    section("Git", `Git (last ${r.git.length} of ${r.git_total}):`, r.git_total, r.git, (g) => `${g.ts}  ${shownGitLine(g.command)}`);
    section("Failed tool calls", `Failed tool calls (last ${r.failures.length} of ${r.failures_total}):`, r.failures_total, r.failures, (f) => `${f.ts}  ${f.tool}: ${cutChars(f.input, FAILED_INPUT_CHARS)}`);
    section("Hook blocks", `Hook blocks (last ${r.hook_blocks.length} of ${r.hook_blocks_total}):`, r.hook_blocks_total, r.hook_blocks, (b) => `${b.ts}  ${b.hook_event}${b.tool === null ? "" : ` ${b.tool}`}: ${cutChars(b.reason, RECORD_LINE_CHARS)}`);
    // Last, because hooks/compact.mjs leaves out segments and then cuts the
    // record from its end to fit, and the sections above are what a compaction
    // summary tends to drop. One segment is the whole session, which those
    // sections already show.
    if (r.segments_total > 1) {
        const shown = r.segments.length === r.segments_total ? `${r.segments_total}` : `last ${r.segments.length} of ${r.segments_total}`;
        lines.push(`Segments (${shown}, split at compactions and pauses over 2 hours):`);
        for (const g of r.segments) {
            lines.push(`  ${g.started_at} – ${g.ended_at}  ${g.requests} requests`, `    First request: ${g.first_request === null ? "(none)" : cutChars(g.first_request, RECORD_LINE_CHARS)}`, ...(g.topics.length === 0 ? [] : [`    Topics: ${cutChars(g.topics.join(", "), SEGMENT_REPLY_CHARS)}`]), ...(g.last_change === null ? [] : [
                `    Last change (request ${g.last_change.request} of ${g.requests}): ${cutChars(g.last_change.reply, SEGMENT_REPLY_CHARS)}`,
            ]), `    Last reply: ${g.last_reply === null ? "(none)" : cutChars(g.last_reply, SEGMENT_REPLY_CHARS)}`
                + (g.closing === null ? "" : ` (then: "${cutChars(g.closing, RECORD_LINE_CHARS)}")`));
        }
    }
    return lines.join("\n");
}
/** The record in at most chars characters, if leaving out its oldest
 *  segments, down to the latest one, does it; the caller cuts what is still
 *  over. A plain cut from the end would drop the latest segments first. */
export function formatSessionRecordWithin(r, chars) {
    let text = formatSessionRecord(r);
    for (let drop = 1; text.length > chars && drop < r.segments.length; drop++) {
        text = formatSessionRecord({ ...r, segments: r.segments.slice(drop) });
    }
    return text;
}
//# sourceMappingURL=left_off.js.map