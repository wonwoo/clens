import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { runIndex } from "../src/indexer/driver.js";
import { digestAllTables } from "../src/indexer/digest.js";

const FIXTURE = join(process.cwd(), "test/fixtures/brainstorm-session.jsonl");
const HOOK_FIXTURE = join(process.cwd(), "test/fixtures/hook-blocks-session.jsonl");

interface FakeEnv {
  tmpRoot: string;
  claude: string;
  clens: string;
  fixturePath: string;
}

function setupFakeHome(): FakeEnv {
  const tmpRoot = mkdtempSync(join(tmpdir(), "clens-digest-"));
  const claude = join(tmpRoot, ".claude");
  const clens = join(tmpRoot, ".clens");
  const projDir = join(claude, "projects", "proj-A");
  mkdirSync(projDir, { recursive: true });
  mkdirSync(clens, { recursive: true });
  const fixturePath = join(projDir, "session-A.jsonl");
  copyFileSync(FIXTURE, fixturePath);
  process.env.CLENS_HOME = claude;
  process.env.CLENS_INDEX_DIR = clens;
  return { tmpRoot, claude, clens, fixturePath };
}

function tearDown(env: FakeEnv): void {
  rmSync(env.tmpRoot, { recursive: true, force: true });
  delete process.env.CLENS_HOME;
  delete process.env.CLENS_INDEX_DIR;
}

function digestFromDb(env: FakeEnv): Map<string, string> {
  const db = new Database(join(env.clens, "index.db"), { readonly: true });
  const out = new Map<string, string>();
  for (const t of digestAllTables(db)) out.set(t.table, t.sha256);
  db.close();
  return out;
}

