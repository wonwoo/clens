# Ledger List at Session Start Design

## Context

clens keeps a ledger of what the user set aside (`~/.clens/ledger.jsonl`, written by `clens_hold`, read by `clens_pending`; `src/mcp/ledger.ts`). The guidance the agent reads (`HOLD_GUIDANCE`, `src/mcp/instructions.ts:22-27`) ends with "When you finish an item clens_pending listed as held, record it done with its id." So a held item is marked done only when the agent called `clens_pending` in that same session. Work picked up in a new session ("tasklog에 rm 명령 추가해줘") leaves the item held, and the user has to mark it done by hand through `/clens:pending`. Nothing reminds the agent of dropped ideas either, unless it calls `clens_pending`.

Goal: an agent that finishes a held item marks it done without being asked, from any session, and does not propose a dropped idea again.

Success criteria:

- G1. At session start (startup, resume, clear) and right after a compaction, in Claude Code and in Codex, the agent's context holds this project's held and dropped items with their ids.
- G2. The guidance tells the agent to mark a finished held item done with its id, to leave a partly done item held, and not to propose a dropped item again unless the user brings it up.
- G3. The list stays small: at most 10 held and 5 dropped items and 6,000 characters, with the rest named as "+N more … clens_pending".
- G4. A missing or broken ledger, or a hook input without `cwd`, adds nothing and never fails the session start.

Decisions already made (conversation of 2026-11-05, session e081f090):

- Show the list in a SessionStart hook in both tools, at startup, resume, clear and compact; cap it and point to `clens_pending` for the rest. The user agreed to build it after the experiments ("오케 일단 내일진행하도록하자"; ledger item `3918c43c`).
- The new last sentence of `HOLD_GUIDANCE` is the one tested in the experiments (R1-R15): "When you finish an item listed as held, at the start of the session or by clens_pending, record it done with clens_hold and its id; if only part of it is done, leave it held. Do not propose a dropped item again unless the user brings it up."
- The list format is the one tested (`docs/experiments/2026-11-05-ledger-autodone/list.txt`, `list-cap.txt`).

Out of scope: marking items done by the hook itself (only the agent can tell that the work is done), showing done items, changing `clens_pending` or `clens_hold` behavior, and the other held items (`bf2259da`, `c14c6b1a`).

## Checked Behavior

Experiments are in `docs/experiments/2026-11-06-ledger-list/results.md` (E1-E3 run for this design, R1-R15 run on 2026-11-05).

| # | Behavior relied on | How checked | Result |
|---|---|---|---|
| K1 | Claude Code 2.1.318 passes `cwd` (the folder the session runs in) in the SessionStart hook input for `startup`, `resume` and `compact` | E1, `inputs/b-*.json` | holds; `clear` not run |
| K2 | In Claude Code, two SessionStart entries that both match `compact` (the existing `compact.mjs` entry and a new one) both reach the model | E1 (`A-compact-7731` and `B-compact-7731` both quoted) | holds |
| K3 | Codex 0.166.0 passes `cwd` in the SessionStart input for `startup`, `resume` and `compact` | E3, `inputs/p-*.json` | holds; `clear` not run |
| K4 | Codex passes a SessionStart `additionalContext` of 9,500 characters to the model uncut, with no `additionalContextLimit` on the entry | E2 (rollout file) | holds. The Codex entry for `hold_guidance.mjs` sets no limit (`plugin/.codex-plugin/hooks.json`), and its output stays under 9,500 characters (see Design) |
| K5 | Claude Code moves a hook output of about 10,000 characters or more to a file | comment at `src/hooks/compact.ts:20-21` (earlier finding, not re-run) | the list stays under 6,000 characters, so this does not apply |
| K6 | Given the list, Claude Code and Codex agents mark the finished held item done with its id, leave partial work held, touch nothing on unrelated work, and do not propose dropped ideas; without the list they mark nothing | R1-R7, R14, R15 | holds in every run (2 runs per Claude scene, 1 per Codex scene) |
| K7 | With 18 held and 6 dropped items the agent picks the right id and leaves a similar one alone; when the item is cut from a capped list, the agent calls `clens_pending` and then marks it | R8-R10 | holds |
| K8 | After a compaction the agent still marks the item done, whether the list comes again after compaction or only at startup | R11, R12 | holds |
| K9 | The ledger's `project_id` is the working directory with every `/` replaced by `-`: the tools tell the agent so (`HOLD_DESCRIPTION`, `src/mcp/instructions.ts:83`), and clens derives Codex project ids the same way (`src/indexer/sources.ts:52`, `src/hooks/failure_hint.ts:187`) | source | holds for agents that follow the description |
| K10 | `readLedger(path)` returns `{ items: [], unreadable: 0 }` for a missing file and throws on other read errors | `src/mcp/ledger.ts:103-111` | holds |
| K11 | `ledgerPath()` is `<CLENS_INDEX_DIR>/ledger.jsonl` when `CLENS_INDEX_DIR` is set | `src/util/paths.ts:24-31,67-69` | holds |
| K12 | `SERVER_INSTRUCTIONS` is 3,215 characters now (`HOLD_GUIDANCE` 1,169); the new sentence adds about 160, under the 4,096 cap that `test/mcp_instructions.spec.ts` guards | `npx tsx` print of both lengths | holds |
| K13 | `test/scripts/plugin-smoke.mjs` runs the hooks from a copy of `plugin/` with `CLENS_INDEX_DIR` set to a temporary folder, and already records `Add a due date to tasks` as held in project `-fixture-cwd` | `test/scripts/plugin-smoke.mjs:31-38,100-132` | holds |

