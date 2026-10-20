/**
 * JSONL parser for Codex rollout session files.
 *
 * Codex writes: ~/.codex/sessions/YYYY/MM/DD/rollout-{date}-{id}.jsonl
 * Each line: { "timestamp": "<ISO>", "type": "<variant>", "payload": { ... } }
 *
 * We map Codex events onto the same ParsedEvent / FileParseResult types that
 * the Claude parser produces so the driver can commit both through the same
 * commitFile() path. Differences:
 *   - session_id comes from SessionMeta.id (payload.id)
 *   - token counts come from EventMsg::token_count → TokenUsageInfo
 *   - user/assistant text come from event_msg::item_completed UserMessage /
 *     AgentMessage items (current format) or event_msg::user_message /
 *     agent_message (older files)
 *   - tool calls come from response_item::function_call / custom_tool_call,
 *     event_msg::mcp_tool_call_begin/end, and the McpToolCall items of the
 *     MCP calls exec code made; whether one failed and how
 *     long its output is come from the output text (codexOutputError), and
 *     the files an exec_command wrote from its cmd (shell_writes.ts)
 *   - one uuid is synthesised per line (no native uuid field)
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codepointLength, errorExcerpt, HOOK_REASON_BYTE_CAP, SHELL_TOOL_INPUT_BYTE_CAP, utf8SafeHeadTailTruncate, utf8SafeTruncate, } from "./claude_parser.js";
import { shellWrittenFiles } from "./shell_writes.js";
import { execCodeScan } from "../util/codex_exec.js";
const TOOL_INPUT_BYTE_CAP = 2048;
const ASSISTANT_TEXT_BYTE_CAP = 4096;
const FILE_OP_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);
// Codex has no dedicated skill-invocation event (confirmed against the full
// EventMsg enum — no skill-related variant exists). The only signal for an
// explicit skill invocation is the user typing "$skill-name" in a chat
// message, per Codex's documented trigger convention. This regex only
// extracts candidates — it can't tell a real skill name from "$100" or a
// pasted "$SuppressFuseableSubscriber" Java inner-class reference, so every
// match here is unvalidated. Validation against installed skill directories
// happens downstream in the indexer driver, not here, so this parser stays
// a pure function with no filesystem access.
const SKILL_MARKER_RE = /\$([A-Za-z][\w-]*)/g;
function extractSkillCandidates(text) {
    const names = new Set();
    for (const m of text.matchAll(SKILL_MARKER_RE))
        names.add(m[1]);
    return [...names];
}
function bumpAnomaly(batch, kind, detail) {
    const cur = batch.counters.get(kind);
    if (cur) {
        cur.count += 1;
        if (detail !== undefined)
            cur.detail = detail;
    }
    else {
        batch.counters.set(kind, { count: 1, detail: detail ?? null });
    }
}
/** Derive a stable synthetic UUID from file path + line sequence number. */
function syntheticUuid(source_file, seq) {
    // Simple deterministic key — not a real UUID but unique within the index.
    return `codex:${source_file}:${seq}`;
}
/** Codex's shell tools: their stored input is kept up to
 *  SHELL_TOOL_INPUT_BYTE_CAP, like Claude Code's Bash. */