describe("gate 2 — incremental == rebuild digest", () => {
  let env: FakeEnv;
  beforeEach(() => {
    env = setupFakeHome();
  });
  afterEach(() => tearDown(env));

  it("a clean rebuild and a clean rebuild over the same input have identical digests", async () => {
    await runIndex({ rebuild: true });
    const d1 = digestFromDb(env);
    await runIndex({ rebuild: true });
    const d2 = digestFromDb(env);
    for (const [t, h] of d1) expect(d2.get(t)).toBe(h);
  });

  it("incremental update over an unchanged fixture leaves digests unchanged", async () => {
    await runIndex({ rebuild: true });
    const d1 = digestFromDb(env);
    await runIndex({}); // no rebuild, no file mtime change
    const d2 = digestFromDb(env);
    for (const [t, h] of d1) expect(d2.get(t)).toBe(h);
  });

  it("rebuild after a real append matches incremental after the same append", async () => {
    // Setup two parallel fake homes — A (incremental) and B (rebuild).
    const envB: FakeEnv = (() => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "clens-digest-B-"));
      const claude = join(tmpRoot, ".claude");
      const clens = join(tmpRoot, ".clens");
      mkdirSync(join(claude, "projects", "proj-A"), { recursive: true });
      mkdirSync(clens, { recursive: true });
      copyFileSync(FIXTURE, join(claude, "projects", "proj-A", "session-A.jsonl"));
      return { tmpRoot, claude, clens, fixturePath: join(claude, "projects", "proj-A", "session-A.jsonl") };
    })();

    try {
      // Step 1: initial build for both.
      process.env.CLENS_HOME = env.claude;
      process.env.CLENS_INDEX_DIR = env.clens;
      await runIndex({ rebuild: true });

      process.env.CLENS_HOME = envB.claude;
      process.env.CLENS_INDEX_DIR = envB.clens;
      await runIndex({ rebuild: true });

      // Step 2: append the same extra line to both fixtures.
      const extraEv = {
        uuid: "added-1",
        sessionId: "test",
        parentUuid: null,
        type: "user",
        timestamp: "2026-06-22T00:00:00Z",
        cwd: "/fixture/cwd",
        gitBranch: "main",
        version: "0.0.0",
        userType: "external",
        entrypoint: "cli",
        message: { role: "user", content: "extra appended event" },
      };
      const line = JSON.stringify(extraEv) + "\n";
      const bodyA = readFileSync(env.fixturePath);
      writeFileSync(env.fixturePath, Buffer.concat([bodyA, Buffer.from(line, "utf8")]));
      const bodyB = readFileSync(envB.fixturePath);
      writeFileSync(envB.fixturePath, Buffer.concat([bodyB, Buffer.from(line, "utf8")]));

      // Force mtime ahead so the indexer picks up the change.
      const fs = await import("node:fs");
      const future = (Date.now() + 5000) / 1000;
      fs.utimesSync(env.fixturePath, future, future);
      fs.utimesSync(envB.fixturePath, future, future);

      // Step 3: A goes incremental, B goes rebuild.
      process.env.CLENS_HOME = env.claude;
      process.env.CLENS_INDEX_DIR = env.clens;
      await runIndex({});

      process.env.CLENS_HOME = envB.claude;
      process.env.CLENS_INDEX_DIR = envB.clens;
      await runIndex({ rebuild: true });

      // Step 4: compare digests across the two indexes.
      // Two indexes built over byte-identical inputs but at different
      // absolute paths → file_cursor.path AND event.source_file differ
      // across A/B. Those columns are excluded from cross-env comparison.
      // Tables whose row state is independent of paths must match exactly.
      const dbA = new Database(join(env.clens, "index.db"), { readonly: true });
      const dbB = new Database(join(envB.clens, "index.db"), { readonly: true });
      try {
        const pathColumnExcluded: Record<string, string> = {
          file_cursor: "SELECT mtime, size, lines, last_ok FROM file_cursor ORDER BY path",
          event: "SELECT uuid, session_id, parent_uuid, prompt_id, agent_id, is_sidechain, ts, role, model, in_tok, out_tok, cache_r, cache_w, text_len, has_tool_use, has_text, has_tool_res, user_turn_no, assistant_turn_no FROM event ORDER BY uuid",
          anomaly: "SELECT kind, SUM(count) AS c FROM anomaly GROUP BY kind ORDER BY kind",
        };

        const tablesToCheck = [
          "schema_version",
          "file_cursor",
          "project",
          "session",
          "event",
          "tool_call",
          "file_op",
          "user_text",
          "skill_call",
          "agent_call",
          "slash_command",
          "system_reminder",
          "hook_block",
          "event_unknown_block",
          "anomaly",
        ];

        for (const t of tablesToCheck) {
          const q = pathColumnExcluded[t];
          if (q !== undefined) {
            const ra = dbA.prepare(q).all();
            const rb = dbB.prepare(q).all();
            if (t === "anomaly") {
              // Log mismatch detail before assertion so we can diagnose.
              if (JSON.stringify(ra) !== JSON.stringify(rb)) {
                process.stderr.write(
                  `anomaly diff:\nA=${JSON.stringify(ra)}\nB=${JSON.stringify(rb)}\n`,
                );
              }
            }
            expect(rb, `cross-env row diff on ${t}`).toEqual(ra);
          } else {
            const ra = dbA.prepare(`SELECT * FROM ${t}`).all();
            const rb = dbB.prepare(`SELECT * FROM ${t}`).all();
            expect(rb, `cross-env row diff on ${t}`).toEqual(ra);
          }
        }
      } finally {
        dbA.close();
        dbB.close();
      }
    } finally {
      rmSync(envB.tmpRoot, { recursive: true, force: true });
    }
  });

  it("hook blocks: rebuild after an append matches incremental", async () => {
    // Lines 1-12 hold the PreToolUse block; line 13 is the Stop attachment.
    const hookLines = readFileSync(HOOK_FIXTURE, "utf8").split("\n").filter((l) => l !== "");
    expect(hookLines).toHaveLength(13);
    const homeWith = (label: string): FakeEnv => {
      const tmpRoot = mkdtempSync(join(tmpdir(), `clens-digest-hook-${label}-`));
      const claude = join(tmpRoot, ".claude");
      const clens = join(tmpRoot, ".clens");
      mkdirSync(join(claude, "projects", "proj-H"), { recursive: true });
      mkdirSync(clens, { recursive: true });
      const fixturePath = join(claude, "projects", "proj-H", "hooks-s1.jsonl");
      writeFileSync(fixturePath, hookLines.slice(0, 12).join("\n") + "\n");
      return { tmpRoot, claude, clens, fixturePath };
    };
    const hA = homeWith("A");
    const hB = homeWith("B");
    const use = (e: FakeEnv) => {
      process.env.CLENS_HOME = e.claude;
      process.env.CLENS_INDEX_DIR = e.clens;
    };

    try {
      use(hA);
      await runIndex({ rebuild: true });
      use(hB);
      await runIndex({ rebuild: true });

      const line13 = hookLines[12]! + "\n";
      for (const e of [hA, hB]) writeFileSync(e.fixturePath, readFileSync(e.fixturePath, "utf8") + line13);
      const fs = await import("node:fs");
      const future = (Date.now() + 5000) / 1000;
      fs.utimesSync(hA.fixturePath, future, future);
      fs.utimesSync(hB.fixturePath, future, future);

      use(hA);
      await runIndex({});
      use(hB);
      await runIndex({ rebuild: true });

      const dbA = new Database(join(hA.clens, "index.db"), { readonly: true });
      const dbB = new Database(join(hB.clens, "index.db"), { readonly: true });
      try {
        // Same path-dependent columns left out as in the test above.
        const pathColumnExcluded: Record<string, string> = {
          file_cursor: "SELECT mtime, size, lines, last_ok FROM file_cursor ORDER BY path",
          event: "SELECT uuid, session_id, parent_uuid, prompt_id, agent_id, is_sidechain, ts, role, model, in_tok, out_tok, cache_r, cache_w, text_len, has_tool_use, has_text, has_tool_res, user_turn_no, assistant_turn_no FROM event ORDER BY uuid",
          anomaly: "SELECT kind, SUM(count) AS c FROM anomaly GROUP BY kind ORDER BY kind",
        };
        const tablesToCheck = [
          "schema_version", "file_cursor", "project", "session", "event", "tool_call", "file_op",
          "user_text", "skill_call", "agent_call", "slash_command", "system_reminder", "hook_block",
          "event_unknown_block", "anomaly",
        ];
        for (const t of tablesToCheck) {
          const q = pathColumnExcluded[t] ?? `SELECT * FROM ${t}`;
          expect(dbB.prepare(q).all(), `cross-env row diff on ${t}`).toEqual(dbA.prepare(q).all());
        }
        for (const db of [dbA, dbB]) {
          expect((db.prepare("SELECT COUNT(*) AS n FROM hook_block").get() as { n: number }).n).toBe(2);
        }
      } finally {
        dbA.close();
        dbB.close();
      }
    } finally {
      rmSync(hA.tmpRoot, { recursive: true, force: true });
      rmSync(hB.tmpRoot, { recursive: true, force: true });
    }
  });

  it("shell writes: rebuild after an append matches incremental", async () => {
    const bash = (n: number, command: string, cwd: string) =>
      JSON.stringify({
        uuid: `sw-${n}`,
        sessionId: "shell-s1",
        type: "assistant",
        timestamp: `2026-09-28T10:00:0${n}Z`,
        cwd,
        message: { role: "assistant", content: [{ type: "tool_use", id: `tu-sw-${n}`, name: "Bash", input: { command } }] },
      });
    const first = [
      bash(1, "cat > notes.md <<'EOF'\na > b\nEOF", "/w/app"),
      bash(2, "cd src && sed -i '' 's/a/b/' x.ts y.ts", "/w/app"),
    ];
    const appended = bash(3, "python3 - <<'EOF'\nopen('out.json', 'w').write('{}')\nEOF", "/w/app/docs");
    const homeWith = (label: string): FakeEnv => {
      const tmpRoot = mkdtempSync(join(tmpdir(), `clens-digest-shell-${label}-`));
      const claude = join(tmpRoot, ".claude");
      const clens = join(tmpRoot, ".clens");
      mkdirSync(join(claude, "projects", "proj-S"), { recursive: true });
      mkdirSync(clens, { recursive: true });
      const fixturePath = join(claude, "projects", "proj-S", "shell-s1.jsonl");
      writeFileSync(fixturePath, first.join("\n") + "\n");
      return { tmpRoot, claude, clens, fixturePath };
    };
    const sA = homeWith("A");
    const sB = homeWith("B");
    const use = (e: FakeEnv) => {
      process.env.CLENS_HOME = e.claude;
      process.env.CLENS_INDEX_DIR = e.clens;
    };

    try {
      use(sA);
      await runIndex({ rebuild: true });
      use(sB);
      await runIndex({ rebuild: true });

      for (const e of [sA, sB]) writeFileSync(e.fixturePath, readFileSync(e.fixturePath, "utf8") + appended + "\n");
      const fs = await import("node:fs");
      const future = (Date.now() + 5000) / 1000;
      fs.utimesSync(sA.fixturePath, future, future);
      fs.utimesSync(sB.fixturePath, future, future);

      use(sA);
      await runIndex({});
      use(sB);
      await runIndex({ rebuild: true });

      const dbA = new Database(join(sA.clens, "index.db"), { readonly: true });
      const dbB = new Database(join(sB.clens, "index.db"), { readonly: true });
      try {
        const q = "SELECT event_uuid, session_id, ts, tool, path FROM file_op ORDER BY event_uuid, path";
        expect(dbB.prepare(q).all()).toEqual(dbA.prepare(q).all());
        expect(dbA.prepare(q).all()).toEqual([
          { event_uuid: "sw-1", session_id: "shell-s1", ts: "2026-09-28T10:00:01Z", tool: "Bash", path: "/w/app/notes.md" },
          { event_uuid: "sw-2", session_id: "shell-s1", ts: "2026-09-28T10:00:02Z", tool: "Bash", path: "/w/app/src/x.ts" },
          { event_uuid: "sw-2", session_id: "shell-s1", ts: "2026-09-28T10:00:02Z", tool: "Bash", path: "/w/app/src/y.ts" },
          { event_uuid: "sw-3", session_id: "shell-s1", ts: "2026-09-28T10:00:03Z", tool: "Bash", path: "/w/app/docs/out.json" },
        ]);
      } finally {
        dbA.close();
        dbB.close();
      }
    } finally {
      rmSync(sA.tmpRoot, { recursive: true, force: true });
      rmSync(sB.tmpRoot, { recursive: true, force: true });
    }
  });
});
