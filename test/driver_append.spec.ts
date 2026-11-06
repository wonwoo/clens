import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendNewLines } from "../src/indexer/append.js";
import { digestAllTables } from "../src/indexer/digest.js";
import { openIndex, runIndex } from "../src/indexer/driver.js";
import { prepareStatements } from "../src/indexer/writer.js";

// A Claude Code transcript that only grew is indexed by appending its new
// lines (src/indexer/append.ts); every other change re-derives the session.
// Each test grows an index run by run in `a` and compares its digest with an
// index rebuilt from scratch in `b` over the same files (gate 2).

const FIXTURE = join(process.cwd(), "test/fixtures/brainstorm-session.jsonl");
const S = "aaaaaaaa-0000-0000-0000-000000000001";

interface Env {
  root: string;
  proj: string;
  codex: string;
  a: string;
  b: string;
}

let env: Env;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "clens-append-"));
  const proj = join(root, ".claude", "projects", "-w-app");
  const codex = join(root, ".codex");
  const a = join(root, "a");
  mkdirSync(proj, { recursive: true });
  mkdirSync(codex, { recursive: true });
  mkdirSync(a, { recursive: true });
  process.env.CLENS_HOME = join(root, ".claude");
  process.env.CLENS_CODEX_HOME = codex;
  process.env.CLENS_INDEX_DIR = a;
  env = { root, proj, codex, a, b: join(root, "b") };
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

function write(path: string, body: string): void {
  writeFileSync(path, body);
  bump(path);
}

function add(path: string, body: string): void {
  appendFileSync(path, body);
  bump(path);
}

const ts = (second: number) => `2026-09-01T00:00:${String(second).padStart(2, "0")}.000Z`;

function user(uuid: string, second: number, content: unknown, extra: object = {}): string {
  return (
    JSON.stringify({ uuid, sessionId: S, type: "user", timestamp: ts(second), cwd: "/w/app", message: { role: "user", content }, ...extra }) +
    "\n"
  );
}

function reply(uuid: string, second: number, content: unknown, model: string | null, extra: object = {}): string {
  const message = model === null ? { role: "assistant", content } : { role: "assistant", model, content };
  return JSON.stringify({ uuid, sessionId: S, type: "assistant", timestamp: ts(second), cwd: "/w/app", message, ...extra }) + "\n";
}

const text = (t: string) => [{ type: "text", text: t }];

function digestOf(dir: string): ReturnType<typeof digestAllTables> {
  const db = new Database(join(dir, "index.db"), { readonly: true });
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

/** What appendNewLines makes of the file as it is on disk now, without
 *  running the index: the fallback reason, or "appended". */
function appendOutcome(path: string): string {
  const db = openIndex();
  try {
    const st = statSync(path);
    const out = appendNewLines(db, prepareStatements(db), {
      path,
      mtime: st.mtimeMs / 1000,
      size: st.size,
      needs_parse: true,
      source: "claude",
    });
    return out.kind === "full" ? out.reason : out.kind;
  } finally {
    db.close();
  }
}

function cursor(path: string): { mtime: number; size: number; lines: number; last_ok: number } {
  const db = new Database(join(env.a, "index.db"), { readonly: true });
  const row = db.prepare("SELECT mtime, size, lines, last_ok FROM file_cursor WHERE path = ?").get(path) as {
    mtime: number;
    size: number;
    lines: number;
    last_ok: number;
  };
  db.close();
  return row;
}

describe("append path — T1 growth", () => {
  it("indexes the fixture grown in 30 parts by appending, and matches a rebuild after every run", async () => {
    const dir = join(env.root, ".claude", "projects", "fixture-project");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "test.jsonl");
    const lines = readFileSync(FIXTURE, "utf8").split(/(?<=\n)/).filter((l) => l.endsWith("\n"));
    expect(lines.length).toBe(961);
    const ends = [...Array.from({ length: 29 }, (_, i) => 32 * (i + 1)), lines.length];
    let start = 0;
    for (const end of ends) {
      const chunk = lines.slice(start, end);
      if (start === 0) write(file, chunk.join(""));
      else add(file, chunk.join(""));
      const r = await runIndex({});
      expect(r.files_parsed).toBe(1);
      expect(r.files_appended).toBe(start === 0 ? 0 : 1);
      // Only the new lines' events are reported: every line with a uuid is one.
      expect(r.events_inserted).toBe(chunk.filter((l) => typeof JSON.parse(l).uuid === "string").length);
      await expectDigestEqualsRebuild();
      start = end;
    }
  }, 120_000);
});

