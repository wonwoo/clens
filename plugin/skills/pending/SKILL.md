---
name: pending
description: |
  What the user set aside in this project, from clens's ledger
  (clens_pending): each item with what it was, the user's own words, when,
  and its state (held, dropped or done). Use when the user asks what was left
  for later, held, parked or dropped: "what did we leave for later", "남은 거
  뭐 있었지", "다음 아이디어 뭐뭐 있었냐", "미뤄 둔 거", "보류한 거", in any
  language. Not for where the latest session stopped (the recap skill) or
  one past topic (clens_search).
when_to_use: |
  Trigger when the user wants the list of things set aside, or to mark one
  of them done or wrong.
---

# What was set aside

clens keeps a ledger of what the user set aside in conversation: agents
record an item with `clens_hold` at the moment the user holds or drops it.
This skill only reads that ledger and updates its items; it does not search
or read past conversations.

## Steps

1. **Read the ledger.** `project_id` is the working directory with every `/`
   replaced by `-`. Call `clens_pending` with it (load the tool with
   ToolSearch when it is deferred).
2. **Show it** in the user's language: the header counts, then held items,
   dropped items, done items. For each item: what it was, its date in local
   time, the user's words quoted, the first 8 characters of its session, what
   it waits for when set, and its id. Leave out empty groups. When the answer
   ends with `(+N more items not shown)` or with a line about unreadable
   lines, say so.
3. **Empty ledger.** When the answer is `Nothing in the ledger for …`, say so,
   and say that the ledger fills as items are set aside in conversations from
   now on. Do not search past conversations instead.
4. **Change an item.** When the user says an item was done, is wrong, or is
   held or dropped after all, call `clens_hold` with `project_id`, the item's
   `id`, `status` `done`, `removed`, `held` or `dropped`, and the user's words
   as `words`. Confirm with the tool's answer.
5. **Files.** Write nothing to files unless the user asks; then write the same
   content as Markdown to the path they give.

## Limits

- Only what an agent recognised and recorded is listed. A decision the agent
  did not recognise, such as agreement-like wording ("어쩔수 없는거
  아니냐"), is missing.
- Items set aside in sessions before this version of clens was installed are
  not in the ledger.
