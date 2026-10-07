# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build         # tsc + chmod +x dist/cli.js (the bin entrypoint)
npm run typecheck     # tsc --noEmit
npm test              # vitest run (full suite)
npm run test:watch    # vitest in watch mode
npx vitest run test/mcp_search.spec.ts          # single file
npx vitest run -t "name of test"                # single test by name
npm run redact        # tsx test/scripts/redact.ts — scrub real session for fixtures
npm run synth         # tsx test/scripts/synth-corpus.ts — synthetic JSONL corpus
```

Local CLI run (after build): `node dist/cli.js <subcommand>`. Subcommands: `index`, `install <lang>`, `stats [--digest]`, `mcp`. The product surface is the MCP server (`dist/mcp/server.js`): it serves the `clens_*` query tools and, while it runs, keeps the index current by watching the session dirs and indexing each changed JSONL incrementally.

## Test path overrides

Production reads from `~/.claude/` (and `~/.codex/` — see `src/indexer/sources.ts`) and writes the index to `~/.clens/`. Tests MUST override both via env vars (see `src/util/paths.ts`):

- `CLENS_HOME` → Claude Code input dir (replaces `~/.claude/`)
- `CLENS_CODEX_HOME` → Codex input dir (replaces `~/.codex/`)
- `CLENS_INDEX_DIR` → index output dir (replaces `~/.clens/`)

Never touch `~/.claude/` from code paths or tests — paths are funneled through `src/util/paths.ts` precisely so this guarantee holds.

## Architecture

Three parts, each in its own `src/` subtree, talking only through SQLite and typed structs:

1. **Indexer** (`src/indexer/`) — walks every registered source's session dir (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`; see `sources.ts` for the adapter registry), parses each event, writes to SQLite at `~/.clens/index.db`. Driver (`driver.ts`) orchestrates: discover → parse → per-file transaction → cursor upsert. Schema (`schema.ts`) is the single source of truth; tables: `event`, `tool_call`, `file_op`, `user_text`, `skill_call`, `agent_call`, `slash_command`, `system_reminder`, `hook_block`, `anomaly`, `event_unknown_block`, `session`, `project`, `file_cursor`, `maintenance` (upkeep state, not derived from transcripts), plus the `user_text_fts*` search tables. After a run that wrote something, the driver optimizes the FTS tables at most once an hour, and at the end of every rebuild: re-deriving a session deletes and re-inserts its rows, and FTS5 keeps deleted entries until a merge. `file_op` also holds the files a shell command wrote, read off the command text by `shell_writes.ts`: tool `Bash` for Claude Code, tool `exec_command` for Codex (a direct call or one inside `exec` code, read by `src/util/codex_exec.ts`). `lang/` holds the Korean (kiwi-nlp) and Japanese/Chinese (Lindera) morpheme layers the search uses; `clens install ko` downloads the Korean model. `watch.ts` is the file watcher the MCP server runs.

