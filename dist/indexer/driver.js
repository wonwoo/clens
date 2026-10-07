/**
 * Indexer driver. Orchestrates: discover → read → parse → write → resolve
 * session.kind → second-pass turn numbering → flush anomaly batch →
 * upsert file_cursor.
 *
 * Gate 2 (incremental == rebuild digest) is the tightest constraint here:
 *   - Per-file batch flush: one `anomaly` row per kind per file (same shape
 *     whether the file was first-seen or revisited).
 *   - Per-session re-derivation: when ANY event for session S changes,
 *     wipe-and-reinsert all S events so user_turn_no is recomputed from a
 *     consistent ordering.
 *   - Transaction boundary: one transaction per file batch. Writers in
 *     other clens processes block on the SQLite shared lock; the advisory
 *     lockfile prevents concurrent index writers.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import lockfile from "proper-lockfile";
import { applySchema, getSchemaVersion, SCHEMA_VERSION } from "./schema.js";
import { discoverFiles, upsertCursor } from "./cursor.js";
import { agentSessionId, assignTurnNumbers } from "./claude_parser.js";
import { getSourceAdapter } from "./sources.js";
import { applyToolResults, flushAnomalyBatch, knownTokens, prepareStatements, wipeSessions, writeParsedEvent, } from "./writer.js";
import { clensHome, codexHome, indexDbPath, indexLockPath, judgeCwdDir } from "../util/paths.js";
import { ensureLanguageAdaptersLoaded } from "./lang/init.js";
import { languageFtsTable, listKnownLanguageCodes } from "./lang/registry.js";
const LOCK_RETRY_MS = 100;
/**
 * Take an advisory lockfile. Another process treats the lock as abandoned
 * once its mtime is 60s old and takes it over; the holder's refresh runs on
 * a timer, so a holder that blocks its event loop that long (or a machine
 * that sleeps) loses the lock. proper-lockfile then throws from that timer by
 * default, which killed the whole MCP server; `onLost` is called instead, and
 * the returned release is a no-op once the lock is lost.
 */
export async function acquireLock(path, timeoutMs, onLost = (err) => console.error(`clens: lost lock ${path}:`, err.message)) {
    const start = Date.now();
    // proper-lockfile requires the target to exist.
    mkdirSync(dirname(path), { recursive: true });
    // Use a sentinel file rather than locking the db file itself.
    if (!existsSync(path)) {
        // Touch sentinel.
        const fs = await import("node:fs");
        fs.writeFileSync(path, "");
    }
    for (;;) {
        try {
            const release = await lockfile.lock(path, { retries: 0, stale: 60_000, onCompromised: onLost });
            return () => release().catch((e) => {
                if (e.code !== "ERELEASED")
                    throw e;
            });
        }
        catch (e) {
            const msg = e.message ?? "";
            if (e.code !== "ELOCKED" && !/ELOCKED|Lock file/i.test(msg)) {
                throw e;
            }
            if (Date.now() - start >= timeoutMs) {
                const err = new Error("indexer busy");
                err.exitCode = 4;
                throw err;
            }
            await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        }
    }
}
/** Open (or create) the SQLite index and ensure schema. */
export function openIndex() {
    mkdirSync(clensHome(), { recursive: true });
    const db = new Database(indexDbPath());
    applySchema(db);
    return db;
}
function deriveSessionKind(args) {
    // §7 §"`session.kind` and `session.parent_id` derivation"
    // Rule 1: subagents/agent-*.jsonl path → subagent.
    if (SUBAGENT_FILE_RE.test(args.source_file))
        return "subagent";
    // Rule 2: any sidechain event → subagent.
    if (args.any_sidechain)
        return "subagent";
    // Rule (clens-specific, not in §7): clens's former background judge
    // subprocess (`claude -p` / `codex exec`, removed with the suggestion
    // pipeline) always ran from judgeCwdDir(), never a real project directory.
    // Its transcripts are still on disk, so keep tagging them rather than let a
    // reindex turn them into ordinary interactive sessions.
    if (args.cwd === judgeCwdDir())
        return "pipeline";
    // What the transcript itself records about how the session was started
    // (Codex: a subagent thread, or a one-shot exec run; Claude Code: an SDK
    // run such as `claude -p`).
    if (args.recorded)
        return args.recorded;
    // Rules 3-5: with no sessions/<pid>.json sidecar reader in v1.0, fall back
    // to interactive when no sidechain markers exist (matches §7 rule 5).
    return "interactive";
}
/** Project id derivation. Default: the parent directory name of the JSONL
 *  file is the canonical key (~/.claude/projects/<dir>/<sessionId>.jsonl),
 *  which is already the cwd with slashes replaced by dashes. Sources whose
 *  file layout doesn't map to a project key this way (e.g. Codex, sharded
 *  under sessions/YYYY/MM/DD/) override via adapter.deriveProjectId. */
