/**
 * Hook blocks: how often each hook refused each tool (a Stop hook refuses the
 * end of a turn, so its tool is NULL), and the latest refusals with reasons.
 */
import { sessionScopedWhere } from "./scope.js";
const RECENT_LIMIT = 5;
const REASON_LINE_CHARS = 150;
/** The reason's first line, cut to REASON_LINE_CHARS code points. */
function reasonLine(reason) {
    if (reason === null)
        return null;
    const chars = [...reason.split("\n")[0]];
    return chars.length > REASON_LINE_CHARS ? chars.slice(0, REASON_LINE_CHARS).join("") + "…" : chars.join("");
}
export function analyzeHookBlocks(db, scope) {
    const { sql, binds } = sessionScopedWhere(scope, "session_id", "ts", "event_uuid");
    const by_hook = db
        .prepare(`SELECT hook_event, tool, COUNT(*) AS count
       FROM hook_block
       WHERE ${sql}
       GROUP BY hook_event, tool
       ORDER BY count DESC, hook_event, tool`)
        .all(...binds);
    const recent = db
        .prepare(`SELECT session_id, ts, hook_event, tool, reason
       FROM hook_block
       WHERE ${sql}
       ORDER BY ts DESC, event_uuid
       LIMIT ${RECENT_LIMIT}`)
        .all(...binds)
        .map(({ reason, ...r }) => ({ ...r, reason_line: reasonLine(reason) }));
    return { total: by_hook.reduce((n, r) => n + r.count, 0), by_hook, recent };
}
//# sourceMappingURL=hook_blocks.js.map