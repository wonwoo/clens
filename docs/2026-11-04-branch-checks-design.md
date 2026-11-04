# Checks on a branch — Design

- **Date**: 2026-11-04
- **Status**: Designed, not implemented
- **Experiments**: run against the author's own index and kept out of the repository; cited below as R1–R13. Project names, hosts, tickets and session ids from them are replaced with generic ones.

## Context

Users ask an agent whether work was already verified: "이거 테스트했었나", "sandbox에서 확인했어?", "cbt 배포됐냐". Since 2026-08-01 such questions came 53 times in 40 sessions across 11 projects, and "how far is it deployed" 15 times in 11 sessions (R12, keyword count, approximate). The answer is in the user's past sessions, in the commands agents ran: test runs, HTTP calls to a local or deployed server, browser pages opened, git pushes to deploy branches. Git knows what changed, not what was checked. clens stores every tool call with its input and whether it failed, but nothing groups them by the work they checked, and the agent has to search conversation text for them.

A researcher agent's survey of about 25 session-history tools (2026-11-04) found none that reports what was checked for a piece of work; that report is the only source for this claim.

**Goal.** An agent asked such a question calls `clens_left_off` with the project and the git branch, and gets, from every Claude Code and Codex session of the project, the checks run while that branch was checked out and the git push and merge commands that name it, grouped by kind and host, each group with its count, failures and latest run.

**Success criteria.**
- S1. For search-service's `feature/ABC-101-keyword-exclusion`, the result lists exactly the five sessions that were on the branch (R13), the local test runs, the local and sandbox HTTP calls and browser pages, and the pushes to dev-deploy, sandbox-deploy and cbt-deploy; nothing of ABC-102, worked on later in one of those sessions (R8, R11).
- S2. Without a branch name, the agent can list the project's latest branches with their checks and pick the one the user means.
- S3. A session's record (`clens_left_off` `session_id`) also lists its checks.
- S4. The server instructions send the agent to this for such questions, within Claude Code's 2,048-character cap.
- S5. Gate 2 (incremental == rebuild digest) still holds.

**Decisions made with the user (2026-11-04).**
- Extend `clens_left_off`; no new MCP tool, so agents read no further tool description each session.
- Find work by git branch only. Ticket keys are not used: they are one user's convention.
- A branch's checks are the calls made while it was checked out, plus git push and merge commands that name it, wherever they ran: deploying by checking out the deploy branch and merging the feature branch happens (argo, 2026-10-12).
- Without a branch, list the project's latest branches with their checks.
- The user asks in plain words; the agent finds the branch with `git branch --show-current` or `git branch -a`.
- A repository where work is committed straight to `main` gets no use from this; the user accepted that limit.

**Out of scope.** Ticket keys; following Codex branch switches inside a session (R7: 3 of 1,285 rollouts); checks made by scripts, skills or MCP tools other than the browser tools below; storing call output; fixing the existing Git section's treatment of `git merge-base` (see Known Limits).

## Checked Behavior

| # | Behavior relied on | How checked |
|---|---|---|
| B1 | Every Claude Code transcript line holding a `tool_use` block carries `gitBranch`, the branch checked out when that line was written | R5: all 41,233 such lines in 1,414 files |
| B2 | A line whose command switches branch carries the old branch; later lines carry the new one | R6 |
| B3 | Codex rollouts carry the branch only in `session_meta.payload.git.branch`; `turn_context` has none | R7; `src/indexer/codex_parser.ts:709-710` reads it into `state.git_branch`; a `turn_context` payload read in R7's rollout has no branch key |
| B4 | The four places that build Codex tool calls can read `state` | `src/indexer/codex_parser.ts`: `function_call`/`custom_tool_call` and the `mcp_tool_call_begin` and `exec_command_begin` branches are inside `processLine(…, state, …)`; `pushExecMcpCall` takes `state` (line 1151) |
| B5 | A column is added to an existing `tool_call` with `ALTER TABLE` in `applySchema()`, and `SCHEMA_VERSION` changes make `runIndex()` rebuild every transcript still on disk; the watcher indexes once when it starts | `src/indexer/schema.ts:9-11, 383-397`; `src/indexer/driver.ts:440-460`; commit a71b0a6 |
| B6 | The read-only MCP server can meet an index whose `tool_call` lacks a new column; `sessionRecord` already falls back when `error_excerpt` is missing | `src/mcp/left_off.ts:632-640` |
| B7 | Resumed sessions copy earlier lines; `notCopiedClause()` keeps one copy | `src/analyzer/scope.ts:30-43` |
| B8 | `workKindClause()` leaves out pipeline and exec sessions and their subagents | `src/analyzer/scope.ts:21-28` |
| B9 | Shell commands of a call: `commandOf` for Bash (`command`) and Codex `exec_command` (`cmd`); `execCodeCommands` for Codex `exec` code | `src/mcp/left_off.ts:326-355`; `src/util/codex_exec.ts` |
| B10 | Quoted text and heredoc bodies are not commands; `stateChangingGitLines` already skips them with `codePositions` and `HEREDOC` | `src/mcp/left_off.ts:359-441`; R2 shows the classifier needs the same |
| B11 | Browser navigation tools in the index: `mcp__playwright__browser_navigate` (Claude 444, Codex 3), `mcp__plugin_ecc_chrome-devtools__navigate_page` (2), `mcp__Claude_Browser__navigate` (1), each with a `url` argument; `browser_navigate_back` has none | index query, 2026-11-04 |
| B12 | Claude Code cuts server instructions and each tool description at 2,048 characters | comment and test: `src/mcp/instructions.ts:9-12`, `test/mcp_instructions.spec.ts` (not re-checked against Claude Code here) |
| B13 | The server instructions are 2,033 characters; with the edits below 2,044 | R9 |
| B14 | The `clens_left_off` description is 967 characters | R10 |
| B15 | Classifier rules below, tried on the real index: 69,487 calls in 1.3 s; samples showed the errors fixed by the rules for quoted text, heredocs, wrappers, top-level domains, `merge-base` and `--abort` | R1–R4, R11 |
| B16 | `tool_call.ts` is the call's own time; a session's subagents are sessions of kind `subagent` with `parent_id` set and the parent's `project_id` | `src/indexer/claude_parser.ts`; index rows in R13's query (`agent-a0000000000000002`, parent 00000000, project argo) |