const SHELL_TOOLS = new Set(["exec_command", "exec"]);
function truncateToolInput(raw, batch, cap = TOOL_INPUT_BYTE_CAP) {
    const { out, truncated } = utf8SafeTruncate(raw, cap);
    if (truncated)
        bumpAnomaly(batch, "tool_input_truncated");
    return out;
}
// A header's path runs to the end of its line. Inside exec code the patch is
// a string literal, so the line ends at an escaped newline or the quote.
const PATCH_FILE_RE = /\*\*\* (?:Update File|Add File|Delete File|Move to): ([^\n\r\\"'`]+)/g;
/** Files a patch edits, each once; a relative path resolves against the
 *  session's working directory. */
function patchedFiles(input, cwd) {
    const out = new Set();
    for (const m of input.matchAll(PATCH_FILE_RE)) {
        const p = m[1].trim();
        if (p !== "")
            out.add(isAbsolute(p) || cwd === null ? p : resolve(cwd, p));
    }
    return [...out];
}
function parseObjectLike(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    if (typeof value !== "string")
        return null;
    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        return null;
    }
    return null;
}
/** A tool output's text: the string itself, or the text parts of a list
 *  joined with nothing between, as Claude Code's tool results are read. */
function codexOutputText(output) {
    if (typeof output === "string")
        return output;
    if (!Array.isArray(output))
        return "";
    let text = "";
    for (const part of output) {
        if (part === null || typeof part !== "object")
            continue;
        const p = part;
        if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string")
            text += p.text;
    }
    return text;
}
const FAILED_OUTPUT_PREFIXES = [
    "Command blocked by PreToolUse hook: ",
    "Tool call blocked by PreToolUse hook: ",
    "aborted by user",
    "patch rejected by user",
    "exec_command failed",
    "write_stdin failed",
    "apply_patch verification failed",
    "Script failed",
];
/** The exit code in a shell output's header ("Process exited with code N"
 *  before the first "\nOutput:"), or null. */
function headerExitCode(text) {
    const outputAt = text.indexOf("\nOutput:");
    if (outputAt === -1)
        return null;
    const m = /Process exited with code (-?\d+)/.exec(text.slice(0, outputAt));
    return m === null ? null : Number(m[1]);
}
/** The process session number in a shell output's header ("Process running
 *  with session ID N"): the command was still running when the call
 *  returned. Null when the header has none. */
function headerRunningSession(text) {
    const outputAt = text.indexOf("\nOutput:");
    if (outputAt === -1)
        return null;
    const m = /Process running with session ID (\d+)/.exec(text.slice(0, outputAt));
    return m === null ? null : Number(m[1]);
}
/** A failed shell call's output as its error excerpt reads it: the header's
 *  exit line, then what the command printed. The rest of a shell header
 *  (chunk id, wall time, token count) filled most of the excerpt's start and
 *  pushed out the error a stack trace opens with. Other outputs as they are. */
function failedOutputText(text) {
    const outputAt = text.indexOf("\nOutput:");
    if (outputAt === -1)
        return text;
    const header = text.slice(0, outputAt).split("\n");
    if (!header.some((line) => line.startsWith("Wall time:")))
        return text;
    const exit = header.filter((line) => /^(?:Process exited with code|Exit code:)/.test(line));
    return [...exit, text.slice(outputAt + "\nOutput:".length).replace(/^\n/, "")].join("\n");
}
/** Whether a tool output reports the tool's own failure (its failure line),
 *  as opposed to the exit code of a process it looked at. */
function ownFailure(text) {
    return FAILED_OUTPUT_PREFIXES.some((prefix) => text.startsWith(prefix)) ? 1 : 0;
}
/** Whether a Codex tool output says the call failed. Codex puts no error
 *  flag on an output; these are the failure shapes its tools write. A shell
 *  command's exit code is read only from the header before "Output:", so a
 *  command that prints "Process exited with code 1" itself is not counted. */
function codexOutputError(text) {
    if (ownFailure(text) === 1)
        return 1;
    const exit = /^Exit code: (-?\d+)/.exec(text);
    if (exit !== null && Number(exit[1]) !== 0)
        return 1;
    const headerExit = headerExitCode(text);
    if (headerExit !== null && headerExit !== 0)
        return 1;
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed);
            const code = parsed?.metadata?.exit_code;
            if (typeof code === "number" && code !== 0)
                return 1;
        }
        catch {
            // Not JSON: no exit code to read.
        }
    }
    return 0;
}
// A PreToolUse block is the blocked call's output: Codex answers the call
// with "<prefix>{reason}<tail>{command or tool name}" (hook_runtime.rs).
const PRE_TOOL_USE_BLOCKS = [
    ["Command blocked by PreToolUse hook: ", ". Command: "],
    ["Tool call blocked by PreToolUse hook: ", ". Tool: "],
];
/** The reason of a PreToolUse block reported by a tool output (null when
 *  empty), or undefined when the output is not one. */
function preToolUseReason(text) {
    for (const [prefix, tail] of PRE_TOOL_USE_BLOCKS) {
        if (!text.startsWith(prefix))
            continue;
        const rest = text.slice(prefix.length);
        const end = rest.lastIndexOf(tail);
        const reason = (end === -1 ? rest : rest.slice(0, end)).trim();
        return reason === "" ? null : utf8SafeTruncate(reason, HOOK_REASON_BYTE_CAP).out;
    }
    return undefined;
}
/** The hook event a HookPrompt fragment came from, from its hookRunId
 *  ("stop:4:/…/hooks.json" gives Stop, "user_prompt_submit:…" gives
 *  UserPromptSubmit), or null when the id names none. */
function hookEventOf(runId) {
    const colon = runId.indexOf(":");
    if (colon <= 0)
        return null;
    return runId
        .slice(0, colon)
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join("");
}
/** Files a Codex shell command wrote, read off its text; a relative path
 *  resolves against its workdir, or else the session's cwd. */
