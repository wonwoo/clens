# Watcher Retry and Codex Context Size Fix

Two bugs from the 2026-11-09 code review, fixed in one run.

## Symptom

**A. The watcher drops a change when its index run fails.** The MCP server's watcher (`src/indexer/watch.ts`) runs `runIndex` after a `.jsonl` change. When that run fails, the lines it would have indexed stay out of the index until some other transcript changes, and nothing is logged. Seen in a real run (script kept outside the repository, temp dirs set through `CLENS_HOME`, `CLENS_CODEX_HOME`, `CLENS_INDEX_DIR`): another writer held the index lock for 32 s while a line `a2` was appended to `s1.jsonl`; 3 s after the lock was released the index held only `a1`, with no output; only after another file `s2.jsonl` changed did `a2` and `b1` arrive. Expected: the change is indexed once the lock is free, and the failure is logged.

The same happens without another process: a change that arrives while the watcher's own run is still going starts a second `runIndex` at once, which waits for the first run's lock and gives up after 30 s. The full rebuild after a `SCHEMA_VERSION` bump took about 7 minutes on 2026-11-09, so every change during it fails this way. Expected: one run at a time, and one more run after it when a change arrived during it.

**B. `clens_stats` prints Codex context sizes about twice too large.** The context-bloat figures (`max_ctx`, `median_ctx`, `context_bloat_ratio`, printed by `clens_stats` health) add `in_tok + cache_r + cache_w` for every assistant event. On this machine's index (read only, 2026-11-10): of 10,739 Codex assistant events with `in_tok > 0`, none has `cache_r > in_tok`, and `cache_r` averages 0.819 of `in_tok`; the largest Codex `in_tok + cache_r + cache_w` is 1,439,503, while the largest Codex `in_tok` is 726,227. Of 220,486 Claude Code events, 218,339 have `cache_r > in_tok`. Expected: a Codex turn's context size is its input tokens, so Codex and Claude Code turns are on one scale.

Source: the 2026-11-09 review in session `e081f090`, checked again on 2026-11-10 as above.

## Reproduction

Command: `npx vitest run test/watch.spec.ts test/health_codex_ctx.spec.ts`

Files:

- `test/watch.spec.ts`: two new tests (it mocks `runIndex`, as the file already did).
  - "runs again after a run fails because the index is busy, and logs the failure": the first `runIndex` after a write rejects with `Error("indexer busy")` carrying `exitCode: 4`; the test expects a second `runIndex` call with no other write, then `onIndexed` once, and `console.error` output containing `indexer busy`.
  - "runs once more after a run that a change arrived during, never two at once": `runIndex` returns a promise the test resolves by hand; a second `.jsonl` is written while the first run is pending; after 400 ms the test expects 1 call and at most 1 run at a time, then, after the first run finishes, a second call, and `onIndexed` twice.
- `test/health_codex_ctx.spec.ts` (new): an in-memory index with a Codex session `cx` (assistant events `in_tok` 100/200/300/400, `cache_r` 90/180/270/360, `cache_w` 0) and a Claude Code session `cc` (`in_tok` 10, `cache_r` 100/200/300/400, `cache_w` 10), both in project `-p`. Expected: `cx` gives `max_ctx` 400 and `median_ctx` 300; `cc` gives 420 and 320; project `-p` gives `max_ctx` 420 in session `cc`.

Failing output before the fix (same on two runs; 4 failed, 11 passed):

```
→ Codex context size: expected { max_ctx: 760, median_ctx: 570 } to deeply equal { max_ctx: 400, median_ctx: 300 }
→ largest context in a project with Codex and Claude Code: expected { max_ctx: 760, max_session_id: 'cx' } to deeply equal { max_ctx: 420, max_session_id: 'cc' }
→ index runs after a busy failure, with no other change: expected 1 to be 2 // Object.is equality
→ index runs started while one was running: expected { calls: 2, most: 2 } to deeply equal { calls: 1, most: 1 }
```

## Root Cause

**A.** `src/indexer/watch.ts:37-47`. `schedule()` starts `runIndex({ rebuild: false })` from a debounce timer with no record of a run in progress, so a change during a run starts a second, concurrent run. Every rejection goes to `.catch(() => {})` (`watch.ts:43-45`), whose comment says "next change will retry": nothing is logged and nothing runs again. `runIndex` waits up to 30 s for the lock (`src/indexer/driver.ts:444`, `lockTimeoutMs ?? 30_000`) and then throws `Error("indexer busy")` with `exitCode` 4 (`driver.ts:110-111`). So a change whose run gave up waits for the next `.jsonl` event; an incremental run then picks it up, since it compares every file's mtime and size with its cursor. The error `runIndex` throws for an index written by a newer clens (added in commit `56408b4`) is swallowed the same way.

**B.** `src/analyzer/health.ts:74` computes `ctx` as `in_tok + cache_r + cache_w` for every assistant event. The Codex parser stores the turn's `last_token_usage.input_tokens` in `in_tok` and `cached_input_tokens` in `cache_r` (`src/indexer/codex_parser.ts:987-988`, written to the event at `:965-966`); `cache_w` stays 0 for Codex. In Codex usage the cached tokens are part of `input_tokens`. The 2026-11-09 reviewer quoted a real rollout's `last_token_usage` as `{"input_tokens":40424,"cached_input_tokens":40192,...,"output_tokens":92,"total_tokens":40516}`, where 40424 + 92 = 40516; that line is from the reviewer's report only. Checked here: a 2026-11 rollout reads `{"input_tokens":37905,"cached_input_tokens":0,...,"output_tokens":39,...,"total_tokens":37944}` (again input + output = total), and the index statistics in Symptom B show `cache_r` never above `in_tok` for Codex. So for Codex the sum counts the cached part twice. The Claude Code parser stores `cache_read_input_tokens` and `cache_creation_input_tokens` apart from `input_tokens` (`src/indexer/claude_parser.ts:628-631`), which is what the sum is right for. `health.ts` is the only reader of `cache_r` outside `src/indexer/`.

