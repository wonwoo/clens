# Local Time In Tool Output Design

## Context

Every time clens prints, in its MCP tools and its hooks, is the stored UTC string (`2026-11-05T01:20:20.871Z`). The user reads Korean time, so each answer had to be converted by hand or by the agent (on 2026-11-05 the `/clens:pending` listing and the index rebuild report both needed it), and skills carry their own conversion rules (`plugin/skills/recap/SKILL.md:37`, `:41`; `plugin/skills/stats/SKILL.md:59`, `:65`). The inputs have the opposite problem: `since`, `until` and `around_ts` are compared with the stored UTC strings as text, so `since: "2026-11-04"` means 09:00 on 2026-11-04 in Korea, not midnight.

The user decided (this conversation, 2026-11-05):

- U1. Change all the tools at once, not one tool at a time (ledger item `7acd3d80`, "전체 도구를 바꿀때 바꾸지").
- U2. Print the local time of the machine clens runs on ("현재 여기 시간으로"), which for the author is KST.
- U3. Proceed with the approach proposed in the conversation: print local time with its offset, turn every time input back into UTC before it reaches SQL, keep storing UTC.

Goals and success criteria:

- G1. Every time a clens tool or hook prints is the server's local time with its offset (`2026-11-05T10:20:20.871+09:00`); in a UTC zone it is printed exactly as stored (`…Z`).
- G2. A time clens printed can be passed back as `around_ts`, `since` or `until` and means the same instant: `clens_session` around a `clens_search` hit's printed `ts` returns that hit.
- G3. A date alone (`2026-11-04`) passed as `since` or `until` means the start of that day in local time; a date-time without `Z` or an offset is local time.
- G4. A time input clens cannot read is an `Invalid params` error naming the field and the accepted forms, instead of being compared as text.
- G5. Nothing stored changes: no `SCHEMA_VERSION` bump, no rebuild, the ledger file format unchanged.

