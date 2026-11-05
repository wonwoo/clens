import { describe, expect, it } from "vitest";
import { createJapaneseAdapter, hasKana } from "../src/indexer/lang/ja.js";
import { createChineseAdapter, hasHan } from "../src/indexer/lang/zh.js";

describe("indexer/lang/ja.ts — hasKana (raw script check, not the adapter's detect())", () => {
  it("detects Hiragana/Katakana", () => {
    expect(hasKana("東京都に行く")).toBe(true); // has に (hiragana)
    expect(hasKana("テスト")).toBe(true); // katakana only
  });

  it("returns false for pure Kanji/English text with no kana — this is unchanged; the ADAPTER's detect() is broader, see below", () => {
    expect(hasKana("refactor this function")).toBe(false);
    expect(hasKana("東京")).toBe(false);
  });
});

describe("indexer/lang/zh.ts — hasHan", () => {
  it("detects CJK ideographs when no kana is present", () => {
    expect(hasHan("我今天去了北京")).toBe(true);
  });

  it("returns false when kana is present, even alongside Han characters (avoids double-classifying Japanese text as Chinese)", () => {
    expect(hasHan("東京都に行く")).toBe(false);
  });

  it("returns false for text with no Han characters", () => {
    expect(hasHan("refactor this function")).toBe(false);
  });
});

describe("indexer/lang/ja.ts & zh.ts — ambiguous Han-only text is tried by BOTH adapters", () => {
  // Measured against a real Japanese Wikipedia article: only ~0.2% of full
  // prose sentences are Han-only (no kana), but short noun-phrase-shaped
  // messages are meaningfully more exposed (~6.5% in the same measurement).
  // Previously ambiguous text went to zh ONLY, where real testing found it
  // actively mis-segments real Japanese words. Now both try it.
  const noopTokenizer = { tokenize: () => [] };

  it("a pure-Kanji (no kana) string is detected by the Japanese adapter too, not just Chinese", () => {
    const ja = createJapaneseAdapter(noopTokenizer);
    expect(ja.detect("選挙結果発表")).toBe(true);
  });

  it("the same pure-Kanji string is still detected by the Chinese adapter (both, not either/or)", () => {
    const zh = createChineseAdapter(noopTokenizer);
    expect(zh.detect("選挙結果発表")).toBe(true);
  });

  it("genuine kana-containing Japanese text is unaffected — still ja-only, not zh", () => {
    const ja = createJapaneseAdapter(noopTokenizer);
    const zh = createChineseAdapter(noopTokenizer);
    expect(ja.detect("東京都に行く")).toBe(true);
    expect(zh.detect("東京都に行く")).toBe(false);
  });

  it("genuine Chinese text (no kana) is still zh-detected, and now also ja-detected (the accepted symmetric cost)", () => {
    const ja = createJapaneseAdapter(noopTokenizer);
    const zh = createChineseAdapter(noopTokenizer);
    expect(zh.detect("我今天去了北京")).toBe(true);
    expect(ja.detect("我今天去了北京")).toBe(true);
  });
});

