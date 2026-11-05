/**
 * clens_stats — aggregate usage stats for one session, one project or every
 * project: tool/skill/agent counts, health signals, timeline, files
 * touched, hook blocks and tool output size. Optionally bounded by `since`. This is a quantitative-summary
 * tool, distinct from clens_search/clens_recent which return individual
 * messages.
 *
 * Calls the analyzer dimensions it surfaces directly; this runs on a
 * synchronous MCP request path, so it computes nothing it does not return:
 * a section that was not asked for is not computed.
 */

import type Database from "better-sqlite3";

import type { Scope } from "../analyzer/scope.js";
import { analyzeIdentity } from "../analyzer/identity.js";
import { analyzeTools } from "../analyzer/tools.js";
import { analyzeSkills } from "../analyzer/skills.js";
import { analyzeAgents } from "../analyzer/agents.js";
import { analyzeHealth } from "../analyzer/health.js";
import { analyzeTimeline } from "../analyzer/timeline.js";
import { analyzeFiles } from "../analyzer/files.js";
import { analyzeHookBlocks, type HookBlocksFacts } from "../analyzer/hook_blocks.js";
import { analyzeToolOutput, type ToolOutputFacts } from "../analyzer/tool_output.js";
import { localTs } from "../util/time.js";

export const STATS_SECTIONS = ["tools", "skills", "agents", "health", "timeline", "files", "hook_blocks", "tool_output"] as const;
export type StatsSection = "tools" | "skills" | "agents" | "health" | "timeline" | "files" | "hook_blocks" | "tool_output";
export const STATS_FILES_TOP = 20;
export const STATS_TOOLS_TOP = 30;
export const STATS_SKILLS_TOP = 20;
export const STATS_TOOL_OUTPUT_TOP = 15;
const NOT_INDEXED = "not indexed yet (the index predates this clens version; run clens index)";
/** analyzeFiles' own LIMIT (src/analyzer/files.ts). */
const FILES_ANALYZER_LIMIT = 50;

export interface StatsParams {
  project_id?: string;
  /** Already resolved: never "current". */
  session_id?: string;
  since?: string;
  sections?: StatsSection[];
  /** Keeps only the skills, slash commands and agent types whose name holds
   *  this text, in any case: "ecc:" for one plugin's. */
  name?: string;
}

export interface StatsFacts {
  scope: "session" | "project" | "all";
  project_id: string | null;
  session_id: string | null;
  sections: StatsSection[];
  name_filter: string | null;
  sessions: number;
  primary_model: string | null;
  started_at: string | null;
  ended_at: string | null;
  tool_counts?: Record<string, number>;
  tool_errors?: number;
  /** Failed calls per tool, only the tools with one or more. */
  tool_errors_by_name?: Record<string, number>;
  skills?: Array<{ name: string; source: string; count: number }>;
  slash_commands?: Array<{ name: string; count: number }>;
  agents?: Array<{ type: string; count: number }>;
  agent_default_rate?: number;
  health?: {
    tool_errors: number;
    compaction_events: number;
    context_bloat_ratio: number | null;
    context_bloat_detail: {
      max_ctx: number;
      median_ctx: number;
      sample_size: number;
      max_session_id: string;
      max_ts: string;
    } | null;
  };
  timeline?: { wall_min: number; think_min: number; idle_min: number };
  files?: Array<{ path: string; tool: string; count: number }>;
  hook_blocks?: HookBlocksFacts;
  tool_output?: ToolOutputFacts;
  /** Sections asked for that the index cannot answer yet (see ifIndexed). */
  not_indexed?: StatsSection[];
}

/** Runs a section's analyzer, or returns undefined when the index predates
 *  the section. applySchema() runs only from the indexer, not from this
 *  read-only server, so a v4 index has no hook_block table and no
 *  tool_call.result_chars until the new build has indexed once. */
function ifIndexed<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch (e) {
    if (/no such (table: hook_block|column: result_chars)/.test((e as Error).message)) return undefined;
    throw e;
  }
}

function buildScope(params: StatsParams): Scope {
  // session_id, when given, scopes every dimension to that one session —
  // since doesn't apply in that mode (a session's own start/end already
  // bounds it), so it's ignored.
  if (params.session_id) return { mode: "session", params: { session_id: params.session_id } };
  if (params.project_id) {
    return {
      mode: "project",
      params: params.since
        ? { project_id: params.project_id, since: params.since }
        : { project_id: params.project_id },
    };
  }
  if (params.since) return { mode: "since", params: { since: params.since } };
  return { mode: "global", params: {} };
}