describe("append path — T2 subagent file", () => {
  it("appends a subagent's own lines and counts the parent's line as skipped", async () => {
    const main = join(env.proj, `${S}.jsonl`);
    write(main, user("m1", 1, "main question") + reply("m2", 2, text("main answer"), "m-a"));
    const subDir = join(env.proj, S, "subagents");
    mkdirSync(subDir, { recursive: true });
    const sub = join(subDir, "agent-x.jsonl");
    const side = { isSidechain: true, agentId: "x" };
    write(sub, user("p0", 3, "a parent line in the subagent file") + user("s1", 4, "sub prompt", side));
    expect((await runIndex({})).files_appended).toBe(0);

    add(sub, reply("s2", 5, text("sub answer"), "m-a", side) + user("p1", 6, "another parent line") + user("s3", 7, "sub follow-up", side));
    const r = await runIndex({});
    expect(r.files_appended).toBe(1);
    expect(r.events_inserted).toBe(2);

    const db = new Database(join(env.a, "index.db"), { readonly: true });
    const skipped = db.prepare("SELECT count FROM anomaly WHERE source_file = ? AND kind = 'subagent_line_skipped'").get(sub);
    db.close();
    expect(skipped).toEqual({ count: 2 });
    await expectDigestEqualsRebuild();
  });

  it("re-derives a subagent file that gains another agent's own line", async () => {
    const subDir = join(env.proj, S, "subagents");
    mkdirSync(subDir, { recursive: true });
    const sub = join(subDir, "agent-x.jsonl");
    write(sub, user("s1", 1, "sub prompt", { isSidechain: true, agentId: "x" }));
    await runIndex({});
    add(sub, user("y1", 2, "another agent", { isSidechain: true, agentId: "y" }));
    expect(appendOutcome(sub)).toBe("other_session");
    expect((await runIndex({})).files_appended).toBe(0);
    await expectDigestEqualsRebuild();
  });
});