Not checked: the `clear` source in either tool (the matcher includes it as the Codex entry already does); Windows paths.

## Design

### Architecture

```
~/.clens/ledger.jsonl
        │ readLedger()                       (src/mcp/ledger.ts, unchanged)
        ▼
formatLedgerList(items, project_id)          (src/mcp/ledger.ts, new)
        ▲
ledgerContext(input)                         (src/hooks/ledger_context.ts, new)
   parses the hook's stdin, takes cwd → project_id
        ▲                          ▲
src/hooks/ledger_list.ts (new)     src/hooks/hold_guidance.ts (changed)
Claude Code SessionStart           Codex SessionStart
prints the list                    prints HOLD_GUIDANCE, then the list
```

Claude Code reads `HOLD_GUIDANCE` from the server instructions, so its hook prints only the list. Codex does not pass server instructions to the model, so its existing hook prints the guidance and now the list after it. Neither hook needs the index or `better-sqlite3`; they read only the ledger file.

### Interfaces

`src/mcp/ledger.ts` (added):

```ts
export const LEDGER_LIST_HELD_MAX = 10;
export const LEDGER_LIST_DROPPED_MAX = 5;
export const LEDGER_LIST_MAX_CHARS = 6000;

/** The SessionStart list of one project's held and dropped items, or null
 *  when the project has none. */
export function formatLedgerList(items: LedgerItem[], project_id: string): string | null;
```

Rules, in order:

1. Keep items with `item.project_id === project_id` and status `held` or `dropped`. If none, return `null`.
2. The first line is exactly `clens ledger for this project, from earlier sessions (ids for clens_hold; full list with clens_pending):`.
3. For each group in the order `held`, `dropped`, skipping a group with no items: sort it by `updated` descending, ties by `id` ascending (the order `formatPending` uses, `src/mcp/ledger.ts:222-226`). Push the line `held:` or `dropped:`. Then for each item, while fewer than the group's maximum (10 held, 5 dropped) are shown: build `- <id>  <item>  (words: "<words>")`, two spaces before the item and before the parenthesis, where `item` and `words` have every run of whitespace replaced by one space and are trimmed. If the lines so far joined with `\n`, plus `\n`, plus this line, would be longer than `LEDGER_LIST_MAX_CHARS - 200` characters, stop this group; otherwise push it. After the group, when `n` items were not shown (n > 0), push `(+<n> more held items: clens_pending)`, with `item` instead of `items` when n is 1, and `dropped` for the dropped group.
4. Return the lines joined with `\n`.

The 200 characters kept back cover the `dropped:` line and two "+N more" lines (each under 45 characters), so the result never exceeds 6,000 characters. A single item longer than the room left (possible only in a hand-edited ledger) ends its group and is counted in "+N more".

`src/hooks/ledger_context.ts` (new):

```ts
/** The ledger list for the project of a SessionStart hook input (the JSON
 *  text the hook reads from stdin), or null when there is nothing to add. */
export function ledgerContext(input: string): string | null;
```

