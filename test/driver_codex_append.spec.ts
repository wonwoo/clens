import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendCodexLines, CODEX_STATES_KEPT, forgetCodexStates } from "../src/indexer/codex_append.js";
import { digestAllTables } from "../src/indexer/digest.js";
import { openIndex, runIndex } from "../src/indexer/driver.js";
import { prepareStatements } from "../src/indexer/writer.js";

// A Codex rollout that only grew is indexed by parsing its new lines with the
// parser state the last parse of it ended with (src/indexer/codex_append.ts);
// every other change re-derives the session. Each test grows an index run by
// run in `a` and compares its digest with an index rebuilt from scratch in
// `b` over the same files (gate 2).

interface Env {
  root: string;
  codex: string;
  day: string;
  a: string;
  b: string;
}

let env: Env;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "clens-codex-append-"));
  const codex = join(root, ".codex");
  const day = join(codex, "sessions", "2026", "09", "01");
  const a = join(root, "a");
  mkdirSync(join(root, ".claude", "projects"), { recursive: true });
  mkdirSync(day, { recursive: true });
  mkdirSync(a, { recursive: true });
  process.env.CLENS_HOME = join(root, ".claude");
  process.env.CLENS_CODEX_HOME = codex;
  process.env.CLENS_INDEX_DIR = a;
  env = { root, codex, day, a, b: join(root, "b") };
  forgetCodexStates();
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

const rollout = (id: string) => join(env.day, `rollout-2026-09-01T00-00-00-${id}.jsonl`);

// Lines shaped as in test/codex_parser.spec.ts.
const at = (s: number) => `2026-09-01T00:00:${String(s).padStart(2, "0")}Z`;
const line = (s: number, type: string, payload: object) => JSON.stringify({ timestamp: at(s), type, payload }) + "\n";
const meta = (s: number, id: string, branch = "main") =>
  line(s, "session_meta", { id, cwd: "/w/app", cli_version: "1.0.0", git: { branch } });
const turn = (s: number, model: string) => line(s, "turn_context", { model, cwd: "/w/app" });
const userMsg = (s: number, text: string) => line(s, "event_msg", { type: "user_message", message: text });
const agentMsg = (s: number, text: string) => line(s, "event_msg", { type: "agent_message", message: text });
const tokens = (s: number) =>
  line(s, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5 } } });
const taskDone = (s: number) => line(s, "event_msg", { type: "task_complete" });
const compacted = (s: number) => line(s, "compacted", { message: "", replacement_history: [] });
const fcall = (s: number, callId: string, name: string, args: unknown) =>
  line(s, "response_item", { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) });
const fout = (s: number, callId: string, output: unknown) => line(s, "response_item", { type: "function_call_output", call_id: callId, output });
const exec = (s: number, callId: string, code: string) => line(s, "response_item", { type: "custom_tool_call", call_id: callId, name: "exec", input: code });
const execOut = (s: number, callId: string, output: string) =>
  line(s, "response_item", { type: "custom_tool_call_output", call_id: callId, output });
const ran = (s: number, command: string, exit_code: number) =>
  line(s, "event_msg", {
    type: "item_completed",
    item: { type: "CommandExecution", id: `e${s}`, command: ["/bin/zsh", "-lc", command], cwd: "file:///w/app/sub", exit_code, source: "unified_exec_startup" },
  });
const text = (t: string) => ({ type: "input_text", text: t });
const done = (header: string, ...printed: string[]) => [text(`${header}\nWall time 0.8 seconds\nOutput:\n`), ...printed.map(text)];
const result = (exit_code: number, output: string) =>
  JSON.stringify({ chunk_id: "263313", wall_time_seconds: 0.02, exit_code, original_token_count: 8, output });
const RUNNING = "Chunk ID: b\nWall time: 1.0 seconds\nProcess running with session ID 88693\nOriginal token count: 0\nOutput:\n";
const exited = (code: number) => `Chunk ID: c\nWall time: 5.0 seconds\nProcess exited with code ${code}\nOriginal token count: 3\nOutput:\nFAIL`;
/** exec code that builds its command at run time: only its CommandExecution item names it. */
const BUILT = 'const c = "echo hi > out.txt"; await tools.exec_command({cmd: c})';
const BLOCKED = "Command blocked by PreToolUse hook: pushes need review. Command: git push";

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

