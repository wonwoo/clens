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

import type Database from "better-sqlite3";
import type {
  AgentCallRow,
  AnomalyBatch,
  EventRow,
  EventUnknownBlockRow,
  FileOpRow,
  ParsedEvent,
  SkillCallRow,
  SlashCommandRow,
  SystemReminderRow,
  ToolCallRow,
  ToolResultInfo,
  UserTextRow,
} from "./types.js";
import { getLanguageAdapter, languageFtsTable, listKnownLanguageCodes } from "./lang/registry.js";

export interface WriterStatements {
  insertEvent: Database.Statement;
  insertToolCall: Database.Statement;
  insertFileOp: Database.Statement;
  insertUserText: Database.Statement;
  insertSkillCall: Database.Statement;
  insertAgentCall: Database.Statement;
  insertSlashCommand: Database.Statement;
  insertSystemReminder: Database.Statement;
  insertHookBlock: Database.Statement;
  insertEventUnknownBlock: Database.Statement;
  insertAnomaly: Database.Statement;
  wipeAnomaliesForFile: Database.Statement;
  updateToolCallResult: Database.Statement;
  upsertSession: Database.Statement;
  upsertProject: Database.Statement;
  wipeEventsForSession: Database.Statement;
  sessionsOnlyInFile: Database.Statement;
  deleteSession: Database.Statement;
  wipeToolCallsForSession: Database.Statement;
  wipeFileOpsForSession: Database.Statement;
  wipeUserTextsForSession: Database.Statement;
  wipeSkillCallsForSession: Database.Statement;
  wipeAgentCallsForSession: Database.Statement;
  wipeSlashCommandsForSession: Database.Statement;
  wipeSystemRemindersForSession: Database.Statement;
  wipeHookBlocksForSession: Database.Statement;
  wipeUnknownBlocksForSession: Database.Statement;
  /** One INSERT per known language code (see indexer/lang/registry.ts),
   *  keyed by code. Only actually used for codes with a registered adapter
   *  at write time — the statement exists for every known code regardless,
   *  since the table itself always exists. */
  insertLanguageFts: Map<string, Database.Statement>;
  /** Per known language code: each message of a session with the tokens
   *  stored for it in that language's table. */
  selectLanguageTokens: Map<string, Database.Statement>;
}

/** Tokens already stored, per language code and message text, joined by
 *  spaces as the language table holds them. */
export type KnownTokens = Map<string, Map<string, string>>;

