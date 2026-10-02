/**
 * Tool output size: how many characters of text each tool's results added to
 * the conversation. Only calls whose result was measured (result_chars not
 * NULL) count; images inside results are not measured (see the parser).
 */
import { sessionScopedWhere } from "./scope.js";
export function analyzeToolOutput(db, scope) {
    const { sql, binds } = sessionScopedWhere(scope, "session_id", "ts", "event_uuid");
    const rows = db
        .prepare(`SELECT name, COUNT(*) AS calls, SUM(result_chars) AS total_chars, MAX(result_chars) AS max_chars
       FROM tool_call
       WHERE ${sql} AND result_chars IS NOT NULL
       GROUP BY name
       ORDER BY total_chars DESC, name`)
        .all(...binds);
    let measured_calls = 0;
    let total_chars = 0;
    const by_tool = rows.map((r) => {
        measured_calls += r.calls;
        total_chars += r.total_chars;
        return { ...r, avg_chars: Math.round(r.total_chars / r.calls) };
    });
    return { measured_calls, total_chars, by_tool };
}
//# sourceMappingURL=tool_output.js.map