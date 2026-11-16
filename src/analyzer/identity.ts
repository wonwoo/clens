/**
 * Identity / scope-level basics for clens_stats.
 *
 * In session scope: session id, project_id, model_primary, started/ended_at.
 * In project scope: project id, session count, model_primary mode, date range.
 * In global scope: session count and date range.
 * A subagent counts as part of the session that started it, not as a session.
 * Without `since`, the date range is the sessions' own span, which covers
 * every line the indexer parsed, a bare attachment line included, though
 * that line has no event row; with `since` it comes from the event rows.
 */

import type Database from "better-sqlite3";
import { copiedEventRowids, notCopiedEventClause, rootSessionExpr, workKindClause, type Scope } from "./scope.js";

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

/** `copied`: the rows copiedEventRowids returns, when the caller has them;
 *  read only in project scope, for the primary model. */
export function analyzeIdentity(db: Database.Database, scope: Scope, copied?: readonly number[]): IdentityFacts {
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
          scope.params.since
            ? `SELECT COUNT(DISTINCT ${rootSessionExpr("s")}) AS sessions,
                      MIN(e.ts) AS started_at,
                      MAX(e.ts) AS ended_at
               FROM session s LEFT JOIN event e ON e.session_id = s.id
               WHERE s.project_id = ? AND ${workKindClause("s")} ${sinceCond}`
            : `SELECT COUNT(DISTINCT ${rootSessionExpr("s")}) AS sessions,
                      MIN(s.started_at) AS started_at,
                      MAX(s.ended_at) AS ended_at
               FROM session s
               WHERE s.project_id = ? AND ${workKindClause("s")}`,
        )
        .get(scope.params.project_id, ...sinceBind) as { sessions: number; started_at: string | null; ended_at: string | null };
      const modelRow = db
        .prepare(
          `SELECT e.model AS model, COUNT(*) AS c
           FROM event e JOIN session s ON e.session_id = s.id
           WHERE e.role = 'assistant' AND e.model IS NOT NULL AND s.project_id = ? AND ${workKindClause("s")}
             AND ${notCopiedEventClause("e", copied ?? copiedEventRowids(db, scope))} ${sinceCond}
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
      const row = db
        .prepare(
          scope.mode === "since"
            ? `SELECT COUNT(DISTINCT ${rootSessionExpr("s")}) AS sessions, MIN(e.ts) AS earliest_event, MAX(e.ts) AS latest_event
               FROM event e JOIN session s ON s.id = e.session_id
               WHERE ${workKindClause("s")} AND e.ts >= ?`
            : `SELECT COUNT(DISTINCT ${rootSessionExpr("s")}) AS sessions, MIN(s.started_at) AS earliest_event, MAX(s.ended_at) AS latest_event
               FROM session s
               WHERE ${workKindClause("s")}`,
        )
        .get(...(scope.mode === "since" ? [scope.params.since] : [])) as {
        sessions: number;
        earliest_event: string | null;
        latest_event: string | null;
      };
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
