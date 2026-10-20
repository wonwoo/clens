/**
 * Verifies ensureLanguageAdaptersLoaded() itself — the actual production
 * registration wiring — not just the adapter factories in isolation. A
 * prior attempt at Korean support (deleted branch) was rejected in review
 * specifically because nothing ever exercised the real registration path:
 * every test injected a fake tokenizer directly into createKoreanAdapter(),
 * so a completely dead call site (setKoreanTokenizer() never invoked
 * anywhere in production) went unnoticed. This file closes that gap for
 * the actual init.ts entrypoint every production process calls.
 *
 * Japanese and Chinese load only from what `clens install ja|zh` put under
 * the model dir, so each case points CLENS_INDEX_DIR at a temporary folder.
 * The installed case needs the real packages, kept like Korean's model in a
 * fixture folder that is not committed (test/fixtures/lindera/<code>, made
 * with `npm install --prefix test/fixtures/lindera/<code> <name>@<version>`,
 * the name and version in LINDERA_PACKAGES), and is skipped where it is
 * missing. Korean's outcome is not asserted here (see
 * lang_ko_real.spec.ts).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINDERA_PACKAGES } from "../src/indexer/lang/init.js";

const FIXTURE = join(process.cwd(), "test/fixtures/lindera");
const installed = (code: "ja" | "zh") =>
  existsSync(join(FIXTURE, code, "node_modules", LINDERA_PACKAGES[code].name, "package.json"));
const hasFixture = installed("ja") && installed("zh");

const savedIndexDir = process.env.CLENS_INDEX_DIR;
const dirs: string[] = [];

/** A fresh init.ts and registry (init.ts loads once per module instance),
 *  run against an index dir whose models/ holds the given installs. */
async function loadWith(installed: ("ja" | "zh")[], indexDir: (dir: string) => string = (dir) => dir) {
  const dir = mkdtempSync(join(tmpdir(), "clens-lang-init-"));
  dirs.push(dir);
  mkdirSync(join(dir, "models"));
  for (const code of installed) symlinkSync(join(FIXTURE, code), join(dir, "models", code));
  process.env.CLENS_INDEX_DIR = indexDir(dir);
  vi.resetModules();
  const init = await import("../src/indexer/lang/init.js");
  const registry = await import("../src/indexer/lang/registry.js");
  await init.ensureLanguageAdaptersLoaded();
  return { init, registry };
}

afterEach(() => {
  if (savedIndexDir === undefined) delete process.env.CLENS_INDEX_DIR;
  else process.env.CLENS_INDEX_DIR = savedIndexDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("indexer/lang/init.ts — ensureLanguageAdaptersLoaded()", () => {
  it("registers no ja or zh adapter when neither is installed", async () => {
    const { registry } = await loadWith([]);
    expect(registry.getLanguageAdapter("ja")).toBeUndefined();
    expect(registry.getLanguageAdapter("zh")).toBeUndefined();
  });

  it.skipIf(!hasFixture)("registers working ja and zh adapters from what is installed", async () => {
    const { registry } = await loadWith(["ja", "zh"]);
    // Not just "truthy" — prove the registered adapter actually tokenizes,
    // the same failure mode (dead registration, adapter never really wired)
    // that sank the prior Korean attempt.
    expect(registry.getLanguageAdapter("ja")!.tokenize("東京都に行く")).toEqual(["東京", "都", "行く"]);
    expect(registry.getLanguageAdapter("zh")!.tokenize("我今天去了北京")).toEqual(["我", "今天", "去", "了", "北京"]);
  });

  it.skipIf(!hasFixture)("registers only the language that is installed", async () => {
    const { registry } = await loadWith(["ja"]);
    expect(registry.getLanguageAdapter("ja")).toBeDefined();
    expect(registry.getLanguageAdapter("zh")).toBeUndefined();
  });

  it.skipIf(!hasFixture)("loads an install under a relative CLENS_INDEX_DIR", async () => {
    const { registry } = await loadWith(["ja"], (dir) => relative(process.cwd(), dir));
    expect(registry.getLanguageAdapter("ja")).toBeDefined();
  });

  it.skipIf(!hasFixture)("is idempotent — a second call does not throw or replace the registered adapters", async () => {
    const { init, registry } = await loadWith(["ja"]);
    const jaBefore = registry.getLanguageAdapter("ja");
    await init.ensureLanguageAdaptersLoaded();
    expect(registry.getLanguageAdapter("ja")).toBe(jaBefore);
  });
});
