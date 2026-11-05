/**
 * clens_session — fetch conversation context around a known session + timestamp.
 *
 * Returns user/assistant messages from the given session ordered by ts,
 * using two index-range queries (before + after around_ts) instead of
 * loading the full session into memory.
 */

import type Database from "better-sqlite3";

import { localTs } from "../util/time.js";

export interface SessionParams {
  session_id: string;
  around_ts: string;
  limit?: number;
  /** Return long messages whole instead of cutting their middle. */
  full?: boolean;
}

export interface SessionMessage {
  role: "user" | "assistant";
  ts: string;
  text: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;
/** A message longer than this (a pasted log, a long prompt; no stored
 *  assistant reply is) keeps KEPT_END_CHARS at each end unless `full` is set,
 *  so one pasted log does not fill the caller's context. */
const LONG_MESSAGE_CHARS = 20_000;
const KEPT_END_CHARS = 5_000;

// The type fixes the role: a user_message row is the user's, an
// assistant_message row the assistant's.
const ROLE_FILTER = "type IN ('user_message', 'assistant_message')";

export function sessionContext(db: Database.Database, params: SessionParams): SessionMessage[] {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const half = Math.ceil(limit / 2);

  // Before: messages up to and including around_ts, newest first
  const before = db.prepare(`
    SELECT role, ts, text FROM user_text
    WHERE session_id = ? AND ts <= ? AND ${ROLE_FILTER}
    ORDER BY ts DESC
    LIMIT ?
  `).all(params.session_id, params.around_ts, half) as SessionMessage[];

  // After: messages strictly after around_ts, oldest first
  const after = db.prepare(`
    SELECT role, ts, text FROM user_text
    WHERE session_id = ? AND ts > ? AND ${ROLE_FILTER}
    ORDER BY ts ASC
    LIMIT ?
  `).all(params.session_id, params.around_ts, limit - before.length) as SessionMessage[];

  // Reverse before (was DESC) and concatenate
  const messages = [...before.reverse(), ...after];
  return params.full ? messages : messages.map((m) => ({ ...m, text: cutMiddle(m.text) }));
}

/** clens_session's answer: each message numbered, with its role and time. */
export function formatSessionMessages(messages: SessionMessage[]): string {
  return messages.map((m, i) => `[${i + 1}] ${m.role.toUpperCase()} ${localTs(m.ts)}\n${m.text}`).join("\n\n");
}

/** `text` with its middle cut when it is over LONG_MESSAGE_CHARS characters
 *  (code points), marked with the number of characters cut. */
function cutMiddle(text: string): string {
  if (text.length <= LONG_MESSAGE_CHARS) return text; // code points never outnumber UTF-16 units
  const chars = Array.from(text);
  if (chars.length <= LONG_MESSAGE_CHARS) return text;
  const cut = chars.length - 2 * KEPT_END_CHARS;
  return (
    chars.slice(0, KEPT_END_CHARS).join("") +
    `\n…[${cut} chars cut; full: true returns the whole message]…\n` +
    chars.slice(-KEPT_END_CHARS).join("")
  );
}

/** Up to `n` messages on each side of `ts` in a session, both lists in
 *  conversation order. Messages at `ts` itself are the hit, not its context. */
export function neighborsOf(
  db: Database.Database,
  session_id: string,
  ts: string,
  n: number,
): { before: SessionMessage[]; after: SessionMessage[] } {
  const before = db.prepare(`
    SELECT role, ts, text FROM user_text
    WHERE session_id = ? AND ts < ? AND ${ROLE_FILTER}
    ORDER BY ts DESC
    LIMIT ?
  `).all(session_id, ts, n) as SessionMessage[];
  const after = db.prepare(`
    SELECT role, ts, text FROM user_text
    WHERE session_id = ? AND ts > ? AND ${ROLE_FILTER}
    ORDER BY ts ASC
    LIMIT ?
  `).all(session_id, ts, n) as SessionMessage[];
  return { before: before.reverse(), after };
}
