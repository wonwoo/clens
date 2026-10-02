/**
 * Optional-install wiring: at process startup, try to load each known
 * language's morphological analyzer and register it. If the optional
 * package isn't installed or the model files haven't been downloaded to
 * languageModelDir(code), registration is silently skipped — every caller
 * downstream (schema/writer/search) already treats an unregistered language
 * as "not installed" and falls back to today's porter+trigram-only behavior.
 * This function must never throw.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { languageModelDir } from "../../util/paths.js";
import { getLanguageAdapter, registerLanguage } from "./registry.js";
import { createKoreanAdapter } from "./ko.js";
import { createJapaneseAdapter } from "./ja.js";
import { createChineseAdapter } from "./zh.js";
let attempted = false;
function logLoadFailure(code, e) {
    // Gated behind CLENS_DEV so it stays
    // silent for ordinary users who simply haven't installed this language.
    if (process.env.CLENS_DEV === "1") {
        console.error(`clens: failed to load the ${code} language adapter:`, e);
    }
}
/** Idempotent — safe to call from every entrypoint that indexes or searches
 *  (driver.ts's runIndex() and the MCP server's startup). Only the first
 *  call in a process does any work. */
export async function ensureLanguageAdaptersLoaded() {
    if (attempted)
        return;
    attempted = true;
    await tryLoadKorean();
    await tryLoadJapanese();
    await tryLoadChinese();
}
async function tryLoadKorean() {
    if (getLanguageAdapter("ko"))
        return;
    const modelDir = languageModelDir("ko");
    if (!existsSync(modelDir))
        return;
    try {
        const { KiwiBuilder, Match } = await import("kiwi-nlp");
        // createRequire().resolve() rather than import.meta.resolve() — the
        // latter isn't implemented under Vitest's SSR module runner, and this
        // path is exercised by tests (see lang_ko_real.spec.ts) as well as
        // production. kiwi-nlp has no "exports" map, so resolving its main
        // entry and looking up kiwi-wasm.wasm as a sibling file works
        // regardless of node_modules layout (local, global, monorepo, ...).
        const kiwiEntry = createRequire(import.meta.url).resolve("kiwi-nlp");
        const wasmPath = join(dirname(kiwiEntry), "kiwi-wasm.wasm");
        const modelFiles = {};
        for (const name of readdirSync(modelDir)) {
            modelFiles[name] = new Uint8Array(readFileSync(join(modelDir, name)));
        }
        const builder = await KiwiBuilder.create(wasmPath);
        const kiwi = await builder.build({ modelFiles });
        registerLanguage(createKoreanAdapter({
            analyze: (text) => kiwi.analyze(text, Match.allWithNormalizing),
        }));
    }
    catch (e) {
        // Missing optional dependency, corrupt/incomplete model files, or any
        // other load failure — treat exactly like "not installed". Never crash
        // indexing or search over an optional feature. Only reached when
        // modelDir exists (the common "not installed" case returns above
        // without entering this try at all), so this is always an unexpected
        // failure worth a debug trace.
        logLoadFailure("ko", e);
    }
}
/** Unlike Korean, ipadic's dictionary is embedded directly in the WASM
 *  binary (lindera-wasm-nodejs-ipadic ships a ~13MB .wasm with the
 *  dictionary baked in — verified directly, not assumed) — there is no
 *  separate model directory to check for, so the only "not installed" case
 *  is the optional package itself being absent, caught below. */
async function tryLoadJapanese() {
    if (getLanguageAdapter("ja"))
        return;
    try {
        const { TokenizerBuilder } = await import("lindera-wasm-nodejs-ipadic");
        const builder = new TokenizerBuilder();
        builder.setDictionary("embedded://ipadic");
        builder.setMode("normal");
        registerLanguage(createJapaneseAdapter(builder.build()));
    }
    catch (e) {
        logLoadFailure("ja", e);
    }
}
/** Same embedded-dictionary shape as Japanese — see tryLoadJapanese(). */
async function tryLoadChinese() {
    if (getLanguageAdapter("zh"))
        return;
    try {
        const { TokenizerBuilder } = await import("lindera-wasm-nodejs-cc-cedict");
        const builder = new TokenizerBuilder();
        builder.setDictionary("embedded://cc-cedict");
        builder.setMode("normal");
        registerLanguage(createChineseAdapter(builder.build()));
    }
    catch (e) {
        logLoadFailure("zh", e);
    }
}
//# sourceMappingURL=init.js.map