/**
 * Dimension 6 — timeline. Classify inter-event gaps into model/tool latency
 * (<5s), think (5s ≤ gap < 5min), and idle (≥5min). ExecPlan §11 thresholds.
 * Active time is every gap under 5 minutes, think included: a session left
 * open for days spans days, so the span would not tell how long anyone worked.
 * A subagent's events go on the timeline of the session that started it, so
 * the time it works while that session waits on it counts once, as work.
 */

import type Database from "better-sqlite3";
import { eventWhere, rootSessionExpr, type Scope } from "./scope.js";

const THINK_LOWER_MS = 5_000;
const THINK_UPPER_MS = 5 * 60_000;

export interface TimelineFacts {
  active_min: number;
  think_min: number;
  idle_min: number;
}

interface EventRow {
  ts: string;
  root: string;
}

export function analyzeTimeline(db: Database.Database, scope: Scope): TimelineFacts {
  const { sql, binds } = eventWhere(scope, "e");
  const rows = db
    .prepare(
      `SELECT e.ts AS ts, ${rootSessionExpr("s")} AS root
       FROM event e JOIN session s ON s.id = e.session_id
       WHERE ${sql}
       ORDER BY root, e.ts`,
    )
    .all(...binds) as EventRow[];

  let activeMs = 0;
  let thinkMs = 0;
  let idleMs = 0;
  let prev: EventRow | null = null;

  for (const r of rows) {
    if (prev === null || prev.root !== r.root) {
      prev = r;
      continue;
    }
    const dt = Date.parse(r.ts) - Date.parse(prev.ts);
    if (Number.isFinite(dt) && dt >= 0) {
      if (dt >= THINK_UPPER_MS) idleMs += dt;
      else {
        activeMs += dt;
        if (dt >= THINK_LOWER_MS) thinkMs += dt;
        // else: active only (model/tool latency)
      }
    }
    prev = r;
  }

  return {
    active_min: round(activeMs / 60000, 2),
    think_min: round(thinkMs / 60000, 2),
    idle_min: round(idleMs / 60000, 2),
  };
}

function round(n: number, digits: number): number {
  const m = Math.pow(10, digits);
  return Math.round(n * m) / m;
}
