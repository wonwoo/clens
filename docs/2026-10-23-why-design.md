# Why a line of code is the way it is — Design

- **Date**: 2026-10-23
- **Status**: Implemented in 85e1dab (`feat(why): find the session that wrote a line of code`)

## Context

Users ask of code an agent wrote "why is this like this" weeks after the session that wrote it. clens holds that session, but nothing leads from a line of code to it:

- `clens_search` matches conversation text, not code. Searching the rarest identifier on a sampled line found the writing session among the top 10 sessions for 8 of 38 lines in this repo and 4 of 8 in `shop-service` (sessions naming the identifier, counted with a substring match, not the FTS ranking).
- `git blame` → commit subject → `clens_left_off` `commits` works only while history is intact. This repo's `Initial commit` of 2026-10-02 squashed four months of work, so 48 of 60 sampled lines blame to commits no session made under that subject.

Measured on 60 random lines of 25+ characters per repo, committed after the index's first session there:

| | blame → commit → session | an edit wrote the line | either |
|---|---|---|---|
| clens | 12 | 38 | 43 |
| shop-service (team repo) | 13 | 8 | 13 |

Where both found a session (15 lines), it was the same one. Scanning all 14,389 stored edits (14 MB of input) for a string takes 0.03 s.

The reason is rarely at the edit itself. Of the 46 found edits, about 10 had the reason in the text around the edit, about 8 were lines nobody asks about (`import`, `package`), and the rest had only progress notes ("Now the code.") under a request like "진행하자". In the 3 of those read in full, the reason was in the assistant reply just before that request: the proposal the user said yes to (a benchmark, a memory comparison table, a plan with a Decision Log).

**Chosen direction.** Find the stored edit that wrote the text; show the request that started that turn and the reply just before it. Git stays out of clens: the skill runs `git blame` only when no edit is found.

**Constraints.** No schema change and no `SCHEMA_VERSION` bump: the feature reads `tool_call` and `file_op` as they are. The server stays read-only and never runs git. Skills read sessions only through the MCP tools.

**Out of scope.** Raising `TOOL_INPUT_BYTE_CAP`; matching text written by shell commands (`cat > f <<EOF`, `sed -i`); a terminal `clens why` command (no `clens` binary is on PATH); hooks that show the reason unasked.

## Design

### Interface: `clens_left_off` gains `text`

`text` is a fourth mode of `clens_left_off`, beside the list, `session_id` and `commits`. Precedence in the handler: `session_id`, then `text`, then `commits`, then the list.

Schema (`LeftOffParamsSchema` in `src/mcp/server.ts`):

```ts
text: z.string().min(1).optional(),
```

with refinements, checked only when `session_id` is absent:

- `text` without `file` → `Invalid params: text needs file, the file the text is in`.
- `text` with `commits` → `Invalid params: pass text or commits, not both`.
- fewer than 20 non-space characters across the text's lines → `Invalid params: text is too short to tell one edit from another; pass a longer line or a few lines`.

`project_id`, `since` and `until` narrow it; `limit` (default 3, max 10) caps the sessions. `file` takes the same forms as now: an absolute path or its tail.

Tool description, `text` property:

> Text from the file, one line or a few, with file. Returns the sessions whose edits of that file wrote it, the first first, instead of a list: each at its first such edit, with the user's request that started that turn and the assistant reply just before the request, which is what the user answered and often holds the reasons. Read around the request with clens_session. Lines are trimmed and must all appear in one edit; at least 20 characters in all. project_id, since, until and limit narrow it. An edit's input is stored up to 2 KB, so later lines of a long edit or of a large new file are not found.

The tool's opening sentence gains "or, with file and text, the sessions that wrote that text".

### Module: `src/mcp/line_origin.ts` (new)

Owns matching and the result shape. The server calls it; it depends only on `left_off.ts` (for `TOP`, `REAL_MESSAGE`, `REQUEST_CHARS`, `REPLY_CHARS`, which become exports) and `scope.ts` (`notCopiedClause`).

