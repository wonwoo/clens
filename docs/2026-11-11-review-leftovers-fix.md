# Review Leftovers Fix

Six findings of the 2026-11-09 code review (session `e081f090`) that a reviewer reported and that were checked against the code and this machine on 2026-11-11, fixed in one run.

## Symptom

**A. Codex never runs the ledger guidance hook for a forked session.** Codex sends `SessionStart` with source `fork` for a forked thread: `codex-rs/hooks/src/events/session_start.rs` on `openai/codex` `main` has `SessionStartSource::Fork` (`as_str` gives `"fork"`), and `matcher_input()` matches a handler's matcher against that string; the installed Codex 0.167.0 binary holds the same `startup resume clear compact fork` list next to its session-start hook messages. clens registers `hooks/hold_guidance.mjs` with the matcher `startup|resume|clear|compact` (`plugin/.codex-plugin/hooks.json:17`). Expected: the hook also runs for `fork`.

**B. A directory whose path holds any character other than a letter, digit or `/` gets two project ids.** Claude Code 2.1.322 names a project directory with `JD(e)`: `e.replace(/[^a-zA-Z0-9]/g, "-")`, and when that is over 200 characters, its first 200 characters, a `-`, and `Math.abs(hre(e)).toString(36)`, where `hre` is `let e=0; for (…) e=(e<<5)-e+t.charCodeAt(n)|0; return e` over the original path (read from `~/.local/share/claude/versions/2.1.322`). On this machine 914 of 918 distinct `(cwd, project_id)` pairs of Claude Code sessions match `cwd.replace(/[^A-Za-z0-9]/g, "-")`; the other 4 are sessions that moved into a `.claude/worktrees` directory after they started. clens gives a Codex session `cwd.replace(/\//g, "-")`, so the index holds `/Users/fidel/.claude/mascot` as `-Users-fidel--claude-mascot` (Claude Code) and `-Users-fidel-.claude-mascot` (Codex), and `/Users/fidel/Documents/New project` as `-Users-fidel-Documents-New project` (34 Codex sessions). The MCP tools tell agents to derive `project_id` the same way ("every slash replaced by a dash"), so in such a directory a project-scoped search, recent, left-off, stats, hold or pending call misses the Claude Code sessions, and the SessionStart ledger hooks (`src/hooks/ledger_context.ts:24`) and the failure hint (`src/hooks/failure_hint.ts:187`) build the same slash-only id. Expected: every project id clens stores or looks up is the one Claude Code gives the directory.