2. **MCP server** (`src/mcp/`) — `server.ts` exposes the `clens_*` query tools over stdio; `search.ts`, `recent.ts`, `session.ts`, `left_off.ts` and `stats.ts` implement them, and `instructions.ts` holds the text sent to the agent (Claude Code cuts each piece at 2,048 characters; `mcp_instructions.spec.ts` guards it). The server opens the index read-only; only its watcher writes, through the driver. Only the watcher loads the language analyzers too (about 1.1 GB, most of it kiwi's); the other servers, one per session, ask it over a local socket to split their search terms into morphemes (`analyzers.ts`).

3. **Analyzer** (`src/analyzer/`) — pure SQL → typed facts for `clens_stats`: one module per dimension (`identity`, `tools`, `skills`, `agents`, `health`, `timeline`, `files`), each taking a `Scope` (`scope.ts`).

`src/commands/` holds the thin CLI adapters and `cli.ts` is a hand-rolled flag parser (no deps) that dispatches to them. clens never calls an LLM.

**Plugin** — the repository root is one plugin for both tools. `.claude-plugin/` (manifest, MCP server inline, and the marketplace both tools read) and `hooks/hooks.json` are Claude Code's; `.codex-plugin/` (manifest, `mcp.json`, `hooks.json`) is Codex's, which reads only that folder when it exists. Both start `plugin/start.mjs`, which installs the runtime npm dependencies or rebuilds better-sqlite3 on a plugin's first run (Codex installs none, Claude Code installs with `--ignore-scripts`) and then runs the server in its own process, since the server finds the calling session through its parent process. `bin/clens` puts the CLI on Claude Code's shell path. Raise `version` in both manifests on each release.

### Key invariants

- **Gate 2 — incremental == rebuild digest.** Re-indexing one file must produce byte-identical SQLite content to a full `--rebuild`. The driver enforces this by wiping all affected sessions and re-deriving turn numbers per-session inside one transaction. See `driver.ts` header comment.
- **Foreign keys are OFF** in `applySchema()` because the writer manages FK integrity at parse time; do not turn them on without auditing the wipe/insert order in `commitFile()`.
- **Anomaly table carries `source_file`** beyond the spec so per-file re-parses can wipe their own anomaly rows before re-flushing. `clens stats` only sums `count`, so this column is transparent downstream.
- **Indexer write-lock** is an advisory lockfile at `~/.clens/index.db.lock` via `proper-lockfile`. Concurrent writers exit code 4 ("indexer busy"). Another process takes over a lock whose holder has not refreshed it for 60s, and the refresh runs on a timer, so never block the event loop that long: `runIndex()` yields between files, and a lost lock goes to `acquireLock()`'s `onLost` instead of throwing (the default throw killed the MCP server).
- **`event.in_tok/out_tok/cache_r/cache_w`** are populated but no longer surfaced as cost/token reporting — `health.ts` (context bloat) still reads `in_tok`, `cache_r` and `cache_w` directly via SQL; no analyzer reads `out_tok`. Do not drop these columns without updating `health.ts` first.
- **`session.kind = 'pipeline'`** tags transcripts of clens's former background judge (run from `judgeCwdDir()`). The judge is gone but its transcripts are still on disk, so the rule stays: dropping it would turn them into ordinary sessions on the next rebuild. A Codex session also records how it was started: a subagent thread becomes `subagent` and a one-shot `codex exec` or SDK run `exec`. A Claude Code transcript started through the SDK (`claude -p`, entrypoint `sdk-*`) is also `exec`. A Claude Code subagent's lines carry its parent's sessionId; they are stored under `agent-<agentId>` (kind `subagent`, `parent_id` the parent), and a Codex subagent records its parent too. Search and the project/all-project scopes of `clens_stats` leave out `pipeline` and `exec` sessions and the subagents they started (`workKindClause()` in `src/analyzer/scope.ts`, which checks the parent's kind at query time); a `clens_stats` call for one explicit session shows it whatever its kind. `role: "user"` search also leaves out subagents, whose "user" is the agent that started them; `clens_left_off` lists only `interactive`, counting its subagents' edits as its own.

## MCP query tools

When querying this project's MCP server (`clens_recent`, `clens_search`, `clens_session`, `clens_left_off`, `clens_stats`), pick by whether you have a keyword:

- **Have a topic/keyword?** Use `clens_search` first with a small `limit` (5-10) — it's FTS5 relevance-ranked, so it surfaces the real hit without needing a narrow time window. Then take the `session_id`+`ts` from the hit and call `clens_session` to pull a tight context window around it — smallest, cleanest result.
- **No keyword, just browsing?** Use `clens_recent`, but only with a narrow `since`/`until` (a few minutes, or a known session's span). It returns raw messages time-ordered with no relevance ranking, so a broad window can return a very large amount of unfiltered text.

Default flow for "find what happened / was decided": `clens_search` → `clens_session`, not `clens_recent`. For "where did I leave off" on a project or a file, `clens_left_off`.

## TypeScript / module conventions

- `"type": "module"` + `module: NodeNext` — all relative imports must end in `.js` (e.g. `import { … } from "./schema.js"`) even when the source is `.ts`.
- `strict: true`, `noUncheckedIndexedAccess: true` — array access returns `T | undefined`; non-null assertion (`!`) is acceptable when the parser has already established the invariant.
- Source lives only under `src/`; `dist/` is build output and never edited. `dist/` is committed, because the plugin runs it and neither Claude Code nor Codex builds a plugin: run `npm run build` and commit `dist/` with every source change.

## Testing notes

- Vitest with the default config (`vitest.config.ts`); tests live in `test/*.spec.ts`.
- `test/fixtures/` holds redacted real-world JSONL plus synthesized corpora. Use `npm run redact` to scrub a fresh capture; use `npm run synth` to regenerate the deterministic synthetic corpus.
- The driver/parser spec suite (`driver.spec.ts`, `claude_parser.spec.ts`, `codex_parser.spec.ts`) is the gate for the indexer; treat anomaly counts as part of the contract.