```ts
export interface LineOrigin {
  /** The session at the top of the tree: a subagent's edit is its parent's. */
  session_id: string;
  project_id: string | null;
  source: string;
  /** ts of the session's first edit that wrote the text. */
  edited_at: string;
  /** The tool_call name: Edit, Write, NotebookEdit, apply_patch or exec. */
  tool: string;
  /** The real user message at or before edited_at in session_id, cut to REQUEST_CHARS. */
  request: { ts: string; text: string } | null;
  /** The real assistant message before request.ts in session_id, cut to REPLY_CHARS. */
  reply_before: { ts: string; text: string } | null;
}

export function lineOrigins(
  db: Database.Database,
  file: string,
  text: string,
  params: Pick<LeftOffParams, "project_id" | "since" | "until" | "limit">,
): LineOrigin[];

export function formatLineOrigins(file: string, origins: LineOrigin[]): string;
```

**Text.** Split on newlines, trim each line, drop empty lines. The 20-character check runs in the schema, so `lineOrigins` assumes it holds.

**Candidates.** One query:

- `file_op f` with `f.tool IN ('Edit','Write','NotebookEdit','apply_patch')` and `f.path = ? OR f.path LIKE '%/' || tail` (the rule `leftOffWithMore` uses for `file`);
- joined to `tool_call t` on `event_uuid` and `session_id`, `t.name IN ('Edit','Write','NotebookEdit','apply_patch','exec')`. In the index no event holds more than one edit call; 468 events hold several `file_op` rows, all multi-file patches;
- `notCopiedClause('t.event_uuid', 't.session_id')`, so a resumed session's copied lines are not a second writer;
- the longest line as a prefilter, in raw and JSON-escaped form: `instr(t.input_json, ?) > 0 OR instr(t.input_json, ?) > 0`;
- `TOP` for the root session; `project_id`, `since`, `until` on `s.project_id` and `t.ts`;
- ordered by `t.ts`.

No session-kind filter, as in `commitSessions`: a one-shot run that wrote code is still where the code came from.

**Wrote, not quoted.** A candidate counts only when every line is in the text the edit put in the file, not in text it replaced:

| tool | where the new text is |
|---|---|
| Edit | after the `"new_string"` key, JSON-escaped |
| Write | after the `"content"` key, JSON-escaped |
| NotebookEdit | after the `"new_source"` key, JSON-escaped |
| apply_patch | lines starting with `+` in the section under the header (`*** Update File:` / `*** Add File:`) whose path equals `f.path` or is its tail |
| exec (Codex code mode calling apply_patch) | the same, inside a string literal: split on real newlines and on the two characters `\n`, and compare in raw and JSON-escaped form |

**Grouping.** Keep each root session once, at its first qualifying edit. Sessions ordered by that edit's ts, oldest first: the first is where the text came from; later ones rewrote or moved it. Cut to `limit`.

**Turn.** For each kept edit, in the root session:

- `request`: the latest message with `role = 'user'` and `REAL_MESSAGE` true, `ts <= edited_at`. A subagent's edit finds the parent's request because the lookup runs on the root.
- `reply_before`: the latest message with `role = 'assistant'` and `REAL_MESSAGE` true, `ts < request.ts`. Null when `request` is null.

**Output** (`formatLineOrigins`), in the style of `formatCommitSessions`:

```
"src/mcp/session.ts": 1 session wrote this text
2026-06-29T08:22:41Z  session:f8215a19-256e-4bf2-95c2-fab90285ec74  project:-Users-me-IdeaProjects-clens  claude  Write
  request 2026-06-29T08:21:14Z: 오케 그럼 그렇게 하자
  reply before it 2026-06-29T08:21:01Z: **Verdict: Confirmed** - 인덱스 없이: SCAN user_text …
```

With several sessions the header reads `N sessions wrote this text, the first first`. With none:

```
"src/mcp/session.ts": no stored edit wrote this text. Edits are stored up to 2 KB, and text written by shell commands is not matched; git blame and the commits parameter may find the commit's session.
```

### Skill: `plugin/skills/why/SKILL.md` (new)

Model-invocable, like `recap`. Frontmatter:

- `name: why`
- `description`: why a piece of code is the way it is, from the session that wrote it. Use when the user asks why a line, value or function in the code is like this, who decided it, "이거 왜 이렇게 했지", "why is this here", with a file, line or code at hand. Not for a past decision with no code at hand (that is `clens_search`).
- `argument-hint: "<file>[:line[-line]] | <code>"`

Steps:

