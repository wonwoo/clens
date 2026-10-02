/**
 * Row writer. Builds prepared statements once per DB connection and runs all
 * inserts for one file batch inside a single transaction so digests match
 * across incremental and rebuild paths (gate 2).
 *
 * Insert order matters for FK integrity (when fk are enabled) — events first,
 * then everything that references event.uuid. We have FK pragmas off (§7
 * note), but we preserve the order anyway for clarity and future-proofing.
 *
 * For incremental updates the writer accepts a list of session_ids whose
 * derived rows must be wiped first (since one new line in a session can
 * change the second-pass turn numbering for every later event in that
 * session). The driver computes that set and calls `wipeSessionEvents`
 * before re-inserting all events for the affected sessions.
 */
import { getLanguageAdapter, languageFtsTable, listKnownLanguageCodes } from "./lang/registry.js";
export function prepareStatements(db) {
    const insertLanguageFts = new Map();
    for (const code of listKnownLanguageCodes()) {
        const table = languageFtsTable(code);
        insertLanguageFts.set(code, db.prepare(`INSERT INTO ${table} (rowid, text, session_id, ts) VALUES (?, ?, ?, ?)`));
    }
    return {
        insertLanguageFts,
        insertEvent: db.prepare(`INSERT OR REPLACE INTO event
       (uuid, session_id, parent_uuid, prompt_id, agent_id, is_sidechain, ts, role, model,
        in_tok, out_tok, cache_r, cache_w, text_len,
        has_tool_use, has_text, has_tool_res,
        user_turn_no, assistant_turn_no, source_file)
       VALUES
       (@uuid, @session_id, @parent_uuid, @prompt_id, @agent_id, @is_sidechain, @ts, @role, @model,
        @in_tok, @out_tok, @cache_r, @cache_w, @text_len,
        @has_tool_use, @has_text, @has_tool_res,
        @user_turn_no, @assistant_turn_no, @source_file)`),
        insertToolCall: db.prepare(`INSERT INTO tool_call (event_uuid, session_id, ts, call_id, name, input_json, duration_ms, is_error, result_chars)
       VALUES (@event_uuid, @session_id, @ts, @call_id, @name, @input_json, @duration_ms, @is_error, @result_chars)`),
        insertFileOp: db.prepare(`INSERT INTO file_op (event_uuid, session_id, ts, tool, path)
       VALUES (@event_uuid, @session_id, @ts, @tool, @path)`),
        insertUserText: db.prepare(`INSERT INTO user_text (event_uuid, session_id, ts, text, is_command, role, type)
       VALUES (@event_uuid, @session_id, @ts, @text, @is_command, @role, @type)`),
        insertSkillCall: db.prepare(`INSERT INTO skill_call (event_uuid, session_id, ts, skill, args_excerpt)
       VALUES (@event_uuid, @session_id, @ts, @skill, @args_excerpt)`),
        insertAgentCall: db.prepare(`INSERT INTO agent_call (event_uuid, session_id, ts, subagent_type, description, prompt_excerpt)
       VALUES (@event_uuid, @session_id, @ts, @subagent_type, @description, @prompt_excerpt)`),
        insertSlashCommand: db.prepare(`INSERT INTO slash_command (event_uuid, session_id, ts, name)
       VALUES (@event_uuid, @session_id, @ts, @name)`),
        insertSystemReminder: db.prepare(`INSERT INTO system_reminder (event_uuid, session_id, ts, category, text_excerpt)
       VALUES (@event_uuid, @session_id, @ts, @category, @text_excerpt)`),
        insertHookBlock: db.prepare(`INSERT INTO hook_block (event_uuid, session_id, ts, hook_event, tool, call_id, reason)
       VALUES (@event_uuid, @session_id, @ts, @hook_event, @tool, @call_id, @reason)`),
        insertEventUnknownBlock: db.prepare(`INSERT OR REPLACE INTO event_unknown_block (event_uuid, block_index, raw_json)
       VALUES (@event_uuid, @block_index, @raw_json)`),
        insertAnomaly: db.prepare(`INSERT INTO anomaly (session_id, ts, kind, count, detail, source_file)
       VALUES (@session_id, @ts, @kind, @count, @detail, @source_file)`),
        wipeAnomaliesForFile: db.prepare(`DELETE FROM anomaly WHERE source_file = ?`),
        updateToolCallResult: db.prepare(`UPDATE tool_call
       SET duration_ms = CAST((julianday(@result_ts) - julianday(ts)) * 86400000 AS INTEGER),
           is_error = @is_error,
           result_chars = @result_chars
       WHERE call_id = @call_id AND duration_ms IS NULL`),
        upsertSession: db.prepare(`INSERT INTO session (id, project_id, kind, parent_id, started_at, ended_at, cwd, git_branch, model_primary, version, source)
       VALUES (@id, @project_id, @kind, @parent_id, @started_at, @ended_at, @cwd, @git_branch, @model_primary, @version, @source)
       ON CONFLICT(id) DO UPDATE SET
         project_id    = excluded.project_id,
         kind          = excluded.kind,
         parent_id     = excluded.parent_id,
         started_at    = MIN(session.started_at, excluded.started_at),
         ended_at      = MAX(COALESCE(session.ended_at, ''), excluded.ended_at),
         cwd           = COALESCE(excluded.cwd, session.cwd),
         git_branch    = COALESCE(excluded.git_branch, session.git_branch),
         model_primary = COALESCE(excluded.model_primary, session.model_primary),
         version       = COALESCE(excluded.version, session.version),
         source        = excluded.source`),
        upsertProject: db.prepare(`INSERT INTO project (id, cwd, display)
       VALUES (@id, @cwd, @display)
       ON CONFLICT(id) DO UPDATE SET
         cwd     = COALESCE(excluded.cwd, project.cwd),
         display = COALESCE(excluded.display, project.display)`),
        wipeEventsForSession: db.prepare(`DELETE FROM event WHERE session_id = ?`),
        // Sessions all of whose event rows came from one file.
        sessionsOnlyInFile: db.prepare(`SELECT DISTINCT e.session_id FROM event e WHERE e.source_file = ?
         AND NOT EXISTS (SELECT 1 FROM event o WHERE o.session_id = e.session_id AND o.source_file IS NOT e.source_file)`),
        deleteSession: db.prepare(`DELETE FROM session WHERE id = ?`),
        wipeToolCallsForSession: db.prepare(`DELETE FROM tool_call WHERE session_id = ?`),
        wipeFileOpsForSession: db.prepare(`DELETE FROM file_op WHERE session_id = ?`),
        wipeUserTextsForSession: db.prepare(`DELETE FROM user_text WHERE session_id = ?`),
        wipeSkillCallsForSession: db.prepare(`DELETE FROM skill_call WHERE session_id = ?`),
        wipeAgentCallsForSession: db.prepare(`DELETE FROM agent_call WHERE session_id = ?`),
        wipeSlashCommandsForSession: db.prepare(`DELETE FROM slash_command WHERE session_id = ?`),
        wipeSystemRemindersForSession: db.prepare(`DELETE FROM system_reminder WHERE session_id = ?`),
        wipeHookBlocksForSession: db.prepare(`DELETE FROM hook_block WHERE session_id = ?`),
        wipeUnknownBlocksForSession: db.prepare(`DELETE FROM event_unknown_block WHERE event_uuid IN (SELECT uuid FROM event WHERE session_id = ?)`),
    };
}
/** Wipe all derived rows for the given sessions. Must be called inside the
 *  same transaction as the re-inserts so readers never see half-state. */