/** What appendCodexLines makes of the file as it is on disk now, without
 *  running the index: the fallback reason, or "appended". */
function appendOutcome(path: string): string {
  const db = openIndex();
  try {
    const st = statSync(path);
    const out = appendCodexLines(db, prepareStatements(db), {
      path,
      mtime: st.mtimeMs / 1000,
      size: st.size,
      needs_parse: true,
      source: "codex",
    });
    return out.kind === "full" ? out.reason : out.kind;
  } finally {
    db.close();
  }
}

function query<T>(sql: string, ...params: unknown[]): T | undefined {
  const db = new Database(join(env.a, "index.db"), { readonly: true });
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } finally {
    db.close();
  }
}

const hasSession = (id: string) => query("SELECT 1 FROM session WHERE id = ?", id) !== undefined;
const callEvent = (callId: string) => query<{ event_uuid: string }>("SELECT event_uuid FROM tool_call WHERE call_id = ?", callId)?.event_uuid;

/** One rollout holding every kind of line whose meaning depends on an
 *  earlier one: a call's output, a hook block and a file op added to an
 *  earlier call, results reported by later calls, tokens counted until
 *  task_complete, and a compaction. */
const X1_LINES = [
  meta(0, "s-x1"),
  turn(1, "m-1"),
  userMsg(2, "first question"),
  fcall(3, "c1", "exec_command", { cmd: "pwd" }),
  fout(4, "c1", "Chunk ID: a\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\n/w/app"),
  fcall(5, "c2", "exec_command", { cmd: "git push" }),
  fout(6, "c2", BLOCKED),
  exec(7, "x1", BUILT),
  ran(8, "echo hi > out.txt", 0),
  execOut(9, "x1", "Script completed\nOutput:\n"),
  fcall(10, "c3", "exec_command", { cmd: "npm test" }),
  fout(11, "c3", RUNNING),
  fcall(12, "w1", "write_stdin", { session_id: 88693, chars: "" }),
  fout(13, "w1", exited(1)),
  exec(14, "x2", 'const r = await tools.exec_command({cmd:"sleep 35; gh --version",yield_time_ms:1000});text(r);'),
  execOut(15, "x2", "Script running with cell ID 3\nWall time 31.0 seconds\nOutput:\n"),
  fcall(16, "w2", "wait", { cell_id: "3", yield_time_ms: 10000, max_tokens: 1000 }),
  fout(17, "w2", done("Script completed", result(127, "zsh:1: command not found: gh\n"))),
  agentMsg(18, "the tests fail"),
  tokens(19),
  taskDone(20),
  compacted(21),
  userMsg(22, "second question"),
  taskDone(23),
];

describe("Codex append path — X1 growth", () => {
  it("appends a rollout grown one line per run, and matches a rebuild after every run", async () => {
    const file = rollout("s-x1");
    for (const [i, l] of X1_LINES.entries()) {
      const indexed = i > 0 && hasSession("s-x1");
      if (i === 0) write(file, l);
      else add(file, l);
      const r = await runIndex({});
      expect(r.files_parsed).toBe(1);
      expect(r.files_appended).toBe(indexed ? 1 : 0);
      await expectDigestEqualsRebuild();
    }
    expect(query("SELECT is_error FROM tool_call WHERE call_id = 'c3'")).toEqual({ is_error: 1 });
    expect(query("SELECT is_error FROM tool_call WHERE call_id = 'x2'")).toEqual({ is_error: 1 });
  }, 120_000);

  it("resumes each append from the state the previous append left", async () => {
    // The rebuild in expectDigestEqualsRebuild parses the same rollout and
    // keeps its state, so the test above resumes every run from a fresh full
    // parse; here no rebuild runs until the end.
    const file = rollout("s-x1");
    for (const [i, l] of X1_LINES.entries()) {
      const indexed = i > 0 && hasSession("s-x1");
      if (i === 0) write(file, l);
      else add(file, l);
      expect((await runIndex({})).files_appended).toBe(indexed ? 1 : 0);
    }
    await expectDigestEqualsRebuild();
  }, 120_000);
});

