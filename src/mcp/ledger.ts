/**
 * clens_hold / clens_pending — the ledger of what users set aside.
 *
 * The agent in a conversation records an item when the user puts it off or
 * drops it (clens_hold), and clens_pending lists them later, as do the
 * SessionStart hooks for the project at hand (formatLedgerList). The ledger
 * is its own file, ~/.clens/ledger.jsonl (ledgerPath()), not a table of the
 * index: the MCP server opens the index read-only, and a rebuild re-derives
 * the index from transcripts, which cannot re-derive an agent's judgement.
 *
 * One JSON event per line, appended and never rewritten. The first event of
 * an id creates the item; later ones change its status, words or waits_for.
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { normalizeProjectId } from "../util/project_id.js";
import { localTs } from "../util/time.js";

export const HOLD_STATUSES = ["held", "dropped", "done", "removed"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export interface LedgerEvent {
  id: string;                // 8 lowercase hex characters, /^[0-9a-f]{8}$/
  ts: string;                // new Date().toISOString() on the server
  project_id: string;
  session_id: string | null; // calling session, null when unknown
  status: HoldStatus;
  item?: string;             // only on the event that creates the item
  words?: string;
  waits_for?: string;
}

export interface LedgerItem {
  id: string;
  project_id: string;
  item: string;
  status: HoldStatus;
  words: string;             // latest words given
  waits_for: string | null;  // latest waits_for given
  session_id: string | null; // session of the creating event
  created: string;           // ts of the creating event
  updated: string;           // ts of the latest event
}

const ID = /^[0-9a-f]{8}$/;

/** Append one event as one line. Several MCP servers, one per session, append
 *  to the same file, so the line goes out in a single appendFileSync call,
 *  which keeps concurrent lines whole (checked on macOS only). */
export function appendLedgerEvent(path: string, event: LedgerEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  // A write cut off earlier leaves a line without its newline; start a new
  // line so this event does not join it and become unreadable too.
  const prefix = endsWithoutNewline(path) ? "\n" : "";
  appendFileSync(path, prefix + JSON.stringify(event) + "\n");
}

function endsWithoutNewline(path: string): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (size === 0) return false;
  const fd = openSync(path, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

function parseEvent(line: string): LedgerEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const optionalString = (key: string) => !(key in o) || typeof o[key] === "string";
  if (
    typeof o.id !== "string" || !ID.test(o.id) ||
    typeof o.ts !== "string" ||
    typeof o.project_id !== "string" ||
    !("session_id" in o) || (o.session_id !== null && typeof o.session_id !== "string") ||
    !(HOLD_STATUSES as readonly unknown[]).includes(o.status) ||
    !optionalString("item") || !optionalString("words") || !optionalString("waits_for")
  ) {
    return null;
  }
  return o as unknown as LedgerEvent;
}

/** Fold the file's events into items, in creation order, removed ones
 *  included. `unreadable` counts the lines skipped other than empty ones. */
export function readLedger(path: string): { items: LedgerItem[]; unreadable: number } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { items: [], unreadable: 0 };
    throw e;
  }
  const byId = new Map<string, LedgerItem>();
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
      // An item's id, project, text, session and creation never change.
      known.status = e.status;
      known.updated = e.ts;
      if (e.words !== undefined) known.words = e.words;
      if (e.waits_for !== undefined) known.waits_for = e.waits_for;
      continue;
    }
    if (e.item === undefined || e.words === undefined) {
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
      updated: e.ts,
    });
  }
  return { items: [...byId.values()], unreadable };
}

export interface HoldParams {
  project_id: string;
  id?: string;
  item?: string;
  status: HoldStatus;
  words?: string;
  waits_for?: string;
}

export type HoldResult = { ok: true; text: string } | { ok: false; error: string };

const MAX_ID_DRAWS = 10;

/** clens_hold: record a new item (without `id`) or change the item `id`. */
export function recordHold(
  path: string,
  params: HoldParams,
  ctx: { sessionId: string | undefined; now: Date; newId?: () => string },
): HoldResult {
  const ts = ctx.now.toISOString();
  const session_id = ctx.sessionId ?? null;
  const { project_id, status, words, waits_for } = params;

  if (params.id !== undefined) {
    if (params.item !== undefined) return { ok: false, error: "item cannot change; record a new item instead" };
    const id = params.id;
    const known = readLedger(path).items.find((i) => i.id === id);
    if (!known) return { ok: false, error: `no item ${id} in the ledger` };
    if (known.project_id !== project_id) {
      return { ok: false, error: `item ${id} belongs to project ${known.project_id}, not ${project_id}` };
    }
    appendLedgerEvent(path, { id, ts, project_id, session_id, status, words, waits_for });
    return { ok: true, text: `Changed ${id} to ${status}: ${known.item}` };
  }

  // Done and removed only make sense for an item already recorded.
  if (status !== "held" && status !== "dropped") {
    return { ok: false, error: "a new item is held or dropped; pass the id of a recorded item to mark it done or removed" };
  }
  const item = params.item;
  if (item === undefined || words === undefined) {
    return { ok: false, error: "item and words are needed to record a new item" };
  }
  const newId = ctx.newId ?? (() => randomBytes(4).toString("hex"));
  const taken = new Set(readLedger(path).items.map((i) => i.id));
  let id: string | undefined;
  for (let draw = 0; draw < MAX_ID_DRAWS && id === undefined; draw++) {
    const candidate = newId();
    if (!taken.has(candidate)) id = candidate;
  }
  if (id === undefined) return { ok: false, error: "could not pick a new id" };
  appendLedgerEvent(path, { id, ts, project_id, session_id, status, item, words, waits_for });
  return { ok: true, text: `Recorded ${id} as ${status}: ${item}` };
}

