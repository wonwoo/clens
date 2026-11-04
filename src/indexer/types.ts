/**
 * Types emitted by the JSONL parsers. Each `*Row` maps 1:1 to a SQLite table
 * defined in src/indexer/schema.ts; AnomalyBatch is an in-memory counter
 * flushed per file batch (see §7 anomaly lifecycle).
 */

export interface EventRow {
  uuid: string;
  session_id: string;
  parent_uuid: string | null;
  prompt_id: string | null;
  agent_id: string | null;
  is_sidechain: 0 | 1 | null;
  ts: string;
  role: string | null;
  model: string | null;
  in_tok: number;
  out_tok: number;
  cache_r: number;
  cache_w: number;
  text_len: number;
  has_tool_use: 0 | 1;
  has_text: 0 | 1;
  has_tool_res: 0 | 1;
  /** Set per session by assignTurnNumbers before the rows are written. */
  user_turn_no: number | null;
  /** Set per session by assignTurnNumbers before the rows are written. */
  assistant_turn_no: number | null;
  source_file: string;
}

export interface ToolCallRow {
  event_uuid: string;
  session_id: string;
  ts: string;
  call_id: string | null;
  name: string;
  input_json: string | null;
  duration_ms: number | null;
  is_error: 0 | 1;
  /** Code points of the result's text; NULL until a result is seen, and
   *  where the source does not measure it. */
  result_chars: number | null;
  /** The git branch checked out when the call ran: Claude Code's gitBranch
   *  on the call's own line, Codex's session_meta branch (a branch switch
   *  inside a rollout is not followed). NULL when the source names none. */
  git_branch: string | null;
}

export interface FileOpRow {
  event_uuid: string;
  session_id: string;
  ts: string;
  tool: string;
  path: string;
}

export interface UserTextRow {
  event_uuid: string;
  session_id: string;
  ts: string;
  text: string;
  is_command: 0 | 1;
  role: "user" | "assistant";
  type: string;
}

export interface SkillCallRow {
  event_uuid: string;
  session_id: string;
  ts: string;
  skill: string;
  args_excerpt: string | null;
}

export interface AgentCallRow {
  event_uuid: string;
  session_id: string;
  ts: string;
  subagent_type: string;
  description: string | null;
  prompt_excerpt: string | null;
}

export interface SlashCommandRow {
  event_uuid: string;
  session_id: string;
  ts: string;
  name: string;
}

export interface SystemReminderRow {
  event_uuid: string;
  session_id: string;
  ts: string;
  category: string;
  text_excerpt: string | null;
}

export interface HookBlockRow {
  event_uuid: string;
  session_id: string;
  ts: string;
  hook_event: string;
  tool: string | null;
  call_id: string | null;
  reason: string | null;
}

export interface EventUnknownBlockRow {
  event_uuid: string;
  block_index: number;
  raw_json: string;
}

/**
 * Per-file in-memory anomaly counter. Flushed to the SQL `anomaly` table
 * once per file batch by the indexer driver (one row per kind seen). This
 * granularity must be identical between incremental and rebuild paths so
 * `clens stats --digest` matches across both (gate 2).
 */
export interface AnomalyBatch {
  /** kind → { count, detail } */
  counters: Map<string, { count: number; detail: string | null }>;
  /** session_id to attach when flushing. Null when batch belongs to a file
   * whose sessionId could not be parsed (e.g. JSON parse errors before
   * sessionId was read). */
  session_id: string | null;
  /** timestamp to stamp the flushed row(s) with (typically the file's mtime
   * in ISO form). */
  ts: string;
  /** Absolute source file path. Lets incremental re-parses wipe their own
   * file-scoped anomaly rows before re-flushing (gate 2 invariant). */
  source_file: string | null;
}

export interface ParsedEvent {
  event: EventRow;
  tool_calls: ToolCallRow[];
  file_ops: FileOpRow[];
  user_texts: UserTextRow[];
  skill_calls: SkillCallRow[];
  agent_calls: AgentCallRow[];
  slash_commands: SlashCommandRow[];
  system_reminders: SystemReminderRow[];
  hook_blocks: HookBlockRow[];
  unknown_blocks: EventUnknownBlockRow[];
}

/** What a tool result tells its tool call: when it came, whether it was an
 *  error, how much text it held (NULL where the source does not measure), and
 *  for an error the start and end of that text (errorExcerpt). */
export type ToolResultInfo = {
  ts: string;
  is_error: 0 | 1;
  result_chars: number | null;
  error_excerpt: string | null;
};

export interface FileParseResult {
  /** Parsed events in file order. */
  events: ParsedEvent[];
  /** Anomaly counters accrued while parsing this file. */
  anomalies: AnomalyBatch;
  /** Session-level metadata: from the first line carrying each field in a
   *  Claude Code transcript, from the last session_meta line in a Codex
   *  rollout (§6.5 maps raw `cwd`/`gitBranch`/`version` onto session.*,
   *  not event.*, so we surface them here for the driver). */
  session_meta: {
    cwd: string | null;
    git_branch: string | null;
    version: string | null;
    /** How the session was started, when the transcript records it. Codex
     *  does: a subagent thread, or a one-shot `codex exec` / SDK run. Claude
     *  Code records an SDK run (`claude -p`) as its entrypoint. */
    kind?: "subagent" | "exec";
    /** The session that started this one: a subagent's parent. */
    parent_id?: string;
  };
  /** Number of fully-terminated lines parsed (excludes a partial last line
   *  with no trailing `\n`). */
  fully_terminated_line_count: number;
  /** Byte offset of the last byte consumed (== end of last `\n`-terminated
   *  line). Stored as file_cursor.last_ok. */
  last_ok_byte_offset: number;
  /** Tool-result link map: tool_use_id → { ts, is_error, result_chars, error_excerpt }. The
   *  driver uses this to fill tool_call.duration_ms, is_error, result_chars
   *  and error_excerpt by joining on call_id. */
  tool_results: Map<string, ToolResultInfo>;
}
