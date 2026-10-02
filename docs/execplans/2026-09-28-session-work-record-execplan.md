# Give one session's work record through clens_left_off (bundle 3: recovery after compaction)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This is the third of three plans written on 2026-09-28. It depends on the other two, which must be implemented first:

- `docs/execplans/2026-09-28-stats-scope-and-search-batch-execplan.md` (bundle 1) adds `resolveSessionId()` in `src/mcp/current_session.ts`, which turns the literal `"current"` into the id of the Claude Code session that started the MCP server.
- `docs/execplans/2026-09-28-hook-blocks-and-tool-output-execplan.md` (bundle 2) adds the `hook_block` table and the `tool_call.result_chars` column to the index.

The section "Context and Orientation" says exactly how to check that both are in place before starting.


## Purpose / Big Picture

Claude Code compacts a long conversation: when the context window fills, it replaces the earlier turns with a written summary and carries on in the same session. The summary is prose written by the model, so exact facts get lost: which files were edited, which git commands ran, which tool calls failed, which hook blocked what, and the user's own wording of each request. Until now the user ran the context-mode plugin, whose SessionStart hook pasted a snapshot of those facts back into the conversation after every compaction. The user is removing context-mode and wants clens to cover this instead, but as a tool the agent calls when it needs it, not as a hook that injects text on its own.

After this change, an agent in Claude Code can call `clens_left_off` with `session_id: "current"` (or any session id) and get back that one session's work record: the user's last requests, the files edited, the state-changing git commands, the failed tool calls and the hook blocks, each list cut to its ten most recent entries. Without `session_id` the tool behaves exactly as it does today. The server instructions tell the agent to make this call after the conversation was compacted.

To see it working: build, restart Claude Code so it starts the new server, edit a file and make a git commit in a scratch session, run `/compact`, then ask the agent to call `clens_left_off` with `session_id` `"current"`. The answer lists the edited file and the commit that happened before the compaction.

Premise check. For this to work, four things must hold. First, compaction keeps the same session id, so `"current"` still names the session whose earlier turns are in the index; this is an assumption (Claude Code appends to the same transcript file and the same `sessionId` after `/compact`), and the manual validation step below checks it. Second, the server can tell which session the agent is in. Bundle 1 adds `detectCurrentSessionId(pid, env)` in `src/mcp/current_session.ts`: it reads the `sessionId` from Claude Code's per-process file `~/.claude/sessions/<pid>.json` for the server's parent process (`process.ppid`), and falls back to the environment variable `CLAUDE_CODE_SESSION_ID`. The file is needed because the variable goes stale: on 2026-09-28 a test in a second terminal showed that `/clear` starts a new session but does not restart the MCP server, so the variable kept the old id, while the per-process file named the new one. Whether `/resume` behaves the same is bundle 1's manual check. Third, the index is current: the MCP server's watcher (`src/indexer/watch.ts`) re-indexes a changed transcript 500 ms after it changes, so turns from before a compaction are indexed long before the agent asks. Fourth, the agent actually calls the tool after compaction; that rests on one sentence in the server instructions and has not been measured. What would break it: Claude Code changing or dropping its undocumented per-process file (the record would then fall back to the variable, which describes the previous session after `/clear`), and the instructions' 2,048-character cap, which leaves very little room today (see Decision Log).

Demand reality. The user is a single developer who runs long Claude Code sessions (one recent session had 392 user messages) and relies on recovering exact facts after compaction. Today, with context-mode installed, a hook re-pastes a snapshot after every compaction whether it is needed or not; with context-mode removed, the agent has only the compaction summary, or falls back to opening transcript files by hand, which is what happened in the session that motivated this work. That is not good enough because the facts the summary drops (a failed test command, a hook that blocked a write, the exact files touched) are the ones the agent needs to continue correctly. The narrowest useful version is this plan: one optional parameter on an existing tool, reading tables the index already has. Why now: the user is removing context-mode, and bundles 1 and 2 have just made `"current"` and hook blocks available.


## Progress

- [x] (2026-09-28 15:24) Confirm bundle 1 and bundle 2 are implemented (the checks in "Context and Orientation"). All four greps print lines and both prerequisite plans have every Progress item checked (bundle 2 is commit `23ba0fb`). Baseline: `tsc --noEmit` clean, 358 tests pass.
- [x] (2026-09-28 15:26) Milestone 1: `sessionRecord()` and `formatSessionRecord()` in `src/mcp/left_off.ts`, with tests in `test/mcp_left_off.spec.ts`. The 8 new tests first failed with `sessionRecord is not a function` (one with `commandOf is not a function`); afterwards all 19 in the file pass and `tsc --noEmit` is clean.
- [x] (2026-09-28 15:27) Milestone 2: `session_id` on `clens_left_off` in `src/mcp/server.ts`, and the instruction sentence in `src/mcp/instructions.ts` (first choice; it fits at 2,042 characters), with `test/mcp_instructions.spec.ts` extended. The new instructions test failed first on the missing sentence; afterwards `npm test` passes, 367 tests. The end-to-end script printed the four expected blocks (Artifacts and Notes).
- [x] (2026-09-28 15:28) Milestone 3, measurement: `sessions 20 median 2366 max 6056`, under the 4,096 target, so the caps stay.
- [x] (2026-09-28 15:53) Milestone 3, git lines past the cut: the user chose to print such a line from its git command (Decision Log). The new test failed first, then `npm test` passed, 368 tests. On the live index all 660 git lines printed for every interactive session now show their git command (before: 122 of 1,167 matches hid it); re-measured `sessions 20 median 2578 max 6059`.
- [x] (2026-09-28 15:59) Milestone 3, manual `/compact` check in Claude Code. In a scratch git repo the session wrote and edited `notes.md`, committed it (`336e319`) and ran a failing `ls /no/such/dir`; the user ran `/compact`; `clens_left_off` with `session_id: "current"` then returned the same session (`73136c75-…`) with `notes.md` under Edited, the commit under Git and `ls /no/such/dir` under Failed tool calls, as it had before the compaction (Artifacts and Notes). The premise holds: compaction keeps the session id and the per-process file still names it. Final run: `tsc --noEmit` clean, `npm test` 368 passed.
- [x] (2026-09-28 15:59) Update `Outcomes & Retrospective`.
- [x] (2026-09-28 16:18) After the code review: every state-changing git line of a call is listed, heredoc bodies are skipped, a heredoc commit carries its subject, and a git command hidden past the cut is added to the printed line (Decision Log). The two new tests failed first (3 entries instead of 4; the push missing from the printed line), then passed; `tsc --noEmit` clean, `npm test` 370 passed. On the live index (Surprises & Discoveries) no heredoc commit lacks its subject and no push is missing outside heredoc bodies; re-measured `sessions 20 median 2676 max 6354`.


## Surprises & Discoveries

These were found while writing the plan, before implementation.

- Observation: SQLite `json_extract` fails on `tool_call.input_json` rows. The parser cuts each tool input to 2,048 bytes (`TOOL_INPUT_BYTE_CAP` in `src/indexer/claude_parser.ts:38`), so a long input is stored as a JSON prefix that does not parse.
  Evidence: `SELECT count(*) FROM tool_call WHERE name='Bash' AND json_extract(input_json,'$.command') GLOB 'git *'` on the live index stopped with `Error: stepping, malformed JSON`. The same count with `input_json LIKE '{"command":"git %'` returned 1,804. Of 1,717 failed tool calls, 38 have an input at the cap.
