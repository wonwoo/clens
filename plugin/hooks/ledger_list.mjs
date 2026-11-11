#!/usr/bin/env node
import { createRequire as __clensRequire } from 'node:module'; const require = __clensRequire(import.meta.url);

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

// src/hooks/ledger_list.ts
var input = "";
for await (const chunk of process.stdin) input += chunk;
var list = ledgerContext(input);
if (list === null) process.exit(0);
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: list } })
);
