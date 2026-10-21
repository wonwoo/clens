/**
 * JSONL parser for Claude Code session files.
 *
 * Implements ExecPlan §6.5 content-block walking rules:
 *   - one JSONL line = one event row in `event`
 *   - multi-content-block messages stay as ONE event row; their blocks
 *     are denormalized into tool_call / user_text / file_op / skill_call
 *     / agent_call / slash_command / event_unknown_block.
 *   - tool_use input is JSON-serialized and truncated to 2048 bytes (a Bash
 *     input to SHELL_TOOL_INPUT_BYTE_CAP)
 *     (UTF-8 safe boundary). Truncation increments
 *     `anomalies.tool_input_truncated`.
 *   - text_len is a codepoint count (Array.from(s).length), not a byte
 *     count.
 *   - user content that is purely tool_result blocks is the synthetic
 *     "pseudo-user" message and is excluded from user_turn_no in pass 2.
 *   - partial last line (no trailing \n) is left for next incremental run.
 *
 * The parser produces a FileParseResult. The indexer driver is responsible
 * for persisting rows, joining tool_result → tool_call for duration_ms,
 * and running the second pass that populates user_turn_no / assistant_turn_no.
 */

import { homedir } from "node:os";

import { shellWrittenFiles } from "./shell_writes.js";
import type {
  AgentCallRow,
  AnomalyBatch,
  EventRow,
  FileParseResult,
  ParsedEvent,
  SkillCallRow,
  SlashCommandRow,
  SystemReminderRow,
  ToolCallRow,
  ToolResultInfo,
  UserTextRow,
} from "./types.js";

const TOOL_INPUT_BYTE_CAP = 2048;
/** A shell tool's input is kept whole up to this, so the work record's git
 *  list, which reads the stored command, sees a git command late in a long
 *  one. The longest local shell inputs are under 40 KB. */
export const SHELL_TOOL_INPUT_BYTE_CAP = 65536;
const ASSISTANT_TEXT_BYTE_CAP = 4096;
const EVENT_UNKNOWN_BLOCK_CAP = 1024;
const SYSTEM_REMINDER_EXCERPT_CAP = 512;
export const HOOK_REASON_BYTE_CAP = 512;
const SKILL_AGENT_ARG_CHAR_CAP = 256;

const FILE_OP_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);

const SLASH_COMMAND_RE = /<command-name>\s*\/?([a-zA-Z0-9_:.\-]+)\s*<\/command-name>/g;
const SYSTEM_REMINDER_BLOCK_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
/** How Claude Code opens the error result of a call a PreToolUse hook blocked,
 *  e.g. `PreToolUse:WebFetch hook error: …`. */
const HOOK_ERROR_PREFIX_RE = /^(\w+):(\S+) hook error:/;

interface ReminderClassifier {
  category: string;
  match: (text: string) => boolean;
}

const REMINDER_TAXONOMY: readonly ReminderClassifier[] = [
  {
    category: "hook_success",
    match: (t) => /hook success/i.test(t) || /hook additional context/i.test(t),
  },
  {
    category: "task_reminder",
    match: (t) =>
      /task tools haven't been used/i.test(t) || /consider using TaskCreate/i.test(t),
  },
  {
    category: "available_agents",
    match: (t) => /Available agent types for the Agent tool/i.test(t),
  },
  {
    category: "available_skills",
    match: (t) => /The following skills are available/i.test(t),
  },
  {
    category: "available_tools",
    match: (t) => /deferred tools are now available/i.test(t),
  },
  {
    category: "session_start",
    match: (t) => /SessionStart/i.test(t),
  },
  {
    category: "user_prompt_submit",
    match: (t) => /UserPromptSubmit/i.test(t),
  },
];

/** Codepoint count for §6.5 text_len. */
export function codepointLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/**
 * UTF-8 safe truncation. Returns a byte-prefix of `s` no longer than `cap`,
 * ending on a complete codepoint boundary.
 */
export function utf8SafeTruncate(s: string, cap: number): { out: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= cap) return { out: s, truncated: false };
  // Step back until we land on a leading byte (top bits != 10xxxxxx)
  let end = cap;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { out: buf.slice(0, end).toString("utf8"), truncated: true };
}

