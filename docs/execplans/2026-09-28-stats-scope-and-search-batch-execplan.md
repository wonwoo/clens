# Let clens_stats see every project or the current session, and let clens_search take several queries

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This is bundle 1 of three. Bundle 2 (hook blocks and tool-output sizes, which need an index schema change) and bundle 3 (a work record of the current session for use after context compaction) are separate ExecPlans under `docs/execplans/`. Neither is needed to execute this one. Bundle 2 and bundle 3 build on the names this plan defines in `Interfaces and Dependencies`, so keep those names exactly.


## Purpose / Big Picture

clens is a local, read-only index of the user's past Claude Code and Codex conversations. An agent (Claude running inside Claude Code) reaches it through an MCP server: MCP, the Model Context Protocol, is the JSON-RPC-over-stdin/stdout protocol Claude Code uses to call tools that another process provides. The clens MCP server is `src/mcp/server.ts`; it serves the tools `clens_search`, `clens_recent`, `clens_session`, `clens_left_off` and `clens_stats`.

After this change an agent can do four things it cannot do today. It can ask `clens_stats` for usage across every project at once, by leaving out `project_id`. It can ask `clens_stats` about the conversation it is in, by passing `session_id: "current"`. It can ask `clens_stats` for only the sections it needs, such as `sections: ["skills"]`, so the answer stays small. And it can pass `clens_search` several queries in one call with `queries: [...]`. Two noise sources also go away: one-shot programmatic runs (session kind `exec`, explained below) no longer show up in search results, and neither they nor clens's old judge transcripts (kind `pipeline`) inflate project-wide or all-project stats.

Two existing bugs are fixed on the way. After `/clear` in Claude Code, search no longer returns the question just asked as its own top hit, and `clens_left_off` no longer lists the conversation it is called from; both happened because the server's idea of "the current session" went stale on `/clear`. And the analyzers stop computing values `clens_stats` never prints, which makes all-project stats faster.

To see it working, build the project, index the test fixture into a temporary directory, start the built MCP server against it with an MCP client, and call `clens_stats` with no arguments: the answer begins with `Scope: all projects`. Call it with `{"session_id": "current"}` while the server's environment has `CLAUDE_CODE_SESSION_ID=test`: the answer begins with `Scope: session test in project p1`. The exact commands are in `Concrete Steps`.


## Progress

- [x] (2026-09-28) Design agreed with the user (approach A: widen the existing tools, add no new tool), measurements taken, this plan written.
- [x] (2026-09-28 13:10 KST) Milestone 0: snapshot the developer's index and record "before" analyzer timings and `projectStats` output (read-only). Snapshot `/tmp/clens-m0/snap.db` (1.63 GB), dump `/tmp/clens-m0/before.json` (9,647 bytes, project `-Users-me-IdeaProjects-clens`); three before runs gave identical dumps. Before timings, `global` scope, ms per run (1 / 2 / 3): identity 101 / 699 / 34, tools 185 / 838 / 88, skills 16 / 92 / 7, agents 319 / 1161 / 92, health 180 / 177 / 164, timeline 281 / 279 / 337, files 13 / 26 / 17.
- [x] (2026-09-28 13:25 KST) Milestone 0: remove the analyzer fields and queries `clens_stats` never prints (agents, tools, timeline, health, skills, files); rewrite `analyzeTools` as one `GROUP BY` query. Also the name tie-break in `formatStats` (`src/mcp/server.ts`) and the header comments. The new key-order test failed first (`expected [ 'Bash', 'ToolSearch', …(5) ] to deeply equal [ 'Edit', 'Bash', …(5) ]`) and passes after.
- [x] (2026-09-28 13:25 KST) Milestone 0: update `test/analyzer_b2.spec.ts`, `test/analyzer_b3.spec.ts` and `test/analyzer_b4.spec.ts` for the removed fields; update the `event.in_tok…` invariant sentence in `CLAUDE.md`.
- [x] (2026-09-28 13:40 KST) Milestone 0: "after" timings recorded; `projectStats` output identical to "before"; `npm test` green. Done: three after runs `cmp`-identical to `before.json`; `npm run typecheck` clean; `npm test` 28 files, 305 tests passed (308 before, minus the 4 deleted cases, plus the new one); acceptance greps find only the allowed `src/indexer/driver.ts:214` comment. The 300 ms bound for `analyzeTools` failed in 3 of 8 after runs; the user accepted the interleaved measurement as meeting it (see the Decision Log). `/tmp/clens-m0/` and `./.m0-probe.ts` were deleted when the milestone closed.
- [x] (2026-09-28 14:05 KST) Milestone 1: `src/mcp/current_session.ts` with `resolveSessionId` and `detectCurrentSessionId`, and its spec `test/mcp_current_session.spec.ts`. The spec failed first (`Failed to load url ../src/mcp/current_session.js`), then 11 tests passed.
- [x] (2026-09-28 14:05 KST) Milestone 1: every current-session use in `src/mcp/server.ts` (search, `clens_left_off`, `clens_stats`) goes through `detectCurrentSessionId(process.ppid, process.env)`, computed per request. Proven end to end in Milestone 3 (`server.ts` cannot be imported in a test).
- [x] (2026-09-28 14:05 KST) Milestone 1: session-kind exclusion in `src/analyzer/scope.ts` and in the hand-written project/global queries of `src/analyzer/identity.ts`. `analyzer_b2/b3/b4` numbers unchanged (14 passed).
- [x] (2026-09-28 14:05 KST) Milestone 1: `src/mcp/stats.ts` gains optional `project_id`, `sections`, the all-projects scope, list caps, and `formatStats` (moved from `src/mcp/server.ts`). The 10 new `test/mcp_stats.spec.ts` cases: 8 failed first (`expected undefined to be 'all'`, `expected { Bash: 1, Edit: 1, Read: 1 } to deeply equal { Edit: 1 }`, `formatStats is not a function`) and the 2 regression guards passed; after, all 17 cases in the file pass.
- [x] (2026-09-28 14:05 KST) Milestone 1: `STATS_DESCRIPTION` added to `src/mcp/instructions.ts` with a length assertion in `test/mcp_instructions.spec.ts`. 937 characters.
- [x] (2026-09-28 14:05 KST) Milestone 1: `src/mcp/server.ts` stats schema, tool description and handler updated; `test/mcp_stats.spec.ts` extended; `npm test` green. `npm test`: 29 files, 326 tests passed.
- [x] (2026-09-28 14:05 KST) Milestone 1: `skills/clens-stats/SKILL.md` updated for optional `project_id`, `session_id: "current"`, `sections` and the new no-data messages.
- [x] (2026-09-28 14:05 KST) Milestone 1: `docs/BACKLOG.md` entry "Cap the size of `clens_session`" rewritten to record the decision not to cap, with the measurement.
- [x] (2026-09-28 14:25 KST) Milestone 2: `s.kind IS NOT 'exec'` added to search's WHERE; test added. The new case failed first (`expected [ 's1', 'run', 's1' ] to not include 'run'`) and passes after; it inserts its own `exec` row so the block's existing fixture is unchanged.
- [x] (2026-09-28 14:25 KST) Milestone 2: `searchText` and `searchManyText` in `src/mcp/search.ts`; server schema and handler accept `queries`; tests added; `SEARCH_DESCRIPTION` still at most 2,048 characters. The five new cases failed first (`searchManyText is not a function`, `searchText is not a function`) and pass after; `SEARCH_DESCRIPTION` is 1,829 characters; `npm test` 29 files, 332 tests passed. `neighborsOf` is no longer imported by `src/mcp/server.ts`, since `searchText` now fills context.
- [x] (2026-09-28 14:35 KST) Milestone 3: end-to-end run of the built server through an MCP client (transcript pasted into `Artifacts and Notes`). Nine `===` markers, `### query: brainstorm` then `### query: skill`, and every block as `Validation and Acceptance` describes, including the last one (env `stale-id`, sessions file `test`) answering `Scope: session test in project p1`.
- [x] (2026-09-28 14:35 KST) Milestone 3: real-scale timing of all-project stats on the developer's own index (read-only), numbers recorded. Default all-sections call: 3,444 ms on the first run, 558 ms on the second, 4,611 characters (1,655 sessions); `["skills"]` alone 42 / 38 ms, 1,122 characters. The answer ends its lists with `(+294 more)` for tools, `(+61 more)` for skills (by name and source), `(+71 more)` for slash commands and `(+30 more of the top 50)` for files.
- [x] (2026-09-28 13:30 KST) Milestone 3: manual check in a second Claude Code terminal after `/clear` (done by the user; see `Surprises & Discoveries`): the current turn was left out of search, and `session_id: "current"` named the new session.
- [x] (2026-09-28 13:32 KST) Milestone 3: the same check after `/resume` (done by the user; see `Surprises & Discoveries`): passed.


## Surprises & Discoveries

- Observation: the MCP server receives the id of the Claude Code session that started it in `CLAUDE_CODE_SESSION_ID`, but the value goes stale on `/clear`.
  Evidence: `src/mcp/server.ts:340` passes `process.env.CLAUDE_CODE_SESSION_ID` to search so the current turn is left out of results, and `src/mcp/server.ts:394` passes it to `clens_left_off` so the current session is left out of its list; the comment at lines 337-338 says Claude Code sets it and Codex does not. Measured on 2026-09-28 at 12:20 KST in a second Claude Code terminal: the `claude` process (pid 74505, started 12:20:02 with `--session-id ba6fa33a-640a-4c18-885e-214d9bf48117`) had a clens MCP server child (pid 74862, ppid 74505, started 12:20:04) that `/clear` did not restart. After `/clear` the user typed a nonce; it was indexed under the new session `347e729f-5f18-47e3-a03f-d40639f9b7fd`, and `clens_search` did not leave that current turn out, so the server was still using the old id. In the main session (claude pid 89612, server ppid 89612) the value was right: a search for the current prompt's words found nothing while an earlier turn's words matched. So the env value is correct at session start and stale after `/clear`. That staleness is a bug in today's search and `clens_left_off`, not only a risk for `"current"`.

- Observation: Claude Code keeps one small JSON file per running `claude` process, `~/.claude/sessions/<pid>.json`, and it follows `/clear`.
  Evidence: the file has keys including `sessionId`, `cwd`, `pid`, `startedAt` and `updatedAt`. After the `/clear` above, `74505.json` held `sessionId` `347e729f…`, the new session; in the main session `89612.json` held `e8932d3e-b9f9-418a-9445-ac63668e847e`, its own id. The same directory also holds `*.key` files, which clens must never read. This file is undocumented Claude Code internal state and may change in a later release. Later the same day the directory held nine JSON files (6008, 6194, 6196, 6217, 23627, 28694, 32532, 74505, 89612), and `ps -p … -o pid=,comm=` showed every one to be a running `/Users/me/.local/bin/claude`, so the files appear to exist only for live processes.

- Observation: Milestone 0's timings on the snapshot are dominated by cold-page reads, not by the code. After the change, `analyzeAgents` was 0 ms in all 8 after runs (before: 319 / 1,161 / 92 ms). `analyzeTools` after, in order: 1,314 / 37 / 720 / 1,481 / 137 / 267 / 36 / 38 ms, so the 300 ms bound failed in 3 of 8 runs; before it was 185 / 838 / 88 ms. The spikes came in the same runs where the unchanged `analyzeIdentity` and `analyzeHealth` also spiked (for example identity 907, health 1,894 ms in the first after run; health ranged 166 to 2,303 ms), with a load average of 7.6. Interleaving the old and new tool queries in one process on the same snapshot (six rounds): old `SELECT ts, name, duration_ms, is_error … ORDER BY ts` plus the JS count 1,484 / 81 / 58 / 62 / 67 / 60 ms, new `GROUP BY` 75 / 33 / 33 / 33 / 51 / 51 ms, and the two removed sidechain scans 2,405 / 104 / 107 / 110 / 116 / 111 ms.
  Evidence: `/tmp/clens-m0/after{1,2,3}.timings`; the interleaved run is a one-off `npx tsx -e` script against `/tmp/clens-m0/snap.db`.