Not checked: B12 against the current Claude Code build; how Claude Code writes `gitBranch` in a directory that is not a git repository (R5 found no empty value, so such lines carry some value or the field is absent; both are handled).

## Design

### Architecture

```
indexer:  claude_parser / codex_parser ──(tool_call.git_branch)──▶ SQLite
mcp:      shell_text.ts  ◀── left_off.ts ──▶ checks.ts ──▶ shell_text.ts
                                ▲                 ▲
                           server.ts ─────────────┘
```

- `src/indexer/*`: store, on each tool call, the branch checked out when it ran.
- `src/mcp/shell_text.ts` (new): the shell-text helpers that `left_off.ts` has today and `checks.ts` also needs. Moving them avoids an import cycle between `left_off.ts` and `checks.ts`.
- `src/mcp/checks.ts` (new): classify one call into checks, group checks, and answer the branch and branches queries. It imports `shell_text.ts`, `cutChars` from `search.ts` and the clauses from `../analyzer/scope.ts`; it never imports `left_off.ts`.
- `src/mcp/left_off.ts`: uses `shell_text.ts`; adds a Checks section to the session record using `checks.ts`.
- `src/mcp/server.ts`: new parameters `branch` and `branches` on `clens_left_off`.

### Data model

`tool_call` gets one column, last: `git_branch TEXT`. `SCHEMA_VERSION` becomes 17.

- Claude Code: the `gitBranch` of the line that holds the `tool_use` block, when it is a non-empty string; otherwise NULL.
- Codex: `state.git_branch` (from `session_meta.payload.git.branch`) when the call is built; NULL when the rollout names none.
- Sessions whose transcripts are gone keep their rows from before v17, with NULL. Every query reads `COALESCE(t.git_branch, s.git_branch)`, the call's branch or else the session's starting branch, and marks a session matched only that way.

Invariant: the value depends only on the call's own file and the lines before it in that file, so Gate 2 holds (`digest.ts` hashes `SELECT *`).

### Check rules

A check is `{ kind, where, host, target }`:

| kind | Comes from | where | host | target |
|---|---|---|---|---|
| `test` | a test-runner command (below) | `local` | null | its simple command |
| `api` | `curl`, `wget`, `http`, `https` or `xh` with an `http://` or `https://` URL later in the same simple command; the first such URL, quoted or not, ending before whitespace or any of `'"\)` | `whereOfUrl` | URL host with port | the URL |
| `browser` | a tool whose name is, or ends after `__` with, `browser_navigate`, `navigate_page` or `navigate`, whose JSON input has a string `url` | `whereOfUrl` | URL host with port | the URL |
| `git` | `git [-C <dir>] push …`, or `git [-C <dir>] merge …` other than `merge-base` and `merge --abort`, `--continue`, `--quit` | `""` | null | its simple command |

Shell text is read from each command of `shellCommands(name, inputJson)` (Bash, `exec_command`, Codex `exec`), line by line with `codeLines` (below). A match counts only when the program word starts at a code position: not inside quotes, not in a comment, not in a heredoc body (R2). A command word may follow the line start, `&&`, `||`, `;`, `|`, `(` or `$(`, then any `NAME=value` assignments, then any of these wrappers: `sudo`, `time`, `env`, `exec`, `nohup`, `nice` with an optional `-n <n>`, `timeout` with its options and duration (R11). A **simple command** runs from the first word after those assignments and wrappers (the program word) to the next `&&`, `||`, `;` or `|` at a code position, or to the line end, trimmed. Taking only the simple command keeps a later `git merge --abort` or `echo` on the same line out of a target (R8 printed such lines).

Test runners (first words, then what must follow):
- `gradle`, `gradlew` or `./gradlew` (any path): a task argument that is `test`, `check`, ends with `:test` or `:check`, or ends with `Test` (`integrationTest`). `spotlessCheck` is not one.
- `mvn`, `mvnw` (any path): an argument `test`, `verify` or `integration-test`.
- `npm`, `pnpm`, `yarn`, `bun` followed by `test`, `test:<x>`, `run test` or `run test:<x>`.
- `npx`, `pnpm exec`, `pnpm dlx`, `yarn`, `bunx` followed by `vitest`, `jest`, `mocha` or `playwright test`.
- `vitest`, `jest`, `mocha`, `pytest`, `py.test`, `tox`, `nox`, `rspec`, `phpunit` (any path).
- `python -m pytest`, `python3 -m pytest`.
- `go test`, `cargo test`, `cargo nextest`, `dotnet test`, `swift test`, `deno test`, `bun test`, `mix test`, `rails test`, `bundle exec rspec`, `bundle exec rails test`, `make test`, `make check`.

`whereOfUrl(url)` returns null when `url` does not parse as `http:` or `https:`. Otherwise, with `hostname` lower-cased and its `[ ]` removed:
- `local` when it is `localhost`, ends with `.localhost`, is `0.0.0.0`, `::1`, `host.docker.internal`, or starts with `127.`;
- else the first label, in hostname order, that is one of `dev`, `develop`, `development`, `sandbox`, `staging`, `stage`, `stg`, `qa`, `test`, `cbt`, `beta`, `preprod`, `prod`, `production`, where the labels are the dot-separated parts without the last one (the top-level domain, R4), each also split at `-`;
- else `other`.

