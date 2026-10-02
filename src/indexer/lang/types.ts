/**
 * Per-language morphological analysis adapter. Each installed language's
 * support (Korean now, others later) implements this shape and registers
 * itself via registry.ts — schema/writer/search never reference a specific
 * language by name, only by the codes registry.ts knows about.
 */
export interface LanguageAdapter {
  /** ISO-ish short code, e.g. "ko". Used to derive the FTS5 table name. */
  code: string;
  /** Does this text contain this language's script? Gates both indexing
   *  (skip tokenize() for rows that don't match) and query building (skip
   *  this layer for query terms that don't match). */
  detect(text: string): boolean;
  /** Content-word tokens with particles/endings/punctuation stripped, in
   *  original order. Empty array if nothing content-bearing was found. */
  tokenize(text: string): string[];
}
