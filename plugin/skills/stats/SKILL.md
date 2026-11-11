---
name: stats
description: |
  Guidance for answering usage-trend questions about the user's Claude Code
  work (which tools/skills/agents they use most, files touched, error rate,
  timeline, which hooks blocked what, which tools' output filled the context)
  via the `clens_stats` MCP tool. Use when the user asks things like
  "요즘 뭐 많이 썼어", "이번 주 통계 보여줘", "무슨 파일 많이 건드렸어", "내가
  스킬 뭐 자주 써", "훅이 뭘 막았어", "컨텍스트 뭐가 많이 먹었어",
  "how often did I use X", "what have I been working on", "which hooks
  blocked me", "what is filling my context" in an aggregate/quantitative sense. Do NOT use for questions about specific
  past conversations, decisions, or message content — that's clens_search /
  clens_recent instead (this skill defers to those explicitly).
when_to_use: |
  Trigger when the question is about usage patterns/aggregates (counts,
  trends, "how much/how often") rather than "what did we talk about" or
  "what did we decide". If unsure which bucket a question falls into, ask:
  would a number answer this, or does it need the actual conversation text?
  Numbers → this skill. Text → clens_search/clens_recent.
---

# clens stats

Runtime guidance for calling the `clens_stats` MCP tool correctly and
consistently, regardless of which project this session is running in.

## When this applies

Use `clens_stats` for aggregate/quantitative questions: tool usage counts,
tool failures per tool, skill/slash-command usage, subagent usage, health signals (errors,
compaction, context bloat), timeline (active time with its think part, and
idle time), files touched,
hook blocks (which hook refused which tool, with the latest reasons) and tool
output size (characters of text each tool's results added to the
conversation). The last two cover Claude Code and Codex sessions. Files touched
counts Read, Edit and Write calls and the files shell commands wrote, as tool
`Bash` (Claude Code) or `exec_command` (Codex); a shell command's files under
a temporary folder (`/tmp`, a scratchpad) are left out.

Do **not** use it for anything that requires actual message content —
"what did I say", "what did we decide", "find where I discussed X". Those
go to `clens_search` (keyword/topic) or `clens_recent` (time-anchored
recent activity) instead. If a request mixes both ("이번 주에 뭐 많이 고쳤고,
그때 무슨 얘기했어") answer the aggregate part with `clens_stats` and the
content part with `clens_recent`/`clens_search` separately — don't try to
force one tool to answer both.

## How to call it

1. **Pick the scope.**
   - A question about the current project (the default): derive `project_id`
     from the current working directory by replacing every `/` with `-`. Do
     this yourself from your known cwd — don't ask the user.
   - A question about every project ("전체", "모든 프로젝트", "across all my
     work"): omit `project_id` and `session_id` both.
   - A question about this conversation ("이 세션에서", "this session"): pass
     `session_id: "current"` (Claude Code and Codex). Session stats count only that
     session's own calls, not the subagents it started.
2. **Default scope is the last 1 month** — if the user doesn't name a time
   window, set `since` to the date one month before today, not `undefined`. Do not
   default to "today"/"recent" (too narrow) or all-time (too broad for a
   long-running project) on your own — 1 month is the standing default
   unless the user says otherwise.
3. If the user does name a window (today, this week, since a date, last N
   days, or explicitly "all-time"/"전체"/"처음부터"), compute `since`
   accordingly as a date, YYYY-MM-DD, the start of that day in local time
   (the same forms as `clens_recent`/`clens_search`) — or omit `since`
   entirely when they explicitly ask for all-time.
4. Load the tool schema via ToolSearch (`select:mcp__clens__clens_stats`) if
   it isn't already loaded, then call it with the scope from step 1 and
   `since` (optional per above). `project_id` is optional. When the question
   needs only some sections, pass `sections` (any of `tools`, `skills`,
   `agents`, `health`, `timeline`, `files`, `hook_blocks`, `tool_output`)
   to keep the answer short: `hook_blocks` for "what did my hooks block",
   `tool_output` for "what is using my context". When the question is about
   one plugin or one family of names ("how much did I use ECC"), pass
   `name` (`"ecc:"`): the skill, slash-command and agent lists then hold
   only the names that contain it, so none is lost past the list cut.

## Presenting the result

The tool returns plain text: a `Scope:` line, then clear sections (tool
usage, skills & commands, agents, health, timeline, files touched, hook
blocks, tool output). Relay
what it actually says — don't invent trends or comparisons the data doesn't
support. Project and all-project stats leave out one-shot exec/SDK runs and
clens judge transcripts; the answer says so on its second line.

If there is no data, say so plainly rather than guessing at a cause, after
checking the one thing each message points at:
- `No data found for project …`: whether `project_id` was derived correctly,
  or whether `since` is too narrow. The message says exec/SDK runs and judge
  sessions are left out: a project with only those has no data here.
- `No data found for session …`: whether the `session_id` is right (a session
  that only just started may not be indexed yet).
- `No data found in any project …`: whether `since` is too narrow.
- `Hook blocks: not indexed yet …` or `Tool output: not indexed yet …`: the
  index was built by an older clens; tell the user to run `clens index` once.

Hook blocks and tool output are missing for sessions whose transcripts were
deleted before clens began recording them (for Codex, before index v8), so
say that totals over older history undercount. Tool output counts text only, not
images.

Long lists are cut and end with a `(+N more …)` line: `(+N more)` for tools
and for tool output,
`(+N more skills)` and `(+N more slash commands)` for those two lists, and
`(+N more)` or `(+N more of the top 50)` for files. Never present such a
list as complete: say how many were left out.

**Always state the actual date range covered**, especially since the
default is now 1 month, not all-time — the user shouldn't have to guess
whether a number is "last month" or "ever" from context alone.

**Render ranked count lists as horizontal ASCII gauge charts inside a
boxed section, not plain lists.** This applies to tool usage, skills &
slash commands, agents, files touched, hook blocks per hook and tool, and
tool output (gauge on total characters) — anything that's a set of labeled
items each with a count, where relative comparison is the point. Health and
timeline sections, and the recent hook blocks with their reasons, stay as
plain text (they're not ranked lists).

- Frame each section with a box border: `┌─ <title>` on top, `│ ` prefix
  on each data row, `└` + a rule the same width on the bottom.
- Fixed-width gauge/track per row (18 chars is a good default), filled
  portion in `█` and the remainder in `·`, scaled to the section's own
  max value (the top item is fully or near-fully filled).
- Format the count with a thousands separator (`1,992`, not `1992`),
  right-aligned in a fixed-width column after the gauge.
- Pad labels to the widest label in that section (plus one space) so all
  gauges start at the same column.
- Cap each section at a reasonable top-N (10-15) if the list is long;
  say how many more were omitted rather than silently dropping them.
- Shorten long labels for readability (e.g. drop the `mcp__clens__`
  prefix, or truncate a long file path to its last 2-3 segments) as long
  as the item stays identifiable — don't fabricate shorter names that
  could be confused with a different item.

Example shape for one section:
```
┌─ 도구 사용 TOP 10
│  Bash             ██████████████████   1,992
│  Read             ███████···········     720
│  Edit             ██████············     648
│  clens_search     █·················      97
└───────────────────────────────────────────────
```
