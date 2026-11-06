/**
 * File walker + cursor logic.
 *
 * Responsibilities:
 *   - Enumerate *.jsonl files under every registered source's sessionsDir()
 *     (see sources.ts — currently ~/.claude/projects/, incl. subagents/*,
 *     and ~/.codex/sessions/).
 *   - Compare each file's mtime against file_cursor.mtime to decide whether
 *     it needs (re)parsing.
 *
 * Reading the body itself happens in the driver and append.ts, not here, so
 * this module stays free of I/O strategy decisions (full-read vs
 * partial-resume).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { SOURCE_ADAPTERS, type SourceAdapter } from "./sources.js";

export interface FileCursorRow {
  path: string;
  mtime: number;
  size: number;
  lines: number;
  last_ok: number;
}

export interface DiscoveredFile {
  /** Absolute path on disk. */
  path: string;
  /** Disk mtime (unix ms / 1000). */
  mtime: number;
  /** Disk size in bytes. */
  size: number;
  /** True if the file needs (re)parsing this run: new file, or mtime newer
   *  than its cursor row's, or size shrunk (truncated). */
  needs_parse: boolean;
  /** Adapter name this file was discovered under (see sources.ts). */
  source: string;
}

/** Recursive *.jsonl walker that skips symlinks and dotfiles; a missing
 *  root yields nothing. */
function walkJsonl(root: string, out: string[] = []): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return out;
  }
  for (const ent of entries) {
    const name = String(ent.name);
    if (name.startsWith(".")) continue;
    const full = join(root, name);
    if (ent.isDirectory()) walkJsonl(full, out);
    else if (ent.isFile() && name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** Load file_cursor rows into a Map keyed by path. */
function loadCursorIndex(db: Database.Database): Map<string, FileCursorRow> {
  const rows = db.prepare("SELECT * FROM file_cursor").all() as FileCursorRow[];
  const m = new Map<string, FileCursorRow>();
  for (const r of rows) m.set(r.path, r);
  return m;
}

function discoverSource(
  cursorIdx: Map<string, FileCursorRow>,
  root: string,
  source: string,
  opts: { forceRebuild?: boolean },
  out: DiscoveredFile[],
): void {
  const files = walkJsonl(root);
  for (const path of files) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const mtime = st.mtimeMs / 1000;
    const size = st.size;
    const prior = cursorIdx.get(path) ?? null;
    const needs =
      opts.forceRebuild === true ||
      prior === null ||
      mtime > prior.mtime + 1e-6 ||
      size < prior.size;
    out.push({ path, mtime, size, needs_parse: needs, source });
  }
}

/** Walk every registered source's sessions dir and decide which files need
 *  (re)parsing. `adapters` defaults to the full registry; tests may inject
 *  a subset or a fake adapter to verify new sources plug in without
 *  changing this function. */
export function discoverFiles(
  db: Database.Database,
  opts: { forceRebuild?: boolean } = {},
  adapters: readonly SourceAdapter[] = SOURCE_ADAPTERS,
): DiscoveredFile[] {
  const cursorIdx = loadCursorIndex(db);
  const out: DiscoveredFile[] = [];
  for (const adapter of adapters) {
    discoverSource(cursorIdx, adapter.sessionsDir(), adapter.name, opts, out);
  }
  return out;
}

/** Upsert a file_cursor row. */
export function upsertCursor(
  db: Database.Database,
  row: FileCursorRow,
): void {
  db.prepare(
    `INSERT INTO file_cursor (path, mtime, size, lines, last_ok)
     VALUES (@path, @mtime, @size, @lines, @last_ok)
     ON CONFLICT(path) DO UPDATE SET
       mtime=excluded.mtime,
       size=excluded.size,
       lines=excluded.lines,
       last_ok=excluded.last_ok`,
  ).run(row);
}
