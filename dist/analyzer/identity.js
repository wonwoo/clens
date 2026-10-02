/**
 * Identity / scope-level basics for the canonical facts JSON.
 *
 * In session scope: session id, project_id, kind, model_primary, version,
 *   started/ended_at, primary cwd, git_branch.
 * In project scope: project id, session count, model_primary mode, date range.
 * In global scope: per-corpus totals (sessions, projects, files).
 */
import { realProjectClause, workKindClause } from "./scope.js";
export function analyzeIdentity(db, scope) {
    switch (scope.mode) {
        case "session": {
            const row = db
                .prepare(`SELECT id, project_id, kind, parent_id, model_primary, version,
                  started_at, ended_at, cwd, git_branch
           FROM session WHERE id = ?`)
                .get(scope.params.session_id);
            if (!row) {
                return {
                    kind: "session",
                    session: {
                        session_id: scope.params.session_id,
                        project_id: null,
                        kind: null,
                        parent_id: null,
                        model_primary: null,
                        version: null,
                        started_at: null,
                        ended_at: null,
                        cwd: null,
                        git_branch: null,
                    },
                };
            }
            return {
                kind: "session",
                session: {
                    session_id: row.id,
                    project_id: row.project_id,
                    kind: row.kind,
                    parent_id: row.parent_id,
                    model_primary: row.model_primary,
                    version: row.version,
                    started_at: row.started_at,
                    ended_at: row.ended_at,
                    cwd: row.cwd,
                    git_branch: row.git_branch,
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
                .prepare(`SELECT COUNT(DISTINCT s.id) AS sessions,
                  MIN(e.ts) AS started_at,
                  MAX(e.ts) AS ended_at
           FROM session s LEFT JOIN event e ON e.session_id = s.id
           WHERE s.project_id = ? AND ${workKindClause("s")} ${sinceCond}`)
                .get(scope.params.project_id, ...sinceBind);
            const modelRow = db
                .prepare(`SELECT e.model AS model, COUNT(*) AS c
           FROM event e JOIN session s ON e.session_id = s.id
           WHERE e.role = 'assistant' AND e.model IS NOT NULL AND s.project_id = ? AND ${workKindClause("s")} ${sinceCond}
           GROUP BY e.model ORDER BY c DESC LIMIT 1`)
                .get(scope.params.project_id, ...sinceBind);
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
            const tsBind = scope.mode === "since" ? [scope.params.since] : [];
            const tsCond = scope.mode === "since" ? "AND e.ts >= ?" : "";
            const row = db
                .prepare(`SELECT COUNT(DISTINCT e.session_id) AS sessions, MIN(e.ts) AS earliest_event, MAX(e.ts) AS latest_event
           FROM event e
           WHERE e.session_id IN (SELECT id FROM session WHERE ${workKindClause()}) ${tsCond}`)
                .get(...tsBind);
            const proj = db
                .prepare(`SELECT COUNT(*) c FROM project WHERE ${realProjectClause("id")}`)
                .get().c;
            const files = db.prepare(`SELECT COUNT(*) c FROM file_cursor`).get().c;
            return {
                kind: scope.mode === "global" ? "global" : "since",
                global: {
                    sessions: row.sessions,
                    projects: proj,
                    files,
                    earliest_event: row.earliest_event,
                    latest_event: row.latest_event,
                },
            };
        }
    }
}
//# sourceMappingURL=identity.js.map