- Observation: with the new build, `"current"` and search's current-turn exclusion follow `/clear`. Checked by the user on 2026-09-28 at 13:28 KST in a second Claude Code terminal (project `-Users-me-IdeaProjects-work-app`): after `/clear` the prompt `zqvnonce4817 이 단어로 clens_search 해 봐` was indexed under the new session `0b50860d-40a1-4922-99dd-55e92567be58` (interactive) and did not come back from the search. The only hit was an assistant message in this plan's executing session (`e8932d3e…`, 04:25:36Z) that quoted the nonce while giving the instructions, a flaw of the check, not of the code: a nonce must not be written anywhere before the check. Then `clens_stats` with `session_id: "current"` and `sections: ["tools"]` answered `Scope: session 0b50860d-40a1-4922-99dd-55e92567be58 in project -Users-me-IdeaProjects-work-app`, the id in that session's scratchpad path. Before this plan, the same `/clear` check at 12:20 KST returned the current turn itself. Then, in the same terminal, the user ran `/resume` into session `ba927a8b-5d5b-4cec-86d9-246f7aeb15db` (interactive, work-app, started 2026-09-27T09:01Z) and searched a nonce of their own, `giijjjaaa`: it was indexed under `ba927a8b…` at 04:31:27Z and not returned, and `session_id: "current"` reported `ba927a8b…`. `~/.claude/sessions/15639.json` (that terminal's `claude`) held `ba927a8b…`; so did `6196.json`, a `claude` process running since 08:33 KST that apparently had the same session open, which the check does not depend on.
  Evidence: `SELECT session_id, ts, role FROM user_text WHERE text LIKE '%zqvnonce4817%'` gives e8932d3e/assistant 04:25:36Z, 0b50860d/user 04:27:57Z, 0b50860d/assistant 04:28:13Z.

- Observation (out of scope, not fixed here): `AGENTS.md` at the repository root is untracked and carries an older copy of the `event.in_tok…` invariant, naming `health.ts`, `skills.ts` and a `corrections.ts` that `src/analyzer/` does not contain. This plan updates `CLAUDE.md` only and leaves `AGENTS.md` alone.

- Observation: all-project stats are slow-ish on a synchronous request, and most of the time goes to values `clens_stats` never prints. Timed on the developer's real index (451,266 events, 180,260 assistant events) with the current analyzers in `global` scope, before any change. First run: identity 84 ms, tools 513 ms, skills 53 ms, agents 1,436 ms, health 252 ms, timeline 542 ms, files 35 ms, about 2.9 s. A second run later the same day: agents 2,036 ms, tools 1,210 ms, identity 767 ms, timeline 328 ms, health 178 ms, skills 103 ms, files 37 ms, about 4.7 s. `analyzeAgents` spends its time on two `is_sidechain = 1` event scans (`sidechain_events`, `subagent_session_ids`) and a sample query per agent type; `analyzeTools` loads every `tool_call` row into JavaScript to count names and compute durations. Milestone 0 removes both.

- Observation: in all-project scope the tool list, not the file list, becomes the largest part of the answer. There are 324 distinct tool names across work sessions (about 11,000 characters as `name: count` lines), 64 distinct skills, 92 distinct slash commands and 27 agent types. The top 30 tools cover 71,729 of 76,888 tool calls (93%); the top 20 skills cover 581 of 694 skill calls (84%). This is why the plan caps those lists too (see the Decision Log).

- Observation: `SERVER_INSTRUCTIONS` in `src/mcp/instructions.ts` is 2,010 characters, 38 short of Claude Code's 2,048-character cap that `test/mcp_instructions.spec.ts` enforces. `SEARCH_DESCRIPTION` is 1,756. This plan does not touch `SERVER_INSTRUCTIONS`; any later plan that wants to add a line there must first shorten something.

- Observation (out of scope, not fixed here): `clens_recent` (`src/mcp/recent.ts`) has no session-kind filter at all, so `pipeline` and `exec` messages appear in it.

- Observation (out of scope, not fixed here): messages that another Claude session sends through the teammate feature ("Another Claude session sent a message: <teammate-message …>") are stored with role `user`, 4,000 to 5,000 characters each, so they can pass for something the human said.


## Decision Log

- Decision: widen the five existing tools instead of adding new ones (approach A).
  Rationale: three approaches were compared with the user. A keeps the tool count at five, so an agent has no new tool to choose among, and the server instructions need no new text. B (new tools such as `clens_hooks`, `clens_context`, `clens_checkpoint`) gives each tool a narrow description, but raises the count to eight while `SERVER_INSTRUCTIONS` has 38 characters of room and it is still unmeasured whether agents pick clens unprompted. C (one read-only SQL tool) needs no code per question, but makes the SQLite schema a public contract that breaks agent queries whenever it changes, cannot bound response size or query cost on the synchronous request path, and forces the agent to read the schema first.
  Date/Author: 2026-09-28, user and Claude.

- Decision: leave `exec` sessions out of `clens_search`.
  Rationale: `exec` is the kind the indexer gives a one-shot programmatic run: a Claude Code transcript whose `entrypoint` starts with `sdk-` (a `claude -p` run or a program built on the SDK; see `parseFileBody` in `src/indexer/claude_parser.ts`) and a Codex `codex exec` run. There are 371 Claude and 168 Codex `exec` sessions holding 2,007 text rows, about 2% of the searchable text. 311 of the 371 Claude ones ran under `/private/tmp` or `/private/var/folders`, and a random sample of their first prompts were all benchmarks or tests ("Implement `compare(a, b)` in `solution.py`…", the same "who are you" prompt repeated). In the session that motivated this work (`abd0edc6-ea0f-45e7-97c6-ae7266ec9ae6`, 2026-09-28), 3 of 8 hits of one search were `exec` runs that an end-to-end test had started from a scratch `judge-cwd` directory (`81f038ce…`, `ad48b4d2…`, `e0c1987d…`). No parameter to bring them back is added; add one when someone needs it.
  Date/Author: 2026-09-28, user and Claude.

- Decision: in project scope and all-project scope, `clens_stats` leaves out sessions of kind `pipeline` and `exec`; a stats call for one explicit `session_id` shows that session whatever its kind. Sessions whose kind is NULL are kept.
  Rationale: the same reason as for search: those runs are programs, not the user's work. Today `exec` adds 2,086 tool calls (2.6%), 33 skill calls and 34 agent calls, and `pipeline` adds 64 tool calls. This slightly lowers numbers that existing project stats report, which is intended. NULL is kept because hand-built test rows and any legacy row carry no kind, and treating unknown as excluded would silently empty them.
  Date/Author: 2026-09-28, user and Claude.

- Decision: implement that exclusion once, in `src/analyzer/scope.ts`, plus the two hand-written queries in `src/analyzer/identity.ts`.
  Rationale: every analyzer builds its WHERE clause through `eventWhere` or `sessionScopedWhere` in `scope.ts`, so one change there covers tools, skills, agents, health, timeline and files. `analyzeIdentity` does not use those helpers for project and global scope (its comment at `src/analyzer/identity.ts:106` explains why), so it gets the same clause by hand. The only production caller of the analyzers is `src/mcp/stats.ts`; `clens stats` on the command line (`src/commands/stats_cmd.ts`) counts raw table rows and never calls them, so it is unaffected.
  Date/Author: 2026-09-28, Claude.

- Decision: `clens_session` gets no byte cap.
  Rationale: this was on `docs/BACKLOG.md`. Measured over 38 real calls: median 3,921 characters, 7 above 8,192, maximum 15,966. Of those 7, four were many 1,500 to 2,400-character assistant replies stacked up by a large `limit`, two were dominated by teammate messages of 4,000 to 5,000 characters stored as `user`, and one by a pasted list. The agent already controls size with `limit`; a byte cap would mostly hide messages. The user agreed to drop it.
  Date/Author: 2026-09-28, user and Claude.

- Decision: cap the lists `clens_stats` prints: files at 20 (`STATS_FILES_TOP`), tools at 30 (`STATS_TOOLS_TOP`), skills and slash commands at 20 each (`STATS_SKILLS_TOP`). When a list is cut, print one line saying how many entries were left out. The cut is done in `src/mcp/stats.ts`, not in the analyzers.
  Rationale: the user agreed to cut files to 20: in six real calls (median 9,060 characters, maximum 9,424) the 50-line "Files touched" list was 50 to 78% of the answer. The tool and skill caps were added while writing this plan, after measuring the all-project lists (see `Surprises & Discoveries`); without them an all-project answer with default sections would be around 17,000 characters, which defeats the purpose of `sections`. The analyzers stay unchanged because `analyzeFiles` is asserted to return up to 50 rows in `test/analyzer_b2.spec.ts` and the analyzers are generic dimension queries, while the cap is a presentation choice of this one tool. The user confirmed all four caps (tools 30, skills 20, slash commands 20, files 20) on 2026-09-28. The real-scale size acceptance in `Validation and Acceptance` (default all-project answer under 8,000 characters) depends on them, so changing a cap later means revisiting that acceptance too.
  Date/Author: 2026-09-28, user and Claude.

- Decision: the "+N more" line of a cut file list says the list stops at the top 50 when the analyzer returned its full 50 rows: `(+N more of the top 50)`; otherwise it is `(+N more)`. The tool, skill and slash-command lines are always `(+N more)`.
  Rationale: `analyzeFiles` stops at `LIMIT 50` (`src/analyzer/files.ts:29`), so in all-project scope N counts only rows 21 to 50 and would understate the real number of paths. Counting distinct paths would take another query over `file_op` on every call just to print one number that no usage question needs; saying where the list stops is honest and free. `analyzeTools` counts every tool name and `analyzeSkills` returns every skill and slash command, so their N is exact.
  Date/Author: 2026-09-28, Claude.

- Decision: session scope, including `"current"`, covers only that session's own rows. A Claude Code subagent's rows are not counted in its parent's stats.
  Rationale: since commit 43cf04c the indexer stores a Claude Code subagent transcript as a session of its own (`agent-<agentId>`, kind `subagent`, `parent_id` the parent), and session scope is `session_id = ?`. That matches what session stats are for: a subagent's tool outputs never enter the parent's context, so counting them would misstate where the parent's context went. Bundle 3's work record counts subagents on purpose, because edits a subagent makes are the parent's work. The `clens_stats` description says that session stats leave out the session's subagents.
  Date/Author: 2026-09-28, Claude.

- Decision: the server finds its current session with `detectCurrentSessionId(process.ppid, process.env)` in `src/mcp/current_session.ts`, on every request. It reads `~/.claude/sessions/<ppid>.json` (through `sessionsDir()` in `src/util/paths.ts`, so `CLENS_HOME` redirects it) and returns its string `sessionId`; when the file is missing, unreadable, malformed or has no string `sessionId`, it returns `CLAUDE_CODE_SESSION_ID` when non-empty, else `undefined`. It never throws. Every place in `src/mcp/server.ts` that used `process.env.CLAUDE_CODE_SESSION_ID` (search's current-turn exclusion, `clens_left_off`'s current-session exclusion, and the new `clens_stats` `"current"`) uses it instead. `resolveSessionId(value, currentSessionId)` keeps its exact contract; callers pass it the detected id. When nothing is detected (Codex sets neither), `"current"` returns an error telling the agent to pass an explicit `session_id`; Codex support is later work.
  Rationale: measured on 2026-09-28 (see `Surprises & Discoveries`): the env value goes stale on `/clear` because the MCP server is not restarted, while `<pid>.json` follows it. The server is a direct child of the `claude` process, so `process.ppid` names that file. Reading it per request (a few hundred bytes) is what makes `/clear` work, since the file changes while the server keeps running. This also fixes two existing bugs after `/clear`: search stops returning the current turn, and `clens_left_off` stops listing the current session. Risks, accepted by the user: the file is undocumented internal state and may change, but the fallback is today's behavior, so nothing gets worse than now; if the server is ever launched through a wrapper (`sh`, `npx`), `ppid` is the wrapper, the file is missing, and the env fallback applies. The process tree is not walked. The file's `pid` must equal `ppid`, a cheap sanity check; it cannot catch a stale file left by a `claude` process that exited uncleanly whose pid the OS later gave to the new parent, and that risk is accepted: on 2026-09-28 the directory held JSON files only for live `claude` processes (first 89612, 74505 and 32532; later nine files, every one a running `claude` according to `ps`), so Claude Code appears to remove the file on exit. The `*.key` files next to it are never read: the code opens only `<pid>.json`.
  Date/Author: 2026-09-28, user and Claude.