Out of scope: the JSON of the `clens stats` CLI command (`src/commands/stats_cmd.ts:53`, `:57`), a developer tool that prints raw rows; time formats other than ISO 8601 (no `Nov 4`, no `yesterday`); a setting to choose the zone (the zone is the server's, U2).

## Checked Behavior

Experiments are in `docs/experiments/2026-11-05-local-time/` (results table in `results.md`; like every `docs/experiments/` folder in this repository, not committed).

| # | Behavior relied on | How checked | Result |
|---|---|---|---|
| B1 | The MCP server runs in the parent's `TZ` when set, else the system zone, under both Claude Code and Codex | E3 | holds for Claude Code 2.1.318 and Codex 0.165.0 |
| B2 | Node's local-time getters follow `process.env.TZ` set at runtime | E1, E5 | holds |
| B3 | `test.env: { TZ: "UTC" }` in `vitest.config.ts` runs every test worker in UTC | E5 | holds |
| B4 | `Date.parse` reads a date alone as UTC midnight, a date-time without offset as local, honours `Z`/`±HH:MM`/`±HHMM`, rolls impossible dates | E4 | holds; hence date-only inputs are handled apart (Interfaces) |
| B5 | zod 4 `z.string().refine(…).transform(…)` inside `z.strictObject` gives the handler the transformed value and a failure lists the path and message | E6 | holds |
| B6 | The `localTs` / `utcBound` rules below give the stated output in UTC, Asia/Seoul, America/New_York (with and without DST) and Asia/Kathmandu (+05:45) | E7 (`e7-output.txt`) | holds |
| B7 | Every stored time on the author's index is the 24-character `toISOString()` form; the parsers store the transcript's `timestamp` as written | results.md, last paragraph; `src/indexer/claude_parser.ts:594`, `src/indexer/codex_parser.ts:455` | holds for the author's index; not enforced by code |
| B8 | Time inputs reach SQL as text compared with stored `ts`: `around_ts` in `src/mcp/session.ts:44`, `:52`; `since`/`until` in `src/mcp/search.ts:393-394`, `src/mcp/recent.ts:44`, `:48`, `src/mcp/left_off.ts:767`, `:771`, `src/mcp/line_origin.ts:121`, `:125`, `src/analyzer/scope.ts:83`, `:90` | source | holds |
| B9 | The MCP schemas live in `src/mcp/server.ts:60-115` (`SessionParamsSchema`, `RecentParamsSchema`, `SearchParamsSchema`, `LeftOffParamsSchema`, `StatsParamsSchema`); every handler rejects a failed parse with `Invalid params: ${error.message}` | source | holds |
| B10 | `test/scripts/plugin-smoke.mjs` starts the server with `getDefaultEnvironment()` (no `TZ`), so it runs in the machine's zone, and checks `request 2026-06-22T02:00:10` (line 88) | source; this machine is Asia/Seoul (E2) | holds: the smoke must pin `TZ` |
| B11 | No test quotes the time descriptions in `server.ts` or the skills (`grep -rn "ISO 8601\|(UTC)" test/` finds only fixture text) | grep | holds |

Not checked: Windows (no machine); how a client renders the offset (it is plain text).

## Design

### Architecture

```
stored UTC ts ──localTs()──▶ every printed time      (src/util/time.ts)
agent input ──timeParam (zod: utcBound)──▶ UTC ISO ──▶ SQL text compare (unchanged)
```

- `src/util/time.ts` (new) owns both directions and imports only `zod`. Nothing else formats or parses a time for output or input.
- Storage, the parsers, the driver and the ledger file are untouched (G5).
- The zone is the process's: `Date`'s local getters (B1, B2). No setting.

### Interfaces: `src/util/time.ts`

```ts
export function localTs(ts: string): string;
```
- Applies only when `ts` matches `/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/` and `Date.parse(ts)` is a number; otherwise returns `ts` unchanged (`"?"`, `null`-placeholders, odd stored values).
- Returns `YYYY-MM-DDTHH:MM:SS` from the `Date`'s local getters, then the input's fraction exactly as written (group 2, may be absent), then the zone: `Z` when `getTimezoneOffset()` is 0, else `+HH:MM` / `-HH:MM` of the local offset at that instant.
- Examples (E7): Asia/Seoul `2026-11-05T01:20:20.871Z` → `2026-11-05T10:20:20.871+09:00`; `2026-06-22T02:00:10Z` → `2026-06-22T11:00:10+09:00`; America/New_York `2026-11-05T01:20:20.871Z` → `2026-11-04T20:20:20.871-05:00`; UTC: unchanged.

```ts
export function utcBound(input: string): string | null;
```
- Trims `input`. A date alone, `/^(\d{4})-(\d{2})-(\d{2})$/`: `new Date(y, m - 1, d)` (local midnight); null when its year, month or day differ from the input (`2026-02-30`); else its `toISOString()`.
- A date-time, `/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i`: `Date.parse` of it with the first space replaced by `T`; null when NaN; else `new Date(t).toISOString()`.
- Anything else (`2026-11`, `yesterday`, empty) → null.

```ts
export const TIME_INPUT_HINT: string;
// "not a date or time: pass YYYY-MM-DD (the start of that day, local time) or YYYY-MM-DDTHH:MM[:SS[.sss]], optionally ending in Z or ±HH:MM (without one it is local time)"
export const timeParam: z.ZodType<string>;
// z.string().refine((s) => utcBound(s) !== null, { message: TIME_INPUT_HINT }).transform((s) => utcBound(s)!)
```

### Inputs: `src/mcp/server.ts`

- Replace `z.string()` with `timeParam` (and `.optional()` where it was optional) for: `SessionParamsSchema.around_ts`; `since` and `until` of `RecentParamsSchema`, `SearchParamsSchema`, `LeftOffParamsSchema`; `StatsParamsSchema.since`. Handlers keep their code: they now receive UTC ISO strings, and an unreadable value fails the parse they already report (B9, G4).
- Rewrite the input descriptions:
  - `clens_search.since`: "Lower bound (at or after). A date alone, YYYY-MM-DD, is the start of that day in local time; a date-time without Z or an offset is local time. Times clens printed can be passed back as they are."
  - `clens_search.until`: "Upper bound (at or before). Same forms as since; a date alone is the start of that day, so pass the next day to include a whole day. Combine with since to bound a window."
  - `clens_recent.since`: "Lower bound, same forms as clens_search's since. For 'today' pass today's date; for 'yesterday' pass yesterday's date with until set to today's."
  - `clens_recent.until`: "Upper bound, same forms as since."
  - `clens_session.around_ts`: "A time clens printed, such as a clens_search hit's ts, as printed: the message at that time and those around it."
  - `clens_left_off.since`: its first words "ISO 8601 lower bound" become "Lower bound (same forms as clens_search's since)"; the rest of the sentence stays.
  - `clens_left_off.until`: "Upper bound (at or before this time), same forms as since. Combine with since to bound a window."
  - `clens_stats.since`: "Lower bound, same forms as clens_search's since. Omit for all-time stats. Ignored when session_id is set."

### Outputs

Wrap each printed time in `localTs(…)`; nothing else in these lines changes. Sites (line numbers at commit `ba3eeef`):

| File | Lines | Values |
|---|---|---|
| `src/mcp/search.ts` | 137 | `r.ts` |
| `src/mcp/recent.ts` | 171 | `r.ts` |
| `src/mcp/server.ts` | 497 | `m.ts` (moved, see below) |
| `src/mcp/left_off.ts` | 197, 202, 667, 677, 680, 686, 695, 698, 700, 710, 803 | `more.since`; `s.ended_at`, `s.started_at`; `r.started_at`, `r.ended_at` (keep the `?? "?"`: `localTs` returns `"?"` unchanged); `q.ts`; `r.last_reply.ts`; `e.last_ts`; `g.ts`; `f.ts`; `b.ts`; `g.started_at`, `g.ended_at`; `s.ts` |
| `src/mcp/checks.ts` | 170, 310, 316, 362 | `g.last_ts`; `s.first_ts`, `s.last_ts`; `g.ts`; `b.last_ts` |
| `src/mcp/line_origin.ts` | 195, 196, 201, 203 | `t.request.ts`; `t.reply_before.ts`; `o.edited_at`; `o.last.edited_at` |
| `src/mcp/stats.ts` | 217, 266, 297 | `facts.started_at`, `facts.ended_at`; `d.max_ts`; `r.ts` |
| `src/mcp/ledger.ts` | 237, 240 | `i.updated`; `i.created` |
| `src/hooks/failure_hint.ts` | 232 | the date becomes `localTs(call.ts).slice(0, 10)`; `around_ts ${localTs(call.ts)}`. Line 233 keeps computing from the stored `call.ts` |

The compaction hook (`src/hooks/compact.ts`) prints through `formatSessionRecordWithin` (`left_off.ts:731`), so it is covered by the `left_off.ts` rows.

`clens_session`'s rendering moves out of the handler into `src/mcp/session.ts` so it can be tested: `export function formatSessionMessages(messages: SessionMessage[]): string` returning `messages.map((m, i) => \`[${i + 1}] ${m.role.toUpperCase()} ${localTs(m.ts)}\n${m.text}\`).join("\n\n")`; the handler calls it (the `"No messages found."` branch stays in the handler).

### Text for agents and contributors

- `plugin/skills/recap/SKILL.md`: line 37 "`started_at` and `ended_at` (UTC)" → "`started_at` and `ended_at` (local time, with its offset)"; lines 40-42 "pass it as `since` and `until`, converted from the user's local time to UTC, with `limit: 10`." → "pass it as `since` and `until` (a date alone is the start of that day in local time), with `limit: 10`."
- `plugin/skills/stats/SKILL.md`: line 59 "set `since` to 1 month before now (UTC), not `undefined`." → "set `since` to the date one month before today, not `undefined`."; in step 3, lines 64-66, the words "compute `since` accordingly as an ISO 8601 UTC timestamp (start of that day/period, same convention as `clens_recent`/`clens_search`)" (wrapped over those lines) → "compute `since` accordingly as a date, YYYY-MM-DD, the start of that day in local time (the same forms as `clens_recent`/`clens_search`)".
- `AGENTS.md`, Key invariants, a new bullet after "A parse change bumps `SCHEMA_VERSION`": "**Times.** The index and the ledger store UTC (`toISOString()`). Tools and hooks print every time through `localTs()` (`src/util/time.ts`): the server's local time with its offset, `Z` in UTC. Every time a tool takes (`since`, `until`, `around_ts`) is a `timeParam`, which turns it into UTC before SQL. Never print a stored time as it is, and never compare a raw input with one."

### Tests

- `vitest.config.ts`: add `env: { TZ: "UTC" }` to `test` (B3). Existing assertions keep their `…Z` strings, since `localTs` returns the stored string unchanged in UTC.
- `test/tz.ts` (new, not a spec): `export function withTz<T>(zone: string, fn: () => T): T` sets `process.env.TZ`, runs `fn`, and restores the previous value (deleting it when it was unset) in `finally`.

## Assumptions To Check

- A1. Wrapping only the sites in the Outputs table leaves no stored time printed as it is: under `TZ=Asia/Seoul`, no output of any formatter, of `clens_session`, or of the two hooks matches `/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/` (step 3 tests and the smoke).
- A2. With `test.env: { TZ: "UTC" }`, the whole suite passes unchanged on a machine whose zone is not UTC (step 1).
- A3. `clens_search` → `clens_session` with the printed `ts` returns the hit through the real server in a non-UTC zone (smoke, step 5), for stored times with milliseconds.

## Implementation Order

1. **Time helpers.** Create `src/util/time.ts` (Interfaces), `test/tz.ts`, `test/time.spec.ts`; add `env: { TZ: "UTC" }` to `vitest.config.ts`. `test/time.spec.ts` checks, with `withTz`: every `localTs` and `utcBound` line of E7's table (`docs/experiments/2026-11-05-local-time/e7-output.txt`) for UTC, Asia/Seoul, America/New_York and Asia/Kathmandu; `localTs` of `"?"` and `"garbage"` returns them unchanged; `timeParam.safeParse("yesterday")` fails with `TIME_INPUT_HINT` and `timeParam.parse("2026-11-05T10:20:20.871+09:00")` is `2026-11-05T01:20:20.871Z`. Verify: `npx vitest run test/time.spec.ts`, then `npm test` passes unchanged (A2).
2. **Inputs.** In `src/mcp/server.ts` use `timeParam` for the fields under Inputs and rewrite the eight descriptions. Verify: `npm run typecheck`; the smoke's KST checks in step 5 cover the server path.
3. **Outputs.** Wrap every site in the Outputs table; add `formatSessionMessages` to `src/mcp/session.ts` and call it from the handler. Add one test per formatter, each rendering that spec file's existing fixture inside `withTz("Asia/Seoul", …)` and asserting that the output contains the KST form of one known fixture time and does not match `/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/`: `formatSearchResults` (`test/mcp_search.spec.ts`), `formatResults` (`test/mcp_recent.spec.ts`), `formatLeftOff` with a `more` footer, `formatSessionRecord` on a record that has requests, a last reply, edited files, a git command, a failed call, a hook block, a check and two segments, `formatSessionRecordWithin`, `formatCommitSessions` (`test/mcp_left_off.spec.ts`), `formatBranchChecks` and `formatRecentBranches` (`test/mcp_checks.spec.ts`), `formatLineOrigins` (`test/mcp_line_origin.spec.ts`), `formatStats` with a session span, a context-bloat `max_ts` and a hook block (`test/mcp_stats.spec.ts`), `formatPending` with a changed item (`test/mcp_ledger.spec.ts`), `failureHint` (`test/failure_hint.spec.ts`), `formatSessionMessages` (`test/mcp_session.spec.ts`). Where a spec's fixture lacks one of the listed parts, add it to that test's own data. Verify: `npm test`.
4. **Text.** Edit the two skills and `AGENTS.md` as under "Text for agents and contributors". Verify: `claude plugin validate plugin` passes; `grep -n "UTC" plugin/skills/recap/SKILL.md plugin/skills/stats/SKILL.md` prints nothing.
5. **Smoke.** In `test/scripts/plugin-smoke.mjs`: add `TZ: "UTC"` to `env` so the existing checks keep their `…Z` strings (B10). Write one more fixture session, `late.jsonl` (`sessionId` `late`), with two lines: user "write the late night deploy note" at `2026-06-21T16:00:00.250Z` and assistant "the deploy note is written" at `2026-06-21T16:00:05.500Z`. After the existing checks, start a second client against the same plugin and index with `env: { ...env, TZ: "Asia/Seoul" }` and check (each a `check(...)` line):
   - "local search": `clens_search` `{ query: "deploy note", session_id: "late", role: "user", limit: 1 }` contains `2026-06-22T01:00:00.250+09:00  session:late`.
   - "local session": `clens_session` `{ session_id: "late", around_ts: "2026-06-22T01:00:00.250+09:00", limit: 1 }` contains `USER 2026-06-22T01:00:00.250+09:00` and `write the late night deploy note`.
   - "local since": `clens_search` `{ query: "deploy note", project_id: "-fixture-cwd", since: "2026-06-22" }` is not an error and contains `session:late`; the same call on the UTC client returns `No results found.`
   - "bad time": `clens_search` `{ query: "deploy note", since: "yesterday" }` has `isError: true` and its text contains `not a date or time`.
   - "local pending": `clens_pending` `{ project_id: "-fixture-cwd" }` matches `/\+09:00/` and not `/\d{2}:\d{2}:\d{2}(\.\d+)?Z/`.
   - "local compact hook": `compact.mjs` with input `{ session_id: "late", source: "compact" }` and `env.TZ = "Asia/Seoul"` contains `2026-06-22T01:00:00.250+09:00`.
   Verify: `npm run build`, then `node test/scripts/plugin-smoke.mjs` prints only PASS lines and exits 0.

## Acceptance

- AC1 (G1). Under `TZ=Asia/Seoul` no formatter, `formatSessionMessages`, `failureHint` or compaction-hook output contains a `…Z` time, and each shows its fixture time with `+09:00` (step 3 tests, smoke "local search", "local session", "local pending", "local compact hook").
- AC2 (G1). Under `TZ=UTC` every existing test passes without changing an asserted time (`npm test`).
- AC3 (G2). Smoke "local session": the printed `ts` passed back as `around_ts` returns that message.
- AC4 (G3). Smoke "local since": `since: "2026-06-22"` includes a message at 2026-06-22 01:00 KST in Asia/Seoul and excludes it in UTC; `test/time.spec.ts` covers date-only and offset-less date-time in four zones.
- AC5 (G4). Smoke "bad time": `since: "yesterday"` is an `Invalid params` error with the hint.
- AC6 (G5). `git diff ba3eeef -- src/indexer src/mcp/ledger.ts` shows no change to `SCHEMA_VERSION`, the parsers or the ledger's stored fields (only `formatPending`'s output lines differ in `ledger.ts`).

