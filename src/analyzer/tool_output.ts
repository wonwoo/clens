/**
 * Tool output size: how many characters of text each tool's results added to
 * the conversation. Only calls whose result was measured (result_chars not
 * NULL) count; images inside results are not measured (see the parser).
 */

import type Database from "better-sqlite3";
import { sessionScopedWhere, type Scope } from "./scope.js";

export interface ToolOutputFacts {
  measured_calls: number;
  total_chars: number;
  /** Every measured tool, by total_chars descending, then by name. */
  by_tool: Array<{ name: string; calls: number; total_chars: number; avg_chars: number; max_chars: number }>;
}

interface ToolRow {
  name: string;
  calls: number;
  total_chars: number;
  max_chars: number;
}

export function analyzeToolOutput(db: Database.Database, scope: Scope): ToolOutputFacts {
  const { sql, binds } = sessionScopedWhere(scope, "session_id", "ts", "event_uuid");
  const rows = db
    .prepare(
      `SELECT name, COUNT(*) AS calls, SUM(result_chars) AS total_chars, MAX(result_chars) AS max_chars
       FROM tool_call
       WHERE ${sql} AND result_chars IS NOT NULL
       GROUP BY name
       ORDER BY total_chars DESC, name`,
    )
    .all(...binds) as ToolRow[];

  let measured_calls = 0;
  let total_chars = 0;
  const by_tool = rows.map((r) => {
    measured_calls += r.calls;
    total_chars += r.total_chars;
    return { ...r, avg_chars: Math.round(r.total_chars / r.calls) };
  });
  return { measured_calls, total_chars, by_tool };
}