- Decision: before Milestone 1, remove every analyzer field and query that `clens_stats` never prints (Milestone 0).
  Rationale: the user said unused values may be deleted. The only production caller of `src/analyzer/*` is `src/mcp/stats.ts` (re-verified: `src/commands/stats_cmd.ts` counts raw rows and imports no analyzer; the other callers are `test/analyzer_b2.spec.ts`, `test/analyzer_b3.spec.ts`, `test/analyzer_b4.spec.ts` and `test/mcp_stats.spec.ts`). The unprinted work dominates all-project time (agents and tools were about 3.2 s of 4.7 s in the second timing run). It goes first, as its own milestone, for three reasons: it changes no printed output, so it can be proven with a before/after comparison of `projectStats` on one index snapshot, which is impossible once Milestone 1 changes the numbers on purpose; the timing gain is measured on today's scope code, cleanly separated from the kind filter Milestone 1 adds; and Milestone 1 then edits smaller analyzers. Removed: in `agents.ts`, `sidechain_events`, `subagent_session_ids`, `distinct_agents` and `by_type[].sample_descriptions` with its per-type query (kept: `agent_calls_total`, `by_type[].type`/`count`, `default_rate`); in `tools.ts`, `durations`, `sequence` and `total_calls`, with the query rewritten as one `GROUP BY name`; in `timeline.ts`, `longest_pause_s` and `thresholds` (checked: `longestPauseMs` feeds only that field, and `thresholds` only echoes the constants `THINK_LOWER_MS`/`THINK_UPPER_MS`, which stay because the wall/think/idle split uses them); in `health.ts`, `unresolved_tool_calls` and its query; in `skills.ts`, `by_project` and the `by_name` fields `sample_args` and `avg_tokens_per_call` with their per-skill sample query; in `files.ts`, `repeat_edits` and `total_ops` with their queries. `skills.ts` then no longer reads `event.in_tok`/`out_tok`/`cache_r`/`cache_w`, so the key-invariant sentence in `CLAUDE.md` that names it is updated; `health.ts` keeps reading `in_tok`, `cache_r` and `cache_w` for context bloat.
  Date/Author: 2026-09-28, user and Claude.

- Decision: after Milestone 0, `analyzeTools` returns `counts` with keys ordered by count descending, then by name, and `formatStats` breaks count ties by name. Tools with equal counts may therefore print in a different order than before; this is accepted.
  Rationale: today the keys come in first-use order, because the loop walks `tool_call` rows `ORDER BY ts` (`src/analyzer/tools.ts:47-64`), and the stable sort by count in `formatStats` (`src/mcp/server.ts:289`) keeps that order among ties. A `GROUP BY` without `ORDER BY` has no defined order, which would make the 30-entry cap pick different tools between runs. A fixed `ORDER BY n DESC, name` plus a name tie-break makes the order, and so the cap, deterministic. The Milestone 0 probe compares `tool_counts` by content (keys sorted) for this reason; every other field must be byte-identical.
  Date/Author: 2026-09-28, Claude.

- Decision: Milestone 0's 300 ms bound for `analyzeTools` counts as met.
  Rationale: the bound failed in 3 of 8 separate probe runs (1,314 / 720 / 1,481 ms), but in the same runs the unchanged `analyzeIdentity` and `analyzeHealth` spiked too, and the load average was 7.6, so the spikes are cold-page reads of a 1.6 GB snapshot, not the query. Interleaved in one process on the same snapshot, the new `GROUP BY` took 33 to 75 ms against 58 to 1,484 ms for the old row load, so the new query is never slower. The user was shown these numbers and told to continue.
  Date/Author: 2026-09-28, user and Claude.

- Decision (after code review, 2026-09-28): leave out the subagents that `exec` and `pipeline` sessions started, in search and in project/all-project stats, by checking the parent's kind in `workKindClause()` at query time.
  Rationale: the indexer stores every subagent file as kind `subagent` whatever started it (`deriveSessionKind`, `src/indexer/driver.ts:117`), so the first version still counted benchmark subagents: on the real index 38 subagent sessions (34 Claude, 4 Codex) have an `exec` or `pipeline` parent, with 256 tool calls. Deriving the kind from the parent's file at index time would make one file's rows depend on another's, which Gate 2 rules out. Only one level of parentage is checked; a subagent of a subagent of an `exec` run would still count. After the change, all-project stats measured 2,437 ms cold and 481 ms warm (before: 3,444 / 558 ms) and a search 18 to 59 ms. `workKindClause()` therefore no longer equals the two-condition string in `Interfaces and Dependencies`; see there. search.ts now uses `workKindClause("s")` instead of its own two conditions.
  Date/Author: 2026-09-28, user and Claude.

- Decision (after code review, 2026-09-28): other review fixes. The project and all-project no-data messages now say that exec/SDK runs and judge sessions are left out, so an agent does not re-derive a correct `project_id`. The skill, slash-command and file queries break count ties by name (`ORDER BY count DESC, sc.skill, s.source`, `count DESC, name`, `count DESC, path, tool`), as the tool list already did, so the caps are deterministic. The two cut lines of the skills section say which list they belong to: `(+N more skills)` and `(+N more slash commands)`. `project_id` and `session_id` in `StatsParamsSchema` are `.min(1)`, since an empty string would otherwise fall through to a wider scope. New tests cover the no-data messages, the left-out note, the skill/slash caps, the file heading and tie order, `searchText`'s partial note and context, and exec subagents in both stats and search; several of them pass on the code before the fix too, because they cover behavior that was already there but untested. The server handler branches (`"current"` error, `?? {}`, `query`/`queries`) stay covered only by the Milestone 3 end-to-end run: testing them directly would mean pulling the handler out of `server.ts`, which starts a server on import.
  Date/Author: 2026-09-28, user and Claude.

- Decision (after code review, 2026-09-28): `clens mcp` is documented, not fixed. It re-spawns `dist/mcp/server.js` as its child (`src/commands/mcp_cmd.ts:16`), so the server's `process.ppid` is that shim, `sessions/<ppid>.json` never exists, and `"current"` plus the search and `clens_left_off` exclusions fall back to `CLAUDE_CODE_SESSION_ID`, which stays on the pre-`/clear` session. The README now says to register `dist/mcp/server.js` directly and what `clens mcp` does not follow. A fix (the shim passing its own ppid in an env variable) was offered and deferred by the user.
  Date/Author: 2026-09-28, user and Claude.

- Decision: move `formatStats` from `src/mcp/server.ts` to `src/mcp/stats.ts`, and move the single-query search formatting from the server handler into a new `searchText` in `src/mcp/search.ts`.
  Rationale: the new behavior (headers, sections, caps, per-query sections) lives in these formatters, and tests import from `src/mcp/*.ts` modules, not from `server.ts`, which starts a server on import. The single-query output must stay byte-identical, which the existing handler code guarantees once moved as-is.
  Date/Author: 2026-09-28, Claude.


## Outcomes & Retrospective

2026-09-28, all milestones implemented and checked. `clens_stats` now answers for every project (no arguments), one project, one session or `session_id: "current"`, with `sections` and capped lists; project and all-project numbers leave out `exec` and `pipeline` sessions. `clens_search` takes `queries` (2-5) and leaves out `exec` sessions. The server finds the calling session through Claude Code's per-process `~/.claude/sessions/<ppid>.json`, which fixed search and `clens_left_off` after `/clear` and `/resume` (checked by the user). The analyzers no longer compute unprinted values: the all-project default call measured 558 ms warm and 3,444 ms cold on a 1,655-session index, 4,611 characters. Tests went from 308 to 332, all passing; `npm run typecheck` is clean.

A code review afterwards found no must-fix issue; its six improvements were applied (see the Decision Log), with `clens mcp` documented rather than fixed. Tests: 341, all passing.

Remaining in this plan: nothing. Out of scope and recorded above: `clens_recent` has no kind filter; teammate messages are stored as role `user`; `AGENTS.md` carries a stale invariant.

Lessons: timings on this machine swing by 10x or more with cold pages and load, so a single-run bound is not decidable; an interleaved comparison in one process was. A nonce for a manual search check must not appear in any earlier message, including the instructions for the check.


## Context and Orientation

