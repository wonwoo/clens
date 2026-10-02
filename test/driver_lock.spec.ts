import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireLock } from "../src/indexer/driver.js";

// Another process takes a lock over once its mtime is older than the stale
// threshold, e.g. while the holder's event loop is busy with a long index run
// or the machine sleeps. The holder finds out on its next refresh.
// proper-lockfile throws from that refresh timer by default, which took the
// whole MCP server down with it.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clens-lock-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireLock — a lock another process took over", () => {
  it("is reported to onLost instead of thrown, and releasing it leaves the new holder's lock alone", async () => {
    const path = join(dir, "index.db.lock");
    let onLost!: (err: Error) => void;
    const lost = new Promise<Error>((resolve) => (onLost = resolve));
    const release = await acquireLock(path, 0, onLost);

    // Another process takes the lock: the lock dir now carries its mtime.
    const later = new Date(Date.now() + 5_000);
    utimesSync(`${path}.lock`, later, later);
    // The holder's next refresh (every stale/2 = 30s) notices.
    vi.advanceTimersByTime(31_000);

    const err = await lost;
    expect((err as Error & { code?: string }).code).toBe("ECOMPROMISED");
    await expect(release()).resolves.toBeUndefined();
    expect(existsSync(`${path}.lock`)).toBe(true);
  });
});
