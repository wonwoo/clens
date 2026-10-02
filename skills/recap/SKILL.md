---
name: recap
description: |
  Recap of the user's recent work in the current project, from their past
  Claude Code and Codex sessions (the clens MCP tools): what each recent
  session worked on, where it stopped, and what is left. Use when the user
  asks "what did I do recently", "what have I been doing in this project",
  "where did I leave off", "summarize my work", "write up this week's work as
  a document", "recap", "what have I been doing here", in any language. Can
  write the recap to a Markdown file when the user asks for a
  document. Not for counts or trends (the stats skill) or for finding one past
  topic or decision (clens_search).
when_to_use: |
  Trigger when the user wants an overview of their own recent work in this
  project, in chat or as a document. A question about one topic ("why did we
  drop the retry logic") is a search, not a recap.
---

# clens recap

## Scope

- **The current project only.** Derive `project_id` from the current working
  directory: replace every `/` with `-`. Don't ask the user for it.
- **The reader is the user**, picking the work up again: say what was being
  done and where it stands, not a report for someone else.
- **The current conversation is not in the record** (`clens_left_off` leaves
  it out). Its content is already in your context; mention it only if it did
  work beyond asking for this recap.

## Steps

1. Call `clens_left_off` with `project_id` and `limit: 3` (load it with
   ToolSearch `select:mcp__clens__clens_left_off` if needed): the point is
   where the latest work stands, and the latest 3 sessions hold it. Use
   `limit: 10` only when the user names a period or asks for more. Each
   session comes with `started_at` and `ended_at` (UTC), the last request,
   the last reply and the files it edited. A session can run for days:
   `started_at` to `ended_at` is its span.
2. If the user named a period ("yesterday", "this week", a date), pass it as
   `since` and `until`, converted from the user's local time to UTC, with
   `limit: 10`.
   Each session then shows its part inside the period: its first and last
   message there, its last request and reply, and its edits. If 10 sessions
   come back, the period may hold more: say the recap covers the latest 10.
3. Where the last reply does not say where things stand (it asks a question,
   reports progress like "checking … now", or shows an error), read
   the end of that session with `clens_session` (`session_id`,
   `around_ts: ended_at`, `limit: 20`).
4. Collect the user's commits on every branch, in the project directory.
   Only read: fetch, but never pull, check out, or touch a stash.
   - `git fetch --all --quiet`, so remote branches are current. If it fails
     (offline, no access), go on and say the remote state is as of the last
     fetch (the time of `.git/FETCH_HEAD`).
   - The user commits under more than one identity (a work and a personal
     email). Take `git config user.email`, the account email in your context
     if there is one, and any author in
     `git shortlog -sne --all --since=<start>` with the same name or email
     name; pass each as its own `--author`.
   - `git log --exclude=refs/stash --all --no-merges --source --author=<id>…
     --since=<start> --until=<end> --date=iso-local --format='%h %ad %S %s'
     --name-only`, where start and end are the earliest `started_at` and the
     latest `ended_at` (or the period). `%S` is the branch each commit was
     reached from.
   - `git status --short` and `git stash list --date=iso`.
5. Attach each commit to a session: the one whose span holds the commit's
   time. When the spans of several sessions hold it (sessions run in
   parallel), take the one that edited the commit's files. The edited-file
   list misses shell edits whose path was set only when the command ran
   (`$VAR`, `$(…)`), and every shell edit of a session whose transcript was
   gone before the index reached v7 (v8 for Codex), so when no candidate
   edited the files, take the one whose conversation mentions the commit
   (step 6). If that still does not decide it, list the commit by itself
   rather than guess. A
   commit outside every session's span was made outside these sessions (an
   editor, a terminal): list it by itself too.