/** Latest change first, ties by id; the order both lists of the ledger use. */
function newestFirst(a: LedgerItem, b: LedgerItem): number {
  return a.updated === b.updated ? (a.id < b.id ? -1 : 1) : a.updated < b.updated ? 1 : -1;
}

/** Default cap on the size of a clens_pending answer, in bytes. */
export const DEFAULT_PENDING_MAX_BYTES = 16384;

/** Room kept under the cap for the "(+k more items not shown)" line. */
const MORE_LINE_RESERVE = 64;

const GROUPS = ["held", "dropped", "done"] as const;

/** clens_pending: the kept items grouped as held, dropped, done, newest
 *  first, within `maxBytes`. */
export function formatPending(
  ledger: { items: LedgerItem[]; unreadable: number },
  params: { project_id?: string; maxBytes?: number },
): string {
  const { project_id } = params;
  const unreadableLine =
    ledger.unreadable > 0 ? `(${ledger.unreadable} unreadable lines in the ledger file were skipped)` : null;
  const kept = ledger.items.filter(
    (i) => i.status !== "removed" && (project_id === undefined || i.project_id === project_id),
  );
  if (kept.length === 0) {
    const nothing = project_id === undefined ? "Nothing in the ledger." : `Nothing in the ledger for ${project_id}.`;
    return unreadableLine === null ? nothing : `${nothing}\n${unreadableLine}`;
  }

  const groups = GROUPS.map((status) => kept.filter((i) => i.status === status).sort(newestFirst));
  const [held, dropped, done] = groups.map((g) => g.length);
  const lines = [`Ledger for ${project_id ?? "every project"}: ${held} held, ${dropped} dropped, ${done} done`];

  const itemLines = (i: LedgerItem): string[] => {
    let detail = `  words: "${i.words}"`;
    if (i.waits_for !== null) detail += `; waits for: ${i.waits_for}`;
    if (i.updated !== i.created) detail += `; changed: ${localTs(i.updated)}`;
    detail += `; session: ${i.session_id ?? "unknown"}`;
    if (project_id === undefined) detail += `; project: ${i.project_id}`;
    return [`- ${i.id}  ${localTs(i.created)}  ${i.item}`, detail];
  };

  const cap = params.maxBytes ?? DEFAULT_PENDING_MAX_BYTES;
  const reserve = MORE_LINE_RESERVE + (unreadableLine === null ? 0 : Buffer.byteLength(unreadableLine, "utf8") + 1);
  let used = Buffer.byteLength(lines[0]!, "utf8");
  let written = 0;
  fill: for (const [g, group] of groups.entries()) {
    for (const [n, i] of group.entries()) {
      // A group line goes out only together with its first item.
      const next = n === 0 ? [`${GROUPS[g]}:`, ...itemLines(i)] : itemLines(i);
      const bytes = next.reduce((sum, l) => sum + 1 + Buffer.byteLength(l, "utf8"), 0);
      if (used + bytes + reserve > cap) break fill;
      lines.push(...next);
      used += bytes;
      written++;
    }
  }
  if (written < kept.length) lines.push(`(+${kept.length - written} more items not shown)`);
  if (unreadableLine !== null) lines.push(unreadableLine);
  return lines.join("\n");
}

export const LEDGER_LIST_HELD_MAX = 10;
export const LEDGER_LIST_DROPPED_MAX = 5;
export const LEDGER_LIST_MAX_CHARS = 6000;

/** Room kept under LEDGER_LIST_MAX_CHARS for the "dropped:" line and the two
 *  "+N more" lines, each under 45 characters. */
const LIST_TAIL_RESERVE = 200;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The SessionStart list of one project's held and dropped items, or null
 *  when the project has none. The SessionStart hooks print it
 *  (src/hooks/ledger_context.ts), so that an agent in any session sees the ids
 *  to mark done; clens_pending gives what the caps leave out. */
export function formatLedgerList(items: LedgerItem[], project_id: string): string | null {
  const kept = items.filter((i) => i.project_id === project_id && (i.status === "held" || i.status === "dropped"));
  if (kept.length === 0) return null;
  const lines = ["clens ledger for this project, from earlier sessions (ids for clens_hold; full list with clens_pending):"];
  const groups = [
    ["held", LEDGER_LIST_HELD_MAX],
    ["dropped", LEDGER_LIST_DROPPED_MAX],
  ] as const;
  for (const [status, max] of groups) {
    const group = kept.filter((i) => i.status === status).sort(newestFirst);
    if (group.length === 0) continue;
    lines.push(`${status}:`);
    let shown = 0;
    for (const i of group) {
      if (shown === max) break;
      const line = `- ${i.id}  ${oneLine(i.item)}  (words: "${oneLine(i.words)}")`;
      // An item longer than the room left (only in a hand-edited ledger)
      // ends its group and is counted below.
      if (lines.join("\n").length + 1 + line.length > LEDGER_LIST_MAX_CHARS - LIST_TAIL_RESERVE) break;
      lines.push(line);
      shown++;
    }
    const more = group.length - shown;
    if (more > 0) lines.push(`(+${more} more ${status} item${more === 1 ? "" : "s"}: clens_pending)`);
  }
  return lines.join("\n");
}
