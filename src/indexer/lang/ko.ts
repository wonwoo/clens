import type { LanguageAdapter } from "./types.js";

const HANGUL_RE = /[가-힣]/;

export function hasHangul(text: string): boolean {
  return HANGUL_RE.test(text);
}

// Sejong POS tagset: J* = particle (조사), E* = ending (어미) — always
// excluded. S* is not uniformly "symbol": real punctuation/symbol tags
// (SF/SP/SSO/SSC/SE/SO/SW, ...) start with S, but so do three
// content-bearing tags — SL (foreign/Latin-script word), SH (Chinese
// character), SN (number) — verified directly against real kiwi-nlp
// output. A bare "starts with S" check silently dropped foreign loanwords,
// Chinese characters, and numbers embedded in Korean text as if they were
// punctuation (e.g. "Kiwi의" analyzes as [{"Kiwi", SL}, {"의", JKG}], but
// the old check excluded SL too, leaving zero content tokens instead of
// ["Kiwi"] — the row's Korean layer silently lost this term entirely).
const CONTENT_S_TAGS = new Set(["SL", "SH", "SN"]);

function isContentTag(tag: string): boolean {
  if (/^[JE]/.test(tag)) return false;
  if (tag.startsWith("S")) return CONTENT_S_TAGS.has(tag);
  return true;
}

// Real production text found a multi-megabyte pasted log blob (a few stray
// Hangul characters inside gigabytes of otherwise-English log lines) that
// aborted the kiwi-nlp WASM analyzer entirely (RuntimeError: Aborted()) —
// its internal buffer/stack has a limit far below what a single chat
// message should ever need. No legitimate short-form chat message needs
// morphological analysis over tens of thousands of characters; skip
// tokenizing anything this large exactly like non-Korean text, rather than
// risk it (the porter/trigram layers still index it normally either way).
const MAX_TOKENIZE_LENGTH = 20_000;

export interface KiwiLike {
  analyze(text: string): { tokens: { str: string; tag: string }[] };
}

/** Builds a LanguageAdapter around an already-constructed Kiwi analyzer.
 *  Kept separate from the kiwi-nlp package loading / model file reading
 *  (see lang/init.ts) so this content-word extraction rule is unit-testable
 *  without the real ~84MB model. */
export function createKoreanAdapter(kiwi: KiwiLike): LanguageAdapter {
  return {
    code: "ko",
    detect: hasHangul,
    tokenize(text: string): string[] {
      if (!hasHangul(text) || text.length > MAX_TOKENIZE_LENGTH) return [];
      try {
        return kiwi
          .analyze(text)
          .tokens.filter((t) => isContentTag(t.tag))
          .map((t) => t.str)
          .filter(Boolean);
      } catch {
        // Belt-and-suspenders: the length cap above is the known trigger,
        // but any other unexpected analyzer failure must not propagate and
        // abort the caller's indexing/search batch over one row.
        return [];
      }
    },
  };
}
