/**
 * Identity / scope-level basics for clens_stats.
 *
 * In session scope: session id, project_id, model_primary, started/ended_at.
 * In project scope: project id, session count, model_primary mode, date range.
 * In global scope: session count and date range.
 */

import type Database from "better-sqlite3";
import { workKindClause, type Scope } from "./scope.js";

export interface IdentitySession {
  session_id: string;
  project_id: string | null;
  model_primary: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface IdentityProject {
  project_id: string;
  sessions: number;
  primary_model: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface IdentityGlobal {
  sessions: number;
  earliest_event: string | null;
  latest_event: string | null;
}

export type IdentityFacts =
  | { kind: "session"; session: IdentitySession }
  | { kind: "project"; project: IdentityProject }
  | { kind: "global"; global: IdentityGlobal }
  | { kind: "since"; global: IdentityGlobal };

export function analyzeIdentity(db: Database.Database, scope: Scope): IdentityFacts {
  switch (scope.mode) {
    case "session": {
      const row = db
        .prepare(
          `SELECT id, project_id, model_primary, started_at, ended_at
           FROM session WHERE id = ?`,
        )
        .get(scope.params.session_id) as
        | {
            id: string;
            project_id: string | null;
            model_primary: string | null;
            started_at: string | null;
            ended_at: string | null;
          }
        | undefined;
      if (!row) {
        return {
          kind: "session",
          session: {
            session_id: scope.params.session_id,
            project_id: null,
            model_primary: null,
            started_at: null,
            ended_at: null,
          },
        };
      }
      return {
        kind: "session",
        session: {
          session_id: row.id,
          project_id: row.project_id,
          model_primary: row.model_primary,
          started_at: row.started_at,
          ended_at: row.ended_at,
        },
      };
    }

    case "project": {
      // Unlike every other analyzer dimension, this query can't route through
      // sessionScopedWhere/eventWhere (scope.ts) — it aggregates across the
      // session/event join itself (COUNT DISTINCT + MIN/MAX), not a plain
      // per-row filter — so `since` is applied by hand here, same semantics
      // as those helpers: only add the condition when since is set.
      const sinceCond = scope.params.since ? "AND e.ts >= ?" : "";
      const sinceBind = scope.params.since ? [scope.params.since] : [];
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT s.id) AS sessions,
                  MIN(e.ts) AS started_at,
                  MAX(e.ts) AS ended_at
           FROM session s LEFT JOIN event e ON e.session_id = s.id
           WHERE s.project_id = ? AND ${workKindClause("s")} ${sinceCond}`,
        )
        .get(scope.params.project_id, ...sinceBind) as { sessions: number; started_at: string | null; ended_at: string | null };
      const modelRow = db
        .prepare(
          `SELECT e.model AS model, COUNT(*) AS c
           FROM event e JOIN session s ON e.session_id = s.id
           WHERE e.role = 'assistant' AND e.model IS NOT NULL AND s.project_id = ? AND ${workKindClause("s")} ${sinceCond}
           GROUP BY e.model ORDER BY c DESC LIMIT 1`,
        )
        .get(scope.params.project_id, ...sinceBind) as { model: string; c: number } | undefined;
      return {
        kind: "project",
        project: {
          project_id: scope.params.project_id,
          sessions: row.sessions,
          primary_model: modelRow?.model ?? null,
          started_at: row.started_at,
          ended_at: row.ended_at,
        },
      };
    }

    case "global":
    case "since": {
      const tsBind: unknown[] = scope.mode === "since" ? [scope.params.since] : [];
      const tsCond = scope.mode === "since" ? "AND e.ts >= ?" : "";
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT e.session_id) AS sessions, MIN(e.ts) AS earliest_event, MAX(e.ts) AS latest_event
           FROM event e
           WHERE e.session_id IN (SELECT id FROM session WHERE ${workKindClause()}) ${tsCond}`,
        )
        .get(...tsBind) as { sessions: number; earliest_event: string | null; latest_event: string | null };
      return {
        kind: scope.mode === "global" ? "global" : "since",
        global: {
          sessions: row.sessions,
          earliest_event: row.earliest_event,
          latest_event: row.latest_event,
        },
      };
    }
  }
}