function shellCommandFiles(cmd, workdir, batch) {
    try {
        return shellWrittenFiles(cmd, workdir, homedir());
    }
    catch {
        // A command the reader cannot handle loses its file list, not the rest
        // of the file.
        bumpAnomaly(batch, "shell_writes_error");
        return [];
    }
}
function detectToolError(result) {
    if (result === null || typeof result !== "object" || Array.isArray(result))
        return 0;
    const record = result;
    if (typeof record.Err === "string")
        return 1;
    if (record.isError === true)
        return 1;
    const ok = record.Ok;
    if (ok && typeof ok === "object" && !Array.isArray(ok)) {
        return ok.isError === true ? 1 : 0;
    }
    return 0;
}
function addDerivedToolRows(args) {
    const { event_uuid, session_id, ts, name, parsed, input } = args;
    if (input === null)
        return;
    if (FILE_OP_TOOLS.has(name)) {
        const path = typeof input.file_path === "string"
            ? input.file_path
            : typeof input.notebook_path === "string"
                ? input.notebook_path
                : null;
        if (path !== null) {
            parsed.file_ops.push({ event_uuid, session_id, ts, tool: name, path });
        }
    }
    if (name === "Skill") {
        const skill = typeof input.skill === "string" ? input.skill : "<missing>";
        const argsStr = typeof input.args === "string" ? input.args : JSON.stringify(input.args ?? "");
        parsed.skill_calls.push({
            event_uuid,
            session_id,
            ts,
            skill,
            args_excerpt: argsStr.slice(0, 256),
        });
    }
    if (name === "Agent") {
        const subagent_type = typeof input.subagent_type === "string" ? input.subagent_type : "<default>";
        const description = typeof input.description === "string" ? input.description : null;
        const promptStr = typeof input.prompt === "string" ? input.prompt : "";
        parsed.agent_calls.push({
            event_uuid,
            session_id,
            ts,
            subagent_type,
            description,
            prompt_excerpt: promptStr.slice(0, 256),
        });
    }
}
/** Re-serialize a stream of top-level JSON objects as JSONL, or null if it
 *  is not one. Tracks brace depth outside strings to find each object's end. */
function compactJsonStream(text) {
    const out = [];
    let depth = 0;
    let inString = false;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === "\\")
                i++;
            else if (c === '"')
                inString = false;
        }
        else if (c === '"') {
            inString = true;
        }
        else if (c === "{") {
            if (depth++ === 0)
                start = i;
        }
        else if (c === "}") {
            if (--depth === 0) {
                try {
                    out.push(JSON.stringify(JSON.parse(text.slice(start, i + 1))));
                }
                catch {
                    return null;
                }
            }
        }
    }
    return depth === 0 && out.length > 0 ? out.join("\n") + "\n" : null;
}
function parseLine(line) {
    if (line.length === 0)
        return null;
    try {
        const obj = JSON.parse(line);
        if (typeof obj.type !== "string" ||
            typeof obj.payload !== "object" ||
            obj.payload === null ||
            Array.isArray(obj.payload)) {
            return null;
        }
        return {
            timestamp: typeof obj.timestamp === "string" ? obj.timestamp : new Date(0).toISOString(),
            type: obj.type,
            payload: obj.payload,
            ordinal: typeof obj.ordinal === "number" ? obj.ordinal : null,
        };
    }
    catch {
        return null;
    }
}
/** Whether a line belongs to the copy of the parent's history that a
 *  subagent rollout from newer Codex starts with: from the parent's copied
 *  session_meta up to subagent_history_start_ordinal. The parent's own
 *  rollout holds those lines; read here they were stored twice, and the
 *  copied session_meta switched the rest of the file to the parent's
 *  session, so committing this file wiped the parent's rows. Older subagent
 *  rollouts carry the field too, counted in the parent's history and past
 *  the end of the file, with no copied session_meta: see inParentTurn. */
function inCopiedHistory(cl, state) {
    if (state.historyStart === null || cl.ordinal === null || cl.ordinal >= state.historyStart)
        return false;
    if (cl.type === "session_meta" && cl.payload.id !== state.session_id)
        state.inParentCopy = true;
    return state.inParentCopy;
}
/** The time a UUIDv7 carries, in ms; null for any other id. */
function uuidV7Ms(id) {
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id))
        return null;
    return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
/** Whether a line belongs to a parent turn that an older subagent rollout
 *  starts with, copied without a mark. Codex ids are UUIDv7, so a turn whose
 *  id is older than the thread's own began before the thread existed: it is
 *  the parent's, which the parent's rollout holds. A line belongs to the
 *  turn last named by a turn_id. */