describe("append path — T3 changes that re-derive the session", () => {
  const main = () => join(env.proj, `${S}.jsonl`);

  /** Index a two-message session, apply `change`, and check that the append
   *  path refuses it for `reason` and the run re-derives the session. */
  async function expectFallback(reason: string, change: (file: string) => void, base?: string): Promise<void> {
    const file = main();
    write(file, base ?? user("u1", 1, "question") + reply("a1", 2, text("answer"), "m-a"));
    expect((await runIndex({})).files_appended).toBe(0);
    change(file);
    expect(appendOutcome(file)).toBe(reason);
    const r = await runIndex({});
    expect(r.files_parsed).toBe(1);
    expect(r.files_appended).toBe(0);
    await expectDigestEqualsRebuild();
  }

  it("out_of_order: an assistant line 1 s before the last numbered line", async () => {
    await expectFallback("out_of_order", (f) => add(f, reply("a2", 1, text("late answer"), "m-a")));
  });

  it("model_tie: one m-a reply, then one m-b reply", async () => {
    await expectFallback("model_tie", (f) => add(f, reply("a2", 3, text("other model"), "m-b")));
  });

  it("late_meta: lines without gitBranch, then one with it", async () => {
    await expectFallback("late_meta", (f) => add(f, user("u2", 3, "on a branch", { gitBranch: "main" })));
  });

  it("sdk_entrypoint: lines without an entrypoint, then sdk-cli", async () => {
    await expectFallback("sdk_entrypoint", (f) => add(f, user("u2", 3, "from the sdk", { entrypoint: "sdk-cli" })));
  });

  it("sidechain: a sidechain line in a main file", async () => {
    // With an agentId the line would belong to the agent's own session, which
    // the other_session test covers; without one it stays in the file's session.
    await expectFallback("sidechain", (f) => add(f, user("u2", 3, "side", { isSidechain: true })));
  });

  it("other_session: a line of another session", async () => {
    await expectFallback("other_session", (f) =>
      add(f, user("o1", 3, "another session", { sessionId: "other-session" }) + user("u2", 4, "back")),
    );
  });

  it("known_uuid: a copy of a line already indexed", async () => {
    await expectFallback("known_uuid", (f) => add(f, user("u1", 1, "question")));
  });

  it("result_exists: a second result for a call already answered", async () => {
    const base =
      user("u1", 1, "question") +
      reply("a1", 2, [{ type: "tool_use", id: "c1", name: "Grep", input: { pattern: "x" } }], "m-a") +
      user("r1", 3, [{ type: "tool_result", tool_use_id: "c1", content: "first" }]);
    await expectFallback(
      "result_exists",
      (f) => add(f, user("r2", 4, [{ type: "tool_result", tool_use_id: "c1", content: "second, longer" }])),
      base,
    );
  });

  it("not_line_start: the file rewritten in place, longer, with the old end inside a line", async () => {
    await expectFallback("not_line_start", (f) =>
      write(f, user("u1", 1, "a question rewritten much longer than before") + reply("a1", 2, text("answer"), "m-a")),
    );
  });

  it("shrunk: the file lost its last line", async () => {
    await expectFallback(
      "shrunk",
      (f) => write(f, user("u1", 1, "question") + reply("a1", 2, text("answer"), "m-a")),
      user("u1", 1, "question") + reply("a1", 2, text("answer"), "m-a") + user("u2", 3, "dropped later"),
    );
  });

  it("shrunk: the file is shorter than the bytes already indexed", async () => {
    // runIndex stores the size listed before it read the file and last_ok
    // from the read, so last_ok passes the size when the file grew between
    // the two; here the file then loses bytes past that size.
    await expectFallback("shrunk", (f) => {
      const body = readFileSync(f);
      const db = new Database(join(env.a, "index.db"));
      db.prepare("UPDATE file_cursor SET size = ? WHERE path = ?").run(body.length - 10, f);
      db.close();
      write(f, body.subarray(0, body.length - 5).toString("utf8"));
    }, user("u1", 1, "question") + reply("a1", 2, text("answer"), "m-a") + user("u2", 3, "cut later"));
  });

  it("copied_lines: the file skipped another session's lines, whose own file later lost them", async () => {
    // A main file keeps another session's lines only while that session has
    // no rows (writableEvents), so which of its old lines a re-derivation
    // writes depends on the rest of the index.
    const A = "cccccccc-0000-0000-0000-000000000003";
    const fileA = join(env.proj, `${A}.jsonl`);
    const copied = user("c1", 0, "earlier session", { sessionId: A });
    write(fileA, copied);
    await runIndex({});
    const file = main();
    write(file, copied + user("u1", 1, "question") + reply("a1", 2, text("answer"), "m-a"));
    await runIndex({});
    write(fileA, "");
    await runIndex({});
    add(file, user("u2", 3, "more"));
    expect(appendOutcome(file)).toBe("copied_lines");
    const r = await runIndex({});
    expect(r.files_appended).toBe(0);
    await expectDigestEqualsRebuild();
  });

  it("several_files: the session also has rows from a second main file", async () => {
    // Every run re-derives a session from one file, so the index holds a
    // session's rows from two files only when something else wrote them;
    // the test moves one row to a second main file by hand.
    const other = join(env.proj, "bbbbbbbb-0000-0000-0000-000000000002.jsonl");
    write(other, user("b1", 5, "second file", { sessionId: "bbbbbbbb-0000-0000-0000-000000000002" }));
    await expectFallback("several_files", (f) => {
      const db = new Database(join(env.a, "index.db"));
      db.prepare("UPDATE event SET source_file = ? WHERE uuid = 'u1'").run(other);
      db.close();
      add(f, user("u2", 3, "more"));
    });
  });
});

