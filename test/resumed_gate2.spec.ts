import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyzeIdentity } from "../src/analyzer/identity.js";
import { eventWhere, type Scope } from "../src/analyzer/scope.js";
import { digestAllTables } from "../src/indexer/digest.js";
import { runIndex } from "../src/indexer/driver.js";
import { sessionRecord } from "../src/mcp/left_off.js";
import { searchUserText } from "../src/mcp/search.js";

// A conversation resumed into a new session starts with the earlier session's
// lines, copied with their uuids under the new session id. Each session keeps
// its own event rows for them, so the index grown run by run equals a rebuild
// whichever file is read first (gate 2). Each test grows an index in `a` and
// compares its digest with one rebuilt from scratch in `b`.

interface Env {
  root: string;
  proj: string;
  a: string;
  b: string;
}

let env: Env;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "clens-resumed-gate2-"));
  const proj = join(root, ".claude", "projects", "-repo");
  const a = join(root, "a");
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(root, ".codex"), { recursive: true });
  mkdirSync(a, { recursive: true });
  process.env.CLENS_HOME = join(root, ".claude");
  process.env.CLENS_CODEX_HOME = join(root, ".codex");
  process.env.CLENS_INDEX_DIR = a;
  env = { root, proj, a, b: join(root, "b") };
});

afterEach(() => {
  rmSync(env.root, { recursive: true, force: true });
  delete process.env.CLENS_HOME;
  delete process.env.CLENS_CODEX_HOME;
  delete process.env.CLENS_INDEX_DIR;
});

/** Give a file a later mtime than everything written before it, so the next
 *  run sees it changed. */
let clock = 1_900_000_000;
function bump(path: string): void {
  clock += 10;
  utimesSync(path, clock, clock);
}

const FIRST = "zz-first";
const RESUMED = "aa-resumed";
const file = (sid: string) => join(env.proj, `${sid}.jsonl`);

function write(sid: string, lines: object[]): void {
  writeFileSync(file(sid), lines.map((l) => JSON.stringify(l) + "\n").join(""));
  bump(file(sid));
}

function add(sid: string, lines: object[]): void {
  appendFileSync(file(sid), lines.map((l) => JSON.stringify(l) + "\n").join(""));
  bump(file(sid));
}

const at = (day: number, second: number) => `2026-07-0${day}T00:00:${String(second).padStart(2, "0")}Z`;
const user = (uuid: string, sessionId: string, timestamp: string, content: unknown) =>
  ({ uuid, sessionId, type: "user", timestamp, message: { role: "user", content } });
const reply = (uuid: string, sessionId: string, timestamp: string, model: string, content: unknown) =>
  ({ uuid, sessionId, type: "assistant", timestamp, message: { role: "assistant", model, content } });
const text = (t: string) => [{ type: "text", text: t }];

function open(dir: string): Database.Database {
  return new Database(join(dir, "index.db"), { readonly: true });
}