## Fix

**A.** In `startWatch` (`src/indexer/watch.ts`), keep three flags in the closure: `running` (a run is in progress), `again` (run once more when it ends), `stopped` (set by `stop()`), plus `lastError` (the last message logged). Split the timer callback into a function `run()`:

- If `running`, set `again = true` and return. Otherwise set `running = true` and call `runIndex({ rebuild: false })`.
- On success: set `lastError = undefined`, then call `onIndexed()`; a rejection or throw from `onIndexed` is swallowed as before.
- On failure: take the message (`err.message`, or `String(err)`). If it differs from `lastError`, write `clens watch: indexing failed: <message>` with `console.error` and set `lastError` to it. If `err.exitCode === 4` (another writer held the lock for 30 s), set `again = true`. Any other failure is not retried; the next change runs again.
- When the run settles (success or failure): set `running = false`; if `again` and not `stopped`, set `again = false` and call `schedule()`.

`schedule()` stays the debounced entry for file events, the retry timer of a missing sessions dir and the start-up run; its timer now calls `run()`. `stop()` also sets `stopped = true`, so a run that ends after `stop()` schedules nothing. Update the file header and remove the "next change will retry" comment. This removes the cause: no second run starts while one holds the lock, a change during a run is indexed right after it, and a busy failure runs again instead of waiting for an unrelated change.

**B.** In `analyzeHealth` (`src/analyzer/health.ts`), compute `ctx` per source: join `session` and count a Codex event's input only.

```sql
SELECT e.session_id, e.ts,
       CASE WHEN s.source = 'codex' THEN e.in_tok
            ELSE e.in_tok + e.cache_r + e.cache_w END AS ctx
FROM event e LEFT JOIN session s ON s.id = e.session_id
WHERE e.role = 'assistant' AND ${eventScope.sql}
ORDER BY ctx
```

`LEFT JOIN` keeps an event without a session row, counted as before. `eventScope.sql` already qualifies its columns with `e.` and uses its own `session` subqueries, so the join adds no ambiguity. Update the header comment (`health.ts:9-10`) and the comment above the query (`health.ts:69-71`) to say Codex counts `in_tok` only and why. No parser change, so `SCHEMA_VERSION` stays.

## Implementation Order

1. **Watcher.** Change `src/indexer/watch.ts` as in Fix A. Verify: `npx vitest run test/watch.spec.ts` passes all 12 tests, including the existing "does not call onIndexed when runIndex fails" (its rejection has no `exitCode`, so it is not retried and `runIndex` is called once).
2. **Context size.** Change `src/analyzer/health.ts` as in Fix B. Verify: `npx vitest run test/watch.spec.ts test/health_codex_ctx.spec.ts` passes (15 tests).
3. **Suite and types.** Run `npm run typecheck` and `npm test`; both pass.
4. **Plugin bundle.** Run `npm run build`, which rewrites `plugin/dist/server.js` and `plugin/dist/cli.js` from the source (`AGENTS.md`: `plugin/` is committed with every source change, and CI fails when it differs from the build). Verify: `node test/scripts/plugin-smoke.mjs` prints only `PASS` lines and exits 0.

## Acceptance

- `npx vitest run test/watch.spec.ts test/health_codex_ctx.spec.ts` exits 0 with `Tests  15 passed (15)`.
- `npm run typecheck` and `npm test` exit 0.
- `node test/scripts/plugin-smoke.mjs` exits 0.
- `git status --short` shows changes only in `src/indexer/watch.ts`, `src/analyzer/health.ts`, `test/watch.spec.ts`, `test/health_codex_ctx.spec.ts`, `plugin/dist/server.js`, `plugin/dist/cli.js` and this document, besides the untracked `.skerry/` and `docs/experiments/` that were there before.

## Known Limits

- A busy failure runs again until the lock is free. Each attempt waits up to 30 s inside `runIndex`, and the same message is logged once, not per attempt. A lock whose holder stops refreshing it is taken over after 60 s (`AGENTS.md`), so the retries end; while a live writer such as `clens index --rebuild` holds the lock, they continue.
- A failure other than a busy lock (the newer-index error, a parse crash) is logged and waits for the next change, as before. Its message is logged again only when a different message came in between or a run succeeded.
- `onIndexed` failures are still swallowed without a log.
- Codex rollouts now also carry `cache_write_input_tokens`; the parser does not read it, and every value seen on this machine was 0. Whether it is part of `input_tokens` is not checked.
- Other review findings stay open: `clens_stats` counts subagents as sessions and counts subagent time twice in the timeline.

## Open Questions

None.

```skerry
{"run": "20261110-041523-58be", "verify": ["npx vitest run test/watch.spec.ts test/health_codex_ctx.spec.ts", "npm run typecheck", "npm test", "node test/scripts/plugin-smoke.mjs"], "repro": {"cmd": "npx vitest run test/watch.spec.ts test/health_codex_ctx.spec.ts", "failText": "Codex context size: expected", "files": ["test/watch.spec.ts", "test/health_codex_ctx.spec.ts"]}, "extras": []}
```
