/**
 * Dimension 10 — Skill / slash-command usage.
 *
 * ExecPlan §11 D10 is explicit: the two sources MUST be reported side by
 * side, NEVER summed. `Skill` tool_use rows (always Skills) live in
 * skill_call; `<command-name>` markers (any slash, including non-Skill
 * commands like /clear, /help) live in slash_command. The output mirrors
 * the spec shape `facts.skills.{by_name, slash_commands}`.
 *
 * The same never-sum principle applies WITHIN skill_call itself now that
 * more than one session.source writes to it: Claude's rows come from a
 * structured `tool_use name="Skill"` event (can't be a false positive —
 * the harness only emits it on a real invocation), while Codex's rows come
 * from regex-scanning `$skill-name` chat text validated against installed
 * skill directories (a strictly weaker evidentiary basis). `by_name` is
 * grouped by (skill, source) so these are never silently blended into one
 * count.
 */

import type Database from "better-sqlite3";
import { sessionScopedWhere, type Scope } from "./scope.js";

export interface SkillByName {
  name: string;
  /** session.source this count came from (e.g. "claude", "codex") — never
   *  sum across sources, they carry different evidentiary confidence (see
   *  file header). One row per (name, source) pair. */
  source: string;
  count: number;
}

export interface SlashCommand {
  name: string;
  count: number;
}

export interface SkillsFacts {
  by_name: SkillByName[];
  slash_commands: SlashCommand[];
}

interface SkillRow {
  skill: string;
  source: string;
  count: number;
}

export function analyzeSkills(db: Database.Database, scope: Scope): SkillsFacts {
  // `sc.` prefix: by_name joins in `session` for source-splitting, so its
  // columns are named by table.
  const skScopeAliased = sessionScopedWhere(scope, "sc.session_id", "sc.ts", "sc.event_uuid");
  const slScope = sessionScopedWhere(scope, "session_id", "ts", "event_uuid");

  const byNameRows = db
    .prepare(
      `SELECT sc.skill AS skill, s.source AS source, COUNT(*) AS count
       FROM skill_call sc
       JOIN session s ON s.id = sc.session_id
       WHERE ${skScopeAliased.sql}
       GROUP BY sc.skill, s.source
       ORDER BY count DESC, sc.skill, s.source`,
    )
    .all(...skScopeAliased.binds) as SkillRow[];

  const byName: SkillByName[] = byNameRows.map((r) => ({ name: r.skill, source: r.source, count: r.count }));

  const slashRows = db
    .prepare(
      `SELECT name, COUNT(*) AS count
       FROM slash_command
       WHERE ${slScope.sql}
       GROUP BY name
       ORDER BY count DESC, name`,
    )
    .all(...slScope.binds) as Array<{ name: string; count: number }>;

  return {
    by_name: byName,
    slash_commands: slashRows,
  };
}
