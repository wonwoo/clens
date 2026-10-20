# ExecPlan: `clens` — Claude Code Session Analyzer (OSS Skill)

- **Date**: 2026-06-21
- **Artifact type**: ExecPlan
- **Status**: Draft (pending user approval)
- **Author**: brainstorming with Claude
- **Repository target**: standalone OSS repo (not this `tdd-test` repo); planned to be `clens` on npm

---

## 0. Context for a Fresh Reader (Read This First)

You are likely a new Claude session or a developer who did not participate in the brainstorming that produced this plan. Read this section before touching anything else. It exists so you can begin work without re-deriving decisions.

**What `clens` is, in one paragraph**
A TypeScript CLI distributed as a **Claude Code Skill** that reads the user's local `~/.claude/` data, builds a SQLite index, and produces deep analytical reports (cost, tokens, cache, tools, files, agents, conversation patterns) plus reusable extraction suggestions (project context, user profile, recurring corrections) for future sessions. The CLI itself contains **no LLM calls** — it emits Markdown with explicit "semantic slot" blocks that the calling Claude fills in. v1 = Markdown + JSON reports. v2 = local web dashboard reading the same JSON. v2.5 = click-to-apply suggestions.

**Who the user is**
Author of this plan is a Claude Code **heavy user**: measured 835 sessions / 271 MB / 126,302 events / 17.9M tokens cumulative on his machine across 16 projects. Top model: Sonnet 4-6 (79%), then Opus 4-7/4-6 (19%). Top tools: Bash 5599 / Read 3960 / Edit 2053 / Write 1832 / ctx_execute 869. Cache hit rate this brainstorming session: 98%. These numbers are not hypothetical demand — they are the corpus the plan validates against.

**Target user definition (binding)**
Primary: heavy Claude Code users (≥200 cumulative sessions, ≥100 MB local data, ≥1 session/day). Secondary: any user, install-and-go. Light users still get correct (thinner) reports.

**Two analysis modes (both first-class in v1)**
- **Cumulative mode** — `clens report` — entire `~/.claude/` corpus. This is the headline mode and the one the "extraction suggestion" feature depends on.
- **Session mode** — `clens session <id|current>` — one session at a time. Auxiliary but expected ("how was that session?").
Same indexer, same schema, same slot system. Difference is one SQL `WHERE` clause.

**The Fat-CLI + Semantic Slots architecture (one-paragraph rationale)**
The CLI produces a near-complete Markdown report with deterministic facts (numbers, tables, lists). Wherever judgment is needed (which "정정" candidates are real scope changes, what a session was about, where to put an extracted suggestion), the CLI emits a `clens-slot` fenced block containing a JSON payload of evidence and a one-line task. The calling Claude replaces the slot in place. **No LLM in the CLI, no user API key required**, because the Skill caller (Claude Code itself) does the judgment. JSON is canonical; Markdown is a render; v2 HTML consumes the same JSON. See §10 for the slot grammar.

