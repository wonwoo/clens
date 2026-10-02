const registry = new Map();
/** Codes clens ships schema support for. Adding a language later is a
 *  one-line change here plus a new adapter module — not a schema rewrite. */
export function listKnownLanguageCodes() {
    return ["ko", "ja", "zh"];
}
export function registerLanguage(adapter) {
    registry.set(adapter.code, adapter);
}
export function getLanguageAdapter(code) {
    return registry.get(code);
}
/** Derives the per-language FTS5 table name from its code. Single source of
 *  truth so schema.ts, writer.ts, and search.ts never hand-type the name. */
export function languageFtsTable(code) {
    return `user_text_fts_lang_${code}`;
}
/** Test-only: clear registrations between test cases. */
export function resetLanguageRegistry() {
    registry.clear();
}
//# sourceMappingURL=registry.js.map