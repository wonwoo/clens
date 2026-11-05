import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runIndex } from "../src/indexer/driver.js";

// Every change to a live transcript makes the indexer delete and re-insert all
// of its session's rows, and FTS5 keeps the deleted rows' entries until a merge
// reaches them. The driver optimizes the search tables at most once an hour.

let root: string;
let proj: string;
let clens: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clens-fts-optimize-"));
  proj = join(root, ".claude", "projects", "-w-app");
  clens = join(root, ".clens");
  mkdirSync(proj, { recursive: true });
  mkdirSync(clens, { recursive: true });
  process.env.CLENS_HOME = join(root, ".claude");
  process.env.CLENS_INDEX_DIR = clens;
  lineNo = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.CLENS_HOME;
  delete process.env.CLENS_INDEX_DIR;
});

const SESSION = "aaaaaaaa-0000-0000-0000-000000000001";
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-09-30T00:00:00Z");

let lineNo = 0;
function line(): string {
  lineNo += 1;
  const n = lineNo;
  return (
    JSON.stringify({
      uuid: `u${n}`,
      sessionId: SESSION,
      type: n % 2 ? "user" : "assistant",
      timestamp: new Date(Date.parse("2026-09-01T00:00:00Z") + n * 1000).toISOString(),
      cwd: "/w/app",
      message:
        n % 2
          ? { role: "user", content: `question ${n} about the parser, the watcher and the ranking of search results` }
          : { role: "assistant", content: [{ type: "text", text: `answer ${n}: ${"the indexer rewrites the session ".repeat(8)}` }] },
    }) + "\n"
  );
}

let clock = 1_900_000_000;
function write(path: string, lines: number, append: boolean): void {
  const body = Array.from({ length: lines }, line).join("");
  if (append) appendFileSync(path, body);
  else writeFileSync(path, body);
  clock += 10;
  utimesSync(path, clock, clock);
}

function query<T>(sql: string): T {
  const db = new Database(join(clens, "index.db"), { readonly: true });
  const row = db.prepare(sql).get() as T;
  db.close();
  return row;
}
const optimizedAt = () => query<{ value: string } | undefined>("SELECT value FROM maintenance WHERE key = 'fts_optimized_at'")?.value;
const trigramBytes = () => query<{ n: number }>("SELECT sum(length(block)) AS n FROM user_text_fts_trigram_data").n;

describe("indexer — FTS upkeep", () => {
  it("optimizes on the first run that writes, then at most once an hour", async () => {
    const file = join(proj, `${SESSION}.jsonl`);
    write(file, 4, false);
    await runIndex({ now: T0 });
    expect(optimizedAt()).toBe(String(T0));

    write(file, 2, true);
    await runIndex({ now: T0 + 30 * 60 * 1000 });
    expect(optimizedAt()).toBe(String(T0));

    write(file, 2, true);
    await runIndex({ now: T0 + HOUR + 1 });
    expect(optimizedAt()).toBe(String(T0 + HOUR + 1));

    // Nothing to read: nothing written, so no optimize either.
    await runIndex({ now: T0 + 5 * HOUR });
    expect(optimizedAt()).toBe(String(T0 + HOUR + 1));
  });

  it("optimizes after a rebuild without waiting for the hour", async () => {
    const file = join(proj, `${SESSION}.jsonl`);
    write(file, 4, false);
    await runIndex({ now: T0 });
    await runIndex({ now: T0 + 10 * 60 * 1000, rebuild: true });
    expect(optimizedAt()).toBe(String(T0 + 10 * 60 * 1000));
  });

  it("keeps a re-derived session's old entries from piling up in the search tables", async () => {
    const file = join(proj, `${SESSION}.jsonl`);
    write(file, 200, false);
    await runIndex({ now: T0 });
    const fresh = trigramBytes();

    // Twenty changes inside the hour: each re-derives the whole session.
    for (let i = 1; i <= 20; i++) {
      write(file, 1, true);
      await runIndex({ now: T0 + i * 1000 });
    }
    // Measured: 3.3 times the fresh size, and 1.1 times after the optimize.
    expect(trigramBytes()).toBeGreaterThan(fresh * 2);

    write(file, 1, true);
    await runIndex({ now: T0 + HOUR });
    expect(trigramBytes()).toBeLessThan(fresh * 1.2);

    const db = new Database(join(clens, "index.db"));
    for (const t of ["user_text_fts", "user_text_fts_trigram"]) {
      expect(() => db.exec(`INSERT INTO ${t} (${t}) VALUES ('integrity-check')`)).not.toThrow();
    }
    const hits = db.prepare("SELECT count(*) AS n FROM user_text_fts_trigram WHERE user_text_fts_trigram MATCH 'watcher'").get() as { n: number };
    db.close();
    expect(hits.n).toBe(111);
  });

  const freePages = () => query<{ n: number }>("SELECT freelist_count AS n FROM pragma_freelist_count").n;
  const walBytes = () => {
    const wal = join(clens, "index.db-wal");
    return existsSync(wal) ? statSync(wal).size : 0;
  };

  it("VACUUMs after the optimize when the free pages reach the threshold, and empties the WAL", async () => {
    const file = join(proj, `${SESSION}.jsonl`);
    write(file, 400, false);
    await runIndex({ now: T0 });
    // A rebuild deletes and re-inserts every row: it leaves free pages.
    await runIndex({ now: T0 + 1000, rebuild: true, vacuumMinFreeBytes: Number.MAX_SAFE_INTEGER });
    const loose = freePages();
    const looseSize = statSync(join(clens, "index.db")).size;
    expect(loose).toBeGreaterThan(0);

    await runIndex({ now: T0 + 2000, rebuild: true, vacuumMinFreeBytes: 1 });
    expect(freePages()).toBe(0);
    expect(statSync(join(clens, "index.db")).size).toBeLessThan(looseSize);
    expect(walBytes()).toBe(0);
    expect(query<{ n: number }>("SELECT count(*) AS n FROM user_text_fts_trigram WHERE user_text_fts_trigram MATCH 'watcher'").n).toBe(200);
  });

  it("leaves the file as it is while the free pages are under the threshold", async () => {
    const file = join(proj, `${SESSION}.jsonl`);
    write(file, 400, false);
    await runIndex({ now: T0 });
    await runIndex({ now: T0 + 1000, rebuild: true });
    expect(freePages()).toBeGreaterThan(0);
  });

  it("finishes while another connection holds a read open, waiting at most 5 s for the checkpoint", async () => {
    const file = join(proj, `${SESSION}.jsonl`);
    write(file, 400, false);
    await runIndex({ now: T0 });
    const reader = new Database(join(clens, "index.db"), { readonly: true });
    const rows = reader.prepare("SELECT text FROM user_text").iterate();
    rows.next();
    const t = Date.now();
    await runIndex({ now: T0 + 1000, rebuild: true, vacuumMinFreeBytes: 1 });
    const elapsed = Date.now() - t;
    rows.return?.();
    reader.close();
    expect(elapsed).toBeLessThan(10_000);
    expect(query<{ n: number }>("SELECT count(*) AS n FROM session").n).toBe(1);
  }, 20_000);
});