function inParentTurn(cl, state) {
    if (state.kind !== "subagent" || state.createdMs === null)
        return false;
    const turn = uuidV7Ms(cl.payload.turn_id);
    if (turn !== null)
        state.inParentTurn = turn < state.createdMs;
    return state.inParentTurn;
}
function makeBlankEvent(uuid, session_id, ts, source_file) {
    return {
        uuid,
        session_id,
        parent_uuid: null,
        prompt_id: null,
        agent_id: null,
        is_sidechain: null,
        ts,
        role: null,
        model: null,
        in_tok: 0,
        out_tok: 0,
        cache_r: 0,
        cache_w: 0,
        text_len: 0,
        has_tool_use: 0,
        has_text: 0,
        has_tool_res: 0,
        user_turn_no: null,
        assistant_turn_no: null,
        source_file,
    };
}
function makeBlankParsed(event) {
    return {
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
}
export function parseCodexFileBody(args) {
    const { source_file, batch } = args;
    // A rollout that was pretty-printed (each JSON object spread over many
    // lines) yields nothing but parse errors line by line; read it as a
    // sequence of JSON values, one per line.
    const body = /^\{[ \t\r]*\n/.test(args.body) ? (compactJsonStream(args.body) ?? args.body) : args.body;
    const events = [];
    const state = {
        session_id: null,
        cwd: null,
        git_branch: null,
        version: null,
        model: null,
        currentTurnId: null,
        currentTurnStartTs: null,
        pendingInTok: 0,
        pendingCachedTok: 0,
        pendingOutTok: 0,
        openToolCalls: new Map(),
        callEvents: new Map(),
        openExec: new Map(),
        failedExec: new Set(),
        runningProcess: new Map(),
        stdinTarget: new Map(),
        openDirect: new Map(),
        namedCommands: new Set(),
        historyStart: null,
        inParentCopy: false,
        createdMs: null,
        inParentTurn: false,
        kind: null,
        parentId: null,
    };
    // tool_results map: call_id → { ts, is_error } — same shape as Claude parser
    const toolResults = new Map();
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
            const cl = parseLine(line);
            if (cl === null) {
                if (line.trim().length > 0)
                    bumpAnomaly(batch, "json_parse_error");
            }
            else if (inCopiedHistory(cl, state) || inParentTurn(cl, state)) {
                bumpAnomaly(batch, "copied_session_line_skipped");
            }
            else {
                processLine(cl, lineSeq, source_file, state, events, toolResults, batch);
                if (batch.session_id === null && state.session_id !== null) {
                    batch.session_id = state.session_id;
                }
            }
            fullyTerminated += 1;
            lastOk = i + 1;
            lineStartByte = i + 1;
        }
        i += 1;
    }
    const trailingNewline = lineStartByte === buf.byteLength;
    return {
        events,
        anomalies: batch,
        trailing_newline: trailingNewline,
        fully_terminated_line_count: fullyTerminated,
        last_ok_byte_offset: lastOk,
        tool_results: toolResults,
        session_meta: {
            cwd: state.cwd,
            git_branch: state.git_branch,
            version: state.version,
            kind: state.kind ?? undefined,
            parent_id: state.parentId ?? undefined,
        },
    };
}
function processLine(cl, seq, source_file, state, events, toolResults, batch) {
    const { type, payload, timestamp } = cl;
    const session_id = state.session_id ?? `codex-unknown:${source_file}`;
    // ── session_meta ──────────────────────────────────────────────────────────
    if (type === "session_meta") {
        // The first session_meta is the file's own thread.
        if (state.session_id === null) {
            if (typeof payload.id === "string")
                state.session_id = payload.id;
            state.createdMs = uuidV7Ms(payload.id);
            if (typeof payload.subagent_history_start_ordinal === "number") {
                state.historyStart = payload.subagent_history_start_ordinal;
            }
            // source is "cli" (the TUI), "vscode" (the editor extension), "exec"
            // (a one-shot codex exec or SDK run), or { subagent: … } for a thread
            // another agent spawned.
            const origin = payload.source;
            if (payload.thread_source === "subagent" || (typeof origin === "object" && origin !== null && "subagent" in origin)) {
                state.kind = "subagent";
                const spawn = origin?.subagent?.thread_spawn;
                if (typeof spawn?.parent_thread_id === "string")
                    state.parentId = spawn.parent_thread_id;
            }
            else if (origin === "exec") {
                state.kind = "exec";
            }
        }
        if (typeof payload.cwd === "string")
            state.cwd = payload.cwd;
        if (typeof payload.cli_version === "string")
            state.version = payload.cli_version;
        const git = payload.git;
        if (git && typeof git.branch === "string")
            state.git_branch = git.branch;
        return;
    }
    // ── turn_context — carries per-turn model ─────────────────────────────────
    if (type === "turn_context") {
        if (typeof payload.model === "string")
            state.model = payload.model;
        if (typeof payload.cwd === "string" && state.cwd === null)
            state.cwd = payload.cwd;
        return;
    }
    // ── compacted — one per compaction (payload.replacement_history is the
    //    history the thread goes on with) ─────────────────────────────────────
    if (type === "compacted") {
        const ev = makeBlankEvent(syntheticUuid(source_file, seq), session_id, timestamp, source_file);
        ev.role = "system";
        const parsed = makeBlankParsed(ev);
        parsed.system_reminders.push({ event_uuid: ev.uuid, session_id, ts: timestamp, category: "compaction", text_excerpt: null });
        events.push(parsed);
        return;
    }
    // ── response_item — current tool call encoding ────────────────────────────
    if (type === "response_item") {
        const itemType = typeof payload.type === "string" ? payload.type : null;
        if (itemType === "function_call" || itemType === "custom_tool_call") {
            const uuid = syntheticUuid(source_file, seq);
            const callId = typeof payload.call_id === "string" ? payload.call_id : null;
            if (callId !== null)
                state.openToolCalls.set(callId, timestamp);
            const name = typeof payload.name === "string" ? payload.name : "<unknown>";
            // A custom (freeform) tool such as apply_patch or exec carries its raw
            // text in `input` instead of JSON `arguments`.
            const args = itemType === "function_call" ? payload.arguments : payload.input;
            const rawArgs = typeof args === "string"
                ? args
                : args !== undefined
                    ? JSON.stringify(args)
                    : null;
            const cap = SHELL_TOOLS.has(name) ? SHELL_TOOL_INPUT_BYTE_CAP : TOOL_INPUT_BYTE_CAP;
            const input_json = rawArgs !== null ? truncateToolInput(rawArgs, batch, cap) : null;
            const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
            ev.role = "assistant";
            ev.model = state.model;
            ev.has_tool_use = 1;
            const parsed = makeBlankParsed(ev);
            parsed.tool_calls.push({
                event_uuid: uuid,
                session_id,
                ts: timestamp,
                call_id: callId,
                name,
                input_json,
                duration_ms: null,
                is_error: 0,
                result_chars: null,
            });
            const input = parseObjectLike(args);
            addDerivedToolRows({
                event_uuid: uuid,
                session_id,
                ts: timestamp,
                name,
                parsed,
                input,
            });
            // A patch (apply_patch, or exec code calling it) names each file it
            // edits in a "*** Update File:" style header. Read them from the whole
            // input: the stored copy may be cut (TOOL_INPUT_BYTE_CAP, or the shell
            // cap for exec code), which dropped the later files of a long patch.
            if (rawArgs !== null && rawArgs.includes("*** Begin Patch")) {
                for (const path of patchedFiles(rawArgs, state.cwd)) {
                    parsed.file_ops.push({ event_uuid: uuid, session_id, ts: timestamp, tool: "apply_patch", path });
                }
            }
            // The files a shell command wrote, read off the whole command like a
            // Claude Code Bash call's (claude_parser.ts): the stored input may be cut.
            if (name === "exec_command" && input !== null && typeof input.cmd === "string") {
                const workdir = typeof input.workdir === "string" ? input.workdir : state.cwd;
                for (const path of shellCommandFiles(input.cmd, workdir, batch)) {
                    parsed.file_ops.push({ event_uuid: uuid, session_id, ts: timestamp, tool: "exec_command", path });
                }
            }
            // exec code runs shell commands through tools.exec_command, each a
            // string literal in the code; read the whole code, not the cut copy.
            if (name === "exec" && rawArgs !== null) {
                const { commands, built } = execCodeScan(rawArgs);
                for (const { cmd, workdir } of commands) {
                    for (const path of shellCommandFiles(cmd, workdir ?? state.cwd, batch)) {
                        parsed.file_ops.push({ event_uuid: uuid, session_id, ts: timestamp, tool: "exec_command", path });
                    }
                }
                if (callId !== null)
                    state.openExec.set(callId, { commands: new Set(commands.map((c) => c.cmd)), built: built > 0 });
                for (const { cmd } of commands)
                    state.namedCommands.add(cmd);
            }
            if (name === "exec_command" && typeof input?.cmd === "string")
                state.namedCommands.add(input.cmd);
            if (callId !== null) {
                state.callEvents.set(callId, parsed);
                if (name === "exec_command" && typeof input?.cmd === "string")
                    state.openDirect.set(callId, input.cmd);
                if (name === "write_stdin" && typeof input?.session_id === "number")
                    state.stdinTarget.set(callId, input.session_id);
            }
            events.push(parsed);
        }
        else if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
            const callId = typeof payload.call_id === "string" ? payload.call_id : null;
            if (callId !== null) {
                const text = codexOutputText(payload.output);
                // exec code says "Script completed" even when a command it ran
                // failed; Codex reported that failure while the call was open.
                const commandFailed = state.failedExec.delete(callId);
                state.openExec.delete(callId);
                state.openDirect.delete(callId);
                let is_error = commandFailed ? 1 : codexOutputError(text);
                const call = state.callEvents.get(callId);
                const callName = call?.tool_calls[0]?.name;
                // A command still running when exec_command returned reports its
                // exit through a later write_stdin naming the same process session:
                // the exit is the exec_command call's, not the write_stdin call's.
                const running = headerRunningSession(text);
                if (callName === "exec_command" && running !== null && headerExitCode(text) === null) {
                    state.runningProcess.set(running, callId);
                }
                const target = state.stdinTarget.get(callId);
                const exit = headerExitCode(text);
                const origin = target === undefined ? undefined : state.runningProcess.get(target);
                if (target !== undefined && exit !== null && origin !== undefined) {
                    state.runningProcess.delete(target);
                    const started = toolResults.get(origin);
                    if (exit !== 0 && started !== undefined) {
                        toolResults.set(origin, { ...started, is_error: 1, error_excerpt: errorExcerpt(failedOutputText(text)) });
                    }
                    is_error = ownFailure(text);
                }
                state.stdinTarget.delete(callId);
                toolResults.set(callId, {
                    ts: timestamp,
                    is_error,
                    result_chars: codepointLength(text),
                    error_excerpt: is_error === 1 ? errorExcerpt(failedOutputText(text)) : null,
                });
                state.openToolCalls.delete(callId);
                // Recorded on the call's own event: the driver reads a whole rollout
                // on every change, so the call and its output are parsed together.
                const reason = preToolUseReason(text);
                if (reason !== undefined && call !== undefined) {
                    call.hook_blocks.push({
                        event_uuid: call.event.uuid,
                        session_id,
                        ts: timestamp,
                        hook_event: "PreToolUse",
                        tool: call.tool_calls[0]?.name ?? null,
                        call_id: callId,
                        reason,
                    });
                }
            }
        }
        return;
    }
    // ── event_msg — all the interesting stuff ─────────────────────────────────
    if (type !== "event_msg")
        return;
    const msgType = typeof payload.type === "string" ? payload.type : null;
    if (msgType === null)
        return;
    const uuid = syntheticUuid(source_file, seq);
    // task_started / turn_started
    if (msgType === "task_started" || msgType === "turn_started") {
        const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
        state.currentTurnId = turnId;
        state.currentTurnStartTs = timestamp;
        state.pendingInTok = 0;
        state.pendingCachedTok = 0;
        state.pendingOutTok = 0;
        return;
    }
    // task_complete / turn_complete — emit one event row with accumulated tokens
    if (msgType === "task_complete" || msgType === "turn_complete") {
        const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
        ev.role = "assistant";
        ev.model = state.model;
        ev.in_tok = state.pendingInTok;
        ev.cache_r = state.pendingCachedTok;
        ev.out_tok = state.pendingOutTok;
        state.pendingInTok = 0;
        state.pendingCachedTok = 0;
        state.pendingOutTok = 0;
        state.currentTurnId = null;
        state.currentTurnStartTs = null;
        const parsed = makeBlankParsed(ev);
        events.push(parsed);
        return;
    }
    // token_count — a turn emits one of these per model round-trip. input/
    // cached_input are running snapshots of the turn's context so far (the
    // latest one already includes everything before it) — take the latest,
    // don't sum, or a turn with N round-trips inflates its context by ~Nx.
    // output_tokens is genuinely incremental generation per round-trip, so
    // that one does accumulate.
    if (msgType === "token_count") {
        const info = payload.info;
        if (info) {
            const last = info.last_token_usage;
            if (last) {
                if (typeof last.input_tokens === "number")
                    state.pendingInTok = last.input_tokens;
                if (typeof last.cached_input_tokens === "number")
                    state.pendingCachedTok = last.cached_input_tokens;
                if (typeof last.output_tokens === "number")
                    state.pendingOutTok += last.output_tokens;
            }
        }
        return;
    }
    // user_message / agent_message — the older chat encoding
    if (msgType === "user_message" || msgType === "agent_message") {
        const text = typeof payload.message === "string" ? payload.message : null;
        if (msgType === "user_message")
            pushUserMessage(events, uuid, session_id, timestamp, source_file, text);
        else
            pushAgentMessage(events, uuid, session_id, timestamp, source_file, state.model, text);
        return;
    }
    // item_completed — the current chat encoding: every rollout file on disk
    // holds its chat text only here. A HookPrompt is what a hook that kept
    // Codex going (a Stop hook's block) told it; a CommandExecution adds to the
    // exec call that ran its command (readCommandExecution); a McpToolCall may
    // be an MCP call exec code made (pushExecMcpCall). Other item types
    // (FileChange, …) are not read from this line.
    if (msgType === "item_completed") {
        const item = payload.item;
        const text = item ? itemText(item) : null;
        if (item?.type === "UserMessage")
            pushUserMessage(events, uuid, session_id, timestamp, source_file, text);
        else if (item?.type === "AgentMessage")
            pushAgentMessage(events, uuid, session_id, timestamp, source_file, state.model, text);
        else if (item?.type === "HookPrompt")
            pushHookPrompt(events, uuid, session_id, timestamp, source_file, item);
        else if (item?.type === "CommandExecution")
            readCommandExecution(item, state, batch);
        else if (item?.type === "McpToolCall")
            pushExecMcpCall(events, uuid, session_id, timestamp, source_file, item, state, batch);
        return;
    }
    // mcp_tool_call_begin
    if (msgType === "mcp_tool_call_begin") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : null;
        if (callId !== null)
            state.openToolCalls.set(callId, timestamp);
        const invocation = payload.invocation;
        const toolName = invocation && typeof invocation.tool === "string"
            ? invocation.tool
            : "<unknown>";
        const inputRaw = invocation?.arguments !== undefined
            ? JSON.stringify(invocation.arguments)
            : null;
        const input_json = inputRaw !== null ? truncateToolInput(inputRaw, batch) : null;
        const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
        ev.role = "assistant";
        ev.has_tool_use = 1;
        const parsed = makeBlankParsed(ev);
        const toolCall = {
            event_uuid: uuid,
            session_id,
            ts: timestamp,
            call_id: callId,
            name: toolName,
            input_json,
            duration_ms: null,
            is_error: 0,
            result_chars: null,
        };
        parsed.tool_calls.push(toolCall);
        events.push(parsed);
        return;
    }
    // mcp_tool_call_end
    if (msgType === "mcp_tool_call_end") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : null;
        const isError = detectToolError(payload.result);
        if (callId !== null) {
            toolResults.set(callId, { ts: timestamp, is_error: isError, result_chars: null, error_excerpt: null });
            state.openToolCalls.delete(callId);
        }
        return;
    }
    // exec_command_begin — shell commands as tool calls (tool name = "exec")
    if (msgType === "exec_command_begin") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : null;
        if (callId !== null)
            state.openToolCalls.set(callId, timestamp);
        const cmd = Array.isArray(payload.command)
            ? payload.command.join(" ")
            : typeof payload.command === "string"
                ? payload.command
                : null;
        const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
        ev.role = "assistant";
        ev.has_tool_use = 1;
        const parsed = makeBlankParsed(ev);
        const toolCall = {
            event_uuid: uuid,
            session_id,
            ts: timestamp,
            call_id: callId,
            name: "exec",
            input_json: cmd !== null ? truncateToolInput(cmd, batch, SHELL_TOOL_INPUT_BYTE_CAP) : null,
            duration_ms: null,
            is_error: 0,
            result_chars: null,
        };
        parsed.tool_calls.push(toolCall);
        events.push(parsed);
        return;
    }
    // exec_command_end
    if (msgType === "exec_command_end") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : null;
        const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : 0;
        const isError = exitCode !== 0 ? 1 : 0;
        if (callId !== null) {
            toolResults.set(callId, { ts: timestamp, is_error: isError, result_chars: null, error_excerpt: null });
            state.openToolCalls.delete(callId);
        }
        return;
    }
}
/** The text parts of an item_completed chat item, one per paragraph. User
 *  parts are "text", assistant parts "Text"; images and skill parts carry no
 *  text. */
