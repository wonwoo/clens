import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendLedgerEvent,
  formatPending,
  readLedger,
  recordHold,
  type LedgerEvent,
  type LedgerItem,
} from "../src/mcp/ledger.js";
import { UTC_TIME, withTz } from "./tz.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clens-ledger-"));
  path = join(dir, "ledger.jsonl");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function lines(): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
}

function event(over: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    id: "0000000a",
    ts: "2026-11-04T10:00:00.000Z",
    project_id: "-p",
    session_id: "s1",
    status: "held",
    item: "Support Cursor",
    words: "일단 대기",
    ...over,
  };
}

const NOW = new Date("2026-11-04T12:00:00.000Z");

describe("appendLedgerEvent / readLedger", () => {
  it("T1 creates the missing folder and writes one line that parses back to the event", () => {
    const nested = join(dir, "a", "b", "ledger.jsonl");
    const e = event({ waits_for: "the next release" });
    appendLedgerEvent(nested, e);
    const text = readFileSync(nested, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const written = text.split("\n").filter((l) => l !== "");
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!)).toEqual(e);
  });

  it("T2 starts a new line after a line cut off without its newline", () => {
    writeFileSync(path, '{"id":"broken');
    appendLedgerEvent(path, event());
    expect(readFileSync(path, "utf8")).toBe(`{"id":"broken\n${JSON.stringify(event())}\n`);
    const ledger = readLedger(path);
    expect(ledger.unreadable).toBe(1);
    expect(ledger.items.map((i) => i.id)).toEqual(["0000000a"]);
  });

  it("T3 reads a missing file as an empty ledger", () => {
    expect(existsSync(path)).toBe(false);
    expect(readLedger(path)).toEqual({ items: [], unreadable: 0 });
  });

  it("T4 folds an update into the item it names", () => {
    appendLedgerEvent(path, event({ waits_for: "a decision" }));
    appendLedgerEvent(path, {
      id: "0000000a",
      ts: "2026-11-05T09:00:00.000Z",
      project_id: "-other",
      session_id: "s2",
      status: "done",
      item: "Something else",
      words: "다 했어",
    });
    const item: LedgerItem = {
      id: "0000000a",
      project_id: "-p",
      item: "Support Cursor",
      status: "done",
      words: "다 했어",
      waits_for: "a decision",
      session_id: "s1",
      created: "2026-11-04T10:00:00.000Z",
      updated: "2026-11-05T09:00:00.000Z",
    };
    expect(readLedger(path)).toEqual({ items: [item], unreadable: 0 });
  });

  it("T5 counts each malformed line as unreadable and skips whitespace-only lines", () => {
    appendLedgerEvent(path, event());
    const known = readLedger(path).items;
    const bad = [
      "not json",
      JSON.stringify([event()]),
      JSON.stringify(event({ status: "later" as never })),
      JSON.stringify(event({ id: "XYZ" })),
      JSON.stringify((({ session_id: _, ...rest }) => rest)(event({ id: "0000000b" }))),
      JSON.stringify({ ...event({ id: "0000000c" }), waits_for: 3 }),
      JSON.stringify((({ words: _, ...rest }) => rest)(event({ id: "0000000d" }))),
    ];
    for (const line of bad) {
      appendFileSync(path, line + "\n");
      const before = readLedger(path);
      expect(before.items).toEqual(known);
    }
    appendFileSync(path, "   \n\n");
    expect(readLedger(path)).toEqual({ items: known, unreadable: bad.length });
  });
});

