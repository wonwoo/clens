#!/usr/bin/env node
import { createRequire as __clensRequire } from 'node:module'; const require = __clensRequire(import.meta.url);

// src/mcp/instructions.ts
var HOLD_GUIDANCE = `LEDGER: clens also keeps a ledger of what the user sets aside, so held work is not forgotten in later sessions and dropped ideas are not proposed again. It is for work and ideas that stand on their own, apart from this conversation. Record without being asked when the user sets one aside: call clens_hold once per item, then go on with the request.
- held: put off, to come back to later ("\uB098\uC911\uC5D0", "\uC77C\uB2E8 \uB300\uAE30", "\uB2E4\uC2DC \uC0DD\uAC01\uD574\uBCFC\uAC8C", "\uBC31\uB85C\uADF8\uC5D0 \uB0A8\uACA8", "let's park it")
- dropped: weighed and rejected, so it should not be proposed again ("\uD328\uC2A4", "\uC548 \uD574\uB3C4 \uB3FC", "\uD544\uC694 \uC5C6\uC74C", "isn't worth it")
Judge by meaning in any language, not by these words. What only shapes the task at hand ends with it and is not recorded: what to leave out of it ("\uB3C4\uCEE4 \uBE7C\uACE0", "skip the tests this time"), picking one option (the others are not set aside unless the user says so), waiting on or holding back one of its steps ("\uC7AC\uC2DC\uC791\uD560\uAC8C \uB300\uAE30", commit, push, deploy), and questions.
When the user asks you to note work for later ("\uAE30\uC5B5\uD574 \uB46C", "\uC801\uC5B4 \uB46C", "remember this"), record it as held. A preference or fact to remember is not work; leave it out of the ledger.
When you finish an item clens_pending listed as held, record it done with its id.`;
var SERVER_INSTRUCTIONS = `clens is a local, read-only index of the user's past Claude Code and Codex conversations across all projects: every user message and assistant reply. It keeps sessions whose transcripts were deleted.

USE IT FIRST, without being asked, when the user refers to earlier work rather than the current conversation or code:
- a past topic, finding or decision: "what did we find about the slow query", "why did we drop the retry logic"
- something tried before: "did switching the linter help" (check before suggesting it again)
- where work stopped or what was done: "where did I leave off", "what did I do yesterday" (clens_left_off)
- if it was tested or deployed: "did we test it on sandbox" (clens_left_off branch)
- another session or project: "the helper in the other repo"
- signal words: last time, earlier, before, previously, we decided, we tried, remember when, and the same in the user's language (\uC9C0\uB09C\uBC88, \uC544\uAE4C, \u524D\u56DE, \u4E0A\u6B21); also a request that assumes something already exists

DON'T USE IT for the current code (read the files), for what is still in your context, or for general knowledge. Earlier turns a compaction dropped are not in it: read them with clens_session, session_id "current".

HOW:
1. clens_search (limit 5-10) with distinctive words the conversation would contain: identifiers, error text, file names, product terms. Keyword search; see its query rules.
2. clens_session with a hit's session_id and ts, to read the conversation around it before answering.
3. Nothing relevant? Retry before concluding it is absent: the other language, spelling variants, split forms (uploadImages / upload images), OR, another project, a wider time range.
4. clens_left_off: latest sessions of a project or file, with last request, reply and edits; session_id "current" after compaction. clens_recent: a time window. clens_stats: counts.

Report when and in which session something was said, quote the key line, and keep what the record shows apart from your inference. Use these tools instead of reading ~/.clens/index.db or transcript files.

${HOLD_GUIDANCE}`;

// src/hooks/hold_guidance.ts
for await (const _ of process.stdin) ;
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: HOLD_GUIDANCE } })
);
