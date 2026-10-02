/**
 * Dimension 6 — timeline. Classify inter-event gaps into model/tool latency
 * (<5s), think (5s ≤ gap < 5min), and idle (≥5min). ExecPlan §11 thresholds.
 */
import { eventWhere } from "./scope.js";
const THINK_LOWER_MS = 5_000;
const THINK_UPPER_MS = 5 * 60_000;
export function analyzeTimeline(db, scope) {
    const { sql, binds } = eventWhere(scope, "e");
    const rows = db
        .prepare(`SELECT ts, session_id FROM event e
       WHERE ${sql}
       ORDER BY session_id, ts`)
        .all(...binds);
    let wallMs = 0;
    let thinkMs = 0;
    let idleMs = 0;
    let prev = null;
    for (const r of rows) {
        if (prev === null || prev.session_id !== r.session_id) {
            prev = r;
            continue;
        }
        const dt = Date.parse(r.ts) - Date.parse(prev.ts);
        if (Number.isFinite(dt) && dt >= 0) {
            wallMs += dt;
            if (dt >= THINK_UPPER_MS)
                idleMs += dt;
            else if (dt >= THINK_LOWER_MS)
                thinkMs += dt;
            // else: counted in wall only (model/tool latency)
        }
        prev = r;
    }
    return {
        wall_min: round(wallMs / 60000, 2),
        think_min: round(thinkMs / 60000, 2),
        idle_min: round(idleMs / 60000, 2),
    };
}
function round(n, digits) {
    const m = Math.pow(10, digits);
    return Math.round(n * m) / m;
}
//# sourceMappingURL=timeline.js.map