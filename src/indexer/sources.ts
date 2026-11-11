/**
 * Source adapter registry — one entry per coding-agent whose session logs
 * get indexed into clens (Claude Code, Codex, and future sources such as
 * Cursor/Windsurf/Qwen). Adding a new source means adding one adapter object
 * to SOURCE_ADAPTERS below; cursor.ts, driver.ts, and watch.ts all consume
 * the registry generically. The driver branches on a source name in these
 * places only: which lines of a Claude Code transcript it writes
 * (writableEvents), the append path of each source (append.ts,
 * codex_append.ts), and a Codex parse, whose end state and skill candidates
 * it handles itself.
 */

import { projectsDir, codexSessionsDir } from "../util/paths.js";
import { projectIdOf } from "../util/project_id.js";
import { parseFileBody } from "./claude_parser.js";
import { parseCodexFileBody } from "./codex_parser.js";
import type { AnomalyBatch, FileParseResult } from "./types.js";

export interface SourceAdapter {
  /** Stable identifier stored in session.source / DiscoveredFile.source. */
  name: string;
  /** Root directory to recursively walk for *.jsonl session files. */
  sessionsDir(): string;
  /** Parse one file's raw body into the common ParsedEvent/FileParseResult shape. */
  parse(args: { body: string; source_file: string; batch: AnomalyBatch }): FileParseResult;
  /**
   * Derive project_id for a file from this source. Return null to fall back
   * to the default (parent directory name of the file path).
   */
  deriveProjectId?(source_file: string, cwd: string | null): string | null;
}

const claudeAdapter: SourceAdapter = {
  name: "claude",
  sessionsDir: projectsDir,
  parse: parseFileBody,
  // A subagent transcript sits under its parent's directory
  // (<project>/<session>/subagents/…), so its own parent directory is not
  // the project. Either separator: paths are joined with `\` on Windows.
  deriveProjectId: (source_file) => {
    const at = source_file.search(/[\\/]subagents[\\/]/);
    return at === -1 ? null : (source_file.slice(0, at).split(/[\\/]/).at(-2) ?? null);
  },
};

const codexAdapter: SourceAdapter = {
  name: "codex",
  sessionsDir: codexSessionsDir,
  parse: parseCodexFileBody,
  // Codex shards sessions under sessions/YYYY/MM/DD/, so the parent directory
  // is a date fragment, not a project key. Derive from the session cwd
  // instead: the id Claude Code gives the directory, so both sources align.
  deriveProjectId: (_source_file, cwd) => (cwd !== null ? projectIdOf(cwd) : null),
};

export const SOURCE_ADAPTERS: readonly SourceAdapter[] = [claudeAdapter, codexAdapter];

export function getSourceAdapter(name: string): SourceAdapter {
  const adapter = SOURCE_ADAPTERS.find((a) => a.name === name);
  if (adapter === undefined) throw new Error(`Unknown source adapter: ${name}`);
  return adapter;
}
