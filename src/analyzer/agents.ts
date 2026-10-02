/**
 * Dimension 8 — subagents started.
 *
 * Source of truth: `agent_call` rows (parser emits one per `Agent` tool_use
 * block), counted per `subagent_type`.
 *
 * `default_rate` = (agent_call rows with subagent_type='<default>') / (all
 * agent_call rows). High default rate suggests the user underspecifies agent
 * types — a coaching opportunity surfaced in §0.
 */

import type Database from "better-sqlite3";
import { sessionScopedWhere, type Scope } from "./scope.js";

export interface AgentByType {
  type: string;
  count: number;
}

export interface AgentsFacts {
  agent_calls_total: number;
  by_type: AgentByType[];
  default_rate: number;
}

interface ByTypeRow {
  subagent_type: string;
  count: number;
}

export function analyzeAgents(db: Database.Database, scope: Scope): AgentsFacts {
  const agentScope = sessionScopedWhere(scope, "session_id", "ts", "event_uuid");

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM agent_call WHERE ${agentScope.sql}`)
      .get(...agentScope.binds) as { c: number }
  ).c;

  const byTypeRows = db
    .prepare(
      `SELECT subagent_type, COUNT(*) AS count
       FROM agent_call
       WHERE ${agentScope.sql}
       GROUP BY subagent_type
       ORDER BY count DESC`,
    )
    .all(...agentScope.binds) as ByTypeRow[];

  const byType: AgentByType[] = byTypeRows.map((r) => ({ type: r.subagent_type, count: r.count }));

  const defaultCount = byTypeRows.find((r) => r.subagent_type === "<default>")?.count ?? 0;
  const defaultRate = total > 0 ? defaultCount / total : 0;

  return {
    agent_calls_total: total,
    by_type: byType,
    default_rate: Number(defaultRate.toFixed(4)),
  };
}
