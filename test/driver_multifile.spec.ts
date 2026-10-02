import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runIndex } from "../src/indexer/driver.js";
import { digestAllTables } from "../src/indexer/digest.js";

// A session's lines can appear in more than one Claude transcript: a subagent's
// transcript (<session>/subagents/agent-*.jsonl) carries the parent's sessionId,
// and a session continued into a new file starts that file with copies of the
// old session's lines. Re-reading one file used to wipe every session it
// mentioned and refill it from that file alone, so reading the parent after
// its subagent, or the copy after the original, deleted the rest.

interface Env {
  root: string;
  proj: string;
  clens: string;
}

let env: Env;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "clens-multifile-"));
  const proj = join(root, ".claude", "projects", "-w-app");
  const clens = join(root, ".clens");
  mkdirSync(proj, { recursive: true });
  mkdirSync(clens, { recursive: true });
  process.env.CLENS_HOME = join(root, ".claude");
  process.env.CLENS_INDEX_DIR = clens;
  env = { root, proj, clens };
});

afterEach(() => {
  rmSync(env.root, { recursive: true, force: true });
  delete process.env.CLENS_HOME;
  delete process.env.CLENS_INDEX_DIR;
});

const line = (uuid: string, sessionId: string, role: "user" | "assistant", text: string, ts: string, extra: object = {}) =>
  JSON.stringify({
    uuid,
    sessionId,
    type: role,
    timestamp: ts,
    cwd: "/w/app",
    message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] },
    ...extra,
  }) + "\n";

/** Give a file a later mtime than everything written before it, so the next
 *  incremental run re-reads it and reads it last. */
let clock = 1_900_000_000;
function bump(path: string): void {
  clock += 10;
  utimesSync(path, clock, clock);
}

function texts(sessionId: string): string[] {
  const db = new Database(join(env.clens, "index.db"), { readonly: true });
  const rows = db
    .prepare("SELECT text FROM user_text WHERE session_id = ? ORDER BY ts")
    .all(sessionId) as { text: string }[];
  db.close();
  return rows.map((r) => r.text);
}

function sessionRow(id: string): { project_id: string; kind: string; parent_id: string | null } | undefined {
  const db = new Database(join(env.clens, "index.db"), { readonly: true });
  const row = db.prepare("SELECT project_id, kind, parent_id FROM session WHERE id = ?").get(id) as
    | { project_id: string; kind: string; parent_id: string | null }
    | undefined;
  db.close();
  return row;
}

function digest(): string {
  const db = new Database(join(env.clens, "index.db"), { readonly: true });
  const d = JSON.stringify(digestAllTables(db));
  db.close();
  return d;
}

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

