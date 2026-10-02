/**
 * `clens stats [--digest]`
 *
 * Reads from the existing index without auto-updating. With `--digest`,
 * emits per-table SHA-256 of canonically PK-sorted rows so callers (gate 2,
 * CI) can compare two index states.
 */
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { digestAllTables } from "../indexer/digest.js";
import { indexDbPath } from "../util/paths.js";
function collectBasic(db) {
    const r = (q) => db.prepare(q).get();
    const ev = r("SELECT COUNT(*) AS c FROM event");
    const ses = r("SELECT COUNT(*) AS c FROM session");
    const proj = r("SELECT COUNT(*) AS c FROM project");
    const files = r("SELECT COUNT(*) AS c FROM file_cursor");
    const ano = r("SELECT COALESCE(SUM(count),0) AS c FROM anomaly");
    return {
        events: ev.c,
        sessions: ses.c,
        projects: proj.c,
        files: files.c,
        anomalies: ano.c,
    };
}
export function statsCommand(flags) {
    if (!existsSync(indexDbPath())) {
        process.stderr.write(`clens stats: no index at ${indexDbPath()}. Run 'clens index' first.\n`);
        return 2;
    }
    const db = new Database(indexDbPath(), { readonly: true });
    try {
        if (flags.digest) {
            const d = digestAllTables(db);
            // JSON to stdout for machine consumers.
            process.stdout.write(JSON.stringify({ tables: d }, null, 2) + "\n");
            return 0;
        }
        const s = collectBasic(db);
        process.stdout.write(JSON.stringify(s, null, 2) + "\n");
        return 0;
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=stats_cmd.js.map