The repository root is the directory that holds `package.json` (on the author's machine, `/Users/me/IdeaProjects/clens`). All paths below are relative to it. It is TypeScript with `"type": "module"` and `module: NodeNext`, so every relative import ends in `.js` even though the file is `.ts` (for example `import { resolveSessionId } from "./current_session.js";`). The compiler runs with `strict` and `noUncheckedIndexedAccess`, so indexing an array gives `T | undefined`. Only `src/` is type-checked by `npm run typecheck`; tests in `test/*.spec.ts` run under Vitest, which does not type-check them.

The index is a SQLite file, `index.db`, built by the indexer (`src/indexer/`). Its location comes from `src/util/paths.ts`: normally `~/.clens/index.db`, but tests and manual runs must redirect every path with environment variables so nothing reads the real `~/.claude/` or `~/.codex/`: `CLENS_HOME` replaces `~/.claude/` (where Claude Code keeps transcripts under `projects/<project>/<session>.jsonl`), `CLENS_CODEX_HOME` replaces `~/.codex/`, and `CLENS_INDEX_DIR` replaces `~/.clens/`. The MCP server opens the index read-only (`getDb()` in `src/mcp/server.ts`) and also runs a file watcher that re-indexes changed transcripts, which is why the end-to-end run below sets all three variables.

Tables that matter here: `session` has one row per conversation with `id`, `project_id`, `kind`, `started_at` and more. A project id is a working-directory path with every `/` replaced by `-` (for Claude transcripts it is the name of the directory the transcript sits in). `event` has one row per transcript line, `tool_call` one row per tool the assistant called (`name`, `is_error`, `input_json`), `file_op` one row per Read/Edit/Write of a path, `skill_call`, `agent_call` and `slash_command` one row per use, and `user_text` holds the searchable user and assistant messages.

`session.kind` says what started a session. `interactive` is a person talking to Claude Code or Codex. `subagent` is an agent thread another session started (its "user" is the parent agent). `exec` is a one-shot programmatic run: a Claude Code transcript whose `entrypoint` field starts with `sdk-` (set in `parseFileBody`, `src/indexer/claude_parser.ts`) or a Codex `codex exec` run. `pipeline` marks transcripts of clens's former background "judge", which no longer runs but whose transcripts remain on disk. `kind` can be NULL in hand-built test rows.

`src/mcp/stats.ts` implements `clens_stats`. Its `projectStats(db, params)` (line 56) builds a `Scope` and calls one analyzer per dimension: `analyzeIdentity`, `analyzeTools`, `analyzeSkills`, `analyzeAgents`, `analyzeHealth`, `analyzeTimeline`, `analyzeFiles`, each in `src/analyzer/<name>.ts`. Today `params.project_id` is required, and the scope is either `{ mode: "session" }` when `session_id` is given or `{ mode: "project" }`. `src/analyzer/scope.ts` defines `Scope` (line 25) with four modes, `global`, `session`, `project`, `since`, and the two helpers `eventWhere` (line 32) and `sessionScopedWhere` (line 55) that turn a scope into a SQL fragment plus bind values. `global` and `since` exist and the analyzers already handle them (`test/analyzer_b4.spec.ts` uses `global`), but `clens_stats` never builds them. `analyzeIdentity` (`src/analyzer/identity.ts`) writes its own SQL for `project` (line 105) and for `global`/`since` (line 142); in `global` it counts sessions from `event` and projects from `project`, and it returns no primary model.

`src/mcp/server.ts` declares each tool twice: a zod schema that validates arguments (`SearchParamsSchema` line 56, `StatsParamsSchema` line 75) and a JSON schema that Claude Code shows the agent (`clens_search` from line 100 with `required: ["query"]` at line 144; `clens_stats` from line 247 with `required: ["project_id"]` at line 270). `formatStats` (line 276) turns `StatsFacts` into text. The `CallToolRequestSchema` handler starts at line 330: the `clens_search` branch (line 331) calls `searchWithTotal`, fills `context` neighbours with `neighborsOf` from `src/mcp/session.ts`, formats with `formatSearchResults`, and prefixes a note when `partial` is true; the `clens_stats` branch is at line 402.

`src/mcp/search.ts` implements keyword search: FTS5 (SQLite's full-text search engine) over `user_text`, in several layers merged by rank. `buildWhere` (line 315) builds the WHERE clause every layer uses; line 342 is `conditions.push("s.kind IS NOT 'pipeline'");` and line 345 adds `s.kind IS NOT 'subagent'` for `role: "user"` searches. `searchWithTotal` (line 594) runs one query and reports `results`, `totalMatched` and `partial` (true when no message held every word and it fell back to messages holding some). `formatSearchResults` (line 112) fits results into a byte budget, always keeping the top hit, and appends a "+N more" footer. `DEFAULT_SEARCH_MAX_BYTES` is 8,192. `src/mcp/instructions.ts` holds `SERVER_INSTRUCTIONS` and `SEARCH_DESCRIPTION`; Claude Code cuts each at 2,048 characters, and `test/mcp_instructions.spec.ts` asserts both fit.

Premise check. This plan relies on three things. First, that the server can tell which Claude Code session it serves. `CLAUDE_CODE_SESSION_ID` (comment at `src/mcp/server.ts:337`) is right at session start but was measured to go stale after `/clear`, because the MCP server keeps running. Claude Code's own per-process file `~/.claude/sessions/<pid>.json` follows `/clear`, and the server is a direct child of `claude`, so `process.ppid` names it (see `Surprises & Discoveries`). The plan reads that file per request and falls back to the env value. `/resume` has not been checked yet; Milestone 3 does. Second, that `session.kind` is filled for real sessions, which the indexer does (`exec` from `entrypoint`, `pipeline` from the judge directory, `subagent`, otherwise `interactive`). Third, that all-project stats are fast enough on the server's synchronous request path: 2.9 to 4.7 s measured on a 451,266-event index before Milestone 0, most of it unprinted work that Milestone 0 removes, and `sections` lets an agent skip slow parts. What would break the plan: a much larger index, or Claude Code changing or dropping `sessions/<pid>.json` (then `"current"` and the search/left_off exclusions fall back to today's env behavior, which is right until the first `/clear`).

Demand reality. The user is the sole developer and main user of clens and is dropping the context-mode plugin, so clens must cover the analysis the user relied on it for. In session `abd0edc6-ea0f-45e7-97c6-ae7266ec9ae6` (2026-09-28) the user asked how much the ECC plugin was used across all work. `clens_stats` only accepts one project, so the agent scanned 1,051 transcript files by hand. It had no way to name its own session and guessed the id from its scratch directory path. It called `clens_search` four times in a row for related words, and 3 of the 8 hits of one call were `exec` test runs. This plan removes each of those workarounds. The narrowest useful version is exactly the six items above; nothing else is added.


## Plan of Work

Milestone 0 removes what the analyzers compute but `clens_stats` never prints. At the end of it, `projectStats` returns exactly what it returned before on the same index snapshot, while all-project stats run faster. It comes first so that equality can be checked: Milestone 1 changes the numbers on purpose, after which no before/after comparison is possible. Proof: the before/after `projectStats` dumps in `Concrete Steps` are identical, the after timings are lower, and `npm test` is green.

In `src/analyzer/agents.ts`, delete from `AgentsFacts` and from `analyzeAgents` the fields `sidechain_events`, `subagent_session_ids` and `distinct_agents`, the two `is_sidechain = 1` queries on `event` that fill the first two, and `by_type[].sample_descriptions` with the per-type `SELECT description … LIMIT 3` query in the `byTypeRows.map`. `AgentByType` becomes `{ type, count }`. Keep `agent_calls_total`, `by_type` and `default_rate`. The `eventWhere` import and `eventScope` become unused; remove them.

In `src/analyzer/tools.ts`, `ToolsFacts` becomes `{ counts: Record<string, number>; errors: number }`. Replace the row-by-row loop with one query, `SELECT name, COUNT(*) AS n, SUM(is_error) AS errors FROM tool_call WHERE <scope> GROUP BY name ORDER BY n DESC, name`; build `counts` from `name`/`n` in that row order, so its keys run by count and then by name, and sum `errors` (treat a NULL sum as 0). Today `counts` gets its keys in first-use order, because the loop walks rows `ORDER BY ts` (`src/analyzer/tools.ts:47-64`), and `projectStats` passes the object through (`src/mcp/stats.ts:104`); the fixed `ORDER BY` replaces that with an order that does not depend on SQLite's grouping. In the same milestone, make the tool sort in `formatStats` (still in `src/mcp/server.ts`, line 289) break count ties by name: `.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))`. Plain `<` is used rather than `localeCompare` so the order does not depend on the machine's locale. That keeps the printed order, and later the 30-entry cap, deterministic. Delete `durations`, `sequence`, `total_calls`, `SEQUENCE_TAIL_MAX`, `percentile` and the `ToolRow` interface, and update the file's header comment, which mentions sequences and durations.

Fix the header comments that describe removed values, or the acceptance `grep` below will trip on them: in `src/analyzer/agents.ts`, lines 4-13 say the output reports `agent_call` counts and `event.is_sidechain` counts side by side, so reduce that paragraph to the `agent_call` source and `default_rate`; in `src/analyzer/health.ts`, delete the `unresolved_tool_calls` bullet at lines 5-6; in `src/analyzer/skills.ts`, delete the `tokens_per_call` paragraph at lines 19-22 and, at lines 62-64, the comment's mention of the "samples sub-query" (the `sc.` alias reason still holds for the by_name join with `session`).

In `src/analyzer/timeline.ts`, delete `longest_pause_s` and `thresholds` from `TimelineFacts` and the `longestPauseMs` bookkeeping in the loop. Keep `THINK_LOWER_MS` and `THINK_UPPER_MS`: the wall/think/idle split uses them. In `src/analyzer/health.ts`, delete `unresolved_tool_calls` and its query (the `tool_call` join to `event` and `file_cursor`); the context-bloat query that reads `in_tok`/`cache_r`/`cache_w` stays. In `src/analyzer/skills.ts`, `SkillByName` becomes `{ name, source, count }`: delete `sample_args`, `avg_tokens_per_call`, the per-skill sample query in the `byNameRows.map` (the only place `skills.ts` reads token columns), the `SampleRow` interface, and `by_project` with its query. In `src/analyzer/files.ts`, `FileFacts` becomes `{ top }`: delete `repeat_edits`, `total_ops` and their two queries. `src/mcp/stats.ts` reads only kept fields today (check with `npm run typecheck`: a removed field it still read would fail to compile).

Update the tests that read removed fields. In `test/analyzer_b2.spec.ts`: in "D4 tools: Edit is the most-called tool" drop the `durations` assertion; delete "D4 tools: sequence is non-empty and chronological"; in "D6 timeline: wall ≥ think ≥ 0…" drop the two `thresholds` assertions; delete "D7 files: repeat_edits flags paths edited ≥3 times" and "D6 timeline: longest_pause_s is the max gap observed". In `test/analyzer_b3.spec.ts`: in "D9 health: tool_errors and unresolved_tool_calls are non-negative ints" drop the two `unresolved_tool_calls` assertions and rename the case to "D9 health: tool_errors is a non-negative int". In `test/analyzer_b4.spec.ts`: in "by_name sums Skill tool_uses…" drop the `sample_args` assertion, and delete "avg_tokens_per_call uses the assistant event's (in+out+cache_r+cache_w) window". Add one case to `test/analyzer_b2.spec.ts` that `analyzeTools(db, SESSION).errors` equals the number of `tool_call` rows with `is_error = 1` for that session (read with a direct `SELECT COUNT(*)`), and that the keys of `counts` run by count descending, then by name. The `errors` part is a regression guard: it passes before the rewrite too, and must still pass after. The key-order part fails before (first-use order) and passes after.

In `CLAUDE.md` at the repository root, the "Key invariants" bullet on `event.in_tok/out_tok/cache_r/cache_w` says `health.ts` (context bloat) and `skills.ts` (tokens_per_call) read those columns. Replace it with one that is exact after Milestone 0: the four columns are populated but not surfaced as cost/token reporting; `health.ts` (context bloat) still reads `in_tok`, `cache_r` and `cache_w` directly via SQL, and no analyzer reads `out_tok`; do not drop these columns without updating `health.ts` first. Do not edit `AGENTS.md` (untracked in this repository and not maintained here), even though it carries an older copy of the same sentence.

Milestone 1 makes `clens_stats` scope-flexible. At the end of it, `clens_stats` with no arguments reports every project, `session_id: "current"` reports the calling session, `sections` limits the output, lists are capped, and project and all-project numbers leave out `exec` and `pipeline` sessions. Proof: new cases in `test/mcp_stats.spec.ts` and `test/mcp_current_session.spec.ts` fail before and pass after, except the two marked below as regression guards, which pass both before and after; and `npm test` stays green.

Create `src/mcp/current_session.ts`. It exports the constant `CURRENT_SESSION = "current"` and the function `resolveSessionId(value, currentSessionId)`. If `value` is not `"current"`, return `{ ok: true, id: value }`. If it is and `currentSessionId` is a non-empty string, return `{ ok: true, id: currentSessionId }`. Otherwise return `{ ok: false, error: 'session_id "current" is not available here: this client does not tell clens which session it is (Codex does not). Pass an explicit session_id, for example one from a clens_search or clens_left_off result.' }`. `resolveSessionId` touches neither the environment nor the file system; callers pass it the detected id, and bundles 2 and 3 use it unchanged (bundle 3's `clens_left_off` resolves `"current"` through it).

The same module exports `detectCurrentSessionId(pid: number, env: NodeJS.ProcessEnv): string | undefined`. It reads `join(sessionsDir(), `${pid}.json`)`, where `sessionsDir()` is the existing, so far unused, export of `src/util/paths.ts` (line 36, `claudeHome()/sessions`, so `CLENS_HOME` redirects it in tests; do not confuse it with the `sessionsDir()` method of the source adapters in `src/indexer/sources.ts`, which points at `projects/`). If the file exists, parses as JSON, has a non-empty string `sessionId`, and its `pid` field equals the `pid` argument (a cheap check that the file describes that process), return the `sessionId`. In every other case (no file, unreadable, malformed JSON, `sessionId` missing, empty or not a string, `pid` missing or different) return `env.CLAUDE_CODE_SESSION_ID` when it is a non-empty string, else `undefined`. Wrap the read and parse in one `try`/`catch` so it never throws. Read only that one file: the same directory holds `*.key` files that clens must never open, so never list the directory or glob it. Put a comment above the function saying this is Claude Code's undocumented per-process state, that it follows `/clear` while `CLAUDE_CODE_SESSION_ID` does not (measured 2026-09-28), and that the env fallback keeps today's behavior when the file is absent (Codex, a wrapper process between `claude` and the server, or a future Claude Code without the file).

In `src/mcp/server.ts`, replace every `process.env.CLAUDE_CODE_SESSION_ID` with `detectCurrentSessionId(process.ppid, process.env)`, evaluated inside the request handler on each call, never cached at startup, because the file changes on `/clear` while the server keeps running. Today that is two places: the `currentSessionId` option of the `clens_search` branch (line 340) and of the `clens_left_off` branch (line 394); the new `clens_stats` branch below is the third. Update the comment at lines 337-338 to say where the id comes from. This fixes two existing bugs after `/clear`: search leaving the current turn in its results (it matches its own words and comes back as a top hit), and `clens_left_off` listing the session it is called from.

In `src/analyzer/scope.ts`, add and export `workKindClause(alias?: string): string`, which returns `(kind IS NOT 'pipeline' AND kind IS NOT 'exec')`, wrapped in parentheses like `realProjectClause` in the same file so it can be ANDed into any WHERE safely, with `alias.` prefixed on both `kind` references when an alias is given. `IS NOT` is used rather than `NOT IN` because `NOT IN` is NULL for a NULL kind, which would drop kind-less rows. Then change both helpers. In `eventWhere` and `sessionScopedWhere`, mode `global` returns `<column> IN (SELECT id FROM session WHERE <workKindClause()>)` instead of `1=1`, where `<column>` is `${eventAlias}.session_id` in `eventWhere` and `sessionIdColumn` in `sessionScopedWhere`. Mode `project` changes its sub-select to `SELECT id FROM session WHERE project_id = ? AND <workKindClause()>`. Mode `since` becomes the `ts >= ?` condition AND the same `IN (...)` clause. Mode `session` stays exactly as it is. Update the file's top comment to say project, global and since scopes leave out `pipeline` and `exec` sessions and why.

In `src/analyzer/identity.ts`, the `project` case (line 105) adds `AND <workKindClause("s")>` to the WHERE of both of its queries (the session count and the model query), next to `s.project_id = ?`. The `global`/`since` case (line 142) counts sessions with `FROM event e WHERE e.session_id IN (SELECT id FROM session WHERE <workKindClause()>)`, adding `AND e.ts >= ?` for `since`. Leave its `projects` and `files` counts as they are: they describe the corpus, and `clens_stats` does not print them. Import `workKindClause` from `./scope.js`.

In `src/mcp/stats.ts`, add the section type and constants listed in `Interfaces and Dependencies`, make `project_id` optional in `StatsParams`, add `sections`, and change `StatsFacts` as specified there. `projectStats` builds the scope like this: with `session_id`, `{ mode: "session" }` and `since` ignored (as today); else with `project_id`, `{ mode: "project" }` with `since` when given; else with `since`, `{ mode: "since" }`; else `{ mode: "global" }`. The caller resolves `"current"` before calling, so `projectStats` never sees that word. `analyzeIdentity` is always called. Each other analyzer is called only when its section is requested (`sections` defaults to all of `STATS_SECTIONS`), which keeps the file's rule that it "computes nothing it does not return": tools needs `analyzeTools`, skills `analyzeSkills` (both `skills` and `slash_commands` come from it), agents `analyzeAgents`, health `analyzeHealth`, timeline `analyzeTimeline`, files `analyzeFiles`. Fields of sections not requested stay `undefined`. For the `global`/`since` identity kinds, set `sessions` from `identity.global.sessions`, `started_at`/`ended_at` from `earliest_event`/`latest_event`, `project_id` and `primary_model` to null. Copy the analyzers' lists whole into `StatsFacts`; the caps are applied only when formatting, so `StatsFacts` stays a faithful record and tests can see full lists.

Move `formatStats` from `src/mcp/server.ts` into `src/mcp/stats.ts` and export it. Its header becomes one `Scope:` line: `Scope: session <session_id> in project <project_id>` (or `in project ?` when unknown), `Scope: project <project_id>`, or `Scope: all projects`. After it, for project and all-project scope, print `Leaves out one-shot exec/SDK runs and clens judge (pipeline) sessions.`, then the existing `Sessions:` and `Primary model:` lines. The no-data message depends on scope: session, `No data found for session <id>. Check the session_id.`; project, the existing message; all projects, `No data found in any project. Widen or remove the since filter.` Then print only the requested sections, in the fixed order tools, skills, agents, health, timeline, files, with today's line formats. Cap the tool list at `STATS_TOOLS_TOP` entries by count (ties by name, the sort set in Milestone 0; keep it when moving the function), the skill list and the slash-command list at `STATS_SKILLS_TOP` each, and the file list at `STATS_FILES_TOP`. When a list is cut, append a line `  (+N more)` where N is how many entries were not shown, except for a file list whose analyzer result had the full 50 rows (`analyzeFiles` stops at `LIMIT 50`, `src/analyzer/files.ts:29`): there the line is `  (+N more of the top 50)`, because more paths may exist beyond the 50 (see the Decision Log). The file section heading becomes `Files touched (top 20 paths):` only when it was cut. `Tool errors:` keeps counting all tools, not only the shown ones.

In `src/mcp/instructions.ts`, add `export const STATS_DESCRIPTION`, the new `clens_stats` tool description, next to `SEARCH_DESCRIPTION` and with the same kind of comment (Claude Code cuts every tool description at 2,048 characters). It drops today's "ALWAYS pass project_id" and says, in at most about 900 characters: what the stats cover; the three scopes (one project with `project_id`, one session with `session_id`, every project when both are omitted); that `session_id: "current"` is this conversation in Claude Code; that session stats count only that session's own calls and leave out the subagents it started; that project and all-project stats leave out one-shot exec/SDK runs and judge transcripts; that `sections` keeps the answer short; and today's sentence that points message lookups to `clens_search`/`clens_recent`. In `test/mcp_instructions.spec.ts`, import it and add `expect(STATS_DESCRIPTION.length).toBeLessThanOrEqual(2048);` to the existing case.

In `src/mcp/server.ts`: change `StatsParamsSchema` to `project_id: z.string().optional()`, keep `session_id` and `since`, and add `sections: z.array(z.enum(STATS_SECTIONS)).min(1).optional()`. In the `clens_stats` tool entry, set `description: STATS_DESCRIPTION` (imported from `./instructions.js`); in its JSON schema, remove `required: ["project_id"]`, describe `project_id` as optional ("Omit, together with session_id, for every project"), describe `session_id` as also accepting `"current"` for this conversation in Claude Code, and add `sections` as `{ type: "array", items: { type: "string", enum: [...STATS_SECTIONS] }, description: "Only these sections (default: all). The scope line and session count are always included." }`. Building the enum from `STATS_SECTIONS` means bundle 2 only edits the tuple and the type in `src/mcp/stats.ts`. In the handler, parse with `StatsParamsSchema.safeParse(req.params.arguments ?? {})`, as the `clens_left_off` branch already does (`src/mcp/server.ts:389`): zod 4 (the repo uses 4.4.3) rejects `undefined` for an object schema, and a call with no arguments is now the ordinary all-project call. When `session_id` is present, call `resolveSessionId(parsed.data.session_id, detectCurrentSessionId(process.ppid, process.env))`; on `ok: false` return `{ content: [{ type: "text", text: result.error }], isError: true }`; on success pass the resolved id on. Replace the local `formatStats` with the import from `./stats.js` and delete the old function. Also update the header comment of `server.ts` so its `clens_stats` line no longer says "for a project".

Update `skills/clens-stats/SKILL.md`, the skill shipped in this repo that agents follow for usage questions. Under "How to call it", step 1 (around line 41) says to derive `project_id` from the cwd; keep that as the default for questions about the current project, and add that `project_id` is omitted (together with `session_id`) when the user asks about every project ("전체", "모든 프로젝트", "across all my work"), and that `session_id: "current"` answers questions about this conversation. Step 4 (around line 54) says to call the tool "with `project_id` (required)"; change it to say `project_id` is optional, and that `sections` (tools, skills, agents, health, timeline, files) should be passed when the question needs only some of them. Under "Presenting the result" (around line 63), replace the advice that points only at `project_id` derivation with the three no-data messages (`No data found for project …`, `No data found for session …`, `No data found in any project …`) and what to check for each, and add that lists end with a `(+N more)` line when cut, so a count list is never presented as complete. Leave the rest of the skill, including its one-month default for `since`, as it is.

Update `docs/BACKLOG.md`: its "Later" list has the entry "Cap the size of `clens_session`". Move it to the "Decided for now" list, dated 2026-09-28, saying the size is left to `limit` and why, with the measurement from this plan's Decision Log (38 calls, median 3,921 characters, 7 above 8,192, maximum 15,966, and the three causes).

Extend `test/mcp_stats.spec.ts` (it seeds an in-memory database with `applySchema`; seed rows have NULL kind). Add a seed variant with sessions of kind `interactive`, `exec` and `pipeline` in the same project, each with one tool call, and cover: all-project stats sum every work session across projects and leave out `exec` and `pipeline`; project stats leave them out too; an explicit `session_id` of the `exec` session still returns its tool call (a regression guard: session scope is already `session_id = ?` with no kind filter, `src/analyzer/scope.ts:36-37,63-64`, so this passes before the change too; it must still pass after); `since` without `project_id` gives the `since` scope; `sections: ["tools"]` leaves `skills`, `agents`, `health`, `timeline` and `files` undefined and `formatStats` prints `Tool usage:` but not `Files touched`; `formatStats` prints `Scope: all projects`, `Scope: project proj-a` and `Scope: session s1 in project proj-a` in the three scopes; a file list of 25 paths prints 20 and `(+5 more)`, a file list of 60 paths (so the analyzer returns its full 50) prints 20 and `(+30 more of the top 50)`, a tool list of 35 names prints 30 and `(+5 more)`; a stats call for a parent session leaves out the tool calls of its `agent-<id>` subagent session (seed one with kind `subagent` and `parent_id` the parent; also a regression guard for the same reason, passing before and after). Keep every existing case passing unchanged; they call `projectStats` with `project_id`, which still works. Create `test/mcp_current_session.spec.ts`. For `resolveSessionId`, cover its three branches (a plain id passes through; `"current"` with an id; `"current"` without one gives the error). For `detectCurrentSessionId`, create a temporary directory with `mkdtempSync`, set `process.env.CLENS_HOME` to it (and delete the variable in `afterEach`), make `<tmp>/sessions/`, and pass an `env` object literal rather than `process.env`, using a made-up pid such as `424242`. Cases, all with env `{ CLAUDE_CODE_SESSION_ID: "from-env" }` unless stated: `sessions/424242.json` with `{"sessionId":"from-file","pid":424242}` gives `from-file`; no file gives `from-env`; a file holding `not json` gives `from-env`; `{"sessionId":42,"pid":424242}` gives `from-env`; `{"sessionId":"","pid":424242}` gives `from-env`; `{"sessionId":"from-file","pid":999}` (pid mismatch) gives `from-env`; `{"sessionId":"from-file"}` (no `pid`) gives `from-env`; no file and env `{}` gives `undefined`; no file and env `{ CLAUDE_CODE_SESSION_ID: "" }` gives `undefined`. None of these may touch the real `~/.claude/`. Run `npx vitest run test/analyzer_b2.spec.ts test/analyzer_b3.spec.ts test/analyzer_b4.spec.ts` as well: their fixtures are `interactive` Claude and Codex sessions, so their numbers must not move.

Milestone 2 changes `clens_search`. At the end of it, search never returns `exec` sessions, and `queries` runs up to five searches in one call. Proof: new cases in `test/mcp_search.spec.ts`, and the unchanged single-query cases still pass.

In `src/mcp/search.ts`, in `buildWhere` right after line 342, add `conditions.push("s.kind IS NOT 'exec'");` with a one-line comment saying one-shot programmatic runs (mostly benchmarks and tests started with `claude -p` or `codex exec`) are not the user's conversations. Then add `searchText`, which contains exactly what the server's `clens_search` branch does today between parsing and returning: call `searchWithTotal`, fill `r.context = neighborsOf(db, r.session_id, r.ts, context)` for each result when `context > 0`, call `formatSearchResults(results, maxBytes, totalMatched, allProjects)`, and prefix `No message contains every word of the query; these contain some of them.\n\n` when `partial` is true. Import `neighborsOf` from `./session.js`; `session.ts` imports nothing from `search.ts`, so this creates no import cycle. Add `searchManyText`. Each section starts with the header line `### query: <the query as given>` and sections are joined by a blank line (`\n\n`). The headers and joiners count toward `maxBytes`: first compute `overhead`, the UTF-8 byte length (`Buffer.byteLength`) of every header plus its trailing `\n`, plus 2 bytes per joiner (`queries.length - 1` of them); then give each query `Math.max(0, Math.floor((maxBytes - overhead) / queries.length))` bytes. Run `searchText` once per query with that budget and the same filters, `limit`, `context` and options. Because `formatSearchResults` always keeps its top hit, each query's best hit survives even when its share of the budget is small, and the partial-match note stays inside the section it belongs to.

In `src/mcp/server.ts`, change `SearchParamsSchema` so `query` is `z.string().min(1).optional()`, add `queries: z.array(z.string().min(1)).min(2).max(5).optional()`, and add `.refine((p) => (p.query === undefined) !== (p.queries === undefined), { message: "Pass exactly one of query or queries." })`. In the `clens_search` JSON schema, remove `required: ["query"]` and add a `queries` property of type array of strings with the description: "Instead of query: 2-5 queries run as separate searches with the same filters and limit, in one call. The answer has one section per query; maxBytes is shared evenly among them." In the handler, compute `maxBytes` (default `DEFAULT_SEARCH_MAX_BYTES`), `context`, `allProjects` and the `currentSessionId` option as today, then return `searchManyText(...)` when `queries` is set and `searchText(...)` otherwise. The refine does not narrow the inferred type: after parsing, `parsed.data.query` is still `string | undefined`, while `SearchParams.query` is `string`. So branch explicitly: `const { query, queries, ...rest } = parsed.data; if (queries !== undefined) { …searchManyText(db, rest, queries, …) } else if (query !== undefined) { …searchText(db, { ...rest, query }, …) }`, with a final `else` that returns the same "Pass exactly one of query or queries." error (unreachable after the refine, but it keeps the types honest without a `!`). In `src/mcp/instructions.ts`, add to `SEARCH_DESCRIPTION`, after the sentence about `context`, the sentence `Pass queries (2-5) instead of query to run several searches in one call.`; the result must stay at most 2,048 characters (it is 1,756 today). Do not touch `SERVER_INSTRUCTIONS`.

Extend `test/mcp_search.spec.ts`. In the "rows that are not conversation" describe block (around line 1029), add an `exec` session with a matching row and assert it is not returned. Add a describe block for `searchManyText` that seeds the database with the file's `seed()` and asserts: two queries give two `### query:` headers in the given order; a query with no hits gives its header followed by `No results found.`; with a small `maxBytes` each section still contains its top hit; the headers are paid for out of `maxBytes` (for two queries and `maxBytes` 2,000, the answer equals `"### query: " + q1 + "\n" + searchText(q1, per) + "\n\n" + "### query: " + q2 + "\n" + searchText(q2, per)` where `per` is `Math.floor((2000 - overhead) / 2)` computed as in `Plan of Work`; note that, as today, `formatSearchResults` appends its "+N more" footer and `searchText` its partial-match note outside the budget, so a byte-for-byte comparison is the check, not a size bound); and `searchText` on one query returns exactly what `formatSearchResults` returned before for the same input (compare against a direct `searchWithTotal` plus `formatSearchResults` call).

Milestone 3 proves the behavior end to end and at real scale, and checks current-session detection in a real Claude Code terminal, including `/resume`, which was not measured when this plan was written. Nothing in `src/` changes in this milestone; if the manual check fails, record it and ask the user (see `Idempotence and Recovery`). The steps are in `Concrete Steps` and the pass criteria in `Validation and Acceptance`; paste the transcripts into `Artifacts and Notes` and the timings and the manual-check results into `Surprises & Discoveries`.


## Concrete Steps

Run everything from the repository root.

Milestone 0, before any edit. Take a consistent read-only snapshot of the developer's index (the live file is in WAL mode and changes while the MCP watcher runs, so do not compare against it directly), then record the "before" timings and `projectStats` output. Skip the timing and comparison on a machine without `~/.clens/index.db`; the tests still apply.

Every path in this step is fixed (`/tmp/clens-m0/`), because shell variables do not survive between separate command runs, and the "after" run happens after many other commands. If `/tmp/clens-m0/` already exists from an earlier attempt, delete it first so the snapshot is fresh.

    rm -rf /tmp/clens-m0 && mkdir -p /tmp/clens-m0
    sqlite3 -readonly ~/.clens/index.db ".backup '/tmp/clens-m0/snap.db'"
    cat > ./.m0-probe.ts <<'EOF'
    import Database from "better-sqlite3";
    import { analyzeIdentity } from "./src/analyzer/identity.ts";
    import { analyzeTools } from "./src/analyzer/tools.ts";
    import { analyzeSkills } from "./src/analyzer/skills.ts";
    import { analyzeAgents } from "./src/analyzer/agents.ts";
    import { analyzeHealth } from "./src/analyzer/health.ts";
    import { analyzeTimeline } from "./src/analyzer/timeline.ts";
    import { analyzeFiles } from "./src/analyzer/files.ts";
    import { projectStats } from "./src/mcp/stats.ts";
    // fileMustExist: without it a wrong path silently opens an empty database.
    const db = new Database("/tmp/clens-m0/snap.db", { readonly: true, fileMustExist: true });
    const scope = { mode: "global", params: {} };
    const fns = { analyzeIdentity, analyzeTools, analyzeSkills, analyzeAgents, analyzeHealth, analyzeTimeline, analyzeFiles };
    for (const [n, f] of Object.entries(fns)) { const t = performance.now(); f(db, scope); console.error(n, Math.round(performance.now() - t), "ms"); }
    const stats = projectStats(db, { project_id: "-Users-me-IdeaProjects-clens" });
    // The tool_counts key order changes on purpose (first use -> count, name); compare its content only.
    stats.tool_counts = Object.fromEntries(Object.entries(stats.tool_counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    console.log(JSON.stringify(stats));
    EOF
    npx tsx ./.m0-probe.ts > /tmp/clens-m0/before.json

The timings go to the terminal (stderr); the `projectStats` dump goes to `/tmp/clens-m0/before.json`. Write the before timings into `Progress` right away so they survive. The probe lives in the repository root only so that `better-sqlite3` and the `./src/...` imports resolve; it is deleted in the last step below and must never be committed. Use any project id that exists in the snapshot if `-Users-me-IdeaProjects-clens` does not, and use the same one after. The dump sorts `tool_counts` keys by name before printing, because Milestone 0 changes their order on purpose (see the Decision Log); every other field is dumped exactly as `projectStats` returns it. After Milestone 0's edits, run the same probe against the same snapshot and compare:

    npx tsx ./.m0-probe.ts > /tmp/clens-m0/after.json
    cmp /tmp/clens-m0/before.json /tmp/clens-m0/after.json && echo IDENTICAL
    rm -f ./.m0-probe.ts

`cmp` printing nothing and `IDENTICAL` appearing is the pass. Keep `/tmp/clens-m0/` until Milestone 0 is closed in case you re-run, then delete it with `rm -rf /tmp/clens-m0`. Paste both timing lists into `Surprises & Discoveries`.

During Milestones 0, 1 and 2, after each group of edits:

    npm run typecheck
    npx vitest run test/mcp_current_session.spec.ts test/mcp_stats.spec.ts
    npx vitest run test/analyzer_b2.spec.ts test/analyzer_b3.spec.ts test/analyzer_b4.spec.ts
    npx vitest run test/mcp_search.spec.ts test/mcp_instructions.spec.ts
    npm test

`npm run typecheck` prints nothing on success. Vitest ends with a summary line such as `Test Files  N passed (N)` and `Tests  M passed (M)`; any `failed` count means stop and fix.

Milestone 3, end to end. Build, then index the fixture into a temporary home so nothing touches the real `~/.claude/` or `~/.clens/`:

    npm run build
    E2E=/tmp/clens-m3
    rm -rf "$E2E" "$E2E.out"
    mkdir -p "$E2E/claude/projects/p1" "$E2E/codex" "$E2E/clens"
    cp test/fixtures/brainstorm-session.jsonl "$E2E/claude/projects/p1/test.jsonl"
    CLENS_HOME="$E2E/claude" CLENS_CODEX_HOME="$E2E/codex" CLENS_INDEX_DIR="$E2E/clens" node dist/cli.js index

The scratch directory is the fixed path `/tmp/clens-m3` (like Milestone 0's `/tmp/clens-m0/`), because shell variables do not survive between separate command runs: every block below starts by setting `E2E=/tmp/clens-m3` and `OUT=/tmp/clens-m3.out` again, so each block can run as its own command. The fixture is one interactive Claude Code session whose id is `test`; it lands in project `p1` (the directory name). Then drive the built server with the MCP SDK client. Run this from the repository root so `@modelcontextprotocol/sdk` resolves from `node_modules`:

    E2E=/tmp/clens-m3
    OUT=/tmp/clens-m3.out
    E2E="$E2E" node --input-type=module > "$OUT" <<'EOF'
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
    const base = { PATH: process.env.PATH, CLENS_HOME: `${process.env.E2E}/claude`,
      CLENS_CODEX_HOME: `${process.env.E2E}/codex`, CLENS_INDEX_DIR: `${process.env.E2E}/clens` };
    async function session(env, calls) {
      const client = new Client({ name: "e2e", version: "0" });
      await client.connect(new StdioClientTransport({ command: "node", args: ["dist/mcp/server.js"], env }));
      for (const [name, args] of calls) {
        const r = await client.callTool(args === undefined ? { name } : { name, arguments: args });
        console.log(`=== ${name} ${args === undefined ? "(no arguments)" : JSON.stringify(args)} isError=${r.isError === true}`);
        console.log(r.content[0].text);
      }
      await client.close();
    }
    await session({ ...base, CLAUDE_CODE_SESSION_ID: "test" }, [
      ["clens_stats", undefined],
      ["clens_stats", {}],
      ["clens_stats", { session_id: "current", sections: ["tools"] }],
      ["clens_stats", { project_id: "p1", sections: ["files"] }],
      ["clens_search", { queries: ["brainstorm", "skill"], limit: 2 }],
      ["clens_search", {}],
    ]);
    await session(base, [["clens_stats", { session_id: "current" }]]);
    // The server's parent is this script, so <this pid>.json is the file it reads.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(`${process.env.E2E}/claude/sessions`, { recursive: true });
    writeFileSync(`${process.env.E2E}/claude/sessions/${process.pid}.json`, JSON.stringify({ sessionId: "test", pid: process.pid }));
    console.log("=== (sessions file written; env says stale-id)");
    await session({ ...base, CLAUDE_CODE_SESSION_ID: "stale-id" }, [["clens_stats", { session_id: "current", sections: ["timeline"] }]]);
    EOF

The script prints, for every call, a marker line `=== <tool> <arguments> isError=<true|false>` followed by the tool's full answer, into `$OUT`. Inspect it with:

    OUT=/tmp/clens-m3.out
    cat "$OUT"
    grep -n '^=== ' "$OUT"
    grep -n '^### query:' "$OUT"
    awk '/^=== clens_stats \{"session_id":"current","sections":\["tools"\]\}/{f=1;next} /^=== /{f=0} f' "$OUT"
    awk '/^=== clens_stats \{"session_id":"current","sections":\["timeline"\]\}/{f=1;next} /^=== /{f=0} f' "$OUT"

The first `grep` lists nine marker lines: eight calls and the note line before the last call. The second lists the search section headers. The first `awk` line prints only the answer of the one `sections: ["tools"]` call; the second prints only the answer of the last call (`sections: ["timeline"]`, from the server whose env says `stale-id`). The arguments differ so each selector matches exactly one block. Paste `$OUT` into `Artifacts and Notes`, then clean up:

    rm -rf /tmp/clens-m3 /tmp/clens-m3.out

Milestone 3, real scale. Time all-project stats on the developer's own index, opened read-only (this reads `~/.clens/index.db` and never writes; skip it on a machine without an index):

    npx tsx -e 'import Database from "better-sqlite3"; import { homedir } from "node:os"; import { projectStats, formatStats } from "./src/mcp/stats.ts"; const db = new Database(homedir() + "/.clens/index.db", { readonly: true }); for (const sections of [undefined, ["skills"]]) { const t = performance.now(); const text = formatStats(projectStats(db, { sections })); console.log(JSON.stringify(sections), Math.round(performance.now() - t), "ms", text.length, "chars"); }'

Milestone 3, manual check in Claude Code (with the built server registered as the `clens` MCP server). Open a second Claude Code terminal. Run `/clear`, then type a prompt containing a made-up word that appears nowhere else, such as `zqvnonce4817`, and in the same prompt ask the agent to call `clens_search` for that word. Wait a few seconds first so the watcher indexes the prompt. Expected: `No results found.`, because the current turn is left out. Before this plan it was found, which is the measured bug. In the same terminal, ask for `clens_stats` with `session_id: "current"` and `sections: ["tools"]`; the `Scope:` line must name the new session, the newest transcript file in `~/.claude/projects/<project>/` (list with `ls -t ~/.claude/projects/<project>/*.jsonl | head -1`; the name without `.jsonl` is the session id). Then `/resume` into an older session and repeat both checks with a new nonce. Record every result, including `/resume`, which was not measured when this plan was written.


## Validation and Acceptance

Automated: `npm run typecheck` prints nothing, and `npm test` reports every test passed. The new cases named in `Plan of Work` fail before their milestone's change and pass after, except the cases marked there as regression guards, which pass both before and after; the pre-existing cases of `test/mcp_stats.spec.ts`, `test/mcp_search.spec.ts` and `test/analyzer_b*.spec.ts` pass unchanged. `test/mcp_instructions.spec.ts` passes, which proves `SEARCH_DESCRIPTION` and the new `STATS_DESCRIPTION` are each at most 2,048 characters.

Milestone 0: `cmp` of the before/after `projectStats` dumps on the same snapshot prints nothing and the step prints `IDENTICAL`. That proves every value `clens_stats` prints is unchanged; the only intended difference, the key order of `tool_counts` (and so the print order of tools with equal counts), is normalized in the dump. The after timings are recorded next to the before timings. Acceptance: `analyzeAgents` and `analyzeTools` each finish in under 300 ms in `global` scope on the snapshot, The other five analyzers have no pass/fail bound, because the two before runs differed by up to 9x for `analyzeIdentity` and a comparison would not be decidable: record their after timings next to the before timings, and mention in `Surprises & Discoveries` any that is more than 3x slower than its slower before run. If the 300 ms bound fails, record the numbers in `Surprises & Discoveries` and discuss with the user before closing the milestone, as for the Milestone 3 time bound. As an estimate, not a measurement: `analyzeAgents` should drop from 1.4 to 2.0 s to tens of milliseconds, since what is left is two small aggregates over the few thousand `agent_call` rows, and `analyzeTools` from 0.5 to 1.2 s to around 100 ms, since one `GROUP BY` replaces loading about 79,000 rows into JavaScript. `grep -n "tokens_per_call" CLAUDE.md` finds nothing, and `grep -rn "sample_descriptions\|sidechain_events\|durations\|longest_pause_s\|unresolved_tool_calls\|by_project\|sample_args\|avg_tokens_per_call\|repeat_edits\|total_ops" src test/*.spec.ts` finds nothing (the one hit allowed is the comment in `src/indexer/driver.ts` about filling tool durations, which is about `tool_call.duration_ms`, not an analyzer field).

Skill and backlog: `grep -n "required" skills/clens-stats/SKILL.md` no longer finds the phrase "`project_id` (required)"; the skill mentions omitting `project_id` for every project, `session_id: "current"`, `sections`, all three no-data messages and the `(+N more)` line. `docs/BACKLOG.md` no longer lists "Cap the size of `clens_session`" under "Later", and its "Decided for now" list has the 2026-09-28 entry with the measurement.

End to end, every criterion below is read off `$OUT`, which holds each call's full answer under its `===` marker. `grep -n '^=== '` shows nine marker lines (eight calls and one note). The call with no arguments (`=== clens_stats (no arguments) isError=false`) and `=== clens_stats {} isError=false` both answer with first line `Scope: all projects`, then the line about leaving out exec and pipeline sessions, then a `Sessions: 1 (…)` line (the fixture is a single session); the no-arguments call proves the `?? {}` parse. The `awk` block for `{"session_id":"current","sections":["tools"]}` starts with `Scope: session test in project p1`, contains `Tool usage:` and `Tool errors:`, and contains none of `Skills & slash commands:`, `Agents:`, `Health:`, `Timeline:` or `Files touched`. The block for `{"project_id":"p1","sections":["files"]}` starts with `Scope: project p1` and has a `Files touched` heading and no `Tool usage:`. `grep -n '^### query:'` prints exactly two lines, `### query: brainstorm` first and `### query: skill` second. The block for `clens_search {}` has `isError=true` and contains `Pass exactly one of query or queries.` The block from the server started without `CLAUDE_CODE_SESSION_ID` (and before any sessions file exists) has `isError=true` and its answer starts with `session_id "current" is not available here`. The last block (the second `awk` line), from the server whose env says `stale-id` while `sessions/<its parent pid>.json` says `test` with a matching `pid`, has `isError=false`, starts with `Scope: session test in project p1` and contains `Timeline:`, which proves the file wins over the env value inside the real server process.

Real scale: record both timings and sizes. Acceptance is that the default all-sections call on the developer's index finishes in under 5 s and its text is under 8,000 characters, and that `["skills"]` alone is well under 1 s. If the size bound fails, record the size and which section makes it up, and ask the user before changing anything: the caps were confirmed by the user on 2026-09-28, so do not lower them on your own. If the time bound fails, record it and discuss before shipping.

Manual check: after `/clear`, the nonce search answers `No results found.` and the `Scope:` line of `session_id: "current"` names the new session. The same after `/resume` is the hoped-for result but was not measured when this plan was written; record what happens either way. If either check fails, follow `Idempotence and Recovery`.


## Idempotence and Recovery

Every step can be repeated. The tests build in-memory or temporary databases. The end-to-end run uses the fixed directory `/tmp/clens-m3` (and `/tmp/clens-m3.out`); its first block deletes both before starting, so a run that failed midway is simply rerun from the first block. The real-scale timing opens the index read-only. No step migrates or rewrites an index: this plan does not change the index schema, so an existing `index.db` keeps working and a fresh install (empty index) behaves the same way.

To roll back, revert the commits of this plan; there is no stored state to undo.

Current-session detection degrades safely by construction: when `~/.claude/sessions/<ppid>.json` is missing, unreadable or changes shape, `detectCurrentSessionId` returns the `CLAUDE_CODE_SESSION_ID` value, which is exactly today's behavior (correct until the first `/clear`). So a Claude Code release that renames or drops the file makes nothing worse than it is now. If the Milestone 3 manual check fails, whether after `/clear` or after `/resume`, do not add another resolution rule on your own: record what happened (the id the server used, the newest transcript's file name, and the `sessionId` in `sessions/<claude pid>.json`, found with `ps -o pid,ppid,command` for the `claude` process) in `Surprises & Discoveries`, mark the Progress item as waiting on the user, and ask. Do not walk the process tree to find `claude` behind a wrapper, and never read the `*.key` files in that directory.


## Artifacts and Notes

The measurements behind the decisions, taken on 2026-09-28 against the developer's real index and transcripts, are quoted in `Surprises & Discoveries` and the `Decision Log`.

Expected shape of an all-project answer after this change (the numbers are illustrative):

    Scope: all projects
    Leaves out one-shot exec/SDK runs and clens judge (pipeline) sessions.
    Sessions: 1653 (2026-04-01T… to 2026-09-28T…)

    Tool usage:
      Bash: 25310
      …
      (+294 more)
    Tool errors: 1717

End-to-end transcript, 2026-09-28 14:30 KST (`/tmp/clens-m3.out`, built server driven by the MCP SDK client; the fixture's file paths are redacted in the fixture itself):

    === clens_stats (no arguments) isError=false
    Scope: all projects
    Leaves out one-shot exec/SDK runs and clens judge (pipeline) sessions.
    Sessions: 1 (2026-06-21T07:35:21.153Z to 2026-06-21T09:14:42.508Z)

    Tool usage:
      Edit: 82
      Bash: 9
      mcp__plugin_context-mode_context-mode__ctx_execute: 9
      Agent: 5
      Read: 2
      ToolSearch: 1
      Write: 1
    Tool errors: 2

    Skills & slash commands:
      brainstorming: 1

    Agents:
      code-reviewer: 5
    Default rate: 0

    Health:
      tool_errors: 2
      compaction_events: 0
      context_bloat_ratio: 1.39
        max_ctx: 270776 (session:test at 2026-06-21T09:11:30.338Z), median_ctx: 194405, sample_size: 238

    Timeline: wall 99.36min, think 86.96min, idle 6.94min

    Files touched:
      </path/redacted> (Edit): 82
      </path/redacted> (Read): 2
      </path/redacted> (Write): 1
    === clens_stats {} isError=false
    Scope: all projects
    Leaves out one-shot exec/SDK runs and clens judge (pipeline) sessions.
    Sessions: 1 (2026-06-21T07:35:21.153Z to 2026-06-21T09:14:42.508Z)

    Tool usage:
      Edit: 82
      Bash: 9
      mcp__plugin_context-mode_context-mode__ctx_execute: 9
      Agent: 5
      Read: 2
      ToolSearch: 1
      Write: 1
    Tool errors: 2

    Skills & slash commands:
      brainstorming: 1

    Agents:
      code-reviewer: 5
    Default rate: 0

    Health:
      tool_errors: 2
      compaction_events: 0
      context_bloat_ratio: 1.39
        max_ctx: 270776 (session:test at 2026-06-21T09:11:30.338Z), median_ctx: 194405, sample_size: 238

    Timeline: wall 99.36min, think 86.96min, idle 6.94min

    Files touched:
      </path/redacted> (Edit): 82
      </path/redacted> (Read): 2
      </path/redacted> (Write): 1
    === clens_stats {"session_id":"current","sections":["tools"]} isError=false
    Scope: session test in project p1
    Sessions: 1 (2026-06-21T07:35:21.153Z to 2026-06-21T09:14:42.508Z)
    Primary model: claude-opus-4-7

    Tool usage:
      Edit: 82
      Bash: 9
      mcp__plugin_context-mode_context-mode__ctx_execute: 9
      Agent: 5
      Read: 2
      ToolSearch: 1
      Write: 1
    Tool errors: 2
    === clens_stats {"project_id":"p1","sections":["files"]} isError=false
    Scope: project p1
    Leaves out one-shot exec/SDK runs and clens judge (pipeline) sessions.
    Sessions: 1 (2026-06-21T07:35:21.153Z to 2026-06-21T09:14:42.508Z)
    Primary model: claude-opus-4-7

    Files touched:
      </path/redacted> (Edit): 82
      </path/redacted> (Read): 2
      </path/redacted> (Write): 1
    === clens_search {"queries":["brainstorm","skill"],"limit":2} isError=false
    ### query: brainstorm
    [1] 2026-06-21T09:03:34.159Z  session:test  project:p1  score:0.0328
    User: test/fixtures/brainstorm-session.jsonl 이건 어딧는데

    [2] 2026-06-21T09:05:02.946Z  session:test  project:p1  score:0.0323
    User: …ture 커밋 전엔 Phase A 시작 금지"라고 잠가둠. 필요한 것: - test/fixtures/brainstorm-session.jsonl — 이 브레인스토밍 세션의 redacted 버전. 지금 작성 중인 이 세션이 원본인데, 아직 추출/redact 안 됨. - test/fixtures/brainstorm-session.expected.json — {turns: [8, 12, 16]} 골든셋. - t…

    (+11 more matches not shown — narrow the query, or raise limit/maxBytes; open any hit's full text with clens_session)

    ### query: skill
    [1] 2026-06-21T08:35:27.488Z  session:test  project:p1  score:0.0247
    Assistant: 이어갑니다. 분석 차원 §11에 Skill/Agent/Project 3개 추가했고, §9 JSON 스키마에도 `agents.by_type` / `skills` / `projects` 필드 추가했어요. 마무리로 남은 것: 1. §6.5 input format에 `Skill`/`Agent` tool_use 인식 규칙 추가 2. §7 스키마에 `skill_…

    [2] 2026-06-21T08:49:28.501Z  session:test  project:p1  score:0.0244
    Assistant: 이제 §12 Skill 런타임 핸드셰이크 명시:

    (+28 more matches not shown — narrow the query, or raise limit/maxBytes; open any hit's full text with clens_session)
    === clens_search {} isError=true
    Invalid params: [
      {
        "code": "custom",
        "path": [],
        "message": "Pass exactly one of query or queries."
      }
    ]
    === clens_stats {"session_id":"current"} isError=true
    session_id "current" is not available here: this client does not tell clens which session it is (Codex does not). Pass an explicit session_id, for example one from a clens_search or clens_left_off result.
    === (sessions file written; env says stale-id)
    === clens_stats {"session_id":"current","sections":["timeline"]} isError=false
    Scope: session test in project p1
    Sessions: 1 (2026-06-21T07:35:21.153Z to 2026-06-21T09:14:42.508Z)
    Primary model: claude-opus-4-7

    Timeline: wall 99.36min, think 86.96min, idle 6.94min


## Interfaces and Dependencies

No new dependency. Use the existing `better-sqlite3`, `zod` and `@modelcontextprotocol/sdk` (its client is used only in the manual end-to-end step).

In `src/mcp/current_session.ts`, define:

    export const CURRENT_SESSION = "current";
    export function resolveSessionId(
      value: string,
      currentSessionId: string | undefined,
    ): { ok: true; id: string } | { ok: false; error: string };
    /** Reads only join(sessionsDir(), `${pid}.json`) (src/util/paths.ts);
     *  its non-empty string sessionId when the file's pid equals `pid`,
     *  else a non-empty env.CLAUDE_CODE_SESSION_ID, else undefined.
     *  Never throws. Callers pass process.ppid and process.env, on every
     *  request. */
    export function detectCurrentSessionId(pid: number, env: NodeJS.ProcessEnv): string | undefined;

After Milestone 0, the analyzer result types are (fields not listed are removed):

    // src/analyzer/agents.ts
    export interface AgentByType { type: string; count: number }
    export interface AgentsFacts { agent_calls_total: number; by_type: AgentByType[]; default_rate: number }
    // src/analyzer/tools.ts
    export interface ToolsFacts { counts: Record<string, number>; errors: number }  // counts keys: count desc, then name
    // src/analyzer/timeline.ts
    export interface TimelineFacts { wall_min: number; think_min: number; idle_min: number }
    // src/analyzer/health.ts: HealthFacts loses unresolved_tool_calls only
    // src/analyzer/skills.ts
    export interface SkillByName { name: string; source: string; count: number }
    export interface SkillsFacts { by_name: SkillByName[]; slash_commands: SlashCommand[] }
    // src/analyzer/files.ts
    export interface FileFacts { top: Array<{ path: string; tool: string; count: number }> }

Function signatures (`analyzeX(db, scope)`) do not change.

In `src/analyzer/scope.ts`, add:

    /** Parenthesized SQL that keeps a session row unless it is a judge
     *  transcript or a one-shot exec/SDK run, or a subagent one of those
     *  started (checked through parent_id). NULL kind is kept.
     *  workKindClause() === "(kind IS NOT 'pipeline' AND kind IS NOT 'exec' AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM session WHERE kind IN ('pipeline', 'exec'))))" */
    export function workKindClause(alias?: string): string;

In `src/mcp/instructions.ts`, add:

    export const STATS_DESCRIPTION: string;   // at most 2,048 characters

and keep the signatures of `eventWhere` and `sessionScopedWhere` unchanged.

In `src/mcp/stats.ts`, define (bundle 2 will add `"hook_blocks"` and `"tool_output"` to both the tuple and the type):

    export const STATS_SECTIONS = ["tools", "skills", "agents", "health", "timeline", "files"] as const;
    export type StatsSection = "tools" | "skills" | "agents" | "health" | "timeline" | "files";
    export const STATS_FILES_TOP = 20;
    export const STATS_TOOLS_TOP = 30;
    export const STATS_SKILLS_TOP = 20;

    export interface StatsParams {
      project_id?: string;
      /** Already resolved: never "current". */
      session_id?: string;
      since?: string;
      sections?: StatsSection[];
    }

    export interface StatsFacts {
      scope: "session" | "project" | "all";
      project_id: string | null;
      session_id: string | null;
      sections: StatsSection[];
      sessions: number;
      primary_model: string | null;
      started_at: string | null;
      ended_at: string | null;
      tool_counts?: Record<string, number>;
      tool_errors?: number;
      skills?: Array<{ name: string; source: string; count: number }>;
      slash_commands?: Array<{ name: string; count: number }>;
      agents?: Array<{ type: string; count: number }>;
      agent_default_rate?: number;
      health?: {
        tool_errors: number;
        compaction_events: number;
        context_bloat_ratio: number | null;
        context_bloat_detail: {
          max_ctx: number;
          median_ctx: number;
          sample_size: number;
          max_session_id: string;
          max_ts: string;
        } | null;
      };
      timeline?: { wall_min: number; think_min: number; idle_min: number };
      files?: Array<{ path: string; tool: string; count: number }>;
    }

    export function projectStats(db: Database.Database, params: StatsParams): StatsFacts;
    export function formatStats(facts: StatsFacts): string;

In `src/mcp/search.ts`, add:

    export interface SearchTextOptions {
      maxBytes: number;
      context: number;
      allProjects: boolean;
    }
    export function searchText(
      db: Database.Database,
      params: SearchParams,
      opts: SearchOptions,
      out: SearchTextOptions,
    ): string;
    export function searchManyText(
      db: Database.Database,
      base: Omit<SearchParams, "query">,
      queries: string[],
      opts: SearchOptions,
      out: SearchTextOptions,
    ): string;

`SearchParams`, `searchWithTotal`, `searchUserText` and `formatSearchResults` keep their current signatures; `src/mcp/left_off.ts` imports `cutChars` and `notNoise` from `search.ts` and is unaffected.


## Revision notes

- 2026-09-28, after spec review ("Issues Found"). The end-to-end script now prints each call's full answer into a file, and every end-to-end acceptance item is checked from it with the listed `grep`/`awk` commands. A no-argument `clens_stats` call was added, which covers the handler's new `?? {}` parse (zod 4 rejects `undefined`). The plan now covers `skills/clens-stats/SKILL.md` (optional `project_id`, `"current"`, `sections`, the new no-data messages) and the `docs/BACKLOG.md` entry for the `clens_session` cap, in Plan of Work, Progress and Validation. The tool and skill caps are now this plan's decision rather than "pending", and the Decision Log says that rejecting them means rewriting the size acceptance. Other changes: a cut file list says `(+N more of the top 50)` when the analyzer hit its limit; a Decision Log entry says session scope leaves out subagent sessions, and the tool description says so too; the `/clear` fallback, if ever needed, lives in `src/mcp/current_session.ts`; the `sections` JSON-schema enum is built from `STATS_SECTIONS`; the stats description moves to `STATS_DESCRIPTION` in `src/mcp/instructions.ts` with a length assertion; `workKindClause()` is parenthesized; the single-query branch narrows `query` explicitly; the `### query:` headers are paid for out of `maxBytes`; the handler anchor is now `server.ts:330`.

Revision note (2026-09-28, after cold-read pass 1): two Milestone 1 stats cases (explicit `session_id` of an `exec` session; parent session without its subagent's calls) cannot fail before the change because session scope already has no kind filter; they are now marked as regression guards that pass before and after, and the Milestone 1 proof and Validation text say so.

Revision note (2026-09-28, after cold-read pass 2): the `/clear` fallback no longer asks the executor to implement a cwd lookup whose precedence over `CLAUDE_CODE_SESSION_ID` was unspecified; a failed check now stops Milestone 3 and goes to the user, with the cwd lookup recorded as one option. `resolveSessionId`'s signature and behavior are unchanged either way.

Revision note (2026-09-28, user decisions after review): (1) Current-session detection now uses Claude Code's per-process file `~/.claude/sessions/<ppid>.json` through a new `detectCurrentSessionId(pid, env)` in `src/mcp/current_session.ts`, falling back to `CLAUDE_CODE_SESSION_ID`. The user measured on 2026-09-28 that the env value goes stale on `/clear` while the file follows it. All three server call sites use it per request, which also fixes search and `clens_left_off` after `/clear`. This replaces the earlier "ask the user if the `/clear` check fails" contingency and the cwd-lookup option. The manual check is now a nonce search after `/clear` and `/resume`; `resolveSessionId` is unchanged. (2) New Milestone 0 removes analyzer fields and queries that `clens_stats` never prints. It is proven by an identical before/after `projectStats` dump on one read-only snapshot, with before/after timings and an acceptance bound, and it updates the three analyzer specs and the `CLAUDE.md` invariant sentence. (3) All four list caps are recorded as confirmed by the user. (4) `SERVER_INSTRUCTIONS` is unchanged.

Revision note (2026-09-28, re-review): the Milestone 0 proof no longer fails on a correct change. `analyzeTools`' new query is `ORDER BY n DESC, name`, `formatStats` breaks count ties by name (deterministic 30-entry cap), and the probe compares `tool_counts` by content with keys sorted; a Decision Log entry accepts that equal-count tools may print in a different order. Every other field stays byte-identical. The probe now uses fixed paths under `/tmp/clens-m0/` and opens the snapshot with `fileMustExist: true`. The `errors` test is marked a regression guard. Stale header comments in `agents.ts`, `health.ts` and `skills.ts` are now edited. The `CLAUDE.md` sentence is exact (`health.ts` reads `in_tok`, `cache_r`, `cache_w`, not `out_tok`), and `AGENTS.md` is left alone and noted in Surprises. `detectCurrentSessionId` requires the file's `pid` to match; three test cases were added (empty `sessionId`, empty env, pid mismatch) plus a missing-`pid` case, and pid reuse is recorded as an accepted risk with the live-files observation. The last E2E call uses `sections: ["timeline"]` so each `awk` selector matches one block. A failed 300 ms bound is recorded and discussed.

Revision note (2026-09-28, after cold-read of the re-review fixes): the Milestone 3 end-to-end blocks use the fixed path `/tmp/clens-m3` and reset `E2E`/`OUT` in each block, since a `mktemp -d` path held only in a shell variable was lost between separate command runs; the Milestone 0 acceptance no longer asks that the other five analyzers be "no slower" (undecidable with up to 9x noise) and instead records their timings.

Revision note (2026-09-28, after code review): subagents of `exec`/`pipeline` sessions are now left out too (`workKindClause()` checks the parent's kind), no-data messages mention what is left out, skill/slash/file lists break ties by name, the skills section's cut lines are labelled, `project_id`/`session_id` reject empty strings, more tests were added, and `clens mcp`'s limitation is documented in README.md. The `workKindClause` interface text was updated to match.
