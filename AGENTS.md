# AGENTS.md

This file guides coding agents (Claude Code and Codex) working in this repository. Claude Code reads it through `CLAUDE.md`, which imports it.

## Commands

```bash
npm run build         # tsc --noEmit, then bundle src/ into plugin/ (scripts/build.mjs)
npm run typecheck     # tsc --noEmit
npm test              # vitest run (full suite)
npm run test:watch    # vitest in watch mode
npx vitest run test/mcp_search.spec.ts          # single file
npx vitest run -t "name of test"                # single test by name
npm run redact        # tsx test/scripts/redact.ts — scrub real session for fixtures
npm run synth         # tsx test/scripts/synth-corpus.ts — synthetic JSONL corpus
```

Local CLI run (after build): `node plugin/dist/cli.js <subcommand>`. Subcommands: `index`, `install <lang>`, `stats [--digest]`, `mcp`.

## Test path overrides

Production reads from `~/.claude/` (and `~/.codex/` — see `src/indexer/sources.ts`) and writes the index to `~/.clens/`. Tests MUST override both via env vars (see `src/util/paths.ts`):

- `CLENS_HOME` → Claude Code input dir (replaces `~/.claude/`)
- `CLENS_CODEX_HOME` → Codex input dir (replaces `~/.codex/`)
- `CLENS_INDEX_DIR` → index output dir (replaces `~/.clens/`)

Never touch `~/.claude/` from code paths or tests — paths are funneled through `src/util/paths.ts` precisely so this guarantee holds.

## Architecture

The indexer (`src/indexer/`), the MCP server (`src/mcp/`) and the analyzer behind `clens_stats` (`src/analyzer/`) talk only through SQLite and typed structs. `src/indexer/schema.ts` is the single source of truth for the tables. clens never calls an LLM.

