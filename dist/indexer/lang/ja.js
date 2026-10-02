import { hasHan, hasKana } from "./scripts.js";
export { hasKana } from "./scripts.js";
// A pure-Kanji sentence (Han present, no kana) is ambiguous between Japanese
// and Chinese with no reliable way to disambiguate short of deeper language
// detection than this project does anywhere else. Measured against a real
// Japanese Wikipedia article: only ~0.2% of full prose sentences are
// Han-only, but short noun-phrase-shaped chat messages (a user typing just
// a term or proper noun) are meaningfully more exposed — closer to ~6.5% in
// the same measurement once section-heading-shaped short phrases are
// counted. Previously, ambiguous text was routed to zh.ts ONLY, where it
// was found to actively mis-segment real Japanese words (e.g. splitting
// "選挙" into "選"+"挙"). Now both ja and zh try ambiguous text — zh.ts's
// hasHan()-based detect() independently does the same for the same reason.
// The cost is symmetric: genuine Chinese text also gets tried here and may
// contribute a wrong-but-plausible-looking Japanese segmentation (verified:
// common single Kanji shared with Chinese, e.g. "北京", tokenize under
// ipadic without an UNK tag) — diluted by RRF fusion the same way the
// language layer's occasional noise already is elsewhere.
function detectJapanese(text) {
    return hasKana(text) || hasHan(text);
}
// IPADIC POS tagset: 助詞 = particle, 助動詞 = auxiliary verb — excluded the
// same as before. "UNK" (no dictionary entry) is newly excluded too: it
// never appeared in genuine Japanese test input, but genuine Chinese text
// now reaching this tokenizer (via detectJapanese()'s ambiguous-text
// widening above) produces UNK for Chinese-only character forms (verified:
// simplified-Chinese-only characters like 语/处/很 come back UNK) — without
// this exclusion those fragments would get indexed as if they were
// meaningful Japanese content words.
//
// Accepted tradeoff, not fully corpus-validated: a genuine rare Japanese
// word ipadic doesn't recognize (an obscure proper noun, neologism, or
// loanword) would ALSO come back UNK and now gets silently dropped instead
// of indexed as before this commit. There's no real Japanese usage corpus
// in this project to measure how often that happens (see
// lang_ja_zh_real.spec.ts's header note on this same gap) — judged
// acceptable because a dropped content word only narrows one search layer
// among several (porter/trigram still index the row's raw text regardless),
// not a data-loss risk.
function isContentTag(pos) {
    return pos !== "助詞" && pos !== "助動詞" && pos !== "UNK";
}
// See ko.ts's MAX_TOKENIZE_LENGTH comment: a real production message (a
// multi-megabyte pasted log blob) aborted kiwi-nlp's WASM analyzer entirely.
// Tested Lindera directly against real repeated text up to 3,000,000
// characters (150x this cap) and it did NOT crash — unlike kiwi-nlp, it's
// not a confirmed crash risk here. It IS a confirmed performance risk: that
// same 3M-character input took ~12 seconds to tokenize. One pathological
// row should not stall an indexing batch for seconds, and no legitimate
// chat message needs morphological analysis over tens of thousands of
// characters regardless, so the same cap is kept as a throughput
// safeguard rather than a crash workaround.
const MAX_TOKENIZE_LENGTH = 20_000;
/** Builds a LanguageAdapter around an already-constructed Lindera Tokenizer
 *  (ipadic dictionary). Kept separate from the lindera-wasm package loading
 *  (see lang/init.ts) so this content-word extraction rule is unit-testable
 *  without the real WASM module. */
export function createJapaneseAdapter(tokenizer) {
    return {
        code: "ja",
        detect: detectJapanese,
        tokenize(text) {
            if (!detectJapanese(text) || text.length > MAX_TOKENIZE_LENGTH)
                return [];
            try {
                return tokenizer
                    .tokenize(text)
                    .filter((t) => isContentTag(t.partOfSpeech))
                    .map((t) => t.surface)
                    .filter(Boolean);
            }
            catch {
                // Belt-and-suspenders: the length cap above is the known trigger
                // class, but any other unexpected analyzer failure must not
                // propagate and abort the caller's indexing/search batch over one row.
                return [];
            }
        },
    };
}
//# sourceMappingURL=ja.js.map