- Observation: every Bash input in the live index starts with `{"command":`, so the command can be read off the front of the stored text even when the JSON is cut.
  Evidence: `SELECT count(*) FROM tool_call WHERE name='Bash' AND input_json NOT LIKE '{"command":%'` returned 0.
- Observation: `SERVER_INSTRUCTIONS` is 2,010 characters today, 38 under the 2,048 cap.
  Evidence: measured with `tsx` importing `src/mcp/instructions.ts` on 2026-09-28. Adding the full sentence this plan wants brought it to 2,071; the shortest wording that fits (below, in Decision Log) brings it to 2,042.
- Observation (during implementation): on real data, one git line in ten hides the git command it was listed for. The whole line is cut to `RECORD_LINE_CHARS` (120), and when a long one-line shell command runs `git branch` or `git commit` far into it, the cut ends before the `git`.
  Evidence: over every Claude Code Bash call in the live index on 2026-09-28, 1,167 commands matched; in 122 the matched `git` starts more than 110 characters into its line, and 319 match on a line other than the first. In this session's own record the first git line read `cd /Users/me/IdeaProjects/clens; git status --short; git diff --staged --stat; echo "---log"; git log -15 --pretty=fo…`, listed for a `git branch --show-current` further along the line.

- Observation (during implementation): text inside a heredoc can be taken for a git command. A command that writes a file through `<<'EOF'` whose body holds a line such as `'{"command":"git add -A && git commit …"}'` matches, because the separator rule sees `&& git commit` in it.
  Evidence: 5 of the 1,167 matches sit inside a heredoc opened on an earlier line (one was this plan's own test being written). In the session that built this plan, 2 of its 5 git lines were such test code (`call("g1", …git commit…)` and `const long = … git branch …`), because the session was writing tests about git commands. First left as it was; since the review fix below, heredoc bodies are skipped.

- Observation (code review, after the manual check): taking one line per Bash call hid most of what Claude Code's own commits record. Its usual commit is `git add -A && git commit -m "$(cat <<'EOF'` / subject / body / `EOF` / `)" && git push`; the record showed only the first line, so neither the subject nor the push appeared, and `git stash` followed by `git reset --hard …` on the next line showed only the stash. Nothing said a command was left out, because the totals counted calls.
  Evidence (reviewer, live index): 221 of 289 shown commit lines ended at the heredoc opener; 48 calls ran a `git push` on a later line the record never showed; 208 of 1,169 matched calls held further state-changing git commands on other lines; 83 shown lines had one past the 120-character cut (9 a push). After the fix, over all 3,471 Claude Code Bash inputs containing `git ` (each run through `sessionRecord` alone in an in-memory index): 1,163 calls give 1,517 lines, at most 6 per call; 0 printed heredoc commit lines lack their subject; 1 call's `git push` is not shown, and it sits inside a `node <<'EOF'` script body; 7 calls the old rule listed now give none, all heredoc bodies of scripts; 1 printed line hides its subcommand (the long `-C` below); the longest printed line is 321 characters, one `&&` chain of six git commands.
- Observation (code review): the `\b` after the subcommand also lets `git merge-base` and `git merge-tree` count as state-changing, because `\b` matches before `-`. 21 of 1,169 matches on the live index. Not changed: not part of the fix the user asked for.

- Observation (during the manual check): a long `-C <dir>` can still hide the git subcommand. The line is printed from its `git`, but `git -C /private/tmp/…/scratchpad/compact-check commit …` runs past 120 characters before `commit`, so the record showed `…git -C /private/tmp/…/compact-c…`.
  Evidence: over all 496 interactive Claude Code sessions on 2026-09-28 15:59, 661 git lines are printed; every one shows `git`, and 1 (this check's own commit) does not show the subcommand. Left as it is.

- Observation: messages that another Claude session sends through SendMessage ("Another Claude session sent a message: <teammate-message …") are stored as `user_text` rows with role `user`, so they can show up among a session's requests. This plan does not filter them; it is a separate indexing question.


## Decision Log

- Decision: extend `clens_left_off` with an optional `session_id` instead of adding a new tool such as `clens_checkpoint`.
  Rationale: agreed with the user as "approach A" for all three bundles: keep the five tools, so the agent does not get another tool to choose from and the server instructions do not need another tool's worth of text. `clens_left_off` already answers "what was done in a session" for the list case.
  Date/Author: 2026-09-28, user and Claude (brainstorming).

- Decision: on-demand tool only; no SessionStart hook, no re-pasting the record with every question, no PreToolUse guidance hook.
  Rationale: the user explicitly rejected those three context-mode behaviors.
  Date/Author: 2026-09-28, user.

- Decision: the task list is not part of the record.
  Rationale: Claude Code keeps tasks outside the conversation, in `~/.claude/tasks/` (705 session directories on the user's machine on 2026-09-28), so the `TaskList` tool still returns them after compaction; clens would only duplicate it. Also, a `TaskUpdate` input names a task by `taskId`, and the id is only in the `TaskCreate` result, which clens does not store; the guess that ids follow creation order could not be checked because no transcript left on disk still holds a `TaskCreate` result.
  Date/Author: 2026-09-28, Claude, accepted by the user.

- Decision: edits, git commands, failed tool calls and hook blocks are collected over the session and every subagent under it (the same `TREE` query the list mode uses for edits). Requests come from the session itself only, and a session whose `kind` is `subagent` shows no requests.
  Rationale: the list mode already counts a subagent's edits as its parent's work (`src/mcp/left_off.ts:53-57`), and a subagent's failures and blocked calls are part of the same work. A subagent's "user" messages are the prompts of the agent that started it, not the user's requests; search makes the same distinction for `role: "user"`.
  Date/Author: 2026-09-28, Claude.

- Decision: a failed tool call that a hook blocked is listed only under hook blocks, not also under failed tool calls.
  Rationale: a PreToolUse block is stored both as a failed `tool_call` (`is_error = 1`) and as a `hook_block` row with the same `call_id`; showing it twice wastes the ten-line budget. The hook block line carries the reason, which the failed-call line cannot.
  Date/Author: 2026-09-28, Claude.

- Decision: when `session_id` is given, `project_id`, `file`, `since`, `until` and `limit` are ignored.
  Rationale: the record is for one known session; a window inside it was not asked for. The tool description says so, so the agent is not surprised.
  Date/Author: 2026-09-28, Claude.

- Decision: git commands are read from the stored Bash input in JavaScript with a tolerant parser (`commandOf()`), after a SQL prefilter `input_json LIKE '%git %'`; never with `json_extract`.
  Rationale: see the first entry in Surprises & Discoveries. A command cut at 2,048 bytes still starts with its useful part.
  Date/Author: 2026-09-28, Claude.

- Decision: "state-changing git command" means a command in which `git` (optionally `git -C <dir>`) is followed by one of commit, checkout, switch, merge, rebase, reset, stash, push, branch, at the start of the command or after `&&`, `||`, `;` or a newline. `git status`, `git log`, `git diff`, `git show` are left out.
  Rationale: the list was agreed with the user. `git branch` and `git stash list` can be read-only, but the list is kept as agreed rather than refined.
  Date/Author: 2026-09-28, user and Claude.

- Decision: where the "call it after compaction" sentence goes. First choice: in `SERVER_INSTRUCTIONS`, by replacing the text `with last request, reply and edited files.` in item 4 with `with last request, reply and edits; session_id "current" after compaction.` (2,042 characters in total when measured on 2026-09-28). If bundle 1 has since grown `SERVER_INSTRUCTIONS` so that this no longer fits under 2,048, fall back to the `clens_left_off` tool description, and record the fallback here and in Outcomes.
  Rationale: the user's instruction was to put it in the server instructions and fall back to the tool description if it does not fit. The fallback is weaker, and the reason must be kept in view: `src/mcp/instructions.ts` explains that Claude Code shows server instructions even while tools are deferred (only their names visible), while a tool's description is seen only after the agent loads that tool, so a sentence there only reaches an agent that already chose `clens_left_off`.
  Date/Author: 2026-09-28, user and Claude.

- Decision: a git line that is longer than `RECORD_LINE_CHARS` and whose matched git command starts after the line's first `RECORD_LINE_CHARS / 2` characters is printed from that git command, after `…` (for example `…git branch --show-current; git rev-parse …`). Short lines, and long ones whose git command comes early, print as before. `SessionRecord.git` still holds the whole line; only `formatSessionRecord` changes.
  Rationale: on the live index the plain cut hid the git command in 122 of 1,167 matching commands (Surprises & Discoveries). The user chose this over keeping the plan's rule or showing only the matched command, which would have dropped the context the plan keeps on purpose (`git add -A && git commit …` as one line). After the change none of the 660 printed git lines hides its command. A test, "starts a long git line at its git command when the cut would hide it", pins it.
  Date/Author: 2026-09-28, user and Claude.

- Decision: a failed call's shown input, like a request, is its first non-empty line, so an input that starts with a newline still shows something. (First recorded with a second choice, one `stateChangingGitLine()` in place of `isStateChangingGit()` plus a line lookup; the next entry replaced both.)
  Rationale: it does not change what the record contains for the plan's tests, and keeps the code shorter.
  Date/Author: 2026-09-28, Claude.

- Decision: a Bash call gives one git entry per line that runs a state-changing git command, not one per call (`stateChangingGitLines()`). A heredoc body is skipped, and a git line that opens one carries the body's first line after ` ⏎ `. On the printed line, a later state-changing git command that the 120-character cut hides is added after the cut from its `git` word (` …git push origin main`, each cut to 40 characters). Totals count lines.
  Rationale: the code review showed that the per-call rule dropped the commit subject in 221 of 289 commits and never showed 48 pushes (Surprises & Discoveries), the facts the record exists to keep; the user decided to fix it. Skipping heredoc bodies is needed once every line is scanned, or a script written through a heredoc would list each git line in it; it also removes the false positives recorded earlier. Keeping whole lines, rather than only the matched commands, keeps the user's earlier choice to show `git add -A && git commit …` as one line.
  Date/Author: 2026-09-28, user (fix it) and Claude (shape).

- Decision: Codex is out of scope for this plan and comes later.
  Rationale: agreed with the user: Claude Code first. `"current"` cannot work in Codex because Codex does not give MCP servers a session id (`resolveSessionId()` returns an error there); an explicit Codex session id still works, but its record will show edits (Codex edits are stored with tool `apply_patch`, which `EDIT_TOOLS` in `src/mcp/left_off.ts:41` already includes) and requests only. A later Codex plan would need: git commands from Codex's shell tool calls (stored with names `exec_command`, 22,821 rows, and `exec`, 1,271 rows, on 2026-09-28, whose input shape differs from Bash's `{"command": …}`), the plan steps Codex records with `update_plan` (183 rows) in place of a task list, and a way to know the current Codex session.
  Date/Author: 2026-09-28, user.


## Outcomes & Retrospective

(2026-09-28 15:59) Done. `clens_left_off` takes an optional `session_id` (an id or `"current"`) and returns that one session's work record: the latest requests, edited files, state-changing git commands, failed tool calls and hook blocks, each cut to ten with its total, with a subagent's edits, git commands, failures and blocks counted as its parent's. Without `session_id` the tool behaves as before: the existing `clens_left_off` tests pass unchanged (the only removed line in `test/mcp_left_off.spec.ts` is the import, widened to the new functions). The "after compaction" sentence went into `SERVER_INSTRUCTIONS` (first choice, 2,042 characters), so no fallback to the tool description was needed.

Acceptance: `npm test` passes, 370 tests, with the 11 new record tests and the new instructions test; the real-index measurement is recorded (`sessions 20 median 2676 max 6354` after the review fix); in a real Claude Code session a `"current"` call after `/compact` showed the edit, the commit and the failed call made before it; `"current"` in a client without a session id returns `resolveSessionId()`'s error with `isError: true` (Milestone 2 end-to-end block).

What changed from the plan: git lines whose command starts late are printed from the git command (user's choice, Decision Log); after the code review (16:18), every state-changing git line of a call is listed, heredoc bodies are skipped, a heredoc commit carries its subject and a command hidden past the cut is added to the printed line, so `npm test` is now 370 and the measurement `sessions 20 median 2676 max 6354`; and one small implementation choice (Decision Log). What remains, left as it is on purpose: a long `git -C <dir>` can still hide its subcommand (1 printed line on the live index), `git merge-base` and `git merge-tree` count as state-changing (21 of 1,169), SendMessage texts count as requests, and Codex sessions get edits and requests only. Not measured: whether an agent calls the tool after compaction without being asked; that rests on the instructions sentence alone.

Learned: the real index caught what the plan's fixture could not. The plan's cut rule looked right on test rows and hid the git command in one line in ten on real commands.


## Context and Orientation

clens is a local tool that reads the transcripts Claude Code and Codex write (one JSONL file per session; JSONL means one JSON object per line) and copies what it needs into a SQLite database, the index, at `~/.clens/index.db`. An MCP server (a process Claude Code starts and talks to over stdin/stdout; it offers "tools" the agent can call) in `src/mcp/server.ts` answers queries from that index and never writes to it. Tests never touch the real directories: they set `CLENS_HOME`, `CLENS_CODEX_HOME` and `CLENS_INDEX_DIR` (see `src/util/paths.ts`), and the MCP tests in `test/` go further and build an in-memory database with `applySchema()` from `src/indexer/schema.ts`, inserting rows by hand. That in-memory path is exactly what a fresh install starts from, so it is the path the tests below cover.

The tables this plan reads, all created in `src/indexer/schema.ts`:

- `session` has one row per session: `id`, `project_id` (the working directory with every `/` replaced by `-`), `kind` (`interactive` for a conversation the user had; `subagent` for a thread an agent started, whose `parent_id` is the session that started it; `exec` and `pipeline` for runs other programs started), `parent_id`, `cwd`, `source` (`claude` or `codex`), `started_at`, `ended_at`.
- `user_text` has one row per user message or assistant reply: `session_id`, `ts` (ISO 8601 timestamp), `text`, `role` (`user` or `assistant`), `type` (`user_message`, `assistant_message`, and other types such as `continuation_summary` for the compaction summary).
- `file_op` has one row per file tool call: `session_id`, `ts`, `tool` (`Read`, `Edit`, `Write`, `NotebookEdit`, or `apply_patch` for Codex), `path` (absolute).
- `tool_call` has one row per tool call: `session_id`, `ts`, `call_id` (the tool_use id that links a call to its result), `name` (such as `Bash`), `input_json` (the tool's input as JSON text, cut to 2,048 bytes, so a long one is not valid JSON), `is_error` (1 when the tool's result was an error), and after bundle 2 `result_chars`. This plan does not read `result_chars`.
- `hook_block` (added by bundle 2) has one row per time a hook blocked something: `event_uuid`, `session_id`, `ts`, `hook_event` (such as `PreToolUse` or `Stop`), `tool` (the blocked tool for PreToolUse, otherwise null), `call_id` (the blocked call's id for PreToolUse, otherwise null), `reason` (the start of the hook's message, or NULL when bundle 2 found no message text; code reading it must treat NULL as the empty string).

The tool this plan changes is `clens_left_off`. Its logic is in `src/mcp/left_off.ts`. `leftOff(db, params, opts)` (line 66) picks sessions: only `kind = 'interactive'` (line 75), optionally one project, and it leaves out `opts.currentSessionId` (lines 83-86) because in Claude Code the asking conversation is never "where earlier work stopped". For each session it returns the first and last conversation message times, the last user request, the last assistant reply and the edited files. Three SQL helpers matter here. `REAL_MESSAGE(alias)` (line 63) keeps only `user_message`/`assistant_message` rows that are not noise (`notNoise()` from `src/mcp/search.ts:370`) and not a bare slash command such as `/compact` (`BARE_COMMAND`, line 49). `TREE` (line 56) is a recursive query that yields a session id and every subagent under it, at any depth, through `session.parent_id`; the list mode uses it so a subagent's edits count as its parent's. `EDIT_TOOLS` (line 41) is the list of file tools that edit. `formatLeftOff(sessions)` (line 156) prints the list, with paths shown relative to the session's `cwd` through `shortPath()` (line 150), and `cutChars(text, max)` (`src/mcp/search.ts:359`) cuts text to `max` code points with "…".

In `src/mcp/server.ts`, `LeftOffParamsSchema` (line 67) is the zod schema (zod is the validation library used for every tool's parameters) for `clens_left_off`; the tool's name, description and JSON input schema are listed in the `ListToolsRequestSchema` handler (the entry starting `name: "clens_left_off"`, around line 214); the call itself is handled in the `CallToolRequestSchema` handler's `clens_left_off` branch, which today calls `leftOff(getDb(), parsed.data, { currentSessionId: process.env.CLAUDE_CODE_SESSION_ID })` and returns `formatLeftOff(...)`; after bundle 1 it passes `detectCurrentSessionId(process.ppid, process.env)` instead. `src/mcp/instructions.ts` holds `SERVER_INSTRUCTIONS`, the text Claude Code puts in the agent's system prompt; Claude Code cuts it (and each tool description) at 2,048 characters, and `test/mcp_instructions.spec.ts` fails the build if it grows past that.

The existing tests for this tool are in `test/mcp_left_off.spec.ts`. Its `beforeEach` builds an in-memory index with sessions `old`, `mid`, `new` (interactive, project `-w-app`, cwd `/w/app`), `judge` (pipeline) and `web` (another project), with helpers `msg(uuid, session, ts, role, text)` and `edit(uuid, session, ts, tool, path)`. The new tests go in the same file and reuse that fixture.

Check the prerequisites before starting. From the repository root `/Users/me/IdeaProjects/clens`, run:

    grep -n "export function resolveSessionId" src/mcp/current_session.ts
    grep -n "export function detectCurrentSessionId" src/mcp/current_session.ts
    grep -n "hook_block" src/indexer/schema.ts
    grep -n "result_chars" src/indexer/schema.ts

Each must print at least one line. Also open both prerequisite ExecPlans and confirm every item in their `Progress` sections is checked. If any check fails, stop and implement the missing bundle first; this plan cannot be tested without them. If bundle 2 named the `hook_block` columns differently from the list above, use its names and note the difference in this plan's Decision Log.


## Plan of Work

Milestone 1 adds the record itself, as pure functions over the database, with no change to the MCP surface yet. At the end of it, `sessionRecord(db, id)` returns a typed record and `formatSessionRecord(record)` prints it, and the new tests in `test/mcp_left_off.spec.ts` pass. Nothing user-visible changes yet.

In `src/mcp/left_off.ts`, below `formatLeftOff`, add the constants `RECORD_LIST_CAP = 10`, `RECORD_LINE_CHARS = 120` and `FAILED_INPUT_CHARS = 100`, and the interface `SessionRecord` given in "Interfaces and Dependencies". Then add four functions.

`commandOf(inputJson)` returns the `command` string of a Bash input, or null. It first tries `JSON.parse(inputJson)` and returns its `command` when that is a string. If parsing throws (the input was cut at 2,048 bytes), it matches the regular expression `/"command":"((?:[^"\\]|\\.)*)/` against the raw text and returns the captured part decoded with `JSON.parse('"' + captured + '"')`, or the captured part as it is when that decode also throws (the cut can fall inside an escape such as `\u00`). It returns null when `inputJson` is null, when a successful parse gives anything that is not an object with a string `command` (including `JSON.parse("null")` and `{"query":"x"}`), and when the fallback regular expression does not match. It is exported so the test can call it directly.

`stateChangingGitLines(command)` returns every line of the command that runs a state-changing git command, trimmed, in order; a line is one when the regular expression `/(?:^|&&|\|\||;)\s*git\s+(?:-C\s+\S+\s+)?(?:commit|checkout|switch|merge|rebase|reset|stash|push|branch)\b/g` matches it. A line that opens a heredoc (`/(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/`, so `<<EOF`, `<<'EOF'`, `<<-"EOF"` but not the here-string `<<<`) starts a body that runs to the line whose trimmed text is the delimiter, or to the end of the command; the body is text (a commit message, a file being written), so its lines are not checked. When the opening line is itself a git line, the body's first non-empty line, the commit subject of `git commit -m "$(cat <<'EOF'`, is added to it after ` ⏎ `. It is not exported.

`sessionRecord(db, sessionId)` returns `null` when `SELECT id, project_id, kind, source, cwd FROM session WHERE id = ?` finds no row. Otherwise it runs these queries, all with `sessionId` as the bound value:

- Start and end: `SELECT min(ut.ts) AS started_at, max(ut.ts) AS ended_at FROM user_text ut WHERE ut.session_id = ? AND ${REAL_MESSAGE("ut")}`.
- Requests, only when the session's `kind` is not `subagent`: `SELECT ts, text FROM user_text ut WHERE ut.session_id = ? AND ut.role = 'user' AND ${REAL_MESSAGE("ut")} ORDER BY ts DESC`. Keep the total count, take the first `RECORD_LIST_CAP` rows, reverse them so they read oldest first, and keep only each text's first non-empty line (trimmed). For a subagent session, `requests` is empty and `requests_total` is 0.
- Edits: `${TREE} SELECT path, count(*) AS count, max(ts) AS last_ts FROM file_op WHERE session_id IN tree AND tool IN ${EDIT_TOOLS} GROUP BY path ORDER BY last_ts DESC`. Keep the total number of paths and the first `RECORD_LIST_CAP`.
- Git: `${TREE} SELECT ts, input_json FROM tool_call WHERE session_id IN tree AND name = 'Bash' AND input_json LIKE '%git %' ORDER BY ts DESC`. For each row, `commandOf()`; when it is not null, each line from `stateChangingGitLines()` is one entry with the row's `ts`, so one call can give several. Rows come newest first, so each row's lines are reversed there; after the list is cut to the first `RECORD_LIST_CAP` and reversed to oldest first, a call's lines read in their own order. The total counts lines, not calls. So the one-line `git add -A && git commit -m "fix login"` is one entry, whole; `cd /x\ngit commit -m y` is `git commit -m y`, not `cd /x`; and `git stash\ngit reset --hard origin/main` is two entries.
- Failed tool calls: `${TREE} SELECT t.ts, t.name, t.input_json FROM tool_call t WHERE t.session_id IN tree AND t.is_error = 1 AND NOT EXISTS (SELECT 1 FROM hook_block h WHERE h.call_id = t.call_id) ORDER BY t.ts DESC`. For each row, the shown input is `commandOf(input_json)` when that is not null, otherwise `input_json` itself, then its first line; an empty input becomes the empty string. Keep the total and the first `RECORD_LIST_CAP`, reversed to oldest first. (A `hook_block` row whose `call_id` is null never equals anything, so Stop blocks do not hide any failed call.)
- Hook blocks: `${TREE} SELECT ts, hook_event, tool, reason FROM hook_block WHERE session_id IN tree ORDER BY ts DESC`. For each row, read `reason` as `row.reason ?? ""` (bundle 2 stores NULL when a block carried no message; the row comes back through an `as` cast, so the type checker will not catch a missing null check), then the shown reason is the first non-empty line of it, with a leading prefix matching `/^\w+:\S+ hook error: /` removed when present (for example `PreToolUse:Bash hook error: `), so the line is the same whether bundle 2 stored the prefix or not. Keep the total and the first `RECORD_LIST_CAP`, reversed to oldest first.

The `TREE` constant is a `WITH` clause with one `?` placeholder; each of the last four queries therefore takes `sessionId` once, for that placeholder.

`formatSessionRecord(r)` prints the record as plain text, one section per list, in this order and with these exact headers (the `N`s are filled in):

    session:<id>  project:<project_id or ?>  <source>  started:<started_at or ?>  ended:<ended_at or ?>
    Requests (last N of M):
      <ts>  <text cut to RECORD_LINE_CHARS>
    Edited (N of M files):
      <path relative to cwd>  <count> edits, last <last_ts>
    Git (last N of M):
      <ts>  <command line cut to RECORD_LINE_CHARS; see below for a long one>
    Failed tool calls (last N of M):
      <ts>  <tool>: <input cut to FAILED_INPUT_CHARS>
    Hook blocks (last N of M):
      <ts>  <hook_event>[ <tool>]: <reason cut to RECORD_LINE_CHARS>

A section whose total is 0 prints its header as `Requests: (none)` (and likewise `Edited: (none)`, `Git: (none)`, `Failed tool calls: (none)`, `Hook blocks: (none)`) with no lines under it. When N equals M the header still says `last N of M` (or `N of M files`), so the agent always sees whether anything was cut. Paths go through the existing `shortPath(path, cwd)`. Texts are cut with `cutChars()`. A git line longer than `RECORD_LINE_CHARS` whose git command starts after its first `RECORD_LINE_CHARS / 2` characters is printed from that git command, after `…`, and then cut; each later state-changing git command on the line whose subcommand the cut still hides is added after it as ` …` plus the text from its `git` to the next such command, cut to `RECORD_LINE_CHARS / 3`. The record itself keeps the whole line (`shownGitLine()`; see Decision Log). The `[ <tool>]` part is present only when `tool` is not null. Lines are joined with `\n`.

Milestone 2 exposes the record through the MCP tool and tells the agent when to use it. In `src/mcp/server.ts`, add `session_id: z.string().min(1).optional()` to `LeftOffParamsSchema`. In the `clens_left_off` entry of the tools list, add the input property `session_id` with the description `A session id from another clens result, or "current" for this conversation (Claude Code only). Returns that one session's record instead of a list: its latest requests, edited files, git commands, failed tool calls and hook blocks. project_id, file, since, until and limit are then ignored.`, and change the tool description's sentence `In Claude Code the current conversation is left out.` to `In Claude Code the current conversation is left out of the list; pass session_id "current" for its own record, for example after the conversation was compacted.` In the handler's `clens_left_off` branch, before the existing call to `leftOff`, add: when `parsed.data.session_id` is set, resolve it exactly the way the `clens_stats` branch does after bundle 1, so the two tools never disagree about which session is current: `resolveSessionId(parsed.data.session_id, detectCurrentSessionId(process.ppid, process.env))`, both imported from `./current_session.js` (if bundle 1's code names or wires these differently, copy what its `clens_stats` branch does); if the result is not `ok`, return `{ content: [{ type: "text", text: result.error }], isError: true }`; otherwise call `sessionRecord(getDb(), result.id)` and return either its `formatSessionRecord()` text or, when it is null, the text `No session found: <id>. A session only just started may not be indexed yet; try again in a few seconds.` (not an error). Import `resolveSessionId` from `./current_session.js` and `sessionRecord`, `formatSessionRecord` from `./left_off.js`. The existing list path stays exactly as it is.

In `src/mcp/instructions.ts`, in `SERVER_INSTRUCTIONS` item 4, replace `with last request, reply and edited files.` with `with last request, reply and edits; session_id "current" after compaction.` Run `test/mcp_instructions.spec.ts`. If it fails because the text is over 2,048 characters (bundle 1 may have added text), revert this instructions edit and rely on the tool-description sentence added above as the fallback; record the fallback and the measured length in the Decision Log and in Outcomes. Either way, add one assertion to `test/mcp_instructions.spec.ts` (see Validation) so the sentence cannot be lost silently.

Milestone 3 checks the result at real scale and in a real Claude Code session. It changes no code unless the measurement shows the record is too long, in which case lower `RECORD_LINE_CHARS` (and `FAILED_INPUT_CHARS`) and record why.


## Concrete Steps

All commands run from the repository root, `/Users/me/IdeaProjects/clens`.

Run the prerequisite checks from "Context and Orientation" first.

Milestone 1. Write the tests in "Validation and Acceptance" into `test/mcp_left_off.spec.ts`, then run them before writing the code; they fail because `sessionRecord` does not exist:

    npx vitest run test/mcp_left_off.spec.ts

Expect the new tests to fail with an error such as `sessionRecord is not a function` (or the same for `commandOf`): Vitest resolves a missing named export from a TypeScript module to `undefined` rather than failing the import. Write the code from "Plan of Work", run the same command, and expect every test in the file to pass, the existing ones included. Then:

    npm run typecheck

Expect no output and exit code 0.

Milestone 2. Make the server and instructions edits, then:

    npx vitest run test/mcp_instructions.spec.ts test/mcp_left_off.spec.ts
    npm run typecheck
    npm test

Expect all to pass. `npm test` runs the whole suite; the driver, parser and other MCP specs must still pass unchanged.

Then check the server handler end to end, since `src/mcp/server.ts` cannot be imported in a test (it starts the server at import time). Build, index the repository's test fixture into a temporary home, and drive the built server with the MCP SDK client (`@modelcontextprotocol/sdk`, already a dependency). The `CLENS_*` variables keep everything away from the real `~/.claude/` and `~/.clens/`: the server's watcher may write, but only to the temporary index. The `env` passed to each server is built from scratch, so `CLAUDE_CODE_SESSION_ID` is present only where the script sets it. Run this as one script from the repository root (an agent's shell calls do not keep variables between calls):

    npm run build
    E2E=$(mktemp -d)
    mkdir -p "$E2E/claude/projects/p1" "$E2E/codex" "$E2E/clens"
    cp test/fixtures/brainstorm-session.jsonl "$E2E/claude/projects/p1/test.jsonl"
    CLENS_HOME="$E2E/claude" CLENS_CODEX_HOME="$E2E/codex" CLENS_INDEX_DIR="$E2E/clens" node dist/cli.js index
    E2E="$E2E" node --input-type=module <<'EOF'
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
    const base = { PATH: process.env.PATH, CLENS_HOME: `${process.env.E2E}/claude`,
      CLENS_CODEX_HOME: `${process.env.E2E}/codex`, CLENS_INDEX_DIR: `${process.env.E2E}/clens` };
    async function session(env, calls) {
      const client = new Client({ name: "e2e", version: "0" });
      await client.connect(new StdioClientTransport({ command: "node", args: ["dist/mcp/server.js"], env }));
      for (const args of calls) {
        const r = await client.callTool({ name: "clens_left_off", arguments: args });
        console.log(`=== clens_left_off ${JSON.stringify(args)} isError=${r.isError === true}`);
        console.log(r.content[0].text);
      }
      await client.close();
    }
    await session({ ...base, CLAUDE_CODE_SESSION_ID: "test" }, [{ session_id: "current" }, { session_id: "nope" }, {}]);
    await session(base, [{ session_id: "current" }]);
    EOF
    rm -rf "$E2E"

The fixture `test/fixtures/brainstorm-session.jsonl` is one interactive Claude Code session whose id is `test`; copied under `projects/p1`, it is indexed into project `p1`. Expect four `===` blocks, in order:

    === clens_left_off {"session_id":"current"} isError=false
    session:test  project:p1  claude  started:…  ended:…
    (then the five sections, each a header line or `<Section>: (none)`)
    === clens_left_off {"session_id":"nope"} isError=false
    No session found: nope. A session only just started may not be indexed yet; try again in a few seconds.
    === clens_left_off {} isError=false
    No sessions found.
    === clens_left_off {"session_id":"current"} isError=true
    session_id "current" is not available here: this client does not tell clens which session it is (Codex does not). Pass an explicit session_id, for example one from a clens_search or clens_left_off result.

The first block proves `"current"` resolves from `CLAUDE_CODE_SESSION_ID` (the temporary `CLENS_HOME` has no `sessions/<pid>.json` for the server's parent, the node script, so `detectCurrentSessionId` falls back to the variable); the last proves that without it the tool returns bundle 1's `resolveSessionId()` error with `isError: true`. The exact error sentence is the one bundle 1 defines in `src/mcp/current_session.ts`; if bundle 1 worded it differently, expect its wording. The third block is the unchanged list mode: the only session in the index is the current one, which the list leaves out, so `formatLeftOff([])` prints `No sessions found.` (`src/mcp/left_off.ts:157`). Paste the four blocks into Artifacts and Notes.

Milestone 3. Build, then measure the formatted record on the 20 most recently ended interactive sessions of the real index (this opens the index read-only and changes nothing):

    npm run build
    node --input-type=module -e '
    import Database from "better-sqlite3";
    import { indexDbPath } from "./dist/util/paths.js";
    import { sessionRecord, formatSessionRecord } from "./dist/mcp/left_off.js";
    const db = new Database(indexDbPath(), { readonly: true, fileMustExist: true });
    const ids = db.prepare("SELECT id FROM session WHERE kind = ? ORDER BY ended_at DESC LIMIT 20").all("interactive").map((r) => r.id);
    const sizes = ids.map((id) => formatSessionRecord(sessionRecord(db, id)).length).sort((a, b) => a - b);
    console.log("sessions", sizes.length, "median", sizes[Math.floor(sizes.length / 2)], "max", sizes.at(-1));'

The output is one line such as `sessions 20 median 2950 max 5400` (these numbers are illustrative, not measured). Record the real line in Artifacts and Notes. The target, an estimate made while designing and not yet measured, is a median under 4,096 characters; each list holding ten lines of at most about 130 characters bounds the worst case near 6.5 KB. If the median is over 4,096, lower `RECORD_LINE_CHARS` to 100 and `FAILED_INPUT_CHARS` to 80, rebuild, measure again, and record both measurements. For comparison, `clens_left_off` list calls made so far returned a median of 5,517 and a maximum of 15,616 characters (12 calls found in the user's transcripts on 2026-09-28).

Then the manual check in Claude Code. This step needs the human user: an executing agent cannot restart Claude Code or type `/mcp` or `/compact` itself. Ask the user to do it, record their result in Progress, and mark the step as waiting on the user rather than skipping it. Restart Claude Code (or reconnect the clens server with `/mcp`) so it starts the freshly built `dist/mcp/server.js`. In a scratch git repository, ask the agent to edit a file, commit it, and run a command that fails (for example `ls /no/such/dir`). Run `/compact`. Ask the agent to call `clens_left_off` with `session_id` `"current"`. The answer must show the edited file under `Edited`, the commit under `Git`, and the failed `ls` under `Failed tool calls`, all from before the compaction. If instead it describes a different session, or says `No session found`, the premise that compaction keeps the session id (or that `CLAUDE_CODE_SESSION_ID` is right) is wrong: record it in Surprises & Discoveries and stop; do not work around it in this plan.


## Validation and Acceptance

Add a `describe("clens_left_off session record", …)` block to `test/mcp_left_off.spec.ts`, reusing the file's `beforeEach` fixture and its `msg` and `edit` helpers, plus two helpers:

    function call(uuid: string, session: string, ts: string, name: string, input: string, isError = 0, callId: string | null = null): void {
      db.prepare("INSERT INTO tool_call (event_uuid, session_id, ts, call_id, name, input_json, is_error) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(uuid, session, ts, callId, name, input, isError);
    }
    function block(uuid: string, session: string, ts: string, hookEvent: string, tool: string | null, callId: string | null, reason: string | null): void {
      db.prepare("INSERT INTO hook_block (event_uuid, session_id, ts, hook_event, tool, call_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(uuid, session, ts, hookEvent, tool, callId, reason);
    }

The tests, each failing before Milestone 1 and passing after it:

"returns null for a session that is not in the index": `sessionRecord(db, "nope")` is `null`.

"gives one session's requests, edits, git commands, failed calls and hook blocks": on session `mid`, add `call("g1", "mid", "2026-09-02T10:04:50Z", "Bash", '{"command":"git add -A && git commit -m \\"fix login\\""}')`, `call("g2", "mid", "2026-09-02T10:04:51Z", "Bash", '{"command":"git status"}')`, `call("f1", "mid", "2026-09-02T10:04:52Z", "Bash", '{"command":"npm test\\nnpm run lint"}', 1)`, and `block("b1", "mid", "2026-09-02T10:04:53Z", "Stop", null, null, "req-harness: you cannot finish yet.\nmore detail")`. Expect `requests` to be `[{ ts: "2026-09-02T10:00:00Z", text: "fix the login bug" }]`, `edits` to list `/w/app/src/cache.ts` and `/w/app/src/login.ts` (the `Read` of `README.md` is not an edit), `git` to hold only the commit (the `git status` is read-only) with command `git add -A && git commit -m "fix login"`, `failures` to be one entry with tool `Bash` and input `npm test` (first line only), and `hook_blocks` to be one entry with hook_event `Stop`, tool `null` and reason `req-harness: you cannot finish yet.`.

"lists a hook-blocked call under hook blocks only": `call("p1", "mid", "2026-09-02T10:04:54Z", "Write", '{"file_path":"/w/app/x.md"}', 1, "toolu_1")` and `block("p2", "mid", "2026-09-02T10:04:54Z", "PreToolUse", "Write", "toolu_1", "PreToolUse:Write hook error: [Fact-Forcing Gate] Before creating x.md\nstate the facts")`. Expect `failures` to contain no `Write` entry, and `hook_blocks` to contain an entry whose reason is `[Fact-Forcing Gate] Before creating x.md` (prefix removed).

"shows a hook block whose reason is NULL": `block("n1", "mid", "2026-09-02T10:04:56Z", "Stop", null, null, null)`. Expect `sessionRecord(db, "mid")` not to throw, its `hook_blocks` to contain an entry with hook_event `Stop` and reason `""`, and `formatSessionRecord()` of it to contain the line `  2026-09-02T10:04:56Z  Stop: ` (nothing after the colon but the space).

"counts a subagent's edits, git commands, failures and hook blocks as the parent's, but not its requests": run `db.exec("INSERT INTO session (id, project_id, kind, parent_id, cwd, source) VALUES ('agent-a1', '-w-app', 'subagent', 'mid', '/w/app', 'claude')")`, then `msg("s1", "agent-a1", "2026-09-02T10:04:40Z", "user", "review the login fix")`, `edit("s2", "agent-a1", "2026-09-02T10:04:41Z", "Edit", "/w/app/src/api.ts")`, `call("s3", "agent-a1", "2026-09-02T10:04:42Z", "Bash", '{"command":"git -C /w/app switch -c fix"}')`. Expect `sessionRecord(db, "mid")` to include `/w/app/src/api.ts` in `edits` and `git -C /w/app switch -c fix` in `git`, and its `requests` not to include `review the login fix`. Expect `sessionRecord(db, "agent-a1")!.requests` to be `[]`.

"keeps the latest ten of each list, oldest first, and reports the total": add twelve user messages to `old` at `2026-09-01T11:00:00Z` through `2026-09-01T11:11:00Z` with texts `request 1` … `request 12`. Expect `requests_total` to be 13 (the fixture's `add the cache` plus twelve), `requests` to have length 10, its first text `request 3` and its last `request 12`.

"reads a git command out of an input cut at 2,048 bytes": build `const cut = '{"command":"git commit -m \\"' + "x".repeat(3000)` and take `cut.slice(0, 2048)` (not valid JSON). Expect `commandOf(cut.slice(0, 2048))` to start with `git commit -m "xxx`, and after `call("c1", "mid", "2026-09-02T10:04:55Z", "Bash", cut.slice(0, 2048))`, `sessionRecord(db, "mid")!.git` to include an entry whose command starts with `git commit -m "`. Also expect `commandOf('{"command":"ls","description":"list"}')` to be `ls` and `commandOf('{"query":"x"}')` to be `null`. Finally, after `call("c2", "mid", "2026-09-02T10:04:57Z", "Bash", '{"command":"cd /w/app\\ngit commit -m \\"second\\""}')`, expect `sessionRecord(db, "mid")!.git` to include an entry whose command is exactly `git commit -m "second"` (the matched line, not `cd /w/app`).

"starts a long git line at its git command when the cut would hide it" (added during Milestone 3, see Decision Log): after `call("l1", "mid", "2026-09-02T10:04:58Z", "Bash", JSON.stringify({ command: "cd /w/app; echo " + "x".repeat(100) + "; git branch --show-current" }))`, expect `sessionRecord(db, "mid")!.git` to contain that whole command and `formatSessionRecord()` of it to contain the line `  2026-09-02T10:04:58Z  …git branch --show-current`.

"lists every state-changing git line of a call, with a heredoc commit's subject, and skips heredoc bodies" (added after the code review, see Decision Log): add `call("h1", "mid", "2026-09-02T10:04:56Z", "Bash", …)` writing a file through `cat > t.ts <<'EOF'` whose body is `run('git add -A && git commit -m x');`, `h2` at `10:04:57Z` with `git add -A && git commit -m "$(cat <<'EOF'` / `fix: keep the session id` / (blank) / `Co-Authored-By: x` / `EOF` / `)" && git push`, and `h3` at `10:04:58Z` with `git stash` / `git reset --hard origin/main` (each passed through `JSON.stringify({ command })`). Expect `git` to equal exactly `git add -A && git commit -m "$(cat <<'EOF' ⏎ fix: keep the session id` and `)" && git push` at `10:04:57Z`, then `git stash` and `git reset --hard origin/main` at `10:04:58Z`, and `git_total` to be 4 (nothing from `h1`).

"adds a later git command on a long line that the cut would hide": with `line = 'git add src/a.ts && git commit -m "' + "x".repeat(120) + '" && git push origin main'` as `k1` at `10:04:58Z`, expect the formatted record to contain `` `  2026-09-02T10:04:58Z  ${line.slice(0, 120)}… …git push origin main` ``.

"formats a record with its section headers": for `mid` with the rows from the second test, expect `formatSessionRecord(sessionRecord(db, "mid")!).split("\n")` to equal exactly:

    session:mid  project:-w-app  codex  started:2026-09-02T10:00:00Z  ended:2026-09-02T10:05:00Z
    Requests (last 1 of 1):
      2026-09-02T10:00:00Z  fix the login bug
    Edited (2 of 2 files):
      src/cache.ts  1 edits, last 2026-09-02T10:04:00Z
      src/login.ts  1 edits, last 2026-09-02T10:03:00Z
    Git (last 1 of 1):
      2026-09-02T10:04:50Z  git add -A && git commit -m "fix login"
    Failed tool calls (last 1 of 1):
      2026-09-02T10:04:52Z  Bash: npm test
    Hook blocks (last 1 of 1):
      2026-09-02T10:04:53Z  Stop: req-harness: you cannot finish yet.

and for `old` with no git, failed calls or hook blocks, expect the lines `Git: (none)`, `Failed tool calls: (none)` and `Hook blocks: (none)`. (The `1 edits` wording is deliberate: it keeps the formatter free of plural rules. If you prefer `1 edit`, change the formatter and this expectation together and record it.)

In `test/mcp_instructions.spec.ts`, add a test "tells the agent to fetch the current session's record after compaction": when the instructions edit landed, `expect(SERVER_INSTRUCTIONS).toContain('session_id "current" after compaction')`. When the fallback was used instead, the sentence lives in `src/mcp/server.ts`, which cannot be imported in a test (importing it starts the server); in that case move the `clens_left_off` description string into `src/mcp/instructions.ts` as `export const LEFT_OFF_DESCRIPTION`, use it in `server.ts`, and assert `expect(LEFT_OFF_DESCRIPTION).toContain('session_id "current"')` and `expect(LEFT_OFF_DESCRIPTION.length).toBeLessThanOrEqual(2048)`.

Acceptance, as behavior: after Milestone 2, `npm test` passes with the new tests included; the existing `clens_left_off` tests pass unchanged, which shows the list mode did not change. After Milestone 3, the real-index measurement line is recorded, and in a real Claude Code session a call with `session_id: "current"` after `/compact` shows edits and git commands made before the compaction. Calling with `session_id: "current"` in a client that sets no `CLAUDE_CODE_SESSION_ID` returns the error text from `resolveSessionId()` with `isError: true`.


## Idempotence and Recovery

This plan changes code and tests only. It adds no table, changes no schema and bumps no `SCHEMA_VERSION`, so no re-index is needed and the index is never written: the MCP server opens it read-only (`getDb()` in `src/mcp/server.ts`). Every step can be repeated. To back out, revert the commits for `src/mcp/left_off.ts`, `src/mcp/server.ts`, `src/mcp/instructions.ts` and the two spec files; the list mode keeps working because its code path is untouched. The later shell-write change (`src/indexer/shell_writes.ts`) shares `left_off.ts` and `server.ts` with this plan but not its recovery: it bumps `SCHEMA_VERSION` (to 7) and its `file_op` rows come back only through a rebuild, so reverting this plan's files does not undo it, and backing it out means reverting the version too. The Milestone 3 measurement opens the real index with `readonly: true` and is safe to run at any time, including while the MCP server's watcher is indexing.


## Artifacts and Notes

The measurement line from Milestone 3, taken 2026-09-28 15:28 on the live index:

    sessions 20 median 2366 max 6056

The four blocks from the Milestone 2 end-to-end script, 2026-09-28 15:27 (the first block's requests are cut here to three of its ten lines; `</path/redacted>` is in the fixture itself). The `clens_left_off` description the built server lists is 713 characters.

    === clens_left_off {"session_id":"current"} isError=false
    session:test  project:p1  claude  started:2026-06-21T07:37:46.935Z  ended:2026-06-21T09:11:30.338Z
    Requests (last 10 of 55):
      2026-06-21T08:59:23.490Z  오케오케 아니그냥 궁금해서 물어본거다
      2026-06-21T08:59:50.588Z  마지막 리뷰한번 돌리자
      …
      2026-06-21T09:10:50.889Z  진행 방법 두 가지:
    Edited (1 of 1 files):
      </path/redacted>  83 edits, last 2026-06-21T09:11:24.486Z
    Git: (none)
    Failed tool calls (last 2 of 2):
      2026-06-21T08:47:51.207Z  Bash: grep -n "{{SLOT" </path/redacted>
      2026-06-21T08:57:14.837Z  Bash: grep -nF '{{SLOT' docs/execplans/2026-06-21-clens-execplan.md && echo "---caveats string---" && grep…
    Hook blocks: (none)
    === clens_left_off {"session_id":"nope"} isError=false
    No session found: nope. A session only just started may not be indexed yet; try again in a few seconds.
    === clens_left_off {} isError=false
    No sessions found.
    === clens_left_off {"session_id":"current"} isError=true
    session_id "current" is not available here: this client does not tell clens which session it is (Codex does not). Pass an explicit session_id, for example one from a clens_search or clens_left_off result.

The manual check after `/compact`, 2026-09-28 15:59, the three sections that matter (the scratch path is shortened here to `<scratchpad>`; other lines of the record left out):

    session:73136c75-c4ca-40ef-9029-d09ab5c75e2e  project:-Users-me-IdeaProjects-clens  claude  started:2026-09-28T04:50:00.025Z  ended:2026-09-28T06:59:13.374Z
    Edited (10 of 11 files):
      <scratchpad>/compact-check/notes.md  2 edits, last 2026-09-28T06:56:17.158Z
    Git (last 5 of 5):
      2026-09-28T06:56:18.993Z  …git -C /private/tmp/claude-501/-Users-me-IdeaProjects-clens/73136c75-c4ca-40ef-9029-d09ab5c75e2e/scratchpad/compact-c…
    Failed tool calls (last 4 of 4):
      2026-09-28T06:56:22.564Z  Bash: ls /no/such/dir

An example of the formatted record, from the test fixture above:

    session:mid  project:-w-app  codex  started:2026-09-02T10:00:00Z  ended:2026-09-02T10:05:00Z
    Requests (last 1 of 1):
      2026-09-02T10:00:00Z  fix the login bug
    Edited (2 of 2 files):
      src/cache.ts  1 edits, last 2026-09-02T10:04:00Z
      src/login.ts  1 edits, last 2026-09-02T10:03:00Z
    Git (last 1 of 1):
      2026-09-02T10:04:50Z  git add -A && git commit -m "fix login"
    Failed tool calls (last 1 of 1):
      2026-09-02T10:04:52Z  Bash: npm test
    Hook blocks (last 1 of 1):
      2026-09-02T10:04:53Z  Stop: req-harness: you cannot finish yet.

Numbers measured on the user's live index and transcripts on 2026-09-28, for scale: 1,804 Bash calls whose input starts with `{"command":"git `; 1,717 failed tool calls, 38 of them with an input at the 2,048-byte cap; `SERVER_INSTRUCTIONS` at 2,010 characters.


## Interfaces and Dependencies

No new library. Everything uses `better-sqlite3` (already the index driver) and `zod` (already used for tool parameters), plus `cutChars` and `notNoise` from `src/mcp/search.ts`.

In `src/mcp/left_off.ts`, export:

    export interface SessionRecord {
      session_id: string;
      project_id: string | null;
      source: string;
      cwd: string | null;
      started_at: string | null;
      ended_at: string | null;
      /** First line of each request, oldest first; the latest RECORD_LIST_CAP. */
      requests: { ts: string; text: string }[];
      requests_total: number;
      /** Most recently edited first. */
      edits: { path: string; count: number; last_ts: string }[];
      edits_total: number;
      /** Each command line that runs a state-changing git command, oldest first;
       *  one Bash call can give several. */
      git: { ts: string; command: string }[];
      git_total: number;
      failures: { ts: string; tool: string; input: string }[];
      failures_total: number;
      hook_blocks: { ts: string; hook_event: string; tool: string | null; reason: string }[];
      hook_blocks_total: number;
    }

    export function sessionRecord(db: Database.Database, sessionId: string): SessionRecord | null;
    export function formatSessionRecord(record: SessionRecord): string;
    export function commandOf(inputJson: string | null): string | null;

Existing exports `leftOff`, `formatLeftOff`, `LeftOffParams` and `LeftOffSession` keep their signatures. `LeftOffParams` does not gain `session_id`: the server handles `session_id` before calling `leftOff`, so `leftOff` stays the list mode only.

From bundle 1, in `src/mcp/current_session.ts`:

    export function resolveSessionId(value: string, currentSessionId: string | undefined): { ok: true; id: string } | { ok: false; error: string };
    export function detectCurrentSessionId(pid: number, env: NodeJS.ProcessEnv): string | undefined;

It returns `{ ok: true, id: value }` for an ordinary id, `{ ok: true, id: currentSessionId }` for `"current"` when the id is known, and `{ ok: false, error }` for `"current"` when it is not (Codex).

From bundle 2: the `hook_block` table with columns `event_uuid, session_id, ts, hook_event, tool, call_id, reason`, created by `applySchema()` in `src/indexer/schema.ts`, so an in-memory test database has it.


Revision note (2026-09-28): first version, written after the brainstorming session that agreed the three bundles.

Revision note (2026-09-28, after spec review): `hook_block.reason` can be NULL in bundle 2, so the hook-block query now reads it as `reason ?? ""` and a test with a NULL reason was added; the git line is now the whole line on which the state-changing `git` matched, instead of the command's first line (a cold-read pass found that "start at the matched word" contradicted the tests' expected `git add -A && git commit -m "fix login"`; the rule was checked in node against every test input), with a multi-line test added; `commandOf`'s null cases are spelled out; the handler resolves `"current"` the same way bundle 1's `clens_stats` does, including its cwd fallback if that was implemented; the failing-first expectation now names Vitest's actual `is not a function` error; the manual `/compact` check is marked as needing the human user.

Revision note (2026-09-28, after cold-read pass 2): added a Milestone 2 end-to-end script that drives the built server with the MCP SDK client, with and without `CLAUDE_CODE_SESSION_ID`, so the "current without the variable returns isError" acceptance can be observed; the git-line rule now names the position of the `git` word inside the match, since the match starts at the separator; the `SessionRecord.git` comment matches that rule.

Revision note (2026-09-28, after a /clear test with the user): `"current"` now resolves through bundle 1's `detectCurrentSessionId(process.ppid, process.env)` (Claude Code's per-process `~/.claude/sessions/<pid>.json` first, `CLAUDE_CODE_SESSION_ID` second), because a test showed the variable stays on the old session after `/clear` while the per-process file follows it. The premise check, the handler text and the end-to-end note were updated; the cwd-lookup fallback idea is gone.
