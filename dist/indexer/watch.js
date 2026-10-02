/**
 * File watcher for every registered source's sessions dir (see sources.ts) —
 * currently ~/.claude/projects/ and ~/.codex/sessions/.
 *
 * Uses recursive fs.watch (macOS FSEvents / Windows RCWC) per root.
 * On any JSONL change, debounces 500ms then runs an incremental index.
 * The DB handle is replaced after each successful index so callers
 * always get a fresh view via the getDb() accessor passed in.
 */
import { watch } from "node:fs";
import { runIndex } from "./driver.js";
import { SOURCE_ADAPTERS } from "./sources.js";
/**
 * Start watching ~/.claude/projects/ and ~/.codex/sessions/ for JSONL changes.
 *
 * @param onIndexed  called after each successful incremental index
 * @param debounceMs debounce window in ms (default 500)
 */
export function startWatch(onIndexed, debounceMs = 500) {
    let timer;
    const watchers = [];
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
    for (const root of SOURCE_ADAPTERS.map((a) => a.sessionsDir())) {
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
        }
        catch {
            // root doesn't exist yet or platform doesn't support recursive watch
        }
    }
    return {
        stop() {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
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