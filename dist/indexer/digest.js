/**
 * Per-table SHA-256 digest. Used by `clens stats --digest` and gate 2
 * (incremental == rebuild) to assert two DB states are content-identical
 * regardless of insert order.
 *
 * For each table:
 *   - Read all rows sorted by primary key (or a stable composite).
 *   - Stringify with stable key ordering.
 *   - Hash the line-stream (one line per row) into one SHA-256.
 *
 * Gate-2 invariant: full rebuild and "rebuild → modify one file → incremental"
 * must yield identical digests across every non-volatile table. The `anomaly`
 * table is hashed too — its lifecycle is per-file batch, so as long as the
 * same files are processed with the same content, the row shape matches.
 */
import { createHash } from "node:crypto";
/** Table → ORDER BY clause that produces a deterministic row order. */
const TABLE_ORDER = new Map([
    ["schema_version", "v"],
    ["file_cursor", "path"],
    ["project", "id"],
    ["session", "id"],
    ["event", "uuid"],
    ["event_unknown_block", "event_uuid, block_index"],
    ["tool_call", "event_uuid, call_id, name"],
    ["file_op", "event_uuid, tool, path"],
    ["user_text", "event_uuid, ts, text"],
    ["skill_call", "event_uuid, ts, skill"],
    ["agent_call", "event_uuid, ts, subagent_type"],
    ["slash_command", "event_uuid, ts, name"],
    ["system_reminder", "event_uuid, ts, category"],
    ["hook_block", "event_uuid, ts, hook_event, COALESCE(call_id, '')"],
    ["anomaly", "kind, COALESCE(session_id, ''), ts, count, COALESCE(detail, '')"],
]);
/** Stable JSON: keys sorted alphabetically. */
function stableStringify(obj) {
    const keys = Object.keys(obj).sort();
    const out = {};
    for (const k of keys)
        out[k] = obj[k];
    return JSON.stringify(out);
}
export function digestAllTables(db) {
    const out = [];
    for (const [table, order] of TABLE_ORDER) {
        const hasher = createHash("sha256");
        let count = 0;
        // exclude live flag from file_cursor — it depends on wall-clock at index
        // time and would break gate 2 between back-to-back runs.
        const cols = table === "file_cursor"
            ? "path, mtime, size, lines, last_ok"
            : "*";
        const rows = db.prepare(`SELECT ${cols} FROM ${table} ORDER BY ${order}`).all();
        for (const row of rows) {
            count += 1;
            hasher.update(stableStringify(row));
            hasher.update("\n");
        }
        out.push({ table, row_count: count, sha256: hasher.digest("hex") });
    }
    return out;
}
//# sourceMappingURL=digest.js.map