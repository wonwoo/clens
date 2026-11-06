/**
 * codex_parser.ts extracts every "$word" in a Codex user_message as an
 * unvalidated skill candidate (it can't tell "$code-review" from "$100" or a
 * pasted Java inner-class name — see its SKILL_MARKER_RE comment). Confirm a
 * candidate against real installed skill directories — global
 * (codexHome()/skills/<name>) or this session's own project-local
 * (<cwd>/.codex/skills/<name>) — before trusting it. This lives outside the
 * parser so codex_parser.ts stays a pure function, and outside analyzer/
 * because that layer is pure-SQL-only.
 *
 * The decision depends on the file system when the rollout is indexed, so
 * each one is recorded: the append path (codex_append.ts) checks them again
 * before it keeps the rows they produced.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { codexHome } from "../util/paths.js";
import type { ParsedEvent } from "./types.js";

/** "$name" candidate → kept (true) or dropped (false). */
export type SkillDecisions = Map<string, boolean>;

function isKnownCodexSkill(name: string, cwd: string | null): boolean {
  if (existsSync(join(codexHome(), "skills", name))) return true;
  if (cwd !== null && existsSync(join(cwd, ".codex", "skills", name))) return true;
  return false;
}

/** Drop every candidate that names no installed skill, deciding each name
 *  not yet in `decisions` and recording it there; returns `decisions`.
 *  Deciding once per name instead of once per occurrence gives the same
 *  rows, since the folders are read within one run either way. */
export function filterCodexSkillCandidates(
  events: ParsedEvent[],
  cwd: string | null,
  decisions: SkillDecisions = new Map(),
): SkillDecisions {
  for (const p of events) {
    if (p.skill_calls.length === 0) continue;
    for (const sc of p.skill_calls) {
      if (!decisions.has(sc.skill)) decisions.set(sc.skill, isKnownCodexSkill(sc.skill, cwd));
    }
    p.skill_calls = p.skill_calls.filter((sc) => decisions.get(sc.skill) === true);
  }
  return decisions;
}

/** Whether every recorded decision still comes out the same, so that a full
 *  index now would keep and drop the same candidates. */
export function skillDecisionsHold(decisions: SkillDecisions, cwd: string | null): boolean {
  for (const [name, kept] of decisions) {
    if (isKnownCodexSkill(name, cwd) !== kept) return false;
  }
  return true;
}