export function wipeSessions(stmts, sessionIds) {
    for (const sid of sessionIds) {
        // Order matters when FK ON: unknown_blocks → tool_call/file_op/etc → events.
        stmts.wipeUnknownBlocksForSession.run(sid);
        stmts.wipeToolCallsForSession.run(sid);
        stmts.wipeFileOpsForSession.run(sid);
        stmts.wipeUserTextsForSession.run(sid);
        stmts.wipeSkillCallsForSession.run(sid);
        stmts.wipeAgentCallsForSession.run(sid);
        stmts.wipeSlashCommandsForSession.run(sid);
        stmts.wipeSystemRemindersForSession.run(sid);
        stmts.wipeHookBlocksForSession.run(sid);
        stmts.wipeEventsForSession.run(sid);
    }
}
/** Insert one ParsedEvent and its child rows. */
export function writeParsedEvent(stmts, p) {
    stmts.insertEvent.run(toSqlBindable(p.event));
    for (const r of p.tool_calls)
        stmts.insertToolCall.run(toSqlBindable(r));
    for (const r of p.file_ops)
        stmts.insertFileOp.run(toSqlBindable(r));
    for (const r of p.user_texts) {
        const info = stmts.insertUserText.run(toSqlBindable(r));
        insertLanguageLayers(stmts, info.lastInsertRowid, r);
    }
    for (const r of p.skill_calls)
        stmts.insertSkillCall.run(toSqlBindable(r));
    for (const r of p.agent_calls)
        stmts.insertAgentCall.run(toSqlBindable(r));
    for (const r of p.slash_commands)
        stmts.insertSlashCommand.run(toSqlBindable(r));
    for (const r of p.system_reminders)
        stmts.insertSystemReminder.run(toSqlBindable(r));
    for (const r of p.hook_blocks)
        stmts.insertHookBlock.run(toSqlBindable(r));
    for (const r of p.unknown_blocks)
        stmts.insertEventUnknownBlock.run(toSqlBindable(r));
}
/** For each known language code with a registered adapter (i.e. actually
 *  installed — see indexer/lang/init.ts), detect + tokenize this row's text
 *  and insert the content-word tokens into that language's FTS table under
 *  the same rowid as the user_text row. Codes with no registered adapter,
 *  or text that doesn't match the adapter's script, are silently skipped —
 *  the table just stays empty for that row, same as "not installed". */