describe("recordHold", () => {
  const ids = (...list: string[]) => {
    let i = 0;
    return () => list[Math.min(i++, list.length - 1)]!;
  };

  it("T6 records a new held item with the calling session, or null without one", () => {
    const res = recordHold(
      path,
      { project_id: "-p", item: "Add a due date", status: "held", words: "let's park it" },
      { sessionId: "sess-1", now: NOW, newId: ids("0000aaaa") },
    );
    expect(res).toEqual({ ok: true, text: "Recorded 0000aaaa as held: Add a due date" });
    expect(lines()).toHaveLength(1);
    const first = JSON.parse(lines()[0]!);
    expect(first).toEqual({
      id: "0000aaaa",
      ts: NOW.toISOString(),
      project_id: "-p",
      session_id: "sess-1",
      status: "held",
      item: "Add a due date",
      words: "let's park it",
    });
    expect("waits_for" in first).toBe(false);

    recordHold(
      path,
      { project_id: "-p", item: "Undo", status: "dropped", words: "패스" },
      { sessionId: undefined, now: NOW, newId: ids("0000bbbb") },
    );
    expect(JSON.parse(lines()[1]!).session_id).toBeNull();
  });

  it("T7 refuses bad calls without writing a line", () => {
    recordHold(
      path,
      { project_id: "-p", item: "Add a due date", status: "held", words: "later" },
      { sessionId: "s", now: NOW, newId: ids("0000aaaa") },
    );
    const ctx = { sessionId: "s", now: NOW, newId: ids("0000cccc") };
    const cases: [Parameters<typeof recordHold>[1], string][] = [
      [{ project_id: "-p", id: "0000aaaa", item: "New text", status: "done" }, "item cannot change; record a new item instead"],
      [{ project_id: "-p", id: "0000ffff", status: "done" }, "no item 0000ffff in the ledger"],
      [{ project_id: "-q", id: "0000aaaa", status: "done" }, "item 0000aaaa belongs to project -p, not -q"],
      [
        { project_id: "-p", item: "X", status: "done", words: "w" },
        "a new item is held or dropped; pass the id of a recorded item to mark it done or removed",
      ],
      [{ project_id: "-p", item: "X", status: "held" }, "item and words are needed to record a new item"],
    ];
    for (const [params, error] of cases) {
      expect(recordHold(path, params, ctx)).toEqual({ ok: false, error });
      expect(lines()).toHaveLength(1);
    }
  });

  it("T8 changes a recorded item, to removed and back to held", () => {
    recordHold(
      path,
      { project_id: "-p", item: "Add a due date", status: "held", words: "later" },
      { sessionId: "s1", now: NOW, newId: ids("0000aaaa") },
    );
    const later = { sessionId: "s2", now: new Date("2026-11-05T00:00:00.000Z") };
    expect(recordHold(path, { project_id: "-p", id: "0000aaaa", status: "done" }, later)).toEqual({
      ok: true,
      text: "Changed 0000aaaa to done: Add a due date",
    });
    expect(JSON.parse(lines()[1]!)).toEqual({
      id: "0000aaaa",
      ts: "2026-11-05T00:00:00.000Z",
      project_id: "-p",
      session_id: "s2",
      status: "done",
    });
    expect(recordHold(path, { project_id: "-p", id: "0000aaaa", status: "removed", words: "잘못 적혔어" }, later).ok).toBe(true);
    expect(readLedger(path).items[0]!.status).toBe("removed");
    expect(recordHold(path, { project_id: "-p", id: "0000aaaa", status: "held" }, later)).toEqual({
      ok: true,
      text: "Changed 0000aaaa to held: Add a due date",
    });
    const item = readLedger(path).items[0]!;
    expect(item.status).toBe("held");
    expect(item.words).toBe("잘못 적혔어");
    expect(item.session_id).toBe("s1");
  });

  it("T9 draws another id when one is taken, and gives up after 10 draws", () => {
    const params = { project_id: "-p", item: "A", status: "held", words: "w" } as const;
    recordHold(path, params, { sessionId: "s", now: NOW, newId: ids("0000aaaa") });
    expect(recordHold(path, params, { sessionId: "s", now: NOW, newId: ids("0000aaaa", "0000bbbb") })).toEqual({
      ok: true,
      text: "Recorded 0000bbbb as held: A",
    });
    let draws = 0;
    const always = () => {
      draws++;
      return "0000aaaa";
    };
    expect(recordHold(path, params, { sessionId: "s", now: NOW, newId: always })).toEqual({
      ok: false,
      error: "could not pick a new id",
    });
    expect(draws).toBe(10);
    expect(lines()).toHaveLength(2);
  });
});