const TRUNCATE_MARKER = "\n…[truncated]…\n";

const ERROR_HEAD_CHARS = 100;
const ERROR_TAIL_CHARS = 200;

/** What a failed call's output keeps: its first ERROR_HEAD_CHARS and last
 *  ERROR_TAIL_CHARS codepoints. The end gets more because most commands print
 *  the error last, after the output that led to it. NULL for no text. */
export function errorExcerpt(text: string): string | null {
  const t = text.trim();
  if (t === "") return null;
  if (codepointLength(t) <= ERROR_HEAD_CHARS + ERROR_TAIL_CHARS) return t;
  // A codepoint is at most two UTF-16 units, so these windows hold enough
  // whole codepoints; a surrogate half cut at a window's edge falls outside.
  const head = [...t.slice(0, ERROR_HEAD_CHARS * 2)].slice(0, ERROR_HEAD_CHARS).join("");
  const tail = [...t.slice(-ERROR_TAIL_CHARS * 2)].slice(-ERROR_TAIL_CHARS).join("");
  return head + TRUNCATE_MARKER + tail;
}

/** Like utf8SafeTruncate, but keeps a head half and a tail half instead of
 *  just the head — assistant messages tend to carry setup/context up front
 *  and the actual conclusion at the end, so a head-only cut loses the part
 *  a reader most wants when the message runs long. */
export function utf8SafeHeadTailTruncate(s: string, cap: number): { out: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= cap) return { out: s, truncated: false };

  const markerBytes = Buffer.byteLength(TRUNCATE_MARKER, "utf8");
  const keep = Math.max(cap - markerBytes, 0);
  const headCap = Math.ceil(keep / 2);
  const tailCap = keep - headCap;

  let headEnd = headCap;
  while (headEnd > 0 && (buf[headEnd]! & 0xc0) === 0x80) headEnd -= 1;

  let tailStart = buf.byteLength - tailCap;
  while (tailStart < buf.byteLength && (buf[tailStart]! & 0xc0) === 0x80) tailStart += 1;

  const head = buf.slice(0, headEnd).toString("utf8");
  const tail = buf.slice(tailStart).toString("utf8");
  return { out: head + TRUNCATE_MARKER + tail, truncated: true };
}

function bumpAnomaly(batch: AnomalyBatch, kind: string, detail: string | null = null): void {
  const cur = batch.counters.get(kind);
  if (cur) {
    cur.count += 1;
    if (detail !== null) cur.detail = detail;
  } else {
    batch.counters.set(kind, { count: 1, detail });
  }
}

function classifyReminder(text: string): string {
  for (const c of REMINDER_TAXONOMY) if (c.match(text)) return c.category;
  return "other";
}

function isToolResultBlob(text: string): boolean {
  // §6.5: filter out user text that is a tool_result blob masquerading as
  // user text (starts with "[{" and contains tool_use_id).
  return text.startsWith("[{") && text.includes("tool_use_id");
}

/** Remove the markup Claude Code wraps around a typed slash command before
 *  the text is stored in user_text, so command names don't pollute FTS
 *  ranking: the <command-name> and <command-message> blocks go, and
 *  <command-args> is unwrapped to what the user typed after the command.
 *  Text without that markup is stored exactly as written. This used to strip
 *  every "/word" anywhere in the message, which cut file paths and URLs out
 *  of what users had pasted ("src/mcp/server.ts" became "src.ts"). */
function stripCommandMarkup(text: string): string {
  if (!/<command-(?:name|message|args)>/.test(text)) return text;
  return text
    .replace(/<command-(name|message)>[\s\S]*?<\/command-\1>/g, "")
    .replace(/<command-args>([\s\S]*?)<\/command-args>/g, "$1")
    .trim();
}

function isContinuationSummary(text: string): boolean {
  const head = text.slice(0, 200);
  return /This session is being continued from a previous conversation/i.test(head);
}

interface BlockSummary {
  has_text: 0 | 1;
  has_tool_use: 0 | 1;
  has_tool_res: 0 | 1;
  text_len: number;
}