describe("append path — T4 equal time", () => {
  it("appends a user line whose time equals the last numbered line's", async () => {
    const file = join(env.proj, `${S}.jsonl`);
    write(file, user("u1", 1, "question") + reply("a1", 2, text("answer"), "m-a"));
    await runIndex({});
    add(file, user("u2", 2, "same second"));
    const r = await runIndex({});
    expect(r.files_appended).toBe(1);
    expect(r.events_inserted).toBe(1);
    await expectDigestEqualsRebuild();
  });
});

describe("append path — T5 no new complete line", () => {
  it("a touch, then half a line, then the rest", async () => {
    const file = join(env.proj, `${S}.jsonl`);
    write(file, user("u1", 1, "question") + reply("a1", 2, text("answer"), "m-a"));
    await runIndex({});
    const before = cursor(file);

    bump(file);
    let r = await runIndex({});
    expect(r.files_appended).toBe(1);
    expect(r.events_inserted).toBe(0);
    expect(cursor(file)).toEqual({ ...before, mtime: statSync(file).mtimeMs / 1000 });
    await expectDigestEqualsRebuild();

    const next = user("u2", 3, "a line written in two parts");
    const half = Math.floor(next.length / 2);
    add(file, next.slice(0, half));
    r = await runIndex({});
    expect(r.files_appended).toBe(1);
    expect(r.events_inserted).toBe(0);
    expect(cursor(file)).toEqual({ ...before, mtime: statSync(file).mtimeMs / 1000, size: statSync(file).size });
    await expectDigestEqualsRebuild();

    add(file, next.slice(half));
    r = await runIndex({});
    expect(r.files_appended).toBe(1);
    expect(r.events_inserted).toBe(1);
    const size = statSync(file).size;
    expect(cursor(file)).toEqual({ mtime: statSync(file).mtimeMs / 1000, size, lines: before.lines + 1, last_ok: size });
    await expectDigestEqualsRebuild();
  });
});

describe("append path — T6 Codex", () => {
  it("appends a grown Codex rollout", async () => {
    const day = join(env.codex, "sessions", "2026", "07", "01");
    mkdirSync(day, { recursive: true });
    const file = join(day, "rollout-2026-07-01-codex-sess-1.jsonl");
    const cline = (o: object) => JSON.stringify(o) + "\n";
    write(
      file,
      cline({ timestamp: "2026-07-01T00:00:00Z", type: "session_meta", payload: { id: "codex-sess-1", cwd: "/w/app", cli_version: "1.0.0" } }) +
        cline({ timestamp: "2026-07-01T00:00:01Z", type: "turn_context", payload: { model: "gpt-5", cwd: "/w/app" } }) +
        cline({ timestamp: "2026-07-01T00:00:02Z", type: "event_msg", payload: { type: "user_message", message: "hello" } }),
    );
    await runIndex({});
    add(file, cline({ timestamp: "2026-07-01T00:00:03Z", type: "event_msg", payload: { type: "user_message", message: "again" } }));
    const r = await runIndex({});
    expect(r.files_parsed).toBe(1);
    expect(r.files_appended).toBe(1);
    await expectDigestEqualsRebuild();
  });
});

describe("append path — T7 rebuild", () => {
  it("a rebuild after an append re-derives every file", async () => {
    const file = join(env.proj, `${S}.jsonl`);
    write(file, user("u1", 1, "question") + reply("a1", 2, text("answer"), "m-a"));
    await runIndex({});
    add(file, user("u2", 3, "more"));
    expect((await runIndex({})).files_appended).toBe(1);
    const r = await runIndex({ rebuild: true });
    expect(r.files_parsed).toBe(1);
    expect(r.files_appended).toBe(0);
  });
});
