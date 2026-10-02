/**
 * Dimension 9 — health.
 *
 * - tool_errors: tool_call.is_error = 1 count.
 * - compaction_events: system_reminder rows with category='compaction', one
 *   per compaction (a Claude Code compact_boundary line or a Codex
 *   `compacted` item; see the parsers), plus the summary messages of a
 *   session that has no such row.
 * - context_bloat_ratio: max(event.in_tok + cache_r + cache_w) /
 *   median(in_tok + cache_r + cache_w) for assistant events in the scope.
 *   Heuristic surfacing of "context grew unmanageable".
 */
import { eventWhere, sessionScopedWhere } from "./scope.js";
export function analyzeHealth(db, scope) {
    const toolScope = sessionScopedWhere(scope, "tc.session_id", "tc.ts", "tc.event_uuid");
    const eventScope = eventWhere(scope, "e");
    const toolErrors = db
        .prepare(`SELECT COUNT(*) AS c FROM tool_call tc WHERE is_error = 1 AND ${toolScope.sql}`)
        .get(...toolScope.binds).c;
    // One system_reminder row per compaction, written by the parsers.
    const srScope = sessionScopedWhere(scope, "sr.session_id", "sr.ts", "sr.event_uuid");
    const compactions = db
        .prepare(`SELECT COUNT(*) AS c FROM system_reminder sr
         WHERE category = 'compaction' AND ${srScope.sql}`)
        .get(...srScope.binds).c;
    // A Claude Code session indexed before the parser wrote compaction rows,
    // whose transcript is gone since, cannot be read again: its compactions
    // are left only as the summary each one starts the conversation again
    // with. Those count where the session has no compaction row; in a session
    // with both, they match one for one.
    const utScope = sessionScopedWhere(scope, "ut.session_id", "ut.ts", "ut.event_uuid");
    const summaryOnly = db
        .prepare(`SELECT COUNT(*) AS c FROM user_text ut
         WHERE ut.type = 'continuation_summary' AND ${utScope.sql}
           AND NOT EXISTS (SELECT 1 FROM system_reminder cr
                           WHERE cr.session_id = ut.session_id AND cr.category = 'compaction')`)
        .get(...utScope.binds).c;
    // Context bloat: assistant events' in_tok+cache_r+cache_w distribution.
    // session_id/ts ride along so a caller can find which turn the max was,
    // not just the ratio.
    const ctxRows = db
        .prepare(`SELECT session_id, ts, (in_tok + cache_r + cache_w) AS ctx
       FROM event e
       WHERE role = 'assistant' AND ${eventScope.sql}
       ORDER BY ctx`)
        .all(...eventScope.binds);
    let bloat = null;
    let bloatDetail = null;
    if (ctxRows.length >= 4) {
        const maxRow = ctxRows[ctxRows.length - 1];
        const medianCtx = ctxRows[Math.floor(ctxRows.length / 2)].ctx;
        if (medianCtx > 0) {
            bloat = Number((maxRow.ctx / medianCtx).toFixed(2));
            bloatDetail = {
                max_ctx: maxRow.ctx,
                median_ctx: medianCtx,
                sample_size: ctxRows.length,
                max_session_id: maxRow.session_id,
                max_ts: maxRow.ts,
            };
        }
    }
    return {
        tool_errors: toolErrors,
        compaction_events: compactions + summaryOnly,
        context_bloat_ratio: bloat,
        context_bloat_detail: bloatDetail,
    };
}
//# sourceMappingURL=health.js.map