function deriveProjectId(source, filePath, cwd) {
    return getSourceAdapter(source).deriveProjectId?.(filePath, cwd) ?? basename(dirname(filePath));
}
function summarizeFile(events) {
    const out = {
        events,
        affected_sessions: new Set(),
        any_sidechain: false,
        earliest_ts: null,
        latest_ts: null,
        primary_model: null,
        cwd: null,
        git_branch: null,
        version: null,
    };
    const modelCount = new Map();
    for (const p of events) {
        const e = p.event;
        out.affected_sessions.add(e.session_id);
        if (e.is_sidechain === 1)
            out.any_sidechain = true;
        if (out.earliest_ts === null || e.ts < out.earliest_ts)
            out.earliest_ts = e.ts;
        if (out.latest_ts === null || e.ts > out.latest_ts)
            out.latest_ts = e.ts;
        if (e.role === "assistant" && typeof e.model === "string") {
            modelCount.set(e.model, (modelCount.get(e.model) ?? 0) + 1);
        }
    }
    if (modelCount.size > 0) {
        out.primary_model = [...modelCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    return out;
}
/**
 * codex_parser.ts extracts every "$word" in a Codex user_message as an
 * unvalidated skill candidate (it can't tell "$code-review" from "$100" or a
 * pasted Java inner-class name — see its SKILL_MARKER_RE comment). Confirm a
 * candidate against real installed skill directories — global
 * (codexHome()/skills/<name>) or this session's own project-local
 * (<cwd>/.codex/skills/<name>) — before trusting it. This lives here rather
 * than in the parser so codex_parser.ts stays a pure function, and rather
 * than in analyzer/ because that layer is pure-SQL-only.
 */
function isKnownCodexSkill(name, cwd) {
    if (existsSync(join(codexHome(), "skills", name)))
        return true;
    if (cwd !== null && existsSync(join(cwd, ".codex", "skills", name)))
        return true;
    return false;
}
function filterCodexSkillCandidates(events, cwd) {
    for (const p of events) {
        if (p.skill_calls.length === 0)
            continue;
        p.skill_calls = p.skill_calls.filter((sc) => isKnownCodexSkill(sc.skill, cwd));
    }
}
/**
 * Process one file's parse output: wipe affected sessions, upsert sessions
 * and projects, write events, fill tool durations, recompute turn numbers,
 * flush anomaly batch, upsert file_cursor.
 *
 * All of this happens in one transaction so digests stay consistent (gate 2).
 */
function commitFile(args) {
    const { db, stmts, source_file, mtime, size, fully_terminated_line_count, last_ok_byte_offset, live, events, tool_results, batch, session_meta, source, } = args;
    const summary = summarizeFile(writableEvents(db, source, source_file, events, batch));
    // Prefer session-level meta harvested from raw JSONL lines (§6.5 maps these
    // top-level fields onto session.*, not event.*).
    const cwd = session_meta.cwd ?? summary.cwd;
    const gitBranch = session_meta.git_branch ?? summary.git_branch;
    const version = session_meta.version ?? summary.version;
    const tx = db.transaction(() => {
        // 1) Project upsert (one row per project dir; derived from path or cwd).
        const project_id = deriveProjectId(source, source_file, cwd);
        stmts.upsertProject.run({
            id: project_id,
            // A subagent may work in another directory (a worktree, a subfolder);
            // letting it set the project's cwd made the value depend on which
            // file was read last.
            cwd: SUBAGENT_FILE_RE.test(source_file) ? null : cwd,
            display: project_id,
        });
        // 2) Session upsert per affected session.
        const kind = deriveSessionKind({
            source_file,
            any_sidechain: summary.any_sidechain,
            cwd,
            recorded: session_meta.kind,
        });
        for (const session_id of summary.affected_sessions) {
            stmts.upsertSession.run({
                id: session_id,
                project_id,
                kind,
                parent_id: session_meta.parent_id !== undefined && session_meta.parent_id !== session_id ? session_meta.parent_id : null,
                started_at: summary.earliest_ts,
                ended_at: summary.latest_ts,
                cwd,
                git_branch: gitBranch,
                model_primary: summary.primary_model,
                version,
                source,
            });
        }
        // 3) Wipe derived rows for affected sessions (so a single newly-arrived
        //    event in session S triggers full re-derivation of S — deterministic
        //    regardless of incremental-vs-rebuild path). Their messages' tokens
        //    are kept first, so re-inserting them does not run the analyzer again.
        const known = knownTokens(stmts, summary.affected_sessions);
        wipeSessions(stmts, summary.affected_sessions);
        // A session only this file held rows for, which the file no longer
        // yields (its lines are now skipped, e.g. a Codex subagent's copy of its
        // parent's history), kept those rows, and a rebuild does not re-create
        // them. Drop it.
        const dropped = stmts.sessionsOnlyInFile.all(source_file)
            .map((r) => r.session_id)
            .filter((sid) => !summary.affected_sessions.has(sid));
        wipeSessions(stmts, dropped);
        for (const sid of dropped)
            stmts.deleteSession.run(sid);
        // 4) Insert all events (turn numbers will be assigned below over the union
        //    of newly-parsed events grouped by session_id).
        //    For incremental updates of one file, this is the file's own events;
        //    for rebuild, it's the same. Gate-2 invariant: same input → same rows.
        const bySession = new Map();
        for (const p of summary.events) {
            const arr = bySession.get(p.event.session_id) ?? [];
            arr.push(p);
            bySession.set(p.event.session_id, arr);
        }
        for (const [, list] of bySession) {
            assignTurnNumbers(list);
            for (const p of list)
                writeParsedEvent(stmts, p, known);
        }
        // 5) Cross-event tool_result → tool_call.duration_ms.
        applyToolResults(stmts, tool_results);
        // 6) Anomaly batch flush.
        flushAnomalyBatch(stmts, batch);
        // 7) Upsert file_cursor.
        upsertCursor(db, {
            path: source_file,
            mtime,
            size,
            lines: fully_terminated_line_count,
            last_ok: last_ok_byte_offset,
            live: live ? 1 : 0,
        });
    });
    tx();
    return { eventsInserted: summary.events.length };
}
/** A subagent transcript: <session>/subagents/agent-*.jsonl, or one level
 *  deeper for a workflow's agents (subagents/workflows/<run>/agent-*.jsonl). */
const SUBAGENT_FILE_RE = /\/subagents\/(?:[^/]+\/)*agent-[^/]+\.jsonl$/;
/** The events a Claude transcript may write. commitFile wipes and refills
 *  every session it writes, so a file must only write the sessions it holds
 *  in full; otherwise re-reading it deletes rows that came from another file.
 *  Two kinds of lines carry a session this file does not hold in full:
 *   - A subagent transcript's lines carry the PARENT's sessionId. Writing them
 *     under it replaced the parent's conversation with the subagent's. The
 *     parser stores a line with an agentId under the agent's own session;
 *     one without is skipped.
 *   - A session continued into a new file starts that file with copies of the
 *     old session's lines. Writing them cut the old session down to the copy
 *     whenever the new file was read after the original. They are written only
 *     while that session has no rows yet, so history whose original file is
 *     gone still gets in.
 *  The file's own session is the one its last line belongs to: copies sit at
 *  the head of the file, new activity is appended at the end. Codex writes one
 *  session per file, so its events pass through. Skipped lines are counted as
 *  anomalies so line accounting still adds up. */
function writableEvents(db, source, source_file, events, batch) {
    if (source !== "claude" || events.length === 0)
        return events;
    const skip = (kind, n) => {
        if (n === 0)
            return;
        const cur = batch.counters.get(kind);
        if (cur)
            cur.count += n;
        else
            batch.counters.set(kind, { count: n, detail: null });
    };
    if (SUBAGENT_FILE_RE.test(source_file)) {
        const own = events.filter((p) => p.event.agent_id !== null && p.event.session_id === agentSessionId(p.event.agent_id));
        skip("subagent_line_skipped", events.length - own.length);
        return own;
    }
    const own = events[events.length - 1].event.session_id;
    const hasRows = db.prepare("SELECT 1 FROM event WHERE session_id = ? LIMIT 1");
    const indexed = new Map();
    const kept = events.filter((p) => {
        const sid = p.event.session_id;
        if (sid === own)
            return true;
        if (!indexed.has(sid))
            indexed.set(sid, hasRows.get(sid) !== undefined);
        return !indexed.get(sid);
    });
    skip("copied_session_line_skipped", events.length - kept.length);
    return kept;
}
/** FTS5 keeps a deleted row's index entries until a merge reaches them, and
 *  commitFile deletes and re-inserts every row of a session it re-derives, so
 *  each change to a live transcript leaves its session's text behind in the
 *  search tables. Automatic merging did not keep up: a day after a rebuild the
 *  index was 2.24 GB, 814 MB after 'optimize' and VACUUM, with the same search
 *  results. 'optimize' took under 2 s on that clean index. FTS5's secure-delete
 *  option removes entries at delete time instead, but made re-deriving an
 *  880-row session 13 times slower (3.5 s against 0.27 s). */
const FTS_OPTIMIZE_INTERVAL_MS = 60 * 60 * 1000;
function optimizeFtsIfDue(db, now, rebuilt) {
    const last = db.prepare("SELECT value FROM maintenance WHERE key = 'fts_optimized_at'").get();
    // A rebuild re-inserts every re-derivable row, so it does not wait for the hour.
    if (!rebuilt && last && now - Number(last.value) < FTS_OPTIMIZE_INTERVAL_MS)
        return;
    const tables = ["user_text_fts", "user_text_fts_trigram", ...listKnownLanguageCodes().map(languageFtsTable)];
    db.transaction(() => {
        for (const t of tables)
            db.exec(`INSERT INTO ${t} (${t}) VALUES ('optimize')`);
        db.prepare("INSERT INTO maintenance (key, value) VALUES ('fts_optimized_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(now));
    })();
}
/**
 * Public entry. On rebuild=true, drops all rows first.
 */
export async function runIndex(opts = {}) {
    // Idempotent — only the first call in a process actually loads anything.
    // Must happen before any writeParsedEvent() call so insertLanguageLayers()
    // sees a registered adapter on this very run, not just the next one.
    await ensureLanguageAdaptersLoaded();
    const lockTimeoutMs = opts.lockTimeoutMs ?? 30_000;
    const lock = { lost: null };
    const release = await acquireLock(indexLockPath(), lockTimeoutMs, (err) => {
        lock.lost = err;
    });
    const t0 = Date.now();
    try {
        const db = openIndex();
        // CREATE TABLE IF NOT EXISTS never adds columns to an already-existing
        // table, so a schema change (e.g. adding session.source) is invisible to
        // a pre-existing index.db until it hits a hard SQL error on write.
        // index.db is a fully derived cache (source of truth is the raw JSONL
        // under ~/.claude/projects and ~/.codex/sessions), so on a version
        // mismatch we just force the same full rebuild --rebuild would do.
        const storedVersion = getSchemaVersion(db);
        const needsRebuild = opts.rebuild === true || (storedVersion !== null && storedVersion !== SCHEMA_VERSION);
        const stmts = prepareStatements(db);
        if (needsRebuild) {
            // A rebuild re-derives what the transcripts on disk still hold. Claude
            // Code deletes old transcripts, which leaves the index as the only copy
            // of those sessions, so a session any of whose source files is gone is
            // kept as it is. Emptying every table here deleted them for good.
            const sources = new Map();
            for (const r of db.prepare("SELECT DISTINCT session_id, source_file FROM event").iterate()) {
                const list = sources.get(r.session_id) ?? [];
                list.push(r.source_file ?? "");
                sources.set(r.session_id, list);
            }
            const rederivable = [...sources]
                .filter(([, files]) => files.every((f) => f !== "" && existsSync(f)))
                .map(([sid]) => sid);
            const anomalyFiles = db.prepare("SELECT DISTINCT source_file FROM anomaly").all();
            const cursorPaths = db.prepare("SELECT path FROM file_cursor").all();
            const dropTx = db.transaction(() => {
                wipeSessions(stmts, rederivable);
                const dropSession = db.prepare("DELETE FROM session WHERE id = ?");
                for (const sid of rederivable)
                    dropSession.run(sid);
                const dropAnomalies = db.prepare("DELETE FROM anomaly WHERE source_file IS ?");
                for (const { source_file } of anomalyFiles) {
                    if (source_file === null || existsSync(source_file))
                        dropAnomalies.run(source_file);
                }
                // Every file on disk gets re-read; a gone file's cursor stays, as it
                // does in the incremental path.
                const dropCursor = db.prepare("DELETE FROM file_cursor WHERE path = ?");
                for (const { path } of cursorPaths)
                    if (existsSync(path))
                        dropCursor.run(path);
                db.exec(`DELETE FROM schema_version`);
                db.prepare("INSERT INTO schema_version (v) VALUES (?)").run(SCHEMA_VERSION);
            });
            dropTx();
        }
        const now = opts.now ?? Date.now();
        const discovered = discoverFiles(db, {
            now,
            forceRebuild: needsRebuild,
        });
        let filesParsed = 0;
        let events = 0;
        let parseErrors = 0;
        for (const f of discovered) {
            if (!f.needs_parse)
                continue;
            // Let the lock refresh timers run between files; a run over many files
            // otherwise holds the event loop for minutes and looks abandoned (see
            // acquireLock). Each file is committed on its own, so stopping here once
            // another writer has the lock leaves the index consistent.
            await new Promise((r) => setImmediate(r));
            if (lock.lost) {
                db.close();
                throw new Error(`clens index: lost the index lock, stopped: ${lock.lost.message}`);
            }
            const body = readFileSync(f.path, "utf8");
            const batch = {
                counters: new Map(),
                session_id: null,
                ts: new Date(Math.floor(f.mtime * 1000)).toISOString(),
                source_file: f.path,
            };
            const parsed = getSourceAdapter(f.source).parse({ body, source_file: f.path, batch });
            if (f.source === "codex") {
                filterCodexSkillCandidates(parsed.events, parsed.session_meta.cwd);
            }
            const { eventsInserted } = commitFile({
                db,
                stmts,
                filePath: f.path,
                source_file: f.path,
                mtime: f.mtime,
                size: f.size,
                fully_terminated_line_count: parsed.fully_terminated_line_count,
                last_ok_byte_offset: parsed.last_ok_byte_offset,
                live: f.live,
                events: parsed.events,
                tool_results: parsed.tool_results,
                batch,
                session_meta: parsed.session_meta,
                source: f.source,
            });
            filesParsed += 1;
            events += eventsInserted;
            parseErrors += parsed.anomalies.counters.get("json_parse_error")?.count ?? 0;
        }
        if (filesParsed > 0 && !lock.lost)
            optimizeFtsIfDue(db, now, needsRebuild);
        db.close();
        return {
            files_total: discovered.length,
            files_parsed: filesParsed,
            events_inserted: events,
            parse_errors: parseErrors,
            elapsed_ms: Date.now() - t0,
        };
    }
    finally {
        await release();
    }
}
//# sourceMappingURL=driver.js.map