/** The text of a tool_result's content, or of a queued prompt: the string
 *  itself, or its text blocks joined. Images and other blocks add nothing. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text;
}

/**
 * Walk message.content and produce all the denormalized child rows for one
 * event. Mutates `batch` for anomaly bookkeeping. Returns a summary used by
 * the event row.
 */
function walkContent(args: {
  event_uuid: string;
  session_id: string;
  ts: string;
  role: string;
  isMeta: boolean;
  /** The line's working directory, where a Bash command on it starts. */
  cwd: string | null;
  content: unknown;
  batch: AnomalyBatch;
  out: ParsedEvent;
  toolResults: Map<string, ToolResultInfo>;
}): BlockSummary {
  const { event_uuid, session_id, ts, role, isMeta, cwd, content, batch, out, toolResults } = args;
  const summary: BlockSummary = {
    has_text: 0,
    has_tool_use: 0,
    has_tool_res: 0,
    text_len: 0,
  };

  if (content === null || content === undefined) {
    bumpAnomaly(batch, "null_content");
    return summary;
  }

  // String form (rare on assistant events; common on plain user messages).
  if (typeof content === "string") {
    summary.has_text = 1;
    summary.text_len += codepointLength(content);
    if (role === "user" && !isToolResultBlob(content)) {
      if (isMeta) {
        // Skill/system-injected message (isMeta:true) — drop user_text but
        // still emit any slash_command rows embedded in the body.
        scanSlashCommands(content, event_uuid, session_id, ts, out.slash_commands);
        bumpAnomaly(batch, "skill_body_skipped");
      } else {
        const userText: UserTextRow = {
          event_uuid,
          session_id,
          ts,
          text: stripCommandMarkup(content),
          is_command: scanSlashCommands(content, event_uuid, session_id, ts, out.slash_commands)
            ? 1
            : 0,
          role: "user",
          type: isContinuationSummary(content) ? "continuation_summary" : "user_message",
        };
        out.user_texts.push(userText);
      }
    }
    extractRemindersFromText(content, event_uuid, session_id, ts, out.system_reminders);
    return summary;
  }

  // Unknown non-array, non-string content.
  if (!Array.isArray(content)) {
    bumpAnomaly(batch, "unrecognized_content_shape");
    return summary;
  }

  let blockIndex = 0;
  // First pass: aggregate authored user text across all text blocks of one
  // user event so a single user_text row carries the full message body.
  const userTextChunks: string[] = [];

  for (const block of content) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      const raw = JSON.stringify(block);
      const truncRaw = raw.slice(0, EVENT_UNKNOWN_BLOCK_CAP);
      out.unknown_blocks.push({
        event_uuid,
        block_index: blockIndex,
        raw_json: truncRaw,
      });
      bumpAnomaly(batch, "unknown_block_type");
      blockIndex += 1;
      continue;
    }

    const b = block as Record<string, unknown>;
    const t = typeof b.type === "string" ? (b.type as string) : "<missing>";

    if (t === "text" && typeof b.text === "string") {
      summary.has_text = 1;
      summary.text_len += codepointLength(b.text);
      if (role === "user" && !isToolResultBlob(b.text)) {
        userTextChunks.push(b.text);
      } else if (role === "assistant" && b.text.length > 0) {
        const { out: clipped } = utf8SafeHeadTailTruncate(b.text, ASSISTANT_TEXT_BYTE_CAP);
        out.user_texts.push({
          event_uuid,
          session_id,
          ts,
          text: clipped,
          is_command: 0,
          role: "assistant",
          type: "assistant_message",
        });
      }
      extractRemindersFromText(b.text, event_uuid, session_id, ts, out.system_reminders);
    } else if (t === "tool_use") {
      summary.has_tool_use = 1;
      const name = typeof b.name === "string" ? b.name : "<missing>";
      const call_id = typeof b.id === "string" ? b.id : null;
      const inputRaw = b.input === undefined ? null : JSON.stringify(b.input);
      let input_json: string | null = null;
      if (inputRaw !== null) {
        const cap = name === "Bash" ? SHELL_TOOL_INPUT_BYTE_CAP : TOOL_INPUT_BYTE_CAP;
        const { out: clipped, truncated } = utf8SafeTruncate(inputRaw, cap);
        input_json = clipped;
        if (truncated) bumpAnomaly(batch, "tool_input_truncated");
      }
      const toolCall: ToolCallRow = {
        event_uuid,
        session_id,
        ts,
        call_id,
        name,
        input_json,
        duration_ms: null,
        is_error: 0,
        result_chars: null,
      };
      out.tool_calls.push(toolCall);

      if (FILE_OP_TOOLS.has(name)) {
        const input = (b.input ?? {}) as { file_path?: unknown; notebook_path?: unknown };
        const path =
          typeof input.file_path === "string"
            ? input.file_path
            : typeof input.notebook_path === "string"
              ? input.notebook_path
              : null;
        if (path !== null) {
          out.file_ops.push({ event_uuid, session_id, ts, tool: name, path });
        }
      }

      // Read off the full command: the stored input_json may be cut.
      if (name === "Bash") {
        const command = (b.input as { command?: unknown } | undefined)?.command;
        if (typeof command === "string") {
          let paths: string[] = [];
          try {
            paths = shellWrittenFiles(command, cwd, homedir());
          } catch {
            // A command the reader cannot handle loses its file list, not the
            // rest of the file.
            bumpAnomaly(batch, "shell_writes_error");
          }
          for (const path of paths) {
            out.file_ops.push({ event_uuid, session_id, ts, tool: name, path });
          }
        }
      }

      if (name === "Skill") {
        const input = (b.input ?? {}) as { skill?: unknown; args?: unknown };
        const skill = typeof input.skill === "string" ? input.skill : "<missing>";
        const argsStr = typeof input.args === "string" ? input.args : input.args === undefined ? "" : JSON.stringify(input.args);
        const args_excerpt = argsStr.slice(0, SKILL_AGENT_ARG_CHAR_CAP);
        const row: SkillCallRow = {
          event_uuid,
          session_id,
          ts,
          skill,
          args_excerpt,
        };
        out.skill_calls.push(row);
      }

      if (name === "Agent") {
        const input = (b.input ?? {}) as {
          subagent_type?: unknown;
          description?: unknown;
          prompt?: unknown;
        };
        const subagent_type =
          typeof input.subagent_type === "string" ? input.subagent_type : "<default>";
        const description = typeof input.description === "string" ? input.description : null;
        const promptStr = typeof input.prompt === "string" ? input.prompt : "";
        const row: AgentCallRow = {
          event_uuid,
          session_id,
          ts,
          subagent_type,
          description,
          prompt_excerpt: promptStr.slice(0, SKILL_AGENT_ARG_CHAR_CAP),
        };
        out.agent_calls.push(row);
      }
    } else if (t === "tool_result") {
      summary.has_tool_res = 1;
      const tool_use_id = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
      const is_error: 0 | 1 = b.is_error === true ? 1 : 0;
      if (tool_use_id !== null) {
        const text = toolResultText(b.content);
        toolResults.set(tool_use_id, {
          ts,
          is_error,
          result_chars: codepointLength(text),
          error_excerpt: is_error === 1 ? errorExcerpt(text) : null,
        });
        // Only an error result that opens with the prefix is a block: the
        // same words later in a result (grep output, a quoted log) are not.
        const m = is_error === 1 ? HOOK_ERROR_PREFIX_RE.exec(text) : null;
        if (m !== null) {
          const rest = text.slice(m[0].length).trim();
          out.hook_blocks.push({
            event_uuid,
            session_id,
            ts,
            hook_event: m[1]!,
            tool: m[2]!,
            call_id: tool_use_id,
            reason: rest === "" ? null : utf8SafeTruncate(rest, HOOK_REASON_BYTE_CAP).out,
          });
        }
      }
    } else if (t === "thinking") {
      // Thinking blocks are content but not user-visible; we ignore them
      // for text_len and child rows. Not an anomaly.
    } else {
      // Unknown block type with a recognizable structure.
      const raw = JSON.stringify(block).slice(0, EVENT_UNKNOWN_BLOCK_CAP);
      out.unknown_blocks.push({
        event_uuid,
        block_index: blockIndex,
        raw_json: raw,
      });
      bumpAnomaly(batch, "unknown_block_type");
    }
    blockIndex += 1;
  }

  if (userTextChunks.length > 0) {
    const joined = userTextChunks.join("\n");
    if (isMeta) {
      // Skill/system-injected message — drop user_text. Unlike the string
      // form above, no slash_command rows are emitted for it.
      bumpAnomaly(batch, "skill_body_skipped");
    } else {
      const isCommand = scanSlashCommands(
        joined,
        event_uuid,
        session_id,
        ts,
        out.slash_commands,
      );
      out.user_texts.push({
        event_uuid,
        session_id,
        ts,
        text: stripCommandMarkup(joined),
        is_command: isCommand ? 1 : 0,
        role: "user",
        type: isContinuationSummary(joined) ? "continuation_summary" : "user_message",
      });
    }
  }

  return summary;
}

