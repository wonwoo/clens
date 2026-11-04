/**
 * clens_left_off with file and text: the sessions whose edits of a file wrote
 * a piece of its text, for "why is this code like this". An edit's stored
 * input holds the text it put in the file (an Edit's new_string, a Write's
 * content, a patch's + lines), so the session that wrote a line is found
 * without git, whose history a squash or a rebase rewrites.
 *
 * The reason is rarely at the edit itself, which sits among progress notes.
 * It is in the request that started the turn or, when that request is a
 * go-ahead ("do it"), in the reply just before it: the proposal the user
 * said yes to. Each session comes with both.
 */
import type Database from "better-sqlite3";

import { notCopiedClause, TOP } from "../analyzer/scope.js";
import { type LeftOffParams, REAL_MESSAGE, REPLY_CHARS, REQUEST_CHARS } from "./left_off.js";
import { cutChars } from "./search.js";

/** One edit that wrote the text, with the turn it was made in. */
export interface LineTurn {
  edited_at: string;
  /** The tool_call name: Edit, Write, NotebookEdit, apply_patch or exec. */
  tool: string;
  /** The real user message at or before edited_at in the session, cut to REQUEST_CHARS. */
  request: { ts: string; text: string } | null;
  /** The real assistant message before request.ts in the session, cut to
   *  REPLY_CHARS: what the user answered. */
  reply_before: { ts: string; text: string } | null;
}

/** A session that wrote the text, at its first edit that did. */
export interface LineOrigin extends LineTurn {
  /** The session at the top of the tree: a subagent's edit is its parent's. */
  session_id: string;
  project_id: string | null;
  source: string;
  /** The session's last edit that wrote the text, when it was made in a later
   *  turn than the first. Either can hold the reason: the later one when the
   *  first attempt was rolled back and the text written again, the first when
   *  later work only carried the text along. */
  last: LineTurn | null;
}

/** As clens_left_off's list. */
const DEFAULT_LIMIT = 3;

/** Where an edit call's JSON input holds the text it put in the file. */
const NEW_TEXT_KEY: Record<string, string> = {
  Edit: '"new_string":',
  Write: '"content":',
  NotebookEdit: '"new_source":',
};