describe("formatPending", () => {
  function item(over: Partial<LedgerItem>): LedgerItem {
    return {
      id: "00000001",
      project_id: "-p",
      item: "Item",
      status: "held",
      words: "later",
      waits_for: null,
      session_id: "s1",
      created: "2026-11-01T00:00:00.000Z",
      updated: "2026-11-01T00:00:00.000Z",
      ...over,
    };
  }

  const items: LedgerItem[] = [
    item({ id: "00000001", item: "Old held", created: "2026-11-01T00:00:00.000Z", updated: "2026-11-01T00:00:00.000Z" }),
    item({ id: "00000002", item: "Dropped one", status: "dropped", words: "패스", session_id: null }),
    item({
      id: "00000003",
      item: "New held",
      created: "2026-11-02T00:00:00.000Z",
      updated: "2026-11-03T00:00:00.000Z",
      waits_for: "the release",
    }),
    item({ id: "00000004", item: "Finished", status: "done", words: "다 했어", updated: "2026-11-04T00:00:00.000Z" }),
    item({ id: "00000005", item: "Wrong record", status: "removed" }),
    item({ id: "00000006", item: "Elsewhere", project_id: "-q" }),
  ];

  it("T10 groups one project's items as held, dropped, done, newest first", () => {
    expect(formatPending({ items, unreadable: 0 }, { project_id: "-p" })).toBe(
      [
        "Ledger for -p: 2 held, 1 dropped, 1 done",
        "held:",
        "- 00000003  2026-11-02T00:00:00.000Z  New held",
        '  words: "later"; waits for: the release; changed: 2026-11-03T00:00:00.000Z; session: s1',
        "- 00000001  2026-11-01T00:00:00.000Z  Old held",
        '  words: "later"; session: s1',
        "dropped:",
        "- 00000002  2026-11-01T00:00:00.000Z  Dropped one",
        '  words: "패스"; session: unknown',
        "done:",
        "- 00000004  2026-11-01T00:00:00.000Z  Finished",
        '  words: "다 했어"; changed: 2026-11-04T00:00:00.000Z; session: s1',
      ].join("\n"),
    );
  });

  it("prints each item's dates in the server's zone", () => {
    const out = withTz("Asia/Seoul", () => formatPending({ items, unreadable: 0 }, { project_id: "-p" }));
    expect(out).toContain("- 00000003  2026-11-02T09:00:00.000+09:00  New held");
    expect(out).toContain("; changed: 2026-11-03T09:00:00.000+09:00;");
    expect(out).not.toMatch(UTC_TIME);
  });

  it("T10 lists every project with the project on each item, and orders ties by id", () => {
    const tie = [item({ id: "00000009", item: "B" }), item({ id: "00000008", item: "A", project_id: "-q" })];
    expect(formatPending({ items: tie, unreadable: 0 }, {})).toBe(
      [
        "Ledger for every project: 2 held, 0 dropped, 0 done",
        "held:",
        "- 00000008  2026-11-01T00:00:00.000Z  A",
        '  words: "later"; session: s1; project: -q',
        "- 00000009  2026-11-01T00:00:00.000Z  B",
        '  words: "later"; session: s1; project: -p',
      ].join("\n"),
    );
  });

  it("T10 says when nothing is kept, with the unreadable line", () => {
    expect(formatPending({ items, unreadable: 0 }, { project_id: "-none" })).toBe("Nothing in the ledger for -none.");
    expect(formatPending({ items: [], unreadable: 0 }, {})).toBe("Nothing in the ledger.");
    expect(formatPending({ items: [], unreadable: 2 }, { project_id: "-p" })).toBe(
      "Nothing in the ledger for -p.\n(2 unreadable lines in the ledger file were skipped)",
    );
  });

  it("T10 ends with the unreadable line", () => {
    const out = formatPending({ items: [items[0]!], unreadable: 3 }, { project_id: "-p" });
    expect(out.split("\n").at(-1)).toBe("(3 unreadable lines in the ledger file were skipped)");
  });

  it("T10 stops at maxBytes and counts the items not shown", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      item({ id: `000000${String(i).padStart(2, "0")}`, item: `Idea number ${i}`, status: i % 2 ? "dropped" : "held" }),
    );
    const cap = 600;
    const out = formatPending({ items: many, unreadable: 1 }, { project_id: "-p", maxBytes: cap });
    const outLines = out.split("\n");
    expect(outLines[0]).toBe("Ledger for -p: 10 held, 10 dropped, 0 done");
    const shown = outLines.filter((l) => l.startsWith("- ")).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(20);
    expect(outLines.at(-2)).toBe(`(+${20 - shown} more items not shown)`);
    expect(outLines.at(-1)).toBe("(1 unreadable lines in the ledger file were skipped)");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(cap);
    // One more item would not have fitted with the reserve.
    const full = formatPending({ items: many, unreadable: 1 }, { project_id: "-p", maxBytes: 1_000_000 }).split("\n");
    const upTo = outLines.slice(0, -2);
    expect(full.slice(0, upTo.length)).toEqual(upTo);
    const next = full.slice(upTo.length, upTo.length + (full[upTo.length]!.endsWith(":") ? 3 : 2));
    const reserve = 64 + Buffer.byteLength("(1 unreadable lines in the ledger file were skipped)") + 1;
    expect(Buffer.byteLength([...upTo, ...next].join("\n"), "utf8") + reserve).toBeGreaterThan(cap);
    // No group line is left without its first item.
    expect(outLines.at(-3)!.endsWith(":")).toBe(false);
  });
});