describe("Codex append path — token counts of a turn that does not complete", () => {
  const started = (s: number) => line(s, "event_msg", { type: "task_started" });
  const aborted = (s: number) => line(s, "event_msg", { type: "turn_aborted", reason: "interrupted" });

  // An interrupted turn writes its counts at turn_aborted, one cut off by the
  // next task_started at that line; the counts come from the state an earlier
  // run left when the token_count line was appended alone.
  it("writes them on the run that appends turn_aborted or task_started, and matches a rebuild after every run", async () => {
    const lines = [
      meta(0, "s-ab"),
      turn(1, "m-1"),
      started(2),
      tokens(3),
      aborted(4),
      started(5),
      tokens(6),
      started(7),
      tokens(8),
      taskDone(9),
    ];
    const file = rollout("s-ab");
    for (const [i, l] of lines.entries()) {
      const indexed = i > 0 && hasSession("s-ab");
      if (i === 0) write(file, l);
      else add(file, l);
      const r = await runIndex({});
      expect(r.files_parsed).toBe(1);
      expect(r.files_appended).toBe(indexed ? 1 : 0);
      await expectDigestEqualsRebuild();
    }
    expect(query("SELECT COUNT(*) AS n FROM event WHERE session_id = 's-ab' AND in_tok > 0")).toEqual({ n: 3 });
  }, 120_000);
});

describe("Codex append path — X2 rows added to earlier events", () => {
  it("writes the file op a CommandExecution item adds to an exec call of an earlier run", async () => {
    const file = rollout("s-x2");
    write(file, meta(0, "s-x2") + turn(1, "m-1") + userMsg(2, "go") + exec(3, "x1", BUILT));
    await runIndex({});
    add(file, ran(4, "echo hi > out.txt", 0) + execOut(5, "x1", "Script completed\nOutput:\n") + taskDone(6));
    expect((await runIndex({})).files_appended).toBe(1);
    const op = query<{ event_uuid: string }>("SELECT event_uuid FROM file_op WHERE path = '/w/app/sub/out.txt'");
    expect(op?.event_uuid).toBe(callEvent("x1"));
    await expectDigestEqualsRebuild();
  });

  it("writes the hook block a call's PreToolUse output adds to a call of an earlier run", async () => {
    const file = rollout("s-x2");
    write(file, meta(0, "s-x2") + turn(1, "m-1") + userMsg(2, "push it") + fcall(3, "c9", "exec_command", { cmd: "git push" }));
    await runIndex({});
    add(file, fout(4, "c9", BLOCKED) + taskDone(5));
    expect((await runIndex({})).files_appended).toBe(1);
    const block = query<{ event_uuid: string; reason: string }>("SELECT event_uuid, reason FROM hook_block WHERE call_id = 'c9'");
    expect(block).toEqual({ event_uuid: callEvent("c9"), reason: "pushes need review" });
    await expectDigestEqualsRebuild();
  });
});

describe("Codex append path — X3 a later result for an earlier call", () => {
  it("fails a running exec_command of an earlier run from the write_stdin that reports its nonzero exit", async () => {
    const file = rollout("s-x3");
    write(file, meta(0, "s-x3") + turn(1, "m-1") + userMsg(2, "test it") + fcall(3, "c1", "exec_command", { cmd: "npm test" }) + fout(4, "c1", RUNNING));
    await runIndex({});
    expect(query("SELECT is_error FROM tool_call WHERE call_id = 'c1'")).toEqual({ is_error: 0 });
    add(file, fcall(5, "w1", "write_stdin", { session_id: 88693, chars: "" }) + fout(6, "w1", exited(1)));
    expect((await runIndex({})).files_appended).toBe(1);
    expect(query("SELECT is_error FROM tool_call WHERE call_id = 'c1'")).toEqual({ is_error: 1 });
    await expectDigestEqualsRebuild();
  });
});