**C. One file that cannot be read stops the whole index run.** When reading or writing one transcript throws (no permission, the file removed between discovery and reading, a file over Node's 536,870,888-character string limit), `runIndex` throws: the files after it are not indexed, and the database handle opened at `src/indexer/driver.ts:451` is not closed. While the file stays so, every run stops there. Expected: that file is skipped with a message, the others are indexed, and the handle is always closed.

**D. `FailureInput.command` is never read.** `src/hooks/failure_hint.ts:29` declares it and `src/hooks/tool_failure.ts:53` fills it; `failureHint` reads only `sessionId`, `cwd` and `output`. Expected: no unused field.

**E. `clens_recent` treats `_` and `%` in `query` as LIKE wildcards.** `src/mcp/recent.ts:88` builds `%${params.query}%` and passes it to four `LIKE ?` (`recent.ts:105`, `:106`, `:109` twice), so `snake_case` also matches `snakeXcase` and `100%` also matches `1000`. Expected: both characters match only themselves.

**F. `clens install <lang>` hides that the analyzer was installed when the rebuild after it fails.** `src/commands/install_cmd.ts:119` awaits `runIndex({ rebuild: true })` outside any `try`; a failure (for example `indexer busy`, exit code 4) reaches `src/cli.ts:113-116`, which prints `clens: fatal: <message>` and exits 1. The install skill (`plugin/skills/install/SKILL.md`, step 4) then says "nothing else changed", while the analyzer is in `~/.clens/models/<lang>/` and only the rebuild is missing. Expected: a `failed:` line that says the analyzer is installed and how to finish the rebuild.

## Reproduction

Command: `npx vitest run test/ledger_list.spec.ts test/sources.spec.ts test/schema_migration.spec.ts test/driver_multifile.spec.ts test/mcp_recent.spec.ts test/install_cmd.spec.ts`

New tests:

- `test/ledger_list.spec.ts`, describe "Codex hook registration": the `SessionStart` entry of `plugin/.codex-plugin/hooks.json` whose command runs `hooks/hold_guidance.mjs` has the matcher `startup|resume|clear|compact|fork` (A).
- `test/ledger_list.spec.ts`, describe "ledgerContext", test "lists the items of a directory whose path holds a dot, by Claude Code's project id": the ledger written in `beforeAll` gets two more held items, `1a2b3c4d` in project `-work-a-b` and `5e6f7a8b` in project `-work-a.b`; `ledgerContext('{"source":"startup","cwd":"/work/a.b"}')` lists both (B: hook id, and items recorded before the fix).
- `test/sources.spec.ts`, test "codexAdapter derives the project id Claude Code gives the same directory": cwd `/Users/x/.claude/mascot` gives `-Users-x--claude-mascot`, `/Users/x/Documents/New project` gives `-Users-x-Documents-New-project`, and `"/w/" + "a".repeat(250) + "/b.c"` (257 characters sanitized) gives `"-w-" + "a".repeat(197) + "-nio7yp"` (B; `nio7yp` computed with Claude Code's `hre` above).
- `test/schema_migration.spec.ts`, describe "a kept Codex session after the project id change": an index at `SCHEMA_VERSION - 1` with Codex session `cx` (cwd `/w/a.b`, project `-w-a.b`) whose only event's `source_file` `/gone/rollout-cx.jsonl` does not exist; after `runIndex({})` the session's `project_id` is `-w-a-b` and `project` has the row `{ id: "-w-a-b", cwd: "/w/a.b" }` (B, sessions whose rollout is gone).
- `test/driver_multifile.spec.ts`, describe "indexer — a transcript that cannot be read" (skipped when run as root, whom file modes do not stop): two Claude Code transcripts, the first `chmod 000`; `runIndex()` resolves, writes `clens index: skipped <path of the first>: ` to stderr, indexes the second, and after `chmod 644` the next `runIndex()` indexes the first (C).
- `test/mcp_recent.spec.ts`, test "query matches _ and % as themselves, not as LIKE wildcards": user texts `rename snake_case keys`, `rename snakeXcase keys`, `coverage at 100%`, `coverage at 1000 lines` in session `s2`; query `snake_case` returns only the first, `100%` only the third (E).
- `test/install_cmd.spec.ts`, test "returns 1 and says the analyzer is installed when the reindex fails": npm succeeds once, `runIndex` rejects with `Error("indexer busy")` carrying `exitCode` 4; `installCommand({ lang: "ja" })` returns 1 and writes ``clens install ja: failed: the analyzer is installed, but the index rebuild failed: indexer busy. Run `start.mjs index --rebuild` to rebuild it.`` followed by a newline (F).

D has no failing test: the field is unused, and its removal is checked by `npm run typecheck`.

Failing output before the fix (7 failed, 64 passed):

```
→ ledger items listed for /work/a.b: expected { item: false, older: true } to deeply equal { item: true, older: true }
→ Codex SessionStart matcher of the ledger guidance hook: expected 'startup|resume|clear|compact' to be 'startup|resume|clear|compact|fork'
→ Codex project ids of /Users/x/.claude/mascot, a path with a space, a 257-character path: expected [ '-Users-x-.claude-mascot', …(2) ] to deeply equal [ '-Users-x--claude-mascot', …(2) ]
→ install whose reindex fails: expected { code: 'threw: indexer busy', …(1) } to deeply equal { code: 1, said: true }
→ clens_recent query with _ and %: expected { underscore: [ …(2) ], …(1) } to deeply equal { …(2) }
→ kept Codex session in /w/a.b after the rebuild: expected { …(2) } to deeply equal { …(2) }
→ index run with one unreadable transcript: expected { …(4) } to deeply equal { outcome: 'resolved', …(3) }
```

The last one received `outcome: "rejected: EACCES: permission denied, open '…/aaaaaaaa-0000-0000-0000-000000000001.jsonl'"`, `open: []`, `said: false`.

## Root Cause

**A.** `plugin/.codex-plugin/hooks.json:17` lists four of Codex's five session-start sources.

**B.** Three places build a project id from a path with only the slashes replaced: `src/indexer/sources.ts:54` (Codex sessions in the index), `src/hooks/ledger_context.ts:24` (the SessionStart ledger list of both tools) and `src/hooks/failure_hint.ts:187`. The MCP tools take `project_id` as the agent wrote it (`src/mcp/server.ts:69`, `:83`, `:95`, `:112`, `:120`, `:129`, all a plain `z.string()`), and `readLedger` keeps each item's `project_id` as recorded (`src/mcp/ledger.ts:136`), which `recordHold` (`ledger.ts:177`), `formatPending` (`ledger.ts:227`) and `formatLedgerList` (`ledger.ts:282`) compare with `===`.

**C.** In `runIndex` (`src/indexer/driver.ts:518-574`) the per-file work (`appendNewLines`/`appendCodexLines` at `:533`, `readFileSync` at `:542`, the parse, `commitFile` at `:554`) has no `catch`, so its first exception leaves the loop and the function. The database is closed only at `:463`, `:526` and `:579`, on the paths that reach them.

**D.** `src/hooks/failure_hint.ts:29`, `src/hooks/tool_failure.ts:53`.

**E.** `src/mcp/recent.ts:88` and the four `LIKE ?` without `ESCAPE`.

**F.** `src/commands/install_cmd.ts:119`, the `runIndex` call outside the `try` of `:111-117`.

## Fix

**A.** Change the matcher at `plugin/.codex-plugin/hooks.json:17` to `startup|resume|clear|compact|fork`. The compaction hook (matcher `compact`) and `plugin/hooks/hooks.json` (Claude Code's sources are `startup`, `resume`, `clear`, `compact`) stay.

**B.** One rule, Claude Code's, everywhere:

1. New file `src/util/project_id.ts`:
   - `export function projectIdOf(path: string): string`: `path.replace(/[^a-zA-Z0-9]/g, "-")`; when longer than 200 characters, its first 200 characters + `-` + `Math.abs(h).toString(36)`, where `h` starts at 0 and for each UTF-16 code unit `c` of `path` becomes `((h << 5) - h + c) | 0`. A header comment says this is Claude Code's directory name for a project (2.1.322, `JD`), so Claude Code and Codex sessions of one directory share one id. The regex has no `u` flag, so each UTF-16 code unit becomes one dash, as in Claude Code.
   - `export function normalizeProjectId(id: string): string`: `id.replace(/[^a-zA-Z0-9]/g, "-")`. Comment: a `project_id` an agent derived by replacing only the slashes, or recorded in the ledger before this change, becomes the id `projectIdOf` gives for paths of up to 200 sanitized characters; an id already in that form is unchanged.
2. `src/indexer/sources.ts:54`: `deriveProjectId: (_source_file, cwd) => (cwd !== null ? projectIdOf(cwd) : null)`, and the comment above it says it gives the id Claude Code gives the directory. `src/indexer/driver.ts:155`: "which is already the cwd with slashes replaced by dashes" becomes "which is the cwd with every character other than a letter or digit replaced by a dash (projectIdOf)".
3. `src/hooks/ledger_context.ts:24`: `const project_id = projectIdOf(cwd);`, and its comment says Claude Code's id for the cwd, the id `clens_hold` stores. `src/hooks/failure_hint.ts:187`: `projects.add(projectIdOf(input.cwd));`.
4. `src/mcp/server.ts`: two constants above the schemas, `const projectIdParam = z.string().transform(normalizeProjectId);` and `const requiredProjectIdParam = z.string().min(1).transform(normalizeProjectId);`, with a comment that an agent derives `project_id` from its cwd by replacing slashes (the tool descriptions say so) and the server turns it into Claude Code's id. `RecentParamsSchema` (`:69`) uses `projectIdParam`; `SearchParamsSchema` (`:83`) and `LeftOffParamsSchema` (`:95`) use `projectIdParam.optional()`; `StatsParamsSchema` (`:112`) and `PendingParamsSchema` (`:129`) use `requiredProjectIdParam.optional()`; `HoldParamsSchema` (`:120`) uses `requiredProjectIdParam`. The tool descriptions and `SERVER_INSTRUCTIONS` stay as they are: the slash-only id they describe is normalized here, and their length limits (`mcp_instructions.spec.ts`) are untouched.
5. `src/mcp/ledger.ts:136`: `project_id: normalizeProjectId(e.project_id)`, so items recorded before this change match. The ledger file is not rewritten. The `""` project of a malformed old item stays `""`.
6. Sessions whose rollout is gone keep their rows through a rebuild (`driver.ts`, the `needsRebuild` block). In its `dropTx`, after the loop that deletes the re-derivable sessions, add: for every row of `SELECT id, cwd, project_id FROM session WHERE source = 'codex' AND cwd IS NOT NULL` (now only kept sessions remain) whose `projectIdOf(cwd)` differs from `project_id`, run `UPDATE session SET project_id = ? WHERE id = ?` and `stmts.upsertProject.run({ id, cwd, display: id })` with the new id. Comment: kept Codex sessions get the id a re-derivation would give. The old `project` row stays, as orphaned project rows already do (7 on this machine), and only `clens stats` (CLI) counts that table.
7. Bump `SCHEMA_VERSION` from 21 to 22 (`src/indexer/schema.ts`) with a `v22` note under the `v21` one: a Codex session's project id is the one Claude Code gives its cwd (`projectIdOf`); the version-mismatch rebuild re-reads every rollout still on disk and gives a session whose rollout is gone the id of its stored cwd. `AGENTS.md` requires the bump for a parse change.
8. `AGENTS.md`, Key invariants: add a bullet "**Project ids** are Claude Code's directory names: `projectIdOf` (`src/util/project_id.ts`) for a path, `normalizeProjectId` for an id an agent derived or the ledger holds; never build one with another rule."

**C.** In `runIndex` (`src/indexer/driver.ts`):

1. Right after `const db = openIndex();` open a `try` that runs to the end of the current `try` body, with `finally { db.close(); }`; remove the three `db.close()` calls at `:463`, `:526` and `:579` (better-sqlite3's `close()` on a closed handle does nothing; checked with better-sqlite3 in this repository). The outer `try … finally { await release(); }` stays.
2. In the `for (const f of discovered)` loop, keep the `needs_parse` check, the `setImmediate` yield and the `lock.lost` check outside, and wrap the rest of the body (from the append attempt through the counter updates after `commitFile` and `keepCodexState`) in `try { … } catch (e) { process.stderr.write(`clens index: skipped ${f.path}: ${e instanceof Error ? e.message : String(e)}\n`); }`. The `continue` after a successful append stays inside the `try`.

Why this is safe: `commitFile` and the append paths write in one transaction each, so a throw leaves no partial rows; the file's cursor is not moved, so the next run reads it again (in a rebuild its cursor was deleted, so the next run reads it too). `appendCodexLines` removes the kept parser state of the rollout before parsing and puts it back only after its rows are written (`src/indexer/codex_append.ts`, `kept.delete(f.path)` at the start of `appendCodexLines`), and `keepCodexState` runs only after `commitFile`, so a skipped rollout never leaves a parser state ahead of the index. A lost lock still throws.

**D.** Remove `command: string;` from `FailureInput` (`src/hooks/failure_hint.ts:29`) and `command: String(event.tool_input?.command ?? ""),` from the call in `src/hooks/tool_failure.ts:53`. In `test/failure_hint.spec.ts`, remove the `command` property from every object literal that is a `FailureInput`: the `ghNow` constant at line 101 and the second argument of the `failureHint` calls at lines 123, 125, 145, 196, 197, 240 and 247 (eight objects; `grep -n "command:" test/failure_hint.spec.ts` lists them, with line 93, a string inside a `failureKey` call, which stays). The helper `failed` (lines 15-20) takes a `command` parameter for the stored tool call, not a `FailureInput`, and stays.

**E.** `src/mcp/recent.ts:88`: `const like = `%${params.query.replace(/[\\%_]/g, "\\$&")}%`;` and each of the four `LIKE ?` at `:105`, `:106`, `:109` becomes `LIKE ? ESCAPE '\'` (in the template literal: `LIKE ? ESCAPE '\\'`). LIKE stays case-insensitive for ASCII, as now.

**F.** `src/commands/install_cmd.ts`: put `runIndex({ rebuild: true })` in a `try`; on a throw write `clens install ${flags.lang}: failed: the analyzer is installed, but the index rebuild failed: ${message}. Run \`start.mjs index --rebuild\` to rebuild it.\n` (message: `err.message ?? e`, as the `catch` above it) and return 1. `plugin/skills/install/SKILL.md` step 4, the failure sentence becomes: "On failure, quote the `failed:` line. When it says the analyzer is installed, run `node "<plugin folder>/start.mjs" index --rebuild` with the same timeout as step 3; its last line starts with `clens index: parsed` when it worked, and then the same restart applies. If it fails too, quote its line and tell the user to run it again later. Otherwise nothing else changed, and search keeps working by characters."

## Implementation Order

1. **Codex fork (A).** Change `plugin/.codex-plugin/hooks.json:17`. Verify: `npx vitest run test/ledger_list.spec.ts -t "Codex hook registration"` passes.
2. **Project ids (B, steps 1-5).** Create `src/util/project_id.ts`; change `sources.ts`, the `driver.ts:155` comment, `ledger_context.ts`, `failure_hint.ts:187`, `server.ts`, `ledger.ts`. Add `test/project_id.spec.ts`: `projectIdOf` gives the three ids of the `sources.spec.ts` test, `C--Users-x-app` for `C:\Users\x\app` and `-w-app` for `/w/app`; `normalizeProjectId` gives `-Users-x--claude-mascot` for `-Users-x-.claude-mascot`, `-w-app` for `-w-app`, and `""` for `""`. Verify: `npx vitest run test/project_id.spec.ts test/sources.spec.ts test/ledger_list.spec.ts test/mcp_ledger.spec.ts test/failure_hint.spec.ts` passes.
3. **Kept Codex sessions and version (B, steps 6-8).** Change the rebuild in `driver.ts`, bump `SCHEMA_VERSION` with the note, add the `AGENTS.md` bullet. Verify: `npx vitest run test/schema_migration.spec.ts test/schema.spec.ts` passes.
4. **Skipped files (C).** Change `runIndex`. Verify: `npx vitest run test/driver_multifile.spec.ts test/driver.spec.ts test/driver_lock_lost.spec.ts test/driver_codex_append.spec.ts` passes.
5. **Small fixes (D, E, F).** Change `failure_hint.ts`, `tool_failure.ts`, `test/failure_hint.spec.ts`, `recent.ts`, `install_cmd.ts`, `plugin/skills/install/SKILL.md`. Verify: `npx vitest run test/failure_hint.spec.ts test/mcp_recent.spec.ts test/install_cmd.spec.ts` passes, and the reproduction command exits 0.
6. **Server check in the smoke test (B, step 4).** In `test/scripts/plugin-smoke.mjs`, after the `"hold and pending"` check, add a check `"project id with a dot"`: `clens_search` with `{ query: "brainstorming", project_id: "-fixture.cwd", limit: 3 }` returns no error and text containing `session:test`, and `clens_pending` with `{ project_id: "-fixture.cwd" }` returns text containing `Ledger for -fixture-cwd: 1 held, 0 dropped, 0 done`.
7. **Suite, types, bundle.** `npm run typecheck`, `npm test`, then `npm run build` (`plugin/` is committed with every source change, `AGENTS.md`), then `node test/scripts/plugin-smoke.mjs` prints only `PASS` lines and exits 0.

## Acceptance

- The reproduction command exits 0.
- `npx vitest run test/project_id.spec.ts` exits 0.
- `npm run typecheck` and `npm test` exit 0.
- `node test/scripts/plugin-smoke.mjs` exits 0, including the `project id with a dot` check.
- Scenario, the real index after the next session start (read only, once the v22 rebuild has finished): `sqlite3 "file:$HOME/.clens/index.db?immutable=1" "SELECT DISTINCT source, project_id FROM session WHERE cwd = '/Users/fidel/.claude/mascot'"` prints `claude|-Users-fidel--claude-mascot` and `codex|-Users-fidel--claude-mascot`. This runs only on this machine, after reinstalling, and is not part of `verify`.
- `git status --short` shows changes only in `src/util/project_id.ts` (new), `src/indexer/sources.ts`, `src/indexer/driver.ts`, `src/indexer/schema.ts`, `src/hooks/ledger_context.ts`, `src/hooks/failure_hint.ts`, `src/hooks/tool_failure.ts`, `src/mcp/server.ts`, `src/mcp/ledger.ts`, `src/mcp/recent.ts`, `src/commands/install_cmd.ts`, `plugin/.codex-plugin/hooks.json`, `plugin/skills/install/SKILL.md`, `AGENTS.md`, the tests named in this document (`test/project_id.spec.ts` new), `test/scripts/plugin-smoke.mjs`, files under `plugin/` that `npm run build` rewrites, and this document, besides the untracked `.skerry/` and `docs/experiments/` that were there before.

## Known Limits

- **Paths over 200 sanitized characters.** The index and the hooks, which have the path, give Claude Code's cut-and-hashed id. An agent that derives `project_id` itself sends the uncut form, which `normalizeProjectId` cannot hash without the path, so a tool call scoped to such a project finds nothing. The hash rule was read from the Claude Code 2.1.322 bundle; it was not checked against a real directory that long, since none exists here and making one would write a transcript into `~/.claude`.
- **Tool descriptions still say "replace every slash".** The server turns that into the right id, so they were left as they are; an agent that already uses the full rule sends the same id.
- **`fork` was not tried with a real forked Codex session.** The source and the 0.167.0 binary were read; a fork needs an interactive Codex session.
- **A file that never becomes readable** is read again, and its `skipped` line printed again, on every index run, since its cursor does not move. In a rebuild its sessions are missing from the index until it can be read; before this fix the whole rebuild stopped there instead.
- **The unreadable-file test is skipped as root**, where file modes do not stop reading.
- **Old `project` rows** of the slash-only ids stay in the table; nothing but `clens stats` (CLI) counts them.
- **Windows** paths get Claude Code's rule (`C:\Users\x\app` becomes `C--Users-x-app`), checked only by the unit test; clens's other path handling on Windows (`/subagents/`) is not checked and not changed here.
- After the bump, a clens 0.2.11 or older still running rebuilds the index with its own rules; 0.2.12 and 0.2.13 refuse an index of a newer version (`driver.ts`) and leave it as it is until their session restarts.

## Open Questions

None.

```skerry
{"run": "20261111-002941-f697", "verify": ["npx vitest run test/ledger_list.spec.ts test/sources.spec.ts test/schema_migration.spec.ts test/driver_multifile.spec.ts test/mcp_recent.spec.ts test/install_cmd.spec.ts", "npx vitest run test/project_id.spec.ts", "npm run typecheck", "npm test", "node test/scripts/plugin-smoke.mjs"], "repro": {"cmd": "npx vitest run test/ledger_list.spec.ts test/sources.spec.ts test/schema_migration.spec.ts test/driver_multifile.spec.ts test/mcp_recent.spec.ts test/install_cmd.spec.ts", "failText": "Codex SessionStart matcher of the ledger guidance hook", "files": ["test/ledger_list.spec.ts", "test/sources.spec.ts", "test/schema_migration.spec.ts", "test/driver_multifile.spec.ts", "test/mcp_recent.spec.ts", "test/install_cmd.spec.ts"]}, "extras": []}
```

## Changes After Approval

- **Fix F, the install skill's failure sentence.** Fix F said the rebuild's "last line starts with `clens index: parsed` when it worked". `plugin/skills/install/SKILL.md` step 4 now says "when it worked it exits 0 and prints a line starting with `clens index: parsed`". Why: `indexCommand` (`src/commands/index_cmd.ts:24-28`) writes `  db: <path>` after the `clens index: parsed` line, so the last line never starts with `clens index: parsed`, and a successful rebuild could be read as a failure (review round 1).