**Rejected alternatives (don't propose these — they were considered and dropped)**
| Option | Why rejected |
|---|---|
| A. Thin CLI (SQL only) + Heavy Claude (composes Markdown) | Inconsistent output across runs; high Claude token cost per Skill call; weak CLI-standalone value. |
| C. Two-Stage Pipeline (CLI raw facts → Skill orchestrates multi-step Claude) | Largest Skill complexity, slower wall time, debugging harder. Its one strength (clean JSON stages) is absorbed into B by making JSON canonical. |
| D. No CLI, pure Skill that parses JSONL in `ctx_execute` per call | 271 MB scanned every call is unviable; no incremental index; no place to persist SQLite. |
| FTS conversation search | Explicitly out by user. context-mode already covers it. |
| Auto-apply to `CLAUDE.md` / memory | Too risky for v1; v2.5 candidate with strong guards. |
| Live monitoring of in-flight sessions | JSONL flush timing makes "live" misleading. |
| Multi-machine / team comparison | Local-only is a privacy invariant. |
| Calling Anthropic API from the CLI | User said this is the whole point — meaning analysis runs in the Skill caller, no API key. |

**Glossary for the fresh reader** (terms used throughout):
- **Claude Code** — Anthropic's CLI/IDE product for agentic coding. Stores per-session JSONL transcripts in `~/.claude/projects/<dir>/<sessionId>.jsonl`. `~/.claude/` also contains `sessions/`, `tasks/`, `telemetry/`, `plans/`, `file-history/`, `skills/`. The CLI version is in each event's `version` field.
- **Skill** — A Claude Code feature: a directory with a `SKILL.md` instructing the calling Claude how to perform a task. The runtime "executes" SKILL.md by treating its body as a prompt the user implicitly sent. There is no SDK; Skills do not run code on their own — they tell Claude what tools to call.
- **Subagent / sidechain** — A nested Claude invocation spawned via the `Agent` tool. Its transcript is written to `subagents/agent-<id>.jsonl` inside the parent session's directory, and `isSidechain=true` on its events.
- **MCP** — Model Context Protocol. Names of MCP tools follow `mcp__<server>__<tool>` (e.g. `mcp__plugin_context-mode_context-mode__ctx_execute`). `clens` does not call MCP tools itself but recognizes them in tool-usage analytics.
- **`<system-reminder>` block** — Synthetic content the Claude Code harness injects into user messages (hook outputs, available-skills/agents lists, task reminders, compaction notices). Recognizable by the literal tags. See §11 taxonomy.
- **`<command-name>` block** — A synthetic block recording slash-command invocations like `/code-review` or `/clens`. See §6.5 regex.
- **context-mode** — A separate Claude Code plugin (out of scope, mentioned only because it already covers full-text conversation search, which is why `clens` does NOT).
- **turn** — see §6.5 canonical definition.
- **`promptId`** — Claude Code-internal id grouping events emitted in response to a single user prompt; one user turn can produce several assistant events all sharing one `promptId`. Stored as `event.prompt_id`; analyzer-side use: optional turn-grouping refinement when present. Not load-bearing for v1 gates.
- **`agentId`** — present only on subagent events; identifies the subagent invocation. Stored as `event.agent_id`. Used by Dimension 11 (Subagent usage) to deduplicate descriptions per invocation. Not load-bearing for kind-resolution (which uses `isSidechain`/path).

**Locked design invariants (do not change without re-approval)**
1. CLI is purely deterministic. No network. No LLM.
2. JSON is canonical; Markdown is a render of the JSON; v2 HTML consumes the same JSON.
3. `~/.claude/` is read-only.
4. Default `--out` is outside any git working tree.
5. v1 ships *suggestions* only — never auto-writes to `CLAUDE.md` / memory.
6. Extraction targets: (1) project context, (2) user profile, (3) recurring corrections. Other extraction types are v2.
7. Subagent sessions are indexed but `session current` resolves to the most-recent **interactive** session, never a subagent flush.
8. `telemetry/` data is best-effort enrichment with limited representativeness (the files locally present are *failed-event* dumps, not full telemetry) — surface this in `caveats[]`, never treat as ground truth.

**Concrete first artifacts the implementer must produce before Phase A "real work"**
Phase 0 (added in §17): generate `test/fixtures/brainstorm-session.jsonl` — a redacted excerpt of the brainstorming session that produced this plan (this conversation), with paths and identifiers scrubbed. The known-good fixture defines gate 6's `{3, 4, 6}` correction-turn set (measured 2026-06-21 from the redacted fixture; the binding criterion is the three semantic scope-changes — drop-FTS / OSS-pivot / Skill-caller-LLM — not the literal numbers). Until that fixture exists, gate 6 cannot be evaluated.

**How to resume this plan in a new Claude session**
1. Open this file (`docs/execplans/2026-06-21-clens-execplan.md`) and read §0 → §3 → §5 → §17 in that order.
2. Look at `~/.claude/projects/` to confirm the data shape described in §6.5 still matches the running Claude Code version (`event.version` in JSONL).
3. Begin Phase 0 (fixture creation). Do not start Phase A until gate 6 fixture is committed.
4. Each phase's exit gate in §14 is the only criterion for moving on. No phase is "done" by intuition.
5. If a design question arises that this document does not answer, return to the user — do not invent. The rejected-alternatives table above is exhaustive for the questions we already settled.

**What I (the brainstorming Claude) verified empirically before writing this plan**
- The `~/.claude/projects/**/*.jsonl` files parse cleanly (0 parse errors across all 835 files).
- Full SQLite index build over 271 MB / 126K events takes 2.28 s on the author's M-series Mac.
- Incremental update (5 files modified in last 24h, 10.6 MB) takes 50 ms.
- Aggregate queries over the indexed data: ≤41 ms for top-N rollups.
- The full analyzer (cost, tokens, cache, tools, turn shape, timeline, files, agents, health, **skill usage, subagent usage, project usage map**, user signals, summary, decisions) returns meaningful numbers on a single session; system-reminder/compaction parsing requires a dedicated parser (regex-only misses them).
- **Skill / subagent / project usage was empirically verified on the author's full corpus**: 126 `Skill` tool_use calls (top: `fact-check` 19, `code-review` 18, `implementation` 14, `researcher` 12); 70 `<command-name>` slash invocations (top: `/challenge-review` 30, `/code-review` 30); 346 `Agent` tool_use calls dominated by `<default>` 189 (55%), then `code-reviewer` 37, `claude-code-guide` 29, `Explore` 29 — the `<default>` rate alone is a strong anomaly signal worth surfacing. Project distribution: top-3 = `work-app` 267 sessions / 5.41M tokens, `harness-test1` 125 / 3.24M, `shop-service` 105 / 4.16M.
- Slot system rationale: I tested it inline. CLI surfaced 6 "correction candidate" excerpts from the brainstorming session; a slot-filling pass identified exactly 3 as real scope changes corresponding to (1) dropping FTS search, (2) switching from personal-use to OSS Skill, (3) shifting LLM responsibility to the Skill caller. **The turn numbers `{8, 12, 16}` were a human-agreed starting hypothesis from the brainstorming conversation — they were NOT computed by a running selector against a real fixture.** Phase 0 must re-derive these numbers by running the actual selector (§10) over the redacted fixture's `user_turn_no` indexing. If the re-derived set differs, **the fixture and `expected.json` and §14 gate 6 are updated to the re-derived set, with the three semantic scope-changes (dropping FTS / OSS pivot / Skill-caller LLM responsibility) remaining the binding criterion**. **Re-derived 2026-06-21 against the committed redacted fixture: the actual user-turn set is `{3, 4, 6}`** — gate 6 has been updated accordingly. The original `{8, 12, 16}` hypothesis is preserved in this paragraph only for historical traceability; all gates reference `{3, 4, 6}`.

---

## 1. Problem

Claude Code stores rich session data locally under `~/.claude/` — JSONL transcripts, token usage, tool calls, subagent trees, telemetry, task graphs. Users have **no way to see how they actually use Claude** (cost, behavior, conversation context, recurring corrections) and **no way to feed that back into future sessions** (e.g. CLAUDE.md, memory, profile).

Measured volume on author's machine: **835 sessions, 271 MB, 126,302 events, 17.9M tokens cumulative** across 16 projects. This is real heavy-user scale that current tooling does not address.

**Empirical signals from this corpus (not hypothetical demand)**:
- Cumulative tokens: 17,926,198 across all sessions.
- Top models by token volume: `claude-sonnet-4-6` 14.2M (79%), `claude-opus-4-7` 2.2M (12%), `claude-opus-4-6` 1.3M (7%), `claude-haiku-4-5` 0.3M.
- Top tools by call count: `Bash` 5,599 / `Read` 3,960 / `Edit` 2,053 / `Write` 1,832 / `mcp__plugin_context-mode_context-mode__ctx_execute` 869.
- The brainstorming session that produced this plan: **99.36 min wall, $94.02 cost** (claude-opus-4-7), **98.07% cache hit rate**, context-bloat ratio surfaced via D9. *(These are the measured values from running `clens session test` against the redacted fixture on 2026-06-21. The earlier sandbox-time estimates of "23.8 min / ~$13.74" were eyeballed mid-session and were off by ~4–7×; they are NOT the binding ground truth. Phase B exit assertions reference the measured values; see `test/fixtures/brainstorm-session.expected.json`'s `phase_b_ground_truth` block.)*

## 2. Goal

Build `clens` — an OSS TypeScript CLI distributed as a Claude Code Skill — that:

1. **Indexes** the entire `~/.claude/` data corpus into a local SQLite database, with cheap incremental updates.
2. **Analyzes** sessions across many deterministic dimensions (cost, tokens, cache, tools, timeline, files, agents, context bloat, user signals, …).
3. **Renders** a rich human-readable Markdown report (Fat-CLI approach) with explicit *semantic slots* for the calling Claude to fill in (corrections, summaries, suggestions).
4. **Extracts** reusable signals — project context, user profile, recurring corrections — and **proposes** where they should live (project `CLAUDE.md`, global memory, etc). Auto-apply is out of scope for v1.
5. Emits both a Markdown report AND a machine-readable JSON, sharing one data model — so the future v2 web dashboard consumes the same JSON without re-derivation.

## 3. Non-Goals

- ❌ Full-text conversation search (explicitly out of scope per user).
- ❌ Auto-applying changes to `CLAUDE.md` / memory in v1. Only *propose* with diff preview.
- ❌ Real-time live monitoring of in-flight sessions (file flush timing makes this misleading).
- ❌ Multi-machine / team-level comparison. Local-only.
- ❌ Calling an LLM API directly from the CLI. The CLI is purely deterministic; meaning analysis is delegated to the calling Claude (Skill caller). User API key not required.
- ❌ Modifying or deleting any data under `~/.claude/`. Read-only.

## 4. Target Users

- **Primary**: Claude Code heavy users (≥200 cumulative sessions, ≥100 MB local data, ≥1 session/day). They want depth, accuracy, and re-use.
- **Secondary**: Any Claude Code user, install-and-go. Light users still get correct (if thinner) reports.

## 5. Constraints & Principles

- **TypeScript / Node.js ≥20**, distributed via npm. Single-package, no native deps if possible (better-sqlite3 is acceptable native dep).
- **Local-only**: data never leaves the user's machine.
- **Skill-first**: primary surface is a Claude Code Skill (`/clens`); the binary also works standalone.
- **Deterministic CLI**: every analytical number is reproducible from JSONL → SQLite. No LLM inside the CLI.
- **Semantic slots**: meaning judgment happens in the calling Claude via slot blocks in the Markdown output.
- **One data model**: the JSON output is canonical; Markdown is a render of it; v2 HTML dashboard consumes the same JSON.
- **Perf target** (on indexed data with author's 1.5× extrapolation: ~1,000 sessions / 500 MB / 1M events): index build ≤15s, incremental update ≤1s, single query ≤100ms.
- **No destructive ops** on user data; SQLite index is rebuildable from source at any time.
- **Supported platforms (v1)**: macOS (arm64 + x86_64) and Linux (x86_64, glibc ≥ 2.31). Node ≥ 20.x.
- **Windows policy (v1)**: best-effort only. The CLI starts up; `os.homedir()` resolves; paths use `path.join`. But Windows-specific behaviors (junction handling, case-insensitive paths, `%USERPROFILE%\.claude` discovery, antivirus locking) are **not tested in CI**. If the CLI crashes on Windows v1, the response is "not supported in v1, please file an issue; v1.1 will address it". `clens doctor` on Windows prints a clear "best-effort platform" warning.
- **Tie-breaking** for `session current` when two interactive sessions share `started_at`: pick the lexicographically larger `session_id` (stable, no clock dependency).
- **`--out` timestamp format**: `YYYYMMDD-HHmmss-<6 hex>` in UTC (e.g. `20260621-143015-a8f3c2`). Stable, sortable, no TZ surprises.

## 6. Architecture (B = Fat CLI + Semantic Slots)

```
+--------------------------------------------------------+
| ~/.claude/                                             |
|   projects/**/*.jsonl   (main + subagents)             |
|   sessions/*.json       (process meta)                 |
|   tasks/*               (agent task graph)             |
|   telemetry/*.json      (env, model — limited)         |
|   plans/*               (plan-mode docs)               |
|   file-history/*        (file snapshots — v2)          |
+----------------------+---------------------------------+
                       |
                       v  (read-only, incremental)
+----------------------+---------------------------------+
| clens indexer (TS)                                     |
|  - mtime + line-offset cursor per file                 |
|  - parses JSONL events, normalizes into rows           |
+----------------------+---------------------------------+
                       |
                       v
+----------------------+---------------------------------+
| ~/.claude/clens/index.db   (SQLite, WAL)              |
|  tables: events, sessions, projects, tools,           |
|          file_ops, usage_turn, agent_links,           |
|          file_index (mtime cursor), schema_version    |
+----------------------+---------------------------------+
                       |
                       v
+----------------------+---------------------------------+
| clens analyzer (TS) — 12+ deterministic dimensions    |
|   cost / tokens / cache / tools / timeline / files   |
|   turn shape / agents / context bloat / user signals  |
|   health / anomalies / extraction candidates          |
+----------------------+---------------------------------+
                       |
                       v
+--------+-------------+--------+--------------------+
|        |                      |                    |
v        v                      v                    v
report  report                excerpts            extract
session  global                (slot material)    (suggestions JSON)
.md+.json .md+.json
                       |
                       v
+----------------------+---------------------------------+
| Claude Code Skill `/clens`                             |
|   pipeline:                                            |
|     1. invoke clens CLI                                |
|     2. fill ````clens-slot blocks via Claude reasoning |
|     3. present final Markdown to user                  |
|     4. (v2) launch web dashboard from same JSON        |
+--------------------------------------------------------+
```

## 6.5 Input Format Assumptions (Claude Code JSONL, v2.x)

Each JSONL line is one **event record**. One event = one row in `event`. Multi-content-block messages (text + tool_use + tool_result in one assistant turn) are **kept as one event row**; their content blocks are denormalized into `tool_call` / `file_op` / `user_text` rows that all reference back to `event.uuid`.

Assumed top-level fields per line (observed in author's corpus):

| JSONL field | Type | Mapped to |
|---|---|---|
| `uuid` | string | `event.uuid` (PK) |
| `parentUuid` | string\|null | `event.parent_uuid` |
| `sessionId` | string | `event.session_id` / `session.id` |
| `promptId` | string\|null | `event.prompt_id` |
| `agentId` | string\|null | `event.agent_id` |
| `isSidechain` | boolean | `event.is_sidechain` (0/1) |
| `type` | `"user"`\|`"assistant"`\|`"attachment"` | `event.role` (after reconciling with `message.role`) |
| `timestamp` | ISO 8601 string | `event.ts` |
| `cwd` | string | `session.cwd` |
| `gitBranch` | string | `session.git_branch` |
| `version` | string | `session.version` |
| `message.role` | `"user"`\|`"assistant"` | confirms `event.role` |
| `message.model` | string | `event.model`, `session.model_primary` (mode of assistant rows) |
| `message.usage.input_tokens` | int | `event.in_tok` |
| `message.usage.output_tokens` | int | `event.out_tok` |
| `message.usage.cache_read_input_tokens` | int | `event.cache_r` |
| `message.usage.cache_creation_input_tokens` | int | `event.cache_w` |
| `message.content` | string \| Block[] | walked; see below |

Content-block walking rules (when `message.content` is an array):
- `{type:"text", text:T}` → adds to `event.text_len += codepoint_count(T)` (NOT bytes — Unicode codepoint count, equivalent to JavaScript `[...T].length` and Python `len(T)`); for `role=user`, also inserted into `user_text` (filtered if `T` starts with `[{` and contains `tool_use_id` — that's a tool-result blob pretending to be user).
- `{type:"tool_use", id, name, input}` → one `tool_call` row; `event.has_tool_use=1`; `input` is JSON-serialized and **truncated to 2048 bytes** (UTF-8 safe boundary). For `name in (Read, Edit, Write, NotebookEdit)`, also one `file_op` row with `path = input.file_path || input.notebook_path`.
  - **Skill calls**: when `name == "Skill"` exactly (the built-in Skill invocation tool), also one `skill_call` row with `skill = input.skill`, `args_excerpt = first 256 chars of input.args`. We do NOT match `:Skill`-suffixed tool names — no such MCP tool exists in observed corpora; if one appears later, the analyzer logs `anomalies.unknown_skill_namespace` and the row goes to `tool_call` only.
  - **Agent calls**: when `name == "Agent"`, also one `agent_call` row with `subagent_type = input.subagent_type ?? "<default>"`, `description = input.description`, `prompt_excerpt = first 256 chars of input.prompt`. The literal sentinel `"<default>"` is used to make heavy default-rate immediately countable.
  - **Slash commands** appearing inside user text are recorded into `slash_command` rows. **Regex**: `/<command-name>\s*\/?([a-zA-Z0-9_:.\-]+)\s*<\/command-name>/g` applied to every `user_text.text`. The character class includes `.` to cover dotted skill names (e.g. plugin-namespaced variants). Multiple matches in one message → multiple `slash_command` rows. The leading `/` is stripped if present. `is_command` is set to 1 on the `user_text` row when at least one match exists. A slash command may or may not be a Skill — see §11 dimension 10 for how analytics treat the two sources separately.
- `{type:"tool_result", tool_use_id, is_error, content}` → updates the matching `tool_call.duration_ms = (this.ts - tool_use.ts)`, sets `is_error`; `event.has_tool_res=1`.
- Any other block type → counted in `anomalies.unknown_block_type` (never throws).

Partial-last-line rule: the parser advances `file_cursor.last_ok` only past lines that end in `\n`. A line missing the terminator is left for the next incremental run (handles concurrent flush from a live Claude Code session).

`role` reconciliation: `event.type` is the source of truth; `message.role` is verified to match. Mismatch increments `anomalies.role_mismatch` and the `event.type` value wins.

**Unit conventions (canonical)**: lengths/sizes carry their unit suffix in field names. `text_len` and `--max-excerpt-chars` are **codepoint counts**. `tool_call.input_json` cap, `event_unknown_block.raw_json` cap, `system_reminder.text_excerpt` cap, `plan_doc.content_md` cap, `telemetry_event.payload` cap, and the slot anti-runaway bound are all **bytes**. When in doubt, JSON field names will read `_chars` or `_bytes` explicitly.

**Definition of "turn" (canonical, used everywhere in this document)**:
- A `turn` is **one user message** in a session, in chronological order, 1-indexed.
- Concretely: `user_turn_no = ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts) WHERE event.role = 'user' AND NOT is_tool_result_pseudo_user`.
- `is_tool_result_pseudo_user` is true when the `user` event's content is purely `tool_result` blocks (Claude Code emits tool results as synthetic user messages). These are excluded from turn numbering.
- The `assistant_turn_no` is the parallel index over assistant events. When ambiguity exists, "turn N" without qualifier means **user turn N**.
- Gate 6's `{3, 4, 6}` are **user turns** (the 3rd, 4th, 6th human-authored messages in the fixture session — measured 2026-06-21 from the redacted brainstorm fixture).
- `event` rows additionally carry `user_turn_no` and `assistant_turn_no` columns populated by the indexer in a second pass after raw rows land. Excluded events have both fields NULL.

**`message.content` edge cases**:
- `null` → treat as `[]` (empty content); set `event.has_text=0, has_tool_use=0, has_tool_res=0`; increment `anomalies.null_content`.
- non-string non-array (object, number) → log `anomalies.unrecognized_content_shape`, treat as `[]`.
- Unknown block type inside an array → counted in `anomalies.unknown_block_type`; the block's raw JSON is stored in `event_unknown_block(event_uuid, block_index, raw_json)` (capped 1KB per row) for later forensic; `event.has_*` flags do **not** change.
- An attachment record (`event.role = 'attachment'`) has its content shape recorded but does not contribute to `user_text` or `tool_call`. `message.role` is allowed to be absent on attachments.

**Line-level skip anomalies** (added 2026-06-21 during Phase A implementation; spec drift recorded for transparency):
- A JSONL line whose body fails `JSON.parse` → counted in `anomalies.json_parse_error` (detail records source_file + line ordinal); the line is skipped and produces no `event` row. `file_cursor.lines` still counts it.
- A line whose parsed value is non-null but not a plain object (array / number / string at top level) → counted in `anomalies.non_object_line`, skipped.
- A line that is a valid object but lacks a top-level `uuid` field (e.g. `{"type":"last-prompt","leafUuid":...,"sessionId":...}` markers some Claude Code versions write at file start) → counted in `anomalies.non_event_line`, skipped. These markers are real Claude Code emissions, not corruption — they are intentionally not stored.
- Line-accounting (gate 1): `file_cursor.lines == events_for_this_file + SUM(count) WHERE kind IN ('json_parse_error', 'non_object_line', 'non_event_line')`. This invariant holds after both full rebuild and incremental update paths.

## 7. Data Model — SQLite Schema (v1)

Tables (simplified):

```sql
CREATE TABLE schema_version (v INTEGER);

CREATE TABLE file_cursor (             -- incremental indexing
  path     TEXT PRIMARY KEY,
  mtime    REAL NOT NULL,
  size     INTEGER NOT NULL,
  lines    INTEGER NOT NULL,           -- count of \n-terminated lines through last_ok (partial trailing line excluded)
  last_ok  INTEGER NOT NULL,           -- byte offset of last successfully parsed \n-terminated line end
  live     INTEGER NOT NULL DEFAULT 0  -- 1 if mtime is within last 60s at index time (excludes file from orphan-tool counts)
);

CREATE TABLE project (
  id       TEXT PRIMARY KEY,           -- derived from dir name
  cwd      TEXT,
  display  TEXT
);

CREATE TABLE session (
  id           TEXT PRIMARY KEY,       -- sessionId
  project_id   TEXT,
  kind         TEXT,                   -- interactive | headless | subagent | unknown
  parent_id    TEXT,                   -- if subagent
  started_at   TEXT,
  ended_at     TEXT,
  cwd          TEXT,
  git_branch   TEXT,
  model_primary TEXT,
  version      TEXT,
  FOREIGN KEY (project_id) REFERENCES project(id)
);

CREATE TABLE event (
  uuid             TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  parent_uuid      TEXT,
  prompt_id        TEXT,
  agent_id         TEXT,
  is_sidechain     INTEGER,
  ts               TEXT NOT NULL,
  role             TEXT,               -- user | assistant | attachment
  model            TEXT,
  in_tok           INTEGER DEFAULT 0,
  out_tok          INTEGER DEFAULT 0,
  cache_r          INTEGER DEFAULT 0,
  cache_w          INTEGER DEFAULT 0,
  text_len         INTEGER DEFAULT 0,
  has_tool_use     INTEGER DEFAULT 0,
  has_text         INTEGER DEFAULT 0,
  has_tool_res     INTEGER DEFAULT 0,
  user_turn_no     INTEGER,            -- NULL for non-user events and synthetic tool-result-user events
  assistant_turn_no INTEGER,           -- NULL for non-assistant events
  FOREIGN KEY (session_id) REFERENCES session(id)
);
CREATE INDEX event_user_turn_idx ON event(session_id, user_turn_no);

CREATE TABLE event_unknown_block (     -- forensic store for unrecognized content block types
  event_uuid  TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  raw_json    TEXT NOT NULL,           -- capped 1024 bytes
  PRIMARY KEY (event_uuid, block_index),
  FOREIGN KEY (event_uuid) REFERENCES event(uuid)
);
CREATE INDEX event_session_idx ON event(session_id, ts);
CREATE INDEX event_ts_idx ON event(ts);

CREATE TABLE tool_call (
  event_uuid   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  ts           TEXT NOT NULL,
  call_id      TEXT,                   -- tool_use id
  name         TEXT NOT NULL,
  input_json   TEXT,                   -- raw input, capped at 2KB; full input not stored
  duration_ms  INTEGER,                -- filled from matching tool_result
  is_error     INTEGER DEFAULT 0,
  FOREIGN KEY (event_uuid) REFERENCES event(uuid)
);
CREATE INDEX tool_session_idx ON tool_call(session_id);
CREATE INDEX tool_name_idx ON tool_call(name);

CREATE TABLE file_op (                 -- denormalized Read/Edit/Write targets
  event_uuid  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  ts          TEXT NOT NULL,
  tool        TEXT NOT NULL,           -- Read | Edit | Write | NotebookEdit
  path        TEXT NOT NULL,
  FOREIGN KEY (event_uuid) REFERENCES event(uuid)
);
CREATE INDEX file_op_path_idx ON file_op(path);

CREATE TABLE user_text (               -- only authored user text (filters tool_results)
  event_uuid  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  ts          TEXT NOT NULL,
  text        TEXT NOT NULL,
  is_command  INTEGER DEFAULT 0,
  FOREIGN KEY (event_uuid) REFERENCES event(uuid)
);

CREATE TABLE task_node (               -- from ~/.claude/tasks/
  task_id     TEXT PRIMARY KEY,
  session_id  TEXT,
  subject     TEXT,
  status      TEXT,
  owner       TEXT
);
CREATE TABLE task_dep (                -- normalized blocks / blocked_by
  task_id     TEXT NOT NULL,
  depends_on  TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE telemetry_event (         -- from ~/.claude/telemetry/ (partial coverage caveat)
  session_id  TEXT,
  ts          TEXT,
  event_name  TEXT,
  model       TEXT,
  version     TEXT,
  payload     TEXT                     -- capped JSON
);

CREATE TABLE plan_doc (                -- from ~/.claude/plans/
  path        TEXT PRIMARY KEY,
  mtime       REAL,
  content_md  TEXT
);

CREATE TABLE skill_call (              -- from tool_use name="Skill"
  event_uuid    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  ts            TEXT NOT NULL,
  skill         TEXT NOT NULL,
  args_excerpt  TEXT,                  -- first 256 chars of input.args
  FOREIGN KEY (event_uuid) REFERENCES event(uuid)
);
CREATE INDEX skill_name_idx ON skill_call(skill);

CREATE TABLE agent_call (              -- from tool_use name="Agent"
  event_uuid       TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  ts               TEXT NOT NULL,
  subagent_type    TEXT NOT NULL,      -- literal "<default>" if input.subagent_type was absent
  description      TEXT,
  prompt_excerpt   TEXT,               -- first 256 chars of input.prompt
  FOREIGN KEY (event_uuid) REFERENCES event(uuid)
);
CREATE INDEX agent_type_idx ON agent_call(subagent_type);

CREATE TABLE slash_command (           -- <command-name>X</command-name> seen in user text
  event_uuid  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  ts          TEXT NOT NULL,
  name        TEXT NOT NULL,
  FOREIGN KEY (event_uuid) REFERENCES event(uuid)
);
CREATE INDEX slash_name_idx ON slash_command(name);

CREATE TABLE system_reminder (         -- <system-reminder>...</system-reminder> parsed from user text
  event_uuid    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  ts            TEXT NOT NULL,
  category      TEXT NOT NULL,         -- see taxonomy in §11
  text_excerpt  TEXT,                  -- capped 512 bytes
  FOREIGN KEY (event_uuid) REFERENCES event(uuid)
);
CREATE INDEX system_reminder_cat_idx ON system_reminder(category);

CREATE TABLE anomaly (                 -- normalized warning bucket
  session_id  TEXT,
  ts          TEXT,
  kind        TEXT NOT NULL,           -- e.g. 'null_content', 'tool_input_truncated'
  count       INTEGER NOT NULL DEFAULT 1,
  detail      TEXT                     -- optional JSON detail (capped 1KB)
);
CREATE INDEX anomaly_kind_idx ON anomaly(kind);

-- Anomaly lifecycle (canonical):
-- 1. The indexer maintains an in-memory `Map<kind, count>` per file batch.
-- 2. On batch flush, write one `anomaly` row per kind for that batch:
--      INSERT INTO anomaly(session_id, ts, kind, count, detail) VALUES (...);
-- 3. report.json renders `facts.anomalies[]` via:
--      SELECT kind, SUM(count) AS count,
--             (SELECT detail FROM anomaly a2
--              WHERE a2.kind = a1.kind AND a2.detail IS NOT NULL
--              ORDER BY a2.ts DESC LIMIT 1) AS detail
--      FROM anomaly a1 [WHERE session_id = ?]
--      GROUP BY kind ORDER BY count DESC;
--    (i.e. preserve the most recent non-null detail per kind; null otherwise.)
-- 4. Narrative shorthand "increment anomalies.X" in §6.5 / §10 means
--    "bump the in-memory counter for kind='X'" — not direct row writes.
-- 5. If an anomaly is recorded before `sessionId` is parsed (e.g. JSON parse
--    error on a malformed line), the row is written with `session_id = NULL`
--    and `detail = { source_file, byte_offset }`. Such rows surface in the
--    global report only (not per-session reports filtered by session_id).
```

**Notes**
- `event.text_len` records length only (no raw text) to keep DB small; user text is selectively duplicated into `user_text` for excerpt rendering.
- All tool inputs are **capped at 2 KB** to keep index sustainable; pathological tool inputs are not the analysis target.
- File-history is **not** indexed in v1; placeholder hook for v2.
- **Concurrency**: SQLite opened with `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000`. A process-level advisory lock (`~/.claude/clens/index.db.lock` via `proper-lockfile` or equivalent) gates writers — concurrent `clens index` runs queue with a 30s timeout, then exit with code `4` ("indexer busy"). Readers (`report`, `session`, `extract`, `stats`) take only the SQLite shared lock and never wait on the advisory lock.
- **`telemetry_event.payload` is intentionally opaque JSON-in-TEXT**: the telemetry shape varies per `event_name` and is treated as best-effort enrichment; we do not normalize. Other JSON-in-TEXT fields (`task_node`) were normalized into `task_dep`.
- **`event.has_text` / `has_tool_use` / `has_tool_res`** are set to 1 iff at least one content block of that kind is observed while walking `message.content`. They are convenience flags for analyzer queries; the authoritative content lives in the derived tables.
- **`tool_call.duration_ms` cross-event fill**: when a `tool_result` is observed, the matching `tool_call` row (looked up by `call_id = tool_use_id`) is updated in place. During incremental indexing, an unmatched `tool_result` can land in a later batch than its `tool_use` — the indexer reopens `tool_call` rows by `call_id`. Truncation of `input_json` past 2048 bytes increments `anomalies.tool_input_truncated`.
- **Orphan tool_use**: when `clens index` finishes a session and one or more `tool_call` rows still have `duration_ms IS NULL` (no matching `tool_result` ever arrived — Claude was killed mid-call, or the session crashed), `duration_ms` stays NULL. Dimension 9 ("Health") counts these as `health.unresolved_tool_calls` via `SELECT COUNT(*) FROM tool_call WHERE duration_ms IS NULL`. Excluding the current open session avoids false positives — see below.
- **Current-session safe handling**: the most recently modified JSONL file may belong to a live session. Its trailing `tool_use` without `tool_result` is not an orphan, it is in-flight. The indexer marks the file via `file_cursor.live = 1` when `mtime` is within the last 60 seconds, and `health.unresolved_tool_calls` excludes events from live files.

### `session.kind` and `session.parent_id` derivation

After all events for a session are indexed, run this resolver:

1. If the source file path matches `**/subagents/agent-*.jsonl` → `kind = 'subagent'`. Set `parent_id` to the session id of the directory's main session (its parent directory's `sessionId`, recovered by reading any non-subagents sibling JSONL).
2. Else if `ANY event.is_sidechain = 1` for this session_id → `kind = 'subagent'`. Pick the **earliest** sidechain event for this session, breaking ties by lexicographically smallest `uuid`. Resolve `parent_id` by walking that event's `parent_uuid` with a **visited-set guard** (max 100 hops; abort and treat as orphan on cycle): at each step, look up the row by `uuid`; if that row's `session_id` differs from the current session, the parent has been found and `parent_id` = that row's `session_id`. If the walk terminates with `parent_uuid IS NULL`, with a row inside the same session (orphan chain), with a cycle (visited-set hit), or by exceeding the hop cap → `parent_id = NULL` and `anomalies.parent_uuid_orphan` is incremented (with `detail = { reason: "null" | "self_session" | "cycle" | "hop_cap" }`).
3. Else if a matching `~/.claude/sessions/<pid>.json` exists with `kind: "interactive"` (or `entrypoint: "cli"` + `kind: "interactive"`) and the same `sessionId` → `kind = 'interactive'`, `parent_id = NULL`.
4. Else if `~/.claude/sessions/<pid>.json` exists with `kind: "headless"` or `is_ci: true` in `~/.claude/telemetry/*.env` for the same session → `kind = 'headless'`, `parent_id = NULL`.
5. Else if NO sidechain events exist AND the source file path does NOT match `**/subagents/*` (i.e. it's a top-level project JSONL with no sidechain markers) → `kind = 'interactive'` (fallback for older sessions whose `sessions/<pid>.json` sidecar has been pruned). `anomalies.session_kind_inferred_interactive` is incremented for transparency.
6. Else → `kind = 'unknown'`, `parent_id = NULL`, increment `anomalies.session_kind_unknown`.

### `~/.claude/tasks/` parse rules

- Directory structure: `~/.claude/tasks/<session-or-task-id>/<n>.json` where `<n>` is the task ordinal (1, 2, 3, ...). Sibling files in the same dir form one task graph.
- `.lock` files and `.DS_Store` ignored.
- Each task JSON shape (observed): `{ id, subject, description, activeForm, status, blocks: [id...], blockedBy: [id...], owner }`.
- Mapping: one row per file in `task_node` (`task_id = <dir>/<n>`); each entry in `blocks`/`blockedBy` becomes a row in `task_dep`.
- Unknown fields → ignored. Missing required fields (`id`, `status`) → increment `anomalies.task_malformed`, skip the row.

### `~/.claude/plans/` parse rules

- Files: `*.md` in the top-level dir. Subdirs ignored.
- Mapping: one row in `plan_doc` (`path = absolute path`, `mtime`, `content_md = entire file content, capped 64 KB`).
- Plans are not associated with sessions in v1 (the filename is a random slug).

### `~/.claude/telemetry/` parse rules

- Files: `*.json`, each containing a single `{ event_type: "ClaudeCodeInternalEvent", event_data: {...} }` object.
- Mapping: one row in `telemetry_event` (`session_id = event_data.session_id`, `ts = event_data.client_timestamp`, `event_name = event_data.event_name`, `model = event_data.model`, `version = event_data.env?.version`, `payload = entire event_data JSON capped 8 KB`).
- Filename pattern `1p_failed_events.*.json` is explicitly the "failed-event" dump. Records from this prefix get `payload.is_failed_dump = true` annotation and `caveats[]` warns about partial coverage.
- Non-JSON files → skipped silently.

## 8. CLI Surface

Binary `clens`. Subcommands:

| Command | Purpose |
|---|---|
| `clens index` | Build or update the local SQLite index. Auto-incremental by default. |
| `clens index --rebuild` | Force a full rebuild. |
| `clens report` | Cumulative (global) report. Default mode. Outputs Markdown to stdout + JSON sibling. |
| `clens report --project <id>` | Restrict to one project. |
| `clens report --since <date>` | Time-bound report. |
| `clens session <id>` | Single-session report. `<id>` may be `current` to pick the most recently modified **interactive** session (`session.kind='interactive'`); if none exists, exit `1` with message `no interactive session found`. The literal id of any session (including subagent) is always honored. |
| `clens extract` | Emit *only* the extraction-suggestion JSON + diff previews. |
| `clens stats` | Quick numeric summary (no slots, no Markdown chrome). For scripts/CI. |
| `clens doctor` | Verify install, paths, SQLite version, data discoverability. Flags: `--scan-secrets` (opt-in heuristic scan over `user_text` / `tool_call.input_json` for `sk-*`, `AKIA*`, JWT shapes — prints counts only, never contents); `--gc <days>` (v1.x optional, prunes `~/.claude/clens/reports/*` older than N days). Neither runs auto-index. |

**Global flags**
- `--format md|json|both` (default `both`)
  - `md`     → Markdown to stdout
  - `json`   → JSON to stdout
  - `both`   → writes `report.md` + `report.json` to `--out`, prints the resolved `--out` path to stdout (the Skill consumes the path; **never** stdout content when `both`)
- `--out <dir>` (default `~/.claude/clens/reports/<run-timestamp>/`)
- `--no-slots` (CLI fills nothing — slot blocks render as collapsed JSON for Claude-less consumers, e.g. CI)
- `--max-excerpt-chars <N>` (control slot payload size, default 4096)
- `--no-index-update` (skip auto-index-update; if index is stale, exit `2`)
- `--lock-timeout <ms>` (default 30000; advisory write-lock wait before exit `4`)
- `--auto-migrate` (allow schema upgrade; without it, schema mismatch exits `5`)

**`clens stats` subcommand flags**
- `--digest` — emit per-table SHA-256 of canonically PK-sorted rows. Used by gate 2 to verify rebuild determinism; suitable for CI assertions.

**Auto-index policy (canonical)**

Every analysis command (`report`, `session`, `extract`, `stats`) performs this preflight in order, before doing its real work:

1. **No index file at `~/.claude/clens/index.db`** (cold start, first ever run): print `clens: building index (first run, this may take a few seconds)...` to stderr, perform a **full build** equivalent to `clens index --rebuild`, then continue.
2. **Index exists and is fresh** (every `~/.claude/**/*.jsonl` file has `mtime ≤ file_cursor.mtime` for its row, AND no new files): proceed silently.
3. **Index exists and is stale** (any source file's `mtime` is newer than the indexed cursor, OR new source files exist): print one line `clens: updating index (<n> changed files)...` to stderr, perform an **incremental update**, then continue.
4. **`--no-index-update` was passed**: skip preflight. If the index is stale or missing, exit `2`. This mode is for CI / scripting where the caller wants to guarantee no I/O work.
5. **Schema version mismatch**: handled separately per §8 exit code 5.

`clens index` (explicit subcommand) is the manual-trigger path — useful for cron, post-install hooks, or troubleshooting. It does the same work as the preflight but with verbose progress output and exit code `0` on success.

`clens doctor` does NOT auto-index. It only reports the state of an existing index (or its absence).

**Exit codes**
- `0` success
- `1` unexpected error
- `2` index stale — newest `.jsonl` mtime is later than `file_cursor.mtime` for ≥1 file and command was invoked with `--no-index-update` (default behavior is to auto-update first; this code is only emitted when auto-update was suppressed)
- `3` `~/.claude/` data dir missing or unreadable
- `4` indexer busy (another `clens index` holds the advisory lock past `--lock-timeout`, default 30s)
- `5` schema migration required (existing index `schema_version` < binary's expected version and `--auto-migrate` not set)

**Schema migration policy**: migrations live in `src/indexer/migrations/<n>-<slug>.sql`. The binary expects `MAX(file_n)` = `schema_version` in DB. Migrations are append-only (no destructive renames in v1); each must be idempotent. `--auto-migrate` applies all pending migrations inside a single transaction. If any fails, the DB is rolled back and the binary exits `5` with the failing file name. There is no v1 down-migration path — restore from backup or `clens index --rebuild`.

## 9. Output Contract (Canonical JSON)

Top-level shape of `report.json`:

```jsonc
{
  "schema_version": 1,
  "generated_at": "ISO",
  "contains_user_content": true,
  "scope": { "mode": "global" | "session" | "project", "params": {...} },
  "facts": {
    "identity":   { /* session/project/model basics */ },
    "cost":       { "total_usd": 94.02, "breakdown": {...}, "per_turn_usd": 1.54 },
    "tokens":     { "in": 644, "out": 227541, "cache_r": 41262182, "cache_w": 802818,
                    "trajectory": [{turn, ctx, in, out, cr, cw}, ...] },
    "cache":      { "hit_rate_overall": 98.07, "per_turn": [...], "savings_usd": "..." },
    "tools":      { "counts": {...}, "durations": {...}, "errors": N, "sequence": [...] },
    "turn_shape": { "text_only": 16, "tool_only": 8, "mixed": 0 },
    "files":      { "top": [{path, tool, count}, ...] },
    "timeline":   { "wall_min": 99.36, "think_min": 86.96, "idle_min": 6.94, "longest_pause_s": 417,
                    "thresholds": { "think_min_s": 5, "idle_min_s": 300 } },
    "agents":     { "sidechain": 0, "distinct_agents": 0, "trees": [...],
                    "by_type": [{ "type": "code-reviewer", "count": 37, "sample_descriptions": [...] }, ...],
                    "default_rate": 0.55 },
    "skills":     { "by_name": [{ "name": "fact-check", "count": 19, "sample_args": [...] }, ...],
                    "slash_commands": [{ "name": "challenge-review", "count": 30 }, ...] },
    "projects":   [{ "id": "work-app", "sessions": 267, "tokens": 5410000, "tokens_per_session": 20262,
                     "first_seen": "...", "last_seen": "...", "dominant_model": "claude-sonnet-4-6" }, ...],
    "health":     { "tool_errors": 0, "unresolved_tool_calls": 0,
                    "compaction_events": [...], "context_bloat_ratio": 1.7 },
    "anomalies":  [{ "kind": "null_content", "count": 2, "detail": null },
                    { "kind": "tool_input_truncated", "count": 13, "detail": null }, ...],
    "caveats":    [{ "code": "telemetry_partial_coverage", "message": "telemetry coverage is partial (failed-events only)" },
                    { "code": "pricing_freshness", "message": "valid_through 2026-12-31" },
                    { "code": "unknown_model", "message": "no price row for model X", "detail": { "model": "X" } }]
  },
  "excerpts": {
    "corrections":  [{session, turn, ts, text, surrounding}],
    "questions":    [...],
    "decisions":    [...],     // surfaced from plans/tasks/conversation
    "errors":       [...],
    "samples":      [...]      // per-dimension excerpts for slot use
  },
  "extraction_candidates": {
    "project_context":  [{ project_id, candidate_md, source_evidence }],
    "user_profile":     [{ trait, candidate_md, source_evidence }],
    "correction_rules": [{ pattern, candidate_md, source_evidence }]
  },
  "suggestions": [
    {
      "target_type": "global_claude_md" | "memory_user" | "memory_feedback" | "project_md",
      "project_id": "<id>",          // present iff target_type=project_md
      "file": "/absolute/path/to/target.md",
      "target_exists": true | false,
      "action": "new" | "update_replace",
      "body": "...markdown to write (frontmatter + Why + How to apply for memory_*)...",
      "replaces": "...substring to replace (only when action=update_replace)...",
      "rationale": "directive-form sentence with inline evidence cite"
    }
  ],
}
```

**R2 contract (binding)**: `clens report` always returns `suggestions: []`. The
Skill caller fills the unified `suggestions` slot with a JSON-stringified
`{suggestions: [...]}` payload; `clens fill` validates the shape (4-way
target_type taxonomy, new vs update_replace action, absolute path, body
non-empty, memory frontmatter requirements) and emits the validated array on
its own stdout. The CLI does NOT decide targets, dedupe against existing
content, or rewrite directives — those decisions are slot-side per §3.

The Markdown report is a deterministic render of this JSON, with fenced `clens-slot` blocks (see §10) where Claude's judgment is required.

## 10. Slot System

Two slot families (Markdown is the only place slots appear; JSON is slot-free fact data). **All slots use the canonical fenced grammar defined below — the `{{SLOT:}}` brace form does not exist in any rendered output.**

1. **Judgment slots** — Claude judges *which of these candidates are real*. Example (illustrative — see canonical grammar for actual syntax):
   - `name: corrections`
   - `task: Identify which candidates are genuine scope changes vs filler. Output a Markdown bullet list.`
   - `payload: { "candidates": [...{turn, text, surrounding}...] }`
2. **Synthesis slots** — Claude composes a short narrative from a structured payload. Example:
   - `name: one_liner`
   - `task: One sentence: what was this session about?`
   - `payload: { "first_user_msg": "...", "last_user_msg": "...", "top_topics": [...] }`

### Slot grammar (canonical)

Terminals: `NL = "\n"`, `NAME = [a-z_][a-z0-9_]*`, `LINE = any chars excluding NL`, `JSON = any single valid RFC 8259 JSON value`.

A slot is a single fenced block. The opening fence is exactly four backticks plus the language tag `clens-slot`, so it nests cleanly with any user-pasted triple-fenced code:

```
````clens-slot
name: corrections
task: Identify which candidates are genuine scope changes. Output a Markdown bullet list.
payload:
```json
{ "candidates": [ ... ] }
```
````
```

EBNF:
```
slot      = "````clens-slot" NL header payload-block NL "````"
header    = "name:" NAME NL "task:" LINE NL
payload-block = "payload:" NL "```json" NL JSON NL "```"
```

Slot rules:
- Each `name` is unique within one Markdown document.
- `task` is a single-line directive.
- `payload` is bounded (default 4096 chars total, configurable via `--max-excerpt-chars`); when truncated, payload includes `"truncated": true` and CLI logs an `anomaly`.
- The Skill replaces the **entire slot block (fence to fence)** with Claude-generated Markdown. Surrounding text is never modified.
- `--no-slots` renders slots as `<details><summary>slot: name</summary><pre>payload JSON</pre></details>` so non-Claude consumers still see the raw evidence.
- If Claude returns text but does not consume a slot block, the Skill emits a warning header and leaves the original slot intact (no silent loss of evidence).

### Slot malformed-response handling (precise rules)

A returned slot replacement is **malformed** iff any of the following:
- The opening/closing fence is missing or mismatched.
- The `name:` header is missing or does not match the original slot's `name`.
- The replacement contains a nested `clens-slot` fence (slot regeneration is forbidden).
- The replacement exceeds `--max-excerpt-chars × 4` bytes (anti-runaway).

Handling per condition:
- **Missing replacement** (Claude returned text but didn't touch the slot) → keep original slot, prepend `> ⚠ slot '<name>' was not filled` warning above it, increment `anomalies.slot_unfilled`.
- **Malformed replacement** → revert to original slot, prepend `> ⚠ slot '<name>' returned malformed; reverted to evidence` warning, store offending text in `--out/slot-errors/<name>.txt`, increment `anomalies.slot_malformed`.
- **Multiple slots returned for one name** → use the first; discard rest with `anomalies.slot_duplicate_response`.

### Corrections candidate selector (deterministic algorithm)

`excerpts.corrections.candidates` is populated by this exact procedure over a session's `user_text` rows in chronological order:

1. For each row `r` with `user_turn_no IS NOT NULL` and `is_command = 0`, evaluate:
   - `KW = ["아니", "잠만", "그게 아니", "말고", "stop", "틀렸", "wrong", "not that", "다시", "취소", "undo", "근데", "다르게", "instead", "rather"]` (case-insensitive, Unicode-normalized NFC).
   - A row matches if it contains any element of `KW` as a substring AND `text_len` is between 4 and 1000 chars (filters out tool-result blobs and trivial confirmations).
2. Each match yields one candidate:
   ```jsonc
   { "turn": user_turn_no, "ts": ts, "text": text,
     "surrounding": { "prev_assistant_excerpt": <last 400 chars of preceding assistant>,
                       "next_assistant_excerpt": <first 400 chars of next assistant> } }
   ```
3. Cap at the top 16 candidates per session (by chronological order). Truncation increments `anomalies.corrections_truncated`.

The selector is intentionally generous (high recall, low precision); slot judgment downstream filters out filler. **Authoritative gates for v1**: §14 gate 6 (CLI-only, deterministic) asserts that this selector's `candidates[]` output **contains** the three semantic scope-change turns `{3, 4, 6}` as a subset (measured against the committed fixture). The exact-set "exactly these three, nothing else" assertion belongs to the slot-filtered `confirmed[]` output produced by the calling Claude — see §14 gate 7. This two-tier structure mirrors the §0 design invariant: the CLI gives a high-recall candidate list; the Skill caller reduces it to the real scope-changes. If a future fixture change shifts the candidate set, §14 gate 6's subset assertion still holds for any fixture that includes the same three semantic scope-changes; if the *semantic* set changes, both gates must be revised.

## 11. Analysis Dimensions (v1)

Validated against author's real data:

| # | Dimension | Determinism | Slot? |
|---|---|---|---|
| 1 | Cost decomposition (per token-type, per turn) | full | no |
| 2 | Token trajectory + context bloat ratio | full | no |
| 3 | Cache efficiency (per turn + total savings) | full | no |
| 4 | Tool usage (counts, sequences, durations, errors) | full | no |
| 5 | Turn shape (text/tool/mixed) | full | no |
| 6 | Timeline (wall vs think vs idle gaps) | full | no |
| 7 | File targets (Read/Edit/Write hot-spots, repeat-edit) | full | no |
| 8 | Subagent / sidechain graph | full | no |
| 9 | Health (tool errors, unresolved calls, compaction events) | full | no |
| 10 | **Skill / slash-command usage** — two distinct counters reported side by side: (a) `skills.by_name` = `Skill` tool_use rows only (always Skills); (b) `skills.slash_commands` = `<command-name>` rows only (any slash command including non-Skill ones like `/clear`, `/help`, `/config`). The two are NOT summed — they are reported separately so a fresh agent or user can see both. Top-N, per-project breakdown, and token cost estimate per Skill invocation window (Skill rows only). | full | no |
| 11 | **Subagent usage** — counts by `subagent_type` (from `Agent` tool_use input.subagent_type); top-N, per-project breakdown, **`<default>` rate as an anomaly metric** (heavy default-rate suggests user underspecifies agent type), description samples per type | full + samples | **yes** (synthesis, "why was this agent used") |
| 12 | **Project usage map** — per-project session count, cumulative tokens, tokens-per-session ratio (heavy-session detector), date range, dominant model | full | no |
| 13 | User signals (correction / question candidates) | candidate-only | **yes** (judgment) |
| 14 | One-liner / topic summary per session | none | **yes** (synthesis) |
| 15 | Decisions / agreements per project (from plans + tasks + conversation) | candidate-only | **yes** (synthesis) |
| 16 | User profile traits (cumulative) | candidate-only | **yes** (synthesis) |
| 17 | Recurring correction patterns | candidate-only | **yes** (synthesis) |

System-reminder / compaction parsing **requires a dedicated parser** (verified during brainstorming that a one-line regex misses them). The parser scans `user_text.text` for `<system-reminder>...</system-reminder>` blocks, normalizes whitespace, then classifies via this fixed taxonomy (anything not matching → `category = "other"`).

**Classifier semantics**: **first match wins, and table order IS priority.** A reminder body that satisfies more than one row is assigned the topmost matching row. E.g. "SessionStart hook success: OK" → `hook_success` (NOT `session_start`), because `hook_success` is row 1. Reordering the table is a behavior change and requires a spec revision.

| category | match rule (substring, case-insensitive) |
|---|---|
| `hook_success` | `"hook success"` or `"hook additional context"` |
| `task_reminder` | `"task tools haven't been used"` or `"consider using TaskCreate"` |
| `compaction` | `"context was compacted"` or `"prior messages"` `+` `"summarized"` |
| `available_agents` | `"Available agent types for the Agent tool"` |
| `available_skills` | `"The following skills are available"` |
| `available_tools` | `"deferred tools are now available"` |
| `session_start` | `"SessionStart"` |
| `user_prompt_submit` | `"UserPromptSubmit"` |
| `other` | anything else |

Each parsed reminder yields a row in `system_reminder(event_uuid, ts, category, text_excerpt)` (text capped 512 bytes). Adding new categories does not invalidate existing rows — they remain `other`.

### Extraction-suggestion quality bar (v1)

`extraction_candidates` is populated from analyzer rollups. Each category has a minimum-evidence threshold; below it, no candidate is emitted (and `caveats[]` reports the empty result is intentional, not a bug):

- **`project_context`** (per-project) — emit when a project has `≥ 5 sessions` AND (`≥ 1 plan_doc` OR `≥ 3 corrections that share a common keyword token across distinct sessions`). "Common keyword token" means the top-1 normalized keyword (Korean noun phrase or English noun) extracted from each correction text appears in ≥3 sessions — operationalized as: bag-of-words intersection over correction texts grouped by session, retaining tokens present in `≥ ⌈sessions_in_project × 0.4⌉` distinct sessions, minimum 3. The `candidate_md` is a 1-3 sentence summary the slot-fill stage drafts from `decisions + plans` evidence.
- **`user_profile`** — emit when a trait shows `≥ 3 distinct sessions` of evidence across the whole corpus. Traits considered: tool-usage skew (Bash-heavy vs Read-heavy), model preference (Opus-leaning vs Sonnet-leaning), pushback frequency, language preference (heuristic: ≥80% of `user_text` is Korean vs English).
- **`correction_rules`** — emit when the same correction keyword + same target topic occurs `≥ 3 times across distinct sessions`. The `pattern` field captures the regularity; `candidate_md` is a "do this / don't do this" rule.

**R2 split of responsibility (binding)**: the CLI emits *candidates with evidence only* (per_project_count, cross_project_count, sample turns, semantic anchors). It does NOT decide `target_type`, does NOT dedupe against existing target-file content, and does NOT compose directives. Those decisions live in the slot consumer (the calling Claude in the Skill handshake §12):

1. The Skill reads four target files first (`~/.claude/CLAUDE.md`, `~/.claude/memory/` index + relevant files, `<project>/CLAUDE.md`).
2. For each candidate, the slot classifier picks one of:
   - **already covered** in a target file → skip silently;
   - **conflicts** with existing content → emit suggestion with `action: "update_replace"` and an exact `replaces` snippet;
   - **new and valuable** → emit with `action: "new"`.
3. The slot picks `target_type` via the 4-way taxonomy:
   - cross-project core policy → `global_claude_md` (cap at ≤10 bullets total).
   - sticky user attribute (lang, tool skew, model preference) → `memory_user` (`~/.claude/memory/user_<slug>.md`, frontmatter `type=user`).
   - correction / pushback pattern → `memory_feedback` (`~/.claude/memory/feedback_<slug>.md`, frontmatter `type=feedback`, body MUST carry `**Why:**` + `**How to apply:**`).
   - single-project pattern (`cross_project_count == 1`) → `project_md` (`<project cwd>/CLAUDE.md`).

The CLI's `clens fill` command is the only place the slot's JSON output is parsed; it validates shape (`target_type` ∈ 4-way, `action` ∈ {new, update_replace}, `file` absolute, body non-empty, frontmatter present on memory targets) and emits the validated `suggestions[]` on its own stdout. Invalid entries write to `<out>/slot-errors/suggestions.failures.json`. The CLI never reroutes a slot decision.

Phase D's exit (§17) requires gate 6 plus: at least one valid `extraction_candidate` is produced when running `clens extract` against the **synthetic corpus** (Phase 0's `synth-corpus.ts` output). Because synth-corpus replicates the fixture across many synthetic sessions with preserved cardinalities, all three `≥ 3` thresholds in §11 are met by construction. The single-fixture run (`clens session test`) is used only for gate 6's corrections-turn assertion; extraction-candidate quality is tested on synth-corpus where the thresholds become meaningful.

**Timeline pause classification (Dimension 6)**:
- `inter-event-gap`: any gap between consecutive events.
- `think_pause`: gap in `[5s, 5min)` — counted toward `timeline.think_min`.
- `idle`: gap `≥ 5min` — counted toward `timeline.idle_min`.
- `<5s` is considered model/tool latency and excluded from both.

Thresholds are constants in `analyzer/timeline.ts` and emitted in `facts.timeline.thresholds` for transparency.

## 12. Skill Definition

**Repository layout** (`clens` is a single standalone OSS repo on GitHub, published to npm as `clens`):

```
clens/                                  ← repo root
  package.json                          # name="clens", bin={clens:"dist/cli.js"}
  tsconfig.json
  README.md
  LICENSE                               # MIT
  data/
    pricing.json                        # per §13
    reminder-taxonomy.json              # per §11
  src/
    cli.ts                              # commander/yargs entry
    indexer/
      parser.ts                         # JSONL → row producers, per §6.5
      schema.ts                         # CREATE TABLE statements, per §7
      cursor.ts                         # file_cursor + incremental
      kind-resolver.ts                  # session.kind / parent_id
    analyzer/
      cost.ts          tokens.ts        cache.ts
      tools.ts         files.ts         agents.ts
      timeline.ts      skills.ts        projects.ts
      user-signals.ts                   # corrections selector, per §10
      extraction.ts                     # candidate quality bar, per §11
    renderer/
      markdown.ts                       # Markdown template engine + slot emission
      slot.ts                           # fenced grammar parser/printer
      json.ts                           # canonical JSON shape, per §9
    commands/
      index.ts  report.ts  session.ts  extract.ts  stats.ts  doctor.ts
    util/
      lockfile.ts  pricing.ts  paths.ts
  skills/                               ← shipped to skill marketplace; references the npm bin
    clens/
      SKILL.md
  test/
    fixtures/
      brainstorm-session.jsonl          # Phase 0 output, redacted
      brainstorm-session.expected.json  # expected gates fixture
    scripts/
      redact.ts                         # author-machine fixture extractor
      synth-corpus.ts                   # 1.5× synthetic corpus generator
    parity.spec.ts
    indexer.spec.ts
    analyzer.spec.ts
    slot.spec.ts
  .github/workflows/
    ci.yml                              # lint + tests + gates 1,2,4,5,6
    nightly.yml                         # gate 3 portable perf
```

The Skill (`skills/clens/SKILL.md`) is committed to the same repo but published separately to the Claude Code Skill marketplace; it does NOT contain TypeScript. It contains instructions for the calling Claude (per §12 handshake) that invoke the npm-installed `clens` binary.

**Runtime directory layout** (what `clens` creates on the user's machine):

```
~/.claude/clens/
  index.db                          # SQLite (WAL mode)
  index.db-wal                      # SQLite WAL
  index.db-shm                      # SQLite shared memory
  index.db.lock                     # advisory lockfile, per §7 concurrency
  reports/
    20260621-143015-a8f3c2/         # one dir per `clens report` run
      report.md
      report.json
      slot-errors/                  # only if slot malformed responses observed
        <slot-name>.txt
```

A `clens doctor --gc` flag (v1.x optional) prunes old report directories; v1 leaves them all (they are user data and the directories are small).

SKILL.md description (draft):

> Analyze local Claude Code session data with `clens`: cumulative reports, per-session reports, and reusable extraction suggestions for CLAUDE.md / memory. **Use when**: the user asks about their Claude usage, cost, sessions, project context, profile, or wants to recycle past decisions.

### Skill ↔ CLI runtime handshake (precise contract)

The Claude Code Skill runtime invokes a skill by reading its `SKILL.md` and following the instructions there. `clens`' SKILL.md instructs the **calling Claude** (not a script) to follow this loop:

1. **Invoke**: Claude calls `Bash` (or equivalent) to run `clens <mode> --format both --out <unique-tmp-dir>`. `<mode>` is `report` (default), `session current`, or whatever the user asked for. The CLI **automatically builds or updates the index on first use** per §8 "Auto-index policy" — the Skill does NOT need to call `clens index` first. On a cold install the CLI prints a `building index...` line to stderr; Claude should pass this through to the user so they understand a one-time delay. The stdout of the `both` invocation prints the resolved `--out` path; Claude reads that path.
2. **Load**: Claude reads `<out>/report.md` and `<out>/report.json` via the `Read` tool.
3. **Read the four target files** (R2 invariant — the CLI does NOT decide targets or dedupe; the Skill does):
   - `~/.claude/CLAUDE.md` (global policy).
   - `~/.claude/memory/MEMORY.md` index + every relevant memory file (`Bash ls -1 ~/.claude/memory/*.md`, then `Read` whatever matches candidates surfaced in `report.json.extraction_candidates`).
   - If invocation was `--project X`: `<project cwd>/CLAUDE.md` (lookup the cwd in `report.json.facts.identity` or via `Bash`).
   - If invocation was global: the project-local `CLAUDE.md` of any project surfaced in `extraction_candidates.project_context` (best effort — skip when cwd unknown).
4. **Fill slots**: Claude scans `report.md` for `clens-slot` fenced blocks. For each block:
   - Parse `name`, `task`, `payload` per §10 grammar.
   - Cross-reference `payload` against `report.json.excerpts[<name>]` for fuller evidence if needed.
   - Generate the replacement per the slot's `task` directive. The `suggestions` slot's reply is a JSON STRING (the object `{suggestions: [...]}` stringified) following the 4-way taxonomy in §11; all other slots are plain Markdown.
5. **Substitute back**: either call `clens fill --in slots.json` (it validates the suggestions JSON shape and emits the validated `suggestions[]` array on stdout) or paste the rendered Markdown directly to the user, replacing each fence-to-fence block.
6. **Render**: Claude assembles the final Markdown (deterministic facts unchanged + filled slots) and emits it to the user as the final response.
7. **Apply on accept (optional)**: For each entry in `clens fill`'s `suggestions[]`, Claude surfaces target/diff/rationale and asks the user yes/no. On yes: `action == "new"` → `Write` the file with `body`; `action == "update_replace"` → `Read` + literal substring replace of `replaces` → `Write`. Never `Edit` for accept/apply. v1 ships *suggestions only* — explicit user `yes` per entry.

SKILL.md ships the slot-filling rubric verbatim so the prompt is reproducible across model versions. The CLI itself contains no LLM invocation; it never knows whether a Skill is calling it or a cron job.

**Why this works without an SDK**: Claude Code's Skill runtime executes Markdown SKILL.md instructions as if the user had pasted them. `clens` exploits this by treating the calling Claude as the slot-fill engine. No new Skill API is required.

## 13. Distribution

- npm package `clens` — `bin: { clens: dist/cli.js }`.
- Install: `npm i -g clens` or `npx clens`.
- Skill marketplace entry referencing the npm bin.
- License: MIT (placeholder; confirm before publish).
- Telemetry: **none**. The CLI never talks to network.
- **Pricing table**: bundled at `data/pricing.json` with a `valid_through` ISO date and per-model entries.
  ```json
  {
    "valid_through": "2026-12-31",
    "currency": "USD",
    "per_million_tokens": {
      "claude-sonnet-4-6":  { "in": 3.00, "out": 15.00, "cache_r": 0.30, "cache_w": 3.75 },
      "claude-opus-4-7":    { "in": 15.00, "out": 75.00, "cache_r": 1.50, "cache_w": 18.75 },
      "claude-opus-4-8":    { "in": 15.00, "out": 75.00, "cache_r": 1.50, "cache_w": 18.75 },
      "claude-haiku-4-5":   { "in": 0.80, "out": 4.00, "cache_r": 0.08, "cache_w": 1.00 }
    },
    "alias": {
      "claude-sonnet-4-6":  ["global.anthropic.claude-sonnet-4-6", "apac.anthropic.claude-sonnet-4-6-*"],
      "claude-opus-4-7":    ["global.anthropic.claude-opus-4-7*"],
      "claude-haiku-4-5":   ["claude-haiku-4-5-20251001"]
    }
  }
  ```
  Models not in the table contribute to a `caveats[]` warning and their cost is reported as `null` (rather than fabricated). `valid_through` past today's date emits another `caveats[]` entry.

  **⚠ Pricing values above are placeholders.** The per-million-token numbers shipped in this ExecPlan have NOT been verified against Anthropic's official price list. **Before any v1 publish to npm or the Skill marketplace, the implementer MUST replace these values with prices fetched from Anthropic's current pricing page and update `valid_through` accordingly.** A pre-publish gate (§17 Phase F exit) blocks release if `data/pricing.json` still contains the placeholder values verbatim — the build step compares against a known-placeholder digest and refuses publish on match.

  **Cost formula (v1)** — applied per assistant event row, summed up:
  ```
  cost_event = (in_tok * price.in
              + out_tok * price.out
              + cache_r * price.cache_r
              + cache_w * price.cache_w) / 1_000_000
  ```
  Where `price` is the per-model row from the pricing table, matched by exact model id OR the longest matching alias pattern (`alias` values are matched as fnmatch globs, so `apac.anthropic.claude-sonnet-4-6-*` matches dated variants). If no model row matches, `cost_event = null` and `caveats[].unknown_model` lists the model id once.

  v1 does **not** model: per-model cache-billing variations (Anthropic's billing for `cache_r` varies slightly across some model generations), per-region surcharges, batch-API discounts. These are documented as `caveats[]` entries on every report so users don't treat the number as bill-exact.

## 14. Validation Plan

Each milestone has a *deterministic* exit gate. Gates run against two corpora:
- **fixture corpus**: a small, redacted, checked-in set under `test/fixtures/` (portable, used in CI and by external contributors)
- **author corpus**: the real `~/.claude/` on the author's machine (used for perf and end-to-end realism; marked *author-local*)

1. **Indexer line-accounting** — `event` is one row per JSONL line. After full build the invariant
   `sum(file_cursor.lines) == sum(event count grouped by source file) + sum(parse_errors)`
   holds across both corpora. Multi-content-block messages stay as **one** event row; their content blocks live in `tool_call` / `user_text` / `file_op` and reference back via `event.uuid`.
2. **Incremental correctness** — modify the most recent session file in the fixture corpus and re-run `clens index`; only that file's `file_cursor` row changes (verified by row-level diff). A follow-up `--rebuild` produces a sqlite database where, for every table, **the multiset of rows sorted by primary key is identical** to the incremental build's. Implementation: `clens stats --digest` emits a per-table SHA-256 of canonically sorted rows; the digest is equal between both runs.
3. **Perf** — the **CI-enforced gate** is the portable synthetic corpus at 1.5× author-scale (1,000 sessions / 500 MB / 1M events, created by `test/scripts/synth-corpus.ts`): full build ≤15 s on a modern laptop CI runner. The 2 s author-local number (measured 2.28 s baseline) is illustrative only — not a CI gate, recorded for regression tracking.
4. **Slot payload bound** — no rendered slot's `payload` field exceeds `--max-excerpt-chars`; on truncation `payload.truncated === true`. Asserted by a unit test fed an oversized candidate set.
5. **JSON ↔ Markdown parity** — for every numeric fact appearing in `report.md`, a matching path exists in `report.json` with the same value (rendered numbers normalized to canonical form). A `test/parity.spec.ts` walks the Markdown using anchored patterns (`\$\d+(?:\.\d{2,})?`, `\d+(?:\.\d+)?%`, `[\d,]+ tokens`) to avoid false positives, and asserts each match maps to a JSON node.
6. **Excerpt candidate gate (fixture, CLI-only)** — given `test/fixtures/brainstorm-session.jsonl` (a redacted snippet of this brainstorming session, with all paths and identifiers scrubbed), `clens session test --format json` produces an `excerpts.corrections.candidates[].turn` set that (a) **contains** `{3, 4, 6}` as a subset — those are the three real scope-changes (drop-FTS / OSS-pivot / Skill-caller-LLM responsibility) — and (b) has size ≤ 16 (the §10 selector cap). This is a CLI-only gate (no Claude in the loop). The exact-set assertion ("only those three, nothing else") belongs to gate 7's slot-filtered `confirmed[]` output.
7. **Skill round-trip with confirmed-set assertion (fixture)** — for the same fixture, running the Skill end-to-end (CLI candidates → Claude slot fill) produces a Markdown report whose corrections section, when parsed back to JSON via `excerpts.corrections.confirmed[].turn`, equals **exactly** `{3, 4, 6}`. This gate IS blocking for Phase E exit but is not enforced in CI by default (because it requires a live Claude call); a `vitest --run --testNamePattern skill-round-trip` invocation with the `CLAUDE_API_KEY` env var present runs it. A degraded CI variant asserts only that the `confirmed[]` field is non-empty, to catch total breakage.

## 15. Risks & Open Questions

| Risk | Mitigation |
|---|---|
| Schema drift in Claude Code's JSONL format | Strict parser with `schema_version` per row, soft-fail on unknown fields, log unknowns to `anomalies`. |
| `~/.claude/` path differs on Windows / non-mac | Use `os.homedir()` + `path.join`; spec windows path (`%USERPROFILE%\.claude`) in v1 manual but defer Windows testing to v1.1. |
| Pricing table goes stale → cost numbers misleading | Ship a static pricing JSON with a `valid_through` date; `caveats[]` always emits a freshness warning. |
| Slot-filling Claude ignores format | Skill prompt explicitly requires "replace slot in place, do not modify surrounding text"; if violated, fall back to rendering raw JSON. |
| User runs CLI while a Claude session is mid-flush | Acceptable; indexer reads with shared lock, tolerates partial last line. |
| Tasks/plans folders evolve | Treat them as best-effort enrichment; missing folders never block the main report. |
| Identifying *subagent* sessions vs main sessions | Use the existing `subagents/` subdir convention + `agentId` field; record `session.kind`. `session current` filters to `kind='interactive'` so we never accidentally pick a subagent flush as "the current session". |
| User pushes back on data extraction touching sensitive content | Default `extract` runs **fully offline**, writes only to `--out` dir; default `--out` is `~/.claude/clens/reports/<ts>/` (outside any repo); a `clens doctor` warning fires if `--out` resolves inside a git working tree; no automatic write to `CLAUDE.md` (v1 scope guarantee). |
| Cost numbers drift from Anthropic Console | Pricing JSON is bundled with `valid_through` date; `caveats[]` warns when stale. Models not in the price table report `cost = null` rather than fabricating. Cache billing nuances across model versions are not modeled; documented in caveats. |

## 16. Out of Scope for v1 (revisit list)

- Web dashboard (v2: local web server + interactive HTML, consuming same JSON; later allow click-to-apply suggestions).
- File-history table (v2 if signal proves valuable).
- Auto-applying suggestions to `CLAUDE.md` / memory (v2 candidate with strong guards).
- Windows-specific testing.
- Multi-version Claude Code JSONL migration (assume current 2.x format; add migration if breakage observed).

## 17. Execution Phases (high-level)

0. **Phase 0 — Fixture & Repo Scaffold (prerequisite for everything else)**:
   - Initialize the standalone `clens` repo (TypeScript + Node ≥20, `package.json`, `tsconfig.json`, `eslint`, `vitest`).
   - Create `test/fixtures/brainstorm-session.jsonl`: a redacted excerpt of the brainstorming session that produced this plan. **Source-file identification (deterministic)**: among `~/.claude/projects/-Users-me-IdeaProjects-tdd-test/*.jsonl` on the author's machine, pick the file with the highest count of substring `"Fat-CLI"` (and `"Fat CLI"`); ties broken by largest file size. The intended file at writing time is `51ead4dc-3663-4e05-9b56-355b53ee9698.jsonl` (verified: brainstorming keywords `Fat-CLI`/`clens-slot`/`brainstorm-session` total 58 hits in this file vs 11 in the next candidate, confirming unique identification). Redact via `test/scripts/redact.ts`. The fixture must contain at least the three known scope-change user turns (measured user-turn numbers `{3, 4, 6}` in the redacted output as of 2026-06-21) with surrounding context. **All `sessionId` values inside the fixture are rewritten to the literal string `test`**, and all event `uuid`s are rewritten to `evt-<n>` where `<n>` is the line ordinal — so subsequent gates can reference the fixture by deterministic ids (`clens session test`).
   - Document the fixture's expected `excerpts.corrections` set in `test/fixtures/brainstorm-session.expected.json`. **Measured value (2026-06-21)**: `{ "corrections": { "turns": [3, 4, 6] } }`. **Verification procedure used**: after the fixture is redacted, the three human-authored user messages that announce the scope changes were identified — (1) "대화 검색은 아니야 A B C E" (drop FTS), (2) "나혼자 쓸꺼는 아니야 소스를 배포할거야" (OSS pivot), (3) "잠만 일단 cli 로 만들걸때 스킬로 사용할거야 글머 OSS 사용자가 자기 API 키 이거필요 없지 않냐" (Skill-caller LLM responsibility). Their `user_turn_no` per §6.5 over the redacted fixture is `{3, 4, 6}`. **If a future fixture regeneration changes the semantic scope-changes themselves, re-derive `user_turn_no` and update both `expected.json` and §14 gate 6/7 in the spec**; the three semantic scope-changes (drop-FTS / OSS-pivot / Skill-caller-LLM responsibility) are the binding criterion, the literal numbers are downstream.
   - Add `test/scripts/synth-corpus.ts` that generates a 1.5×-author-scale synthetic corpus (1000 sessions / 500 MB / 1M events) by **deterministic perturbation** of the fixture:
     - Each synthetic session is a clone of the fixture with: (a) new `sessionId` (`synth-<n>`), (b) new `uuid` per event (`evt-<n>-<m>`), (c) `parentUuid` rewritten to the corresponding new uuid so the parent chain stays valid (orphan walks are NOT introduced by perturbation), (d) `timestamp` time-shifted by `n * 1 hour`, (e) `cwd` rotated among 10 synthetic project paths so `project_session_count` distribution is non-degenerate, (f) tool call `input` payloads padded with random whitespace to hit the target byte volume without affecting parse semantics. **Cardinalities preserved**: per-session event count, role distribution, tool name distribution, and turn count are unchanged from the fixture. Token-usage numbers are unchanged (deterministic perturbation does not invent billing).
     - The generator is seeded (`--seed` flag, default `42`) so CI runs are reproducible.
   - Exit: fixture file committed, expected JSON committed, synth-corpus script runs and produces a valid corpus directory passing `clens index --rebuild` without parse errors.
   - **Redactor contract** (`test/scripts/redact.ts`): operates on a single source JSONL file. Replacements applied in order: (i) absolute filesystem paths → `</path/redacted>`, (ii) `~/.claude/projects/<dir>/...` → `<corpus>/.../`, (iii) any string matching `sk-[A-Za-z0-9_-]{20,}` / `AKIA[A-Z0-9]{16}` / `eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+` → `<redacted-secret>`, (iv) all `sessionId` rewritten to `test`, (v) all `uuid` rewritten to `evt-<line-ordinal>`, (vi) `parentUuid` rewritten consistently to maintain the chain, (vii) `cwd` rewritten to `/fixture/cwd`, (viii) `gitBranch` preserved. Output is line-by-line one-to-one; redactor never inserts or drops lines.
1. **Phase A — Indexer**: parser, schema, full + incremental index, doctor command. Exit: gates 1–3 pass.
2. **Phase B — Analyzer (deterministic dimensions 1–12)**: SQL queries + JSON shaping for cost, tokens, cache, tools, turn shape, timeline, files, agents, health, skill usage, subagent usage, project usage map. Exit: running `clens session test --format json` on the fixture produces a JSON whose key facts diff cleanly against `test/fixtures/brainstorm-session.expected.json`, which contains at minimum:
   ```jsonc
   {
     "facts": {
       "cost":        { "total_usd_approx": 94.02, "tolerance_pct": 5 },
       "cache":       { "hit_rate_overall_approx": 98.07, "tolerance_percentage_points": 1 },
       "tools":       { "counts_min": { "mcp__plugin_context-mode_context-mode__ctx_execute": 5, "Edit": 70, "Agent": 5 } },
       "timeline":    { "wall_min_approx": 99.36, "tolerance_pct": 5 }
     },
     "scope": { "mode": "session" }
   }
   ```
   `_approx` fields are checked within the per-field `tolerance_pct`. `_min` fields are lower-bound asserts. Other facts (e.g. `agents.by_type`, `projects[]`) get their own per-fixture expected entries as new fixtures are added.
3. **Phase C — Markdown rendering + slot system**: templates, slot block format, `--no-slots` fallback. Exit: gate 5 passes.
4. **Phase D — Excerpt/candidate extraction + suggestion handshake (dimensions 13–17)**: deterministic candidate selection, excerpt windowing, session summary, decisions, profile traits, recurring corrections, AND the unified `suggestions` slot path (R2). Exit (all must pass):
   - **Gate 6** — `clens session test --format json` on the fixture produces an `excerpts.corrections.candidates[].turn` set that contains `{3, 4, 6}` as a subset (and has size ≤ 16 per the §10 selector cap). CLI-only; no Claude in the loop.
   - **Extraction-candidate gate** — `clens extract --format json` against the synthetic corpus produces at least one valid entry in each of `extraction_candidates.{project_context, user_profile, correction_rules}`. Synth-corpus's preserved cardinalities (per §17 Phase 0) ensure the §11 thresholds are met by construction; a failure indicates an analyzer bug, not data shortage.
   - **R2 quality gate** — when the user runs `/clens` end-to-end in Claude Code on a heavy-user corpus (≥200 sessions): (a) ≤ 10 final suggestions in `clens fill` stdout, (b) every suggestion uses one of the 4 `target_type` values, (c) every suggestion's `rationale` is directive form with inline session/project evidence, (d) re-running after the user accepts a subset yields ≈0 new suggestions for the accepted targets (slot dedup against now-existing target content). Failure → iterate on the slot task instructions in §11 / SKILL.md, or extend the parser injection filters (§6.5 anomalies bucket).
5. **Phase E — Skill packaging**: SKILL.md, slot-filling Claude prompt, end-to-end test. Exit: gate 7 passes against `test/fixtures/brainstorm-session.jsonl` — Skill end-to-end produces a Markdown report whose `excerpts.corrections.confirmed[].turn` (after the calling Claude reduces the candidate set) equals exactly `{3, 4, 6}`. Slots are all filled; none left raw. In CI without a live Claude key, the degraded variant only asserts `confirmed[]` is non-empty.
6. **Phase F — npm publish prep**: README, license, version, basic CI (lint + tests + gates 1, 2, 4, 5, 6 run on every PR; gate 3 portable variant runs nightly). **Pre-publish gate**: `data/pricing.json` must NOT match the placeholder digest committed in Phase 0 — i.e. the implementer has fetched current Anthropic prices and replaced the placeholder values. `npm publish` is blocked otherwise.

Each phase ends with a concrete validation run on the author's corpus.

## 18. Next Concrete Action

**For a fresh Claude session picking up this plan**: read §0 in full, then §3, §5, §17. Do not begin Phase A until Phase 0 (fixture creation) is complete and committed. Do not re-litigate the rejected alternatives in §0; if the user raises one, surface that the decision exists and ask for explicit override.

**For the user reviewing this plan now**: approve or list specific revisions. On approval, Phase 0 work can be delegated to any agent that has access to the author's `~/.claude/projects/` data; subsequent phases need only the committed fixture.

## 19. Self-Review Checklist (pre-reviewer)

- [x] Placeholder scan: no `TODO`/`TBD`.
- [x] Consistency scan: scope, mode, language, dimension numbering, table field names match across §6.5 / §7 / §9 / §11 / §14 / §17.
- [x] Scope scan: v1 is contained (no web UI, no auto-apply, no FTS). v2 items explicitly listed in §16.
- [x] Ambiguity scan: slot semantics, schema, exit codes, validation gates are concrete; new tables (`skill_call`, `agent_call`, `slash_command`) have FKs and indexes.
- [x] Assumptions scan: pricing freshness, JSONL format stability, OS path differences are surfaced as risks; `<default>` agent-type sentinel is documented in §6.5.
- [x] Testability scan: every major requirement has a numeric gate in §14; Phase B exit explicitly references skill/subagent/project counts.
- [x] Demand-reality scan: §1 names the desperate user (heavy Claude user), the status quo (no tooling), the trigger (835-session local corpus already exists), AND the empirical signal that skill / agent / project breakdowns are non-trivial (126 skill calls, 346 agent calls with 55% `<default>` rate, 30%-of-traffic project concentration on `work-app`).
- [x] Handoff readiness: §0 covers persona, locked invariants, rejected alternatives, empirical verifications, and "how to resume" — sufficient for a fresh Claude session to begin without re-deriving decisions.

---

**Completion status**: PENDING_APPROVAL — spec quality acceptable, awaiting user yes/no.
