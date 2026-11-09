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
import type Database from "better-sqlite3";

/** Table → ORDER BY clause that produces a deterministic row order. */
const TABLE_ORDER: ReadonlyMap<string, string> = new Map([
  ["schema_version", "v"],
  ["file_cursor", "path"],
  ["project", "id"],
  ["session", "id"],
  // A line copied into a resumed session has rows under the same uuid in
  // each session that holds it, so session_id follows the uuid; without it
  // those rows tie and hash in whatever order they were written.
  ["event", "uuid, session_id"],
  ["event_unknown_block", "event_uuid, session_id, block_index"],
  ["tool_call", "event_uuid, session_id, call_id, name"],
  ["file_op", "event_uuid, session_id, tool, path"],
  ["user_text", "event_uuid, session_id, ts, text"],
  ["skill_call", "event_uuid, session_id, ts, skill"],
  ["agent_call", "event_uuid, session_id, ts, subagent_type"],
  ["slash_command", "event_uuid, session_id, ts, name"],
  ["system_reminder", "event_uuid, session_id, ts, category"],
  ["hook_block", "event_uuid, session_id, ts, hook_event, COALESCE(call_id, '')"],
  ["anomaly", "kind, COALESCE(session_id, ''), ts, count, COALESCE(detail, '')"],
]);

/** Stable JSON: keys sorted alphabetically. */
function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return JSON.stringify(out);
}

export interface TableDigest {
  table: string;
  row_count: number;
  sha256: string;
}

export function digestAllTables(db: Database.Database): TableDigest[] {
  const out: TableDigest[] = [];
  for (const [table, order] of TABLE_ORDER) {
    const hasher = createHash("sha256");
    let count = 0;
    // exclude live flag from file_cursor — it depends on wall-clock at index
    // time and would break gate 2 between back-to-back runs.
    const cols =
      table === "file_cursor"
        ? "path, mtime, size, lines, last_ok"
        : "*";
    const rows = db.prepare(`SELECT ${cols} FROM ${table} ORDER BY ${order}`).all() as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      count += 1;
      hasher.update(stableStringify(row));
      hasher.update("\n");
    }
    out.push({ table, row_count: count, sha256: hasher.digest("hex") });
  }
  return out;
}
