/**
 * Canonical paths for clens. All consumers must go through here so behavior
 * stays consistent across commands and tests can override via env vars.
 *
 * clensHome() is intentionally NOT nested under claudeHome() — clens indexes
 * multiple sources (Claude Code, Codex, and future ones registered in
 * sources.ts), so its index lives in its own top-level ~/.clens/,
 * not inside any one source's home directory.
 *
 * Environment overrides (test-only):
 *   CLENS_HOME        — overrides ~/.claude/  (Claude Code input data dir)
 *   CLENS_CODEX_HOME  — overrides ~/.codex/   (Codex input data dir)
 *   CLENS_INDEX_DIR   — overrides ~/.clens/   (index output dir)
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function claudeHome(): string {
  return process.env.CLENS_HOME ?? join(homedir(), ".claude");
}

export function clensHome(): string {
  // When CLENS_HOME is overridden (test isolation) and CLENS_INDEX_DIR is
  // not explicitly set, return a non-existent sentinel so callers never
  // fall through to the real ~/.clens — mirrors codexHome()'s guard below.
  if (process.env.CLENS_HOME !== undefined && process.env.CLENS_INDEX_DIR === undefined) {
    return join(process.env.CLENS_HOME, "__no_clens__");
  }
  return process.env.CLENS_INDEX_DIR ?? join(homedir(), ".clens");
}

export function projectsDir(): string {
  return join(claudeHome(), "projects");
}

export function sessionsDir(): string {
  return join(claudeHome(), "sessions");
}

export function codexHome(): string {
  // When CLENS_HOME is overridden (test isolation) and CLENS_CODEX_HOME is
  // not explicitly set, return a non-existent sentinel so discoverFiles()
  // skips Codex data without touching the real ~/.codex.
  if (process.env.CLENS_HOME !== undefined && process.env.CLENS_CODEX_HOME === undefined) {
    return join(process.env.CLENS_HOME, "__no_codex__");
  }
  return process.env.CLENS_CODEX_HOME ?? join(homedir(), ".codex");
}

export function codexSessionsDir(): string {
  return join(codexHome(), "sessions");
}

export function indexDbPath(): string {
  return join(clensHome(), "index.db");
}

/** Where the tool-failure hook (src/hooks/tool_failure.ts) notes, one file
 *  per session, the failures it already told that session about. */
export function hintsSeenDir(): string {
  return join(clensHome(), "hints-seen");
}

/** The ledger of what users set aside (src/mcp/ledger.ts): one JSON event per line. */
export function ledgerPath(): string {
  return join(clensHome(), "ledger.jsonl");
}

export function indexLockPath(): string {
  return join(clensHome(), "index.db.lock");
}

export function watchLockPath(): string {
  return join(clensHome(), "watch.lock");
}

/** Where the watching MCP server splits other servers' search terms into
 *  morphemes (see src/mcp/analyzers.ts): a socket next to the index, or a
 *  named pipe on Windows, which has no socket files. */
export function analyzerSocketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\clens-analyzer-${createHash("sha1").update(clensHome()).digest("hex").slice(0, 16)}`;
  }
  return join(clensHome(), "analyzer.sock");
}

/** Root of downloaded optional-language morphological analysis models
 *  (e.g. Kiwi's Korean model). Inherits clensHome()'s CLENS_INDEX_DIR
 *  override, so tests never touch the real ~/.clens/models. */
export function modelsDir(): string {
  return join(clensHome(), "models");
}

export function languageModelDir(code: string): string {
  return join(modelsDir(), code);
}

/** The `cwd` clens's former judge LLM subprocess (`claude -p` /
 *  `codex exec`, removed with the suggestion pipeline) ran from. Those
 *  subprocesses logged their own session transcripts into the underlying
 *  CLI's normal session dir, keyed by cwd, and the transcripts remain there.
 *  This sentinel path lets the indexer keep recognizing and tagging them
 *  (see deriveSessionKind() in src/indexer/driver.ts). */
export function judgeCwdDir(): string {
  return join(clensHome(), "judge-cwd");
}