- Parse `input` as JSON. When it fails, or the value is not a non-null object, or its `cwd` is not a non-empty string, return `null`.
- `project_id` is `cwd.replace(/\//g, "-")`.
- Call `readLedger(ledgerPath())`. When it throws, return `null`.
- Return `formatLedgerList(ledger.items, project_id)`.

`src/hooks/ledger_list.ts` (new, Claude Code): read stdin to its end into a string, call `ledgerContext`. When it returns `null`, write nothing and exit 0. Otherwise write `JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: list } })`. Header comment in the style of the other hooks: what it does, that it is registered for Claude Code only, and that `npm run build` bundles it into `plugin/hooks/ledger_list.mjs`.

`src/hooks/hold_guidance.ts` (changed, Codex): read stdin into a string instead of discarding it; `const list = ledgerContext(input)`; `additionalContext` is `HOLD_GUIDANCE` when `list` is `null`, else `` `${HOLD_GUIDANCE}\n\n${list}` `` (the form tested in R14, R15). Update its header comment to say it also lists the project's held and dropped items. Its output is at most 1,169 + 160 + 2 + 6,000 characters plus the JSON wrapper, under the 9,500 checked in K4.

`src/mcp/instructions.ts`:

- Replace the last line of `HOLD_GUIDANCE` with exactly: `When you finish an item listed as held, at the start of the session or by clens_pending, record it done with clens_hold and its id; if only part of it is done, leave it held. Do not propose a dropped item again unless the user brings it up.`
- In `HOLD_DESCRIPTION`, `its id (from clens_pending or an earlier clens_hold)` becomes `its id (from clens_pending, the ledger list at session start, or an earlier clens_hold)`.
- In the header comment (lines 17-21), after "prints the same text", add that the SessionStart hooks also list the project's held and dropped items (`src/hooks/ledger_list.ts` in Claude Code, `src/hooks/hold_guidance.ts` in Codex).

### Hook registration

`plugin/hooks/hooks.json` (Claude Code): add a second `SessionStart` entry after the `compact` one:

```json
{
  "matcher": "startup|resume|clear|compact",
  "hooks": [
    { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/ledger_list.mjs\"", "timeout": 10 }
  ]
}
```

and append to its `description`: ` At the start of a session and after a compaction, list the project's held and dropped items from clens's ledger.`

`plugin/.codex-plugin/hooks.json` (Codex): the entries stay; its `description` sentence `At the start of a session, tell the agent to record in clens's ledger what the user sets aside.` becomes `At the start of a session and after a compaction, tell the agent to record in clens's ledger what the user sets aside, and list the project's held and dropped items.`

`scripts/build.mjs`: add `await build({ ...common, entryPoints: ["src/hooks/ledger_list.ts"], outfile: "plugin/hooks/ledger_list.mjs" });` after the `hold_guidance` line.

### Documentation

Each change below names the sentence it follows or replaces; the new text is in a block.

`README.md`:

- Line 93, after the sentence "Say an item is done or was recorded by mistake, and it is updated.", add:
  ```
  An agent that finishes a held item marks it done by itself.
  ```
- Line 117, replace the second sentence ("In Codex a session-start hook … to the model.") with:
  ```
  At the start of a session and after a compaction, a hook lists the project's held and dropped items with their ids, so the agent marks a held item done when it finishes it and does not propose a dropped one again: `hooks/ledger_list.mjs` in Claude Code, and in Codex `hooks/hold_guidance.mjs`, which also tells the agent to record, since Codex does not pass the server's instructions to the model.
  ```
- Limits, last bullet: before its last sentence ("In Codex nothing is recorded until you trust clens's hooks."), add:
  ```
  Likewise it marks a held item done only when it sees that the work it finished is that item.
  ```
- Line 145, replace the clause from "and the ledger guidance hook" up to and including "registered for Codex only;" with:
  ```
  the ledger list hook `plugin/hooks/ledger_list.mjs`, built from `src/hooks/ledger_list.ts` and registered for Claude Code only, and the ledger guidance hook `plugin/hooks/hold_guidance.mjs`, built from `src/hooks/hold_guidance.ts` and registered for Codex only;
  ```

`README.ko.md`, the same places:

