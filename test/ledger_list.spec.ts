import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ledgerContext } from "../src/hooks/ledger_context.js";
import { formatLedgerList, LEDGER_LIST_MAX_CHARS, type HoldStatus, type LedgerItem } from "../src/mcp/ledger.js";

const HEAD = "clens ledger for this project, from earlier sessions (ids for clens_hold; full list with clens_pending):";

const item = (
  id: string,
  status: HoldStatus,
  text: string,
  words: string,
  updated = "2026-11-05T01:00:00.000Z",
  project_id = "-work-app",
): LedgerItem => ({
  id,
  project_id,
  item: text,
  status,
  words,
  waits_for: null,
  session_id: null,
  created: "2026-11-05T00:00:00.000Z",
  updated,
});

const hex = (n: number) => n.toString(16).padStart(8, "0");

describe("formatLedgerList", () => {
  it("returns null when the project has no held or dropped item", () => {
    expect(formatLedgerList([], "-work-app")).toBeNull();
    expect(
      formatLedgerList([item("a1b2c3d4", "done", "Add rm", "later"), item("c9d0e1f2", "removed", "Use SQLite", "no need")], "-work-app"),
    ).toBeNull();
    expect(formatLedgerList([item("a1b2c3d4", "held", "Add rm", "later", undefined, "-other")], "-work-app")).toBeNull();
  });

  it("prints the held group, then the dropped group, each item with its id and the user's words", () => {
    const list = formatLedgerList(
      [item("c9d0e1f2", "dropped", "Use SQLite", "no need"), item("a1b2c3d4", "held", "Add rm", "later")],
      "-work-app",
    );
    expect(list).toBe(
      [HEAD, "held:", '- a1b2c3d4  Add rm  (words: "later")', "dropped:", '- c9d0e1f2  Use SQLite  (words: "no need")'].join("\n"),
    );
  });

  it("orders a group by the latest change, newest first, ties by id", () => {
    const list = formatLedgerList(
      [
        item("00000003", "held", "old", "w", "2026-11-01T00:00:00.000Z"),
        item("00000002", "held", "new b", "w", "2026-11-03T00:00:00.000Z"),
        item("00000001", "held", "new a", "w", "2026-11-03T00:00:00.000Z"),
      ],
      "-work-app",
    );
    expect(list!.split("\n").slice(2).map((l) => l.slice(2, 10))).toEqual(["00000001", "00000002", "00000003"]);
  });

  it("shows at most 10 held and 5 dropped items, and counts the rest", () => {
    const items = [
      ...Array.from({ length: 18 }, (_, n) => item(hex(n), "held", `held ${n}`, "later")),
      ...Array.from({ length: 6 }, (_, n) => item(hex(100 + n), "dropped", `dropped ${n}`, "no")),
    ];
    const lines = formatLedgerList(items, "-work-app")!.split("\n");
    const heldAt = lines.indexOf("held:");
    const droppedAt = lines.indexOf("dropped:");
    expect(droppedAt - heldAt - 1).toBe(11);
    expect(lines[droppedAt - 1]).toBe("(+8 more held items: clens_pending)");
    expect(lines.length - droppedAt - 1).toBe(6);
    expect(lines.at(-1)).toBe("(+1 more dropped item: clens_pending)");
  });

  it(`stays within ${LEDGER_LIST_MAX_CHARS} characters, counting the items it leaves out`, () => {
    const items = Array.from({ length: 10 }, (_, n) => item(hex(n), "held", "i".repeat(300), "w".repeat(500)));
    const list = formatLedgerList(items, "-work-app")!;
    expect(list.length).toBeLessThanOrEqual(LEDGER_LIST_MAX_CHARS);
    const shown = list.split("\n").filter((l) => l.startsWith("- ")).length;
    const more = /\(\+(\d+) more held items?: clens_pending\)$/.exec(list);
    expect(more).not.toBeNull();
    expect(shown + Number(more![1])).toBe(10);
  });

  it("puts each item and its words on one line", () => {
    const list = formatLedgerList([item("a1b2c3d4", "held", "Add\n  rm\tnow ", "  la\n\nter  ")], "-work-app");
    expect(list!.split("\n")[2]).toBe('- a1b2c3d4  Add rm now  (words: "la ter")');
  });

  it("prints no dropped group when nothing was dropped", () => {
    const list = formatLedgerList([item("a1b2c3d4", "held", "Add rm", "later")], "-work-app")!;
    expect(list).toBe([HEAD, "held:", '- a1b2c3d4  Add rm  (words: "later")'].join("\n"));
    expect(list).not.toContain("dropped:");
  });
});

describe("ledgerContext", () => {
  let root: string;
  let indexDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clens-ledger-list-"));
    indexDir = join(root, "index");
    mkdirSync(indexDir);
    const event = (id: string, project_id: string, item: string) =>
      JSON.stringify({ id, ts: "2026-11-05T01:00:00.000Z", project_id, session_id: null, status: "held", item, words: "later" });
    writeFileSync(
      join(indexDir, "ledger.jsonl"),
      [
        event("a1b2c3d4", "-work-app", "This project's item"),
        event("e5f6a7b8", "-other", "Other project's item"),
        // So that an empty cwd lists nothing because it is refused, not
        // because no item has an empty project.
        event("0a0b0c0d", "", "Item of no project"),
      ].join("\n") + "\n",
    );
    process.env.CLENS_INDEX_DIR = indexDir;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.CLENS_INDEX_DIR;
  });

  it("lists the items of the project the session runs in", () => {
    const list = ledgerContext('{"source":"startup","cwd":"/work/app"}');
    expect(list).toContain("a1b2c3d4  This project's item");
    expect(list).not.toContain("Other project's item");
  });

  it("returns null when the input carries no usable cwd", () => {
    expect(ledgerContext("not json")).toBeNull();
    expect(ledgerContext('{"source":"startup"}')).toBeNull();
    expect(ledgerContext('{"cwd":7}')).toBeNull();
    expect(ledgerContext('{"cwd":""}')).toBeNull();
    expect(ledgerContext("null")).toBeNull();
  });

  it("returns null when the ledger is missing or cannot be read", () => {
    const input = '{"source":"startup","cwd":"/work/app"}';
    try {
      process.env.CLENS_INDEX_DIR = join(root, "missing");
      expect(ledgerContext(input)).toBeNull();
      const broken = join(root, "broken");
      mkdirSync(join(broken, "ledger.jsonl"), { recursive: true });
      process.env.CLENS_INDEX_DIR = broken;
      expect(ledgerContext(input)).toBeNull();
    } finally {
      process.env.CLENS_INDEX_DIR = indexDir;
    }
  });
});

describe("Claude Code hook registration", () => {
  it("runs the ledger list hook at startup, resume, clear and compact", () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), "plugin/hooks/hooks.json"), "utf8")) as {
      hooks: { SessionStart: { matcher: string; hooks: { command: string }[] }[] };
    };
    const entry = config.hooks.SessionStart.find((e) => e.hooks.some((h) => h.command.includes("hooks/ledger_list.mjs")));
    expect(entry?.matcher).toBe("startup|resume|clear|compact");
  });
});
