---
name: why
description: |
  Why a piece of code is the way it is, from the past Claude Code or Codex
  session that wrote it (the clens MCP tools): the request and the proposal
  the user agreed to. Use when the user asks why a line, value or function in
  the code is like this, who decided it, "why is this here", "이거 왜 이렇게
  했지", in any language, with a file, a line or code at hand. Not for a past
  decision with no code at hand (clens_search).
when_to_use: |
  Trigger when the question points at code: a file and line, a function, a
  constant, a pasted snippet. "Why did we drop the retry logic" with no code
  in view is a search, not this.
argument-hint: "<file>[:line[-line]] | <code>"
---

# Why is this code like this

The session that wrote a line holds its reason: usually in the request that
started that turn or, when the request was a go-ahead ("do it"), in the
assistant reply just before it, the proposal the user said yes to.
`clens_left_off` with `file` and `text` finds that session from the line
itself, without git.

## Steps

1. **Pin the text.** Read the file. Take one to three lines of the code asked
   about that are distinctive, 20 or more characters in all: a signature, a
   condition, a constant. Not `}`, an import or a blank line.
2. **Find the edit.** Call `clens_left_off` with `file` and `text`. Pass the
   file as its path from the repository root and no `project_id`: a worktree
   or a moved checkout has another absolute path and another project id.
   Results name their project; drop one from an unrelated project that only
   shares the path. If nothing comes back, try other distinctive lines of the
   same function or statement, one line per call, up to three: the line asked
   about may have been changed since, or cut from the stored copy of the edit
   that wrote it, while its neighbours were not. A session found this way was
   found through those lines, not the one asked about; say so in the answer.
3. **If still none, try the commit.** Run `git blame --porcelain -L <n>,<n> --
   <file>` for the line and `git log -1 --format=%s <hash>` for the subject.
   Call `clens_left_off` with `commits: [subject]` and no `project_id`, for
   the same reason as in step 2; drop a session from an unrelated project
   that only shares the subject. Read the session around the commit's ts
   with `clens_session`. A revert
   or merge subject, or no session, means the line was not written under that
   subject in an indexed session: by hand, by someone else, or before clens
   indexed it. Say so; do not guess a reason.
4. **Read the decision.** Call `clens_session` with the session and
   `around_ts` set to the request's ts, `limit: 10`. When the session shows
   "written again", read that later turn too: if the code was rolled back
   between the two, the later turn holds the reason; if later work only
   carried the line along, the first does. When the request is about
   moving or splitting code, the line came from another file: say so, and
   look for where it was first written with `clens_search` on the function's
   name.
5. **Answer** in the user's language. First sentence: the reason. Then when and in which session,
   quoting the user's words or the line of the proposal that holds it. Keep
   what the record shows apart from your inference. With several sessions,
   the first is where the code came from; later ones rewrote or moved it.

## Rules

- Read sessions only through the clens tools, never transcript files under
  `~/.claude/projects/` or `~/.codex/sessions/`.
- Run only read-only git commands.
- When nothing explains the code, say what you checked and stop there.