function itemText(item) {
    if (!Array.isArray(item.content))
        return null;
    const parts = [];
    for (const part of item.content) {
        if (part === null || typeof part !== "object")
            continue;
        const p = part;
        if ((p.type === "text" || p.type === "Text") && typeof p.text === "string")
            parts.push(p.text);
    }
    return parts.length > 0 ? parts.join("\n") : null;
}
function pushUserMessage(events, uuid, session_id, timestamp, source_file, text) {
    if (text === null || text.trim().length === 0)
        return;
    const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
    ev.role = "user";
    ev.has_text = 1;
    ev.text_len = [...text].length;
    const parsed = makeBlankParsed(ev);
    const userText = {
        event_uuid: uuid,
        session_id,
        ts: timestamp,
        text,
        is_command: 0,
        role: "user",
        type: "user_message",
    };
    parsed.user_texts.push(userText);
    for (const skill of extractSkillCandidates(text)) {
        parsed.skill_calls.push({ event_uuid: uuid, session_id, ts: timestamp, skill, args_excerpt: null });
    }
    events.push(parsed);
}
/** What a CommandExecution item adds to the open exec call that ran its
 *  command. For a command the call's code names as a literal, only a
 *  nonzero exit (the code already gave its files). For a command the code
 *  built at run time, its written files and its exit, but only while exactly
 *  one exec call is open and its code builds a cmd, so the item cannot go
 *  to the wrong call. An item
 *  of a direct exec_command call, which has its own record, or of the
 *  user's own shell is not read. Neither is an item whose command an
 *  earlier call named: it comes when the command ends, so a call that
 *  returned while its command still ran gets it later, maybe while another
 *  exec call is open. Not every Codex version writes these items,
 *  and most of them repeat a direct call, so they are never a source on
 *  their own. */