- The MCP server opens the index read-only; only its watcher writes, through the driver. Only the watcher loads the language analyzers (kiwi's is most of the memory); the other servers, one per session, ask it over a local socket to split search terms (`analyzers.ts`). `clens_hold` appends to `~/.clens/ledger.jsonl` (`src/mcp/ledger.ts`), a file apart from the index, which a rebuild never touches.
- Claude Code 2.1.318 cuts server instructions and each tool description (`src/mcp/instructions.ts`) at 4,096 characters, and older releases at 2,048, so what every client needs stays in the first 2,048 characters of `SERVER_INSTRUCTIONS` and the ledger paragraph comes last; `mcp_instructions.spec.ts` guards it.
- `plugin/` is one plugin for both tools. The root's `.claude-plugin/marketplace.json` points Claude Code at it and `.agents/plugins/marketplace.json` points Codex at it (Codex reads the latter when both exist; keep the two in step). Inside it, `plugin/.claude-plugin/` and `plugin/hooks/hooks.json` are for Claude Code, `plugin/.codex-plugin/` for Codex. Both start `plugin/start.mjs`, which installs the runtime dependencies on a first run and then runs the server in its own process, since the server finds the calling session through its parent process.
- clens's own skills (`plugin/skills/`) read sessions only through the clens MCP tools, never from transcript files under `~/.claude/projects/` or `~/.codex/sessions/`; where clens lacks something a skill needs, such as tool output, the skill says so instead of opening the file.
- Raise `version` in `package.json` and both manifests only for a release the user asks for. The language analyzers install through the `install` skill, which runs the plugin's own `start.mjs install <lang>`. To get a change into the installed plugin, push it, then reinstall in both tools (Claude Code: `claude plugin marketplace update clens`, `claude plugin uninstall clens@clens`, `claude plugin install clens@clens`; Codex: `codex plugin marketplace upgrade clens`, `codex plugin remove clens@clens`, `codex plugin add clens@clens`), compare the installed copies with the build, and tell the user to restart open sessions.

### Key invariants

- **Gate 2 — incremental == rebuild digest.** Re-indexing one file must produce byte-identical SQLite content to a full `--rebuild`. The driver enforces this by wiping all affected sessions and re-deriving turn numbers per-session inside one transaction. See `driver.ts` header comment. A Claude Code transcript that only grew is indexed by appending its new lines (`src/indexer/append.ts`) when `appendNewLines` can prove the result equals a re-derivation; every other change re-derives the affected sessions as before.
- **Foreign keys are OFF** in `applySchema()` because the writer manages FK integrity at parse time; do not turn them on without auditing the wipe/insert order in `commitFile()`.
- **A parse change bumps `SCHEMA_VERSION`**, so the version-mismatch rebuild re-derives every transcript still on disk; a session whose transcript is gone is kept as it is.
- **Times.** The index and the ledger store UTC (`toISOString()`). Tools and hooks print every time through `localTs()` (`src/util/time.ts`): the server's local time with its offset, `Z` in UTC. Every time a tool takes (`since`, `until`, `around_ts`) is a `timeParam`, which turns it into UTC before SQL. Never print a stored time as it is, and never compare a raw input with one.
- **Anomaly table carries `source_file`** so per-file re-parses can wipe their own anomaly rows before re-flushing.
- **Indexer write-lock** is an advisory lockfile at `~/.clens/index.db.lock` via `proper-lockfile`. Concurrent writers exit code 4 ("indexer busy"). Another process takes over a lock whose holder has not refreshed it for 60s, and the refresh runs on a timer, so never block the event loop that long: `runIndex()` yields between files, and a lost lock goes to `acquireLock()`'s `onLost` instead of throwing (the default throw killed the MCP server).
- **`event.in_tok/cache_r/cache_w`** are read by `health.ts` (context bloat); do not drop them without updating it.
- **Session kinds.** `pipeline` tags transcripts of clens's former background judge (run from `judgeCwdDir()`); the judge is gone but its transcripts are still on disk, so keep the rule, or they become ordinary sessions on the next rebuild. `exec` is a one-shot run (`codex exec`, an SDK run, `claude -p`), and `subagent` a subagent thread, stored under `agent-<agentId>` with `parent_id` set. Search and the project/all-project scopes of `clens_stats` leave out `pipeline` and `exec` sessions and the subagents they started (`workKindClause()` in `src/analyzer/scope.ts`), while a `clens_stats` call for one explicit session shows it whatever its kind; `role: "user"` search also leaves out subagents; `clens_left_off` lists only `interactive`, counting its subagents' edits as its own.

## TypeScript / module conventions

- `"type": "module"` + `module: NodeNext` — all relative imports must end in `.js` (e.g. `import { … } from "./schema.js"`) even when the source is `.ts`.
- `strict: true`, `noUncheckedIndexedAccess: true` — array access returns `T | undefined`; non-null assertion (`!`) is acceptable when the parser has already established the invariant.
- Source lives only under `src/`. `npm run build` bundles it with esbuild into `plugin/dist/server.js`, `plugin/dist/cli.js` and `plugin/hooks/compact.mjs`, and writes `plugin/package.json` with the two dependencies left out of the bundles, `better-sqlite3` (native) and `kiwi-nlp` (loads a .wasm file beside it), which `plugin/start.mjs` installs. The bundles are never edited and are committed, because neither Claude Code nor Codex builds a plugin: run `npm test` and `npm run build` before each commit, and commit `plugin/` with every source change. CI fails when `plugin/` differs from what the source builds to, and runs `test/scripts/plugin-smoke.mjs`, which runs a copy of `plugin/` with only its own dependencies.

## Testing notes

- Tests live in `test/*.spec.ts`. `test/fixtures/` holds redacted real-world JSONL plus synthesized corpora: `npm run redact` scrubs a fresh capture, `npm run synth` regenerates the synthetic corpus.
- The driver/parser spec suite (`driver.spec.ts`, `claude_parser.spec.ts`, `codex_parser.spec.ts`) is the gate for the indexer; treat anomaly counts as part of the contract.