describe("indexer — a session spread over several transcripts", () => {
  it("a subagent transcript is stored as its own session and never wipes its parent", async () => {
    const main = join(env.proj, `${A}.jsonl`);
    writeFileSync(main, line("m1", A, "user", "main question", "2026-09-01T00:00:01Z") + line("m2", A, "assistant", "main answer", "2026-09-01T00:00:02Z"));
    bump(main);
    const sub = join(env.proj, A, "subagents", "agent-x1.jsonl");
    mkdirSync(join(env.proj, A, "subagents"), { recursive: true });
    const side = { isSidechain: true, agentId: "x1" };
    writeFileSync(sub, line("s1", A, "user", "sub prompt", "2026-09-01T00:00:03Z", side));
    bump(sub);
    await runIndex();
    expect(texts(A)).toEqual(["main question", "main answer"]);

    // The subagent file changes after the parent was read: it is re-read last.
    appendFileSync(sub, line("s2", A, "assistant", "sub answer", "2026-09-01T00:00:04Z", side));
    bump(sub);
    await runIndex();
    expect(texts(A)).toEqual(["main question", "main answer"]);
    expect(texts("agent-x1")).toEqual(["sub prompt", "sub answer"]);
    expect(sessionRow("agent-x1")).toEqual({ project_id: "-w-app", kind: "subagent", parent_id: A });
    expect(sessionRow(A)).toMatchObject({ kind: "interactive", parent_id: null });
  });

  it("a workflow agent's transcript, one level deeper, never wipes its parent session either", async () => {
    const main = join(env.proj, `${A}.jsonl`);
    writeFileSync(main, line("m1", A, "user", "main question", "2026-09-01T00:00:01Z") + line("m2", A, "assistant", "main answer", "2026-09-01T00:00:02Z"));
    bump(main);
    const dir = join(env.proj, A, "subagents", "workflows", "wf_1");
    mkdirSync(dir, { recursive: true });
    const sub = join(dir, "agent-w1.jsonl");
    const side = { isSidechain: true, agentId: "w1" };
    writeFileSync(sub, line("w1", A, "user", "workflow agent prompt", "2026-09-01T00:00:03Z", side));
    bump(sub);
    await runIndex();
    // The agent's file changes after the parent was read: it is re-read alone.
    appendFileSync(sub, line("w2", A, "assistant", "workflow agent answer", "2026-09-01T00:00:04Z", side));
    bump(sub);
    await runIndex();
    expect(texts(A)).toEqual(["main question", "main answer"]);
    expect(texts("agent-w1")).toEqual(["workflow agent prompt", "workflow agent answer"]);
    expect(sessionRow("agent-w1")).toEqual({ project_id: "-w-app", kind: "subagent", parent_id: A });
    const incremental = digest();
    await runIndex({ rebuild: true });
    expect(digest()).toBe(incremental);
  });

  it("a later file that starts with copies of an older session does not cut off the original's tail", async () => {
    const orig = join(env.proj, `${A}.jsonl`);
    writeFileSync(
      orig,
      line("a1", A, "user", "first question", "2026-09-01T00:00:01Z") +
        line("a2", A, "assistant", "first answer", "2026-09-01T00:00:02Z") +
        line("a3", A, "user", "tail question", "2026-09-01T00:00:03Z") +
        line("a4", A, "assistant", "tail answer", "2026-09-01T00:00:04Z"),
    );
    bump(orig);
    const cont = join(env.proj, `${B}.jsonl`);
    writeFileSync(
      cont,
      line("a1", A, "user", "first question", "2026-09-01T00:00:01Z") +
        line("a2", A, "assistant", "first answer", "2026-09-01T00:00:02Z") +
        line("b1", B, "user", "continued question", "2026-09-02T00:00:01Z"),
    );
    bump(cont);
    await runIndex();
    const full = ["first question", "first answer", "tail question", "tail answer"];
    expect(texts(A)).toEqual(full);
    expect(texts(B)).toEqual(["continued question"]);

    appendFileSync(cont, line("b2", B, "assistant", "continued answer", "2026-09-02T00:00:02Z"));
    bump(cont);
    await runIndex();
    expect(texts(A)).toEqual(full);
    expect(texts(B)).toEqual(["continued question", "continued answer"]);
  });

  it("copied lines are kept when the original session is not in the index", async () => {
    const cont = join(env.proj, `${B}.jsonl`);
    writeFileSync(
      cont,
      line("a1", A, "user", "first question", "2026-09-01T00:00:01Z") +
        line("b1", B, "user", "continued question", "2026-09-02T00:00:01Z"),
    );
    await runIndex();
    expect(texts(A)).toEqual(["first question"]);
    expect(texts(B)).toEqual(["continued question"]);
  });

  it("gate 2: after these changes, incremental state equals a full rebuild", async () => {
    const orig = join(env.proj, `${A}.jsonl`);
    writeFileSync(orig, line("a1", A, "user", "first question", "2026-09-01T00:00:01Z") + line("a3", A, "user", "tail question", "2026-09-01T00:00:03Z"));
    bump(orig);
    const cont = join(env.proj, `${B}.jsonl`);
    writeFileSync(cont, line("a1", A, "user", "first question", "2026-09-01T00:00:01Z") + line("b1", B, "user", "continued question", "2026-09-02T00:00:01Z"));
    bump(cont);
    mkdirSync(join(env.proj, A, "subagents"), { recursive: true });
    const sub = join(env.proj, A, "subagents", "agent-x1.jsonl");
    writeFileSync(sub, line("s1", A, "user", "sub prompt", "2026-09-01T00:00:05Z", { isSidechain: true }));
    bump(sub);
    await runIndex();
    appendFileSync(cont, line("b2", B, "assistant", "continued answer", "2026-09-02T00:00:02Z"));
    bump(cont);
    appendFileSync(sub, line("s2", A, "assistant", "sub answer", "2026-09-01T00:00:06Z", { isSidechain: true }));
    bump(sub);
    await runIndex();
    const incremental = digest();
    await runIndex({ rebuild: true });
    expect(digest()).toBe(incremental);
  });
});

