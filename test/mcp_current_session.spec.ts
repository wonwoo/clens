import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codexSessionFromMeta, detectCurrentSessionId, resolveSessionId } from "../src/mcp/current_session.js";

describe("resolveSessionId", () => {
  it("passes a plain session id through", () => {
    expect(resolveSessionId("abc", undefined)).toEqual({ ok: true, id: "abc" });
    expect(resolveSessionId("abc", "other")).toEqual({ ok: true, id: "abc" });
  });

  it("turns \"current\" into the detected session id", () => {
    expect(resolveSessionId("current", "s-now")).toEqual({ ok: true, id: "s-now" });
  });

  it("gives an error for \"current\" when no session id is known", () => {
    for (const none of [undefined, ""]) {
      const r = resolveSessionId("current", none);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('session_id "current" is not available here');
    }
  });
});

describe("detectCurrentSessionId", () => {
  const PID = 424242;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "clens-current-"));
    mkdirSync(join(home, "sessions"));
    process.env.CLENS_HOME = home;
  });

  afterEach(() => {
    delete process.env.CLENS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  function sessionFile(content: string): void {
    writeFileSync(join(home, "sessions", `${PID}.json`), content);
  }

  const ENV = { CLAUDE_CODE_SESSION_ID: "from-env" };

  it("prefers the per-process file's sessionId", () => {
    sessionFile(JSON.stringify({ sessionId: "from-file", pid: PID }));
    expect(detectCurrentSessionId(PID, ENV)).toBe("from-file");
  });

  it("falls back to the env value without a file", () => {
    expect(detectCurrentSessionId(PID, ENV)).toBe("from-env");
  });

  it("falls back to the env value when the file is not JSON", () => {
    sessionFile("not json");
    expect(detectCurrentSessionId(PID, ENV)).toBe("from-env");
  });

  it("falls back to the env value when sessionId is not a string", () => {
    sessionFile(JSON.stringify({ sessionId: 42, pid: PID }));
    expect(detectCurrentSessionId(PID, ENV)).toBe("from-env");
  });

  it("falls back to the env value when sessionId is empty", () => {
    sessionFile(JSON.stringify({ sessionId: "", pid: PID }));
    expect(detectCurrentSessionId(PID, ENV)).toBe("from-env");
  });

  it("falls back to the env value when the file's pid differs", () => {
    sessionFile(JSON.stringify({ sessionId: "from-file", pid: 999 }));
    expect(detectCurrentSessionId(PID, ENV)).toBe("from-env");
  });

  it("falls back to the env value when the file has no pid", () => {
    sessionFile(JSON.stringify({ sessionId: "from-file" }));
    expect(detectCurrentSessionId(PID, ENV)).toBe("from-env");
  });

  it("gives undefined with neither a file nor an env value", () => {
    expect(detectCurrentSessionId(PID, {})).toBeUndefined();
    expect(detectCurrentSessionId(PID, { CLAUDE_CODE_SESSION_ID: "" })).toBeUndefined();
  });
});

describe("codexSessionFromMeta", () => {
  it("reads the Codex thread from a tool call's _meta, the id clens stores", () => {
    expect(codexSessionFromMeta({
      callId: "c",
      "x-codex-turn-metadata": { session_id: "root", thread_id: "child", turn_id: "t" },
    })).toBe("child");
  });

  it("falls back to the session id without a thread id", () => {
    expect(codexSessionFromMeta({ "x-codex-turn-metadata": { session_id: "root" } })).toBe("root");
  });

  it("gives undefined without Codex metadata", () => {
    for (const meta of [
      undefined,
      null,
      {},
      { "x-codex-turn-metadata": "x" },
      { "x-codex-turn-metadata": { thread_id: "", session_id: "" } },
      "text",
    ]) {
      expect(codexSessionFromMeta(meta)).toBeUndefined();
    }
  });
});