Scenarios (run from the repository root after `npm run build`):

```
$ node test/scripts/plugin-smoke.mjs
PASS tools
PASS search
PASS line origin
…
PASS local search
PASS local session
PASS local since
PASS bad time
PASS local pending
PASS local compact hook
```
(exit code 0; the `…` stands for the existing PASS lines, which stay as they are.)

```
$ npx vitest run test/time.spec.ts
```
passes; its Asia/Seoul case shows `localTs("2026-11-05T01:20:20.871Z")` is `2026-11-05T10:20:20.871+09:00` and `utcBound("2026-11-04")` is `2026-11-03T15:00:00.000Z`.

## Known Limits

- A stored time without milliseconds (`…:10Z`; none on the author's index, B7, but test fixtures have them) comes back from `utcBound` as `…:10.000Z`, which sorts before it: passed back as `around_ts` the message lands in the "after" half instead of being the centre, and as `until` it is left out. Real transcripts carry milliseconds.
- In the hour a DST change repeats, an offset-less local input means the first of the two instants (`Date.parse`'s choice); the printed times carry offsets, so passing them back is exact.
- An agent that converts to UTC itself (old habit, or an old skill text cached) still works: a `…Z` input is read as UTC.
- `formatSessionRecordWithin`'s character budget is spent 5 more characters per printed time (`+09:00` against `Z`), so the compaction hook's record holds slightly fewer lines in non-UTC zones.
- Inputs like `2026-11` or `Nov 4`, accepted silently before (compared as text), now fail with the hint.
- Not checked: Windows.

## Open Questions

None. The defaults taken: the zone is the server process's (U2), not a setting; an unreadable time input is an error rather than ignored (G4).

## Goals Check

- G1: met by the Outputs table and `localTs` (AC1, AC2).
- G2: met by `timeParam` on `around_ts` and the fraction kept in `localTs` (AC3), for stored times with milliseconds (Known Limits).
- G3: met by `utcBound`'s date-only and offset-less rules (AC4).
- G4: met by `timeParam`'s refine (AC5).
- G5: met: only formatting and input parsing change (AC6).

```skerry
{"run": "20261105-070749-0150", "verify": ["npm run typecheck", "npm test", "node test/scripts/plugin-smoke.mjs"], "extras": []}
```

## Changes After Approval

- Implementation Order step 5, smoke "bad time": the document checks `isError: true` and that the text contains `not a date or time`. The check now also requires the text to start with `Invalid params`, because AC5 says the error is an `Invalid params` error and the check as written did not show it.
- Design, Tests, `test/tz.ts`: the document gives it one export, `withTz`. It also exports `UTC_TIME`, the pattern `/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/` from A1 and step 3, so the twelve step-3 tests share one copy instead of each spelling it.
- Design, Interfaces: the document puts `timeParam` in `src/util/time.ts` and says that file imports only `zod`. `timeParam` is now in `src/mcp/time_param.ts` (same definition, imported by `src/mcp/server.ts` and `test/time.spec.ts`), and `src/util/time.ts` imports nothing. Why: the hooks print through `localTs`, so zod went into `plugin/hooks/tool_failure.mjs` (17,085 → 560,838 bytes) and `plugin/hooks/compact.mjs` (42,824 → 586,510 bytes), a cost paid on every hook run. `test/time.spec.ts` checks that `src/util/time.ts` has no import.
