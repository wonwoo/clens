# Hold Ledger Design

## Context

Users set work aside in conversation all the time ("일단 2번은 다시 생각해보고", "백로그에 남겨", "패스", "let's park it") and lose track of it across sessions. On 2026-11-04 the author asked "다음 아이디어 뭐뭐 있었냐" and the answer had to be dug out of old sessions by hand, and an idea set aside earlier (Cursor support) was missed until the user named it.

A previous design on the same day (`docs/2026-11-04-pending-ledger-design.md`, never committed) built `/clens:pending` as a scan: page through every user message of a period with a new `brief` mode of `clens_recent` and judge each one. A test run on the author's index found the items but stored nothing: each call re-reads the whole period (about 39 KB, 487 messages for 14 days), results can differ between runs, and an item older than the period drops out. The user then decided (this conversation, 2026-11-04):

- D1. Record at the moment of the decision: when the user sets something aside, the agent in that conversation, which knows what was meant, records it through an MCP tool. Recognition is by meaning, in any language, best effort ("못잡는건 어절수 없지만 최대한 많이 잡아보자").
- D2. `/clens:pending` is for lookup only: it shows what was recorded. It does not scan transcripts.
- D3. Store the ledger in a file, not in the index database.
- D4. Drop the scan: the uncommitted `brief` mode of `clens_recent`, its tests and the scanning skill are removed.
- D5. Wrongly recorded items are fixed at lookup: the user says an item is wrong and the agent removes it (the user asked whether false positives show up; they do, with the user's own words beside them, so they are easy to spot).

Goal and success criteria:

- G1. In Claude Code and in Codex, an agent records a held or dropped item without being asked, in Korean and English conversations (measured: R1, R9, R5, R10).
- G2. Routine holds (commit, push, "잠시 대기"), questions and plain approval are not recorded.
- G3. `/clens:pending` lists the ledger of the current project grouped by status, with each item's words, date and session, and lets the user mark an item done, held, dropped or removed.
- G4. The index stays read-only for the MCP server (`AGENTS.md`, Architecture); the ledger survives an index rebuild.
- G5. Nothing of the `brief` scan remains in the code.

Out of scope: building the ledger from past transcripts (no backfill), pruning the ledger, other clients than Claude Code and Codex, a second session noticing on its own that an item from another session was done.

## Checked Behavior

Experiments are in `docs/experiments/2026-11-04-hold-ledger/` (results table in `results.md`, never committed, like every `docs/experiments/` folder in this repository). The scenes are in `scenes.tsv`: a two-turn conversation in a scratch repository (`base/`, a 10-line todo CLI). Turn one asks for three numbered ideas (IDEAS), one feature explanation (ONE) or one README edit (EDIT); turn two is the user's line under test. Each run uses a stand-in MCP server (`server.mjs`, `server-final.mjs`) with one tool, `clens_hold`, that appends its arguments to a log.

| # | Behavior relied on | How checked | Result |
|---|---|---|---|
| B1 | Claude Code shows MCP server instructions to the model; a deferred MCP tool is loaded with ToolSearch when the instructions name it | R1: `claude -p` 2.1.318 runs, transcripts show `ToolSearch select:mcp__clens__clens_hold` then the call | holds |
| B2 | Claude Code 2.1.318 cuts server instructions and each tool description at `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`, default 4,096 characters, and logs "Server instructions truncated from N to M chars" | R7: strings of `~/.local/share/claude/versions/2.1.318`: `function y1(e=!1){return i.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??(e?mDi:Wbr)}`, `Wbr=4096`, `mDi=16384` | holds for 2.1.318; the 2,048 in `src/mcp/instructions.ts:9-12` and `AGENTS.md` came from an earlier release (not re-checked which) |
| B3 | Codex 0.165.0 does not give MCP server instructions to the model | R3: a secret word only in the stand-in server's instructions; `codex exec` answers UNKNOWN; the tool itself is callable by name | holds |
| B4 | Codex runs a SessionStart hook on `startup` and on `resume` and gives its `hookSpecificOutput.additionalContext` to the model; its `source` is one of startup, resume, clear, compact, fork; a matcher `startup\|resume\|clear` fires on startup and resume | R6 (secret word reached the model, source startup); R5 transcripts show the hook on `codex exec` and `codex exec resume`; the enum is in the codex binary's hook schema | holds; clear and compact matching not run |
| B5 | A Codex hook runs only after the user trusts it (`/hooks`); an untrusted session-flag hook is skipped | R6: without `--dangerously-bypass-hook-trust` the hook output never reached the model | holds; README already tells Codex users to trust clens's hooks |
| B6 | Codex asks approval for an MCP tool call unless the server's `default_tools_approval_mode` is `approve`; clens's Codex manifest sets it (`plugin/.codex-plugin/mcp.json`) | R11: with `workspace-write` and approval `never`, the call failed with "MCP tool call requires approval, but approval policy is never"; with `default_tools_approval_mode="approve"` it ran | holds |
| B7 | Without guidance in context, Codex never calls the tool from its description alone | R2: 10 runs of held/dropped scenes, 0 calls; for "할일에 기록만해놔" it wrote `TODO.md` | holds |
| B8 | With the guidance in context the agents record held and dropped items, by meaning, in Korean and English, and skip routine holds and questions | R1, R4, R5, R9, R10 | see the table in Acceptance |
| B9 | Appending one JSON line per `appendFileSync` call from several processes to one file leaves every line whole | R8: 8 processes × 2,000 lines of 3,024 bytes, and 8 × 500 lines of 12,024 bytes, on macOS APFS: all lines parse, none lost | holds on macOS; Linux and Windows not run |
| B10 | The MCP server learns the calling session per request: `codexSessionFromMeta(req.params._meta) ?? detectCurrentSessionId(process.ppid, process.env)` | `src/mcp/server.ts:364` at `HEAD` (372 in the working tree before step 1), `src/mcp/current_session.ts` | may be undefined; the ledger then stores `null` |
| B11 | Every path under `~/.clens` comes from `clensHome()`, which tests point at a temporary folder with `CLENS_INDEX_DIR` | `src/util/paths.ts:24-32` (`clensHome()`) | holds |
| B12 | `npm run build` bundles each entry listed in `scripts/build.mjs`; hooks live in `plugin/hooks/*.mjs`; Codex's hooks come from `plugin/.codex-plugin/hooks.json` with `${PLUGIN_ROOT}` | `scripts/build.mjs:23-27`, `plugin/.codex-plugin/hooks.json` | holds |
| B13 | The uncommitted changes in the working tree are only the previous run's `brief` scan: `README.md`, `README.ko.md`, `plugin/dist/server.js`, `src/mcp/recent.ts`, `src/mcp/server.ts`, `test/mcp_recent.spec.ts`, `test/scripts/plugin-smoke.mjs` modified; `docs/2026-11-04-pending-ledger-design.md`, `plugin/skills/pending/`, `docs/experiments/` untracked | `git diff HEAD --stat`, `git status --short` at the start of this run | holds |
| B14 | `codex exec` adds a `[projects."<dir>"]` trust entry to `~/.codex/config.toml` for each new working folder | R12: entries for every scratch folder appeared | holds; the experiment's entries were removed afterwards (results.md) |

Not checked: Codex keeping or losing hook context across its own compaction (the hook also runs on `compact`, so the guidance comes back either way); whether Claude Code asks the user's permission on the first `clens_hold` call (it treats it like the other clens tools, which carry no annotations either); appends on Linux and Windows.

## Design

### Architecture

```
agent ──clens_hold──▶ MCP server ──appendLedgerEvent──▶ ~/.clens/ledger.jsonl
agent ──clens_pending─▶ MCP server ──readLedger──────────┘
guidance: Claude Code ← SERVER_INSTRUCTIONS (last paragraph)
          Codex       ← SessionStart hook hold_guidance.mjs (startup|resume|clear|compact)
user ──/clens:pending──▶ skill ──clens_pending / clens_hold (id)──▶ same tools
```

- `src/mcp/ledger.ts` (new) owns the file: its line format, folding events into items, validating a `clens_hold` call and formatting `clens_pending`. It imports only `node:fs`, `node:crypto`, `node:path`. It never touches the index.
- `src/mcp/server.ts` registers the two tools and passes them the ledger path and the calling session.
- `src/mcp/instructions.ts` owns every text the agent reads: `HOLD_GUIDANCE`, `SERVER_INSTRUCTIONS`, `HOLD_DESCRIPTION`, `PENDING_DESCRIPTION`.
- `src/hooks/hold_guidance.ts` (new) prints `HOLD_GUIDANCE` as a SessionStart hook output. Only Codex registers it (B3); Claude Code reads the same text from the server instructions (B1).
- The ledger is a separate file because the MCP server opens the index read-only and only the watcher writes it, and a `SCHEMA_VERSION` bump rebuilds the index from transcripts, which cannot rebuild an agent's judgement (G4, D3). One file for every project keeps the path fixed; each event names its project.

### Data model: `~/.clens/ledger.jsonl`

One JSON object per line, appended, never rewritten. Each line is an event:

```ts
export const HOLD_STATUSES = ["held", "dropped", "done", "removed"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export interface LedgerEvent {
  id: string;                // 8 lowercase hex characters, /^[0-9a-f]{8}$/
  ts: string;                // new Date().toISOString() on the server
  project_id: string;
  session_id: string | null; // calling session, null when unknown (B10)
  status: HoldStatus;
  item?: string;             // only on the event that creates the item
  words?: string;
  waits_for?: string;
}

export interface LedgerItem {
  id: string;
  project_id: string;
  item: string;
  status: HoldStatus;
  words: string;             // latest words given
  waits_for: string | null;  // latest waits_for given
  session_id: string | null; // session of the creating event
  created: string;           // ts of the creating event
  updated: string;           // ts of the latest event
}
```

Folding (`readLedger`), in file order:

- A line is readable when it parses as a JSON object (not an array or null) in which: `id` is a string matching `/^[0-9a-f]{8}$/`; `ts` and `project_id` are strings; the key `session_id` is present with a string or `null`; `status` is one of `HOLD_STATUSES`; and each of `item`, `words` and `waits_for` is either absent or a string. Other keys are ignored. Any other line is skipped: an empty line (after trimming whitespace) silently, every other skipped line counted as unreadable.
- A readable event whose `id` is new and that has both `item` and `words` creates the item: `status`, `words`, `waits_for ?? null`, `session_id`, `created = updated = ts`.
- A readable event whose `id` is new but lacks `item` or `words` is counted as unreadable and changes nothing.
- A readable event whose `id` is known updates it: `status`, `updated = ts`, `words` when present, `waits_for` when present. Its `item`, `project_id` and `session_id` are ignored.
- Items whose final status is `removed` stay in the fold (so they can be changed back) but `clens_pending` leaves them out.

Invariants: an item's `id`, `project_id`, `item`, `session_id` and `created` never change after its first event; the file only grows.

### Interfaces: `src/mcp/ledger.ts`

```ts
export function appendLedgerEvent(path: string, event: LedgerEvent): void;
```
Creates the parent folder (`mkdirSync(dirname(path), { recursive: true })`). When the file exists, is not empty and its last byte is not `\n` (a write cut off earlier), it writes `\n` before the line, so the new line does not join the broken one. It writes `JSON.stringify(event) + "\n"` with one `appendFileSync` call (B9). Errors (permissions, disk full) propagate.

```ts
export function readLedger(path: string): { items: LedgerItem[]; unreadable: number };
```
A missing file gives `{ items: [], unreadable: 0 }`. Other read errors propagate. `items` includes removed items, in creation order.

```ts
export interface HoldParams {
  project_id: string;
  id?: string;
  item?: string;
  status: HoldStatus;
  words?: string;
  waits_for?: string;
}
export type HoldResult = { ok: true; text: string } | { ok: false; error: string };
export function recordHold(
  path: string,
  params: HoldParams,
  ctx: { sessionId: string | undefined; now: Date; newId?: () => string },
): HoldResult;
```
`newId` defaults to `() => randomBytes(4).toString("hex")`. Rules, checked in this order:

1. With `id` and `item`: error `item cannot change; record a new item instead`.
2. With `id`: the id must be an item in `readLedger(path).items` (removed ones included), else error `no item <id> in the ledger`; its `project_id` must equal `params.project_id`, else error `item <id> belongs to project <its project_id>, not <params.project_id>`. Then append `{ id, ts, project_id, session_id, status, words?, waits_for? }` and return `Changed <id> to <status>: <item>`.
3. Without `id`: `status` must be `held` or `dropped`, else error `a new item is held or dropped; pass the id of a recorded item to mark it done or removed`; `item` and `words` must both be given, else error `item and words are needed to record a new item`. Draw ids from `newId` until one is not among the existing ids, at most 10 draws, else error `could not pick a new id`. Append `{ id, ts, project_id, session_id, status, item, words, waits_for? }` and return `Recorded <id> as <status>: <item>`.

`ts` is `ctx.now.toISOString()`; `session_id` is `ctx.sessionId ?? null`. Keys with an undefined value are left out of the written line.

```ts
export const DEFAULT_PENDING_MAX_BYTES = 16384;
export function formatPending(
  ledger: { items: LedgerItem[]; unreadable: number },
  params: { project_id?: string; maxBytes?: number },
): string;
```
Lines joined with `\n`:

1. Items kept: not `removed`, and `project_id` equal to `params.project_id` when it is given.
2. No items kept: the text is `Nothing in the ledger for <project_id>.` (or `Nothing in the ledger.` without `project_id`), followed by the unreadable line of rule 6 when `unreadable > 0`.
3. Header: `Ledger for <project_id>: <h> held, <d> dropped, <n> done` (or `Ledger for every project: …`), counting all kept items.
4. Groups in the order `held`, `dropped`, `done`, each only when not empty: a line `<status>:`, then per item, newest `updated` first and `id` ascending on a tie, two lines:
   - `- <id>  <created>  <item>` (two spaces between fields)
   - `  words: "<words>"` followed, each only when it applies, by `; waits for: <waits_for>`, `; changed: <updated>` (when `updated !== created`), then always `; session: <session_id or unknown>`, then `; project: <project_id>` when `params.project_id` is not given.
5. Byte cap `cap = params.maxBytes ?? DEFAULT_PENDING_MAX_BYTES`, every size measured with `Buffer.byteLength(…, "utf8")` over the lines joined with `\n`: the header is always written. Before each item, take its two lines, with its group's `<status>:` line in front when it is the first item of its group. If the text so far plus those lines plus a reserve would pass `cap`, write no more items and add the line `(+<k> more items not shown)`, `k` being the kept items not written. The reserve is 64 bytes, plus the bytes of the unreadable line of rule 6 and one newline when `unreadable > 0`. A group line is never written without its first item.
6. When `unreadable > 0`, the last line is `(<unreadable> unreadable lines in the ledger file were skipped)`.

### Interfaces: tools in `src/mcp/server.ts`

```ts
const HoldParamsSchema = z.strictObject({
  project_id: z.string().min(1),
  id: z.string().regex(/^[0-9a-f]{8}$/).optional(),
  item: z.string().min(1).max(300).optional(),
  status: z.enum(HOLD_STATUSES),
  words: z.string().min(1).max(500).optional(),
  waits_for: z.string().min(1).max(200).optional(),
});
const PendingParamsSchema = z.strictObject({
  project_id: z.string().min(1).optional(),
  maxBytes: z.number().int().min(256).max(1_000_000).optional(),
});
```

- `clens_hold`, description `HOLD_DESCRIPTION`; input schema (written by hand like the other tools' in `ListTools`) with required `["project_id", "status"]` and these properties and descriptions:
  - `project_id` (string): "The working directory path with every slash replaced by a dash."
  - `id` (string): "An item's id from clens_pending or an earlier clens_hold, to change that item."
  - `item` (string): "What was set aside, in one line that makes sense without this conversation. New items only."
  - `status` (string, enum `HOLD_STATUSES`): "held or dropped for a new item; done, held, dropped or removed for an item passed by id."
  - `words` (string): "The user's own words that set it aside or changed it, quoted."
  - `waits_for` (string): "What a held item waits for, when the user said so."

  Handler: parse (failure → `Invalid params: <zod message>`, `isError: true`); `recordHold(ledgerPath(), data, { sessionId: currentSessionId, now: new Date() })`; `ok` → the text; not ok → the error text with `isError: true`; a thrown error → `Ledger error: <message>` with `isError: true`.
- `clens_pending`, description `PENDING_DESCRIPTION`; no required property; `project_id` (string): "A working directory path with every slash replaced by a dash; omit it for every project."; `maxBytes` (number): "Cap on the answer's size in bytes (default 16384)." Handler: parse; `formatPending(readLedger(ledgerPath()), data)`; a thrown error → `Ledger error: <message>`.
- The file header comment's tool list gains both tools.

`src/util/paths.ts` gains:

```ts
/** The ledger of what users set aside (src/mcp/ledger.ts): one JSON event per line. */
export function ledgerPath(): string { return join(clensHome(), "ledger.jsonl"); }
```

### Texts in `src/mcp/instructions.ts`

`HOLD_GUIDANCE` is exactly this text (no trailing newline; it is the `final-guidance.txt` of R9 and R10):

```
LEDGER: clens also keeps a ledger of what the user sets aside, so held work is not forgotten and dropped ideas are not proposed again. Record it without being asked: when the user decides that something proposed or discussed will not be done now, call clens_hold once per item, then go on with the request.
- held: kept for later, to think about, to wait for something, to do after other work ("나중에", "일단 대기", "다시 생각해볼게", "백로그에 남겨", "let's park it")
- dropped: will not be done ("패스", "안 해도 돼", "필요 없음", "isn't worth it")
Judge by meaning in any language, not by these words. Not for: waiting on a step of the current task ("재시작할게 대기"), holding back a routine step (commit, push, deploy), questions, or picking one option (the others are not set aside unless the user says so).
When you finish an item clens_pending listed as held, record it done with its id.
```

`SERVER_INSTRUCTIONS` becomes the current text unchanged (2,044 characters), then `\n\n`, then `HOLD_GUIDANCE`: 2,905 characters (measured, R9). A client that cuts at 2,048 characters keeps everything it has today and loses only the ledger paragraph (B2). The header comment of the file is rewritten to say: Claude Code 2.1.318 cuts server instructions and each tool description at 4,096 characters, older releases at 2,048; what every client must see stays in the first 2,048 characters, and the ledger paragraph comes last.

`HOLD_DESCRIPTION`:

```
Record in clens's ledger an item the user set aside in this conversation, or change one recorded earlier. Call it when the user decides that something proposed or discussed will not be done now, once per item, then go on with the request.

New item: pass project_id, item (what was set aside, in one line that makes sense without this conversation), status held (kept for later) or dropped (will not be done), words (the user's own words that set it aside, quoted) and, for a held item, waits_for when the user said what it waits for.

Change an item: pass project_id, its id (from clens_pending or an earlier clens_hold) and status: done when it was just done, held or dropped when the user changed their mind, removed when it should not have been recorded. words and waits_for are optional then; item cannot change.

project_id is the working directory path with every slash replaced by a dash.
```

`PENDING_DESCRIPTION`:

```
List clens's ledger: what the user set aside in conversations, recorded with clens_hold. Pass project_id (the working directory path with every slash replaced by a dash) for one project; omit it for every project. Items are grouped as held, dropped and done, newest first, each with its id, date, item, the user's words, what it waits for and the session that recorded it. Items marked removed are left out. The ledger holds only what agents recorded since this version of clens was installed; it is not built from past transcripts.
```

### Codex hook

`src/hooks/hold_guidance.ts` reads stdin to its end, ignores it, and writes `JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: HOLD_GUIDANCE } })`. It needs no index and no dependency. `scripts/build.mjs` builds it to `plugin/hooks/hold_guidance.mjs`. `plugin/.codex-plugin/hooks.json` gets a second `SessionStart` entry after the compact one:

```json
{
  "matcher": "startup|resume|clear|compact",
  "hooks": [
    { "type": "command", "command": "node \"${PLUGIN_ROOT}/hooks/hold_guidance.mjs\"", "timeout": 10 }
  ]
}
```

and its `description` gains the sentence `At the start of a session, tell the agent to record in clens's ledger what the user sets aside.` `plugin/hooks/hooks.json` (Claude Code) is not changed.

### Skill: `plugin/skills/pending/SKILL.md` (rewritten)

Frontmatter: `name: pending`; `description`: what the user set aside in this project, from clens's ledger (`clens_pending`), each item with what it was, the user's words, when, and its state; use when the user asks what was left for later, held, parked or dropped ("what did we leave for later", "남은 거 뭐 있었지", "다음 아이디어 뭐뭐 있었냐", "미뤄 둔 거", "보류한 거"), in any language; not for where the latest session stopped (recap) or one past topic (clens_search). `when_to_use`: when the user wants the list of things set aside, or to mark one done or wrong. No `argument-hint`.

Steps:

1. `project_id` is the working directory with every `/` replaced by `-`. Call `clens_pending` with it (load the tool with ToolSearch when it is deferred).
2. Show the result in the user's language: the header counts, then held items, dropped items, done items; each with its item, its local date, the user's words quoted, the first 8 characters of its session, what it waits for when set, and its id. Leave out empty groups. Say when the answer ended with `(+N more items not shown)` or an unreadable-lines line.
3. When the result is `Nothing in the ledger for …`, say so, and say that the ledger fills as items are set aside in conversations from now on; do not search transcripts instead.
4. When the user says an item was done, is wrong, or is held or dropped after all, call `clens_hold` with `project_id`, its `id` and `status` `done`, `removed`, `held` or `dropped`, and the user's words as `words`. Confirm with the tool's answer.
5. Write nothing to files unless the user asks; then write the same content as Markdown to the path they give.

Limits section: only what an agent recorded is listed; a decision the agent did not recognise (agreement-like wording such as "어쩔수 없는거 아니냐") is missing; items from sessions before this version are not there.

### Removing the scan (D4)

Restore to `HEAD` the files the previous run changed (B13): `git checkout HEAD -- README.md README.ko.md plugin/dist/server.js src/mcp/recent.ts src/mcp/server.ts test/mcp_recent.spec.ts test/scripts/plugin-smoke.mjs`, and delete `docs/2026-11-04-pending-ledger-design.md`. `plugin/skills/pending/SKILL.md` is replaced by the new skill. `docs/experiments/2026-11-04-pending-ledger/` stays as it is (local, never committed).

### Documentation

- `README.md`, `README.ko.md`:
  - "What it does" list (after the `/clens:reflect` bullet): one bullet saying that when you put something off or drop it in a conversation the agent records it, and `/clens:pending` lists it later with your words (Korean: the same meaning).
  - "Skills": a `/clens:pending` paragraph after the `/clens:reflect` one: lists what you set aside in this project, held, dropped and done, each with your words and date; say an item is done or wrong and it is updated; the ledger fills from conversations held after installing this version and is kept in `~/.clens/ledger.jsonl`.
  - "How it works": "through five MCP tools" becomes seven (Korean: "MCP 도구 다섯 개" → "일곱 개"), and two table rows: `clens_hold` "Records what you put off or dropped" / "미루거나 버린 일을 장부에 적습니다"; `clens_pending` "Lists that ledger" / "그 장부를 보여 줍니다". After the table's hook paragraph: the agent writes the ledger to `~/.clens/ledger.jsonl`, apart from the index; in Codex a session-start hook (`hooks/hold_guidance.mjs`) tells the agent to record, since Codex does not pass server instructions to the model.
  - Codex install note: trusting clens's hooks also turns on the ledger recording.
  - "Limits": the agent records what it recognises as set aside; agreement-like wording can be missed; in Codex nothing is recorded until the hooks are trusted.
  - "Development": the hook sentence names `plugin/hooks/hold_guidance.mjs`, built from `src/hooks/hold_guidance.ts`, registered for Codex only.
- `AGENTS.md`: the instructions bullet (line 35) says Claude Code 2.1.318 cuts server instructions and each tool description at 4,096 characters and older releases at 2,048, so what every client needs stays in the first 2,048 characters of `SERVER_INSTRUCTIONS` and the ledger paragraph comes last, guarded by `mcp_instructions.spec.ts`. The first Architecture bullet adds: `clens_hold` appends to `~/.clens/ledger.jsonl` (`src/mcp/ledger.ts`), a file apart from the index, which a rebuild never touches.

## Assumptions To Check

- A1. With `HOLD_GUIDANCE` after the current 2,044 characters of server instructions, Claude Code still loads and calls `clens_hold` (R9 measured it with this exact text appended; re-run `run5.sh` against the built server if the text changes).
- A2. Codex 0.165.0 runs `plugin/hooks/hold_guidance.mjs` from the plugin's `hooks.json` once the user trusts it, with `${PLUGIN_ROOT}` resolved, as it does for `compact.mjs` (R5 ran the same text from a session-flag hook, not from the plugin).
- A3. Appends from several MCP servers do not interleave (R8, macOS).

## Implementation Order

Each step starts with its failing test where it has one. Check after every step: `npm run typecheck` and the named tests.

1. **Remove the scan.** Run the `git checkout` and delete of "Removing the scan". Check: `git diff --quiet HEAD -- src test README.md README.ko.md plugin/dist` exits 0; `npm test` passes (the base suite).
2. **Ledger file.** `src/util/paths.ts` `ledgerPath()`; `src/mcp/ledger.ts` with `HOLD_STATUSES`, `HoldStatus`, `LedgerEvent`, `LedgerItem`, `appendLedgerEvent`, `readLedger`, `HoldParams`, `HoldResult`, `recordHold`, `DEFAULT_PENDING_MAX_BYTES`, `formatPending`. Tests in `test/mcp_ledger.spec.ts`, each in its own temporary folder (`mkdtempSync(join(tmpdir(), "clens-ledger-"))`, removed in `afterEach`):
   - T1 `appendLedgerEvent` creates the missing folder and writes one line that parses back to the event.
   - T2 a file whose last byte is not `\n` (write `{"id":"broken` by hand) gets `\n` before the next line; `readLedger` returns the new item and `unreadable: 1`.
   - T3 `readLedger` on a missing file returns `{ items: [], unreadable: 0 }`.
   - T4 folding: create then update with status done and new words gives status done, the new words, `created` of the first, `updated` of the second; an update's `item` and `project_id` are ignored.
   - T5 each of these lines counts as unreadable and changes nothing: not JSON; a JSON array; an unknown status; a bad id; no `session_id` key; `waits_for` a number; a new id without `words`. A whitespace-only line does not count.
   - T6 `recordHold` new held item: text `Recorded <id> as held: <item>`, one line with `session_id` from ctx, `null` when ctx has none, and no `waits_for` key when not given.
   - T7 `recordHold` errors, one each: id with item; unknown id; id of another project; new item with status done; new item without words. None writes a line.
   - T8 `recordHold` update: `Changed <id> to done: <item>`; then status removed and back to held works.
   - T9 id collision: `newId` returning an existing id first and a new one second records the new one; one that always returns an existing id gives `could not pick a new id`.
   - T10 `formatPending`: header counts; group order held, dropped, done; newest first; `; changed:` only when updated; `; project:` only without `project_id`; removed left out; another project left out; `Nothing in the ledger for -p.`; the unreadable line; a small `maxBytes` gives the header, some items and `(+k more items not shown)` with the right `k`.
   Check: `npx vitest run test/mcp_ledger.spec.ts`.
3. **Texts.** `src/mcp/instructions.ts`: `HOLD_GUIDANCE`, `SERVER_INSTRUCTIONS` as designed, `HOLD_DESCRIPTION`, `PENDING_DESCRIPTION`, header comment. `test/mcp_instructions.spec.ts`: replace the first test with: `SERVER_INSTRUCTIONS.length <= 4096`; `SERVER_INSTRUCTIONS.endsWith("\n\n" + HOLD_GUIDANCE)`; `SERVER_INSTRUCTIONS.length - HOLD_GUIDANCE.length - 2 <= 2048`; `SEARCH_DESCRIPTION`, `STATS_DESCRIPTION`, `HOLD_DESCRIPTION`, `PENDING_DESCRIPTION` each `<= 2048`. Add: `HOLD_GUIDANCE` contains `call clens_hold once per item` and `picking one option`. Keep the other tests. Check: `npx vitest run test/mcp_instructions.spec.ts`.
4. **Tools.** `src/mcp/server.ts`: schemas, the two `ListTools` entries, the two handlers, header comment. Check: `npm run typecheck`, `npm test`.
5. **Codex hook.** `src/hooks/hold_guidance.ts`; `scripts/build.mjs` entry `src/hooks/hold_guidance.ts` → `plugin/hooks/hold_guidance.mjs`; `plugin/.codex-plugin/hooks.json` entry and description. Check: `npm run build`, then `echo '{"source":"startup"}' | node plugin/hooks/hold_guidance.mjs` prints JSON whose `hookSpecificOutput.additionalContext` equals `HOLD_GUIDANCE`.
6. **Skill.** Rewrite `plugin/skills/pending/SKILL.md` as designed. Check: it names only `clens_pending` and `clens_hold` among tools and contains no `clens_recent` or `brief`.
7. **Smoke.** `test/scripts/plugin-smoke.mjs`: the tools check expects `clens_hold,clens_left_off,clens_pending,clens_recent,clens_search,clens_session,clens_stats`; a check `hold and pending` calls `clens_hold` `{ project_id: "-fixture-cwd", item: "Add a due date to tasks", status: "held", words: "let's park it" }` (text starts with `Recorded `), then `clens_pending` `{ project_id: "-fixture-cwd" }`, whose text contains `Ledger for -fixture-cwd: 1 held, 0 dropped, 0 done`, `Add a due date to tasks` and `words: "let's park it"`; a check `hold guidance hook` runs `node <plugin>/hooks/hold_guidance.mjs` with input `{"source":"startup"}` and expects `"hookEventName":"SessionStart"` and `call clens_hold` in the output. Extend the header comment's list. Check: `npm run build && node test/scripts/plugin-smoke.mjs`.
8. **Documentation.** `README.md`, `README.ko.md`, `AGENTS.md` as designed. Check: `grep -c "clens_hold\|clens_pending" README.md README.ko.md` prints at least 2 for each file; `npm test`.

## Acceptance

- AC1. `npx vitest run test/mcp_ledger.spec.ts test/mcp_instructions.spec.ts` passes (T1–T10 and the text tests).
- AC2. `npm run typecheck` and `npm test` exit 0.
- AC3. `npm run build && node test/scripts/plugin-smoke.mjs` exits 0 and prints `PASS tools`, `PASS hold and pending` and `PASS hold guidance hook` among its lines.
- AC4. No scan remains: `grep -c "brief" src/mcp/recent.ts src/mcp/server.ts` prints `src/mcp/recent.ts:0` and `src/mcp/server.ts:0`; `git diff --quiet HEAD -- src/mcp/recent.ts test/mcp_recent.spec.ts` exits 0; `docs/2026-11-04-pending-ledger-design.md` does not exist.
- AC5. `plugin/skills/pending/SKILL.md` has `name: pending`, uses only `clens_pending` and `clens_hold`, and mentions neither `clens_recent` nor `brief`.

Scenarios (run from the repository root; output as printed to a pipe):

1. Record and list through the built server. `npm run build && node test/scripts/plugin-smoke.mjs` prints, among others:
   ```
   PASS tools
   PASS hold and pending
   PASS hold guidance hook
   ```
   and exits 0.
2. Codex hook output. After `npm run build`, `echo '{"source":"startup"}' | node plugin/hooks/hold_guidance.mjs | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s).hookSpecificOutput;console.log(o.hookEventName, o.additionalContext.startsWith("LEDGER: clens also keeps a ledger"))})'` prints:
   ```
   SessionStart true
   ```
3. Instruction length. `npx tsx -e 'import {SERVER_INSTRUCTIONS as S, HOLD_GUIDANCE as G} from "./src/mcp/instructions.ts"; console.log(S.length, S.length - G.length - 2)'` prints `2905 2044`.

Measured agent behavior (the reason for the design, not a gate; runs cost money and vary). Scenes and scripts in `docs/experiments/2026-11-04-hold-ledger/`; "set aside" counts the runs whose recorded items and statuses matched the user's line, "wrong" the runs that recorded something the line did not set aside.

| # | Client, guidance | Set-aside scenes | Other scenes |
|---|---|---|---|
| R1 | Claude Code, guidance as the whole server instructions (`server.mjs`) | 20 of 22 (P4 "3번은 음 어쩔수 없는거 아니냐" missed twice) | 1 wrong of 16 ("go with #1" recorded #2 and #3 as held) |
| R2 | Codex, tool description only | 0 of 10 | 0 of 4 |
| R4 | Codex, guidance in the repository's AGENTS.md | 10 of 10 | 0 of 6 |
| R5 | Codex, guidance from a SessionStart hook | 10 of 10 | 1 wrong of 6 ("go with #1") |
| R9 | Claude Code, `HOLD_GUIDANCE` after the current instructions | 8 of 10 (P4 missed twice) | 0 of 5 (F3 "go with #1" ×3, N3 "1번 진행해" ×2) |
| R10 | Codex, `HOLD_GUIDANCE` from a SessionStart hook | 4 of 4 (P1 ×2, E1 ×2) | 0 of 4 (F3 ×3, N3 ×1) |

## Known Limits

- The ledger has only what an agent recognised and recorded. Agreement-like wording ("3번은 음 어쩔수 없는거 아니냐") was missed in every run (R1, R9). The user sees nothing for such an item.
- No backfill: decisions made before this version is installed are not in the ledger, and `/clens:pending` says so instead of searching.
- Codex records nothing until the user trusts clens's hooks in `/hooks` (B5, R2). Updating the plugin adds a new hook, which Codex may ask to trust again.
- A Claude Code release that cuts server instructions at 2,048 characters drops the ledger paragraph; the tools still work when called.
- A false record (R1, R5: one each) shows up in `/clens:pending` with the words that triggered it; the user removes it there (D5).
- `project_id` comes from the agent, as for every clens tool; a wrong one files the item under another project.
- Concurrent appends were checked on macOS only (R8).
- The ledger is never pruned; at a few hundred bytes per event it stays small.
- An item done in another session stays held until someone marks it done; the guidance asks the agent to mark it only when it worked from a `clens_pending` listing.
- Not checked: whether Claude Code asks permission on the first `clens_hold` call; Codex's handling of hook context across its compaction (the hook runs on `compact` too).

## Open Questions

None. The defaults taken: `clens_pending` lists done and dropped items as well as held ones (the user asked to see what was held, dropped and done); `waits_for` is shown only when given.

## Goals Check

- G1: met for both clients in the measured scenes (R9; R5 and R10 for Codex), with the misses in Known Limits.
- G2: met in the measured scenes (R9: 0 wrong of 5; R10: 0 of 4; R4: 0 of 6); one wrong record each in R1 and R5 before the "picking one option" sentence was added.
- G3: met by `clens_pending`, `formatPending` and the rewritten skill (steps 2, 4, 6).
- G4: met: the ledger is its own file written by `ledger.ts`; the index connection stays read-only (step 2, AGENTS.md).
- G5: met by step 1 and AC4.

```skerry
{"run": "20261104-132237-286c", "verify": ["npm run typecheck", "npm test"], "extras": []}
```

## Changes After Approval

- Design → Documentation, "How it works": the document says "through five MCP tools" becomes seven (Korean "MCP 도구 다섯 개" → "일곱 개"). The sentence now reads "The agent reaches the index, and the ledger of what you set aside, through seven MCP tools:" (Korean "에이전트는 MCP 도구 일곱 개로 이 색인과 미뤄 둔 일의 장부를 다룹니다."). Why: the old sentence said the agent *reads the index* through the tools, which is untrue of `clens_hold` and `clens_pending`; they work on the ledger file, not the index.
