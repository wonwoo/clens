/**
 * Real lindera-wasm analyzer tests — proves the adapters work against the
 * actual WASM tokenizer, not just a hand-written fake (same rationale as
 * lang_ko_real.spec.ts). Both dictionaries are embedded directly in the WASM
 * binary (verified: the ipadic .wasm is ~13MB, cc-cedict's ~9.6MB), and the
 * packages are not dependencies: `clens install ja|zh` installs them. Like
 * Korean's model, they are read from a fixture folder that is not committed
 * (test/fixtures/lindera/<code>, made with `npm install --prefix
 * test/fixtures/lindera/<code> <name>@<version>`, the name and version in
 * LINDERA_PACKAGES), and these tests are skipped where it is missing.
 *
 * No real Japanese/Chinese usage data exists in this project's actual
 * corpus (unlike Korean, which was validated against 51,958 real messages).
 * In place of that, the large-input tests below use real Japanese/Chinese
 * Wikipedia text (CC-BY-SA excerpts, short quotes) repeated to size, instead
 * of a single repeated character — closer to the shape of the real
 * oversized-paste-blob production failure than a synthetic string would be.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe as describeAll, expect, it } from "vitest";
import { LINDERA_PACKAGES } from "../src/indexer/lang/init.js";
import { createJapaneseAdapter } from "../src/indexer/lang/ja.js";
import { createChineseAdapter } from "../src/indexer/lang/zh.js";

const FIXTURE = join(process.cwd(), "test/fixtures/lindera");
const installed = (code: "ja" | "zh") =>
  existsSync(join(FIXTURE, code, "node_modules", LINDERA_PACKAGES[code].name, "package.json"));
const describe = describeAll.skipIf(!installed("ja") || !installed("zh"));

function buildTokenizer(code: "ja" | "zh") {
  const { name, dictionary } = LINDERA_PACKAGES[code];
  const { TokenizerBuilder } = createRequire(join(FIXTURE, code, "package.json"))(name);
  const builder = new TokenizerBuilder();
  builder.setDictionary(dictionary);
  builder.setMode("normal");
  return builder.build();
}

async function buildJapaneseTokenizer() {
  return buildTokenizer("ja");
}

async function buildChineseTokenizer() {
  return buildTokenizer("zh");
}

describe("indexer/lang/ja.ts — real lindera-wasm (ipadic) analyzer", () => {
  it("strips particles (助詞) and auxiliary verbs (助動詞), keeping content words", async () => {
    const adapter = createJapaneseAdapter(await buildJapaneseTokenizer());
    const tokens = adapter.tokenize("東京都に行く");
    expect(tokens).toEqual(["東京", "都", "行く"]);
    expect(tokens).not.toContain("に");
  });

  it("keeps long compound proper nouns as a single token", async () => {
    const adapter = createJapaneseAdapter(await buildJapaneseTokenizer());
    const tokens = adapter.tokenize("関西国際空港限定トートバッグ");
    expect(tokens).toContain("関西国際空港");
  });
});

describe("indexer/lang/zh.ts — real lindera-wasm (cc-cedict) analyzer", () => {
  it("segments a sentence into real dictionary words", async () => {
    const adapter = createChineseAdapter(await buildChineseTokenizer());
    const tokens = adapter.tokenize("我今天去了北京");
    expect(tokens).toEqual(["我", "今天", "去", "了", "北京"]);
  });

  it("keeps multi-character compound words as a single token (自然语言处理 = NLP)", async () => {
    const adapter = createChineseAdapter(await buildChineseTokenizer());
    const tokens = adapter.tokenize("自然语言处理很有趣");
    expect(tokens).toContain("自然语言处理");
  });
});

/**
 * Proves the ambiguous-Han-only-text fix against the real analyzers, not
 * just the fake-tokenizer unit tests in lang_ja_zh.spec.ts. Before this
 * fix, a pure-Kanji Japanese phrase (no kana) was routed to zh ONLY, where
 * cc-cedict actively mis-segmented it. Measured against real Japanese
 * Wikipedia prose: only ~0.2% of full sentences are Han-only, but short
 * noun-phrase-shaped messages are meaningfully more exposed (~6.5% in the
 * same measurement) — a realistic risk for short chat messages, not a
 * theoretical one.
 */