// A patch header's path runs to the end of its line; inside exec code the
// line ends at an escaped newline or the quote (as codex_parser.ts reads it).
const PATCH_HEADER = /^\*\*\* (?:Update File|Add File|Delete File|Move to): ([^\n\r\\"'`]+)/;
const PATCH_END = "*** End Patch";

/** `s` as it stands inside a JSON string. */
const escaped = (s: string) => JSON.stringify(s).slice(1, -1);

/** The + lines of a patch under the header naming `path` (the path itself or
 *  its tail, as a relative header names it). A raw patch ends its lines only
 *  at line breaks, since its code can hold the two characters \n itself. In
 *  Codex exec code the patch is a string literal (`inLiteral`), so a line also
 *  ends at a \n with no backslash before it; the code's own \n reads \\n. */
function addedLines(input: string, path: string, inLiteral: boolean): string[] {
  const out: string[] = [];
  let mine = false;
  for (const line of input.split(inLiteral ? /\r?\n|(?<!\\)\\n/ : /\r?\n/)) {
    const header = PATCH_HEADER.exec(line);
    if (header) {
      const named = header[1]!.trim().replace(/^\.\//, "");
      mine = named === path || path.endsWith(`/${named}`);
    } else if (line.startsWith(PATCH_END)) {
      mine = false;
    } else if (mine && line.startsWith("+")) {
      out.push(line);
    }
  }
  return out;
}

/** Whether the edit put every one of `lines` in the file at `path`, rather
 *  than only quoting it as the text it replaced. */
function wrote(name: string, input: string, path: string, lines: string[]): boolean {
  const key = NEW_TEXT_KEY[name];
  if (key !== undefined) {
    const at = input.indexOf(key);
    return at >= 0 && lines.every((l) => input.indexOf(escaped(l), at) >= 0);
  }
  const added = addedLines(input, path, name === "exec");
  return lines.every((l) => added.some((a) => a.includes(l) || a.includes(escaped(l))));
}

/** The sessions whose edits of `file` wrote `text`, each once at its first
 *  such edit (with its last one when that was in a later turn), oldest
 *  first: the first is where the text came from, later ones rewrote or moved
 *  it. `text` is one line or a few, each trimmed; all
 *  must be in one edit. `file` is a path or its tail, as clens_left_off's
 *  file. Any session kind counts, as for commitSessions: a one-shot run that
 *  wrote code is still where it came from. */
export function lineOrigins(
  db: Database.Database,
  file: string,
  text: string,
  params: Pick<LeftOffParams, "project_id" | "since" | "until" | "limit">,
): LineOrigin[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return [];
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
  const tail = file.replace(/^\.\//, "");
  const like = "%/" + tail.replace(/[\\%_]/g, (c) => "\\" + c);
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (params.project_id) {
    conditions.push("s.project_id = ?");
    bindings.push(params.project_id);
  }
  if (params.since) {
    conditions.push("t.ts >= ?");
    bindings.push(params.since);
  }
  if (params.until) {
    conditions.push("t.ts <= ?");
    bindings.push(params.until);
  }
  // In the index no event holds more than one edit call; a patch that edits
  // several files has a file_op row for each, told apart by its headers.
  const rows = db.prepare(`
    ${TOP}
    SELECT top.root AS session_id, s.project_id, s.source, t.ts, t.name, t.input_json, f.path
    FROM file_op f
    JOIN tool_call t ON t.event_uuid = f.event_uuid AND t.session_id = f.session_id
    JOIN top ON top.id = t.session_id
    JOIN session s ON s.id = top.root
    WHERE f.tool IN ('Edit', 'Write', 'NotebookEdit', 'apply_patch')
      AND (f.path = ? OR f.path LIKE ? ESCAPE '\\')
      AND t.name IN ('Edit', 'Write', 'NotebookEdit', 'apply_patch', 'exec')
      AND (instr(t.input_json, ?) > 0 OR instr(t.input_json, ?) > 0)
      AND ${notCopiedClause("t.event_uuid", "t.session_id")}
      ${conditions.map((c) => `AND ${c}`).join(" ")}
    ORDER BY t.ts`).all(file, like, longest, escaped(longest), ...bindings) as {
    session_id: string; project_id: string | null; source: string; ts: string; name: string; input_json: string; path: string;
  }[];

  // Each session's first and last edit that wrote the text, in the order of
  // their first; rows come oldest first.
  const bySession = new Map<string, { first: (typeof rows)[number]; last: (typeof rows)[number] }>();
  for (const row of rows) {
    if (!wrote(row.name, row.input_json, row.path, lines)) continue;
    const seen = bySession.get(row.session_id);
    if (seen) seen.last = row;
    else bySession.set(row.session_id, { first: row, last: row });
  }

  const request = db.prepare(`SELECT u.ts, u.text FROM user_text u
    WHERE u.session_id = ? AND u.role = 'user' AND ${REAL_MESSAGE("u")} AND u.ts <= ?
    ORDER BY u.ts DESC LIMIT 1`);
  const replyBefore = db.prepare(`SELECT u.ts, u.text FROM user_text u
    WHERE u.session_id = ? AND u.role = 'assistant' AND ${REAL_MESSAGE("u")} AND u.ts < ?
    ORDER BY u.ts DESC LIMIT 1`);
  const turnOf = (row: (typeof rows)[number]): LineTurn => {
    const req = request.get(row.session_id, row.ts) as { ts: string; text: string } | undefined;
    const reply = req ? (replyBefore.get(row.session_id, req.ts) as { ts: string; text: string } | undefined) : undefined;
    return {
      edited_at: row.ts,
      tool: row.name,
      request: req ? { ts: req.ts, text: cutChars(req.text, REQUEST_CHARS) } : null,
      reply_before: reply ? { ts: reply.ts, text: cutChars(reply.text, REPLY_CHARS) } : null,
    };
  };
  return [...bySession.values()].slice(0, params.limit ?? DEFAULT_LIMIT).map(({ first, last }) => {
    const firstTurn = turnOf(first);
    const lastTurn = last === first ? null : turnOf(last);
    return {
      session_id: first.session_id,
      project_id: first.project_id,
      source: first.source,
      ...firstTurn,
      last: lastTurn && lastTurn.request?.ts !== firstTurn.request?.ts ? lastTurn : null,
    };
  });
}

export function formatLineOrigins(file: string, origins: LineOrigin[]): string {
  const name = JSON.stringify(file);
  if (origins.length === 0) {
    return `${name}: no stored edit wrote this text. Edits are stored up to 2 KB, and text written by shell commands is not matched; git blame and the commits parameter may find the commit's session.`;
  }
  const head = origins.length === 1
    ? `${name}: 1 session wrote this text`
    : `${name}: ${origins.length} sessions wrote this text, the first first`;
  const turn = (t: LineTurn, indent: string) => [
    ...(t.request ? [`${indent}request ${t.request.ts}: ${t.request.text}`] : []),
    ...(t.reply_before ? [`${indent}reply before it ${t.reply_before.ts}: ${t.reply_before.text}`] : []),
  ];
  return [
    head,
    ...origins.flatMap((o) => [
      `${o.edited_at}  session:${o.session_id}  project:${o.project_id ?? "?"}  ${o.source}  ${o.tool}`,
      ...turn(o, "  "),
      ...(o.last ? [`  written again ${o.last.edited_at}  ${o.last.tool}`, ...turn(o.last, "    ")] : []),
    ]),
  ].join("\n");
}
