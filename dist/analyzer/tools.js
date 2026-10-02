/**
 * Dimension 4 — tool usage. Call counts per tool name, and errors.
 */
import { sessionScopedWhere } from "./scope.js";
export function analyzeTools(db, scope) {
    const { sql, binds } = sessionScopedWhere(scope, "session_id", "ts", "event_uuid");
    // A fixed ORDER BY: GROUP BY alone gives no defined order, and callers
    // cut this list.
    const rows = db
        .prepare(`SELECT name, COUNT(*) AS n, SUM(is_error) AS errors
       FROM tool_call
       WHERE ${sql}
       GROUP BY name
       ORDER BY n DESC, name`)
        .all(...binds);
    const counts = {};
    const errorsByName = {};
    let errors = 0;
    for (const r of rows) {
        counts[r.name] = r.n;
        errors += r.errors ?? 0;
        if ((r.errors ?? 0) > 0)
            errorsByName[r.name] = r.errors;
    }
    return { counts, errors, errors_by_name: errorsByName };
}
//# sourceMappingURL=tools.js.map