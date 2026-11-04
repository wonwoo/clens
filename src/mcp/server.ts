/**
 * clens MCP server — stdio transport.
 *
 * Tools exposed:
 *   clens_search   — FTS5 full-text search over past messages, one or several queries
 *   clens_recent   — recent messages by date/project, with an optional LIKE keyword filter
 *   clens_session  — the conversation around one message
 *   clens_left_off — where work stopped: a project's or file's latest sessions, one session's work record, or a branch's checks
 *   clens_stats    — aggregate usage stats for a session, a project or every project
 *                    (tools/skills/agents/health/timeline/files, hook blocks, tool output size)
 *   clens_hold     — record in the ledger (~/.clens/ledger.jsonl) an item the user set aside, or change one
 *   clens_pending  — list the ledger: held, dropped and done items
 *
 * Register in .mcp.json:
 *   {
 *     "mcpServers": {
 *       "clens": {
 *         "type": "stdio",
 *         "command": "node",
 *         "args": ["/path/to/clens/dist/mcp/server.js"]
 *       }
 *     }
 *   }
 */

import { existsSync } from "node:fs";

import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { indexDbPath, ledgerPath, watchLockPath } from "../util/paths.js";
import { startWatch, type WatchHandle } from "../indexer/watch.js";
import { acquireLock } from "../indexer/driver.js";
import { ensureLanguageAdaptersLoaded } from "../indexer/lang/init.js";
import { searchText, searchManyText, queryTerms, DEFAULT_SEARCH_MAX_BYTES } from "./search.js";
import { searchAnalyzers, serveAnalyzers } from "./analyzers.js";
import { recentUserText, formatResults, DEFAULT_RECENT_MAX_BYTES } from "./recent.js";
import { sessionContext } from "./session.js";
import {
  leftOffWithMore, formatLeftOff, sessionRecord, formatSessionRecord, commitSessions, formatCommitSessions,
} from "./left_off.js";
import { branchChecks, branchParamsError, formatBranchChecks, formatRecentBranches, recentBranches } from "./checks.js";
import { formatLineOrigins, lineOrigins } from "./line_origin.js";
import {
  HOLD_DESCRIPTION, PENDING_DESCRIPTION, SEARCH_DESCRIPTION, SERVER_INSTRUCTIONS, STATS_DESCRIPTION,
} from "./instructions.js";
import { formatPending, HOLD_STATUSES, readLedger, recordHold } from "./ledger.js";
import { formatStats, projectStats, STATS_SECTIONS } from "./stats.js";
import { codexSessionFromMeta, detectCurrentSessionId, resolveSessionId } from "./current_session.js";

// Strict: a key a tool does not take is an error, not dropped without a word.
// Agents passed `ts` for around_ts and `project` for project_id; the dropped
// `project` turned a one-project clens_left_off into a list of every project.
const SessionParamsSchema = z.strictObject({
  session_id: z.string(),
  around_ts: z.string(),
  limit: z.number().int().min(1).max(40).optional(),
  full: z.boolean().optional(),
});

const RecentParamsSchema = z.strictObject({
  project_id: z.string(),
  since: z.string().optional(),
  until: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  maxBytes: z.number().int().min(256).max(1_000_000).optional(),
});

const ONE_OF_QUERY = "Pass exactly one of query or queries.";

const SearchParamsSchema = z
  .strictObject({
    query: z.string().min(1).optional(),
    queries: z.array(z.string().min(1)).min(2).max(5).optional(),
    project_id: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    role: z.enum(["user", "assistant"]).optional(),
    session_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    maxBytes: z.number().int().min(256).max(1_000_000).optional(),
    context: z.number().int().min(0).max(5).optional(),
  })
  .refine((p) => (p.query === undefined) !== (p.queries === undefined), { message: ONE_OF_QUERY });