describe("indexer/lang/ja.ts & zh.ts — ambiguous pure-Kanji text against the real analyzers", () => {
  const AMBIGUOUS_JA_PHRASE = "選挙結果発表"; // "election results announcement" — real Japanese, zero kana

  it("the real Japanese analyzer now correctly segments a pure-Kanji Japanese phrase into its real words", async () => {
    const ja = createJapaneseAdapter(await buildJapaneseTokenizer());
    expect(ja.tokenize(AMBIGUOUS_JA_PHRASE)).toEqual(["選挙", "結果", "発表"]);
  });

  it("the real Chinese analyzer still mis-segments the same phrase (the pre-existing, now-complemented-not-replaced behavior)", async () => {
    const zh = createChineseAdapter(await buildChineseTokenizer());
    const tokens = zh.tokenize(AMBIGUOUS_JA_PHRASE);
    // Real cc-cedict does not recognize "選挙"/"発表" as compound words and
    // splits them into single characters — this is exactly why ja.ts's
    // detect() was widened rather than relying on zh alone.
    expect(tokens).not.toContain("選挙");
    expect(tokens).not.toContain("発表");
  });

  it("genuine Chinese text run through the real Japanese analyzer (the accepted symmetric cost) produces no UNK garbage tokens", async () => {
    const ja = createJapaneseAdapter(await buildJapaneseTokenizer());
    const tokens = ja.tokenize("自然语言处理很有趣");
    // Simplified-Chinese-only character forms (语/处/很) have no ipadic
    // dictionary entry and come back tagged UNK — isContentTag() must have
    // filtered them out already; if this exclusion regressed, indexing
    // would silently start treating these fragments as real Japanese words.
    expect(tokens).not.toContain("语");
    expect(tokens).not.toContain("处");
    expect(tokens).not.toContain("很");
  });
});

// Real (short, fair-use) excerpts from Japanese/Chinese Wikipedia, used only
// to build realistic-shaped large input — not to test translation quality.
// CC BY-SA 4.0, https://ja.wikipedia.org/wiki/日本語 and
// https://zh.wikipedia.org/wiki/汉语.
const JA_EXCERPT =
  "日本語は、一部の方言を除いて、音の上下による高低アクセントを持っている。" +
  "アクセントは語ごとに決まっており、モーラ単位で高低が定まる。" +
  "同音語をアクセントによって区別できる場合も少なくない。";
const ZH_EXCERPT =
  "中国大陆大部分语言学家认为汉语是一种单一的语言，" +
  "但许多外国语言学家和中国内地的小部分语言学家认为汉语作为语族，" +
  "是官话、粤语、吴语、闽语、客家话等语言的统称。";

/**
 * These two blocks answer two DIFFERENT questions and must not be conflated:
 *  1. Does our own length cap stop oversized input before it ever reaches
 *     the WASM analyzer? (adapter-level — the analyzer is never called)
 *  2. Does the real Lindera WASM analyzer itself survive genuinely huge
 *     input if it WERE called? (bypasses the adapter/cap entirely)
 * Both are real findings: unlike kiwi-nlp (which aborted on real production
 * text in this size range), Lindera was tested directly up to 3,000,000
 * characters (150x MAX_TOKENIZE_LENGTH) and did not crash — only got slow
 * (~12s). The cap below is kept as a throughput safeguard either way.
 */
describe("indexer/lang/ja.ts & zh.ts — the length cap stops oversized input before the analyzer is called", () => {
  it("a real Japanese excerpt repeated past the length cap returns [] without invoking the analyzer", async () => {
    const adapter = createJapaneseAdapter(await buildJapaneseTokenizer());
    const huge = JA_EXCERPT.repeat(Math.ceil(25_000 / JA_EXCERPT.length));
    expect(huge.length).toBeGreaterThan(20_000);
    expect(adapter.tokenize(huge)).toEqual([]);
  });

  it("a real Chinese excerpt repeated past the length cap returns [] without invoking the analyzer", async () => {
    const adapter = createChineseAdapter(await buildChineseTokenizer());
    const huge = ZH_EXCERPT.repeat(Math.ceil(25_000 / ZH_EXCERPT.length));
    expect(huge.length).toBeGreaterThan(20_000);
    expect(adapter.tokenize(huge)).toEqual([]);
  });

  it("sanity check: the SAME real excerpts under the cap tokenize normally (the cap isn't just always returning [])", async () => {
    const ja = createJapaneseAdapter(await buildJapaneseTokenizer());
    const zh = createChineseAdapter(await buildChineseTokenizer());
    expect(ja.tokenize(JA_EXCERPT).length).toBeGreaterThan(0);
    expect(zh.tokenize(ZH_EXCERPT).length).toBeGreaterThan(0);
  });
});

describe("indexer/lang/ja.ts & zh.ts — the real WASM analyzer itself does not crash on genuinely huge input", () => {
  it("the raw Lindera Japanese tokenizer (bypassing our cap) handles 500,000 real characters without throwing", async () => {
    const tokenizer = await buildJapaneseTokenizer();
    const huge = JA_EXCERPT.repeat(Math.ceil(500_000 / JA_EXCERPT.length));
    expect(() => tokenizer.tokenize(huge)).not.toThrow();
  }, 30_000);

  it("the raw Lindera Chinese tokenizer (bypassing our cap) handles 500,000 real characters without throwing", async () => {
    const tokenizer = await buildChineseTokenizer();
    const huge = ZH_EXCERPT.repeat(Math.ceil(500_000 / ZH_EXCERPT.length));
    expect(() => tokenizer.tokenize(huge)).not.toThrow();
  }, 30_000);
});