6. Read the middle of long sessions. The last request and reply show what a
   session did last, not everything it did. For each commit attached to a
   session that its last request and reply do not explain, run
   `clens_search` with a distinctive word from the commit (an identifier or
   term from its subject or files), the `project_id`, and `since`/`until` set
   to the session's span; read around the hit with `clens_session` when the
   snippet is not enough. Describe the session by all of its work, in order.
7. Find where each branch with the user's commits has reached. Take the
   default branch from `git symbolic-ref --short refs/remotes/origin/HEAD`
   (usually `origin/main`).
   - **Pushed**: `git rev-list --count origin/<branch>..<branch>` is 0. No
     `origin/<branch>` means the branch is local only.
   - **In the default branch**: `git cherry <default> <branch>` marks each
     commit `-` when the default branch has it (merged or cherry-picked) and
     `+` when it does not. A squash merge adds one combined commit, which
     `git cherry` does not match: when every commit shows `+` but the work
     looks finished, check the PR with `gh pr list --head <branch> --state
     merged` if `gh` works for this remote; otherwise say the merge could not
     be confirmed.
   - **In a deploy branch**: remote branches the project deploys from, named
     with deploy, release, prod or stage (or named so in the project's docs).
     Check each with `git cherry` the same way. Teams often deploy a branch
     before merging it, so report every place the work has reached, not one
     step on a ladder.
   - When only part of a branch has arrived, give the count and the commits
     missing: "4 of 5 commits in the deploy branch; the last one not yet".
8. Two sessions that end with the same request and reply are one
   conversation seen twice: Codex keeps a copy of a Claude session it
   imported. List it once, under the earlier one.
9. Write the recap (below).

## What the record cannot show

- Files a shell command wrote are in the edited-file list when the command
  text names them (redirects, `tee`, `sed -i`, `perl -i`, python or node
  scripts run from a heredoc or `-c`/`-e`). A path set only when the command
  ran (`$VAR`, `$(…)`, a glob), what a script file written in an earlier call
  writes when run by name, and `cp`, `mv` or `touch` are not; in Codex `exec`
  code, a command built at run time counts only when that `exec` call was the
  only one running. Sessions whose
  transcripts were gone before the index reached v7 (v8 for Codex) have no
  shell edits at all. Edits a subagent made are listed, under the session that started it.
  A session can have commits whose files it never lists; the span and a
  search tie them (steps 5 and 6).
- Tool outputs (command results, file contents) are not indexed.

## Output

Newest first, one block per session:

- its span in local time, the source (claude / codex) and the first 8
  characters of the session id, so the user can ask for more of it
- what it worked on, in order, from the requests, the reply, the commits
  attached to it and what the searches in step 6 found
- its commits, each with its short hash and branch
- its state, in two parts:
  - the conversation: **in progress** (it stopped mid-task, or the reply
    says work continues), **waiting on the user** (the reply ends with a
    question), or **reply says finished**
  - the commits: where they have reached, for each branch: **local only**,
    **pushed**, **in <deploy branch>**, **in <default branch>**. Work is
    done only where it has reached the place the project ships from; a
    commit alone is not "done".
  Say so when the state is your inference rather than what the record says,
  and quote the line that decides it when it is unclear.
- what comes next, only when the record states it

Then the commits attached to no session, if any. End with the open items,
most recent first:

- branches with the user's commits in the span that are not in the default
  branch yet, with how far each has reached
- stashes from `git stash list`, with their date and branch; one an agent
  made to set work aside is work still parked
- uncommitted changes from `git status`
- questions or next steps the sessions left open

An item a later session or commit already settled is not open: a question
the user answered next time, or work a later commit finished or removed.
Say when `git fetch` failed and the remote state may be old. Write in the
user's language.

## As a document

When the user asks for a document ("as a document", "write it to a file"),
write the same content as Markdown to the path they give; without one, to
`recap-YYYY-MM-DD.md` in the project root, and tell them the path. Put the
period covered and the date written at the top. Leave out secrets that appear
in the record (tokens, passwords, keys).