1. **Pin the text.** Read the file. Take one to three lines of the code asked about that are distinctive, 20 or more characters in all: a signature, a condition, a constant, not `}` or an import.
2. **Find the edit.** Call `clens_left_off` with `file` and `text`. Pass the file as its path from the repository root and no `project_id`: a worktree or a moved checkout has another absolute path and another project id. Results name their project; drop one from an unrelated project that only shares the path.
3. **If none, try the commit.** Run `git blame --porcelain -L <n>,<n> -- <file>` and `git log -1 --format=%s <hash>`, then call `clens_left_off` with `commits: [subject]` and this project's `project_id`. Read that session around the commit's ts. A revert or merge subject, or no session, means the line was not written under that subject in an indexed session: say so, do not guess.
4. **Read the decision.** Call `clens_session` with the session and `around_ts` set to the request's ts, `limit: 10`. When the request runs a plan (`/execute-plan <path>`, a path under `docs/`), read that file's Decision Log or the section about this code.
5. **Answer.** First sentence: the reason. Then when and in which session, quoting the user's words or the line of the proposal that holds it. Keep what the record shows apart from inference. With several sessions, the first is the origin.

Rules: sessions only through the clens tools, never transcript files; git commands read-only.

### Known limits

- **Renamed files.** `file_op` keeps the path at the time of the edit, so text in a file renamed since is not found under its new name. `git blame` follows renames, so step 3 of the skill can still reach the session through the commit.
- **Moved lines.** Text moved in from another file (an extracted function) is found at the edit that moved it, whose request explains the move, not the code. When the request is about moving or splitting code, the skill says so and looks for the earlier file with `clens_search` on the function's name.

### Other files

- `src/mcp/left_off.ts`: export `TOP`, `REAL_MESSAGE`, `REQUEST_CHARS`, `REPLY_CHARS`. No behaviour change.
- `src/mcp/server.ts`: schema field and refinements, the `text` branch, the descriptions above.
- `README.md`, `README.ko.md`: one line each under the skills (`/clens:why`, `$clens:why` in Codex).
- `src/mcp/instructions.ts`: unchanged (see Open Questions).

## Open Questions

- **Minimum length.** Whether 20 characters keeps common lines from matching many sessions. Measuring how many sessions match lines of 10–30 characters would settle it. Default: 20.
- **Server instructions.** `SERVER_INSTRUCTIONS` is at 2,033 of its 2,048 characters, so naming the new mode there means trimming another line. Seeing whether agents reach for the skill on "why is this like this" without it would settle it. Default: leave the instructions alone; the skill's description and the tool description carry it.
- **Stored input cap.** How many misses come from the 2 KB cut (501 of 9,400 Edit inputs are cut; a large Write keeps only its start). Counting, over the sampled misses, how many the full transcript line would have matched would settle it. Default: no change; it needs a parse change and a `SCHEMA_VERSION` bump.
- **Shell writes.** How often code reaches a file through `cat > f <<EOF` or `sed -i`. Default: not matched.
- **Decision anchor.** "The reply before the request" was checked on 3 of about 28 cases. Reading 15–20 more would settle whether to also show the request's own previous request. Default: request and reply before it only.

## Implementation Notes

Order:

1. Export the four names from `left_off.ts`; `npm test` still passes.
2. `line_origin.ts` with `test/mcp_line_origin.spec.ts`, built on the in-memory fixture style of `mcp_left_off.spec.ts`. Cases:
   - an Edit's `new_string` holding the line is found; one holding it only in `old_string` is not;
   - Write `content`; NotebookEdit `new_source`;
   - an apply_patch `+` line under the file's header is found; the same line under another file's header, or as a `-` line, is not;
   - Codex `exec` code holding a patch literal;
   - several lines: all in one edit is found; spread over two edits is not;
   - a subagent's edit comes back as its parent, with the parent's request;
   - `request` skips task notifications and bare slash commands; `reply_before` is the assistant message before it;
   - each session once at its first edit, oldest first, cut by `limit`;
   - a resumed session's copied edit is not a second writer;
   - `formatLineOrigins` for one, several and no sessions.
3. `server.ts` branch, schema and descriptions. Add a `clens_left_off` `text` call to `test/scripts/plugin-smoke.mjs` with an Edit in a fixture transcript, so the bundled server is exercised.
4. The skill and the README lines.
5. `npm test`, `npm run build`, commit `plugin/` with the source.

Steps 1–3 fit the `implementation` skill with tests first; step 4 is a document.
