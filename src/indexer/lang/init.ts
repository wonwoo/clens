/**
 * Optional-install wiring: try to load each known language's morphological
 * analyzer and register it. The indexer and the MCP server that becomes the
 * watcher call it; other servers ask the watcher over a local socket
 * (src/mcp/analyzers.ts). If the optional package isn't installed or the
 * model files haven't been downloaded to languageModelDir(code), registration
 * is silently skipped — the writer treats an unregistered language as "not
 * installed". This function must never throw.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { languageModelDir } from "../../util/paths.js";
import { getLanguageAdapter, registerLanguage } from "./registry.js";
import { createKoreanAdapter } from "./ko.js";
import { createJapaneseAdapter, type LinderaTokenizerLike } from "./ja.js";
import { createChineseAdapter } from "./zh.js";

/** Japanese's and Chinese's analyzers: npm packages with the dictionary
 *  built into their WASM. `clens install ja|zh` installs each under the
 *  language's model dir, and only that copy is loaded: Claude Code installs
 *  a plugin's dev dependencies too, so one in the plugin's node_modules says
 *  nothing about whether the user asked for the language. */
export const LINDERA_PACKAGES = {
  ja: { name: "lindera-wasm-nodejs-ipadic", version: "2.0.0", dictionary: "embedded://ipadic" },
  zh: { name: "lindera-wasm-nodejs-cc-cedict", version: "2.0.0", dictionary: "embedded://cc-cedict" },
} as const;

interface LinderaModule {
  TokenizerBuilder: new () => {
    setDictionary(dictionary: string): void;
    setMode(mode: string): void;
    build(): LinderaTokenizerLike;
  };
}

let attempted = false;

function logLoadFailure(code: string, e: unknown): void {
  // Gated behind CLENS_DEV so it stays
  // silent for ordinary users who simply haven't installed this language.
  if (process.env.CLENS_DEV === "1") {
    console.error(`clens: failed to load the ${code} language adapter:`, e);
  }
}

/** Idempotent — safe to call from every entrypoint that indexes (driver.ts's
 *  runIndex() and the MCP server once it becomes the watcher). Only the
 *  first call in a process does any work. */
export async function ensureLanguageAdaptersLoaded(): Promise<void> {
  if (attempted) return;
  attempted = true;
  await tryLoadKorean();
  await tryLoadJapanese();
  await tryLoadChinese();
}

async function tryLoadKorean(): Promise<void> {
  if (getLanguageAdapter("ko")) return;
  const modelDir = languageModelDir("ko");
  if (!existsSync(modelDir)) return;

  try {
    const { KiwiBuilder, Match } = await import("kiwi-nlp");
    // createRequire().resolve() rather than import.meta.resolve() — the
    // latter isn't implemented under Vitest's SSR module runner
    // (lang_ko_real.spec.ts resolves kiwi-nlp the same way). kiwi-nlp has
    // no "exports" map, so resolving its main
    // entry and looking up kiwi-wasm.wasm as a sibling file works
    // regardless of node_modules layout (local, global, monorepo, ...).
    const kiwiEntry = createRequire(import.meta.url).resolve("kiwi-nlp");
    const wasmPath = join(dirname(kiwiEntry), "kiwi-wasm.wasm");

    const modelFiles: Record<string, Uint8Array> = {};
    for (const name of readdirSync(modelDir)) {
      modelFiles[name] = new Uint8Array(readFileSync(join(modelDir, name)));
    }

    const builder = await KiwiBuilder.create(wasmPath);
    const kiwi = await builder.build({ modelFiles });

    registerLanguage(
      createKoreanAdapter({
        analyze: (text: string) => kiwi.analyze(text, Match.allWithNormalizing),
      }),
    );
  } catch (e) {
    // Missing optional dependency, corrupt/incomplete model files, or any
    // other load failure — treat exactly like "not installed". Never crash
    // indexing or search over an optional feature. Only reached when
    // modelDir exists (the common "not installed" case returns above
    // without entering this try at all), so this is always an unexpected
    // failure worth a debug trace.
    logLoadFailure("ko", e);
  }
}

/** The tokenizer of the Lindera package installed for `code`, or undefined
 *  when `clens install <code>` has not run. Unlike Korean's, the dictionary
 *  is embedded in the WASM binary (ipadic's .wasm is ~13MB), so the package
 *  is the whole install. */
function installedLinderaTokenizer(code: keyof typeof LINDERA_PACKAGES): LinderaTokenizerLike | undefined {
  const { name, dictionary } = LINDERA_PACKAGES[code];
  const dir = languageModelDir(code);
  if (!existsSync(join(dir, "node_modules", name, "package.json"))) return undefined;
  // createRequire takes only an absolute path; CLENS_INDEX_DIR may be relative.
  const { TokenizerBuilder } = createRequire(resolve(dir, "package.json"))(name) as LinderaModule;
  const builder = new TokenizerBuilder();
  builder.setDictionary(dictionary);
  builder.setMode("normal");
  return builder.build();
}

async function tryLoadJapanese(): Promise<void> {
  if (getLanguageAdapter("ja")) return;
  try {
    const tokenizer = installedLinderaTokenizer("ja");
    if (tokenizer) registerLanguage(createJapaneseAdapter(tokenizer));
  } catch (e) {
    logLoadFailure("ja", e);
  }
}

async function tryLoadChinese(): Promise<void> {
  if (getLanguageAdapter("zh")) return;
  try {
    const tokenizer = installedLinderaTokenizer("zh");
    if (tokenizer) registerLanguage(createChineseAdapter(tokenizer));
  } catch (e) {
    logLoadFailure("zh", e);
  }
}
