# Give Codex sessions the clens features Claude Code sessions have

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

## Purpose / Big Picture

clens indexes both Claude Code and Codex conversations, but a Codex session's record is much thinner than a Claude Code one. After this work, a Codex user gets what a Claude Code user gets today:

1. Right after Codex compacts a conversation, the agent is handed that session's clens work record (its latest requests, edited files, git commands, failed tool calls and hook blocks) without having to ask for it.
2. `clens_left_off` and `clens_stats` accept `session_id: "current"` inside Codex, and `clens_search` and `clens_left_off` leave the current Codex conversation out, as they do in Claude Code.
3. The work record of a Codex session lists the files its shell commands wrote, the state-changing git commands it ran, the tool calls that failed and the hook blocks it hit; `clens_stats` counts Codex tool errors, hook blocks and tool output size.

To see it working at the end: in a Codex session in any project, ask Codex to create a file with a shell redirect and commit it, run a command that fails, then type `/compact`. The next model request carries a developer message that starts with "clens work record of this session" and lists the file, the commit and the failed command. Asking Codex to call `clens_left_off` with `session_id: "current"` returns the same record.

Two differences stay, because Codex decides them and clens cannot change them: Codex runs no hook after compacting a subagent session, and a hook the user added runs only after the user trusts it with `/hooks` in Codex. Both are recorded in `docs/BACKLOG.md` under "Known limits".


## Progress