function readCommandExecution(item, state, batch) {
    if (item.source === "user_shell")
        return;
    const command = Array.isArray(item.command) ? item.command[item.command.length - 1] : item.command;
    if (typeof command !== "string")
        return;
    for (const cmd of state.openDirect.values())
        if (cmd === command)
            return;
    const failed = typeof item.exit_code === "number" && item.exit_code !== 0;
    const naming = [...state.openExec].filter(([, open]) => open.commands.has(command)).map(([callId]) => callId);
    if (naming.length > 0) {
        if (failed)
            for (const callId of naming)
                state.failedExec.add(callId);
        return;
    }
    if (state.namedCommands.has(command))
        return;
    const only = state.openExec.size === 1 ? [...state.openExec][0] : undefined;
    if (only === undefined || !only[1].built)
        return;
    const callId = only[0];
    const call = state.callEvents.get(callId);
    if (call === undefined)
        return;
    const { uuid, session_id, ts } = call.event;
    for (const path of shellCommandFiles(command, cwdOf(item.cwd) ?? state.cwd, batch)) {
        call.file_ops.push({ event_uuid: uuid, session_id, ts, tool: "exec_command", path });
    }
    if (failed)
        state.failedExec.add(callId);
}
/** An MCP call that exec code made (`tools.mcp__clens__clens_search(…)`):
 *  Codex records it only as a McpToolCall item, whose id starts with
 *  "exec-", so it becomes a tool call of its own, named as the code calls it
 *  (a name keeps letters, digits and "_", so server "context-mode" is
 *  mcp__context_mode__…). Codex reports a direct MCP call this way too, under
 *  that call's own id; the call already has its record, and so does a
 *  subagent's copy of a parent's call, so other ids are skipped. Its result
 *  went to the code, not the conversation, so it adds no output characters:
 *  the exec call's output holds them. */
