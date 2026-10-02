/**
 * Which session "current" means: the conversation that is calling this MCP
 * server. Claude Code is found through its per-process sessions file or
 * CLAUDE_CODE_SESSION_ID (detectCurrentSessionId); Codex names its thread in
 * the _meta of every tool call, under x-codex-turn-metadata
 * (codexSessionFromMeta).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir } from "../util/paths.js";
export const CURRENT_SESSION = "current";
/** `value` unchanged unless it is "current", which becomes
 *  `currentSessionId`, or an error when that is unknown. */
export function resolveSessionId(value, currentSessionId) {
    if (value !== CURRENT_SESSION)
        return { ok: true, id: value };
    if (currentSessionId)
        return { ok: true, id: currentSessionId };
    return {
        ok: false,
        error: 'session_id "current" is not available here: this client does not tell clens which session it is. Pass an explicit session_id, for example one from a clens_search or clens_left_off result.',
    };
}
/**
 * The Codex thread a tool call came from. Codex sends every MCP tool call a
 * _meta whose x-codex-turn-metadata holds session_id and thread_id. The
 * thread is the id clens stores for a Codex session; session_id is the root
 * session's, which in a subagent is its parent's. Never throws.
 */
export function codexSessionFromMeta(meta) {
    if (typeof meta !== "object" || meta === null)
        return undefined;
    const turn = meta["x-codex-turn-metadata"];
    if (typeof turn !== "object" || turn === null)
        return undefined;
    const { thread_id: threadId, session_id: sessionId } = turn;
    if (typeof threadId === "string" && threadId.length > 0)
        return threadId;
    if (typeof sessionId === "string" && sessionId.length > 0)
        return sessionId;
    return undefined;
}
/**
 * The session the Claude Code process `pid` is in now. Claude Code keeps an
 * undocumented per-process file, ~/.claude/sessions/<pid>.json, whose
 * sessionId follows /clear; CLAUDE_CODE_SESSION_ID, set when the server
 * started, does not (measured 2026-09-28: /clear starts a new session but
 * does not restart MCP servers). Without the file (Codex, a wrapper process
 * between claude and this server, or a Claude Code release without it) the
 * env value is today's behavior, right until the first /clear.
 *
 * Reads only <pid>.json: the directory also holds *.key files, which must
 * never be opened. Never throws. Call it per request: the file changes while
 * this server keeps running.
 */
export function detectCurrentSessionId(pid, env) {
    try {
        const parsed = JSON.parse(readFileSync(join(sessionsDir(), `${pid}.json`), "utf8"));
        if (typeof parsed === "object" && parsed !== null) {
            const { sessionId, pid: filePid } = parsed;
            if (typeof sessionId === "string" && sessionId.length > 0 && filePid === pid)
                return sessionId;
        }
    }
    catch {
        // No file, unreadable or not JSON: fall back to the env value.
    }
    const fromEnv = env.CLAUDE_CODE_SESSION_ID;
    return fromEnv ? fromEnv : undefined;
}
//# sourceMappingURL=current_session.js.map