A call gives at most one `test` and one `api` check per simple command, a `browser` check per browser call, and a `git` check per matching git command.

A check failed when its call's `is_error` is 1.

### Interfaces

`src/mcp/shell_text.ts` (moved from `left_off.ts` unchanged unless stated):

```ts
export function commandOf(inputJson: string | null): string | null;
export function shellCommands(name: string, inputJson: string | null): string[]; // was private in left_off.ts
/** Every line of `command` outside heredoc bodies, trimmed, oldest first:
 *  `code[i]` is true where `line[i]` is shell code (codePositions), and
 *  `body` is the heredoc body that line opens (lines joined by "\n"), or null. */
export function codeLines(command: string): { line: string; code: boolean[]; body: string | null }[];
```

`codePositions`, `SHELL_C` and `HEREDOC` move with them, unexported. `left_off.ts` keeps `stateChangingGitLines`, rewritten over `codeLines` with the same output (a git line that opens a heredoc gets ` ⏎ ` and the body's first non-empty line), and re-exports `commandOf` (`export { commandOf } from "./shell_text.js"`), which `test/claude_parser.spec.ts` imports from `left_off.js`.

`src/mcp/checks.ts`:

```ts
export type CheckKind = "test" | "api" | "browser" | "git";
export interface CallCheck { kind: CheckKind; where: string; host: string | null; target: string }
export function whereOfUrl(url: string): { where: string; host: string } | null;
export function checksOfCall(name: string, inputJson: string | null): CallCheck[];

/** One call's checks with the call's session, time and is_error. */
export interface CheckRow { session_id: string; ts: string; is_error: number; check: CallCheck }
/** Checks of one kind, where and host (git excluded). */
export interface CheckGroup {
  kind: "test" | "api" | "browser"; where: string; host: string | null;
  count: number; failed: number; last_ts: string; last_target: string; last_session: string;
}
/** Groups of the non-git rows, ordered by last_ts, oldest first; rows in ts order. */
export function groupChecks(rows: CheckRow[]): CheckGroup[];
export function formatCheckGroup(g: CheckGroup): string;

export interface BranchChecksParams { project_id: string; branch: string; since?: string; until?: string }
export interface BranchSession { session_id: string; source: string; first_ts: string; last_ts: string; start_branch_only: boolean }
export interface BranchChecks {
  project_id: string; branch: string;
  sessions: BranchSession[]; sessions_total: number;   // latest 10, oldest first
  groups: CheckGroup[]; groups_total: number;          // latest 20 by last_ts, oldest first
  git: { ts: string; session_id: string; line: string; failed: boolean }[]; git_total: number; // latest 20, oldest first
}
export function branchChecks(db: Database.Database, p: BranchChecksParams): BranchChecks;
export function formatBranchChecks(r: BranchChecks): string;

export interface BranchSummary { branch: string; last_ts: string; sessions: number; checks: { label: string; count: number }[] }
export function recentBranches(
  db: Database.Database,
  p: { project_id: string; since?: string; until?: string; limit?: number },
): { branches: BranchSummary[]; more: number };
export function formatRecentBranches(project_id: string, r: { branches: BranchSummary[]; more: number }): string;

/** The error to return for branch/branches parameters, or null when they are valid. */
export function branchParamsError(p: {
  project_id?: string; branch?: string; branches?: boolean; file?: string; text?: string; commits?: string[];
}): string | null;
```

`branchChecks`:
- Calls: `tool_call t JOIN session s ON s.id = t.session_id` where `s.project_id = project_id`, `workKindClause("s")`, `notCopiedClause("t.event_uuid", "t.session_id")`, the name is `Bash`, `exec_command`, `exec` or `LIKE '%navigate%'`, and `since`/`until` bound `t.ts` (inclusive), ordered by `t.ts`. Each call's branch is `COALESCE(t.git_branch, s.git_branch)`. A check is kept when the call's branch equals `branch`, or when it is a `git` check whose target names `branch`: `branch` appears preceded by the line start, whitespace, `:`, `/`, `'`, `"` or `=`, and followed by the line end, whitespace, `:`, `'`, `"`, `~` or `^` (so `feature/x` does not match `feature/x-2`, and `origin/feature/x` and `sha:refs/heads/feature/x` do).
- Sessions: every session with a tool call of any name on `branch`, under the same project, `workKindClause`, `notCopiedClause` and `since`/`until` conditions, with its first and last such call and `start_branch_only` true when any of those calls had NULL `git_branch`. The source is `s.source`. Ordered by first call.
- When `t.git_branch` does not exist (an index the watcher has not opened since the upgrade; the error message matches `/no such column: (t\.)?git_branch/`), both queries run again with `NULL` in its place.

`recentBranches`: branches are the distinct `COALESCE(t.git_branch, s.git_branch)` over the project's calls of any name, under the same `workKindClause`, `notCopiedClause` and `since`/`until` conditions as `branchChecks`, leaving out NULL, `''` and `HEAD`, ordered by their latest call, newest first; `limit` defaults to 3, at most 10. `more` is how many were left out. For each listed branch, `sessions` is `branchChecks(…).sessions_total` and `checks` comes from its `groups` (same `since`/`until`): one label `<kind> <where>` per distinct pair with the sum of its groups' counts, ordered by kind (`test`, `api`, `browser`) then where alphabetically, then `git` with `git_total` when above 0. Example: `test local 3, api local 1, api sandbox 1, git 1`.

`branchParamsError`, applied only when `branch` is given or `branches` is true: `"branch and branches need project_id, the project the branch is in"` without `project_id`; `"pass branch or branches, not both"` with both; `"branch and branches take no file, text or commits"` with any of those. Otherwise null.

### Output formats

`formatCheckGroup`: `<kind> <where>[ <host>]: <count> <noun>, <failed> failed, last <last_ts>: <last_target cut to 160 characters> (session <last_session>)`, where noun is `run`/`runs` (test), `call`/`calls` (api), `page`/`pages` (browser), singular for 1. Example: `api sandbox search-api.sandbox.example.net: 3 calls, 0 failed, last 2026-10-21T01:28:05.000Z: http://search-api.sandbox.example.net/… (session 00000000-0000-4000-8000-000000000003)`.

`formatBranchChecks`, when there are sessions or git lines:

```
Branch <branch> in <project_id>
Sessions on it (last <n> of <total>), first and last call on it:
  <session_id>  <source>  <first_ts> – <last_ts>[  (branch from the session's start)]
Checks (last <n> of <total>, by kind and host):
  <formatCheckGroup>
Git push and merge on it or naming it (last <n> of <total>):
  <ts>  <line cut to 160 characters>  (session <session_id>)[  failed]
A check that did not fail exited 0; clens keeps no output of a call that succeeded, so read the reply after a check with clens_session (its session and time) to know what it returned.
```

An empty list prints its header line as `Checks: (none)` or `Git push and merge on it or naming it: (none)`. With no session and no git line the whole output is `No session in <project_id> made a call on branch <branch>, and no git push or merge names it. Pass branches: true for the project's branches.`

`formatRecentBranches`:

```
Branches in <project_id>, latest first:
[1] <branch>  last <last_ts>  <n> sessions  checks: <label> <count>, <label> <count>   ("1 session" for one; "checks: none" when there is none)
…
(+<more> more branches; raise limit, max 10)        ← only when more > 0
Pass branch with one of them for its checks.
```

No branch: `No branch recorded in <project_id>.`

Session record: `SessionRecord` gets `checks: CheckGroup[]` (latest `RECORD_LIST_CAP` groups by `last_ts`, oldest first) and `checks_total: number`, from the calls of the session and its subagents (`TREE`), git excluded (the Git section shows those). `formatSessionRecord` prints it right after the Git section, with the record's `section()` helper: header `Checks (last <n> of <total>):`, each row `  <formatCheckGroup>`, or `Checks: (none)`.

### `clens_left_off` parameters and text

`LeftOffParamsSchema` (`src/mcp/server.ts`) adds `branch: z.string().min(1).optional()` and `branches: z.boolean().optional()`. The handler order: `session_id` (others ignored, as now); then, when `branch` is given or `branches` is true, `branchParamsError` (an error returns `Invalid params: <message>` with `isError: true`), then `formatBranchChecks(branchChecks(…))` or `formatRecentBranches(project_id, recentBranches(…))`; then `text`, `commits` and the list, as now.

Tool description: after `then clens_session to read more of one. ` insert:

> With project_id and branch (a git branch name, as `git branch --show-current` prints it), returns the checks run while that branch was checked out, in every Claude Code and Codex session of the project, and the git push and merge commands that name it: test runs, HTTP calls (curl, wget, httpie, xh) and browser pages, by host, each with its failures and latest run. Use it for "did we test this", "was it checked on sandbox", "is it deployed to cbt". With branches: true, the project's latest branches with their checks, to find the one the user means. A check that did not fail exited 0, which does not say its result was right.

Property descriptions:
- `branch`: `A git branch of the project, as git branch --show-current prints it. Returns its checks instead of a list; needs project_id. since and until narrow it; limit is ignored, and file, text and commits are an error with it.`
- `branches`: `true lists the project's latest branches, newest activity first, each with its checks; needs project_id. limit (default 3, max 10), since and until apply.`
- `session_id`: `edited files, git commands, failed tool calls` becomes `edited files, git commands, checks (test runs, HTTP calls and browser pages, by host), failed tool calls`, and `project_id, file, since, until, limit, commits and text are then ignored.` becomes `project_id, file, since, until, limit, commits, text, branch and branches are then ignored.`

The description grows from 967 to 1,598 characters (B14 plus the 630 inserted and a space), under 2,048.

Server instructions (`src/mcp/instructions.ts`), four edits (R9, 2,044 characters):
1. `every user message and assistant reply, with session ids and timestamps.` → `every user message and assistant reply.`
2. After the line ending `(clens_left_off)` add `- if it was tested or deployed: "did we test it on sandbox" (clens_left_off branch)`.
3. `Keyword search, not semantic; see its query rules.` → `Keyword search; see its query rules.`
4. `clens_recent: messages in a time window. clens_stats: tool and file counts.` → `clens_recent: a time window. clens_stats: counts.`

README.md and README.ko.md, `clens_left_off` row: add "and the checks run on a branch" / "브랜치에서 한 확인(테스트, API 호출, 화면 확인, 배포)".

### File structure

| File | Change |
|---|---|
| `src/mcp/shell_text.ts` | new: `commandOf`, `shellCommands`, `codeLines` (+ private `codePositions`, `SHELL_C`, `HEREDOC`) |
| `src/mcp/checks.ts` | new: check rules, grouping, branch queries, formats, `branchParamsError` |
| `src/mcp/left_off.ts` | import from `shell_text.ts`; `stateChangingGitLines` over `codeLines`; re-export `commandOf`; `checks`/`checks_total` in `SessionRecord`; Checks section |
| `src/mcp/server.ts` | schema, handler, descriptions |
| `src/mcp/instructions.ts` | four edits |
| `src/indexer/types.ts` | `ToolCallRow.git_branch: string \| null` with a doc comment |
| `src/indexer/schema.ts` | column in `CREATE TABLE tool_call` after `error_excerpt`; `ALTER TABLE tool_call ADD COLUMN git_branch TEXT` in `applySchema()` after the `error_excerpt` one; `SCHEMA_VERSION = 17` with a `v17:` note |
| `src/indexer/writer.ts` | `insertToolCall` writes `git_branch` |
| `src/indexer/claude_parser.ts` | `walkContent` takes `gitBranch: string \| null` from `parseEventLine` and sets it on each tool call |
| `src/indexer/codex_parser.ts` | the four tool-call sites of B4 set `git_branch: state.git_branch` |
| `test/mcp_checks.spec.ts` | new |
| `test/mcp_left_off.spec.ts`, `test/claude_parser.spec.ts`, `test/codex_parser.spec.ts`, `test/schema.spec.ts`, `test/mcp_instructions.spec.ts` | additions; expected tool-call objects gain `git_branch` |
| `README.md`, `README.ko.md` | one row each |
| `plugin/` | rebuilt with `npm run build` |

## Assumptions To Check

1. Claude Code writes `gitBranch` on every line with a `tool_use` block, as the branch when that line was written (B1, B2).
2. Codex's branch is only in `session_meta.payload.git.branch` (B3), and each Codex tool-call site can read `state` (B4).
3. Adding the column by `ALTER TABLE` plus the version bump re-derives `git_branch` for every transcript on disk on the watcher's first run after the update, and leaves NULL for sessions whose transcripts are gone (B5).
4. A server meeting an index without the column answers through the NULL fallback rather than failing (B6).
5. With the column stored, `branchChecks` on search-service answers in under 1 second (R8 took 1.8 s, 1.6 s of it reading transcripts that the column replaces).
6. The code-aware classifier keeps R11's counts for the ABC-101 branch: 10 local test runs, the localhost:8282 and localhost:3000 groups, three sandbox API hosts, sandbox browser pages, and no `merge-base` or `--abort` line.

## Implementation Order

1. **Move the shell helpers.** Create `src/mcp/shell_text.ts`; move `commandOf`, `shellCommands`, `codePositions`, `SHELL_C`, `HEREDOC`; add `codeLines`; rewrite `stateChangingGitLines` over it; re-export `commandOf` from `left_off.ts`. Check: `npm run typecheck`; `npx vitest run test/mcp_left_off.spec.ts test/claude_parser.spec.ts` pass with no test changed.
2. **Check rules.** Create `checks.ts` with `CheckKind`, `CallCheck`, `whereOfUrl`, `checksOfCall`. Write the tests first in `test/mcp_checks.spec.ts`, each failing before the code:
   - test: `./gradlew :core:test --tests "a.B"`, `timeout 580 ./gradlew --offline -q :core:test`, `npm test 2>&1 | tail`, `npx vitest run x`, `cd app && pytest -q`, `go test ./...`, `./gradlew check` give one `test` check each; `./gradlew spotlessCheck`, `grep -n "a\|vitest" f`, `echo "npm test"`, and a `python3 - <<'EOF'` whose body holds `; npx vitest` give none.
   - api: `curl -s http://localhost:8282/x` → `local`, host `localhost:8282`; `curl https://search-prod.es.example.net:9200/_cat` → `prod`; `curl -sL https://technical-writing.dev/a` → `other`; `wget https://cbt-shop.example.com/` → `cbt`; `curl http://10.0.0.1/` → `other`; `echo "curl http://localhost/"` → none.
   - browser: `mcp__playwright__browser_navigate` `{"url":"http://localhost:3000/a"}` → `local`; `mcp__playwright__browser_navigate_back` `{}` → none; a cut input (invalid JSON) → none.
   - git: `git push origin dev-deploy` and `git checkout sandbox-deploy && git merge --ff-only feature/x` → one `git` check each; `git merge-base HEAD main` and `git merge --abort` → none.
   - Codex: name `exec`, input `tools.exec_command({cmd:"npm test"})` → one `test` check.
   - `whereOfUrl`: `http://127.0.0.1:7777/` and `http://[::1]:3000/` → `local`; `ftp://x/` and `not a url` → null.
   Check: `npx vitest run test/mcp_checks.spec.ts`.
3. **Store the branch.** `types.ts`, `schema.ts` (column, `ALTER`, version 17 and note), `writer.ts`, `claude_parser.ts`, `codex_parser.ts`. Tests first: `schema.spec.ts` upgrade test also expects `git_branch TEXT`; `claude_parser.spec.ts`: two lines with `gitBranch` `main` then `feature/x` give tool calls with those values, a line without it gives null; `codex_parser.spec.ts`: a rollout whose `session_meta` has `git.branch` `feature/y` gives that value on its `exec_command` call, and one without `git` gives null; fix expected tool-call objects there to include `git_branch`. Check: `npx vitest run test/schema.spec.ts test/claude_parser.spec.ts test/codex_parser.spec.ts test/driver.spec.ts test/driver_multifile.spec.ts` (the driver specs hold Gate 2).
4. **Branch queries.** `CheckRow`, `CheckGroup`, `groupChecks`, `formatCheckGroup`, `branchChecks`, `formatBranchChecks`, `recentBranches`, `formatRecentBranches`, `branchParamsError`. Tests first, on an in-memory DB built with `applySchema` and inserted rows (as `test/mcp_left_off.spec.ts` does), project `-w-app`:
   - session A (claude, interactive, `session.git_branch` `main`): a Bash call with `git_branch` `main`, then calls with `git_branch` `feature/x`: `npm test`, `curl http://localhost:8080/h`; B (claude, subagent, `parent_id` A, same project): `npx vitest run` on `feature/x`; C (codex, interactive): `exec_command` `{"cmd":"curl https://api.sandbox.example.com/v1"}` on `feature/x` with `is_error` 1; D (claude, interactive, on `main`): `git checkout sandbox-deploy && git merge feature/x`; E (claude, interactive, `session.git_branch` `feature/x`, its calls with `git_branch` NULL): `pytest`; F (project `-w-web`, `feature/x`): `npm test`; G (kind `exec`, `feature/x`): `npm test`; H (claude, interactive, `session.git_branch` `feature/x`): a resumed copy of B's call, set up as `notCopiedClause` reads it: one `event` row with B's call's `event_uuid` and `session_id` B, and two `tool_call` rows with that `event_uuid`, B's own and an identical one with `session_id` H.
   - `branchChecks(feature/x)`: sessions A, B, C, E in first-call order, E marked start-branch-only, D absent; groups `test local` count 3 (A, B, E), `api local localhost:8080` 1, `api sandbox api.sandbox.example.com` 1 with 1 failed; git: D's merge line; F, G and H add nothing.
   - Naming, on a separate in-memory DB: one claude interactive session on `main` in `-w-app` runs four Bash calls, `git push origin feature/x-2`, `git push origin feature/x`, `git push origin abc123:refs/heads/feature/x` and `git merge origin/feature/x`. `branchChecks` for `feature/x` returns the last three as `git` lines and not the first, with `sessions` empty (no call ran on `feature/x`).
   - `since` set after A's last call leaves A out of `sessions` and its checks out of `groups`.
   - An index whose `tool_call` lacks `git_branch`: build the main fixture, then run `ALTER TABLE tool_call DROP COLUMN git_branch` (`applySchema` would add the column back, so it is not called again; DROP COLUMN works in the bundled SQLite 3.49.2, checked 2026-11-04). Then A's calls all count under `main`, E's under `feature/x`, and E is marked start-branch-only.
   - `recentBranches` on the main fixture, adding one claude interactive session whose calls have `git_branch` `HEAD`, then one with NULL `git_branch` and NULL `session.git_branch`: branches are `feature/x` then `main` when `feature/x`'s latest call is the later one; `HEAD` and NULL are not listed; `limit: 1` lists `feature/x` with `more` 1; `feature/x`'s labels are `test local 3, api local 1, api sandbox 1, git 1` in that order and `sessions` 4 (A, B, C, E).
   - `branchParamsError`: the three messages and null.
   - exact `formatBranchChecks` and `formatRecentBranches` output for the fixture, including the empty cases.
   Check: `npx vitest run test/mcp_checks.spec.ts`.
5. **Session record.** `checks` and `checks_total` in `SessionRecord`, the Checks section after Git. Tests first in `test/mcp_left_off.spec.ts`: a session with a test run, a curl and a `git push` shows `Checks (last 2 of 2):` with the two groups and the push only under Git; a session with none shows `Checks: (none)`; the existing exact-output tests gain the Checks line. Check: `npx vitest run test/mcp_left_off.spec.ts`.
6. **Tool and texts.** `server.ts` schema, handler and descriptions; `instructions.ts` edits; README rows. Tests first in `test/mcp_instructions.spec.ts`: `SERVER_INSTRUCTIONS` contains `(clens_left_off branch)` and stays at most 2,048 characters. Check: `npx vitest run test/mcp_instructions.spec.ts`; `npm run typecheck`.
7. **Whole build.** `npm test`, `npm run build`, `node test/scripts/plugin-smoke.mjs`. Check: all exit 0, and `git status --short plugin/` lists the rebuilt bundles.

## Acceptance

- A1. `npm run typecheck` and `npm test` exit 0.
- A2. Every step's tests above exist and passed after failing first.
- A3. The scenarios below give the expected output.
- A4. `SERVER_INSTRUCTIONS.length` ≤ 2,048 and the `clens_left_off` description ≤ 2,048 characters.

Scenarios, from the repository root after step 7. They build a fresh index of this machine's transcripts in a temporary folder (reading `~/.claude` and `~/.codex`, writing only the folder); `~/.clens` is not touched. They depend on transcripts from 2026-10-19 to 2026-10-23, which Claude Code's default 30-day cleanup removes from about 2026-11-18.

```sh
export CLENS_INDEX_DIR=$(mktemp -d /tmp/skerry-branch-checks.XXXX)
node plugin/dist/cli.js index > "$CLENS_INDEX_DIR/index.log" 2>&1; echo $?
```
Expected: `0`.

```sh
cat > "$CLENS_INDEX_DIR/q.ts" <<'EOF'
import Database from "better-sqlite3";
import { branchChecks, formatBranchChecks, recentBranches, formatRecentBranches } from "./src/mcp/checks.ts";
import { formatSessionRecord, sessionRecord } from "./src/mcp/left_off.ts";
import { indexDbPath } from "./src/util/paths.ts";
const db = new Database(indexDbPath(), { readonly: true, fileMustExist: true });
const P = "-Users-me-IdeaProjects-search-service";
const t0 = Date.now();
const out = formatBranchChecks(branchChecks(db, { project_id: P, branch: "feature/ABC-101-keyword-exclusion" }));
console.error(`ms ${Date.now() - t0}`);
const which = process.argv[2];
console.log(which === "branch" ? out
  : which === "branches" ? formatRecentBranches(P, recentBranches(db, { project_id: P }))
  : formatSessionRecord(sessionRecord(db, "00000000-0000-4000-8000-000000000003")!));
EOF
cp "$CLENS_INDEX_DIR/q.ts" ./q-skerry.ts
npx tsx ./q-skerry.ts branch > "$CLENS_INDEX_DIR/branch.txt" 2> "$CLENS_INDEX_DIR/ms.txt"
sed -n '/^Sessions on it/,/^Checks/p' "$CLENS_INDEX_DIR/branch.txt" | grep -c -E '00000000-0000-4000-8000-000000000001|00000000-0000-4000-8000-000000000002|00000000-0000-4000-8000-000000000003|agent-a0000000000000001|agent-a0000000000000002'
sed -n '/^Sessions on it/,/^Checks/p' "$CLENS_INDEX_DIR/branch.txt" | grep -c '^  '
grep -c -E '^  test local: 10 runs, 0 failed|^  api local localhost:8282:|^  browser local localhost:3000:|^  api sandbox search-api\.sandbox\.example\.net:|^  browser sandbox sandbox-admin\.example\.com:' "$CLENS_INDEX_DIR/branch.txt"
grep -c -E 'refs/heads/cbt-deploy|git push origin dev-deploy sandbox-deploy' "$CLENS_INDEX_DIR/branch.txt"
grep -c -E 'merge-base|merge --abort|ABC-102' "$CLENS_INDEX_DIR/branch.txt"
grep '^ms ' "$CLENS_INDEX_DIR/ms.txt" | awk '{ exit !($2 < 1000) }'; echo $?
```
Expected, one per line: `5`, `5`, `5`, `3`, `0`, `0` (the five sessions of R13 and no other; the five groups of R11; the dev/sandbox push and the two cbt-deploy pushes of the 2026-10-21T04:40:20Z call, one to search-service and one, after `cd`, to the same feature's admin repository `search-admin`, each a git command of its own by the rules; nothing caught wrongly or from ABC-102; under 1 second). The user chose on 2026-11-04 to keep the rules and count both cbt-deploy pushes: the admin push deployed the same feature.

```sh
npx tsx ./q-skerry.ts branches | head -1
npx tsx ./q-skerry.ts branches | grep -c '^\[[0-9]\] '
npx tsx ./q-skerry.ts record | grep -c -E '^Checks \(last [0-9]+ of [0-9]+\):'
npx tsx ./q-skerry.ts record | sed -n '/^Checks (/,/^[A-Z]/p' | grep -c '^  git'
rm ./q-skerry.ts
```
Expected: `Branches in -Users-me-IdeaProjects-search-service, latest first:`, `3`, `1`, `0`.

## Known Limits

- Codex: a call carries the branch the rollout started on; a `git switch` inside the session is not followed (R7: 3 of 1,285 rollouts run one).
- Sessions whose transcripts were deleted before this version keep NULL branches, and so does every session until the rebuild after the update reaches it: their calls count under the session's starting branch, and the session line says `(branch from the session's start)`.
- clens keeps no output of a call that succeeded. "0 failed" means the commands exited 0: `curl` exits 0 on an HTTP 500 unless `-f` is given. The agent reads the reply after a check with `clens_session`.
- Not recognized as checks: HTTP calls made by scripts (Python `requests`, a project script), by skills or MCP tools other than the browser tools above, test runners outside the list, CI runs, and deploys done outside the agent (a merge in the GitHub UI).
- A git command naming the branch only through a variable (`git push origin $F`) is caught only when it ran on the branch.
- A host with no environment word (`api.example.com`, often production) is `other`; the host is shown, so the agent can tell.
- A repository where work is committed straight to `main` gets every call of `main` under that branch.
- The record's existing Git section counts `git merge-base` as state-changing (`STATE_CHANGING_GIT` matches `merge\b`); this design does not change that section.
- Not checked: B12 against the current Claude Code build, and `gitBranch` in a directory that is not a git repository.

## Open Questions

None. Defaults chosen without the user: `branches` lists 3 by default (as `clens_left_off` lists 3 sessions); the session record shows checks without git lines, which its Git section already lists.

## Goals Check

- S1: met by the branch query (calls on the branch plus git lines naming it) and checked by the first scenario block against R11 and R13.
- S2: met by `branches: true`; second scenario block.
- S3: met by the Checks section; third scenario block and step 5 tests.
- S4: met by the instructions edit (2,044 characters, R9) and step 6 test.
- S5: met: the column depends only on the call's own file (Data model); step 3 runs the driver specs that compare incremental and rebuild digests.

```skerry
{"run": "20261104-012417-d1d7", "verify": ["npm run typecheck", "npm test"], "extras": []}
```

## Changes After Approval

- `formatRecentBranches` footer (Output formats): the document says `(+<more> more branches; raise limit, max 10)`; with one branch left out it now reads `(+1 more branch; raise limit, max 10)`, and `branches` from two on. Why: "1 more branches" is not English, and the list line already says `1 session` for one.
- `formatBranchChecks` (Output formats): the document names the empty-list headers only for Checks and Git; when no session ran on the branch but a git line names it (the step 4 naming fixture), the sessions header prints `Sessions on it: (none)`, by the same rule. Why: the document left that case unstated, and the other two lists already print `<header>: (none)`.
- Step 2 tests: three cases the document does not list were added to `test/mcp_checks.spec.ts`: `curl -s 'http://localhost:8080/a?b=1' | jq .` gives the URL without its quote; `echo '$(pytest -q)'` gives no check (a command substitution inside single quotes is text); `(cd app && npm test)` gives one test run with target `npm test`. Why: the first two pin the quote rule and the code-position rule (the listed cases still passed with the code-position check removed); the third pins the end of a simple command at a closing `)` (see the implementer's report).
- Step 6 (`clens_left_off` description): the document says it grows to 1,598 characters; measured from the built text it is 1,596. Under 2,048 either way.
- Branch queries' join (Interfaces, Calls): the document says `tool_call t JOIN session s ON s.id = t.session_id`; `branchChecks` and `recentBranches` now read `session s CROSS JOIN tool_call t ON t.session_id = s.id` (in `callScope`), the same rows. Why: with `tool_call` as the outer loop SQLite scanned every call in the index (`session` has no `project_id` index), so the first query on a freshly built index took 1,058-1,229 ms in four runs, and the first scenario block's sixth value came out `1`; SQLite always runs the left table of a CROSS JOIN as the outer loop (sqlite.org, Query Optimizer Overview, "Manual Control Of Query Plans Using CROSS JOIN"), and it now takes 91 ms on a fresh index, 20 ms after. Step 4 gains a test, `branch queries — plan` in `test/mcp_checks.spec.ts`, that the three statements read `tool_call` by `tool_session_idx (session_id=?)`; it failed before the change.
- Reading shell text (Check rules; Interfaces, `shell_text.ts`; replaces the line-by-line classifier of step 2): checks come from `executedCommands(command): { argv: string[]; text: string }[]`, the programs a command runs, read in bash's order by `readShell(text): ShellCommand[]` (`ShellCommand = { words, starts, end, source }`). `'…'` is literal; in `"…"` a backslash escapes only `$`, `` ` ``, `"`, `\` and a line break; outside quotes a backslash escapes the next character and, before a line break, joins the lines without a space; a `#` starting a word starts a comment to the line's end; `;`, `&`, `|`, `&&`, `||`, `;;`, `|&`, `(`, `)` and a line break end a command; a redirection (`>`, `2>&1`, `&>`, `<<<`, …) and its target are not words; a heredoc body is skipped after the line that opens it, matching its delimiter exactly (tabs stripped for `<<-`; in an unquoted heredoc a backslash and a line break join body lines); the commands inside `$( )`, `` `…` ``, `<( )` and `>( )` are read too, nested up to 64 deep (deeper ones are kept as text); `$'…'` decodes its escapes (`\n`, `\t`, `\xHH`, `\NNN`, `\uHHHH`, …); an escaped character quotes a word, so `<<\EOF` is a quoted heredoc; an unquoted heredoc body line joins the next only when it ends in an odd number of backslashes. `executedCommands` then skips the reserved words `!`, `{`, `if`, `then`, `else`, `elif`, `do`, `while`, `until`, `NAME=value` words and the wrappers `sudo`, `time`, `env`, `exec`, `nohup`, `nice`, `timeout`; for `sh`/`bash`/`zsh`/`dash`/`ksh` with a `-…c…` option it reads the command after the options instead of the shell, `-o`, `-O` (alone or ending a group such as `-eo`), `--rcfile` and `--init-file` taking the word after them; `fi`, `done`, `esac` and `}` standing alone are no command. A target (test, git) is the command's text from its program word to its end, backslash-line-break and the indentation after it removed. `shellCommands` reads an older Codex `exec_command_begin` input (`bash -lc npm test`, the words joined) as the text after `-c`. `codeLines` and the session record's Git section are as before the review. Tests: `test/shell_text_bash.spec.ts` runs 58 commands in bash with stand-ins that log their arguments and checks that `executedCommands` finds the same programs and arguments, plus `|&` (bash 3.2 on macOS lacks it), a heredoc inside `$( )`, both branches of a conditional and 3,000 nested `$( )` as unit tests. Why: review rounds 1 to 6 each found commands the line-by-line classifier misread (a comment, a whole `sh -c`, `'\''`, line continuations, a backslash ending a comment or heredoc line, a continuation inside a word, `\ ` before a line break, `sh \⏎-c`; then, against the reader, `<( )`, `<<\EOF`, `bash -o pipefail -c`, `$'…'` escapes and deep nesting); fixing each case alone broke its neighbour. On the index, 69,961 calls take 478 ms; it finds more checks than the prototype (test 4,050 against 3,708, git 849 → 1,131, api local 339 → 497), and sampled extras were all real (several test runs or deploy pushes in one call, a test after a heredoc, `for … do npm test`).
- Review round 1, note text (Output formats, the last line of `formatBranchChecks`; the tool description's last checks sentence): `A check that did not fail exited 0;` is now `A check that did not fail exited 0 or got no result (stopped or still running);`, and the description's `A check that did not fail exited 0, which` is now `… exited 0 or got no result, which`. Why: a call has `is_error` 0 until its result comes and keeps it when none comes. The description is 1,615 characters.
- Known Limits, added with the reader: the reader runs nothing, so it lists the commands of every branch of a conditional (`if false; then npm test; fi` lists `npm test`) and of a command after `&&` whose left side failed (that call is then marked failed); a command substitution inside an unquoted heredoc body is not read (bash runs it); `eval`, aliases, shell functions, `xargs` and scripts a command runs are not read into; `|&` is read as bash 4 and later read it.
- Sessions of `branchChecks` (Design, "Sessions"; `BranchSession`; the first Acceptance block): a subagent's calls are listed under the session at the top of its tree (`TOP`, moved from `left_off.ts` to `src/analyzer/scope.ts` so `checks.ts` can use it without an import cycle), and `BranchSession` gets `subagents: number`, how many of its subagents made a call on the branch, printed as `  (+<n> subagent[s])` after the times. A subagent whose parent is not indexed is listed as itself. `sessions_total`, and so `recentBranches`' `sessions`, count top sessions. The first Acceptance block's first two counts become `3` and `3` (the three top sessions of R13, two of them with one subagent). Why: run by hand after QA, `main` of this repository since 2026-11-01 listed ten review and QA subagents and none of the two sessions they worked for.
