---
name: continue
description: |
  Continue here the work of the user's latest other session in this project,
  usually one they just left in the other tool (Claude Code to Codex or back),
  without the user retelling it. Reads that session's work record and last
  turns through the clens MCP tools, checks the working tree, then picks up
  where it stopped. Runs only when the user invokes it.
argument-hint: "[session_id | what to continue]"
disable-model-invocation: true
---

# Continue another session

The user worked on something in another session, often in the other tool,
and wants to go on in this conversation without explaining it again. clens
has that session indexed within seconds of its last message, so its record is
current.

## Steps

1. **Find the session.**
   - If the user gave a session_id, use it.
   - Otherwise call `clens_left_off` with this project's `project_id` (the
     working directory with every "/" replaced by "-") and `limit: 3`. The
     current conversation is left out of that list, so its first entry is the
     latest other session.
   - If the user named what to continue and the first entry is about
     something else, call `clens_search` with words from that topic and take
     the session of the best hit.
   - If this project has no other session, say so and ask which one to
     continue. Do not pick one from another project on your own.
2. **Read its record.** Call `clens_left_off` with that `session_id`. It
   gives the session's requests, last reply, edited files, the git commands
   that changed state, failed tool calls and hook blocks.
3. **Read how it ended.** Call `clens_session` with that `session_id`,
   `around_ts` set to the ts of its last request, and `limit: 10`. Read
   earlier turns the same way only when the record leaves the open task
   unclear.
4. **Check the files.** The record says what happened in that session, not
   what the files hold now. Before acting on it, run `git status` and look at
   the files it edited.
5. **Report, then continue.** In two to four sentences, tell the user what
   that session was doing, where it stopped and what was left open: a
   question the user never answered, a failing test, an uncommitted change.
   - If the user said what to continue, do it.
   - Otherwise ask the one question that decides the next step.

## Rules

- Do not redo work the record shows as done, and do not bring back an
  approach the user rejected there.
- What the user decided or ruled out in that session (for example "do not
  commit yet") still holds here unless the user says otherwise.
- The record is a summary, not the whole conversation. When a detail matters,
  read it with `clens_session` instead of guessing.
- Keep what the record shows apart from your own inference when you report.
