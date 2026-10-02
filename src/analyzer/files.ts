/**
 * Dimension 7 — file targets. Top paths per tool: Read/Edit/Write and the
 * files a shell command wrote.
 */

import type Database from "better-sqlite3";
import { sessionScopedWhere, type Scope } from "./scope.js";
import { TEMP_ROOTS } from "../util/temp_dirs.js";

export interface FileFacts {
  top: Array<{ path: string; tool: string; count: number }>;
}

interface FileOpRow {
  path: string;
  tool: string;
  count: number;
}

export function analyzeFiles(db: Database.Database, scope: Scope): FileFacts {
  const { sql, binds } = sessionScopedWhere(scope, "session_id", "ts", "event_uuid");
  // Files a shell command wrote (Claude Code's Bash, Codex's exec_command)
  // count, except under a temporary folder outside the session's own: a
  // scratch log written on every run would fill the list.
  const rows = db
    .prepare(
      `SELECT path, tool, COUNT(*) AS count
       FROM file_op
       WHERE ${sql}
         AND NOT (tool IN ('Bash', 'exec_command')
           AND (${TEMP_ROOTS.map(() => "path LIKE ?").join(" OR ")})
           AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = file_op.session_id AND s.cwd IS NOT NULL
             AND substr(file_op.path, 1, length(s.cwd) + 1) = s.cwd || '/'))
       GROUP BY path, tool
       ORDER BY count DESC, path, tool
       LIMIT 50`,
    )
    .all(...binds, ...TEMP_ROOTS.map((root) => `${root}%`)) as FileOpRow[];

  return { top: rows };
}