describe("indexer/lang/ja.ts — createJapaneseAdapter content-word extraction", () => {
  // Fake Lindera tokenizer mirroring real ipadic output (surface/partOfSpeech
  // shape verified directly against the real WASM package, not assumed) —
  // see lang_ja_zh_real.spec.ts for the real-analyzer proof.
  const fakeTokenizer = {
    tokenize: (text: string) => {
      if (text === "東京都に行く") {
        return [
          { surface: "東京", partOfSpeech: "名詞" },
          { surface: "都", partOfSpeech: "名詞" },
          { surface: "に", partOfSpeech: "助詞" },
          { surface: "行く", partOfSpeech: "動詞" },
        ];
      }
      if (text === "形態素解析のテストです") {
        return [
          { surface: "形態素", partOfSpeech: "名詞" },
          { surface: "解析", partOfSpeech: "名詞" },
          { surface: "の", partOfSpeech: "助詞" },
          { surface: "テスト", partOfSpeech: "名詞" },
          { surface: "です", partOfSpeech: "助動詞" },
        ];
      }
      return [];
    },
  };

  it("strips 助詞 (particle) tags, keeping content words", () => {
    const adapter = createJapaneseAdapter(fakeTokenizer);
    expect(adapter.tokenize("東京都に行く")).toEqual(["東京", "都", "行く"]);
  });

  it("strips 助動詞 (auxiliary verb) tags too", () => {
    const adapter = createJapaneseAdapter(fakeTokenizer);
    expect(adapter.tokenize("形態素解析のテストです")).toEqual(["形態素", "解析", "テスト"]);
  });

  it("keeps each word's base form, so a conjugated verb matches its dictionary form", () => {
    const adapter = createJapaneseAdapter({
      tokenize: () => [
        { surface: "制限", partOfSpeech: "名詞", baseForm: "制限" },
        { surface: "し", partOfSpeech: "動詞", baseForm: "する" },
        { surface: "まし", partOfSpeech: "助動詞", baseForm: "ます" },
        { surface: "た", partOfSpeech: "助動詞", baseForm: "た" },
      ],
    });
    expect(adapter.tokenize("制限しました")).toEqual(["制限", "する"]);
  });

  it("keeps the surface form of a word with no base form (missing or ipadic's \"*\")", () => {
    const adapter = createJapaneseAdapter({
      tokenize: () => [
        { surface: "テスト", partOfSpeech: "名詞" },
        { surface: "ケース", partOfSpeech: "名詞", baseForm: "*" },
      ],
    });
    expect(adapter.tokenize("テストケース")).toEqual(["テスト", "ケース"]);
  });

  // Since detectJapanese() now also fires for ambiguous Han-only text (see
  // the "ambiguous Han-only text" describe block below), genuine Chinese
  // text can reach this tokenizer too. Real ipadic tags Chinese-only
  // character forms (e.g. simplified-only 语/处/很) as "UNK" — without this
  // exclusion those fragments would get indexed as if they were meaningful
  // Japanese content words.
  it("strips UNK (no dictionary entry) tags — verified real trigger: genuine Chinese text reaching this tokenizer via the ambiguous-detection widening", () => {
    const adapter = createJapaneseAdapter({
      tokenize: (text: string) => {
        if (text === "自然语言处理") {
          return [
            { surface: "自然", partOfSpeech: "名詞" },
            { surface: "语", partOfSpeech: "UNK" },
            { surface: "言", partOfSpeech: "名詞" },
            { surface: "处", partOfSpeech: "UNK" },
            { surface: "理", partOfSpeech: "名詞" },
          ];
        }
        return [];
      },
    });
    expect(adapter.tokenize("自然语言处理")).toEqual(["自然", "言", "理"]);
  });

  it("returns empty array for text with no kana, without calling the analyzer", () => {
    let called = false;
    const adapter = createJapaneseAdapter({
      tokenize: () => {
        called = true;
        return [];
      },
    });
    expect(adapter.tokenize("no kana here")).toEqual([]);
    expect(called).toBe(false);
  });

  it("skips tokenization for text over the length cap, without calling the analyzer", () => {
    let called = false;
    const adapter = createJapaneseAdapter({
      tokenize: () => {
        called = true;
        return [];
      },
    });
    const huge = "あ".repeat(20_001);
    expect(adapter.tokenize(huge)).toEqual([]);
    expect(called).toBe(false);
  });

  it("returns empty array instead of throwing when the analyzer itself fails", () => {
    const adapter = createJapaneseAdapter({
      tokenize: () => {
        throw new Error("simulated WASM RuntimeError: Aborted()");
      },
    });
    expect(() => adapter.tokenize("東京都に行く")).not.toThrow();
    expect(adapter.tokenize("東京都に行く")).toEqual([]);
  });
});

describe("indexer/lang/zh.ts — createChineseAdapter content-word extraction", () => {
  // Fake tokenizer mirroring real cc-cedict output: partOfSpeech is always
  // "*" (cc-cedict carries no real POS tagging — verified directly) except
  // "UNK" for punctuation/unrecognized characters.
  const fakeTokenizer = {
    tokenize: (text: string) => {
      if (text === "我今天去了北京，自然语言处理很有趣") {
        return [
          { surface: "我", partOfSpeech: "*" },
          { surface: "今天", partOfSpeech: "*" },
          { surface: "去", partOfSpeech: "*" },
          { surface: "了", partOfSpeech: "*" },
          { surface: "北京", partOfSpeech: "*" },
          { surface: "，", partOfSpeech: "UNK" },
          { surface: "自然语言处理", partOfSpeech: "*" },
          { surface: "很", partOfSpeech: "*" },
          { surface: "有趣", partOfSpeech: "*" },
        ];
      }
      return [];
    },
  };

  it("drops UNK (punctuation/unrecognized) tokens, keeps everything else since cc-cedict has no particle concept", () => {
    const adapter = createChineseAdapter(fakeTokenizer);
    expect(adapter.tokenize("我今天去了北京，自然语言处理很有趣")).toEqual([
      "我",
      "今天",
      "去",
      "了",
      "北京",
      "自然语言处理",
      "很",
      "有趣",
    ]);
  });

  it("keeps multi-character compound words as single tokens (e.g. 自然语言处理)", () => {
    const adapter = createChineseAdapter(fakeTokenizer);
    expect(adapter.tokenize("我今天去了北京，自然语言处理很有趣")).toContain("自然语言处理");
  });

  it("returns empty array for text with no Han characters, without calling the analyzer", () => {
    let called = false;
    const adapter = createChineseAdapter({
      tokenize: () => {
        called = true;
        return [];
      },
    });
    expect(adapter.tokenize("no han here")).toEqual([]);
    expect(called).toBe(false);
  });

  it("skips tokenization for text over the length cap, without calling the analyzer", () => {
    let called = false;
    const adapter = createChineseAdapter({
      tokenize: () => {
        called = true;
        return [];
      },
    });
    const huge = "我".repeat(20_001);
    expect(adapter.tokenize(huge)).toEqual([]);
    expect(called).toBe(false);
  });

  it("returns empty array instead of throwing when the analyzer itself fails", () => {
    const adapter = createChineseAdapter({
      tokenize: () => {
        throw new Error("simulated WASM RuntimeError: Aborted()");
      },
    });
    expect(() => adapter.tokenize("我今天去了北京")).not.toThrow();
    expect(adapter.tokenize("我今天去了北京")).toEqual([]);
  });
});