describe("Codex append path — X4 changes that re-derive the session", () => {
  const BASE = meta(0, "s-x4") + turn(1, "m-1") + userMsg(2, "question") + agentMsg(3, "answer");

  /** Index `base`, apply `change`, and check that the append path refuses it
   *  for `reason` and the run re-derives the session. */
  async function expectFallback(reason: string, change: (file: string) => void, base = BASE): Promise<void> {
    const file = rollout("s-x4");
    write(file, base);
    expect((await runIndex({})).files_appended).toBe(0);
    change(file);
    expect(appendOutcome(file)).toBe(reason);
    const r = await runIndex({});
    expect(r.files_parsed).toBe(1);
    expect(r.files_appended).toBe(0);
    await expectDigestEqualsRebuild();
  }

  it("no_state: the kept states were forgotten", async () => {
    await expectFallback("no_state", (f) => {
      forgetCodexStates();
      add(f, userMsg(4, "more"));
    });
  });

  it("no_state: the kept state is ahead of the cursor, after another index read the grown rollout", async () => {
    const file = rollout("s-x4");
    write(file, BASE);
    await runIndex({});
    add(file, userMsg(4, "more"));
    process.env.CLENS_INDEX_DIR = join(env.root, "c");
    try {
      await runIndex({});
    } finally {
      process.env.CLENS_INDEX_DIR = env.a;
    }
    expect(appendOutcome(file)).toBe("no_state");
    const r = await runIndex({});
    expect(r.files_parsed).toBe(1);
    expect(r.files_appended).toBe(0);
    await expectDigestEqualsRebuild();
  });

  describe("skills_changed: an earlier message names $x4skill", () => {
    const base = meta(0, "s-x4") + turn(1, "m-1") + userMsg(2, "use $x4skill please") + taskDone(3);
    const skill = () => join(env.codex, "skills", "x4skill");

    it("the skill folder is created between runs", async () => {
      await expectFallback("skills_changed", (f) => {
        mkdirSync(skill(), { recursive: true });
        add(f, userMsg(4, "again"));
      }, base);
      expect(query("SELECT skill FROM skill_call WHERE session_id = 's-x4'")).toEqual({ skill: "x4skill" });
    });

    it("the skill folder present at the first run is removed between runs", async () => {
      mkdirSync(skill(), { recursive: true });
      await expectFallback("skills_changed", (f) => {
        rmSync(skill(), { recursive: true });
        add(f, userMsg(4, "again"));
      }, base);
      expect(query("SELECT skill FROM skill_call WHERE session_id = 's-x4'")).toBeUndefined();
    });

    it("a symlink at the skill path gets its missing target between runs", async () => {
      // The folder names stay the same; only checking the decision again
      // sees the change.
      const target = join(env.root, "skill-target");
      mkdirSync(join(env.codex, "skills"), { recursive: true });
      symlinkSync(target, skill());
      await expectFallback("skills_changed", (f) => {
        mkdirSync(target);
        add(f, userMsg(4, "again"));
      }, base);
      expect(query("SELECT skill FROM skill_call WHERE session_id = 's-x4'")).toEqual({ skill: "x4skill" });
    });
  });

  it("meta_changed: a second own session_meta on another branch", async () => {
    await expectFallback("meta_changed", (f) => add(f, meta(4, "s-x4", "feature") + userMsg(5, "on a branch")));
  });

  it("torn_first_line: the first new line is not JSON", async () => {
    await expectFallback("torn_first_line", (f) => add(f, "the tail of a rewritten line\n" + userMsg(4, "more")));
  });

  it("out_of_order: a user line 1 s before the last numbered line", async () => {
    await expectFallback("out_of_order", (f) => add(f, userMsg(1, "late question")));
  });

  it("model_tie: one m-1 reply, then a turn on m-2 with one reply", async () => {
    await expectFallback("model_tie", (f) => add(f, turn(4, "m-2") + agentMsg(5, "other model")));
  });

  it("shrunk: the rollout lost its last line", async () => {
    await expectFallback("shrunk", (f) => write(f, BASE), BASE + userMsg(4, "dropped later"));
  });

  it("not_line_start: the rollout rewritten in place, longer, with the old end inside a line", async () => {
    await expectFallback("not_line_start", (f) =>
      write(f, meta(0, "s-x4") + turn(1, "m-1") + userMsg(2, "a question rewritten much longer than before") + agentMsg(3, "answer")),
    );
  });

  it("several_files: the session also has rows from a second rollout", async () => {
    // Every run re-derives a session from one file, so the index holds a
    // session's rows from two files only when something else wrote them;
    // the test moves one row to a second rollout by hand.
    const other = rollout("s-other");
    write(other, meta(0, "s-other") + userMsg(1, "second rollout"));
    await expectFallback("several_files", (f) => {
      const db = new Database(join(env.a, "index.db"));
      db.prepare("UPDATE event SET source_file = ? WHERE uuid = ?").run(other, `codex:${f}:3`);
      db.close();
      add(f, userMsg(4, "more"));
    });
  });

  it("several_sessions: a line before the rollout's session_meta", async () => {
    // That line's event goes to a session of its own, whose span a
    // re-derivation takes from the whole file.
    const base = userMsg(0, "before the session_meta") + meta(1, "s-x4") + turn(2, "m-1") + userMsg(3, "question") + agentMsg(4, "answer");
    await expectFallback("several_sessions", (f) => add(f, userMsg(5, "more")), base);
  });

  it("a pretty-printed rollout keeps no state", async () => {
    // The full path parses a pretty-printed rollout compacted (one line per
    // object) and stores last_ok of that compacted text. The spaces after the
    // first "{\n" make the file's byte before that offset the \n ending the
    // second object, so the run gets past the cursor checks to no_state.
    const first = meta(0, "s-x4").trimEnd();
    const second = userMsg(2, "question");
    const third = agentMsg(3, "answer");
    const pretty = "{\n" + " ".repeat(third.length - 1) + first.slice(1) + "\n" + second + third;
    await expectFallback("no_state", (f) => add(f, userMsg(4, "more")), pretty);
  });
});