const LeftOffParamsSchema = z.strictObject({
  project_id: z.string().optional(),
  file: z.string().min(1).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(10).optional(),
  session_id: z.string().min(1).optional(),
  commits: z.array(z.string().min(1)).min(1).max(50).optional(),
  text: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  branches: z.boolean().optional(),
});

/** Fewer non-space characters than this match too many edits to tell one apart. */
const MIN_TEXT_CHARS = 20;

const StatsParamsSchema = z.strictObject({
  // min(1): an empty string would otherwise fall through to a wider scope.
  project_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  since: z.string().optional(),
  sections: z.array(z.enum(STATS_SECTIONS)).min(1).optional(),
  name: z.string().min(1).optional(),
});

const HoldParamsSchema = z.strictObject({
  project_id: z.string().min(1),
  id: z.string().regex(/^[0-9a-f]{8}$/).optional(),
  item: z.string().min(1).max(300).optional(),
  status: z.enum(HOLD_STATUSES),
  words: z.string().min(1).max(500).optional(),
  waits_for: z.string().min(1).max(200).optional(),
});

const PendingParamsSchema = z.strictObject({
  project_id: z.string().min(1).optional(),
  maxBytes: z.number().int().min(256).max(1_000_000).optional(),
});

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    const path = indexDbPath();
    // A new install has no index until the watcher's first run, which
    // starts with the watcher.
    if (!existsSync(path)) {
      throw new Error("clens has no index yet; it is building one in the background. Try again in a minute.");
    }
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 30000"); // see schema.ts's applySchema() for why 30s
  }
  return db;
}