export function projectStats(db: Database.Database, params: StatsParams): StatsFacts {
  const scope = buildScope(params);
  const sections = params.sections ?? [...STATS_SECTIONS];
  const wants = (s: StatsSection): boolean => sections.includes(s);

  const identity = analyzeIdentity(db, scope);
  const facts: StatsFacts = {
    scope: scope.mode === "session" ? "session" : scope.mode === "project" ? "project" : "all",
    project_id: params.project_id ?? null,
    session_id: params.session_id ?? null,
    sections,
    name_filter: params.name ?? null,
    sessions: 0,
    primary_model: null,
    started_at: null,
    ended_at: null,
  };
  // The session row not existing is a real, reachable case (bad
  // session_id), reflected as sessions: 0.
  if (identity.kind === "session") {
    facts.project_id = identity.session.project_id ?? params.project_id ?? null;
    facts.sessions = identity.session.started_at !== null ? 1 : 0;
    facts.primary_model = identity.session.model_primary;
    facts.started_at = identity.session.started_at;
    facts.ended_at = identity.session.ended_at;
  } else if (identity.kind === "project") {
    facts.sessions = identity.project.sessions;
    facts.primary_model = identity.project.primary_model;
    facts.started_at = identity.project.started_at;
    facts.ended_at = identity.project.ended_at;
  } else {
    facts.project_id = null;
    facts.sessions = identity.global.sessions;
    facts.started_at = identity.global.earliest_event;
    facts.ended_at = identity.global.latest_event;
  }

  if (wants("tools")) {
    const tools = analyzeTools(db, scope);
    facts.tool_counts = tools.counts;
    facts.tool_errors = tools.errors;
    facts.tool_errors_by_name = tools.errors_by_name;
  }
  const needle = params.name?.toLowerCase();
  const named = (name: string): boolean => needle === undefined || name.toLowerCase().includes(needle);
  if (wants("skills")) {
    const skills = analyzeSkills(db, scope);
    facts.skills = skills.by_name.filter((s) => named(s.name)).map((s) => ({ name: s.name, source: s.source, count: s.count }));
    facts.slash_commands = skills.slash_commands.filter((c) => named(c.name));
  }
  if (wants("agents")) {
    const agents = analyzeAgents(db, scope);
    facts.agents = agents.by_type.filter((a) => named(a.type)).map((a) => ({ type: a.type, count: a.count }));
    facts.agent_default_rate = agents.default_rate;
  }
  if (wants("health")) {
    const health = analyzeHealth(db, scope);
    facts.health = {
      tool_errors: health.tool_errors,
      compaction_events: health.compaction_events,
      context_bloat_ratio: health.context_bloat_ratio,
      context_bloat_detail: health.context_bloat_detail,
    };
  }
  if (wants("timeline")) {
    const timeline = analyzeTimeline(db, scope);
    facts.timeline = {
      wall_min: timeline.wall_min,
      think_min: timeline.think_min,
      idle_min: timeline.idle_min,
    };
  }
  if (wants("files")) facts.files = analyzeFiles(db, scope).top;
  if (wants("hook_blocks")) facts.hook_blocks = ifIndexed(() => analyzeHookBlocks(db, scope));
  if (wants("tool_output")) facts.tool_output = ifIndexed(() => analyzeToolOutput(db, scope));
  const notIndexed = (["hook_blocks", "tool_output"] as const).filter((s) => wants(s) && facts[s] === undefined);
  if (notIndexed.length > 0) facts.not_indexed = notIndexed;

  return facts;
}

/** `  (+N more)` when `shown` is shorter than `total`, else nothing. */
function moreLine(total: number, shown: number, suffix = ""): string[] {
  return total > shown ? [`  (+${total - shown} more${suffix})`] : [];
}

