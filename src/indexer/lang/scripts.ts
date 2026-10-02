/**
 * Raw Unicode script-range detection shared by ja.ts and zh.ts. Split out
 * to a standalone module (rather than one importing the other) because both
 * files' detect() logic now needs both functions — ja.ts needs hasHan()
 * (Han-only text is ambiguously also-Japanese, see ja.ts) and zh.ts needs
 * hasKana() (to exclude text that's more likely Japanese) — importing
 * directly between ja.ts and zh.ts would be circular.
 *
 * Naming note: this module's hasHan() means only "contains any Han/CJK
 * ideograph" — the raw script check. zh.ts imports it aliased as
 * hasHanChars and re-derives its OWN same-named hasHan() with a narrower,
 * adapter-specific meaning ("Han present AND no kana" — its actual
 * Chinese-vs-Japanese detect() policy). Don't confuse the two; only the
 * name collides, not the code path (zh.ts's alias avoids a literal clash).
 */

// Hiragana + Katakana — a strong, largely Japanese-exclusive signal.
const KANA_RE = /[぀-ヿ]/;

export function hasKana(text: string): boolean {
  return KANA_RE.test(text);
}

// CJK Unified Ideographs (Kanji/Hanzi) — shared between Japanese and
// Chinese, so on its own this cannot distinguish the two languages.
const HAN_RE = /[一-鿿]/;

export function hasHan(text: string): boolean {
  return HAN_RE.test(text);
}
