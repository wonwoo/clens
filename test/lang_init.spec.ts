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
 * Only ja/zh are asserted as successfully registered: both lindera-wasm
 * packages are regular dependencies with embedded dictionaries, so they
 * succeed on any machine where `npm install` succeeded. Korean depends on
 * a model directory manually downloaded to ~/.clens/models/ko/ on this
 * developer's machine (see lang/init.ts's tryLoadKorean) that does not
 * exist on a fresh checkout/CI — so ko's outcome is intentionally not
 * asserted either way here (see lang_ko_real.spec.ts's skipIf for that gap).
 */
import { describe, expect, it } from "vitest";
import { ensureLanguageAdaptersLoaded } from "../src/indexer/lang/init.js";
import { getLanguageAdapter } from "../src/indexer/lang/registry.js";

describe("indexer/lang/init.ts — ensureLanguageAdaptersLoaded()", () => {
  it("registers working ja and zh adapters through the real production entrypoint", async () => {
    await ensureLanguageAdaptersLoaded();

    const ja = getLanguageAdapter("ja");
    const zh = getLanguageAdapter("zh");
    expect(ja).toBeDefined();
    expect(zh).toBeDefined();

    // Not just "truthy" — prove the registered adapter actually tokenizes,
    // the same failure mode (dead registration, adapter never really wired)
    // that sank the prior Korean attempt.
    expect(ja!.tokenize("東京都に行く")).toEqual(["東京", "都", "行く"]);
    expect(zh!.tokenize("我今天去了北京")).toEqual(["我", "今天", "去", "了", "北京"]);
  });

  it("is idempotent — a second call does not throw or replace the registered adapters", async () => {
    await ensureLanguageAdaptersLoaded();
    const jaBefore = getLanguageAdapter("ja");
    await ensureLanguageAdaptersLoaded();
    expect(getLanguageAdapter("ja")).toBe(jaBefore);
  });
});
