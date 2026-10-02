import { afterEach, describe, expect, it } from "vitest";
import {
  getLanguageAdapter,
  languageFtsTable,
  listKnownLanguageCodes,
  registerLanguage,
  resetLanguageRegistry,
} from "../src/indexer/lang/registry.js";
import { createKoreanAdapter, hasHangul } from "../src/indexer/lang/ko.js";
import type { LanguageAdapter } from "../src/indexer/lang/types.js";

afterEach(() => {
  resetLanguageRegistry();
});

describe("indexer/lang/registry.ts", () => {
  it("knows about ko, ja, and zh", () => {
    expect(listKnownLanguageCodes()).toEqual(["ko", "ja", "zh"]);
  });

  it("derives the FTS5 table name from the code", () => {
    expect(languageFtsTable("ko")).toBe("user_text_fts_lang_ko");
    expect(languageFtsTable("ja")).toBe("user_text_fts_lang_ja");
  });

  it("getLanguageAdapter returns undefined before registration", () => {
    expect(getLanguageAdapter("ko")).toBeUndefined();
  });

  it("registerLanguage makes the adapter retrievable by its code", () => {
    const fake: LanguageAdapter = {
      code: "ko",
      detect: () => true,
      tokenize: () => ["x"],
    };
    registerLanguage(fake);
    expect(getLanguageAdapter("ko")).toBe(fake);
  });

  it("resetLanguageRegistry clears registrations (test isolation)", () => {
    registerLanguage({ code: "ko", detect: () => true, tokenize: () => [] });
    resetLanguageRegistry();
    expect(getLanguageAdapter("ko")).toBeUndefined();
  });
});

describe("indexer/lang/ko.ts — hasHangul", () => {
  it("detects Hangul syllables", () => {
    expect(hasHangul("리팩토링")).toBe(true);
  });

  it("returns false for pure English/code text", () => {
    expect(hasHangul("refactor this function")).toBe(false);
  });

  it("returns true for mixed Korean+English text", () => {
    expect(hasHangul("코드 refactor 해줘")).toBe(true);
  });
});

describe("indexer/lang/ko.ts — createKoreanAdapter content-word extraction", () => {
  // Fake Kiwi that mirrors the real tagset shape (J*=particle, E*=ending,
  // S*=symbol) without needing the real 84MB model — see lang_ko_real.spec.ts
  // for the one test that proves the real analyzer behaves the same way.
  const fakeKiwi = {
    analyze: (text: string) => {
      if (text === "리팩토링을") {
        return { tokens: [{ str: "리팩토링", tag: "NNP" }, { str: "을", tag: "JKO" }] };
      }
      if (text === "리팩토링") {
        return { tokens: [{ str: "리팩토링", tag: "NNP" }] };
      }
      return { tokens: [] };
    },
  };

  it("strips particle/ending/symbol tags, keeping content words", () => {
    const adapter = createKoreanAdapter(fakeKiwi);
    expect(adapter.tokenize("리팩토링을")).toEqual(["리팩토링"]);
  });

  it("particle-attached and bare forms tokenize identically", () => {
    const adapter = createKoreanAdapter(fakeKiwi);
    expect(adapter.tokenize("리팩토링을")).toEqual(adapter.tokenize("리팩토링"));
  });

  it("returns empty array for text with no Hangul, without calling the analyzer", () => {
    let called = false;
    const adapter = createKoreanAdapter({
      analyze: () => {
        called = true;
        return { tokens: [] };
      },
    });
    expect(adapter.tokenize("no hangul here")).toEqual([]);
    expect(called).toBe(false);
  });

  // Regression: a real production message (a multi-megabyte pasted log
  // blob with a few stray Hangul characters) aborted the real kiwi-nlp WASM
  // analyzer entirely (RuntimeError: Aborted()) when fed in whole. Found by
  // running the real analyzer over the full real corpus, not by a unit test
  // — see the incident notes in ko.ts's MAX_TOKENIZE_LENGTH comment.
  it("skips tokenization for text over the length cap, without calling the analyzer", () => {
    let called = false;
    const adapter = createKoreanAdapter({
      analyze: () => {
        called = true;
        return { tokens: [] };
      },
    });
    const huge = "가".repeat(20_001);
    expect(adapter.tokenize(huge)).toEqual([]);
    expect(called).toBe(false);
  });

  it("returns empty array instead of throwing when the analyzer itself fails", () => {
    const adapter = createKoreanAdapter({
      analyze: () => {
        throw new Error("simulated WASM RuntimeError: Aborted()");
      },
    });
    expect(() => adapter.tokenize("리팩토링을")).not.toThrow();
    expect(adapter.tokenize("리팩토링을")).toEqual([]);
  });
});
