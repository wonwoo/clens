import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock runIndex so we don't touch the real DB
vi.mock("../src/indexer/driver.js", () => ({
  runIndex: vi.fn().mockResolvedValue(undefined),
}));

let currentTestDir = "";

// Mock projectsDir to return the current test's unique dir.
// codexSessionsDir points at a non-existent path so the codex watcher is
// silently skipped and these tests observe only the projects watcher.
vi.mock("../src/util/paths.js", () => ({
  projectsDir: () => currentTestDir,
  codexSessionsDir: () => join(tmpdir(), "clens-watch-no-codex-dir"),
}));

import { startWatch } from "../src/indexer/watch.js";
import { runIndex } from "../src/indexer/driver.js";

const mockedRunIndex = runIndex as ReturnType<typeof vi.fn>;

/** How long a test waits for the watcher to react. fs.watch delivery plus the
 *  debounce normally lands within ~150ms, but a fixed 400ms sleep failed
 *  whenever the machine was busy (a parallel suite, background judge calls),
 *  so the positive cases poll for the call instead of guessing a duration. */
const REACT_TIMEOUT = { timeout: 5_000, interval: 20 };

/** Write `file` until the watcher has reacted with one runIndex call.
 *
 *  Waiting longer is not enough on its own: under load, a write made before
 *  the freshly started fs.watch is live produces no event at all, so the test
 *  sat on a call that was never coming. Rewriting only while nothing has been
 *  called, at an interval well above the debounce, lets a lost first event be
 *  replaced without turning one expected index call into two. */
async function writeUntilIndexed(file: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (mockedRunIndex.mock.calls.length === 0) writeFileSync(file, `{"t":${Date.now()}}\n`);
      expect(mockedRunIndex).toHaveBeenCalled();
    },
    { timeout: 5_000, interval: 300 },
  );
}

// `vi.clearAllMocks()` clears recorded calls but NOT a queued
// `mockRejectedValueOnce`. When a test's write went unnoticed, its queued
// rejection survived into the next test and failed that one too — which is
// why "runIndex fails" and "onIndexed throws" always broke together. Reset the
// implementation queue before every test instead.
beforeEach(() => {
  mockedRunIndex.mockReset();
  mockedRunIndex.mockResolvedValue(undefined);
});

function makeTmpDir(): string {
  const dir = join(tmpdir(), `clens-watch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.clearAllMocks();
});

describe("startWatch", () => {
  it("calls onIndexed after a JSONL file is written (debounced)", async () => {
    currentTestDir = makeTmpDir();
    dirs.push(currentTestDir);

    const onIndexed = vi.fn();
    const handle = startWatch(onIndexed, 100);

    await writeUntilIndexed(join(currentTestDir, "test.jsonl"));
    await vi.waitFor(() => expect(onIndexed).toHaveBeenCalledTimes(1), REACT_TIMEOUT);
    handle.stop();

    expect(mockedRunIndex).toHaveBeenCalledWith({ rebuild: false });
    expect(onIndexed).toHaveBeenCalledTimes(1);
  });

  it("debounces 5 rapid writes into exactly 1 index call", async () => {
    currentTestDir = makeTmpDir();
    dirs.push(currentTestDir);

    const onIndexed = vi.fn();
    const handle = startWatch(onIndexed, 200);

    const file = join(currentTestDir, "rapid.jsonl");
    for (let i = 0; i < 5; i++) {
      writeFileSync(file, `{"i":${i}}\n`);
      await new Promise((r) => setTimeout(r, 20));
    }

    await new Promise((r) => setTimeout(r, 600));
    handle.stop();

    expect(mockedRunIndex).toHaveBeenCalledTimes(1);
    expect(onIndexed).toHaveBeenCalledTimes(1);
  });

  it("stop() prevents pending index from firing", async () => {
    currentTestDir = makeTmpDir();
    dirs.push(currentTestDir);

    const onIndexed = vi.fn();
    const handle = startWatch(onIndexed, 200);

    writeFileSync(join(currentTestDir, "stop-test.jsonl"), '{"x":1}\n');
    handle.stop();

    await new Promise((r) => setTimeout(r, 400));
    expect(mockedRunIndex).not.toHaveBeenCalled();
    expect(onIndexed).not.toHaveBeenCalled();
  });

  it("stop() can be called twice without throwing", async () => {
    currentTestDir = makeTmpDir();
    dirs.push(currentTestDir);

    const handle = startWatch(vi.fn(), 100);
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it("ignores non-JSONL file changes", async () => {
    currentTestDir = makeTmpDir();
    dirs.push(currentTestDir);

    await new Promise((r) => setTimeout(r, 50));
    vi.clearAllMocks();

    const onIndexed = vi.fn();
    const handle = startWatch(onIndexed, 100);

    writeFileSync(join(currentTestDir, "notes.txt"), "hello");
    writeFileSync(join(currentTestDir, "config.json"), "{}");

    await new Promise((r) => setTimeout(r, 400));
    handle.stop();

    expect(mockedRunIndex).not.toHaveBeenCalled();
    expect(onIndexed).not.toHaveBeenCalled();
  });

  it("does not call onIndexed when runIndex fails", async () => {
    currentTestDir = makeTmpDir();
    dirs.push(currentTestDir);

    mockedRunIndex.mockRejectedValueOnce(new Error("lock busy"));

    const onIndexed = vi.fn();
    const handle = startWatch(onIndexed, 100);

    await writeUntilIndexed(join(currentTestDir, "fail.jsonl"));
    // onIndexed would fire right after runIndex settles, so give the rejected
    // promise a moment before asserting that it did not.
    await new Promise((r) => setTimeout(r, 100));
    handle.stop();

    expect(mockedRunIndex).toHaveBeenCalledTimes(1);
    expect(onIndexed).not.toHaveBeenCalled();
  });

  it("does not crash when onIndexed throws", async () => {
    currentTestDir = makeTmpDir();
    dirs.push(currentTestDir);

    const onIndexed = vi.fn().mockRejectedValueOnce(new Error("cb error"));
    const handle = startWatch(onIndexed, 100);

    // Should not throw / unhandledRejection
    await writeUntilIndexed(join(currentTestDir, "crash.jsonl"));
    await vi.waitFor(() => expect(onIndexed).toHaveBeenCalledTimes(1), REACT_TIMEOUT);
    handle.stop();

    expect(onIndexed).toHaveBeenCalledTimes(1);
  });

  it("watches a sessions dir made after it started, and indexes what the dir already holds", async () => {
    const parent = makeTmpDir();
    dirs.push(parent);
    currentTestDir = join(parent, "projects");

    const onIndexed = vi.fn();
    const handle = startWatch(onIndexed, 50, 100);
    mkdirSync(currentTestDir);
    // Written before the dir is watched: no event will come for it.
    writeFileSync(join(currentTestDir, "first.jsonl"), '{"x":1}\n');
    await vi.waitFor(() => expect(onIndexed).toHaveBeenCalledTimes(1), REACT_TIMEOUT);

    mockedRunIndex.mockClear();
    await writeUntilIndexed(join(currentTestDir, "second.jsonl"));
    handle.stop();
  });

  it("returns noop handle when projectsDir does not exist", () => {
    currentTestDir = join(tmpdir(), "clens-nonexistent-dir-that-does-not-exist");
    // Do NOT create the dir

    expect(() => {
      const handle = startWatch(vi.fn(), 100);
      handle.stop();
    }).not.toThrow();
  });
});