export function formatStats(facts: StatsFacts): string {
  if (facts.sessions === 0) {
    if (facts.scope === "session") return `No data found for session ${facts.session_id}. Check the session_id.`;
    const leftOut = "(one-shot exec/SDK runs and clens judge sessions are left out)";
    if (facts.scope === "all") return `No data found in any project ${leftOut}. Widen or remove the since filter.`;
    return `No data found for project ${facts.project_id} ${leftOut}. Check the project_id/session_id derivation or widen/remove the since filter.`;
  }
  const lines: string[] = [];
  if (facts.scope === "session") {
    lines.push(`Scope: session ${facts.session_id} in project ${facts.project_id ?? "?"}`);
  } else {
    lines.push(facts.scope === "project" ? `Scope: project ${facts.project_id}` : "Scope: all projects");
    lines.push("Leaves out one-shot exec/SDK runs and clens judge (pipeline) sessions.");
  }
  lines.push(
    // A missing ended_at prints "null", as the template printed it before.
    `Sessions: ${facts.sessions}` +
      (facts.started_at ? ` (${localTs(facts.started_at)} to ${localTs(facts.ended_at ?? "null")})` : ""),
  );
  if (facts.primary_model) lines.push(`Primary model: ${facts.primary_model}`);
  if (facts.name_filter !== null) lines.push(`Name filter: "${facts.name_filter}" (skills, slash commands and agents only)`);

  if (facts.tool_counts) {
    lines.push("", "Tool usage:");
    // Ties by name (plain <, not localeCompare, so the order does not depend
    // on the machine's locale), which also makes the cap deterministic.
    const toolEntries = Object.entries(facts.tool_counts).sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    if (toolEntries.length === 0) lines.push("  (none)");
    for (const [name, count] of toolEntries.slice(0, STATS_TOOLS_TOP)) {
      const failed = facts.tool_errors_by_name?.[name];
      lines.push(`  ${name}: ${count}${failed === undefined ? "" : ` (${failed} failed)`}`);
    }
    lines.push(...moreLine(toolEntries.length, STATS_TOOLS_TOP));
    lines.push(`Tool errors: ${facts.tool_errors}`);
  }

  if (facts.skills && facts.slash_commands) {
    lines.push("", "Skills & slash commands:");
    if (facts.skills.length === 0 && facts.slash_commands.length === 0) lines.push("  (none)");
    for (const s of facts.skills.slice(0, STATS_SKILLS_TOP)) lines.push(`  ${s.name} (${s.source}): ${s.count}`);
    // Both lists share the section, so each cut line says which list it is.
    lines.push(...moreLine(facts.skills.length, STATS_SKILLS_TOP, " skills"));
    for (const c of facts.slash_commands.slice(0, STATS_SKILLS_TOP)) lines.push(`  ${c.name}: ${c.count}`);
    lines.push(...moreLine(facts.slash_commands.length, STATS_SKILLS_TOP, " slash commands"));
  }

  if (facts.agents) {
    lines.push("", "Agents:");
    if (facts.agents.length === 0) lines.push("  (none)");
    for (const a of facts.agents) lines.push(`  ${a.type}: ${a.count}`);
    lines.push(`Default rate: ${facts.agent_default_rate}`);
  }

  if (facts.health) {
    lines.push(
      "",
      "Health:",
      `  tool_errors: ${facts.health.tool_errors}`,
      `  compaction_events: ${facts.health.compaction_events}`,
      `  context_bloat_ratio: ${facts.health.context_bloat_ratio ?? "n/a"}`,
    );
    if (facts.health.context_bloat_detail) {
      const d = facts.health.context_bloat_detail;
      lines.push(
        `    max_ctx: ${d.max_ctx} (session:${d.max_session_id} at ${localTs(d.max_ts)}), median_ctx: ${d.median_ctx}, sample_size: ${d.sample_size}`,
      );
    }
  }

  if (facts.timeline) {
    lines.push(
      "",
      `Timeline: wall ${facts.timeline.wall_min}min, think ${facts.timeline.think_min}min, idle ${facts.timeline.idle_min}min`,
    );
  }

  if (facts.files) {
    const cut = facts.files.length > STATS_FILES_TOP;
    lines.push("", cut ? `Files touched (top ${STATS_FILES_TOP} paths):` : "Files touched:");
    if (facts.files.length === 0) lines.push("  (none)");
    for (const f of facts.files.slice(0, STATS_FILES_TOP)) lines.push(`  ${f.path} (${f.tool}): ${f.count}`);
    // The analyzer stops at its LIMIT, so a full result may hide more paths.
    const suffix = facts.files.length >= FILES_ANALYZER_LIMIT ? ` of the top ${FILES_ANALYZER_LIMIT}` : "";
    lines.push(...moreLine(facts.files.length, STATS_FILES_TOP, suffix));
  }

  if (facts.not_indexed?.includes("hook_blocks")) lines.push("", `Hook blocks: ${NOT_INDEXED}`);
  if (facts.hook_blocks) {
    const hookLabel = (b: { hook_event: string; tool: string | null }) =>
      b.tool === null ? b.hook_event : `${b.hook_event} ${b.tool}`;
    lines.push("", `Hook blocks: ${facts.hook_blocks.total}`);
    for (const b of facts.hook_blocks.by_hook) lines.push(`  ${hookLabel(b)}: ${b.count}`);
    if (facts.hook_blocks.recent.length > 0) {
      lines.push("  Recent:");
      for (const r of facts.hook_blocks.recent) {
        lines.push(`    ${localTs(r.ts)} session:${r.session_id} ${hookLabel(r)}` + (r.reason_line === null ? "" : `: ${r.reason_line}`));
      }
    }
  }

  if (facts.not_indexed?.includes("tool_output")) lines.push("", `Tool output: ${NOT_INDEXED}`);
  if (facts.tool_output) {
    const out = facts.tool_output;
    if (out.measured_calls === 0) {
      lines.push("", "Tool output: (none measured)");
    } else {
      lines.push("", `Tool output (characters of tool results, text only): ${out.measured_calls} calls, ${out.total_chars} chars`);
      for (const t of out.by_tool.slice(0, STATS_TOOL_OUTPUT_TOP)) {
        lines.push(`  ${t.name}: ${t.calls} calls, total ${t.total_chars}, avg ${t.avg_chars}, max ${t.max_chars}`);
      }
      lines.push(...moreLine(out.by_tool.length, STATS_TOOL_OUTPUT_TOP));
    }
  }

  return lines.join("\n");
}