function pushExecMcpCall(events, uuid, session_id, timestamp, source_file, item, state, batch) {
    const id = item.id;
    if (typeof id !== "string" || !id.startsWith("exec-"))
        return;
    if (typeof item.server !== "string" || typeof item.tool !== "string")
        return;
    const ident = (s) => s.replace(/[^A-Za-z0-9_]/g, "_");
    const result = item.result;
    const failed = item.status === "failed" ||
        (result !== null && typeof result === "object" && result.isError === true);
    const d = item.duration;
    const raw = item.arguments !== undefined ? JSON.stringify(item.arguments) : null;
    const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
    ev.role = "assistant";
    ev.model = state.model;
    ev.has_tool_use = 1;
    const parsed = makeBlankParsed(ev);
    parsed.tool_calls.push({
        event_uuid: uuid,
        session_id,
        ts: timestamp,
        call_id: id,
        name: `mcp__${ident(item.server)}__${ident(item.tool)}`,
        input_json: raw !== null ? truncateToolInput(raw, batch) : null,
        duration_ms: typeof d?.secs === "number" && typeof d.nanos === "number" ? Math.round(d.secs * 1000 + d.nanos / 1e6) : null,
        is_error: failed ? 1 : 0,
        result_chars: null,
    });
    events.push(parsed);
}
/** A CommandExecution item's cwd, a file:// URL, as a path; null when it is
 *  not one. */
