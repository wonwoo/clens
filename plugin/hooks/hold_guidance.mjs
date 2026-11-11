#!/usr/bin/env node
import { createRequire as __clensRequire } from 'node:module'; const require = __clensRequire(import.meta.url);

// src/mcp/instructions.ts
var HOLD_GUIDANCE = `LEDGER: clens also keeps a ledger of what the user sets aside, so held work is not forgotten in later sessions and dropped ideas are not proposed again. It is for work and ideas that stand on their own, apart from this conversation. Record without being asked when the user sets one aside: call clens_hold once per item, then go on with the request.
- held: put off, to come back to later ("\uB098\uC911\uC5D0", "\uC77C\uB2E8 \uB300\uAE30", "\uB2E4\uC2DC \uC0DD\uAC01\uD574\uBCFC\uAC8C", "\uBC31\uB85C\uADF8\uC5D0 \uB0A8\uACA8", "let's park it")
- dropped: weighed and rejected, so it should not be proposed again ("\uD328\uC2A4", "\uC548 \uD574\uB3C4 \uB3FC", "\uD544\uC694 \uC5C6\uC74C", "isn't worth it")
Judge by meaning in any language, not by these words. What only shapes the task at hand ends with it and is not recorded: what to leave out of it ("\uB3C4\uCEE4 \uBE7C\uACE0", "skip the tests this time"), picking one option (the others are not set aside unless the user says so), waiting on or holding back one of its steps ("\uC7AC\uC2DC\uC791\uD560\uAC8C \uB300\uAE30", commit, push, deploy), and questions.
When the user asks you to note work for later ("\uAE30\uC5B5\uD574 \uB46C", "\uC801\uC5B4 \uB46C", "remember this"), record it as held. A preference or fact to remember is not work; leave it out of the ledger.
When you finish an item listed as held, at the start of the session or by clens_pending, record it done with clens_hold and its id; if only part of it is done, leave it held. Do not propose a dropped item again unless the user brings it up.`;
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
2. clens_session with a hit's session_id and ts as around_ts, to read the conversation around it before answering.
3. Nothing relevant? Retry before giving up: the other language, spelling variants, split forms (uploadImages / upload images), OR, another project, a wider time range.
4. clens_left_off: latest sessions of a project or file, with last request, reply and edits; session_id "current" after compaction. clens_recent: a time window. clens_stats: counts.

Report when and in which session something was said, quote the key line, and keep what the record shows apart from your inference. Use these tools instead of reading ~/.clens/index.db or transcript files.

${HOLD_GUIDANCE}`;

// src/mcp/ledger.ts
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";

// src/util/project_id.ts
var MAX_NAME = 200;
function projectIdOf(path) {
  const name = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_NAME) return name;
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h << 5) - h + path.charCodeAt(i) | 0;
  return `${name.slice(0, MAX_NAME)}-${Math.abs(h).toString(36)}`;
}
function normalizeProjectId(id) {
  return id.replace(/[^a-zA-Z0-9]/g, "-");
}

// src/mcp/ledger.ts
var HOLD_STATUSES = ["held", "dropped", "done", "removed"];
var ID = /^[0-9a-f]{8}$/;
function parseEvent(line) {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v;
  const optionalString = (key) => !(key in o) || typeof o[key] === "string";
  if (typeof o.id !== "string" || !ID.test(o.id) || typeof o.ts !== "string" || typeof o.project_id !== "string" || !("session_id" in o) || o.session_id !== null && typeof o.session_id !== "string" || !HOLD_STATUSES.includes(o.status) || !optionalString("item") || !optionalString("words") || !optionalString("waits_for")) {
    return null;
  }
  return o;
}
function readLedger(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { items: [], unreadable: 0 };
    throw e;
  }
  const byId = /* @__PURE__ */ new Map();
  let unreadable = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const e = parseEvent(line);
    if (e === null) {
      unreadable++;
      continue;
    }
    const known = byId.get(e.id);
    if (known) {
      known.status = e.status;
      known.updated = e.ts;
      if (e.words !== void 0) known.words = e.words;
      if (e.waits_for !== void 0) known.waits_for = e.waits_for;
      continue;
    }
    if (e.item === void 0 || e.words === void 0) {
      unreadable++;
      continue;
    }
    byId.set(e.id, {
      id: e.id,
      project_id: normalizeProjectId(e.project_id),
      item: e.item,
      status: e.status,
      words: e.words,
      waits_for: e.waits_for ?? null,
      session_id: e.session_id,
      created: e.ts,
      updated: e.ts
    });
  }
  return { items: [...byId.values()], unreadable };
}
function newestFirst(a, b) {
  return a.updated === b.updated ? a.id < b.id ? -1 : 1 : a.updated < b.updated ? 1 : -1;
}
var LEDGER_LIST_HELD_MAX = 10;
var LEDGER_LIST_DROPPED_MAX = 5;
var LEDGER_LIST_MAX_CHARS = 6e3;
var LIST_TAIL_RESERVE = 200;
var oneLine = (text) => text.replace(/\s+/g, " ").trim();
function formatLedgerList(items, project_id) {
  const kept = items.filter((i) => i.project_id === project_id && (i.status === "held" || i.status === "dropped"));
  if (kept.length === 0) return null;
  const lines = ["clens ledger for this project, from earlier sessions (ids for clens_hold; full list with clens_pending):"];
  const groups = [
    ["held", LEDGER_LIST_HELD_MAX],
    ["dropped", LEDGER_LIST_DROPPED_MAX]
  ];
  for (const [status, max] of groups) {
    const group = kept.filter((i) => i.status === status).sort(newestFirst);
    if (group.length === 0) continue;
    lines.push(`${status}:`);
    let shown = 0;
    for (const i of group) {
      if (shown === max) break;
      const line = `- ${i.id}  ${oneLine(i.item)}  (words: "${oneLine(i.words)}")`;
      if (lines.join("\n").length + 1 + line.length > LEDGER_LIST_MAX_CHARS - LIST_TAIL_RESERVE) break;
      lines.push(line);
      shown++;
    }
    const more = group.length - shown;
    if (more > 0) lines.push(`(+${more} more ${status} item${more === 1 ? "" : "s"}: clens_pending)`);
  }
  return lines.join("\n");
}

// src/util/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function clensHome() {
  if (process.env.CLENS_HOME !== void 0 && process.env.CLENS_INDEX_DIR === void 0) {
    return join(process.env.CLENS_HOME, "__no_clens__");
  }
  return process.env.CLENS_INDEX_DIR ?? join(homedir(), ".clens");
}
function ledgerPath() {
  return join(clensHome(), "ledger.jsonl");
}

// src/hooks/ledger_context.ts
function ledgerContext(input2) {
  let event;
  try {
    event = JSON.parse(input2);
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const { cwd } = event;
  if (typeof cwd !== "string" || cwd === "") return null;
  const project_id = projectIdOf(cwd);
  let ledger;
  try {
    ledger = readLedger(ledgerPath());
  } catch {
    return null;
  }
  return formatLedgerList(ledger.items, project_id);
}

// src/hooks/hold_guidance.ts
var input = "";
for await (const chunk of process.stdin) input += chunk;
var list = ledgerContext(input);
var additionalContext = list === null ? HOLD_GUIDANCE : `${HOLD_GUIDANCE}

${list}`;
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } })
);