const server = new Server(
  { name: "clens", version: "0.0.0" },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "clens_search",
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "FTS5 search query — literal token/substring matching, not semantic search. Pick distinctive words likely to appear verbatim in the target message (technical terms, exact names) over generic ones, since rare terms cut noise more than common ones. Matches both user and assistant messages, so consider phrasing either side might have used. If a query returns nothing or too little, retry with a synonym or a different language before concluding no match exists.",
          },
          project_id: {
            type: "string",
            description:
              "A working directory path with every slash replaced by a dash; for the current project, derive it from your known cwd. Omit to search every project.",
          },
          since: {
            type: "string",
            description: "ISO 8601 date lower bound (matches at or after this time)",
          },
          until: {
            type: "string",
            description: "ISO 8601 date upper bound (matches at or before this time). Combine with since to bound a window.",
          },
          role: {
            type: "string",
            enum: ["user", "assistant"],
            description:
              "Restrict to one author: \"user\" (the human's own messages) or \"assistant\" (Claude's replies). Omit to search both. Use \"user\" to find what the user themselves said without assistant replies drowning it out.",
          },
          session_id: {
            type: "string",
            description:
              "Only this session's messages: a session_id from another clens result, or \"current\" for this conversation (Claude Code and Codex). The subagents it started are not included; search one by its own session_id. A session named here is searched whatever its kind.",
          },
          limit: {
            type: "number",
            description: "Max results (default 20, max 100)",
          },
          maxBytes: {
            type: "number",
            description:
              "Cap on the total serialized size of the response (default 8192). Lower-ranked hits past the cap are truncated and reported as \"+N more\"; the top hit is always returned. Raise this only if you need more hits in one call.",
          },
          context: {
            type: "number",
            description:
              "Also show up to this many messages before and after each hit in its session (0-5, default 0), each cut to one short line and marked by its offset ([-1] is just before the hit). Context counts toward maxBytes, so fewer hits fit.",
          },
          queries: {
            type: "array",
            items: { type: "string" },
            description:
              "Instead of query: 2-5 queries run as separate searches with the same filters and limit, in one call. The answer has one section per query; maxBytes is shared evenly among them.",
          },
        },
      },
    },
    {
      name: "clens_recent",
      description:
        "List the user's own messages in a project, Claude Code and Codex, each with the first reply to it, with an optional keyword filter — still time-ordered (ts DESC), not relevance-ranked. " +
        "Use it to browse a narrow window (a few minutes, or a known session's span). Messages an agent wrote (a subagent's prompt, a one-shot claude -p or codex exec run) are left out. " +
        "For where work stopped or what was done (\"where did I leave off\", \"what did I do yesterday\") use clens_left_off; for a topic or keyword, clens_search. " +
        "Returns FULL messages (not snippets), so the response is capped at maxBytes total; the oldest rows beyond the cap are dropped and reported as \"+N more\". Prefer a narrow since/until over a large window. " +
        "ALWAYS pass project_id. Derive it from the current working directory: replace every slash with a dash.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "The current working directory path with every slash replaced by a dash. Derive this from your known cwd.",
          },
          since: {
            type: "string",
            description: "ISO 8601 lower bound. For 'today' use start of today in UTC. For 'yesterday' use yesterday's date.",
          },
          until: {
            type: "string",
            description: "ISO 8601 upper bound",
          },
          query: {
            type: "string",
            description: "Optional keyword filter (plain substring match, not FTS5) on the user's message and the reply shown with it. Narrows the time-ordered list instead of ranking by relevance. Match is literal — retry with a synonym or a different language if a query returns nothing.",
          },
          limit: {
            type: "number",
            description:
              "Max results (default 10, max 30). Start with the default — if the answer isn't in it, retry with a larger limit (up to 30) rather than requesting the max upfront.",
          },
          maxBytes: {
            type: "number",
            description:
              "Cap on the total serialized size of the response (default 32768). Because recent returns FULL messages, a few large messages can hit this; the oldest rows past the cap are dropped and reported as \"+N more\". The most-recent row is always returned — its body truncated (with a clens_session pointer to the full text) only if that one message alone is enormous. Prefer narrowing since/until over raising this.",
          },
        },
        required: ["project_id"],
      },
    },
    {
      name: "clens_session",
      description:
        "Fetch conversation context around a specific message in a session. " +
        "Use this after clens_search to get the full conversation around a matching result. " +
        "Pass a clens_search result's session_id, and its ts as around_ts.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "session_id from a clens_search or clens_recent result, or \"current\" for this conversation (Claude Code and Codex), for example to read turns a compaction dropped",
          },
          around_ts: {
            type: "string",
            description: "ISO 8601 timestamp to center the context window on (ts from clens_search result)",
          },
          limit: {
            type: "number",
            description: "Number of messages to return (default 20, max 40)",
          },
          full: {
            type: "boolean",
            description: "Return messages over 20,000 characters whole. By default their middle is cut, keeping 5,000 characters at each end.",
          },
        },
        required: ["session_id", "around_ts"],
      },
    },
    {
      name: "clens_left_off",
      description:
        "Where work stopped: the latest sessions of a project, or the sessions that edited a given file, newest first; or, with file and text, the sessions that wrote that text. " +
        "Each comes with when its conversation started and ended, the user's last request, the assistant's last reply (often a status or summary) and the files it edited. " +
        "Use it for \"where did I leave off\", \"what was I doing on this\", \"who last changed this file and why\"; then clens_session to read more of one. " +
        "With project_id and branch (a git branch name, as `git branch --show-current` prints it), returns the checks run while that branch was checked out, in every Claude Code and Codex session of the project, and the git push and merge commands that name it: test runs, HTTP calls (curl, wget, httpie, xh) and browser pages, by host, each with its failures and latest run. Use it for \"did we test this\", \"was it checked on sandbox\", \"is it deployed to cbt\". With branches: true, the project's latest branches with their checks, to find the one the user means. A check that did not fail exited 0 or got no result, which does not say its result was right. " +
        "When the limit leaves out a session that was active in the span the list covers, the list ends with how many. " +
        "In Claude Code and Codex the current conversation is left out of the list; pass session_id \"current\" for its own record, for example after the conversation was compacted. A subagent's edits count as the session that started it. Files a shell command wrote are read off its text (redirects, tee, sed -i, heredoc and -c/-e scripts); a path set only when it ran ($VAR, $(…)) is missed.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "A working directory path with every slash replaced by a dash. Omit to look across every project.",
          },
          file: {
            type: "string",
            description: "Only sessions that edited this file: an absolute path, or its tail such as src/app.ts.",
          },
          since: {
            type: "string",
            description: "ISO 8601 lower bound, for \"what did I do yesterday / this week\". With since and until, only sessions active in that window, each shown as it stood at the window's end: its last request and reply and the edits inside it.",
          },
          until: {
            type: "string",
            description: "ISO 8601 upper bound (at or before this time). Combine with since to bound a window.",
          },
          limit: {
            type: "number",
            description: "Number of sessions (default 3, max 10).",
          },
          session_id: {
            type: "string",
            description:
              "A session id from another clens result, or \"current\" for this conversation (Claude Code and Codex). Returns that one session's record instead of a list: its segments (the conversation cut at compactions and pauses over 2 hours, each with its span, request count, first request, the code terms its replies mention most, the reply after its latest edit or commit when a later request followed, and last reply), its latest requests, its last reply (and, for a session of one segment, that reply after its latest edit or commit), edited files, git commands, checks (test runs, HTTP calls and browser pages, by host), failed tool calls (with the start and end of their output) and hook blocks. project_id, file, since, until, limit, commits, text, branch and branches are then ignored.",
          },
          commits: {
            type: "array",
            items: { type: "string" },
            description:
              "Commit subjects (git log's %s), 1-50. Returns, for each, the sessions that ran git commit with it, newest first, instead of a list: which of the sessions open at a commit's time made it. project_id, since and until narrow it; file and limit are then ignored. Not found: a commit whose command holds no subject (--no-edit, revert, rebase, -F with a file).",
          },
          text: {
            type: "string",
            description:
              "Text from the file, one line or a few, with file. Returns the sessions whose edits of that file wrote it, the first first, instead of a list: each at its first such edit, with the user's request that started that turn and the assistant reply just before the request, which is what the user answered and often holds the reasons. When the same session wrote it again in a later turn, that last turn follows as \"written again\": it holds the reason when the first attempt was rolled back, the first turn does when later work only carried the text along. Read around a request with clens_session. Lines are trimmed and must all appear in one edit; at least 20 characters in all. project_id, since, until and limit narrow it. An edit's input is stored up to 2 KB, so later lines of a long edit or of a large new file are not found.",
          },
          branch: {
            type: "string",
            description:
              "A git branch of the project, as git branch --show-current prints it. Returns its checks instead of a list; needs project_id. since and until narrow it; limit is ignored, and file, text and commits are an error with it.",
          },
          branches: {
            type: "boolean",
            description:
              "true lists the project's latest branches, newest activity first, each with its checks; needs project_id. limit (default 3, max 10), since and until apply.",
          },
        },
      },
    },
    {
      name: "clens_stats",
      description: STATS_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "A working directory path with every slash replaced by a dash; for the current project, derive it from your known cwd. Omit, together with session_id, for every project.",
          },
          session_id: {
            type: "string",
            description: "Scope stats to a single session instead of a project. Get it from a clens_search/clens_recent/clens_left_off result, or pass \"current\" for this conversation (Claude Code and Codex). When set, since is ignored.",
          },
          since: {
            type: "string",
            description: "ISO 8601 date lower bound. Omit for all-time stats. Ignored when session_id is set.",
          },
          sections: {
            type: "array",
            items: { type: "string", enum: [...STATS_SECTIONS] },
            description: "Only these sections (default: all). The scope line and session count are always included.",
          },
          name: {
            type: "string",
            description: "Only the skills, slash commands and agent types whose name contains this text, in any case, e.g. \"ecc:\" for one plugin's. Other sections are not filtered.",
          },
        },
      },
    },
    {
      name: "clens_hold",
      description: HOLD_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "The working directory path with every slash replaced by a dash.",
          },
          id: {
            type: "string",
            description: "An item's id from clens_pending or an earlier clens_hold, to change that item.",
          },
          item: {
            type: "string",
            description: "What was set aside, in one line that makes sense without this conversation. New items only.",
          },
          status: {
            type: "string",
            enum: [...HOLD_STATUSES],
            description: "held or dropped for a new item; done, held, dropped or removed for an item passed by id.",
          },
          words: {
            type: "string",
            description: "The user's own words that set it aside or changed it, quoted.",
          },
          waits_for: {
            type: "string",
            description: "What a held item waits for, when the user said so.",
          },
        },
        required: ["project_id", "status"],
      },
    },
    {
      name: "clens_pending",
      description: PENDING_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "A working directory path with every slash replaced by a dash; omit it for every project.",
          },
          maxBytes: {
            type: "number",
            description: "Cap on the answer's size in bytes (default 16384).",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  // The calling session, looked up per request: Claude Code's changes with
  // /clear while this server keeps running (see current_session.ts). Codex
  // metadata comes first: it proves the caller is Codex, while a
  // CLAUDE_CODE_SESSION_ID left in the environment of a Codex started from a
  // Claude Code shell would name the wrong session.
  const currentSessionId = codexSessionFromMeta(req.params._meta) ?? detectCurrentSessionId(process.ppid, process.env);

  if (req.params.name === "clens_search") {
    const parsed = SearchParamsSchema.safeParse(req.params.arguments);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid params: ${parsed.error.message}` }], isError: true };
    }
    try {
      if (parsed.data.session_id !== undefined) {
        const resolved = resolveSessionId(parsed.data.session_id, currentSessionId);
        if (!resolved.ok) return { content: [{ type: "text", text: resolved.error }], isError: true };
        parsed.data.session_id = resolved.id;
      }
      // The refine above does not narrow the type: query is still optional.
      const { query, queries, ...rest } = parsed.data;
      const terms = (queries ?? (query === undefined ? [] : [query])).flatMap(queryTerms);
      // Without a known session (a client that names none), the current
      // turn simply isn't excluded.
      const opts = { currentSessionId, languages: await searchAnalyzers(terms) };
      const out = {
        maxBytes: parsed.data.maxBytes ?? DEFAULT_SEARCH_MAX_BYTES,
        context: parsed.data.context ?? 0,
        allProjects: parsed.data.project_id === undefined && parsed.data.session_id === undefined,
      };
      if (queries !== undefined) {
        return { content: [{ type: "text", text: searchManyText(getDb(), rest, queries, opts, out) }] };
      }
      if (query !== undefined) {
        return { content: [{ type: "text", text: searchText(getDb(), { ...rest, query }, opts, out) }] };
      }
      return { content: [{ type: "text", text: `Invalid params: ${ONE_OF_QUERY}` }], isError: true };
    } catch (e) {
      const err = e as { message?: string };
      return { content: [{ type: "text", text: `Search error: ${err.message ?? String(e)}` }], isError: true };
    }
  }

  if (req.params.name === "clens_recent") {
    const parsed = RecentParamsSchema.safeParse(req.params.arguments);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid params: ${parsed.error.message}` }], isError: true };
    }
    try {
      const results = recentUserText(getDb(), parsed.data);
      return { content: [{ type: "text", text: formatResults(results, parsed.data.maxBytes ?? DEFAULT_RECENT_MAX_BYTES) }] };
    } catch (e) {
      const err = e as { message?: string };
      return { content: [{ type: "text", text: `Recent error: ${err.message ?? String(e)}` }], isError: true };
    }
  }

  if (req.params.name === "clens_session") {
    const parsed = SessionParamsSchema.safeParse(req.params.arguments);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid params: ${parsed.error.message}` }], isError: true };
    }
    try {
      const resolved = resolveSessionId(parsed.data.session_id, currentSessionId);
      if (!resolved.ok) return { content: [{ type: "text", text: resolved.error }], isError: true };
      const messages = sessionContext(getDb(), { ...parsed.data, session_id: resolved.id });
      if (messages.length === 0) return { content: [{ type: "text", text: "No messages found." }] };
      const formatted = messages
        .map((m, i) => `[${i + 1}] ${m.role.toUpperCase()} ${m.ts}\n${m.text}`)
        .join("\n\n");
      return { content: [{ type: "text", text: formatted }] };
    } catch (e) {
      const err = e as { message?: string };
      return { content: [{ type: "text", text: `Session error: ${err.message ?? String(e)}` }], isError: true };
    }
  }

  if (req.params.name === "clens_left_off") {
    const parsed = LeftOffParamsSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid params: ${parsed.error.message}` }], isError: true };
    }
    try {
      if (parsed.data.session_id !== undefined) {
        // Resolved the way clens_stats resolves it, so both tools agree on which session is current.
        const resolved = resolveSessionId(parsed.data.session_id, currentSessionId);
        if (!resolved.ok) return { content: [{ type: "text", text: resolved.error }], isError: true };
        const record = sessionRecord(getDb(), resolved.id);
        const text = record
          ? formatSessionRecord(record)
          : `No session found: ${resolved.id}. A session only just started may not be indexed yet; try again in a few seconds.`;
        return { content: [{ type: "text", text }] };
      }
      const { branch, branches } = parsed.data;
      if (branch !== undefined || branches === true) {
        const invalid = branchParamsError(parsed.data);
        if (invalid !== null) return { content: [{ type: "text", text: `Invalid params: ${invalid}` }], isError: true };
        // branchParamsError has made sure project_id is set.
        const project_id = parsed.data.project_id!;
        const window = { since: parsed.data.since, until: parsed.data.until };
        const text = branch !== undefined
          ? formatBranchChecks(branchChecks(getDb(), { project_id, branch, ...window }))
          : formatRecentBranches(project_id, recentBranches(getDb(), { project_id, limit: parsed.data.limit, ...window }));
        return { content: [{ type: "text", text }] };
      }
      if (parsed.data.text !== undefined) {
        const { file, text, commits } = parsed.data;
        const invalid = (message: string) => ({ content: [{ type: "text" as const, text: `Invalid params: ${message}` }], isError: true });
        if (file === undefined) return invalid("text needs file, the file the text is in");
        if (commits !== undefined) return invalid("pass text or commits, not both");
        if (text.replace(/\s/g, "").length < MIN_TEXT_CHARS) {
          return invalid("text is too short to tell one edit from another; pass a longer line or a few lines");
        }
        return { content: [{ type: "text", text: formatLineOrigins(file, lineOrigins(getDb(), file, text, parsed.data)) }] };
      }
      if (parsed.data.commits !== undefined) {
        return { content: [{ type: "text", text: formatCommitSessions(commitSessions(getDb(), parsed.data.commits, parsed.data)) }] };
      }
      const { sessions, more } = leftOffWithMore(getDb(), parsed.data, { currentSessionId });
      return { content: [{ type: "text", text: formatLeftOff(sessions, more) }] };
    } catch (e) {
      const err = e as { message?: string };
      return { content: [{ type: "text", text: `Left-off error: ${err.message ?? String(e)}` }], isError: true };
    }
  }

  if (req.params.name === "clens_stats") {
    const parsed = StatsParamsSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid params: ${parsed.error.message}` }], isError: true };
    }
    try {
      const params = parsed.data;
      if (params.session_id !== undefined) {
        const resolved = resolveSessionId(params.session_id, currentSessionId);
        if (!resolved.ok) return { content: [{ type: "text", text: resolved.error }], isError: true };
        params.session_id = resolved.id;
      }
      const facts = projectStats(getDb(), params);
      return { content: [{ type: "text", text: formatStats(facts) }] };
    } catch (e) {
      const err = e as { message?: string };
      return { content: [{ type: "text", text: `Stats error: ${err.message ?? String(e)}` }], isError: true };
    }
  }

  // The ledger is its own file, not the index: the index connection stays
  // read-only, and a rebuild never touches what agents recorded.
  if (req.params.name === "clens_hold") {
    const parsed = HoldParamsSchema.safeParse(req.params.arguments);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid params: ${parsed.error.message}` }], isError: true };
    }
    try {
      const result = recordHold(ledgerPath(), parsed.data, { sessionId: currentSessionId, now: new Date() });
      if (!result.ok) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: result.text }] };
    } catch (e) {
      const err = e as { message?: string };
      return { content: [{ type: "text", text: `Ledger error: ${err.message ?? String(e)}` }], isError: true };
    }
  }

  if (req.params.name === "clens_pending") {
    const parsed = PendingParamsSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid params: ${parsed.error.message}` }], isError: true };
    }
    try {
      return { content: [{ type: "text", text: formatPending(readLedger(ledgerPath()), parsed.data) }] };
    } catch (e) {
      const err = e as { message?: string };
      return { content: [{ type: "text", text: `Ledger error: ${err.message ?? String(e)}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
});