- Line 93, after the sentence "어떤 항목을 끝냈다거나 잘못 적혔다고 말하면 그대로 고칩니다.", add:
  ```
  보류 항목을 끝낸 에이전트는 따로 말하지 않아도 완료로 적습니다.
  ```
- Line 117, replace the second sentence ("Codex는 서버 안내문을 … 알려 줍니다.") with:
  ```
  세션이 시작될 때와 압축 직후에는 훅이 이 프로젝트에서 보류하거나 버린 항목을 id와 함께 보여 줍니다. 그래서 에이전트는 보류 항목을 끝내면 완료로 적고, 버린 항목은 다시 제안하지 않습니다. Claude Code에서는 `hooks/ledger_list.mjs`가, Codex에서는 `hooks/hold_guidance.mjs`가 이 일을 합니다. Codex는 서버 안내문을 모델에 넘기지 않으므로 이 훅이 기록하라는 안내도 함께 전합니다.
  ```
- 한계, last bullet: before its last sentence ("Codex에서는 clens 훅을 신뢰하기 전까지 아무것도 적히지 않습니다."), add:
  ```
  보류 항목도 방금 끝낸 일이 그 항목이라고 알아볼 때만 완료로 적습니다.
  ```
- Line 145, replace the sentence that starts "장부 안내 훅은" and ends "Codex에만 등록합니다." with:
  ```
  장부 목록 훅은 `src/hooks/ledger_list.ts`를 빌드한 `plugin/hooks/ledger_list.mjs`로 Claude Code에만 등록하고, 장부 안내 훅은 `src/hooks/hold_guidance.ts`를 빌드한 `plugin/hooks/hold_guidance.mjs`로 Codex에만 등록합니다.
  ```

## Assumptions To Check

- A1. Claude Code 2.1.318 runs `plugin/hooks/ledger_list.mjs` from the installed plugin's `hooks.json` on startup with `${CLAUDE_PLUGIN_ROOT}` resolved, as it does for `compact.mjs` (E1 used a `--settings` hook, not the plugin).
- A2. `claude plugin validate plugin` accepts `hooks.json` with two `SessionStart` entries.
- A3. The new `HOLD_GUIDANCE` keeps `SERVER_INSTRUCTIONS` within 4,096 characters and everything before the ledger paragraph within 2,048 (the existing test in `test/mcp_instructions.spec.ts`).

## Implementation Order

1. **Format.** `formatLedgerList` and the three constants in `src/mcp/ledger.ts`. Tests in a new `test/ledger_list.spec.ts` (fixtures are `LedgerItem` objects built in the test):
   - returns `null` for an empty list, for a project with only `done` and `removed` items, and for a `held` item of another project;
   - prints exactly, for held `a1b2c3d4` "Add rm" words "later" and dropped `c9d0e1f2` "Use SQLite" words "no need":
     ```
     clens ledger for this project, from earlier sessions (ids for clens_hold; full list with clens_pending):
     held:
     - a1b2c3d4  Add rm  (words: "later")
     dropped:
     - c9d0e1f2  Use SQLite  (words: "no need")
     ```
   - orders a group by `updated` descending, ties by `id` ascending;
   - with 18 held and 6 dropped short items, shows 10 and 5 and ends the groups with `(+8 more held items: clens_pending)` and `(+1 more dropped item: clens_pending)`;
   - with 10 held items whose `item` is 300 characters and `words` 500, the result is at most 6,000 characters, and the shown items plus the "+N more held items" count make 10;
   - replaces a newline and runs of spaces in `item` and `words` with one space;
   - with only held items, prints no `dropped:` line.
   Check: `npx vitest run test/ledger_list.spec.ts`.
2. **Hook input.** `src/hooks/ledger_context.ts`. Tests in `test/ledger_list.spec.ts`, with `CLENS_INDEX_DIR` set to a `mkdtempSync` folder in `beforeAll` and removed in `afterAll` (as `test/compaction.spec.ts` does):
   - a ledger file with a held item of `-work-app` and one of `-other`: `ledgerContext('{"source":"startup","cwd":"/work/app"}')` contains the first and not the second;
   - returns `null` for input `not json`, for `{"source":"startup"}`, for `{"cwd":7}`, for `{"cwd":""}`, when the ledger file does not exist, and when the ledger path is a directory (`readLedger` throws `EISDIR`).
   Check: `npx vitest run test/ledger_list.spec.ts`.