function insertLanguageLayers(stmts, rowid, r) {
    for (const code of listKnownLanguageCodes()) {
        const adapter = getLanguageAdapter(code);
        if (!adapter || !adapter.detect(r.text))
            continue;
        const tokens = adapter.tokenize(r.text).join(" ");
        if (!tokens)
            continue;
        stmts.insertLanguageFts.get(code).run(rowid, tokens, r.session_id, r.ts);
    }
}
/** better-sqlite3 cannot bind boolean / undefined directly. Normalize. */
function toSqlBindable(row) {
    const out = {};
    for (const k of Object.keys(row)) {
        const v = row[k];
        if (v === undefined)
            out[k] = null;
        else if (typeof v === "boolean")
            out[k] = v ? 1 : 0;
        else
            out[k] = v;
    }
    return out;
}
/** Flush anomaly counters to the table. Called once per file batch (§7
 *  lifecycle) so incremental and rebuild produce identical row shapes.
 *  Before flushing, any prior anomaly rows for this source_file are wiped
 *  so re-parsing the same file does not double-count. */
export function flushAnomalyBatch(stmts, batch) {
    if (batch.source_file !== null) {
        stmts.wipeAnomaliesForFile.run(batch.source_file);
    }
    for (const [kind, { count, detail }] of batch.counters) {
        stmts.insertAnomaly.run({
            session_id: batch.session_id,
            ts: batch.ts,
            kind,
            count,
            detail,
            source_file: batch.source_file,
        });
    }
}
/** Cross-event tool_result → tool_call.duration_ms fill. */
export function applyToolResults(stmts, results) {
    for (const [call_id, { ts, is_error, result_chars }] of results) {
        stmts.updateToolCallResult.run({ call_id, result_ts: ts, is_error, result_chars });
    }
}
//# sourceMappingURL=writer.js.map