function cwdOf(value) {
    if (typeof value !== "string" || value === "")
        return null;
    if (value.startsWith("file://")) {
        try {
            return fileURLToPath(value);
        }
        catch {
            return null;
        }
    }
    return isAbsolute(value) ? value : null;
}
/** One hook block per fragment of a HookPrompt item, each from the hook its
 *  hookRunId names; no tool or call id, like a Claude Code Stop block. */
function pushHookPrompt(events, uuid, session_id, timestamp, source_file, item) {
    if (!Array.isArray(item.fragments))
        return;
    const parsed = makeBlankParsed(makeBlankEvent(uuid, session_id, timestamp, source_file));
    for (const fragment of item.fragments) {
        if (fragment === null || typeof fragment !== "object")
            continue;
        const { text, hookRunId } = fragment;
        if (typeof text !== "string" || typeof hookRunId !== "string")
            continue;
        const hook_event = hookEventOf(hookRunId);
        if (hook_event === null)
            continue;
        const reason = text.trim();
        parsed.hook_blocks.push({
            event_uuid: uuid,
            session_id,
            ts: timestamp,
            hook_event,
            tool: null,
            call_id: null,
            reason: reason === "" ? null : utf8SafeTruncate(reason, HOOK_REASON_BYTE_CAP).out,
        });
    }
    if (parsed.hook_blocks.length > 0)
        events.push(parsed);
}
function pushAgentMessage(events, uuid, session_id, timestamp, source_file, model, text) {
    if (text === null || text.trim().length === 0)
        return;
    const ev = makeBlankEvent(uuid, session_id, timestamp, source_file);
    ev.role = "assistant";
    ev.model = model;
    ev.has_text = 1;
    ev.text_len = [...text].length;
    const parsed = makeBlankParsed(ev);
    const { out: clipped } = utf8SafeHeadTailTruncate(text, ASSISTANT_TEXT_BYTE_CAP);
    const assistantText = {
        event_uuid: uuid,
        session_id,
        ts: timestamp,
        text: clipped,
        is_command: 0,
        role: "assistant",
        type: "assistant_message",
    };
    parsed.user_texts.push(assistantText);
    events.push(parsed);
}
//# sourceMappingURL=codex_parser.js.map