3. **Guidance.** `HOLD_GUIDANCE`, `HOLD_DESCRIPTION` and the comment in `src/mcp/instructions.ts`. Add to `test/mcp_instructions.spec.ts` a test that `HOLD_GUIDANCE` contains `When you finish an item listed as held, at the start of the session or by clens_pending, record it done with clens_hold and its id`, `if only part of it is done, leave it held` and `Do not propose a dropped item again unless the user brings it up`, and no longer contains `When you finish an item clens_pending listed as held`. Check: `npx vitest run test/mcp_instructions.spec.ts` (the length test covers A3).
4. **Hooks and build.** `src/hooks/ledger_list.ts`, the `src/hooks/hold_guidance.ts` change, the `scripts/build.mjs` entry, both `hooks.json` files. Add to `test/ledger_list.spec.ts` a test that reads `plugin/hooks/hooks.json` and finds a `SessionStart` entry with matcher `startup|resume|clear|compact` whose command contains `hooks/ledger_list.mjs`. Check: `npm run build`, then `npx vitest run test/ledger_list.spec.ts` and `claude plugin validate plugin` (A2).
5. **Smoke.** In `test/scripts/plugin-smoke.mjs`, after the `hold guidance hook` check, add:
   - `ledger list hook`: run `node <plugin>/hooks/ledger_list.mjs` with input `{"source":"startup","cwd":"/fixture/cwd"}`; expect `"hookEventName":"SessionStart"` and `Add a due date to tasks` (recorded earlier in the script for `-fixture-cwd`);
   - `ledger list hook (other project)`: input `{"source":"startup","cwd":"/elsewhere"}`; expect empty output;
   - `hold guidance hook (with list)`: run `hold_guidance.mjs` with input `{"source":"startup","cwd":"/fixture/cwd"}`; expect both `call clens_hold` and `Add a due date to tasks`.
   The existing `hold guidance hook` check (input without `cwd`) stays. Extend the header comment's list of what the script runs. Check: `npm run build && node test/scripts/plugin-smoke.mjs`.
6. **Docs.** README.md and README.ko.md as in Documentation. Check: `grep -n "ledger_list.mjs" README.md README.ko.md` shows lines 117 and 145 in each.
7. **Full check.** `npm run typecheck && npm test && npm run build && node test/scripts/plugin-smoke.mjs`, then `git status --short plugin/` shows `plugin/hooks/ledger_list.mjs` as new and the changed bundles, which are committed with the source.

## Acceptance

- AC1. `formatLedgerList` and `ledgerContext` behave as the tests in steps 1-2 state.
- AC2. `HOLD_GUIDANCE` ends with the tested sentence, and `SERVER_INSTRUCTIONS` passes the existing length test.
- AC3. Claude Code's `hooks.json` registers `ledger_list.mjs` for `startup|resume|clear|compact`; Codex's `hold_guidance.mjs` prints the guidance followed by the list.
- AC4. The hooks add nothing (Claude) or only the guidance (Codex) when the ledger is missing or unreadable, the input has no `cwd`, or the project has no held or dropped items, and exit 0.
- AC5. `npm run typecheck`, `npm test` and `node test/scripts/plugin-smoke.mjs` pass after `npm run build`.

Scenarios, run from the repository root after `npm run build`. Each one makes its own temporary folder.

S1. The Claude Code hook lists one project's items:

```sh
T=$(mktemp -d)
printf '%s\n' \
 '{"id":"a1b2c3d4","ts":"2026-11-05T01:00:00.000Z","project_id":"-work-app","session_id":null,"status":"held","item":"Add rm","words":"later"}' \
 '{"id":"c9d0e1f2","ts":"2026-11-05T02:00:00.000Z","project_id":"-work-app","session_id":null,"status":"dropped","item":"Use SQLite","words":"no need"}' \
 '{"id":"e5f6a7b8","ts":"2026-11-05T03:00:00.000Z","project_id":"-other","session_id":null,"status":"held","item":"Other project","words":"x"}' \
 > $T/ledger.jsonl
echo '{"source":"startup","cwd":"/work/app"}' | CLENS_INDEX_DIR=$T node plugin/hooks/ledger_list.mjs \
 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s).hookSpecificOutput;console.log(o.hookEventName);console.log(o.additionalContext)})'
```

