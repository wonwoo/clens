/**
 * File watcher for every registered source's sessions dir (see sources.ts) —
 * currently ~/.claude/projects/ and ~/.codex/sessions/.
 *
 * Uses recursive fs.watch (macOS FSEvents / Windows RCWC) per root.
 * Runs an incremental index once on start, then on any JSONL change,
 * debounced 500ms.
 * One index run at a time: a change that arrives during a run starts one more
 * run after it, since a second run would only wait for the first one's lock
 * and give up after 30 s. A run that failed is logged, and run again when it
 * failed because another writer held the lock; any other failure waits for
 * the next change.
 * After each successful index it calls onIndexed, where the caller (the MCP
 * server) replaces its DB handle to get a fresh view.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { runIndex } from "./driver.js";
import { SOURCE_ADAPTERS } from "./sources.js";

export interface WatchHandle {
  stop(): void;
}

/**
 * Start watching ~/.claude/projects/ and ~/.codex/sessions/ for JSONL changes.
 *
 * @param onIndexed  called after each successful incremental index
 * @param debounceMs debounce window in ms (default 500)
 * @param retryMs    how often to look again for a sessions dir that does not
 *                   exist yet (default 30 s)
 */
export function startWatch(
  onIndexed: () => void | Promise<void>,
  debounceMs = 500,
  retryMs = 30_000,
): WatchHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];
  const retries: ReturnType<typeof setInterval>[] = [];
  let running = false;
  let again = false;
  let stopped = false;
  // A busy lock fails every attempt until it is free; log its message once.
  let lastError: string | undefined;

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, debounceMs);
  }

  async function run(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await runIndex({ rebuild: false });
      lastError = undefined;
      try {
        await onIndexed();
      } catch {
        // The caller's refresh failing does not undo the index run.
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastError) {
        console.error(`clens watch: indexing failed: ${message}`);
        lastError = message;
      }
      // Exit code 4: another writer held the lock for the whole wait
      // (driver.ts acquireLock). The change is still unindexed and may get no
      // further event, so run again.
      if ((err as { exitCode?: unknown } | null | undefined)?.exitCode === 4) again = true;
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        schedule();
      }
    }
  }

  function watchRoot(root: string): boolean {
    try {
      const watcher = watch(root, { recursive: true }, (_, filename) => {
        if (typeof filename === "string" && filename.endsWith(".jsonl")) {
          schedule();
        }
      });
      watcher.on("error", (err) => {
        // fs.watch died (e.g. platform watch-limit hit) — live indexing for
        // this root stops until the process restarts. Log so it's visible
        // instead of silently going stale.
        console.error(`clens watch: fs.watch on ${root} failed, live indexing stopped for this root:`, err);
        watcher.close();
      });
      watchers.push(watcher);
      return true;
    } catch {
      // root doesn't exist yet or platform doesn't support recursive watch
      return false;
    }
  }

  for (const root of SOURCE_ADAPTERS.map((a) => a.sessionsDir())) {
    if (watchRoot(root) || existsSync(root)) continue;
    // A tool not used on this machine yet has no sessions dir. Watch it once
    // it appears, and index what it holds by then, which made no event.
    const retry = setInterval(() => {
      if (!watchRoot(root)) return;
      clearInterval(retry);
      schedule();
    }, retryMs);
    retry.unref();
    retries.push(retry);
  }

  // Index once now. Transcripts written while no watcher ran made no event,
  // and after an update that raised SCHEMA_VERSION the rebuild starts only
  // when runIndex runs; without this both waited for some session to write.
  schedule();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const r of retries) clearInterval(r);
      retries.length = 0;
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // already closed
        }
      }
      watchers.length = 0;
    },
  };
}