/**
 * Scan a user text body for slash-command markers, pushing rows. Returns true
 * iff at least one was found.
 */
function scanSlashCommands(
  text: string,
  event_uuid: string,
  session_id: string,
  ts: string,
  out: SlashCommandRow[],
): boolean {
  let hit = false;
  SLASH_COMMAND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SLASH_COMMAND_RE.exec(text)) !== null) {
    hit = true;
    out.push({
      event_uuid,
      session_id,
      ts,
      name: m[1]!,
    });
  }
  return hit;
}

function extractRemindersFromText(
  text: string,
  event_uuid: string,
  session_id: string,
  ts: string,
  out: SystemReminderRow[],
): void {
  SYSTEM_REMINDER_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SYSTEM_REMINDER_BLOCK_RE.exec(text)) !== null) {
    const body = m[1]!.replace(/\s+/g, " ").trim();
    const cat = classifyReminder(body);
    out.push({
      event_uuid,
      session_id,
      ts,
      category: cat,
      text_excerpt: utf8SafeTruncate(body, SYSTEM_REMINDER_EXCERPT_CAP).out,
    });
  }
}

/** The session id a Claude Code subagent's lines are stored under. */
export function agentSessionId(agentId: string): string {
  return `agent-${agentId}`;
}

/**
 * Parse one JSONL line into a ParsedEvent. Returns null if the line is
 * empty (consumer can skip), or throws-like flags via the anomaly batch.
 *
 * `seq` is the file-local 1-based ordinal of this line (only used in the
 * json_parse_error detail; a line with no uuid is skipped).
 */
