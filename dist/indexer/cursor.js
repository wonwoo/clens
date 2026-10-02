/**
 * File walker + cursor logic.
 *
 * Responsibilities:
 *   - Enumerate *.jsonl files under every registered source's sessionsDir()
 *     (see sources.ts — currently ~/.claude/projects/, incl. subagents/*,
 *     and ~/.codex/sessions/).
 *   - Compare each file's mtime against file_cursor.mtime to decide whether
 *     it needs (re)parsing.
 *   - Decide each file's `live` flag (mtime within last 60s → live=1, exclude
 *     from orphan-tool counts per §7).
 *
 * Reading the body itself happens in the driver, not here, so this module
 * stays free of I/O strategy decisions (full-read vs partial-resume).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_ADAPTERS } from "./sources.js";
const LIVE_WINDOW_MS = 60_000;
/** Recursive *.jsonl walker that ignores broken symlinks and dotfiles. */
function walkJsonl(root, out = []) {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const ent of entries) {
        const name = String(ent.name);
        if (name.startsWith("."))
            continue;
        const full = join(root, name);
        if (ent.isDirectory())
            walkJsonl(full, out);
        else if (ent.isFile() && name.endsWith(".jsonl"))
            out.push(full);
    }
    return out;
}
/** Load file_cursor rows into a Map keyed by path. */
function loadCursorIndex(db) {
    const rows = db.prepare("SELECT * FROM file_cursor").all();
    const m = new Map();
    for (const r of rows)
        m.set(r.path, r);
    return m;
}
function discoverSource(cursorIdx, root, source, opts, out) {
    if (!existsSync(root))
        return;
    const files = walkJsonl(root);
    for (const path of files) {
        let st;
        try {
            st = statSync(path);
        }
        catch {
            continue;
        }
        const mtime = st.mtimeMs / 1000;
        const size = st.size;
        const prior = cursorIdx.get(path) ?? null;
        const live = opts.now - st.mtimeMs <= LIVE_WINDOW_MS;
        const needs = opts.forceRebuild === true ||
            prior === null ||
            mtime > prior.mtime + 1e-6 ||
            size < prior.size;
        out.push({ path, mtime, size, live, prior, needs_parse: needs, source });
    }
}
/** Walk every registered source's sessions dir and decide which files need
 *  (re)parsing. `adapters` defaults to the full registry; tests may inject
 *  a subset or a fake adapter to verify new sources plug in without
 *  changing this function. */
export function discoverFiles(db, opts = { now: Date.now() }, adapters = SOURCE_ADAPTERS) {
    const cursorIdx = loadCursorIndex(db);
    const out = [];
    for (const adapter of adapters) {
        discoverSource(cursorIdx, adapter.sessionsDir(), adapter.name, opts, out);
    }
    return out;
}
/** Upsert a file_cursor row. */
export function upsertCursor(db, row) {
    db.prepare(`INSERT INTO file_cursor (path, mtime, size, lines, last_ok, live)
     VALUES (@path, @mtime, @size, @lines, @last_ok, @live)
     ON CONFLICT(path) DO UPDATE SET
       mtime=excluded.mtime,
       size=excluded.size,
       lines=excluded.lines,
       last_ok=excluded.last_ok,
       live=excluded.live`).run(row);
}
//# sourceMappingURL=cursor.js.map