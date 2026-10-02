// Sent to the client in the initialize response. Claude Code shows server
// instructions in the system prompt even while the tools themselves are
// deferred (only their names visible), so this is what tells the agent WHEN
// to reach for clens; the per-tool descriptions only say how each one works.
// Without it users had to name the tool in every request, and agents went to
// the raw index or transcripts instead. Keep every claim here true of the
// current code: agents act on it literally.
//
// Claude Code passes at most 2,048 characters of server instructions and of
// each tool description (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH) and cuts
// the rest, so each stays under that: when and how to use clens here, the
// query rules in the clens_search description.
export const SERVER_INSTRUCTIONS = `clens is a local, read-only index of the user's past Claude Code and Codex conversations across all projects: every user message and assistant reply, with session ids and timestamps. It keeps sessions whose transcripts were deleted.

USE IT FIRST, without being asked, when the user refers to earlier work rather than the current conversation or code:
- a past topic, finding or decision: "what did we find about the slow query", "why did we drop the retry logic"
- something tried before: "did switching the linter help" (check before suggesting it again)
- where work stopped or what was done: "where did I leave off", "what did I do yesterday" (clens_left_off)
- another session or project: "the helper in the other repo"
- signal words: last time, earlier, before, previously, we decided, we tried, remember when, and the same in the user's language (지난번, 아까, 前回, 上次); also a request that assumes something already exists

DON'T USE IT for the current code (read the files), for what is still in your context, or for general knowledge. Earlier turns a compaction dropped are not in it: read them with clens_session, session_id "current".

HOW:
1. clens_search (limit 5-10) with distinctive words the conversation would contain: identifiers, error text, file names, product terms. Keyword search, not semantic; see its query rules.
2. clens_session with a hit's session_id and ts, to read the conversation around it before answering.
3. Nothing relevant? Retry before concluding it is absent: the other language, spelling variants, split forms (uploadImages / upload images), OR, another project, a wider time range.
4. clens_left_off: latest sessions of a project or file, with last request, reply and edits; session_id "current" after compaction. clens_recent: messages in a time window. clens_stats: tool and file counts.

Report when and in which session something was said, quote the key line, and keep what the record shows apart from your inference. Use these tools instead of reading ~/.clens/index.db or transcript files.`;

export const SEARCH_DESCRIPTION = `Keyword search (FTS5, not semantic) over the user's past Claude Code and Codex messages, the user's and the assistant's. Returns a short snippet per hit with its session_id, ts, role and score; read the conversation around a hit with clens_session (its session_id + ts). Pass context (1-5) to also get that many messages before and after each hit, often enough to skip that call. Pass queries (2-5) instead of query to run several searches in one call.

Query rules:
- Every word must appear in the same message. When no message has them all, the results are messages with some of them, and the response says so.
- Use words the message itself would contain (identifiers, error text, file names, product terms), not a paraphrase of the question.
- Supports "exact phrase", prefix* and the operators OR and NOT. Operators count only in uppercase; lowercase and, or, not are ordinary words.
- Retry a miss with the other language (identifiers in English, prose in the user's language), spelling variants and split forms, combined with OR: cacheTimeout OR "cache timeout".
- role "user" finds what the user themselves said or decided, without assistant replies drowning it out.
- In Claude Code and Codex the current turn is left out; earlier turns of this conversation can still match, and are already in your context unless a compaction dropped them.

project_id is a working directory path with every "/" replaced by "-" (/Users/a/work/app becomes -Users-a-work-app; home-directory sessions are under -Users-a). Pass it to search one project, deriving another project's id from its path when the user asks about that project. Omit it to search every project; each hit then names its project.

Not indexed: tool outputs (command results, file contents read) and the code itself.

The response is capped at maxBytes; lower-ranked hits past the cap are reported as "+N more".`;

// The clens_stats tool description; Claude Code cuts it at 2,048 characters
// like every tool description.
export const STATS_DESCRIPTION = `Aggregate usage statistics: tool call counts with each tool's failures, skill, slash-command and agent call counts, health signals (errors, compaction, context bloat), timeline (wall/think/idle time), and files touched. Use this for questions about usage patterns or trends ("what tools do I use most", "how much have I used skill X", "what files have I been editing") — NOT for finding specific messages or conversations, which clens_search/clens_recent handle instead.

Scope: pass project_id for one project, session_id for one session, or neither for every project. session_id "current" is this conversation (Claude Code and Codex). Session stats count only that session's own calls, not the subagents it started. Project and all-project stats leave out one-shot exec/SDK runs and clens judge transcripts. since bounds by date and is ignored with session_id.

Pass sections to get only what the question needs and keep the answer short. Long lists end with a "(+N more)" line. For one plugin's or one family's skills, slash commands and agents, pass name ("ecc:"), so none falls past the cut.

For Claude Code and Codex sessions it also reports hook blocks (which hook stopped which tool, with the latest reasons) and tool output size per tool (characters of text each tool's results added to the conversation; images are not counted). Sessions whose transcripts were deleted before clens began recording these have neither, so totals over older history count less than happened.`;