export function parseEventLine(
  line: string,
  source_file: string,
  seq: number,
  batch: AnomalyBatch,
  toolResults: Map<string, ToolResultInfo>,
): ParsedEvent | null {
  if (line.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    bumpAnomaly(batch, "json_parse_error", JSON.stringify({ source_file, seq }));
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    bumpAnomaly(batch, "non_object_line");
    return null;
  }
  const o = obj as Record<string, unknown>;

  // Some files carry non-event marker lines like {"type":"last-prompt", "leafUuid":..., "sessionId":...}.
  // These have no `uuid` field. We skip them with an anomaly counter so they
  // don't pollute the event table or break the line-accounting gate; the
  // file_cursor.lines field still counts them.
  if (typeof o.uuid !== "string") {
    bumpAnomaly(batch, "non_event_line");
    return null;
  }

  const uuid = o.uuid;
  // A subagent's lines carry its parent's sessionId; its agentId names its
  // own thread, stored as a session of its own.
  const session_id =
    o.isSidechain === true && typeof o.agentId === "string"
      ? agentSessionId(o.agentId)
      : typeof o.sessionId === "string" ? o.sessionId : "<unknown>";
  if (batch.session_id === null) batch.session_id = session_id;

  const ts = typeof o.timestamp === "string" ? o.timestamp : new Date(0).toISOString();
  const role = typeof o.type === "string" ? o.type : null;

  const message = (o.message ?? {}) as Record<string, unknown>;
  const usage = (message.usage ?? {}) as Record<string, unknown>;
  const messageRole = typeof message.role === "string" ? message.role : null;

  if (role !== null && messageRole !== null && messageRole !== role && role !== "attachment") {
    bumpAnomaly(batch, "role_mismatch");
  }

  const event: EventRow = {
    uuid,
    session_id,
    parent_uuid: typeof o.parentUuid === "string" ? o.parentUuid : null,
    prompt_id: typeof o.promptId === "string" ? o.promptId : null,
    agent_id: typeof o.agentId === "string" ? o.agentId : null,
    is_sidechain: typeof o.isSidechain === "boolean" ? (o.isSidechain ? 1 : 0) : null,
    ts,
    role,
    model: typeof message.model === "string" ? message.model : null,
    in_tok: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    out_tok: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    cache_r:
      typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
    cache_w:
      typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0,
    text_len: 0,
    has_tool_use: 0,
    has_text: 0,
    has_tool_res: 0,
    user_turn_no: null,
    assistant_turn_no: null,
    source_file,
  };

  const parsed: ParsedEvent = {
    event,
    tool_calls: [],
    file_ops: [],
    user_texts: [],
    skill_calls: [],
    agent_calls: [],
    slash_commands: [],
    system_reminders: [],
    hook_blocks: [],
    unknown_blocks: [],
  };

  const summary = walkContent({
    event_uuid: uuid,
    session_id,
    ts,
    role: role ?? "",
    isMeta: o.isMeta === true,
    cwd: typeof o.cwd === "string" ? o.cwd : null,
    content: message.content,
    batch,
    out: parsed,
    toolResults,
  });
  parsed.event.text_len = summary.text_len;
  parsed.event.has_text = summary.has_text;
  parsed.event.has_tool_use = summary.has_tool_use;
  parsed.event.has_tool_res = summary.has_tool_res;

  // A Stop hook's refusal is a line of its own. A PreToolUse refusal is taken
  // from the blocked call's result above, so one here would count it twice.
  const attachment = o.attachment;
  if (o.type === "attachment" && attachment !== null && typeof attachment === "object") {
    const a = attachment as Record<string, unknown>;
    if (a.type === "hook_blocking_error" && typeof a.hookEvent === "string" && a.hookEvent !== "PreToolUse") {
      const blocking = a.blockingError;
      const reason = blocking !== null && typeof blocking === "object"
        ? (blocking as Record<string, unknown>).blockingError
        : undefined;
      parsed.hook_blocks.push({
        event_uuid: uuid,
        session_id,
        ts,
        hook_event: a.hookEvent,
        tool: null,
        call_id: null,
        reason: typeof reason === "string" ? utf8SafeTruncate(reason, HOOK_REASON_BYTE_CAP).out : null,
      });
    }
    // A message the user sent while the agent was working is queued and
    // handed over mid-turn as this attachment, never as a user line. Only
    // the user's own: task notifications and peer or coordinator messages
    // come the same way.
    const origin = a.origin as Record<string, unknown> | null | undefined;
    if (a.type === "queued_command" && origin?.kind === "human") {
      const text = toolResultText(a.prompt).trim();
      if (text !== "") {
        parsed.user_texts.push({ event_uuid: uuid, session_id, ts, text, is_command: 0, role: "user", type: "user_message" });
      }
    }
  }

  // A compaction writes one system line of its own, followed by the summary as
  // a user message. Its excerpt keeps the trigger ("manual" or "auto").
  if (o.type === "system" && o.subtype === "compact_boundary") {
    const meta = o.compactMetadata;
    const trigger = meta !== null && typeof meta === "object" ? (meta as Record<string, unknown>).trigger : undefined;
    parsed.system_reminders.push({
      event_uuid: uuid,
      session_id,
      ts,
      category: "compaction",
      text_excerpt: typeof trigger === "string" ? trigger : null,
    });
  }

  return parsed;
}