describe("indexer — a rebuild keeps sessions whose transcripts are gone", () => {
  // Claude Code deletes old transcripts, so the index is the only copy of
  // those sessions. A rebuild used to empty every table and re-read only the
  // files still on disk, which deleted them for good.
  it("--rebuild re-reads the files on disk and leaves the rest as it was", async () => {
    const gone = join(env.proj, `${A}.jsonl`);
    writeFileSync(gone, line("a1", A, "user", "old question", "2026-05-01T00:00:01Z") + line("a2", A, "assistant", "old answer", "2026-05-01T00:00:02Z"));
    bump(gone);
    const kept = join(env.proj, `${B}.jsonl`);
    writeFileSync(kept, line("b1", B, "user", "recent question", "2026-09-01T00:00:01Z"));
    bump(kept);
    await runIndex();
    unlinkSync(gone);
    await runIndex();
    const before = digest();

    await runIndex({ rebuild: true });
    expect(texts(A)).toEqual(["old question", "old answer"]);
    expect(texts(B)).toEqual(["recent question"]);
    expect(digest()).toBe(before);
  });

  it("a session still on disk is rebuilt from its file", async () => {
    const kept = join(env.proj, `${B}.jsonl`);
    writeFileSync(kept, line("b1", B, "user", "recent question", "2026-09-01T00:00:01Z"));
    await runIndex();
    const db = new Database(join(env.clens, "index.db"));
    db.prepare("UPDATE user_text SET text = 'tampered' WHERE session_id = ?").run(B);
    db.close();
    await runIndex({ rebuild: true });
    expect(texts(B)).toEqual(["recent question"]);
  });
});

