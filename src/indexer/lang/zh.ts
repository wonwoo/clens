import type { LanguageAdapter } from "./types.js";
import { hasHan as hasHanChars, hasKana } from "./scripts.js";

// CJK Unified Ideographs. This range also matches Japanese Kanji, so on its
// own it can't distinguish Chinese from Japanese — excluding text that also
// contains Hiragana/Katakana (see scripts.ts's hasKana) covers the common
// case (Japanese sentences almost always mix kana with Kanji). Text with
// Han characters and no kana is ambiguous — ja.ts's detect() now ALSO fires
// for this same ambiguous text (see its detectJapanese() comment for why:
// routing it to zh ONLY was found to actively mis-segment real Japanese
// words, e.g. splitting "選挙" into "選"+"挙"). This adapter still treats
// ambiguous text as Chinese too — the two adapters overlap on purpose for
// this narrow case rather than one silently losing it.
export function hasHan(text: string): boolean {
  return hasHanChars(text) && !hasKana(text);
}

// CC-CEDICT (unlike ipadic/ko-dic) carries no real part-of-speech tagging —
// every dictionary entry's partOfSpeech is "*"; the only non-"*" value
// observed is "UNK" for characters/punctuation with no dictionary entry
// (verified directly against real output, not assumed). Chinese is also an
// isolating language with no inflectional particles/endings to strip the
// way Korean/Japanese need, so "content word" here just means "a real
// dictionary word" — drop UNK (punctuation/unrecognized), keep everything else.
function isContentTag(pos: string): boolean {
  return pos !== "UNK";
}

// See ja.ts's MAX_TOKENIZE_LENGTH comment: tested Lindera directly against
// real repeated text up to 3,000,000 characters and it did NOT crash like
// kiwi-nlp did — this cap is a throughput safeguard (that same input took
// ~12s to tokenize) rather than a confirmed crash workaround for Lindera.
const MAX_TOKENIZE_LENGTH = 20_000;

export interface LinderaTokenizerLike {
  tokenize(text: string): { surface: string; partOfSpeech: string }[];
}

/** Builds a LanguageAdapter around an already-constructed Lindera Tokenizer
 *  (cc-cedict dictionary). Kept separate from the lindera-wasm package
 *  loading (see lang/init.ts) so this content-word extraction rule is
 *  unit-testable without the real WASM module. */
export function createChineseAdapter(tokenizer: LinderaTokenizerLike): LanguageAdapter {
  return {
    code: "zh",
    detect: hasHan,
    tokenize(text: string): string[] {
      if (!hasHan(text) || text.length > MAX_TOKENIZE_LENGTH) return [];
      try {
        return tokenizer
          .tokenize(text)
          .filter((t) => isContentTag(t.partOfSpeech))
          .map((t) => t.surface)
          .filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
