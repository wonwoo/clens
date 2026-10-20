#!/usr/bin/env node
/**
 * clens CLI dispatcher.
 *
 * Hand-rolled flag parser (no deps; small surface) keeps the bin lean.
 * Each subcommand lives in src/commands/<name>_cmd.ts.
 */
import { indexCommand } from "./commands/index_cmd.js";
import { installCommand } from "./commands/install_cmd.js";
import { mcpCommand } from "./commands/mcp_cmd.js";
import { statsCommand } from "./commands/stats_cmd.js";
function parse(argv) {
    const cmd = argv[0] ?? "";
    const flags = new Map();
    const positional = [];
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            if (eq > 0) {
                flags.set(a.slice(2, eq), a.slice(eq + 1));
            }
            else {
                const next = argv[i + 1];
                if (next !== undefined && !next.startsWith("--")) {
                    flags.set(a.slice(2), next);
                    i += 1;
                }
                else {
                    flags.set(a.slice(2), true);
                }
            }
        }
        else {
            positional.push(a);
        }
    }
    return { cmd, flags, positional };
}
function usage() {
    process.stderr.write(`clens — Claude Code session analyzer\n` +
        `\n` +
        `usage:\n` +
        `  clens index [--rebuild] [--lock-timeout <ms>]\n` +
        `  clens install <lang>   (ko, ja, zh)\n` +
        `  clens stats [--digest]\n` +
        `  clens mcp\n`);
}
async function main() {
    const parsed = parse(process.argv.slice(2));
    switch (parsed.cmd) {
        case "":
        case "help":
        case "--help":
        case "-h":
            usage();
            return parsed.cmd === "" ? 2 : 0;
        case "index": {
            return indexCommand({
                rebuild: parsed.flags.get("rebuild") === true,
                lockTimeoutMs: numberFlag(parsed.flags, "lock-timeout", 30_000),
            });
        }
        case "install": {
            const lang = parsed.positional[0];
            if (lang === undefined) {
                process.stderr.write("clens install: missing <lang> (e.g. 'ko')\n");
                usage();
                return 2;
            }
            return installCommand({ lang });
        }
        case "stats": {
            return statsCommand({
                digest: parsed.flags.get("digest") === true,
            });
        }
        case "mcp": {
            return mcpCommand();
        }
        default:
            process.stderr.write(`clens: unknown command '${parsed.cmd}'\n`);
            usage();
            return 2;
    }
}
function numberFlag(flags, name, dflt) {
    const v = flags.get(name);
    if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n))
            return n;
    }
    return dflt;
}
main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`clens: fatal: ${err?.message ?? err}\n`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map