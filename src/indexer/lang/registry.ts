/**
 * Language adapter registry. schema.ts, writer.ts, and mcp/search.ts all
 * drive off listKnownLanguageCodes() + getLanguageAdapter() instead of
 * referencing any specific language — adding a new language later means
 * adding one code here and one adapter module, not touching those three
 * files' logic.
 *
 * A code being "known" (listKnownLanguageCodes()) and a code being
 * "registered" (getLanguageAdapter() returns non-undefined) are different:
 * known codes always get a schema table (so nothing needs a schema migration
 * when a language is later installed), but a table only gets populated/
 * queried once its adapter is actually registered — i.e. the optional
 * dependency + model files were found at startup. See lang/init.ts.
 */
import type { LanguageAdapter } from "./types.js";

const registry = new Map<string, LanguageAdapter>();

/** Codes clens ships schema support for. Adding a language later is a
 *  one-line change here plus a new adapter module — not a schema rewrite. */
export function listKnownLanguageCodes(): string[] {
  return ["ko", "ja", "zh"];
}

export function registerLanguage(adapter: LanguageAdapter): void {
  registry.set(adapter.code, adapter);
}

export function getLanguageAdapter(code: string): LanguageAdapter | undefined {
  return registry.get(code);
}

/** Derives the per-language FTS5 table name from its code. Single source of
 *  truth so schema.ts, writer.ts, and search.ts never hand-type the name. */
export function languageFtsTable(code: string): string {
  return `user_text_fts_lang_${code}`;
}

/** Test-only: clear registrations between test cases. */
export function resetLanguageRegistry(): void {
  registry.clear();
}
