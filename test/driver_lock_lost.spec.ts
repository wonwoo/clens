import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runIndex must notice, between files, that its index lock was taken over
// and stop writing. The lock is replaced by a stub that reports the loss at
// a chosen point in the event loop, which only a run that yields between
// files ever reaches.
const loss = vi.hoisted(() => ({ afterYields: 0 }));
vi.mock("proper-lockfile", () => ({
  default: {
    lock: async (_path: string, opts: { onCompromised: (err: Error) => void }) => {
      let n = loss.afterYields;
      const fire = (): void => {
        if (n-- > 0) setImmediate(fire);
        else opts.onCompromised(Object.assign(new Error("taken over"), { code: "ECOMPROMISED" }));
      };
      setImmediate(fire);
      return async () => {};
    },
  },
}));

import { runIndex } from "../src/indexer/driver.js";

let root: string;
let clens: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clens-lock-lost-"));
  const proj = join(root, ".claude", "projects", "-w-app");
  clens = join(root, ".clens");
  mkdirSync(proj, { recursive: true });
  mkdirSync(clens, { recursive: true });
  for (let i = 1; i <= 3; i++) {
    const sid = `aaaaaaaa-0000-0000-0000-00000000000${i}`;
    writeFileSync(
      join(proj, `${sid}.jsonl`),
      JSON.stringify({ uuid: `u${i}`, sessionId: sid, type: "user", timestamp: `2026-09-01T00:00:0${i}Z`, cwd: "/w/app", message: { role: "user", content: `question ${i}` } }) + "\n",
    );
  }
  process.env.CLENS_HOME = join(root, ".claude");
  process.env.CLENS_INDEX_DIR = clens;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.CLENS_HOME;
  delete process.env.CLENS_INDEX_DIR;
});

function filesIndexed(): number {
  const db = new Database(join(clens, "index.db"), { readonly: true });
  const n = (db.prepare("SELECT count(*) AS n FROM file_cursor").get() as { n: number }).n;
  db.close();
  return n;
}

describe("runIndex — the index lock is lost mid-run", () => {
  it("stops before the next file and keeps the files already committed", async () => {
    loss.afterYields = 1;
    await expect(runIndex()).rejects.toThrow(/lost the index lock/);
    expect(filesIndexed()).toBe(1);
  });

  it("indexes every file when the lock is kept", async () => {
    loss.afterYields = 1_000;
    await runIndex();
    expect(filesIndexed()).toBe(3);
  });
});