function query<T>(sql: string): T[] {
  const db = open(env.a);
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function digestOf(dir: string): ReturnType<typeof digestAllTables> {
  const db = open(dir);
  const d = digestAllTables(db);
  db.close();
  return d;
}

/** Gate 2: the index grown in `a` equals one rebuilt from scratch in `b`. */
async function expectDigestEqualsRebuild(): Promise<void> {
  const grown = digestOf(env.a);
  rmSync(env.b, { recursive: true, force: true });
  mkdirSync(env.b, { recursive: true });
  process.env.CLENS_INDEX_DIR = env.b;
  try {
    await runIndex({ rebuild: true });
  } finally {
    process.env.CLENS_INDEX_DIR = env.a;
  }
  expect(digestOf(env.b)).toEqual(grown);
}

/** R1's files: two lines of zz-first, copied at the head of aa-resumed, and
 *  one line of aa-resumed's own; zz-first indexed in one run, aa-resumed in
 *  a later one. */
const earlier = (sid: string) => [
  user("a1", sid, at(1, 1), "fix the flaky retry"),
  reply("a2", sid, at(1, 2), "claude-x", text("ok")),
];
async function indexResumedAfterFirst(): Promise<void> {
  write(FIRST, earlier(FIRST));
  await runIndex({});
  write(RESUMED, [...earlier(RESUMED), user("b1", RESUMED, at(2, 1), "now run the tests")]);
  await runIndex({});
}

describe("a line copied into a resumed session", () => {
  it("R1: has an event row in each session, as in a rebuild", async () => {
    await indexResumedAfterFirst();
    expect(query("SELECT uuid, session_id FROM event WHERE uuid = 'a1' ORDER BY session_id")).toEqual([
      { uuid: "a1", session_id: RESUMED },
      { uuid: "a1", session_id: FIRST },
    ]);
    await expectDigestEqualsRebuild();
  });

  it("R2: counts in the resumed session's model when its transcript is appended", async () => {
    const copied = (sid: string) => [
      user("a1", sid, at(1, 1), "q a1"),
      reply("a2", sid, at(1, 2), "m-a", text("r a2")),
      reply("a3", sid, at(1, 3), "m-a", text("r a3")),
      reply("a4", sid, at(1, 4), "m-a", text("r a4")),
    ];
    write(FIRST, copied(FIRST));
    write(RESUMED, [...copied(RESUMED), user("b1", RESUMED, at(1, 10), "q b1"), reply("b2", RESUMED, at(1, 11), "m-b", text("r b2"))]);
    await runIndex({ rebuild: true });
    add(RESUMED, [user("b3", RESUMED, at(1, 12), "q b3"), reply("b4", RESUMED, at(1, 13), "m-b", text("r b4"))]);
    expect((await runIndex({})).files_appended).toBe(1);
    expect(query(`SELECT model_primary FROM session WHERE id = '${RESUMED}'`)).toEqual([{ model_primary: "m-a" }]);
    await expectDigestEqualsRebuild();
  });

  describe("R3: a tool result fills only the call rows of its own session", () => {
    const callLines = (sid: string) => [
      user("a1", sid, at(1, 1), "run the tests"),
      reply("a2", sid, at(1, 2), "claude-x", [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "npm test" } }]),
    ];
    const resumedLines = [...callLines(RESUMED), user("a3", RESUMED, at(1, 3), [{ type: "tool_result", tool_use_id: "toolu_9", content: "passed" }])];
    const durations = () =>
      query<{ session_id: string; filled: number }>(
        "SELECT session_id, duration_ms IS NOT NULL AS filled FROM tool_call WHERE call_id = 'toolu_9' ORDER BY session_id",
      );

    it("when the resumed session is indexed after the first", async () => {
      write(FIRST, callLines(FIRST));
      await runIndex({});
      write(RESUMED, resumedLines);
      await runIndex({});
      expect(durations()).toEqual([{ session_id: RESUMED, filled: 1 }, { session_id: FIRST, filled: 0 }]);
      await expectDigestEqualsRebuild();
    });

    it("when the first session is indexed after the resumed one", async () => {
      write(RESUMED, resumedLines);
      await runIndex({});
      write(FIRST, callLines(FIRST));
      await runIndex({});
      expect(durations()).toEqual([{ session_id: RESUMED, filled: 1 }, { session_id: FIRST, filled: 0 }]);
      await expectDigestEqualsRebuild();
    });
  });

  it("R4: keeps an unknown block in each session through a re-derivation of the other", async () => {
    const withBlock = (sid: string) => [
      user("a1", sid, at(1, 1), "fix the flaky retry"),
      reply("a2", sid, at(1, 2), "claude-x", [{ type: "text", text: "ok" }, { type: "mystery_block", detail: 1 }]),
    ];
    const blocks = () => query("SELECT session_id FROM event_unknown_block ORDER BY session_id");
    write(FIRST, withBlock(FIRST));
    await runIndex({});
    const own = [user("b1", RESUMED, at(2, 1), "now run the tests"), user("b2", RESUMED, at(2, 2), "and lint")];
    write(RESUMED, [...withBlock(RESUMED), ...own]);
    await runIndex({});
    expect(blocks()).toEqual([{ session_id: RESUMED }, { session_id: FIRST }]);
    // A file that shrank is re-derived whole; a file that only grew (or was
    // only touched) would go the append path instead.
    write(RESUMED, [...withBlock(RESUMED), own[0]!]);
    const run = await runIndex({});
    expect([run.files_parsed, run.files_appended]).toEqual([1, 0]);
    expect(blocks()).toEqual([{ session_id: RESUMED }, { session_id: FIRST }]);
    await expectDigestEqualsRebuild();
  });

  it("R5: counts once in event scopes over several sessions", async () => {
    await indexResumedAfterFirst();
    const db = open(env.a);
    try {
      const count = (scope: Scope) => {
        const { sql, binds } = eventWhere(scope, "e");
        return (db.prepare(`SELECT COUNT(*) AS n FROM event e WHERE ${sql}`).get(...binds) as { n: number }).n;
      };
      // a1, a2 and b1, the copies counted in aa-resumed, the smaller session id.
      expect(count({ mode: "project", params: { project_id: "-repo" } })).toBe(3);
      expect(count({ mode: "global", params: {} })).toBe(3);
      expect(count({ mode: "since", params: { since: "2026-06-01T00:00:00Z" } })).toBe(3);
      expect(count({ mode: "session", params: { session_id: RESUMED } })).toBe(3);
      expect(count({ mode: "session", params: { session_id: FIRST } })).toBe(2);
      const { sql, binds } = eventWhere({ mode: "project", params: { project_id: "-repo" } }, "e");
      expect(db.prepare(`SELECT uuid, session_id FROM event e WHERE ${sql} ORDER BY uuid`).all(...binds)).toEqual([
        { uuid: "a1", session_id: RESUMED },
        { uuid: "a2", session_id: RESUMED },
        { uuid: "b1", session_id: RESUMED },
      ]);
      const identity = analyzeIdentity(db, { mode: "project", params: { project_id: "-repo" } });
      expect(identity.kind === "project" && identity.project.primary_model).toBe("claude-x");
    } finally {
      db.close();
    }
  });

  it("R5: counts a copied reply once in the project's primary model", async () => {
    // Counted once, claude-y has three replies to claude-x's two; counted in
    // both sessions, claude-x would have four.
    const copied = (sid: string) => [
      user("a1", sid, at(1, 1), "q a1"),
      reply("a2", sid, at(1, 2), "claude-x", text("r a2")),
      reply("a3", sid, at(1, 3), "claude-x", text("r a3")),
    ];
    write(FIRST, copied(FIRST));
    await runIndex({});
    write(RESUMED, [
      ...copied(RESUMED),
      user("b1", RESUMED, at(2, 1), "q b1"),
      reply("b2", RESUMED, at(2, 2), "claude-y", text("r b2")),
      reply("b3", RESUMED, at(2, 3), "claude-y", text("r b3")),
      reply("b4", RESUMED, at(2, 4), "claude-y", text("r b4")),
    ]);
    await runIndex({});
    const db = open(env.a);
    try {
      const identity = analyzeIdentity(db, { mode: "project", params: { project_id: "-repo" } });
      expect(identity.kind === "project" && identity.project.primary_model).toBe("claude-y");
    } finally {
      db.close();
    }
  });

  it("is found once by search, in the smaller session id", async () => {
    await indexResumedAfterFirst();
    const db = open(env.a);
    try {
      expect(searchUserText(db, { query: "flaky retry" }).map((r) => r.session_id)).toEqual([RESUMED]);
    } finally {
      db.close();
    }
  });

  it("R6: is one request in the resumed session's segments", async () => {
    await indexResumedAfterFirst();
    const db = open(env.a);
    try {
      const record = sessionRecord(db, RESUMED)!;
      expect(record.segments.reduce((n, s) => n + s.requests, 0)).toBe(2);
    } finally {
      db.close();
    }
  });
});