Expected output:

```
SessionStart
clens ledger for this project, from earlier sessions (ids for clens_hold; full list with clens_pending):
held:
- a1b2c3d4  Add rm  (words: "later")
dropped:
- c9d0e1f2  Use SQLite  (words: "no need")
```

S2. A done item leaves the list. Continue in the same shell:

```sh
echo '{"id":"a1b2c3d4","ts":"2026-11-05T04:00:00.000Z","project_id":"-work-app","session_id":null,"status":"done"}' >> $T/ledger.jsonl
echo '{"source":"compact","cwd":"/work/app"}' | CLENS_INDEX_DIR=$T node plugin/hooks/ledger_list.mjs \
 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).hookSpecificOutput.additionalContext))'
```

Expected output:

```
clens ledger for this project, from earlier sessions (ids for clens_hold; full list with clens_pending):
dropped:
- c9d0e1f2  Use SQLite  (words: "no need")
```

S3. Nothing to add. Continue in the same shell:

```sh
out=$(echo '{"source":"startup","cwd":"/nowhere"}' | CLENS_INDEX_DIR=$T node plugin/hooks/ledger_list.mjs); echo "exit $? chars ${#out}"
out=$(echo 'not json' | CLENS_INDEX_DIR=$T node plugin/hooks/ledger_list.mjs); echo "exit $? chars ${#out}"
```

Expected output:

```
exit 0 chars 0
exit 0 chars 0
```

S4. The Codex hook prints the guidance, then the list. Continue in the same shell:

```sh
echo '{"source":"startup","cwd":"/work/app"}' | CLENS_INDEX_DIR=$T node plugin/hooks/hold_guidance.mjs \
 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).hookSpecificOutput.additionalContext;console.log(c.startsWith("LEDGER: clens also keeps a ledger"));console.log(c.split("\n\n").pop())})'
echo '{"source":"startup"}' | CLENS_INDEX_DIR=$T node plugin/hooks/hold_guidance.mjs \
 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).hookSpecificOutput.additionalContext.includes("clens ledger for this project")))'
```

Expected output:

```
true
clens ledger for this project, from earlier sessions (ids for clens_hold; full list with clens_pending):
dropped:
- c9d0e1f2  Use SQLite  (words: "no need")
false
```

## Known Limits

- The agent decides whether finished work is a listed item. The experiments ran each Claude scene twice and each Codex scene once (R1-R15), all as expected; in real use it can still miss an item, for instance when the request is worded far from the item. The user can then mark it done through `/clens:pending`.
- The list is found by `cwd`. A session started in a subdirectory, or an item an agent recorded under a different `project_id` form, is not listed; `clens_pending` still shows it. Windows paths (backslashes) were not checked: the hook replaces only `/`, as the tool descriptions tell the agent to.
- Claude Code releases that cut server instructions at 2,048 characters lose `HOLD_GUIDANCE`, so the agent sees the list without the sentence that says to mark items done.
- Each `claude -p --resume` fires `resume` again (E1), so a session resumed many times holds one copy of the list per resume.
- After a compaction or resume, the list also holds items recorded earlier in the same session, though its first line says "from earlier sessions"; this is the wording tested in R11.
- Codex's internal sessions (E3: `cwd` `~/.codex/memories`) get the guidance as today and no list, since no item belongs to that folder.
- The `clear` source was not run in either tool.

## Open Questions

None.

## Goals Check

- G1. Met: `ledger_list.mjs` in Claude Code and `hold_guidance.mjs` in Codex, both on `startup|resume|clear|compact`, with `cwd` given in every source checked (K1, K3); the agent behavior rests on R1-R15.
- G2. Met: the new last sentence of `HOLD_GUIDANCE` (tested in R1-R15), and the `HOLD_DESCRIPTION` id note.
- G3. Met: 10 held, 5 dropped, 6,000 characters, with "+N more … clens_pending" lines; R10 shows the agent follows them.
- G4. Met: `ledgerContext` returns `null` for each of those cases, and the hooks then add nothing or only the guidance and exit 0 (steps 2 and 5, S3).

```skerry
{"run": "20261105-234433-a4c1", "verify": ["npm run typecheck", "npm test", "node test/scripts/plugin-smoke.mjs"], "extras": []}
```
