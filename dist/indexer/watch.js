/**
 * File watcher for every registered source's sessions dir (see sources.ts) —
 * currently ~/.claude/projects/ and ~/.codex/sessions/.
 *
 * Uses recursive fs.watch (macOS FSEvents / Windows RCWC) per root.
 * On any JSONL change, debounces 500ms then runs an incremental index.
 * After each successful index it calls onIndexed, where the caller (the MCP
 * server) replaces its DB handle to get a fresh view.
 */
import { existsSync, watch } from "node:fs";
import { runIndex } from "./driver.js";
import { SOURCE_ADAPTERS } from "./sources.js";
/**
 * Start watching ~/.claude/projects/ and ~/.codex/sessions/ for JSONL changes.
 *
 * @param onIndexed  called after each successful incremental index
 * @param debounceMs debounce window in ms (default 500)
 * @param retryMs    how often to look again for a sessions dir that does not
 *                   exist yet (default 30 s)
 */
export function startWatch(onIndexed, debounceMs = 500, retryMs = 30_000) {
    let timer;
    const watchers = [];
    const retries = [];
    function schedule() {
        if (timer !== undefined)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            runIndex({ rebuild: false })
                .then(() => onIndexed())
                .catch(() => {
                // Index failure is non-fatal; next change will retry
            });
        }, debounceMs);
    }
    function watchRoot(root) {
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
        }
        catch {
            // root doesn't exist yet or platform doesn't support recursive watch
            return false;
        }
    }
    for (const root of SOURCE_ADAPTERS.map((a) => a.sessionsDir())) {
        if (watchRoot(root) || existsSync(root))
            continue;
        // A tool not used on this machine yet has no sessions dir. Watch it once
        // it appears, and index what it holds by then, which made no event.
        const retry = setInterval(() => {
            if (!watchRoot(root))
                return;
            clearInterval(retry);
            schedule();
        }, retryMs);
        retry.unref();
        retries.push(retry);
    }
    return {
        stop() {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            for (const r of retries)
                clearInterval(r);
            retries.length = 0;
            for (const w of watchers) {
                try {
                    w.close();
                }
                catch {
                    // already closed
                }
            }
            watchers.length = 0;
        },
    };
}
//# sourceMappingURL=watch.js.map