export function prepareStatements(db: Database.Database): WriterStatements {
  const insertLanguageFts = new Map<string, Database.Statement>();
  const selectLanguageTokens = new Map<string, Database.Statement>();
  for (const code of listKnownLanguageCodes()) {
    const table = languageFtsTable(code);
    insertLanguageFts.set(
      code,
      db.prepare(`INSERT INTO ${table} (rowid, text, session_id, ts) VALUES (?, ?, ?, ?)`),
    );
    selectLanguageTokens.set(
      code,
      db.prepare(
        `SELECT ut.text AS text, l.text AS tokens FROM user_text ut
         JOIN ${table} l ON l.rowid = ut.rowid WHERE ut.session_id = ?`,
      ),
    );
  }
  return {
    insertLanguageFts,
    selectLanguageTokens,
    insertEvent: db.prepare(
      `INSERT OR REPLACE INTO event
       (uuid, session_id, parent_uuid, prompt_id, agent_id, is_sidechain, ts, role, model,
        in_tok, out_tok, cache_r, cache_w, text_len,
        has_tool_use, has_text, has_tool_res,
        user_turn_no, assistant_turn_no, source_file)
       VALUES
       (@uuid, @session_id, @parent_uuid, @prompt_id, @agent_id, @is_sidechain, @ts, @role, @model,
        @in_tok, @out_tok, @cache_r, @cache_w, @text_len,
        @has_tool_use, @has_text, @has_tool_res,
        @user_turn_no, @assistant_turn_no, @source_file)`,
    ),
    insertToolCall: db.prepare(
      `INSERT INTO tool_call (event_uuid, session_id, ts, call_id, name, input_json, duration_ms, is_error, result_chars)
       VALUES (@event_uuid, @session_id, @ts, @call_id, @name, @input_json, @duration_ms, @is_error, @result_chars)`,
    ),
    insertFileOp: db.prepare(
      `INSERT INTO file_op (event_uuid, session_id, ts, tool, path)
       VALUES (@event_uuid, @session_id, @ts, @tool, @path)`,
    ),
    insertUserText: db.prepare(
      `INSERT INTO user_text (event_uuid, session_id, ts, text, is_command, role, type)
       VALUES (@event_uuid, @session_id, @ts, @text, @is_command, @role, @type)`,
    ),
    insertSkillCall: db.prepare(
      `INSERT INTO skill_call (event_uuid, session_id, ts, skill, args_excerpt)
       VALUES (@event_uuid, @session_id, @ts, @skill, @args_excerpt)`,
    ),
    insertAgentCall: db.prepare(
      `INSERT INTO agent_call (event_uuid, session_id, ts, subagent_type, description, prompt_excerpt)
       VALUES (@event_uuid, @session_id, @ts, @subagent_type, @description, @prompt_excerpt)`,
    ),
    insertSlashCommand: db.prepare(
      `INSERT INTO slash_command (event_uuid, session_id, ts, name)
       VALUES (@event_uuid, @session_id, @ts, @name)`,
    ),
    insertSystemReminder: db.prepare(
      `INSERT INTO system_reminder (event_uuid, session_id, ts, category, text_excerpt)
       VALUES (@event_uuid, @session_id, @ts, @category, @text_excerpt)`,
    ),
    insertHookBlock: db.prepare(
      `INSERT INTO hook_block (event_uuid, session_id, ts, hook_event, tool, call_id, reason)
       VALUES (@event_uuid, @session_id, @ts, @hook_event, @tool, @call_id, @reason)`,
    ),
    insertEventUnknownBlock: db.prepare(
      `INSERT OR REPLACE INTO event_unknown_block (event_uuid, block_index, raw_json)
       VALUES (@event_uuid, @block_index, @raw_json)`,
    ),
    insertAnomaly: db.prepare(
      `INSERT INTO anomaly (session_id, ts, kind, count, detail, source_file)
       VALUES (@session_id, @ts, @kind, @count, @detail, @source_file)`,
    ),
    wipeAnomaliesForFile: db.prepare(`DELETE FROM anomaly WHERE source_file = ?`),
    updateToolCallResult: db.prepare(
      `UPDATE tool_call
       SET duration_ms = CAST((julianday(@result_ts) - julianday(ts)) * 86400000 AS INTEGER),
           is_error = @is_error,
           result_chars = @result_chars
       WHERE call_id = @call_id AND duration_ms IS NULL`,
    ),
    // A file writes only the sessions it holds in full (writableEvents in
    // driver.ts), so its span replaces the stored one, as in a rebuild, which
    // deletes the row first; kept with MIN/MAX, a line the file lost stayed.
    upsertSession: db.prepare(
      `INSERT INTO session (id, project_id, kind, parent_id, started_at, ended_at, cwd, git_branch, model_primary, version, source)
       VALUES (@id, @project_id, @kind, @parent_id, @started_at, @ended_at, @cwd, @git_branch, @model_primary, @version, @source)
       ON CONFLICT(id) DO UPDATE SET
         project_id    = excluded.project_id,
         kind          = excluded.kind,
         parent_id     = excluded.parent_id,
         started_at    = excluded.started_at,
         ended_at      = excluded.ended_at,
         cwd           = COALESCE(excluded.cwd, session.cwd),
         git_branch    = COALESCE(excluded.git_branch, session.git_branch),
         model_primary = COALESCE(excluded.model_primary, session.model_primary),
         version       = COALESCE(excluded.version, session.version),
         source        = excluded.source`,
    ),
    upsertProject: db.prepare(
      `INSERT INTO project (id, cwd, display)
       VALUES (@id, @cwd, @display)
       ON CONFLICT(id) DO UPDATE SET
         cwd     = COALESCE(excluded.cwd, project.cwd),
         display = COALESCE(excluded.display, project.display)`,
    ),
    wipeEventsForSession: db.prepare(`DELETE FROM event WHERE session_id = ?`),
    // Sessions all of whose event rows came from one file.
    sessionsOnlyInFile: db.prepare(
      `SELECT DISTINCT e.session_id FROM event e WHERE e.source_file = ?
         AND NOT EXISTS (SELECT 1 FROM event o WHERE o.session_id = e.session_id AND o.source_file IS NOT e.source_file)`,
    ),
    deleteSession: db.prepare(`DELETE FROM session WHERE id = ?`),
    wipeToolCallsForSession: db.prepare(`DELETE FROM tool_call WHERE session_id = ?`),
    wipeFileOpsForSession: db.prepare(`DELETE FROM file_op WHERE session_id = ?`),
    wipeUserTextsForSession: db.prepare(`DELETE FROM user_text WHERE session_id = ?`),
    wipeSkillCallsForSession: db.prepare(`DELETE FROM skill_call WHERE session_id = ?`),
    wipeAgentCallsForSession: db.prepare(`DELETE FROM agent_call WHERE session_id = ?`),
    wipeSlashCommandsForSession: db.prepare(`DELETE FROM slash_command WHERE session_id = ?`),
    wipeSystemRemindersForSession: db.prepare(`DELETE FROM system_reminder WHERE session_id = ?`),
    wipeHookBlocksForSession: db.prepare(`DELETE FROM hook_block WHERE session_id = ?`),
    wipeUnknownBlocksForSession: db.prepare(
      `DELETE FROM event_unknown_block WHERE event_uuid IN (SELECT uuid FROM event WHERE session_id = ?)`,
    ),
  };
}

