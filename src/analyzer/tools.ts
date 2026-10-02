/**
 * Dimension 4 — tool usage. Call counts per tool name, and errors.
 */

import type Database from "better-sqlite3";
import { sessionScopedWhere, type Scope } from "./scope.js";

export interface ToolsFacts {
  /** Keys run by count descending, then by name. */
  counts: Record<string, number>;
  errors: number;
  /** Failed calls per tool, only the tools with one or more. */
  errors_by_name: Record<string, number>;
}

interface CountRow {
  name: string;
  n: number;
  errors: number | null;
}

export function analyzeTools(db: Database.Database, scope: Scope): ToolsFacts {
  const { sql, binds } = sessionScopedWhere(scope, "session_id", "ts", "event_uuid");
  // A fixed ORDER BY: GROUP BY alone gives no defined order, and callers
  // cut this list.
  const rows = db
    .prepare(
      `SELECT name, COUNT(*) AS n, SUM(is_error) AS errors
       FROM tool_call
       WHERE ${sql}
       GROUP BY name
       ORDER BY n DESC, name`,
    )
    .all(...binds) as CountRow[];

  const counts: Record<string, number> = {};
  const errorsByName: Record<string, number> = {};
  let errors = 0;
  for (const r of rows) {
    counts[r.name] = r.n;
    errors += r.errors ?? 0;
    if ((r.errors ?? 0) > 0) errorsByName[r.name] = r.errors!;
  }
  return { counts, errors, errors_by_name: errorsByName };
}
