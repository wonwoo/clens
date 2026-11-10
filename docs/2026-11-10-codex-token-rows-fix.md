# Codex Token Rows Fix

Two causes of wrong Codex context figures in `clens_stats` health, fixed in one run.

## Symptom

`clens_stats` health prints `context_bloat_ratio` `n/a` for a single Codex session, and in scopes that mix Codex and Claude Code sessions the median context size comes out too low and the ratio too high. The figures are computed by `analyzeHealth` (`src/analyzer/health.ts:78-103`).

Observed on this machine's index (read only, 2026-11-10). Codex assistant events:

| kind of row | rows | carries tokens |
|---|---|---|
| tool call (`has_tool_use` 1) | 35,622 | no |
| reply text (`has_text` 1) | 31,332 | no |
| end of turn (no text, no tool use) | 10,739 | yes |
| end of turn | 1,184 | no |

Claude Code assistant events: 221,000 carry tokens, 271 do not.

The rollouts under `~/.codex/sessions` (1,345 files, 13,404 turns, counted by how each turn ends) show a second loss. 11,169 turns end at `task_complete` after a `token_count` line, and their counts are stored. 773 turns end at `turn_aborted` after a `token_count` line, 77 are cut off by the next `task_started` after one, and 16 are still open at the end of the file after one: none of these counts is stored. The turns with no `token_count` line at all (1,173 ending at `task_complete`, mostly written by Codex Desktop `0.146.0-alpha.9.2`, which writes no `token_count` line; 172 at `turn_aborted`; 24 open) have no counts to store. The `token_usage_record` lines newer Codex versions write appear only in turns that also have a `token_count` line, so they add nothing.

Expected: the context size distribution uses only events that carry token counts, and every turn whose rollout has a `token_count` line gets an event with its counts, also when the turn is interrupted or cut off.

## Reproduction

Command: `npx vitest run test/codex_parser.spec.ts test/health_codex_ctx.spec.ts`

- `test/codex_parser.spec.ts`, new describe "parseCodexFileBody — token counts of a turn that does not complete": a rollout with turn `t1` (`token_count` 1000/800/50, then `turn_aborted` at `00:00:04Z`), turn `t2` (`token_count` 2000/1500/60, cut off by `task_started` of `t3` at `00:00:07Z`), turn `t3` (`token_count` 3000/2500/70, `task_complete` at `00:00:09Z`) and turn `t4` (`task_started`, then `turn_aborted` with no `token_count`). Expected events `[ts, role, in_tok, cache_r, out_tok]`: `["2026-07-01T00:00:04Z","assistant",1000,800,50]`, `["2026-07-01T00:00:07Z","assistant",2000,1500,60]`, `["2026-07-01T00:00:09Z","assistant",3000,2500,70]`, and nothing for `t4`.
- `test/health_codex_ctx.spec.ts`, new test "leaves out assistant events that carry no token counts": Codex session `cz` in project `-q` with 10 assistant events, 6 with `in_tok`/`cache_r`/`cache_w` all 0 and 4 with `in_tok` 100/200/300/400 (`cache_r` 90/180/270/360). Expected: ratio 1.33, `max_ctx` 400, `median_ctx` 300, `sample_size` 4, `max_session_id` `cz`, `max_ts` `2026-07-01T00:00:10.000Z`.

Failing output before the fix (2 failed, 47 passed):

```
→ context size of a Codex session with token-less events: expected { ratio: null } to deeply equal { ratio: 1.33, max_ctx: 400, …(4) }
→ token rows of interrupted turns: expected [ [ '2026-07-01T00:00:09Z', …(4) ] ] to deeply equal [ …(3) ]
```

## Root Cause

