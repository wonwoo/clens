/**
 * Scope filter — defines the WHERE clause that constrains every analyzer
 * query (single session, single project, global, time-bound).
 *
 * The discriminated union keeps callers honest: each analyzer accepts a
 * `Scope` and reads it to compose its SQL.
 *
 * Project, global and since scopes leave out judge transcripts (`pipeline`)
 * and one-shot exec/SDK runs (`exec`), and the subagents those started:
 * those are programs, not the user's work. Session scope shows the one
 * session asked for, whatever its kind.
 */

/** Parenthesized SQL that keeps a session row unless it is a judge
 *  transcript or a one-shot exec/SDK run, or a subagent one of those
 *  started. A subagent's file is always stored as kind `subagent`, so its
 *  parent's kind is checked here, at query time: deriving it at index time
 *  would make one file's rows depend on another file (Gate 2). NULL kind is
 *  kept: `IS NOT`, not `NOT IN`, which is NULL for a NULL kind and would
 *  drop kind-less rows. */
export function workKindClause(alias?: string): string {
  const col = (c: string) => (alias ? `${alias}.${c}` : c);
  return (
    `(${col("kind")} IS NOT 'pipeline' AND ${col("kind")} IS NOT 'exec'` +
    ` AND (${col("parent_id")} IS NULL OR ${col("parent_id")} NOT IN` +
    ` (SELECT id FROM session WHERE kind IN ('pipeline', 'exec'))))`
  );
}

/** Parenthesized SQL that is false for a row copied from another session.
 *  A conversation resumed into a new session starts with the earlier
 *  session's lines, copied with their uuids under the new session id and
 *  marked nowhere as copies, so their rows are stored once per session. The
 *  event table holds one row per uuid (`INSERT OR REPLACE`, so the session
 *  indexed last), and the copy counted is the one in that row's session. A
 *  row whose event is missing is kept. Telling the copies apart at index
 *  time would make one file's rows depend on another file (Gate 2). */
export function notCopiedClause(eventUuidColumn: string, sessionIdColumn: string): string {
  return (
    `(IFNULL((SELECT owner.session_id FROM event owner WHERE owner.uuid = ${eventUuidColumn}),` +
    ` ${sessionIdColumn}) = ${sessionIdColumn})`
  );
}

/** Parenthesized SQL that is false for the event of an `Agent` call a fork
 *  subagent's transcript copied from the session that started it. The copy
 *  has a new uuid, so notCopiedClause misses it, but the same call id. Of
 *  the events that share a call id, the one with the smallest uuid counts:
 *  the copy and the original say the same, and which one counts must not
 *  depend on which session resumed which (notCopiedClause picks among rows
 *  that share a uuid). Only `Agent` calls: no other tool's call is copied
 *  this way, and comparing every call id took 0.6 s against 22 ms on a
 *  real index of 89,572 calls. */
export function notForkCopyClause(eventUuidColumn: string): string {
  return (
    `(${eventUuidColumn} NOT IN (SELECT copy.event_uuid FROM tool_call copy` +
    ` JOIN tool_call kept ON kept.call_id = copy.call_id AND kept.event_uuid < copy.event_uuid` +
    ` WHERE copy.name = 'Agent'))`
  );
}

const WORK_SESSIONS = `SELECT id FROM session WHERE ${workKindClause()}`;

export type Scope =
  | { mode: "global"; params: Record<string, never> }
  | { mode: "session"; params: { session_id: string } }
  | { mode: "project"; params: { project_id: string; since?: string } }
  | { mode: "since"; params: { since: string } };

/** Returns a SQL fragment (without the WHERE keyword) and bind values. */
export function eventWhere(scope: Scope, eventAlias = "e"): { sql: string; binds: unknown[] } {
  switch (scope.mode) {
    case "global":
      return { sql: `${eventAlias}.session_id IN (${WORK_SESSIONS})`, binds: [] };
    case "session":
      return { sql: `${eventAlias}.session_id = ?`, binds: [scope.params.session_id] };
    case "project": {
      const parts = [
        `${eventAlias}.session_id IN (SELECT id FROM session WHERE project_id = ? AND ${workKindClause()})`,
      ];
      const binds: unknown[] = [scope.params.project_id];
      if (scope.params.since) {
        parts.push(`${eventAlias}.ts >= ?`);
        binds.push(scope.params.since);
      }
      return { sql: parts.join(" AND "), binds };
    }
    case "since":
      return {
        sql: `${eventAlias}.ts >= ? AND ${eventAlias}.session_id IN (${WORK_SESSIONS})`,
        binds: [scope.params.since],
      };
  }
}

/** Same as eventWhere but for tool_call / file_op / etc with their own alias.
 *  Scopes over more than one session count a row copied into a resumed
 *  session or a fork subagent once (notCopiedClause, notForkCopyClause);
 *  session scope keeps the session whole. */
export function sessionScopedWhere(
  scope: Scope,
  sessionIdColumn: string,
  tsColumn: string,
  eventUuidColumn: string,
): { sql: string; binds: unknown[] } {
  const notCopied =
    `${notCopiedClause(eventUuidColumn, sessionIdColumn)} AND ${notForkCopyClause(eventUuidColumn)}`;
  switch (scope.mode) {
    case "global":
      return { sql: `${sessionIdColumn} IN (${WORK_SESSIONS}) AND ${notCopied}`, binds: [] };
    case "session":
      return { sql: `${sessionIdColumn} = ?`, binds: [scope.params.session_id] };
    case "project": {
      const parts = [
        `${sessionIdColumn} IN (SELECT id FROM session WHERE project_id = ? AND ${workKindClause()})`,
        notCopied,
      ];
      const binds: unknown[] = [scope.params.project_id];
      if (scope.params.since) {
        parts.push(`${tsColumn} >= ?`);
        binds.push(scope.params.since);
      }
      return { sql: parts.join(" AND "), binds };
    }
    case "since":
      return {
        sql: `${tsColumn} >= ? AND ${sessionIdColumn} IN (${WORK_SESSIONS}) AND ${notCopied}`,
        binds: [scope.params.since],
      };
  }
}
