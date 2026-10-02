/**
 * Hook blocks: how often each hook refused each tool (a Stop hook refuses the
 * end of a turn, so its tool is NULL), and the latest refusals with reasons.
 */

import type Database from "better-sqlite3";
import { sessionScopedWhere, type Scope } from "./scope.js";

const RECENT_LIMIT = 5;
const REASON_LINE_CHARS = 150;

export interface HookBlocksFacts {
  total: number;
  /** By count descending, then hook_event, then tool. */
  by_hook: Array<{ hook_event: string; tool: string | null; count: number }>;
  /** The newest blocks, newest first. */
  recent: Array<{ session_id: string; ts: string; hook_event: string; tool: string | null; reason_line: string | null }>;
}

/** The reason's first line, cut to REASON_LINE_CHARS code points. */
function reasonLine(reason: string | null): string | null {
  if (reason === null) return null;
  const chars = [...reason.split("\n")[0]!];
  return chars.length > REASON_LINE_CHARS ? chars.slice(0, REASON_LINE_CHARS).join("") + "…" : chars.join("");
}

export function analyzeHookBlocks(db: Database.Database, scope: Scope): HookBlocksFacts {
  const { sql, binds } = sessionScopedWhere(scope, "session_id", "ts", "event_uuid");
  const by_hook = db
    .prepare(
      `SELECT hook_event, tool, COUNT(*) AS count
       FROM hook_block
       WHERE ${sql}
       GROUP BY hook_event, tool
       ORDER BY count DESC, hook_event, tool`,
    )
    .all(...binds) as HookBlocksFacts["by_hook"];
  const recent = (db
    .prepare(
      `SELECT session_id, ts, hook_event, tool, reason
       FROM hook_block
       WHERE ${sql}
       ORDER BY ts DESC, event_uuid
       LIMIT ${RECENT_LIMIT}`,
    )
    .all(...binds) as Array<{ session_id: string; ts: string; hook_event: string; tool: string | null; reason: string | null }>)
    .map(({ reason, ...r }) => ({ ...r, reason_line: reasonLine(reason) }));
  return { total: by_hook.reduce((n, r) => n + r.count, 0), by_hook, recent };
}