**A. The health query counts events that carry no tokens.** `src/analyzer/health.ts:78-86` selects every assistant event in scope (`WHERE e.role = 'assistant'`) and sorts by `ctx`; lines 90-103 take the last row as the max and the row at `floor(n / 2)` as the median. The Codex parser writes a turn's counts on one event only, the one it makes at `task_complete` (`src/indexer/codex_parser.ts:960-973`); its reply and tool-call events are made with `makeBlankEvent` (`codex_parser.ts:546`), whose token fields are 0. So a Codex session's rows are mostly `ctx` 0, the median is 0, and `medianCtx > 0` (`health.ts:93`) fails, leaving the ratio `null`. In a mixed scope the zero rows pull the median down.

**B. The parser keeps a turn's counts only until the next `task_started`, and writes them only at `task_complete`.** `token_count` sets `state.pendingInTok`/`pendingCachedTok` and adds to `pendingOutTok` (`codex_parser.ts:982-992`). `task_started`/`turn_started` sets all three to 0 and writes nothing (`codex_parser.ts:952-957`). `task_complete`/`turn_complete` writes them on a new assistant event (`codex_parser.ts:960-973`). There is no branch for `turn_aborted`, so an interrupted turn's counts sit in the state until the next `task_started` sets them to 0, and a turn cut off by a new `task_started` loses them the same way.

## Fix

**A.** In `analyzeHealth` (`src/analyzer/health.ts`), keep only events whose context size is above 0: add `AND (CASE WHEN s.source = 'codex' THEN e.in_tok ELSE e.in_tok + e.cache_r + e.cache_w END) > 0` to the `WHERE` of the `ctxRows` query (repeat the expression rather than use the `ctx` alias in `WHERE`). Update the header comment (`health.ts:9-12`) and the comment above the query to say that events with no token counts (a Codex reply or tool call, a Claude Code line without usage) are left out. The `ctxRows.length >= 4` and `medianCtx > 0` checks stay.

**B.** In the Codex parser (`src/indexer/codex_parser.ts`):

1. Add `pendingTok: boolean` to `SessionState` (after `pendingOutTok`, with a doc comment: a `token_count` line of the current turn has not been written yet), and `pendingTok: false` to the state `parseCodexFile` builds (after `pendingOutTok: 0`). `parseCodexFile` is the only place that builds a `SessionState`; the Codex append path (`src/indexer/codex_append.ts`) keeps and reuses that object, so it carries the new field with no change there.
2. Move the body of the `task_complete` branch into a function `pushTurnTokens(events, uuid, session_id, timestamp, source_file, state)` that pushes the assistant event with `model`, `in_tok`, `cache_r` and `out_tok` from the state, as now, then sets the three counts to 0 and `pendingTok` to false.
3. `token_count`: when it sets the counts from `last_token_usage`, also set `pendingTok = true`.
4. `task_complete` / `turn_complete`: call `pushTurnTokens` as now, with or without `pendingTok`, so the 1,184 end-of-turn rows with no counts stay as they are.
5. `turn_aborted` (new branch): if `pendingTok`, call `pushTurnTokens` with this line's uuid and timestamp; otherwise write nothing. Return.
6. `task_started` / `turn_started`: if `pendingTok`, call `pushTurnTokens` with this line's uuid and timestamp before resetting; then set the counts to 0 as now.

These lines are subject to the same copied-history filter as every line (`codex_parser.ts:705`), so a subagent's copied parent turns still write nothing.

Bump `SCHEMA_VERSION` from 20 to 21 (`src/indexer/schema.ts:101`) with a `v21` note under the `v20` one: Codex turns that end at `turn_aborted`, or are cut off by the next `task_started`, keep their token counts; the version-mismatch rebuild re-reads every rollout still on disk, and a session whose rollout is gone keeps the rows it has. `AGENTS.md` requires the bump for a parse change.

## Implementation Order