/** Wipe all derived rows for the given sessions. Must be called inside the
 *  same transaction as the re-inserts so readers never see half-state. */
export function wipeSessions(stmts: WriterStatements, sessionIds: Iterable<string>): void {
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

/** The tokens stored for the messages of these sessions, read before they are
 *  wiped and re-derived. An analyzer gives the same tokens for the same text,
 *  so a message seen before needs no second run, which took most of the time
 *  a long session took to re-index. A text that gave no tokens has no row and
 *  is analyzed again. */
export function knownTokens(stmts: WriterStatements, sessionIds: Iterable<string>): KnownTokens {
  const known: KnownTokens = new Map();
  for (const code of listKnownLanguageCodes()) {
    if (!getLanguageAdapter(code)) continue;
    const byText = new Map<string, string>();
    const select = stmts.selectLanguageTokens.get(code)!;
    for (const sid of sessionIds) {
      for (const r of select.all(sid) as { text: string; tokens: string }[]) byText.set(r.text, r.tokens);
    }
    known.set(code, byText);
  }
  return known;
}

/** Insert one ParsedEvent and its child rows. */
export function writeParsedEvent(stmts: WriterStatements, p: ParsedEvent, known?: KnownTokens): void {
  stmts.insertEvent.run(toSqlBindable(p.event));
  for (const r of p.tool_calls) stmts.insertToolCall.run(toSqlBindable(r));
  for (const r of p.file_ops) stmts.insertFileOp.run(toSqlBindable(r));
  for (const r of p.user_texts) {
    const info = stmts.insertUserText.run(toSqlBindable(r));
    insertLanguageLayers(stmts, info.lastInsertRowid, r, known);
  }
  for (const r of p.skill_calls) stmts.insertSkillCall.run(toSqlBindable(r));
  for (const r of p.agent_calls) stmts.insertAgentCall.run(toSqlBindable(r));
  for (const r of p.slash_commands) stmts.insertSlashCommand.run(toSqlBindable(r));
  for (const r of p.system_reminders) stmts.insertSystemReminder.run(toSqlBindable(r));
  for (const r of p.hook_blocks) stmts.insertHookBlock.run(toSqlBindable(r));
  for (const r of p.unknown_blocks) stmts.insertEventUnknownBlock.run(toSqlBindable(r));
}

/** For each known language code with a registered adapter (i.e. actually
 *  installed — see indexer/lang/init.ts), detect + tokenize this row's text
 *  and insert the content-word tokens into that language's FTS table under
 *  the same rowid as the user_text row. Codes with no registered adapter,
 *  or text that doesn't match the adapter's script, are silently skipped —
 *  the table just stays empty for that row, same as "not installed". */
function insertLanguageLayers(
  stmts: WriterStatements,
  rowid: number | bigint,
  r: UserTextRow,
  known?: KnownTokens,
): void {
  for (const code of listKnownLanguageCodes()) {
    const adapter = getLanguageAdapter(code);
    if (!adapter || !adapter.detect(r.text)) continue;
    const tokens = known?.get(code)?.get(r.text) ?? adapter.tokenize(r.text).join(" ");
    if (!tokens) continue;
    stmts.insertLanguageFts.get(code)!.run(rowid, tokens, r.session_id, r.ts);
  }
}

/** better-sqlite3 cannot bind boolean / undefined directly. Normalize. */
function toSqlBindable(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    const v = (row as Record<string, unknown>)[k];
    if (v === undefined) out[k] = null;
    else if (typeof v === "boolean") out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

/** Flush anomaly counters to the table. Called once per file batch (§7
 *  lifecycle) so incremental and rebuild produce identical row shapes.
 *  Before flushing, any prior anomaly rows for this source_file are wiped
 *  so re-parsing the same file does not double-count. */
export function flushAnomalyBatch(
  stmts: WriterStatements,
  batch: AnomalyBatch,
): void {
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
export function applyToolResults(
  stmts: WriterStatements,
  results: Map<string, ToolResultInfo>,
): void {
  for (const [call_id, { ts, is_error, result_chars }] of results) {
    stmts.updateToolCallResult.run({ call_id, result_ts: ts, is_error, result_chars });
  }
}

// Re-export row types so consumers don't need to import from types.js directly.
export type {
  AgentCallRow,
  EventRow,
  EventUnknownBlockRow,
  FileOpRow,
  SkillCallRow,
  SlashCommandRow,
  SystemReminderRow,
  ToolCallRow,
  UserTextRow,
};
