/**
 * clens_recent — date/project-filtered user message listing.
 *
 * Keyword is optional. Returns recent user messages ordered by ts DESC;
 * an optional `query` narrows via LIKE rather than FTS5 — the since/until
 * + project_id filters already keep the candidate row count small, so a
 * plain LIKE scan is cheap and doesn't disturb the time ordering.
 */
import { notCopiedClause, workKindClause } from "../analyzer/scope.js";
import { notNoise } from "./search.js";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
export function recentUserText(db, params) {
    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const conditions = [];
    const bindings = [];
    if (params.project_id) {
        conditions.push("s.project_id = ?");
        bindings.push(params.project_id);
    }
    if (params.since) {
        conditions.push("ut.ts >= ?");
        bindings.push(params.since);
    }
    if (params.until) {
        conditions.push("ut.ts <= ?");
        bindings.push(params.until);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // `a` is an assistant reply in the turn the user row `ut` opened: after it
    // and before the session's next user message.
    const inTurn = `a.session_id = ut.session_id
         AND a.role = 'assistant'
         AND a.ts > ut.ts
         AND NOT EXISTS (
           SELECT 1 FROM user_text u2
           WHERE u2.session_id = ut.session_id AND u2.role = 'user'
             AND u2.ts > ut.ts AND u2.ts < a.ts
         )`;
    const firstReply = `(SELECT a.text FROM user_text a WHERE ${inTurn} ORDER BY a.ts ASC LIMIT 1)`;
    // Only what the user wrote, as search's role "user" finds it. Command
    // messages are listed for what was typed after the command; rows holding no
    // message (an empty command, a task notification, an interrupt marker; see
    // notNoise) stay out, and so do threads whose "user" is an agent: a
    // subagent's, and one-shot exec runs with theirs (workKindClause). A
    // message copied into a resumed session is listed once.
    const userRows = `
    FROM user_text ut
    JOIN session s ON s.id = ut.session_id
    ${where}
    AND ut.role = 'user'
    AND ut.type != 'continuation_summary'
    AND ${workKindClause("s")}
    AND s.kind IS NOT 'subagent'
    AND ${notNoise("ut")}
    AND ${notCopiedClause("ut.event_uuid", "ut.session_id")}`;
    // The keyword filter also matches the assistant's replies in the turn: a
    // topic often appears only in the answer, and matching the user's words
    // alone left those turns unfindable here. When only a reply matches, the
    // reply shown is the first one that does, since a turn's first reply is
    // often a short "let me check" rather than the answer.
    if (params.query) {
        const like = `%${params.query}%`;
        // Same turn as inTurn, computed once per user row: the turn ends at the
        // session's next user message. Both ends are plain comparisons so the
        // (session_id, ts) index bounds the range; inTurn's NOT EXISTS, or an OR
        // on the upper end, scanned to the end of the session for every user row
        // and made a project-wide keyword call ~30x slower.
        const reply = `SELECT a.text FROM user_text a
         WHERE a.session_id = t.session_id AND a.role = 'assistant'
           AND a.ts > t.ts AND a.ts <= COALESCE(t.next_ts, '9999')`;
        const sql = `
      WITH t AS (
        SELECT ut.session_id, ut.ts, ut.text,
          (SELECT min(u2.ts) FROM user_text u2
            WHERE u2.session_id = ut.session_id AND u2.role = 'user' AND u2.ts > ut.ts) AS next_ts
        ${userRows}
      )
      SELECT session_id, ts, text,
        CASE WHEN text LIKE ? THEN (${reply} ORDER BY a.ts ASC LIMIT 1)
             ELSE (${reply} AND a.text LIKE ? ORDER BY a.ts ASC LIMIT 1)
        END AS assistant_response
      FROM t
      WHERE text LIKE ? OR EXISTS (${reply} AND a.text LIKE ?)
      ORDER BY ts DESC
      LIMIT ?`;
        return db.prepare(sql).all(...bindings, like, like, like, like, limit);
    }
    const sql = `
    SELECT ut.session_id, ut.ts, ut.text, ${firstReply} AS assistant_response
    ${userRows}
    ORDER BY ut.ts DESC
    LIMIT ?`;
    return db.prepare(sql).all(...bindings, limit);
}
/** Default cap on the TOTAL serialized bytes of a clens_recent response.
 *  Larger than clens_search's cap because recent returns FULL messages, not
 *  snippets — but still bounded, so a window that happens to contain a few
 *  huge pasted messages can no longer blow the caller's context. */
export const DEFAULT_RECENT_MAX_BYTES = 32768;
/** Absolute cap on a SINGLE row's serialized bytes. This is the one case the
 *  total-byte budget cannot contain: the most-recent row is always emitted
 *  even when it alone exceeds maxBytes, so without a per-row cap a lone giant
 *  message (a huge paste + long reply) would still blow the MCP ceiling. Set
 *  above DEFAULT_RECENT_MAX_BYTES — so ordinary large messages still pass
 *  through whole — and well under the ceiling that the un-capped 94KB response
 *  hit, so only a genuinely oversized row is ever truncated. */
export const MAX_ROW_BYTES = 65536;
/** Truncate `s` to at most `maxLen` UTF-8 bytes without splitting a multi-byte
 *  character — iterates code points so it never cuts mid-char or mid-surrogate. */
function truncateToBytes(s, maxLen) {
    if (maxLen <= 0)
        return "";
    if (Buffer.byteLength(s, "utf8") <= maxLen)
        return s;
    let out = "";
    let used = 0;
    for (const ch of s) {
        const c = Buffer.byteLength(ch, "utf8");
        if (used + c > maxLen)
            break;
        out += ch;
        used += c;
    }
    return out;
}
/** Serialize recent rows into the MCP text response under a total byte budget.
 *  Rows arrive ordered ts DESC (most-recent first), so the budget drops from
 *  the OLDEST end and reports the tail as "+N more". Emitted bodies are kept
 *  WHOLE — recent's contract is full messages, not snippets — with ONE
 *  exception: a single row larger than MAX_ROW_BYTES (which the budget can't
 *  drop, since the most-recent row is always emitted) has its body truncated
 *  and a clens_session pointer appended, so the response can never exceed the
 *  MCP ceiling even when one message is enormous. The header (ts + session_id)
 *  always survives, so a truncated row is still identifiable and one
 *  clens_session call away from its full text. Rows carry no project_id:
 *  the caller passes it as a required param. */
export function formatResults(results, maxBytes = DEFAULT_RECENT_MAX_BYTES) {
    if (results.length === 0)
        return "No results found.";
    const parts = [];
    let used = 0;
    for (const r of results) {
        const header = `[${parts.length + 1}] ${r.ts}  session:${r.session_id}`;
        let body = `\nUser: ${r.text}`;
        if (r.assistant_response)
            body += `\nAssistant: ${r.assistant_response}`;
        let entry = header + body;
        if (Buffer.byteLength(entry, "utf8") > MAX_ROW_BYTES) {
            // Only reached when a single message alone is enormous. Truncate its body
            // to fit MAX_ROW_BYTES (reserving room for the marker, sized against the
            // largest possible omitted count so the finished entry always fits) and
            // point at clens_session for the full text — valid here because this row
            // IS shown, so its session_id + ts are visible to the caller.
            const marker = (omitted) => `\n…[truncated ${omitted} chars — full text via clens_session(session_id, around_ts: <ts>, full: true)]`;
            const reserve = Buffer.byteLength(marker(body.length), "utf8");
            const keptBody = truncateToBytes(body, MAX_ROW_BYTES - Buffer.byteLength(header, "utf8") - reserve);
            const omitted = [...body].length - [...keptBody].length;
            entry = header + keptBody + marker(omitted);
        }
        const cost = Buffer.byteLength(entry, "utf8") + (parts.length > 0 ? 2 : 0); // +2 for the "\n\n" joiner
        if (parts.length > 0 && used + cost > maxBytes)
            break;
        parts.push(entry);
        used += cost;
    }
    let out = parts.join("\n\n");
    const hidden = results.length - parts.length;
    if (hidden > 0) {
        out += `\n\n(+${hidden} more not shown — capped at maxBytes; narrow the window with since/until, lower the limit, or raise maxBytes)`;
    }
    return out;
}
//# sourceMappingURL=recent.js.map