describe("Codex append path — X7 results written as a re-derivation writes them", () => {
  // Re-deriving writes each call's newest result onto every row of that call
  // id in the rollout's own session whose duration is still empty
  // (updateToolCallResult).
  const mcpItem = (s: number, id: string) =>
    line(s, "event_msg", {
      type: "item_completed",
      item: { type: "McpToolCall", id, server: "clens", tool: "clens_search", arguments: {}, status: "completed", result: { content: [] }, duration: { secs: 0, nanos: 205000000 } },
    });

  it("a result an earlier line left for a call the new lines bring is written to that call", async () => {
    const file = rollout("s-x7a");
    write(file, meta(0, "s-x7a") + userMsg(1, "go") + fout(2, "c9", exited(1)));
    await runIndex({});
    add(file, fcall(3, "c9", "exec_command", { cmd: "npm test" }));
    expect((await runIndex({})).files_appended).toBe(1);
    expect(query("SELECT is_error FROM tool_call WHERE call_id = 'c9'")).toEqual({ is_error: 1 });
    await expectDigestEqualsRebuild();
  });

  it("a result for a call parsed with its duration goes the full way", async () => {
    const file = rollout("s-x7b");
    write(file, meta(0, "s-x7b") + userMsg(1, "go") + mcpItem(2, "exec-a"));
    await runIndex({});
    add(file, fout(3, "exec-a", exited(1)));
    expect(appendOutcome(file)).toBe("prefilled_result");
    expect((await runIndex({})).files_appended).toBe(0);
    await expectDigestEqualsRebuild();
  });

  it("a result for a call id another session also holds goes the full way", async () => {
    const first = rollout("s-x7c1");
    const second = rollout("s-x7c2");
    write(first, meta(0, "s-x7c1") + userMsg(1, "go") + fcall(2, "c7", "exec_command", { cmd: "npm test" }));
    write(second, meta(0, "s-x7c2") + userMsg(1, "go") + fcall(2, "c7", "exec_command", { cmd: "npm test" }));
    await runIndex({});
    add(second, fout(3, "c7", exited(1)));
    expect(appendOutcome(second)).toBe("shared_call_id");
    expect((await runIndex({})).files_appended).toBe(0);
    await expectDigestEqualsRebuild();
  });

  // Before v19 re-deriving a rollout also filled other sessions' empty rows
  // of its call ids, so its rows depended on which file was indexed last.
  // The guard that came of it stays, stricter than needed.
  it("an earlier result whose call id a session indexed later also holds goes the full way", async () => {
    const first = rollout("s-x7d1");
    write(first, meta(0, "s-x7d1") + userMsg(1, "go") + fcall(2, "c7", "exec_command", { cmd: "npm test" }) + fout(3, "c7", exited(1)));
    await runIndex({});
    write(rollout("s-x7d2"), meta(0, "s-x7d2") + userMsg(1, "go") + fcall(2, "c7", "exec_command", { cmd: "npm test" }));
    await runIndex({});
    add(first, userMsg(4, "again"));
    expect(appendOutcome(first)).toBe("shared_call_id");
    expect((await runIndex({})).files_appended).toBe(0);
  });

  it("another rollout's result for a call id leaves this rollout's call empty, and appending to it equals a rebuild", async () => {
    const first = rollout("s-x7e1");
    write(first, meta(0, "s-x7e1") + userMsg(1, "go") + fcall(2, "c8", "exec_command", { cmd: "npm test" }));
    await runIndex({});
    write(rollout("s-x7e2"), meta(0, "s-x7e2") + userMsg(1, "go") + fout(2, "c8", exited(1)));
    await runIndex({});
    expect(query("SELECT duration_ms, is_error FROM tool_call WHERE call_id = 'c8'")).toEqual({ duration_ms: null, is_error: 0 });
    add(first, userMsg(3, "again"));
    expect((await runIndex({})).files_appended).toBe(1);
    await expectDigestEqualsRebuild();
  });

  it("a call id with a row parsed with its duration and another row goes the full way", async () => {
    const first = rollout("s-x7f1");
    write(first, meta(0, "s-x7f1") + userMsg(1, "go") + mcpItem(2, "exec-z") + fcall(3, "exec-z", "exec_command", { cmd: "npm test" }));
    await runIndex({});
    write(rollout("s-x7f2"), meta(0, "s-x7f2") + userMsg(1, "go") + fout(2, "exec-z", exited(1)));
    await runIndex({});
    add(first, userMsg(4, "again"));
    expect(appendOutcome(first)).toBe("prefilled_result");
    expect((await runIndex({})).files_appended).toBe(0);
  });
});

describe("Codex append path — X5 store bound", () => {
  it(`keeps the states of the last ${CODEX_STATES_KEPT} rollouts used`, async () => {
    const files = Array.from({ length: CODEX_STATES_KEPT + 1 }, (_, i) => rollout(`s-x5-${i}`));
    // One run per rollout, so the first one indexed is the least recently used.
    for (const [i, file] of files.entries()) {
      write(file, meta(0, `s-x5-${i}`) + userMsg(1, "question"));
      expect((await runIndex({})).files_parsed).toBe(1);
    }
    const first = files[0]!;
    const last = files[files.length - 1]!;
    add(first, userMsg(2, "more"));
    add(last, userMsg(2, "more"));
    expect(appendOutcome(first)).toBe("no_state");
    const r = await runIndex({});
    expect(r.files_parsed).toBe(2);
    expect(r.files_appended).toBe(1);
    expect(query("SELECT 1 AS appended FROM event WHERE uuid = ?", `codex:${last}:3`)).toEqual({ appended: 1 });
    await expectDigestEqualsRebuild();
  }, 60_000);
});