describe("indexer — a Codex subagent rollout next to its parent", () => {
  const cline = (ordinal: number, type: string, payload: object) =>
    JSON.stringify({ timestamp: `2026-09-15T00:${String(ordinal).padStart(2, "0")}:00Z`, ordinal, type, payload }) + "\n";
  const said = (ordinal: number, t: "UserMessage" | "AgentMessage", text: string) =>
    cline(ordinal, "event_msg", { type: "item_completed", item: { type: t, id: `i${ordinal}`, content: [{ type: t === "UserMessage" ? "text" : "Text", text }] } });

  it("reading the subagent's file after the parent's leaves the parent whole", async () => {
    const codex = join(env.root, ".codex");
    const day = join(codex, "sessions", "2026", "09", "15");
    mkdirSync(day, { recursive: true });
    process.env.CLENS_CODEX_HOME = codex;
    try {
      const parent = join(day, "rollout-2026-09-15T00-00-00-parent.jsonl");
      writeFileSync(
        parent,
        cline(0, "session_meta", { id: "parent", cwd: "/w/app" }) +
          said(1, "UserMessage", "parent question") +
          said(2, "AgentMessage", "parent answer") +
          said(3, "UserMessage", "parent follow-up"),
      );
      bump(parent);
      const child = join(day, "rollout-2026-09-15T00-10-00-child.jsonl");
      writeFileSync(
        child,
        cline(0, "session_meta", { id: "child", cwd: "/w/app", subagent_history_start_ordinal: 3, forked_from_id: "parent" }) +
          cline(1, "session_meta", { id: "parent", cwd: "/w/app" }) +
          said(2, "UserMessage", "parent question") +
          said(3, "UserMessage", "review this") +
          said(4, "AgentMessage", "reviewed"),
      );
      bump(child);
      await runIndex();
      expect(texts("parent")).toEqual(["parent question", "parent answer", "parent follow-up"]);
      expect(texts("child")).toEqual(["review this", "reviewed"]);
      const incremental = digest();
      await runIndex({ rebuild: true });
      expect(digest()).toBe(incremental);
    } finally {
      delete process.env.CLENS_CODEX_HOME;
    }
  });

  it("a session its file no longer yields is dropped, as a rebuild would", async () => {
    const codex = join(env.root, ".codex");
    const day = join(codex, "sessions", "2026", "09", "15");
    mkdirSync(day, { recursive: true });
    process.env.CLENS_CODEX_HOME = codex;
    try {
      const child = join(day, "rollout-2026-09-15T00-10-00-child.jsonl");
      const write = (copied: boolean) =>
        writeFileSync(
          child,
          cline(0, "session_meta", { id: "child", cwd: "/w/app", subagent_history_start_ordinal: 9 }) +
            (copied ? cline(1, "session_meta", { id: "parent", cwd: "/w/app" }) : "") +
            said(2, "UserMessage", "review this") +
            said(3, "AgentMessage", "reviewed"),
        );
      write(false);
      bump(child);
      await runIndex();
      expect(texts("child")).toEqual(["review this", "reviewed"]);
      // Read again with every line after the copied parent session_meta
      // counted as copied history: nothing of the child is left.
      write(true);
      bump(child);
      await runIndex();
      expect(texts("child")).toEqual([]);
      const incremental = digest();
      await runIndex({ rebuild: true });
      expect(digest()).toBe(incremental);
    } finally {
      delete process.env.CLENS_CODEX_HOME;
    }
  });

  it("Codex shell calls: an append read incrementally matches a rebuild", async () => {
    const codex = join(env.root, ".codex");
    const day = join(codex, "sessions", "2026", "09", "15");
    mkdirSync(day, { recursive: true });
    process.env.CLENS_CODEX_HOME = codex;
    const fcall = (ordinal: number, callId: string, cmd: string) =>
      cline(ordinal, "response_item", { type: "function_call", call_id: callId, name: "exec_command", arguments: JSON.stringify({ cmd }) });
    const fout = (ordinal: number, callId: string, output: string) =>
      cline(ordinal, "response_item", { type: "function_call_output", call_id: callId, output });
    try {
      const file = join(day, "rollout-2026-09-15T00-20-00-sh.jsonl");
      writeFileSync(
        file,
        cline(0, "session_meta", { id: "sh", cwd: "/w/app" }) +
          fcall(1, "c1", "echo hi > a.txt") +
          fout(2, "c1", "Chunk ID: a\nWall time: 0\nProcess exited with code 0\nOutput:\n"),
      );
      bump(file);
      await runIndex();
      appendFileSync(
        file,
        fcall(3, "c2", "git commit -m x && false") +
          fout(4, "c2", "Chunk ID: b\nWall time: 0\nProcess exited with code 1\nOutput:\n") +
          fcall(5, "c3", "git push") +
          fout(6, "c3", "Command blocked by PreToolUse hook: pushes need review. Command: git push") +
          cline(7, "event_msg", {
            type: "item_completed",
            item: { type: "HookPrompt", id: "h1", fragments: [{ text: "keep going", hookRunId: "stop:0:/w/.codex/hooks.json" }] },
          }) +
          cline(8, "response_item", { type: "custom_tool_call", call_id: "x1", name: "exec", input: 'await tools.exec_command({cmd:"ls /nope"})' }) +
          cline(9, "event_msg", {
            type: "item_completed",
            item: { type: "CommandExecution", id: "e1", command: ["/bin/zsh", "-lc", "ls /nope"], exit_code: 1, status: "failed" },
          }) +
          cline(10, "response_item", { type: "custom_tool_call_output", call_id: "x1", output: "Script completed\nOutput:\n" }) +
          fcall(11, "c4", "npm test") +
          fout(12, "c4", "Chunk ID: c\nWall time: 1\nProcess running with session ID 7\nOutput:\n") +
          cline(13, "response_item", { type: "function_call", call_id: "w1", name: "write_stdin", arguments: JSON.stringify({ session_id: 7, chars: "" }) }) +
          fout(14, "w1", "Chunk ID: d\nWall time: 5\nProcess exited with code 1\nOutput:\n") +
          cline(15, "response_item", { type: "custom_tool_call", call_id: "x2", name: "exec", input: 'const c = "echo hi > b.txt"; await tools.exec_command({cmd: c})' }) +
          cline(16, "event_msg", {
            type: "item_completed",
            item: { type: "CommandExecution", id: "e2", command: ["/bin/zsh", "-lc", "echo hi > b.txt"], cwd: "file:///w/app", exit_code: 0 },
          }) +
          cline(17, "response_item", { type: "custom_tool_call_output", call_id: "x2", output: "Script completed\nOutput:\n" }),
      );
      bump(file);
      await runIndex();

      const db = new Database(join(env.clens, "index.db"), { readonly: true });
      const calls = db.prepare("SELECT name, is_error, result_chars FROM tool_call WHERE session_id = 'sh' ORDER BY ts").all();
      const ops = db.prepare("SELECT tool, path FROM file_op WHERE session_id = 'sh'").all();
      const blocks = db.prepare("SELECT hook_event, tool, call_id, reason FROM hook_block WHERE session_id = 'sh' ORDER BY ts").all();
      db.close();
      expect(calls).toEqual([
        { name: "exec_command", is_error: 0, result_chars: 60 },
        { name: "exec_command", is_error: 1, result_chars: 60 },
        { name: "exec_command", is_error: 1, result_chars: 73 },
        { name: "exec", is_error: 1, result_chars: 25 },
        { name: "exec_command", is_error: 1, result_chars: 67 },
        { name: "write_stdin", is_error: 0, result_chars: 60 },
        { name: "exec", is_error: 0, result_chars: 25 },
      ]);
      expect(ops).toEqual([
        { tool: "exec_command", path: "/w/app/a.txt" },
        { tool: "exec_command", path: "/w/app/b.txt" },
      ]);
      expect(blocks).toEqual([
        { hook_event: "PreToolUse", tool: "exec_command", call_id: "c3", reason: "pushes need review" },
        { hook_event: "Stop", tool: null, call_id: null, reason: "keep going" },
      ]);

      const incremental = digest();
      await runIndex({ rebuild: true });
      expect(digest()).toBe(incremental);
    } finally {
      delete process.env.CLENS_CODEX_HOME;
    }
  });

  it("stores how each Codex session was started as its kind", async () => {
    const codex = join(env.root, ".codex");
    const day = join(codex, "sessions", "2026", "09", "15");
    mkdirSync(day, { recursive: true });
    process.env.CLENS_CODEX_HOME = codex;
    try {
      const file = (name: string, meta: object) =>
        writeFileSync(join(day, `rollout-2026-09-15T00-00-00-${name}.jsonl`), cline(0, "session_meta", { id: name, ...meta }) + said(1, "UserMessage", "hi"));
      file("tui", { cwd: "/w/app", source: "cli" });
      file("run", { cwd: "/w/app", source: "exec" });
      file("child", { cwd: "/w/app", source: { subagent: { thread_spawn: { parent_thread_id: "tui" } } } });
      file("judge", { cwd: join(env.clens, "judge-cwd"), source: "exec" });
      await runIndex();
      const db = new Database(join(env.clens, "index.db"), { readonly: true });
      const kinds = Object.fromEntries((db.prepare("SELECT id, kind FROM session").all() as { id: string; kind: string }[]).map((r) => [r.id, r.kind]));
      db.close();
      expect(kinds).toEqual({ tui: "interactive", run: "exec", child: "subagent", judge: "pipeline" });
      expect(sessionRow("child")!.parent_id).toBe("tui");
    } finally {
      delete process.env.CLENS_CODEX_HOME;
    }
  });
});

describe("indexer — a Claude Code session a program started", () => {
  it("stores a Claude Code session started through the SDK as exec", async () => {
    writeFileSync(join(env.proj, "tui.jsonl"), line("t1", "tui", "user", "hi", "2026-09-15T00:00:00Z", { entrypoint: "cli" }));
    writeFileSync(join(env.proj, "run.jsonl"), line("r1", "run", "user", "hi", "2026-09-15T00:00:00Z", { entrypoint: "sdk-cli" }));
    writeFileSync(join(env.proj, "app.jsonl"), line("a1", "app", "user", "hi", "2026-09-15T00:00:00Z", { entrypoint: "claude-desktop" }));
    await runIndex();
    const db = new Database(join(env.clens, "index.db"), { readonly: true });
    const kinds = Object.fromEntries((db.prepare("SELECT id, kind FROM session").all() as { id: string; kind: string }[]).map((r) => [r.id, r.kind]));
    db.close();
    expect(kinds).toEqual({ tui: "interactive", run: "exec", app: "interactive" });
    const incremental = digest();
    await runIndex({ rebuild: true });
    expect(digest()).toBe(incremental);
  });
});