process.on("exit", () => { db?.close(); });

// Only one MCP server process should watch for JSONL changes — otherwise
// every concurrent Claude/Codex session spawns its own watcher, multiplying
// fs handles and triggering redundant reindex runs on the same change.
// Non-blocking lock attempt: if another process already holds watch.lock,
// this process skips watching and just serves reads. If the lock holder
// exits (or is killed — proper-lockfile's stale timeout covers that case),
// the lock frees up for the next attempt below to pick up watching.
const WATCH_LOCK_RETRY_MS = 30_000;

/** Try to become the watcher. Returns true once this process owns the lock
 *  and startWatch() is running; false if another process still holds it
 *  (expected — not logged) or an unexpected error occurred (logged, since
 *  that's not ordinary lock contention and would otherwise fail silently). */
async function tryBecomeWatcher(): Promise<boolean> {
  try {
    let watching: WatchHandle | null = null;
    const release = await acquireLock(watchLockPath(), 0, (err) => {
      // Another process took the watch lock because this one looked
      // abandoned (see acquireLock). It watches now; this one goes back to
      // serving reads and retrying, instead of dying. Its analyzer socket
      // stays open: closing it would remove the socket file, which is the
      // new watcher's by then.
      console.error("clens watch: lost the watch lock, stopped watching:", err.message);
      watching?.stop();
      retryWatching();
    });
    // The watcher holds the language analyzers for every server: it needs
    // them to index, and the others ask it to split their search terms
    // (see analyzers.ts).
    await ensureLanguageAdaptersLoaded();
    try {
      await serveAnalyzers();
    } catch (e) {
      console.error("clens watch: cannot serve the language analyzers to other servers:", (e as Error).message);
    }
    watching = startWatch(() => {
      db?.close();
      db = null;
    });
    process.on("exit", () => { void release(); });
    return true;
  } catch (e) {
    const exitCode = (e as { exitCode?: number }).exitCode;
    if (exitCode !== 4) {
      // Not the expected "indexer busy" lock-contention signal — surface it.
      console.error("clens watch: unexpected error acquiring watch lock:", e);
    }
    return false;
  }
}

// Another process currently owns the watch lock. Keep retrying so that if
// it exits later, this already-running process can take over — otherwise
// only a freshly spawned process would ever notice the lock freed up.
function retryWatching(): void {
  const retryTimer = setInterval(() => {
    tryBecomeWatcher()
      .then((became) => {
        if (became) clearInterval(retryTimer);
      })
      .catch(() => {
        // Swallow — tryBecomeWatcher already logs unexpected errors.
      });
  }, WATCH_LOCK_RETRY_MS);
  retryTimer.unref();
}

if (!(await tryBecomeWatcher())) retryWatching();

const transport = new StdioServerTransport();
await server.connect(transport);
