import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySchema } from "../src/indexer/schema.js";
import { registerLanguage, resetLanguageRegistry } from "../src/indexer/lang/registry.js";
import { closeAnalyzerServer, remoteAnalyzers, searchAnalyzers, serveAnalyzers } from "../src/mcp/analyzers.js";
import { queryTerms, searchUserText } from "../src/mcp/search.js";

// A stand-in for kiwi: strips a trailing 을/를, as kiwi strips a particle.
function registerFakeKorean(): void {
  registerLanguage({
    code: "ko",
    detect: (t) => /[가-힣]/.test(t),
    tokenize: (t) => (/[가-힣]/.test(t) ? t.split(/\s+/).map((w) => w.replace(/[을를]$/, "")) : []),
  });
}

function openSeeded(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  db.exec(`
    INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
    INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
    INSERT INTO event (uuid, session_id, ts, role) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', 'user');
    INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', '리팩토링 완료했습니다');
    INSERT INTO user_text_fts_lang_ko (rowid, text, session_id, ts)
      VALUES ((SELECT rowid FROM user_text WHERE event_uuid = 'e1'), '리팩토링 완료', 's1', '2026-06-01T10:00:00Z');
  `);
  return db;
}

/** Leaves a socket file at `path` whose listener is gone, as a watcher
 *  killed without closing its server does. */
function leaveStaleSocket(path: string): void {
  spawnSync(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`,
  ]);
}

describe("mcp/analyzers.ts — one process holds the language analyzers", () => {
  let dir: string;
  let sock: string;

  beforeEach(() => {
    // A short path: a Unix socket's path is limited to about 100 bytes.
    dir = mkdtempSync(join(tmpdir(), "clens-an-"));
    sock = join(dir, "a.sock");
  });

  afterEach(async () => {
    await closeAnalyzerServer();
    resetLanguageRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a server without analyzers finds with the watcher's tokens what the watcher finds itself", async () => {
    registerFakeKorean();
    await serveAnalyzers(sock);
    const db = openSeeded();
    const query = "리팩토링을";
    const local = searchUserText(db, { query });
    expect(local.map((r) => r.snippet)).toEqual(["리팩토링 완료했습니다"]);

    const languages = await remoteAnalyzers(queryTerms(query), sock);
    resetLanguageRegistry(); // this process now has no analyzer of its own
    expect(languages.map((a) => a.code)).toEqual(["ko"]);
    expect(searchUserText(db, { query }, { languages })).toEqual(local);
    // Only the morpheme layer finds the particle-attached word.
    expect(searchUserText(db, { query }, { languages: [] })).toEqual([]);
  });

  it("a term no analyzer detects gets no tokens from the watcher", async () => {
    registerFakeKorean();
    await serveAnalyzers(sock);
    const [ko] = await remoteAnalyzers(["refactor", "리팩토링을"], sock);
    expect(ko!.detect("refactor")).toBe(false);
    expect(ko!.tokenize("refactor")).toEqual([]);
    expect(ko!.detect("리팩토링을")).toBe(true);
    expect(ko!.tokenize("리팩토링을")).toEqual(["리팩토링"]);
  });

  it("a process with its own analyzers uses them and asks nobody", async () => {
    registerFakeKorean();
    // No socket at `sock`: asking would come back empty, not undefined.
    expect(await searchAnalyzers(["리팩토링을"], sock)).toBeUndefined();
  });

  it("without a watcher the search goes on without the morpheme layers", async () => {
    const t0 = Date.now();
    expect(await remoteAnalyzers(["리팩토링을"], sock)).toEqual([]);
    leaveStaleSocket(sock);
    expect(existsSync(sock)).toBe(true);
    expect(await remoteAnalyzers(["리팩토링을"], sock)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("a watcher that does not answer in time is given up on", async () => {
    // Reads the request, so it sees the client hang up, and never answers.
    const silent: Server = createServer((s) => s.resume());
    await new Promise<void>((resolve) => silent.listen(sock, resolve));
    try {
      const t0 = Date.now();
      expect(await remoteAnalyzers(["리팩토링을"], sock, 200)).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it("a new watcher takes over the socket file a killed one left", async () => {
    leaveStaleSocket(sock);
    registerFakeKorean();
    await serveAnalyzers(sock);
    const [ko] = await remoteAnalyzers(["리팩토링을"], sock);
    expect(ko!.tokenize("리팩토링을")).toEqual(["리팩토링"]);
  });

  it("a process that becomes the watcher again serves again", async () => {
    registerFakeKorean();
    await serveAnalyzers(sock);
    await serveAnalyzers(sock);
    const [ko] = await remoteAnalyzers(["리팩토링을"], sock);
    expect(ko!.tokenize("리팩토링을")).toEqual(["리팩토링"]);
  });

  it("a malformed request closes its connection and the watcher keeps answering", async () => {
    registerFakeKorean();
    await serveAnalyzers(sock);
    const reply = await new Promise<string>((resolve) => {
      let got = "";
      const c = connect(sock, () => c.write("not json\n"));
      c.on("data", (d) => (got += d));
      c.on("close", () => resolve(got));
      c.on("error", () => resolve(got));
    });
    expect(reply).toBe("");
    const [ko] = await remoteAnalyzers(["리팩토링을"], sock);
    expect(ko!.tokenize("리팩토링을")).toEqual(["리팩토링"]);
  });
});