/**
 * Parse an entire JSONL file body. Partial last line (no trailing \n)
 * is excluded from `events` and from `last_ok_byte_offset`; the driver
 * re-reads the whole file on its next change, which picks it up.
 *
 * `last_ok_byte_offset` is a BYTE offset (not codepoint offset), computed
 * over the UTF-8 buffer. It is stored as file_cursor.last_ok; nothing
 * resumes reading from it.
 */
export function parseFileBody(args: {
  body: string;
  source_file: string;
  batch: AnomalyBatch;
}): FileParseResult {
  const { body, source_file, batch } = args;
  const events: ParsedEvent[] = [];
  const toolResults = new Map<string, ToolResultInfo>();
  const sessionMeta: FileParseResult["session_meta"] = {
    cwd: null,
    git_branch: null,
    version: null,
  };
  let entrypoint: string | null = null;

  const buf = Buffer.from(body, "utf8");
  let i = 0;
  let lineStartByte = 0;
  let lineSeq = 0;
  let lastOk = 0;
  let fullyTerminated = 0;

  while (i < buf.byteLength) {
    if (buf[i] === 0x0a /* \n */) {
      const line = buf.slice(lineStartByte, i).toString("utf8");
      lineSeq += 1;
      const parsed = parseEventLine(line, source_file, lineSeq, batch, toolResults);
      if (parsed !== null) events.push(parsed);
      // A subagent's parent is the sessionId its lines carry.
      if (sessionMeta.parent_id === undefined && parsed !== null && parsed.event.agent_id !== null
        && parsed.event.session_id === agentSessionId(parsed.event.agent_id)) {
        const sid = (JSON.parse(line) as Record<string, unknown>).sessionId;
        if (typeof sid === "string") sessionMeta.parent_id = sid;
      }
      // Harvest session-level meta from the first line that carries each
      // field. Cheap — we only parse JSON if any meta field is still null.
      if (sessionMeta.cwd === null || sessionMeta.git_branch === null || sessionMeta.version === null || entrypoint === null) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (sessionMeta.cwd === null && typeof obj.cwd === "string") sessionMeta.cwd = obj.cwd;
          if (sessionMeta.git_branch === null && typeof obj.gitBranch === "string") sessionMeta.git_branch = obj.gitBranch;
          if (sessionMeta.version === null && typeof obj.version === "string") sessionMeta.version = obj.version;
          if (entrypoint === null && typeof obj.entrypoint === "string") entrypoint = obj.entrypoint;
        } catch {
          // already counted as json_parse_error inside parseEventLine
        }
      }
      fullyTerminated += 1;
      lastOk = i + 1;
      lineStartByte = i + 1;
    }
    i += 1;
  }

  // A session started through the SDK (`claude -p`, or a program built on
  // it) is a program's run, not the user's conversation.
  if (entrypoint?.startsWith("sdk-")) sessionMeta.kind = "exec";

  return {
    events,
    anomalies: batch,
    fully_terminated_line_count: fullyTerminated,
    last_ok_byte_offset: lastOk,
    tool_results: toolResults,
    session_meta: sessionMeta,
  };
}

/**
 * Second-pass turn numbering for the events of one session.
 *
 * - user_turn_no: 1-based row_number over events with role='user' and NOT
 *   pseudo-user (purely tool_result content).
 * - assistant_turn_no: 1-based row_number over events with role='assistant'.
 *
 * A user event is pseudo-user when its content was purely tool_result
 * blocks (i.e. has_tool_res=1 AND has_text=0 AND has_tool_use=0).
 */
export function assignTurnNumbers(
  events: ParsedEvent[],
): { userTurns: number; assistantTurns: number } {
  // Sort by ts in case the caller passes events from multiple files for one session.
  const sorted = [...events].sort((a, b) => (a.event.ts < b.event.ts ? -1 : a.event.ts > b.event.ts ? 1 : 0));
  let u = 0;
  let a = 0;
  for (const ev of sorted) {
    const e = ev.event;
    if (e.role === "user") {
      const isPseudo = e.has_text === 0 && e.has_tool_use === 0 && e.has_tool_res === 1;
      if (!isPseudo) {
        u += 1;
        e.user_turn_no = u;
      }
    } else if (e.role === "assistant") {
      a += 1;
      e.assistant_turn_no = a;
    }
  }
  return { userTurns: u, assistantTurns: a };
}