1. **Health query.** Change `src/analyzer/health.ts` as in Fix A. Verify: `npx vitest run test/health_codex_ctx.spec.ts` passes all 4 tests.
2. **Parser.** Change `src/indexer/codex_parser.ts` as in Fix B. Verify: `npx vitest run test/codex_parser.spec.ts test/health_codex_ctx.spec.ts` passes.
3. **Append path.** Add a test to `test/driver_codex_append.spec.ts` that grows one rollout `rollout("s-ab")` one line per run from these lines, built with the file's helpers plus two new ones, `started = (s: number) => line(s, "event_msg", { type: "task_started" })` and `aborted = (s: number) => line(s, "event_msg", { type: "turn_aborted", reason: "interrupted" })`: `meta(0, "s-ab")`, `turn(1, "m-1")`, `started(2)`, `tokens(3)`, `aborted(4)`, `started(5)`, `tokens(6)`, `started(7)`, `tokens(8)`, `taskDone(9)`. After each run it checks `files_parsed` 1, `files_appended` 1 once the session is indexed (0 on the first run), and `expectDigestEqualsRebuild()`, as the test "appends a rollout grown one line per run, and matches a rebuild after every run" does. At the end, `SELECT COUNT(*) AS n FROM event WHERE session_id = 's-ab' AND in_tok > 0` gives `{ n: 3 }`. Verify: `npx vitest run test/driver_codex_append.spec.ts` passes.
4. **Schema version.** Bump `SCHEMA_VERSION` to 21 with the note in Fix B. Verify: `npx vitest run test/schema.spec.ts test/schema_migration.spec.ts` passes.
5. **Suite and types.** `npm run typecheck` and `npm test` exit 0.
6. **Plugin bundle.** Run `npm run build` (`plugin/` is committed with every source change, `AGENTS.md`). Verify: `node test/scripts/plugin-smoke.mjs` exits 0.

## Acceptance

- `npx vitest run test/codex_parser.spec.ts test/health_codex_ctx.spec.ts` exits 0.
- `npx vitest run test/driver_codex_append.spec.ts` exits 0, including the new test of step 3.
- `npm run typecheck` and `npm test` exit 0.
- `node test/scripts/plugin-smoke.mjs` exits 0.
- `git status --short` shows changes only in `src/analyzer/health.ts`, `src/indexer/codex_parser.ts`, `src/indexer/schema.ts`, `test/codex_parser.spec.ts`, `test/health_codex_ctx.spec.ts`, `test/driver_codex_append.spec.ts`, files under `plugin/` that `npm run build` rewrites, and this document, besides the untracked `.skerry/` and `docs/experiments/` that were there before.

## Known Limits

- A turn still open at the end of its rollout keeps its counts unwritten (16 turns on this machine). Writing them at the end of the file would give the append path a row it must take back when the turn goes on, so a turn of a crashed session stays without counts.
- Turns whose rollout has no `token_count` line (1,369 on this machine, mostly Codex Desktop `0.146.0-alpha.9.2`) have no counts to store; their sessions show `n/a`, as a session with fewer than 4 counted events does.
- The new rows are assistant events like the `task_complete` rows: they carry the turn's model and no text, so they count wherever Codex assistant events are counted, as an interrupted turn's model call did happen.
- After the bump, a clens 0.2.11 or older still running rebuilds the index with v20 rules; 0.2.12 refuses a newer index (`src/indexer/driver.ts`).
- Codex `cache_write_input_tokens` is still not read; every value seen was 0.

## Open Questions

None.

```skerry
{"run": "20261110-045336-8b9d", "verify": ["npx vitest run test/codex_parser.spec.ts test/health_codex_ctx.spec.ts", "npx vitest run test/driver_codex_append.spec.ts", "npm run typecheck", "npm test", "node test/scripts/plugin-smoke.mjs"], "repro": {"cmd": "npx vitest run test/codex_parser.spec.ts test/health_codex_ctx.spec.ts", "failText": "token rows of interrupted turns", "files": ["test/codex_parser.spec.ts", "test/health_codex_ctx.spec.ts"]}, "extras": []}
```
