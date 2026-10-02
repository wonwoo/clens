/**
 * `clens index [--rebuild] [--lock-timeout <ms>]`
 *
 * Builds or updates the local SQLite index. Verbose progress goes to stderr.
 * On success exits 0; on advisory-lock timeout exits 4 per §8 exit codes.
 */
import { runIndex } from "../indexer/driver.js";
import { indexDbPath } from "../util/paths.js";
export async function indexCommand(flags) {
    const t0 = Date.now();
    try {
        const result = await runIndex({
            rebuild: flags.rebuild,
            lockTimeoutMs: flags.lockTimeoutMs,
        });
        process.stderr.write(`clens index: parsed ${result.files_parsed}/${result.files_total} files, ` +
            `${result.events_inserted} events, ${result.parse_errors} parse_errors, ` +
            `${result.elapsed_ms}ms\n  db: ${indexDbPath()}\n`);
        return 0;
    }
    catch (e) {
        const err = e;
        if (err.exitCode) {
            process.stderr.write(`clens index: ${err.message ?? "error"}\n`);
            return err.exitCode;
        }
        process.stderr.write(`clens index: unexpected error after ${Date.now() - t0}ms: ${err.message ?? e}\n`);
        return 1;
    }
}
//# sourceMappingURL=index_cmd.js.map