- [x] (2026-09-29 00:34Z) Research: Codex 0.155.1 source and the 1,162 local rollouts read; findings in `Surprises & Discoveries`.
- [x] (2026-09-29 00:52Z) Milestone 1: `"current"` from the tool call's `_meta` (`codexSessionFromMeta` in `src/mcp/current_session.ts`, used once per request in `src/mcp/server.ts`); tool texts say "Claude Code and Codex".
- [x] (2026-09-29 00:52Z) Milestone 1: the three `codexSessionFromMeta` tests failed with "codexSessionFromMeta is not a function", then passed; `npm test` 443 passed, typecheck clean. `test/scripts/codex-current-e2e.mjs` against the version 7 build printed `FAIL with _meta` (with the old error text) and `PASS without _meta`, exit 1. The same calls against the server run from source (`npx tsx src/mcp/server.ts`) returned the record for `clens_left_off` and `Scope: session codex-e2e in project -w-app` for `clens_stats` with `_meta`, and the new refusal without it.
- [x] (2026-09-29 01:18Z) Milestone 2: direct `exec_command` calls give shell-written files, failures and output size (`codexOutputText`, `codexOutputError`, `shellCommandFiles` in `src/indexer/codex_parser.ts`); the record's git list and edits read them (`commandOf` reads `cmd`, `EDIT_TOOLS` and the git query name `exec_command`); `src/analyzer/files.ts` leaves `exec_command` rows out; `SCHEMA_VERSION` 8.
- [x] (2026-09-29 01:18Z) Milestone 2: tests failed first for the expected reasons (the two size expectations, the files, the failure table, the guard's anomaly count, the record's git line, the analyzer row, and the Gate 2 test's rows), then passed; the "cmd is not a string" test passed from the start, as a check that nothing is recorded can. `npm test` 449 passed, typecheck clean. The full-corpus run is in `Surprises & Discoveries`.
- [x] (2026-09-29 01:40Z) Milestone 3: commands inside `exec` code give shell-written files and git lines (`execCodeCommands` in `src/util/codex_exec.ts`, used by `src/indexer/codex_parser.ts` and the git query in `src/mcp/left_off.ts`, which now also takes `exec` rows).
- [x] (2026-09-29 01:40Z) Milestone 3: `test/codex_exec.spec.ts` first failed to load (no module), then its 8 tests passed; the parser test and the record test failed on empty results, then passed. `npm test` 459 passed, typecheck clean. The full-corpus run is in `Surprises & Discoveries`.
- [x] (2026-09-29 01:58Z) Milestone 4: Codex hook blocks (`pushHookPrompt`, `hookEventOf` and `preToolUseReason` in `src/indexer/codex_parser.ts`; `HOOK_REASON_BYTE_CAP` exported from `claude_parser.ts`); the stats description names Codex.
- [x] (2026-09-29 01:58Z) Milestone 4: the Stop and PreToolUse parser tests and the extended Gate 2 test failed without the parser change and pass with it; the "wording inside a normal output" test and the record test "lists a Codex PreToolUse block under hook blocks, not failures" passed from the start, the first because it checks that nothing is recorded, the second because the record reads `hook_block` rows whatever their tool, so it guards the Codex shape rather than new record code. `npm test` 463 passed, typecheck clean. Over all local rollouts: 29 Stop blocks and 1 PreToolUse block (`read_file`, reason "Governed read denied for src/governed-read.ts"), no exception.
- [x] (2026-09-29 02:12Z) Milestone 5: README (both languages), `CLAUDE.md`, both skills and backlog updated (see the Milestone 5 entry in `Decision Log` for what differs from the plan).
- [ ] Milestone 5 (partly done): done (2026-09-29 02:20Z): `npm test` 463 passed, typecheck clean, `npm run build` (`dist/indexer/schema.js` has `SCHEMA_VERSION = 8`); `node test/scripts/codex-current-e2e.mjs` prints `PASS with _meta`, `PASS without _meta`, exit 0; `hooks/compact.mjs` given a Codex-shaped input (`session_id` of a real Codex session, plus `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `source: "compact"`) prints only `hookSpecificOutput.hookEventName` and `.additionalContext`, a 1,551-character record ending in `END-OF-CLENS-RECORD`; the Claude Code hook still prints a whole record (4,557 characters). Then (2026-09-29 02:00Z): with the user's approval the hook entry was added to `~/.codex/hooks.json` (copy kept as `hooks.json.bak-clens`); the user trusted it, restarted every server, and ran the `/compact` check; the record arrived right after the compaction (see `Surprises & Discoveries`). The version 8 rebuild settled at 10:19:49 KST with 2,435 Claude Code and 1,090 Codex sessions; the real index then held exactly what the full-corpus runs predicted: 1,948 failed Codex calls, 33,124 with `result_chars`, 217 `exec_command` file rows, 29 Stop and 1 PreToolUse hook blocks, no `shell_writes_error`; Claude Code's `Bash` rows 1,693 (1,672 at version 7, plus newer sessions). Eight random failed calls, opened in their rollouts, each show a real failure (exit codes 1, 2, 101, or "aborted by user"). A failure inside `exec` code was not recorded (see `Surprises & Discoveries`); the user asked for it, which is Milestone 6.
- [x] (2026-09-29 02:35Z) Milestone 6: failures inside `exec` code (`openExec`, `failedExec`, `markFailedExec` in `src/indexer/codex_parser.ts`); `SCHEMA_VERSION` 9. The positive parser test failed first ("expected +0 to be 1"), then passed; the negative one passed from the start, as a check that nothing is marked can; the extended Gate 2 test failed without the parser change and passes with it (its expected `result_chars` for the `exec` output was first miscounted as 24 and corrected to the measured 25). `npm test` 465 passed, typecheck clean, `npm run build` done, the end-to-end script passes. Over all local rollouts: no exception, 85 of 1,296 `exec` calls failed (15 before), 2,018 failed calls in all; ten sampled failures each hold a command that exited nonzero (`rg` finding nothing exits 1 and counts, as it does for a direct call).
- [x] (2026-09-29 03:05Z) Milestone 7: shell tool inputs stored up to 64 KB (`SHELL_TOOL_INPUT_BYTE_CAP`, commit `8298b74`); running commands' exits through `write_stdin` (`runningProcess`, `stdinTarget`, `headerExitCode`, `headerRunningSession`, `ownFailure`); `exec` commands built at run time from `CommandExecution` items (`readCommandExecution`, `execCodeScan`, `openDirect`); `SCHEMA_VERSION` 10; README (both), recap skill updated. Every new test failed first and then passed, except the ones that check nothing is recorded; two existing Claude parser tests changed with the cap; two expected `result_chars` in the Gate 2 test were written before measuring and corrected to the measured 67 and 60. Milestone 6's test "one the code does not name" failed once under the first cut of `readCommandExecution`, which gave an unnamed command to any lone open `exec` call; the rule now also needs the call's code to build a `cmd` at run time (`execCodeScan(...).built > 0`), and the test passes as written. `npm test` 472 passed, typecheck clean. Over all local rollouts: no exception; failed `exec_command` calls 1,559 → 1,729 and `write_stdin` 191 → 21 (170 exits moved to the call that started the process; one traced: `./gradlew :core:test …` "Process running with session ID 2071", then `write_stdin` for 2071 "Process exited with code 1"); failed `exec` 85 → 89; no file row came from a `CommandExecution` item (no built command wrote a file).
- [x] (2026-09-29 03:35Z) Milestone 7: build; the user restarts every server; the version 10 rebuild checked. Version 10; 2,435 Claude Code and 1,093 Codex sessions; failed Codex calls `exec_command` 1,729, `write_stdin` 21, `exec` 89, the same as the offline run; 0 `shell_writes_error`; file rows `Bash` 1,709, `exec_command` 217; longest stored input `Bash` 25,305 bytes, `exec_command` 25,818, `exec` 39,286 (682, 59 and 153 inputs over 2,048 bytes); `quick_check` ok.
- [x] (2026-09-29 02:08Z) Milestone 6: the user restarted every server; the version 9 rebuild settled at 11:06:24 KST (2,435 Claude Code and 1,093 Codex sessions); the real index holds 2,018 failed Codex calls, 85 of them `exec`, and no `shell_writes_error`, the same as the full-corpus run. `hooks/compact.mjs` for the `/compact` test session now lists "Failed tool calls (last 1 of 1): … exec: const r = await tools.exec_command({cmd:"ls /no/such/dir",…".


## Surprises & Discoveries

- Observation: Codex already has the hook needed for compaction recovery. After compacting, it queues a SessionStart run with source `compact` and runs it before the next model request; the hook's `additionalContext` is recorded into the conversation as a developer message. It skips this for subagent sessions.
  Evidence: Codex source at tag `rust-v0.155.1`: `codex-rs/core/src/session/mod.rs:3960-3976` (persist the compacted history, then `queue_pending_session_start_source(SessionStartSource::Compact)`), `codex-rs/core/src/hook_runtime.rs:124-172` (`run_pending_session_start_hooks`; `SessionSource::SubAgent(_) => return false` at line 147), `:833-849` (`record_additional_contexts` records developer messages). A local rollout written by Codex 0.154.0, `~/.codex/sessions/2026/09/17/rollout-2026-09-17T08-33-45-01a0ac91-b55e-7033-926f-41bfee79dc17.jsonl`, shows a compaction at 03:07:43.080Z and context-mode's SessionStart output as a developer message at 03:07:43.351Z.

- Observation: SessionStart hook output accepts exactly `hookSpecificOutput.hookEventName` and `hookSpecificOutput.additionalContext` and rejects unknown fields. `hooks/compact.mjs` prints exactly these two fields, so it works for Codex unchanged. Output above about 2,500 tokens is saved to a file and only a head-and-tail preview reaches the model, unless the hook entry sets `additionalContextLimit`.
  Evidence: `codex-rs/hooks/src/schema.rs:384-403` (`#[serde(deny_unknown_fields)]`, `additional_context: Option<String>`), `codex-rs/hooks/src/output_spill.rs:12` (`DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT: usize = 2_500`). The 0.154.0 rollout above shows the spill: "Warning: truncated output (original token count: 32834)".

- Observation: Codex tells an MCP server which session called it, in every tool call's `_meta`. clens does not read it, so `"current"` fails in Codex today.
  Evidence: `codex-rs/core/src/mcp_tool_call.rs:1239-1263` (`build_mcp_tool_call_request_meta` puts the turn metadata under the key `x-codex-turn-metadata`), `codex-rs/core/src/turn_metadata.rs:391-441` (`mcp_metadata_template` fills `session_id` and `thread_id`), `codex-rs/core/src/responses_metadata.rs:28-29` (the keys are `session_id` and `thread_id`). With the installed SDK (`@modelcontextprotocol/sdk` 1.29.0), a client call `callTool({ name, arguments, _meta: { "x-codex-turn-metadata": { session_id: "root", thread_id: "child" } } })` arrives in the server handler as `req.params._meta` with that object intact (checked with a throwaway stdio server and client).

- Observation: `thread_id`, not `session_id`, is the id clens stores for a Codex session. In a root rollout the two are equal; in a subagent rollout `session_id` is the root's id.
  Evidence: over the local rollouts, the first `session_meta` of all 1,033 root rollouts that carry `session_id` has `session_id == id`; in 24 of the 276 subagent rollouts that carry it, `session_id` differs from `id` and equals the parent thread. clens stores `payload.id` (`src/indexer/codex_parser.ts:10`, `:432`).

- Observation: for Codex, the index records no failures, no output sizes and no hook blocks, and no shell-written files.
  Evidence: in `~/.clens/index.db`, Codex sessions hold 33,130 `tool_call` rows, none with `result_chars` set and none with `is_error = 1`, and 0 `hook_block` rows; their `file_op` rows all have tool `apply_patch` (4,323). The cause is in `src/indexer/codex_parser.ts:516-521`: every `function_call_output` / `custom_tool_call_output` is stored as `{ is_error: 0, result_chars: null }`. The busiest Codex tools are `exec_command` (22,821 calls), `apply_patch` (2,805), `exec` (1,271) and `write_stdin` (1,165).

- Observation: a direct `exec_command` call carries its command as JSON `{"cmd": …, "workdir": …, "yield_time_ms": …, "max_output_tokens": …}`, and its output starts with a header that holds the exit code.
  Evidence: a real output begins "Chunk ID: 182a2d\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 208\nOutput:\n". Across the local rollouts, exit codes read from that header: 0 in 20,290 outputs, 1 in 1,012, 2 in 214, 128 in 52, 7 in 45, 127 in 34, 101 in 21; 1,104 outputs have no exit code (spawn failures "exec_command failed for …", "aborted by user after …", and commands still running when the call returned).

- Observation: other tools show failure in their own wording. `apply_patch`: "Exit code: N" first line (560 with 0, 3 with 1), JSON `{"output": …, "metadata": {"exit_code": N, …}}` (2,093 with 0, 3 with 1), "apply_patch verification failed: …" (140), "aborted by user after …" (5), "patch rejected by user" (1). `exec`: "Script completed" (1,232), "Script running with cell ID …" (24), "Script failed" (13), "aborted by user after …" (2). `write_stdin`: "write_stdin failed: …" (15), otherwise the same header as `exec_command`.

- Observation: Codex also writes `CommandExecution` items (`event_msg` / `item_completed`, with `command`, `cwd`, `exit_code`), but not in every version, and mostly as copies of direct calls. They are not a reliable source.
  Evidence: 8,595 such items locally; 7,601 repeat a direct `exec_command` call of the same file, 991 do not, 3 come from the user's own shell (`source: "user_shell"`). Rollouts written by Codex 0.129.0 through 0.146.1 hold none, although those versions made thousands of `exec_command` calls.

- Observation: in `exec` (Codex's "code mode", where the model writes JavaScript that calls tools), the shell commands exist only as string literals in the code, such as `tools.exec_command({cmd:"npm test",workdir:"/w/app"})`.
  Evidence: of the 1,271 local `exec` calls, 579 call `tools.exec_command` with a literal `cmd`, 89 with a `cmd` that is not a literal, 25 hold a state-changing git command and 23 a redirect, `tee`, `sed -i` or `perl -i`. For comparison, 96 direct `exec_command` calls hold a state-changing git command.

- Observation: Codex hook blocks look different from Claude Code's. A Stop hook that makes Codex continue leaves an `item_completed` item of type `HookPrompt`; a PreToolUse block becomes the blocked call's output text.
  Evidence: 29 local `HookPrompt` items, for example `{"type":"HookPrompt","id":"…","fragments":[{"text":"OMX team pipeline is still active …","hookRunId":"stop:4:/Users/me/.codex/hooks.json"}]}`. For PreToolUse, `codex-rs/core/src/hook_runtime.rs:229-240` formats "Command blocked by PreToolUse hook: {reason}. Command: {command}" (for shell and apply_patch) or "Tool call blocked by PreToolUse hook: {reason}. Tool: {name}", and `codex-rs/core/src/tools/registry.rs:577-590` returns it to the model as the call's result (`FunctionCallError::RespondToModel`). One local rollout holds a real one, as the output of a `read_file` call: "Tool call blocked by PreToolUse hook: Governed read denied for src/governed-read.ts. Tool: …" (found in Milestone 2's full-corpus run; the research search had missed it because it skipped lines holding `input_text`).

- Observation: over all 1,162 local rollouts, the Milestone 2 parser raised no exception and no `shell_writes_error`, gave every one of the 33,124 tool outputs a `result_chars`, marked 1,948 calls failed and found 217 files that `exec_command` calls wrote. The failures by tool: `exec_command` 1,559, `write_stdin` 191, `apply_patch` 152, `wait_agent` 24, `exec` 15, `request_user_input` 4, `read_file` 2, `browser_resize` 1. Every failure of a tool other than the shell and patch tools was checked by its output: all are "aborted by user after …", "Script failed" (13 `exec` outputs, given as a list of parts) or the one PreToolUse block above. The slowest file (57,771,477 bytes) parses in 159-173 ms, the same as before the change (161-168 ms).
  Evidence: `scale_m2.ts` and `fail_check.ts`, throwaway scripts that call `parseCodexFileBody` on each rollout and read nothing but `~/.codex/sessions`.

- Observation: `execCodeCommands` over the 1,271 local `exec` calls raised no exception, took at most 0.87 ms per call, and found 932 literal commands in 655 calls (the research regex had counted 579 calls, since it required `cmd` to be the first property); 27 calls hold a state-changing git command. No local `exec` command writes a file: the 28 that looked like writes redirect to `/dev/null`, name `-o /dev/null`, or hold `>` inside a search pattern or a `node -e` script, and `shellWrittenFiles` returns nothing for each. So Milestone 3 adds git lines to real records and no `file_op` rows today; its file path is proved by the unit test.
  Evidence: `scale_m3.ts` and `exec_writes.ts`, throwaway scripts over `~/.codex/sessions`: "exec calls 1271; with a literal command 655; commands 932; with a state-changing git command 27; exceptions 0; slowest 0.87 ms", "look like writes 28 with written files 0".

- Observation: the compact hook works in Codex. In the user's check (Codex 0.155.1, `~/.codex/sessions/2026/09/29/rollout-2026-09-29T10-48-10-01a0ead9-1526-7d70-8592-c07579d11106.jsonl`), the compaction is at line 64 and the clens record is the developer message at line 78 (01:50:42.104Z), 564 characters, whole, ending in `END-OF-CLENS-RECORD`, with both requests. context-mode's SessionStart hook, still in `~/.codex/hooks.json` with matcher `""`, also fired at the same moment (line 77, 9,981 characters, spilled: "original token count: 6377").
  Evidence: the rollout lines above.

- Observation: a command that fails inside `exec` code is not recorded as a failure. In the check, `ls /no/such/dir` ran as `exec` code; its `CommandExecution` item says `exit_code: 1, status: "failed"`, but the `exec` output is `Script completed …` followed by the script's own printout `{"exit_code":1,"output":"ls: /no/such/dir: No such file or directory\n"}`, which no rule of `codexOutputError` reads. This matters more than the research assumed: since September 2026 Codex runs most commands through `exec` (1,296 `exec` calls against 660 direct `exec_command` calls in the index; under 0.154.0, 898 against 123), and direct `apply_patch` calls stopped (0 in September). In the same check Codex refused to write `notes.md` with `echo` ("상위 편집 규칙상 `echo`로 파일을 쓰는 것은 허용되지 않아"), so there was no edit or commit to record; the empty Edited and Git lists were right.
  Evidence: the rollout above, lines 51-57; `SELECT substr(t.ts,1,7), sum(t.name='exec_command'), sum(t.name='exec') … GROUP BY 1` over Codex sessions.

- Observation: the first automated read of the Codex hooks documentation said PostCompact hooks can add `additionalContext`. The raw page says they take only the common output fields; only SessionStart can add context after a compaction. This plan uses SessionStart only.


## Decision Log

- Decision: read Codex shell commands from the `exec_command` call's own arguments and from string literals in `exec` code, never from `CommandExecution` items.
  Rationale: `CommandExecution` items are missing in 0.129.0 through 0.146.1 and mostly repeat direct calls, so counting them would drop whole versions and count most commands twice. The call arguments exist in every version.
  Date/Author: 2026-09-29, Claude.

- Decision: `file_op` rows for files a Codex shell command wrote get tool `exec_command`, both for direct calls and for calls inside `exec` code.
  Rationale: the tool that ran the command is `exec_command` in both cases. Claude Code's rows use the Claude tool name `Bash`; using Codex's own name keeps each source's names real, and every place that lists shell writes names both.
  Date/Author: 2026-09-29, Claude.

- Decision: a Codex tool call is an error when its output text matches one of the rules in `codexOutputError` (Plan of Work, Milestone 2). Anything else is not an error.
  Rationale: Codex has no error flag on a tool output; the rules are the failure shapes found in the local rollouts (see `Surprises & Discoveries`). The exit code in an `exec_command` header is read only from the header, before the "Output:" line, so a command that prints "Process exited with code 1" as its own output is not counted.
  Date/Author: 2026-09-29, Claude.

- Decision: a command that is still running when its `exec_command` call returns is not an error, and its later exit code, reported in a `write_stdin` output, marks that `write_stdin` call.
  Rationale: tying a later `write_stdin` output back to the `exec_command` call would need Codex's process session numbers, which the rollout carries only inside output text. The failure is still listed, under `write_stdin`.
  Date/Author: 2026-09-29, Claude.

- Decision: a Codex tool call's `result_chars` is the number of code points of its output text: the string itself, or, for an output given as a list of parts, the `text` of each part joined with nothing between them.
  Rationale: Claude Code's `result_chars` is the code-point length of the result's text blocks joined the same way (`toolResultText` and `codepointLength` in `src/indexer/claude_parser.ts:197-208` and `:101-105`), so the two sources measure the same thing.
  Date/Author: 2026-09-29, Claude.

- Decision: `"current"` is taken from `_meta["x-codex-turn-metadata"].thread_id`, falling back to its `session_id`, and this is tried before the Claude Code detection.
  Rationale: `thread_id` is the id clens stores (see `Surprises & Discoveries`). Codex metadata in the request proves the caller is Codex, while the Claude Code detection can be fooled when Codex was started from a shell inside a Claude Code session, which leaves `CLAUDE_CODE_SESSION_ID` in the environment.
  Date/Author: 2026-09-29, Claude.

- Decision: the parsing of `exec` code lives in `src/util/codex_exec.ts`, used by both the indexer (shell-written files) and `src/mcp/left_off.ts` (git lines).
  Rationale: the record's git list reads commands from `tool_call.input_json` at query time, like `commandOf` does for Claude Code, so the MCP side needs the same reading. `src/util/` holds code both sides share (today only `paths.ts`); putting it there keeps the indexer and the MCP server from importing each other.
  Date/Author: 2026-09-29, Claude.

- Decision: Codex hook blocks go into the existing `hook_block` table. A `HookPrompt` item gives one row per fragment, with the hook event from its `hookRunId` (`stop` becomes `Stop`) and no tool or call id. A PreToolUse block message gives one row on the blocked call's event, with tool the call's name, its call id, and the reason from the message; the call also counts as an error.
  Rationale: this is the shape Claude Code's rows already have (a Stop block has no tool or call id; a PreToolUse block has both and the call is an error), so `clens_left_off` and `clens_stats` show Codex blocks with no change on their side.
  Date/Author: 2026-09-29, Claude.

- Decision: bump `SCHEMA_VERSION` from 7 to 8 once, in Milestone 2, and do not run `npm run build` again until Milestone 5.
  Rationale: Milestones 2 to 4 all change what the indexer writes for Codex. A version bump makes every running server rebuild the index on start; one bump covers all three as long as no build ships in between. If a build did ship between them, bump to 9 in Milestone 5 so the index is rebuilt with the final code.
  Date/Author: 2026-09-29, Claude.

- Decision: build once, in Milestone 5, and do every step that needs the build or the user there: the passing run of the end-to-end script, registering the compact hook in `~/.codex/hooks.json`, the user's `/hooks` trust, the server restart and the `/compact` check. Milestone 1 writes the end-to-end script and runs it only against the existing version 7 build, where it must fail with `_meta`.
  Rationale: the user asked for the development of Milestones 1 to 4 first and all steps that need them at the end (2026-09-29). The plan first had Milestone 1 build and register the hook; building after Milestone 1 is harmless (no schema change), but one build and one round of user steps is what was asked.
  Date/Author: 2026-09-29, Claude (at the user's request).

- Decision: in Milestone 5, the README's hook instructions go under "Install" as "Compaction hook (optional)" (in Korean, "압축 훅 (선택)") instead of a section before "Limits", and three statements the plan did not list are corrected because Milestone 1 made them false: the README paragraph on registering the server said Codex cannot use `"current"`, and `skills/clens-stats/SKILL.md` said hook blocks and tool output cover Claude Code only, that `"current"` is Claude Code only, and that hook blocks and tool output are missing for Codex sessions. The README's Limits also say that in `exec` code only a literal `cmd` counts, which Milestone 3 made true.
  Rationale: registering the hook is an install step, next to registering the server; and the documentation must match what the code now does.
  Date/Author: 2026-09-29, Claude.

- Decision: add Milestone 6. An `exec` call counts as failed when, while it is open, Codex reports a command it ran as failed: an `item_completed` `CommandExecution` item whose `exit_code` is a number other than 0 and whose command is one of the call's literal commands (`execCodeCommands`). `SCHEMA_VERSION` goes to 9.
  Rationale: the user's `/compact` check showed a failed `ls` inside `exec` code left out of the record, and since September Codex runs most commands through `exec` (see `Surprises & Discoveries`); the user asked for these failures to be recorded (2026-09-29). This narrows the earlier decision never to read `CommandExecution` items: they are still not a source of commands or files, only of the exit code of a command the `exec` code names, and every Codex version that writes `exec` calls also writes these items (0.147.0 and later locally). Matching the command text ties the item to its call even when other calls are open. Version 8 was built and the real index rebuilt before this change, so the bump is to 9.
  Date/Author: 2026-09-29, Claude (at the user's request).

- Decision: add Milestone 7 for two of the three gaps left after Milestone 6: a running command's later exit goes to its own `exec_command` call through the process session number, and a command `exec` code builds at run time is read from its `CommandExecution` item. The third gap, git commands past the 2,048-byte cut of a stored input, is closed by keeping shell tool inputs (`Bash`, `exec_command`, `exec`) up to 64 KB, not by a new table of commands.
  Rationale: the user asked for all three (2026-09-29). Claude Code has the same gap as Codex (both parsers cut stored inputs at 2,048 bytes and the git list reads the stored input), so the fix is shared. A new table would need its writes, its wipe in `commitFile` and a place in the digest; raising the cap for shell tools needs a constant, costs about 2.7 MB on a 2.0 GB index, and stores every local shell input whole (the largest is 39,286 bytes). The user chose the cap (2026-09-29). The first two use data every rollout already holds. `CommandExecution` items become a source of commands and files, but only for an `exec` call's commands that its code does not name literally and no open direct call runs, and only when one `exec` call is open, so no command is counted twice or given to the wrong call.
  Date/Author: 2026-09-29, Claude (at the user's request).

- Decision: the Codex hook entry sets `additionalContextLimit` to 10000.
  Rationale: `hooks/compact.mjs` cuts its whole output to 9,000 characters (`MAX_CHARS` in that file), which cannot exceed about 9,000 tokens even for text that tokenizes one character per token. The default 2,500-token limit would spill a long record to a file.
  Date/Author: 2026-09-29, Claude.


## Outcomes & Retrospective

(2026-09-29) Done. A Codex session now gets what a Claude Code session gets: the compact hook puts its work record in right after a compaction (seen in a real Codex 0.155.1 session), `"current"` resolves from the tool call's `_meta` (end-to-end script against the built server), and the record and `clens_stats` hold Codex shell-written files, git lines, failures (including those inside `exec` code), output sizes and hook blocks. On the real index: 2,018 failed Codex calls, 33,124 outputs sized, 217 shell-written files, 29 Stop and 1 PreToolUse hook blocks, where version 7 held none of these. The two known limits stay as recorded in `docs/BACKLOG.md`: no hook after a Codex subagent's compaction, and a hook runs only once the user trusts it.

What is still not covered, after Milestone 7 closed the three gaps first listed here: a command `exec` code builds at run time counts only while that `exec` call is the only one open, and its git commands are not in the git list (the list reads the stored code, which does not hold them); a shell input over 64 KB is still cut (none locally).

What was learned: the research read the source and the rollouts but still undercounted how Codex works now. Codex moved most commands into `exec` code in September, which only the user's live `/compact` check exposed (Milestone 6), and a real PreToolUse block existed that the research search had filtered out. Running each milestone over the whole local corpus, and opening samples of what it marked, caught every other surprise before it reached the index.


## Context and Orientation

clens is a TypeScript project (Node, ES modules, `strict`) that reads the conversation logs Claude Code and Codex write, stores them in a SQLite database at `~/.clens/index.db`, and answers questions about them through an MCP server. MCP (Model Context Protocol) is the JSON-RPC protocol a coding agent uses to call outside tools; the agent starts clens's server (`dist/mcp/server.js`) as a child process and sends it `tools/call` requests over stdin and stdout.

The code has three parts that talk only through the database. The indexer (`src/indexer/`) parses log files and writes rows; `driver.ts` finds changed files, reads each one whole (`readFileSync` at `src/indexer/driver.ts:478`) and hands it to a parser, then commits the rows in one transaction per file. The MCP server (`src/mcp/`) opens the database read-only and answers tool calls; `left_off.ts` builds the "work record" of one session. The analyzer (`src/analyzer/`) turns SQL into the facts `clens_stats` reports. `src/util/paths.ts` is shared by all three and holds every path, so tests can redirect them with the environment variables `CLENS_HOME` (instead of `~/.claude`), `CLENS_CODEX_HOME` (instead of `~/.codex`) and `CLENS_INDEX_DIR` (instead of `~/.clens`). Code and tests must never touch the real `~/.claude/`, and the real `~/.clens/index.db` is only ever read.

Codex writes one "rollout" file per conversation thread, `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. Each line is a JSON object `{ "timestamp", "type", "payload" }`, sometimes with an `ordinal`. The first line is a `session_meta` whose `payload.id` is the thread id, which clens uses as the session id. A model's tool call is a `response_item` line whose payload type is `function_call` (JSON `arguments` string) or `custom_tool_call` (raw `input` text, used by `apply_patch` and `exec`); its result is a later `function_call_output` or `custom_tool_call_output` line with the same `call_id` and an `output` that is a string or a list of `{ "type": "input_text", "text": … }` parts. Chat text arrives in `event_msg` lines whose payload type is `item_completed` and whose `item.type` is `UserMessage` or `AgentMessage`. `exec_command` runs a shell command (`cmd`, optional `workdir`); `write_stdin` feeds a command still running; `apply_patch` edits files with a patch; `exec` runs a JavaScript program that can itself call `tools.exec_command(…)`, `tools.apply_patch(…)` and other tools.

`src/indexer/codex_parser.ts` turns a rollout into the same row types the Claude Code parser (`src/indexer/claude_parser.ts`) produces. The rows that matter here:

- `tool_call` (one per call: `name`, `input_json` cut at 2,048 bytes, `is_error`, `result_chars`). A result is matched to its call through the `tool_results` map the parser returns (call id to `{ ts, is_error, result_chars }`), which `applyToolResults` in `src/indexer/writer.ts:274-281` applies with `UPDATE tool_call … WHERE call_id = @call_id`.
- `file_op` (a file a tool touched: `tool`, `path`). For Claude Code, `claude_parser.ts:352-366` adds a row with tool `Bash` for every file `shellWrittenFiles(command, cwd, homedir())` in `src/indexer/shell_writes.ts` reads off a Bash command's text (redirects, `tee`, `sed -i`, heredoc and `-c`/`-e` scripts). That function takes the command, the directory it ran in and the home directory, and returns absolute paths.
- `hook_block` (a hook that stopped the agent: `hook_event`, `tool`, `call_id`, `reason`), columns in `src/indexer/schema.ts:285-294`.

The "work record" (`sessionRecord` and `formatSessionRecord` in `src/mcp/left_off.ts`) lists a session's latest requests, the files it edited (`file_op` rows whose tool is in `EDIT_TOOLS`, line 43), its state-changing git commands (the query at lines 315-319 takes `tool_call` rows named `Bash` and reads each command with `commandOf`, lines 208-227, which reads the JSON field `command`), its failed tool calls (`is_error = 1` without a hook block) and its hook blocks. `clens_left_off` returns it for a `session_id`, and `"current"` is resolved by `resolveSessionId` and `detectCurrentSessionId` in `src/mcp/current_session.ts`, which today know only Claude Code. The call sites are in `src/mcp/server.ts` lines 308 (`clens_search`), 369 and 378 (`clens_left_off`) and 395 (`clens_stats`), all inside the one `CallToolRequestSchema` handler that starts at line 297 and receives `req`.

`hooks/compact.mjs` is a SessionStart hook: it reads `{ session_id, source }` as JSON on stdin, does nothing unless `source` is `compact`, opens the index read-only, and prints `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}` holding the session's record, cut to 9,000 characters and ended by the line `END-OF-CLENS-RECORD`. It imports `dist/`, so it needs `npm run build`. It is registered for Claude Code in the user's `~/.claude/settings.json`.

Gate 2 is the project's main invariant: indexing a file incrementally must give byte-identical database content to a full `--rebuild`. `test/digest.spec.ts` and `test/driver_multifile.spec.ts` check it by comparing `digestAllTables` digests. `SCHEMA_VERSION` (`src/indexer/schema.ts:46`, now 7) is stored in the database; a server that finds another version rebuilds the index from the logs still on disk, so any change to what the parser writes needs a bump, or old rows stay as they were.

The test suite passes before this work: from the repository root, `npm test` reports `Test Files  31 passed (31)` and `Tests  440 passed (440)`, and `npm run typecheck` prints no errors.


## Plan of Work

### Milestone 1: "current" in Codex

At the end of this milestone the server code resolves `session_id: "current"` from a Codex tool call, proved by unit tests; once built (in Milestone 5), a Codex session can call `clens_left_off` with `"current"` and get its own record. Nothing in the indexer changes yet, so until Milestones 2 to 4 land the record shows only what clens already stores for Codex (requests and `apply_patch` edits).

In `src/mcp/current_session.ts`, add and export `codexSessionFromMeta(meta: unknown): string | undefined`. It returns `undefined` unless `meta` is an object whose `x-codex-turn-metadata` property is an object; from that object it returns `thread_id` when it is a non-empty string, otherwise `session_id` when that is a non-empty string, otherwise `undefined`. It never throws. Rewrite the file's header comment so it says both sources: Claude Code through its per-process sessions file or `CLAUDE_CODE_SESSION_ID`, Codex through the `_meta` of each tool call (`x-codex-turn-metadata`, whose `thread_id` is the id clens stores). In `resolveSessionId`'s error message (line 24), drop "(Codex does not)" so it reads: `session_id "current" is not available here: this client does not tell clens which session it is. Pass an explicit session_id, for example one from a clens_search or clens_left_off result.`

In `src/mcp/server.ts`, inside the `CallToolRequestSchema` handler (line 297), compute once, at the top of the handler, `const currentSessionId = codexSessionFromMeta(req.params._meta) ?? detectCurrentSessionId(process.ppid, process.env);` and use `currentSessionId` in place of each of the four `detectCurrentSessionId(process.ppid, process.env)` calls (lines 308, 369, 378, 395). Import `codexSessionFromMeta` next to the existing import at line 43. Change the tool texts: at line 236 the clens_left_off description begins "In Claude Code the current conversation is left out of the list"; make it "In Claude Code and Codex the current conversation is left out of the list". At lines 263 and 280, replace "(Claude Code only)" with "(Claude Code and Codex)". In `src/mcp/instructions.ts`, line 40 of the search description says "In Claude Code the current turn is left out"; make it "In Claude Code and Codex the current turn is left out". Line 52 of the stats description says `session_id "current" is this conversation (Claude Code only).`; make it `(Claude Code and Codex).` `test/mcp_instructions.spec.ts` checks that these texts stay within 2,048 characters; the edits add a few characters, so run it.

Add tests to `test/mcp_current_session.spec.ts`, in a new `describe("codexSessionFromMeta", …)`: `codexSessionFromMeta({ callId: "c", "x-codex-turn-metadata": { session_id: "root", thread_id: "child", turn_id: "t" } })` is `"child"`; `codexSessionFromMeta({ "x-codex-turn-metadata": { session_id: "root" } })` is `"root"`; and each of `undefined`, `null`, `{}`, `{ "x-codex-turn-metadata": "x" }`, `{ "x-codex-turn-metadata": { thread_id: "", session_id: "" } }` and `"text"` gives `undefined`.

Add the end-to-end script `test/scripts/codex-current-e2e.mjs` (an ES module; it lives in the repository so its bare imports resolve from `node_modules`). It makes a temporary directory with `.claude/` (empty), `.codex/sessions/2026/09/29/` and `.clens/`; writes `rollout-2026-09-29T00-00-00-codex-e2e.jsonl` there with three lines, a `session_meta` (`{ "id": "codex-e2e", "cwd": "/w/app", "source": "cli" }`, timestamp `2026-09-29T00:00:00Z`) and two `event_msg` / `item_completed` lines, a `UserMessage` with content `[{ "type": "text", "text": "fix the login bug" }]` at `2026-09-29T00:00:01Z` and an `AgentMessage` with content `[{ "type": "Text", "text": "Fixed." }]` at `2026-09-29T00:00:02Z`; runs `node dist/cli.js index` with `CLENS_HOME`, `CLENS_CODEX_HOME` and `CLENS_INDEX_DIR` pointed at those directories; then starts `node dist/mcp/server.js` through `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js`, with `env: { ...getDefaultEnvironment(), CLENS_HOME, CLENS_CODEX_HOME, CLENS_INDEX_DIR }` (so a `CLAUDE_CODE_SESSION_ID` in the caller's environment does not reach the server), and a `Client` from `@modelcontextprotocol/sdk/client/index.js`. It makes two calls. The first is `callTool({ name: "clens_left_off", arguments: { session_id: "current" }, _meta: { "x-codex-turn-metadata": { session_id: "codex-e2e", thread_id: "codex-e2e", turn_id: "t1" } } })`; it prints `PASS with _meta` when the answer is not an error, its text starts with `session:codex-e2e  project:-w-app  codex` and it contains `fix the login bug`, and `FAIL with _meta` followed by the text otherwise. The second is the same call without `_meta`; it prints `PASS without _meta` when the answer is an error whose text starts with `session_id "current" is not available here`, and `FAIL without _meta` otherwise. It closes the client, removes the temporary directory, and exits with code 1 if anything failed. Run it once now, against the existing version 7 build in `dist/` (do not rebuild): it must print `FAIL with _meta` and `PASS without _meta` and exit 1, which shows the check fails without this milestone's code. The passing run comes after the build in Milestone 5.

### Milestone 2: direct exec_command calls in the record and the stats

At the end of this milestone, a Codex session's record lists the files its `exec_command` calls wrote, the state-changing git commands they ran and the ones that failed, and `clens_stats` counts Codex tool errors and output size.

In `src/indexer/codex_parser.ts`, import `homedir` from `node:os`, `shellWrittenFiles` from `./shell_writes.js`, and `codepointLength` from `./claude_parser.js` (already exported at `claude_parser.ts:101`).

Add two functions. `codexOutputText(output: unknown): string` returns `output` itself when it is a string; when it is an array, the concatenation, with nothing between, of the `text` of every element that is an object with a string `text` and a `type` of `input_text`, `output_text` or `text`; otherwise the empty string. `codexOutputError(text: string): 0 | 1` returns 1 when any of these holds, checked in this order, and 0 otherwise:

1. The text starts with `Command blocked by PreToolUse hook: ` or `Tool call blocked by PreToolUse hook: `.
2. The text starts with `aborted by user` or `patch rejected by user`.
3. The text starts with `exec_command failed`, `write_stdin failed`, `apply_patch verification failed` or `Script failed`.
4. The first line matches `/^Exit code: (-?\d+)/` and the number is not 0.
5. The text contains `\nOutput:`, and the part before its first occurrence (the header) matches `/Process exited with code (-?\d+)/` with a number that is not 0.
6. The text, trimmed, starts with `{`, parses as JSON to an object, and that object's `metadata.exit_code` is a number that is not 0.

In the `function_call_output` / `custom_tool_call_output` branch (lines 516-521), compute `const text = codexOutputText(payload.output);` and set the result to `{ ts: timestamp, is_error: codexOutputError(text), result_chars: codepointLength(text) }` instead of `{ ts: timestamp, is_error: 0, result_chars: null }`.

In the `function_call` / `custom_tool_call` branch (lines 466-515), after the patch handling and before `events.push(parsed)`, when `name === "exec_command"`: take `const input = parseObjectLike(args);` (the whole, uncut arguments); when `input` is not null and `input.cmd` is a string, call `shellWrittenFiles(input.cmd, typeof input.workdir === "string" ? input.workdir : state.cwd, homedir())` inside `try`, and on any exception call `bumpAnomaly(batch, "shell_writes_error")` and use no paths; push one `file_op` row `{ event_uuid: uuid, session_id, ts: timestamp, tool: "exec_command", path }` per returned path. This mirrors `claude_parser.ts:352-366`.

In `src/indexer/schema.ts`, set `SCHEMA_VERSION` to 8 and add below the v7 comment: "v8: Codex rows. A tool call's is_error and result_chars from its output text, file_op rows with tool 'exec_command' for the files a Codex shell command wrote (a direct exec_command call or one inside exec code), and hook_block rows from HookPrompt items and PreToolUse block messages. No structural change; the version-mismatch rebuild re-reads every transcript still on disk."

In `src/mcp/left_off.ts`: add `'exec_command'` to `EDIT_TOOLS` (line 43), giving `('Edit', 'Write', 'NotebookEdit', 'apply_patch', 'Bash', 'exec_command')`. Make `commandOf` (lines 208-227) read `cmd` when there is no `command`: in the JSON branch, take `parsed.command` and, when it is not a string, `parsed.cmd`; in the fallback regex, use `/"(?:command|cmd)":"((?:[^"\\]|\\.)*)/`. Update its comment to say it reads a Claude Code Bash input's `command` or a Codex `exec_command` input's `cmd`. In the git query (line 318), replace `name = 'Bash'` with `name IN ('Bash', 'exec_command')`. In the `SessionRecord` interface, the comment on `git` (lines 198-199) ends "one Bash call can give several"; make it "one shell call can give several".

In `src/analyzer/files.ts`, line 26, replace `tool <> 'Bash'` with `tool NOT IN ('Bash', 'exec_command')` and extend the comment above it (line 20) to say the Codex rows are held back the same way.

Tests, all in the files named:

In `test/codex_parser.spec.ts`, change the two existing expectations that assumed no output size: in "parses response_item function_call/function_call_output into tool_call + tool_results", the expected result becomes `{ ts: "2026-07-01T00:00:03Z", is_error: 0, result_chars: 2 }` (the output is `ok`); in "parses response_item custom_tool_call/custom_tool_call_output …", it becomes `{ ts: "2026-07-01T00:00:03Z", is_error: 0, result_chars: 21 }` (the output `{"output":"Success."}` is 21 code points). Add `describe("parseCodexFileBody — shell commands", …)` with:

- "records the files an exec_command call writes, relative to its workdir or else the session's cwd": a `session_meta` with `id: "s-sh"`, `cwd: "/w/app"`; a `function_call` `exec_command` with arguments `{"cmd":"cat > notes.md <<'EOF'\nhi\nEOF","workdir":"/w/app/docs"}`; another with `{"cmd":"sed -i '' 's/a/b/' src/x.ts"}` and no workdir; and one with `{"cmd":"ls -la"}`. The `file_op` rows, as `[tool, path]`, are `[["exec_command", "/w/app/docs/notes.md"], ["exec_command", "/w/app/src/x.ts"]]`.
- "marks a Codex tool call failed from its output, and counts the output's size": one call and one output per case, each with its own call id, then check `tool_results.get(id).is_error`. Errors (1): `Chunk ID: a\nWall time: 0.1 seconds\nProcess exited with code 1\nOriginal token count: 3\nOutput:\nboom`; `exec_command failed for `/bin/zsh -lc 'x'`: spawn error`; `aborted by user after 1.2s`; `Exit code: 1\nWall time: 0.2 seconds\nOutput:\nFailed`; `{"output":"Failed to read file","metadata":{"exit_code":1,"duration_seconds":0.0}}`; `apply_patch verification failed: Failed to find expected lines`; `patch rejected by user`; `Script failed\nWall time 0.1 seconds\nOutput:\n`; `write_stdin failed: stdin is closed for this session`; `Command blocked by PreToolUse hook: no pushes. Command: git push`. Not errors (0): the first case with code 0; `Chunk ID: b\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nProcess exited with code 1` (the second exit code is the command's own output); `Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess.`; `{"output":"Success.","metadata":{"exit_code":0}}`; `Script completed\nWall time 0.0 seconds\nOutput:\n`; and a list output `[{"type":"input_text","text":"Wall time: 1 seconds\nOutput:"},{"type":"input_text","text":"ok"}]`, whose `result_chars` is 30 (the code points of `Wall time: 1 seconds\nOutput:ok`).
- "ignores an exec_command whose cmd is not a string": arguments `{"cmd":42}` give the `tool_call` row, no `file_op` row and no anomaly.

Create `test/codex_parser_shell_guard.spec.ts` on the pattern of `test/claude_parser_shell_guard.spec.ts`, which uses `vi.mock` to make `shellWrittenFiles` throw: with the mock in place, an `exec_command` call with arguments `{"cmd":"echo hi > a.txt"}` still yields its `tool_call` row, yields no `file_op` row, and leaves the batch's `shell_writes_error` counter at 1.

In `test/mcp_left_off.spec.ts`, inside `describe("clens_left_off session record", …)`, add "reads a Codex exec_command's git commands and edits": `call("cx1", "mid", "2026-09-02T10:04:58Z", "exec_command", '{"cmd":"git add -A && git commit -m \\"codex fix\\"","workdir":"/w/app"}')`, and `edit("cx2", "mid", "2026-09-02T10:04:59Z", "exec_command", "/w/app/src/codex.ts")`; then `sessionRecord(db, "mid")!.git.map((g) => g.command)` contains `git add -A && git commit -m "codex fix"`, its `edits` paths contain `/w/app/src/codex.ts`, and `commandOf('{"cmd":"ls","workdir":"/w"}')` is `"ls"`, and for `const cut = '{"cmd":"git commit -m \\"' + "x".repeat(3000)`, `commandOf(cut.slice(0, 2048))!.startsWith('git commit -m "xxx')` is true.

In `test/analyzer_b2.spec.ts`, in the describe "D7 files leaves out files a Bash command wrote (held until decided)" (line 81), add a row with tool `exec_command` next to the Bash rows (line 89-90 style) and check it is left out the same way.

In `test/driver_multifile.spec.ts`, inside `describe("indexer — a Codex subagent rollout next to its parent", …)` (which has the `cline` helper), add "Codex shell calls: an append read incrementally matches a rebuild": set `CLENS_CODEX_HOME` as the neighbouring tests do; write a rollout with a `session_meta` (`id: "sh"`, `cwd: "/w/app"`), a `function_call` `exec_command` (`call_id: "c1"`, arguments `{"cmd":"echo hi > a.txt"}`) and its `function_call_output` (`Chunk ID: a\nWall time: 0\nProcess exited with code 0\nOutput:\n`); `bump` it and `runIndex()`; then append a second call (`call_id: "c2"`, `{"cmd":"git commit -m x && false"}`) and its output with `Process exited with code 1` in the header; `bump` and `runIndex()` again; take `digest()`; `runIndex({ rebuild: true })`; `expect(digest()).toBe(incremental)`. Also check, before the rebuild, that `SELECT name, is_error, result_chars FROM tool_call ORDER BY ts` gives `exec_command` with `is_error` 0 then 1 and non-null `result_chars`, and that `file_op` holds one row with tool `exec_command` and path `/w/app/a.txt`.

### Milestone 3: commands inside exec code

At the end of this milestone, shell commands that `exec` code runs through `tools.exec_command` count like direct calls: their written files are in the record, and their state-changing git commands are in the git list.

Create `src/util/codex_exec.ts` exporting `interface ExecCodeCommand { cmd: string; workdir: string | null }` and `execCodeCommands(code: string): ExecCodeCommand[]`. The function scans `code` once, left to right, keeping track of whether it is inside a `//` comment (to the end of the line), a `/* … */` comment, a `'…'` or `"…"` string (a backslash skips the next character), or a `` `…` `` template (a backslash skips the next character; `${` opens a nested code part that ends at its matching `}`). Only outside all of these, at a position where the text matches `/^tools\s*\.\s*exec_command\s*\(\s*\{/` and the character before is not a letter, digit, `_`, `$` or `.`, it reads the object literal that follows. Inside the literal, it reads properties separated by commas: a key (an identifier, or a `'…'` / `"…"` string) and, after `:`, a value. When the key is `cmd` or `workdir` and the value is a string literal (`'…'`, `"…"`, or a template with no `${`), it keeps the value, unescaped; any other value is skipped up to the next comma or closing brace at the same depth, stepping over nested strings, templates, comments, parentheses, brackets and braces. Unescaping follows JavaScript: `\n`, `\t`, `\r`, `\b`, `\f`, `\v`, `\0`, `\xHH`, `\uHHHH`, `\u{…}`, a backslash before a line break (removed with the break), and a backslash before any other character (gives that character). When the literal closes and a `cmd` string was kept, it appends `{ cmd, workdir }` (workdir `null` when absent or not a literal). The scan then continues after the literal. It never throws: on malformed code it returns what it found so far. Regular-expression literals in the code are not recognised; a `/` starts a comment only when followed by `/` or `*`.

In `src/indexer/codex_parser.ts`, in the `function_call` / `custom_tool_call` branch, when `name === "exec"` and `rawArgs` is not null, run `execCodeCommands(rawArgs)` (the whole code, not the cut `input_json`), and for each command call `shellWrittenFiles(cmd, workdir ?? state.cwd, homedir())` under the same `try` / `bumpAnomaly(batch, "shell_writes_error")` guard as Milestone 2, pushing `file_op` rows with tool `exec_command`. Keep the existing patch handling for `exec` as it is.

In `src/mcp/left_off.ts`, import `execCodeCommands` from `../util/codex_exec.js`. In the git query, use `name IN ('Bash', 'exec_command', 'exec')` and select `name` too; in the `flatMap` that follows (lines 322-325), take the commands as `name === "exec" ? execCodeCommands(input_json ?? "").map((c) => c.cmd) : [commandOf(input_json)]`, drop nulls, and run `stateChangingGitLines` on each, keeping the reversal the code does now. An `exec` input is stored cut at 2,048 bytes, so a git command past the cut is not listed; the files it wrote still are, because the parser reads the whole code.

Tests: create `test/codex_exec.spec.ts` with `describe("execCodeCommands", …)` and these cases, each an input and the exact expected array:

- `await tools.exec_command({cmd:"git status",workdir:"/w/app"})` gives `[{ cmd: "git status", workdir: "/w/app" }]`.
- `tools.exec_command({ cmd: 'echo \'hi\' > a.txt' })` (in the test source, the inner quotes are escaped for JavaScript) gives `[{ cmd: "echo 'hi' > a.txt", workdir: null }]`.
- `tools.exec_command({cmd:"cat > n.md <<'EOF'\nx\nEOF"})` where `\n` is the two characters backslash and n inside the code gives one command whose `cmd` holds real line breaks: `"cat > n.md <<'EOF'` + line break + `x` + line break + `EOF"`.
- `` tools.exec_command({cmd:`ls -la`}) `` gives `[{ cmd: "ls -la", workdir: null }]`; `` tools.exec_command({cmd:`ls ${dir}`}) `` gives `[]`; `const c = "ls"; tools.exec_command({cmd: c})` gives `[]`.
- `tools.exec_command({workdir:"/w", cmd:"pwd", yield_time_ms:1000})` gives `[{ cmd: "pwd", workdir: "/w" }]`; `tools.exec_command({"cmd":"pwd"})` gives `[{ cmd: "pwd", workdir: null }]`.
- `const [a, b] = await Promise.all([tools.exec_command({cmd:"npm test"}), tools.exec_command({cmd:"npm run build"})]);` gives the two commands in that order.
- `// tools.exec_command({cmd:'rm x'})` + line break + `/* tools.exec_command({cmd:'rm y'}) */ const s = "tools.exec_command({cmd:'rm z'})"; await tools.exec_command({cmd:'ls'})` gives only `[{ cmd: "ls", workdir: null }]`.
- `mytools.exec_command({cmd:"x"})` and `tools.exec_commandx({cmd:"x"})` give `[]`; an unterminated `tools.exec_command({cmd:"abc` gives `[]` without throwing.

In `test/codex_parser.spec.ts`, in the "shell commands" describe, add "records the files exec code writes through tools.exec_command": a `custom_tool_call` named `exec` with input `const r = await tools.exec_command({cmd:"echo hi > out.txt", workdir:"/w/app/tmp"}); await tools.exec_command({cmd:"ls"});` in a session with cwd `/w/app` gives the one `file_op` row `["exec_command", "/w/app/tmp/out.txt"]`; the existing test in "parseCodexFileBody — files a patch edits", whose third call is `exec` code running `ls`, keeps its expected list unchanged.

In `test/mcp_left_off.spec.ts`, add "reads the git commands exec code runs": `call("cx3", "mid", "2026-09-02T10:05:01Z", "exec", 'await tools.exec_command({cmd:"git switch -c codex-branch"});')` puts `git switch -c codex-branch` in `sessionRecord(db, "mid")!.git`.

### Milestone 4: Codex hook blocks

At the end of this milestone, a Codex session's record and `clens_stats` show the hooks that blocked it, as they do for Claude Code.

In `src/indexer/claude_parser.ts`, export `HOOK_REASON_BYTE_CAP` (line 46) so the Codex parser uses the same cap. In `src/indexer/codex_parser.ts`, import it and `utf8SafeTruncate` (already imported).

Add to `SessionState` a `callEvents: Map<string, ParsedEvent>` (call id to the parsed event of that call) and initialise it empty. In the `function_call` / `custom_tool_call` branch, when `callId` is not null, store `parsed` under it.

In the output branch, after computing `text`, check for a PreToolUse block: when `text` starts with `Command blocked by PreToolUse hook: ` the reason is the text after that prefix up to the last occurrence of `. Command: ` (or to the end when absent); when it starts with `Tool call blocked by PreToolUse hook: ` the reason runs up to the last `. Tool: `. When either matched and `state.callEvents.get(callId)` is a parsed event, push to its `hook_blocks` `{ event_uuid: thatEvent.event.uuid, session_id, ts: timestamp, hook_event: "PreToolUse", tool: thatEvent.tool_calls[0]?.name ?? null, call_id: callId, reason }` with `reason` trimmed, cut by `utf8SafeTruncate(reason, HOOK_REASON_BYTE_CAP).out`, and `null` when empty. The call is already an error by rule 1 of `codexOutputError`. The driver reads a whole rollout on every change, so a call and its output are always parsed together and the row lands the same way incrementally and on a rebuild.

In the `item_completed` branch (lines 593-599), when `item.type === "HookPrompt"` and `item.fragments` is an array, create one event (`makeBlankEvent(uuid, session_id, timestamp, source_file)` with no role) and, for each fragment that is an object with a string `text` and a string `hookRunId`, push a hook block `{ event_uuid: uuid, session_id, ts: timestamp, hook_event, tool: null, call_id: null, reason }`, where `hook_event` is the part of `hookRunId` before its first `:`, turned from snake_case into PascalCase (`stop` gives `Stop`, `subagent_stop` gives `SubagentStop`, `user_prompt_submit` gives `UserPromptSubmit`), and `reason` is the fragment's text trimmed and cut by `utf8SafeTruncate(…, HOOK_REASON_BYTE_CAP).out` (`null` when empty). Skip a fragment whose `hookRunId` has no `:` or an empty first part. Push the event only when it holds at least one hook block.

In `src/mcp/instructions.ts`, line 56 says "For Claude Code sessions it also reports hook blocks (which hook stopped which tool, with the latest reasons) and tool outp…"; make it "For Claude Code and Codex sessions it also reports …", and run `test/mcp_instructions.spec.ts` for the 2,048-character cap.

Tests, in `test/codex_parser.spec.ts`, `describe("parseCodexFileBody — hook blocks", …)`:

- "records a Stop hook's prompt as a hook block": an `event_msg` `item_completed` with `item: { type: "HookPrompt", id: "h1", fragments: [{ text: "keep going until the tests pass", hookRunId: "stop:4:/Users/x/.codex/hooks.json" }] }` gives one event whose `hook_blocks` is `[{ …, hook_event: "Stop", tool: null, call_id: null, reason: "keep going until the tests pass" }]`, and no `user_texts`.
- "records a PreToolUse block from the blocked call's output": a `function_call` `exec_command` (`call_id: "c9"`, arguments `{"cmd":"git push"}`) and its output `Command blocked by PreToolUse hook: pushes need review. Command: git push` give, on the call's event, the hook block `{ hook_event: "PreToolUse", tool: "exec_command", call_id: "c9", reason: "pushes need review" }`, and `tool_results.get("c9").is_error` is 1. The same with `Tool call blocked by PreToolUse hook: no MCP writes. Tool: mcp__db__write` on a call named `mcp__db__write` gives reason `no MCP writes` and tool `mcp__db__write`.
- "does not read hook-block wording inside a normal output": an output `Chunk ID: a\nWall time: 0\nProcess exited with code 0\nOutput:\nCommand blocked by PreToolUse hook: x. Command: y` gives no hook block and `is_error` 0.

In `test/mcp_left_off.spec.ts`, add "lists a Codex PreToolUse block under hook blocks, not failures": with `call("cb1", "mid", "2026-09-02T10:05:02Z", "exec_command", '{"cmd":"git push"}', 1, "c-block")` and `block("cb2", "mid", "2026-09-02T10:05:02Z", "PreToolUse", "exec_command", "c-block", "pushes need review")`, the record's `failures` has no `exec_command` entry and its `hook_blocks` reasons contain `pushes need review`.

In `test/driver_multifile.spec.ts`, extend the Milestone 2 Gate 2 test's appended part with a `HookPrompt` line and a blocked call and output, so the digest comparison covers `hook_block` too.

### Milestone 6: failures inside exec code (added at the user's request)

At the end of this milestone, an `exec` call whose code ran a command that failed is recorded as a failed call, so it shows under "Failed tool calls" in the record and in `clens_stats` error counts.

In `src/indexer/codex_parser.ts`, add to `SessionState` an `openExec: Map<string, Set<string>>` (call id of an `exec` call whose output has not come yet, to its literal commands) and a `failedExec: Set<string>` (call ids of `exec` calls one of whose commands failed), both initialised empty. In the `function_call` / `custom_tool_call` branch, when `name === "exec"`, `callId` is not null and `rawArgs` is not null, store `new Set(execCodeCommands(rawArgs).map((c) => c.cmd))` under the call id. In the `item_completed` branch, when `item.type === "CommandExecution"` and `item.exit_code` is a number other than 0, take its command (the last element of `item.command` when that is an array whose last element is a string, or `item.command` itself when it is a string) and add to `failedExec` every open `exec` call whose set holds that command. In the output branch, when the call id is in `openExec`, remove it there, and set `is_error` to 1 when `failedExec` holds it (then remove it from `failedExec`), otherwise to `codexOutputError(text)`.

In `src/indexer/schema.ts`, set `SCHEMA_VERSION` to 9 and add below the v8 comment: "v9: an exec call is failed when a command its code ran exited nonzero (a CommandExecution item naming one of its literal commands while it is open). v8 was released, so this needs its own rebuild."

Tests, in `test/codex_parser.spec.ts`, `describe("parseCodexFileBody — failures inside exec code", …)`, each with a `custom_tool_call` `exec` (`call_id: "x1"`, input `await tools.exec_command({cmd:"ls /no/such/dir"})`), then an `event_msg` `item_completed` `CommandExecution`, then the `custom_tool_call_output` `Script completed\nWall time 0.3 seconds\nOutput:\n`:

- "marks an exec call failed when a command it ran exited nonzero": the item has `command: ["/bin/zsh", "-lc", "ls /no/such/dir"]`, `exit_code: 1`; `tool_results.get("x1").is_error` is 1. The same with `command: "ls /no/such/dir"` (a string) is 1.
- "does not for a command that succeeded, one the code does not name, or one reported after the call ended": `exit_code: 0` gives 0; `exit_code: 1` with command `ls /other` gives 0; `exit_code: 1` for `ls /no/such/dir` placed after the output line gives 0.

In `test/driver_multifile.spec.ts`, extend the Codex Gate 2 test's appended part with such an `exec` call, a failing `CommandExecution` item and the output, and expect a fourth `tool_call` row `{ name: "exec", is_error: 1, … }`.

Validation: the tests above fail first (the first on `is_error` 0), then pass; `npm test` passes; typecheck is clean. Over the local rollouts, count `exec` calls the new rule marks failed and open some of them to check that a command in each really failed. Then `npm run build`; the user restarts every server; the version 9 rebuild settles; the real index holds more failed `exec` calls than before (15 at version 8).

### Milestone 7: commands still running, and exec commands built at run time (added at the user's request)

At the end of this milestone, the three gaps left after Milestone 6 are closed. A command still running when its `exec_command` call returns, whose exit a later `write_stdin` call reports, fails its own `exec_command` call instead of the `write_stdin` call. And a command that `exec` code builds at run time (its `cmd` is not a literal) counts from the `CommandExecution` item Codex writes for it: its written files and its failure go to the `exec` call. `SCHEMA_VERSION` goes to 10.

Background, measured over the local rollouts: 1,263 `exec_command` outputs report "Process running with session ID N" in their header instead of an exit code, and for 1,212 of them a later `write_stdin` call names the same N in its arguments (`{"session_id": N, "chars": …}`); its output carries the usual header, with "Process exited with code M" once the process ended. 90 `exec` calls run `tools.exec_command` with a `cmd` that is not a literal, and every one of them has `CommandExecution` items while it is open.

In `src/indexer/codex_parser.ts`, add to `SessionState`: `runningProcess: Map<number, string>` (a process session number to the call id of the `exec_command` call that started it and returned while it ran), `stdinTarget: Map<string, number>` (a `write_stdin` call id to the session number in its arguments), and `openDirect: Map<string, string>` (the call id of a direct `exec_command` call whose output has not come yet, to its `cmd`). Add `headerExitCode(text: string): number | null` (the number in "Process exited with code N" within the header, the part before the first "\nOutput:", or null) and `headerRunningSession(text: string): number | null` (the number in "Process running with session ID N" within the same header, or null).

When a `function_call` named `write_stdin` has a numeric `session_id` argument, record it in `stdinTarget`. When a direct `exec_command` call has a string `cmd`, record it in `openDirect`; remove it when its output comes. In the output branch: for an `exec_command` output whose header reports a running session and no exit code, record the session number in `runningProcess`. For a `write_stdin` output whose header has an exit code, when its session number is in `runningProcess`, the exit belongs to that `exec_command` call: if the code is not 0, set that call's result's `is_error` to 1 (keeping its `ts` and `result_chars`); remove the session from `runningProcess`; and the `write_stdin` call's own `is_error` is 1 only for its own failure lines (the prefixes rule of `codexOutputError`), not for the process's exit.

Replace `markFailedExec` with `readCommandExecution(item, state, batch)`. It ignores an item whose `source` is `user_shell` (a command the user ran), or whose command (the last element of `item.command` when an array, or `item.command` when a string) is not a string, and one whose command is the `cmd` of an open direct `exec_command` call (that call already has it). Otherwise, when an open `exec` call names the command among its literals, a nonzero `exit_code` marks that call failed (as in Milestone 6) and nothing else is read, since the call's own code already gave its files. When no open `exec` call names it and exactly one `exec` call is open, the item belongs to that call: its command's written files (`shellWrittenFiles` with the item's `cwd`, a `file://` URL turned into a path, or else the session's cwd) become `file_op` rows with tool `exec_command` on that call's event, with the call's `ts`; and a nonzero `exit_code` marks the call failed. With several `exec` calls open and no literal match, the item is not read.

In `src/indexer/schema.ts`, set `SCHEMA_VERSION` to 10 with the comment: "v10: a command still running when its exec_command call returned fails that call when a later write_stdin reports its nonzero exit; a command exec code built at run time counts from its CommandExecution item (written files, failure); a shell tool's stored input is kept up to 64 KB."

Tests, in `test/codex_parser.spec.ts`:

- "gives a running command's later exit to the exec_command call that started it": `exec_command` `c1` (`{"cmd":"npm test"}`), output `Chunk ID: a\nWall time: 1.0 seconds\nProcess running with session ID 88693\nOriginal token count: 0\nOutput:\n`, `write_stdin` `w1` (`{"session_id":88693,"chars":""}`), output `Chunk ID: b\nWall time: 5.0 seconds\nProcess exited with code 1\nOriginal token count: 3\nOutput:\nFAIL`: `c1` is 1 and `w1` is 0. With exit code 0, both are 0. A `write_stdin` naming an unknown session with exit code 1 is 1. `write_stdin failed: stdin is closed for this session` for the known session leaves `c1` at 0 and gives `w1` 1.
- "reads a command exec code built at run time from its CommandExecution item": `exec` `x1` with code `const c = "echo hi > out.txt"; await tools.exec_command({cmd: c})`, an item with command `["/bin/zsh","-lc","echo hi > out.txt"]`, `cwd: "file:///w/app/sub"`, `exit_code: 0`, then the output: `x1`'s event has the one `file_op` `["exec_command", "/w/app/sub/out.txt"]` and `x1` is 0; with `exit_code: 1`, `x1` is 1.
- "leaves a CommandExecution item alone when it belongs elsewhere or cannot be placed": the item's command is the `cmd` of an open direct `exec_command` call (no `file_op` on the `exec` event, `exec` 0); its `source` is `user_shell` (nothing); two `exec` calls are open and neither names it (nothing); the command is a literal of the open `exec` call and writes a file (exactly one `file_op`, from the code).

Extend the Codex Gate 2 test in `test/driver_multifile.spec.ts` with a running `exec_command`, its `write_stdin` reporting exit 1, and an `exec` call with a built command and its item.

Third, the stored input of a shell tool call is kept up to 64 KB instead of 2 KB, so the work record's git list sees a git command late in a long command. In `src/indexer/claude_parser.ts`, add and export `SHELL_TOOL_INPUT_BYTE_CAP = 65536` next to `TOOL_INPUT_BYTE_CAP` (line 42) and cut a `Bash` input at it (the `tool_use` branch, line 322); every other tool keeps 2,048. In `src/indexer/codex_parser.ts`, give `truncateToolInput` the cap as a parameter and use `SHELL_TOOL_INPUT_BYTE_CAP` for `exec_command` and `exec`, 2,048 for the rest. Measured over the local transcripts: the largest shell inputs are 27,398 bytes (`Bash`), 26,076 (`exec_command`) and 39,286 (`exec`), so none is cut at 64 KB, and the index grows by about 2.7 MB (Bash 1,746,492 bytes, `exec_command` 189,717, `exec` 765,957, over the 2 KB copies). Six inputs hold a state-changing git command that ends past 2 KB (five `Bash`, one `exec`, all within 5,532 bytes). Update the comments that say a stored shell input is cut at 2,048 bytes: `commandOf` and the git query in `src/mcp/left_off.ts`. Two existing tests assume a `Bash` input is cut at 2 KB and change: in `test/claude_parser.spec.ts`, "reads the full command, not the input cut at 2 KB" uses a command over 64 KB (`"x".repeat(70000)`) and checks the stored input is at most 65,536 bytes; "truncates tool_call.input_json over 2 KB and increments anomaly" uses a non-shell tool (`Write` with a 5,000-character `content`). New tests: a 5,000-byte `Bash` input is stored whole with no `tool_input_truncated`; in `test/codex_parser.spec.ts`, 5,000-byte `exec_command` arguments and `exec` code are stored whole and a 5,000-byte `apply_patch` input is cut at 2,048; in `test/claude_parser.spec.ts`, the stored input of a `Bash` command that runs `git commit -m "late"` after 3,000 bytes of other text still holds it, so `commandOf` (from `src/mcp/left_off.ts`) reads the whole command back (a record-side test would pass before the change, since it inserts the stored input itself).

Validation: the tests fail first, then pass; `npm test` passes; typecheck is clean. Over the local rollouts, count the `exec_command` calls that now fail through `write_stdin`, the `write_stdin` failures before and after, the `file_op` rows and failures that `CommandExecution` items add to `exec` calls and the items left unread, and open samples of each. Update `README.md`, `README.ko.md` and `skills/clens-recap/SKILL.md`, which say only a literal `cmd` counts in `exec` code. Then build, the user restarts every server, and the version 10 rebuild is checked.

### Milestone 5: documents, build and the real index

At the end of this milestone the documentation describes Codex as it now works, the built server is in use, and the real index holds the new Codex rows.

`README.md`: under "Limits" (around line 104), replace the line "Hook blocks, tool output size and `session_id: "current"` are Claude Code only." with "In Codex, no work record is put back after a subagent's compaction (Codex runs no hook there), and the compact hook runs only after you trust it with `/hooks`." Add a section "After compaction" before "Limits" that shows both registrations: for Claude Code, the `SessionStart` entry in `~/.claude/settings.json` (`"matcher": "compact"`, command `node /absolute/path/to/clens/hooks/compact.mjs`); for Codex, the `~/.codex/hooks.json` entry from Milestone 1 with the same command, `additionalContextLimit` 10000, and the `/hooks` trust step. Say that the hook needs `npm run build` first. `README.ko.md`: the same changes in Korean, in 합니다체 (formal Korean), following the style of the rest of that file. `CLAUDE.md`: the sentence "`file_op` also holds the files a Bash command wrote (tool `Bash`), read off the command text by `shell_writes.ts`." becomes "`file_op` also holds the files a shell command wrote, read off the command text by `shell_writes.ts`: tool `Bash` for Claude Code, tool `exec_command` for Codex (a direct call or one inside `exec` code)." `skills/clens-recap/SKILL.md`: where it says sessions whose transcripts were gone before the index reached v7 have no shell edits, add that for Codex it is v8. `docs/BACKLOG.md`: remove the Later item "`session_id "current"` in Codex, from the tool call's `_meta`", which this plan did, and in the item "Whether `clens_stats` file counts include shell-written files" name the Codex tool `exec_command` next to `Bash`.

Then build (`npm run build`) and run the end-to-end script, which now prints `PASS with _meta` and `PASS without _meta` and exits 0.

Register the hook for Codex. `~/.codex/hooks.json` is the user's own file (it holds context-mode's hooks today), so ask the user before editing it, and show them the entry. Keep a copy first (`cp ~/.codex/hooks.json ~/.codex/hooks.json.bak-clens`). Add to its `hooks.SessionStart` array the entry

    {
      "matcher": "compact",
      "hooks": [
        {
          "type": "command",
          "command": "node /Users/me/IdeaProjects/clens/hooks/compact.mjs",
          "additionalContextLimit": 10000
        }
      ]
    }

keeping every other entry as it is, and check that the file still parses (`node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME + "/.codex/hooks.json", "utf8"))'` prints nothing and exits 0). Codex runs the hook only after the user reviews and trusts it: the user opens Codex, types `/hooks`, and trusts the new SessionStart entry. Only the user can do that step.

Then the user restarts every running clens server (their Claude Code and Codex sessions), the index rebuilds, and the user does the manual `/compact` check in Concrete Steps. Check the real index as in Validation and Acceptance.


## Concrete Steps

All commands run from the repository root, `/Users/me/IdeaProjects/clens`, on the branch `feat/codex-support`. `node_modules` must be installed (`npm install` once if it is missing).

Before starting, confirm the baseline:

    $ npm run typecheck
    (no output after the script line)
    $ npm test
    Test Files  31 passed (31)
         Tests  440 passed (440)

For each milestone, write the tests first and run the file they are in; they fail before the code change (a missing export fails with `… is not a function`; a changed expectation fails with an `expected … to equal …` diff), and pass after it:

    $ npx vitest run test/mcp_current_session.spec.ts
    $ npx vitest run test/codex_parser.spec.ts test/codex_parser_shell_guard.spec.ts
    $ npx vitest run test/codex_exec.spec.ts
    $ npx vitest run test/mcp_left_off.spec.ts test/analyzer_b2.spec.ts test/driver_multifile.spec.ts
    $ npx vitest run test/mcp_instructions.spec.ts

After each milestone run `npm run typecheck` (no errors) and `npm test` (every file passes; the count rises by the tests added). Commit each milestone on its own.

Milestone 1 end-to-end check. Write the script and run it against the existing version 7 build in `dist/`, without rebuilding; it prints `FAIL with _meta` followed by `session_id "current" is not available here: this client does not tell clens which session …`, then `PASS without _meta`, and exits 1. (Checked while writing this plan: the version 7 server answers a `"current"` call that carries Codex `_meta` with that error, and answers `session_id: "codex-e2e"` with a record whose first line is `session:codex-e2e  project:-w-app  codex  started:2026-09-29T00:00:01Z  ended:2026-09-29T00:00:02Z`.) In Milestone 5, after the build:

    $ npm run build
    $ node test/scripts/codex-current-e2e.mjs
    PASS with _meta
    PASS without _meta

Milestone 5 manual check, done by the user after trusting the hook with `/hooks`: in a Codex session in any project, ask for one small task, then type `/compact`, then ask "what did you do before the compaction?". The rollout of that session (`ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1`) holds, right after the line whose `type` is `compacted`, a `response_item` developer message whose text contains `clens work record of this session` and `END-OF-CLENS-RECORD`. Find it with:

    $ grep -c "clens work record of this session" "$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1)"
    1

Milestone 5: build, then have every running clens server restarted (the user restarts their Claude Code and Codex sessions; each starts a new server). The first server to start on version 8 rebuilds the index. Read the stored version with a read-only connection from Node, which respects SQLite's locks:

    $ node -e 'const D = require("better-sqlite3"); const db = new D(process.env.HOME + "/.clens/index.db", { readonly: true, fileMustExist: true }); db.pragma("busy_timeout = 30000"); console.log(db.prepare("SELECT v FROM schema_version").all())'
    [ { v: 8 } ]

Wait until it prints 8 and the file's size stops changing. Do not read the live index with `sqlite3 "file:…?immutable=1"`: `immutable` ignores locks, and a read made while a server is writing can report "database disk image is malformed" for a database that is fine (a locked read-only `PRAGMA quick_check` on the same file then prints `ok`).


## Validation and Acceptance

Tests: `npm test` passes with every new test named in Plan of Work, and each new test fails when the code it covers is reverted. `npm run typecheck` reports no errors.

Behaviour, in the end-to-end script: `node test/scripts/codex-current-e2e.mjs` prints `PASS with _meta` and `PASS without _meta` and exits 0.

Behaviour, in a real Codex session (the user): after `/compact`, the model's next request carries the record (the `grep -c` above prints 1), and calling `clens_left_off` with `session_id: "current"` in that session returns a record whose first line starts with `session:<that session's id>`.

The real index after the version 8 rebuild, read with a read-only Node connection (never write to it):

- `SELECT count(*) FROM tool_call t JOIN session s ON s.id = t.session_id WHERE s.source = 'codex' AND t.is_error = 1` was 0 at version 7 and is now above 0. Open five of these calls' outputs in their rollouts and check that each shows a failure by one of the rules of `codexOutputError`.
- `SELECT count(*) … AND t.result_chars IS NOT NULL` was 0 and is now above 0.
- `SELECT count(*) FROM file_op f JOIN session s ON s.id = f.session_id WHERE s.source = 'codex' AND f.tool = 'exec_command'` was 0 and is now above 0; spot-check that the paths are ones those commands wrote.
- `SELECT hook_event, count(*) FROM hook_block h JOIN session s ON s.id = h.session_id WHERE s.source = 'codex' GROUP BY hook_event` shows `Stop` rows (the local rollouts hold 29 `HookPrompt` items; the count can be lower when some sit in skipped copies of a parent's history).
- `SELECT count(*) FROM anomaly WHERE kind = 'shell_writes_error'` is 0.
- The Claude Code rows are unchanged in kind: `SELECT count(*) FROM file_op WHERE tool = 'Bash'` is about what it was before the rebuild (1,672 at version 7, plus rows for sessions written since).


## Idempotence and Recovery

Every code step is an ordinary edit under git; rerunning a test or the end-to-end script changes nothing outside temporary directories, which the script removes. `npm run build` can be repeated.

The version bump rebuilds the index from the logs still on disk and keeps sessions whose logs are gone, so no conversation is lost. If the rebuild shows a problem, revert the commits of this plan (git revert, newest first) and set `SCHEMA_VERSION` back up to 9 rather than down to 7, so every server rebuilds once more with the old code; a lower number than the one in the database is not a safe way back. Several servers of different versions running at once rebuild the index in turn; after any build, restart all of them.

`~/.codex/hooks.json` belongs to the user. Before editing it, keep a copy (`cp ~/.codex/hooks.json ~/.codex/hooks.json.bak-clens`); to undo, remove the one SessionStart entry whose command names `hooks/compact.mjs`, or restore the copy.


## Artifacts and Notes

A direct `exec_command` call and its output, as Codex writes them (shortened):

    {"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call_…",
      "arguments":"{\"cmd\":\"git status --short --branch\",\"workdir\":\"/Users/me/IdeaProjects/paircli\",\"yield_time_ms\":1000,\"max_output_tokens\":1200}"}}
    {"type":"response_item","payload":{"type":"function_call_output","call_id":"call_…",
      "output":"Chunk ID: 182a2d\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 208\nOutput:\n…"}}

`exec` code as Codex writes it (shortened):

    {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec",
      "input":"const [a,b] = await Promise.all([\n  tools.exec_command({cmd:\"npm test\",workdir:\"/Users/fid…\"}), …"}}

A Stop hook's prompt:

    {"type":"event_msg","payload":{"type":"item_completed","item":{"type":"HookPrompt","id":"01a07f02-…",
      "fragments":[{"text":"OMX team pipeline is still active …","hookRunId":"stop:4:/Users/me/.codex/hooks.json"}]}}}

The `_meta` Codex 0.155.1 sends with an MCP tool call (keys from the source; values made up):

    { "callId": "call-1", "x-codex-turn-metadata": { "session_id": "01a0…", "thread_id": "01a0…", "turn_id": "01a0…", "model": "gpt-5.5", … } }


## Interfaces and Dependencies

No new dependency. The work uses the installed `@modelcontextprotocol/sdk` 1.29.0 (its `Client`, `StdioClientTransport` and `getDefaultEnvironment` only in the end-to-end script) and `better-sqlite3`.

In `src/mcp/current_session.ts`:

    export function codexSessionFromMeta(meta: unknown): string | undefined;

In `src/util/codex_exec.ts` (new):

    export interface ExecCodeCommand { cmd: string; workdir: string | null }
    export function execCodeCommands(code: string): ExecCodeCommand[];

In `src/indexer/codex_parser.ts` (module-private):

    function codexOutputText(output: unknown): string;
    function codexOutputError(text: string): 0 | 1;

and `SessionState` gains `callEvents: Map<string, ParsedEvent>`, `openExec: Map<string, { commands: Set<string>; built: boolean }>`, `failedExec: Set<string>`, `runningProcess: Map<number, string>`, `stdinTarget: Map<string, number>` and `openDirect: Map<string, string>`, with the module-private `readCommandExecution(item: Record<string, unknown>, state: SessionState, batch: AnomalyBatch): void`, `headerExitCode(text: string): number | null`, `headerRunningSession(text: string): number | null` and `ownFailure(text: string): 0 | 1`. `src/util/codex_exec.ts` also exports `execCodeScan(code: string): { commands: ExecCodeCommand[]; built: number }`, and `src/indexer/claude_parser.ts` exports `SHELL_TOOL_INPUT_BYTE_CAP = 65536`.

In `src/indexer/claude_parser.ts`, `HOOK_REASON_BYTE_CAP` becomes exported:

    export const HOOK_REASON_BYTE_CAP = 512;

In `src/mcp/left_off.ts`, `commandOf(inputJson: string | null): string | null` keeps its signature and also reads `cmd`; `EDIT_TOOLS` gains `'exec_command'`.

In `src/indexer/schema.ts`, `SCHEMA_VERSION = 10` (8 after Milestone 2, 9 after Milestone 6, 10 after Milestone 7).

New files: `src/util/codex_exec.ts`, `test/codex_exec.spec.ts`, `test/codex_parser_shell_guard.spec.ts`, `test/scripts/codex-current-e2e.mjs`.
