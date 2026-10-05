/**
 * clens_search — multi-layer FTS5 search with RRF fusion.
 *
 * Layer 1: user_text_fts (unicode61) — standard word-boundary tokenization
 * Layer 2: user_text_fts_trigram (trigram) — substring/partial-word matching
 * Layer 3+: one per installed optional language adapter (see
 *   indexer/lang/registry.ts) — morpheme-normalized content-word matching,
 *   so a query with a particle/ending attached ("리팩토링을") matches the
 *   same rows as the bare form ("리팩토링"). Only languages with a
 *   registered adapter (i.e. actually installed) get a layer; others are
 *   skipped entirely, same as before any language support existed.
 *
 * Results from all active layers are merged via Reciprocal Rank Fusion
 * (K=60), so partial matches like "리뷰" finding "리뷰해바" work naturally.
 */

import type Database from "better-sqlite3";

import { getLanguageAdapter, languageFtsTable, listKnownLanguageCodes } from "../indexer/lang/registry.js";
import type { LanguageAdapter } from "../indexer/lang/types.js";
import { neighborsOf, type SessionMessage } from "./session.js";
import { notCopiedClause, workKindClause } from "../analyzer/scope.js";

export interface SearchParams {
  query: string;
  project_id?: string;
  since?: string;
  until?: string;
  /** Restrict matches to one author. Omit to search both (default). Filtering
   *  to "user" is the cheapest way to cut assistant-reply noise when looking
   *  for something the user themselves said (Task 2, item 1). */
  role?: "user" | "assistant";
  /** Only this session's own messages, not those of the subagents it started. */
  session_id?: string;
  limit?: number;
}

export interface SearchResult {
  session_id: string;
  project_id: string | null;
  ts: string;
  role: "user" | "assistant";
  /** A short match-centered excerpt of the matched message — NOT the full
   *  message. Enough to judge relevance; fetch the full conversation with
   *  clens_session (find/read split — see CLENS-IMPROVEMENT-TASKS.md Task 1). */
  snippet: string;
  /** RRF fused relevance score (higher = more relevant); results are ordered
   *  by it descending. Exposed so callers can gauge confidence and so a byte
   *  budget truncates from the least-relevant end. */
  score: number;
  /** Messages around the hit in its session, when the caller asked for them. */
  context?: { before: SessionMessage[]; after: SessionMessage[] };
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RRF_K = 60;

// Snippet window: characters kept before / after the first matched term's
// offset. TRAIL > LEAD because the text that explains *why* a hit is relevant
// usually follows the matched term. ~240 chars total keeps each result small
// enough that a full page fits the default byte budget while still carrying
// enough context to judge relevance (Task 1: "관련성 판단이 가능한 최소 길이").
const SNIPPET_LEAD = 60;
const SNIPPET_TRAIL = 180;
const CONTEXT_LINE_CHARS = SNIPPET_LEAD + SNIPPET_TRAIL;

/** Default cap on the TOTAL serialized bytes of a clens_search response.
 *  ~20 snippet rows fit comfortably under this; the cap only bites on large
 *  limits / long snippets, and always truncates from the lowest-ranked end. */
export const DEFAULT_SEARCH_MAX_BYTES = 8192;

/** Build a match-centered snippet: find where any positive query term first
 *  occurs in `text` and return a window around it, collapsing whitespace so
 *  the result stays 1–2 lines. Head-truncation (first N chars) is deliberately
 *  avoided — a matched term deep in a long message would fall outside a head
 *  cut, making a genuine hit look irrelevant.
 *
 *  `probes` must include, for each query term, both its literal text AND (for
 *  a term a language adapter detects) its content-word tokens — mirroring
 *  termSatisfied's two-path check — so a language-layer hit like "리팩토링을"
 *  matching a row containing only the bare "리팩토링" still locates its offset
 *  instead of silently falling back to a head cut. */
function buildSnippet(text: string, probes: string[]): string {
  const lower = text.toLowerCase();
  let off = -1;
  for (const p of probes) {
    if (!p) continue;
    const i = lower.indexOf(p.toLowerCase());
    if (i >= 0 && (off === -1 || i < off)) off = i;
  }
  if (off < 0) off = 0; // no probe located (defensive — post-filter guarantees a match); head snippet
  const start = Math.max(0, off - SNIPPET_LEAD);
  const end = Math.min(text.length, off + SNIPPET_TRAIL);
  let slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) slice = "…" + slice;
  if (end < text.length) slice = slice + "…";
  return slice;
}

/** Serialize search results into the MCP text response under a total byte
 *  budget. Results arrive already ordered by score (descending), so the budget
 *  truncates from the least-relevant end and reports the hidden count — a
 *  size cap must never silently hide a relevant hit (Task 1: recall 무회귀).
 *  The top result is always emitted even if it alone exceeds the budget.
 *
 *  `totalMatched` is how many rows matched before the `limit` slice (see
 *  searchWithTotal). Passing it lets the footer count BOTH kinds of omission —
 *  results dropped here for size AND matches never fetched because they fell
 *  past `limit` — so a full page of `limit` results no longer implies "that's
 *  all there is". It is a floor (the candidate pool is itself capped at ~3x
 *  limit), hence the "+N more" wording is a lower bound, never an overclaim.
 *  Defaults to results.length so a caller that doesn't track it still gets the
 *  size-only count, unchanged. */
export function formatSearchResults(
  results: SearchResult[],
  maxBytes = DEFAULT_SEARCH_MAX_BYTES,
  totalMatched = results.length,
  /** Name each hit's project: set when the search spanned every project. */
  showProject = false,
): string {
  if (results.length === 0) return "No results found.";
  const parts: string[] = [];
  let used = 0;
  const label = (role: string) => (role === "assistant" ? "Assistant" : "User");
  // A context message is one line cut to about a snippet's length, marked by
  // its offset from the hit: [-1] is the message just before it.
  const contextLine = (m: SessionMessage, at: string) =>
    `  [${at}] ${label(m.role)}: ${cutChars(m.text.replace(/\s+/g, " "), CONTEXT_LINE_CHARS)}`;
  for (const r of results) {
    const where = showProject ? `  project:${r.project_id ?? "?"}` : "";
    const before = r.context?.before.map((m, i, all) => contextLine(m, `-${all.length - i}`)) ?? [];
    const after = r.context?.after.map((m, i) => contextLine(m, `+${i + 1}`)) ?? [];
    const entry = [
      `[${parts.length + 1}] ${r.ts}  session:${r.session_id}${where}  score:${r.score}`,
      ...before,
      `${label(r.role)}: ${r.snippet}`,
      ...after,
    ].join("\n");
    const cost = Buffer.byteLength(entry, "utf8") + (parts.length > 0 ? 2 : 0); // +2 for the "\n\n" joiner
    if (parts.length > 0 && used + cost > maxBytes) break;
    parts.push(entry);
    used += cost;
  }
  let out = parts.join("\n\n");
  // Hidden = every match not on screen, whether dropped here for size or left
  // unfetched beyond `limit`. totalMatched >= results.length always, so this is
  // never negative; when a caller omits totalMatched it reduces to size-only.
  const hidden = Math.max(totalMatched, results.length) - parts.length;
  if (hidden > 0) {
    out += `\n\n(+${hidden} more match${hidden === 1 ? "" : "es"} not shown — narrow the query, or raise limit/maxBytes; open any hit's full text with clens_session)`;
  }
  return out;
}

/** One AND-joined group of positive terms; groups are OR'd together. */
interface TermGroup {
  terms: QueryTerm[];
}

/** `text` is the sanitized form the MATCH expressions are built from; `raw`
 *  is the term as the user typed it. The post-filter accepts a row holding
 *  either one, because sanitizing can turn a term into text that no row
 *  contains: a URL's "https://" becomes "https //". */
interface QueryTerm {
  text: string;
  raw: string;
  phrase: boolean;
}

interface TokenizedQuery {
  groups: TermGroup[];
  /** Raw (unquoted) text of NOT-negated terms, used as a post-filter over
   *  merged results — see the note in searchUserText() for why this can't
   *  be enforced inside a single layer's MATCH clause alone. */
  negatedTerms: string[];
}

const BARE_WORD_UNSAFE = /["'(){}[\]*:^~]/g;
const PHRASE_UNSAFE = /['(){}[\]:^~]/g;

/** Tokenize a raw query into quoted-phrase / bare-word terms, recognizing
 *  standalone NOT/AND/OR as FTS5 boolean operators and NEAR as an
 *  acknowledged-but-unsupported operator (dropped, not treated as a literal
 *  search term). Operators must be uppercase, as in FTS5 itself: a lowercase
 *  "not" is an ordinary word, or "native binary not found" would search for
 *  "native binary" without "found". AND is implicit between adjacent terms, so
 *  an explicit "AND" token is just consumed. OR starts a new term group.
 *  NOT marks the next term (phrase or bare word) as negated. */
function tokenizeQuery(raw: string): TokenizedQuery {
  const groups: TermGroup[] = [{ terms: [] }];
  const negatedTerms: string[] = [];
  let pendingNot = false;

  const tokenRe = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(raw)) !== null) {
    if (m[1] !== undefined) {
      const cleaned = m[1].replace(PHRASE_UNSAFE, " ").replace(/\s+/g, " ").trim();
      if (!cleaned) { pendingNot = false; continue; }
      if (pendingNot) negatedTerms.push(cleaned);
      else groups[groups.length - 1]!.terms.push({ text: cleaned, raw: m[1].trim(), phrase: cleaned.includes(" ") });
      pendingNot = false;
      continue;
    }
    const word = m[2]!;
    if (word === "NOT") { pendingNot = true; continue; }
    if (word === "AND") { pendingNot = false; continue; }
    if (word === "OR") { pendingNot = false; groups.push({ terms: [] }); continue; }
    if (word === "NEAR") { pendingNot = false; continue; }
    // ":" separates rather than vanishes: deleting it glued "ecc:plan-prd"
    // into "eccplan-prd" and a URL's scheme onto its host, which no row holds.
    const cleaned = word.replace(/:/g, " ").replace(BARE_WORD_UNSAFE, "").replace(/\s+/g, " ").trim();
    if (!cleaned) { pendingNot = false; continue; }
    if (pendingNot) negatedTerms.push(cleaned);
    else groups[groups.length - 1]!.terms.push({ text: cleaned, raw: word, phrase: false });
    pendingNot = false;
  }

  return { groups: groups.filter((g) => g.terms.length > 0), negatedTerms };
}

/** Render OR-of-AND-groups into a unicode61 MATCH expression. Bare words get
 *  a trailing prefix wildcard (partial-word matches like 리뷰->리뷰해바);
 *  phrases are passed through as literal FTS5 phrase queries (adjacency
 *  required) instead of being split into independently-AND'd words. */
function renderPorterMatch(groups: TermGroup[]): string {
  const groupExprs = groups
    .map((g) => {
      const termExprs = g.terms.map((t) => (t.phrase ? `"${t.text}"` : `"${t.text}"*`));
      return termExprs.length > 1 ? `(${termExprs.join(" AND ")})` : termExprs[0];
    })
    .filter((e): e is string => !!e);
  return groupExprs.join(" OR ");
}

interface TrigramQuery {
  /** MATCH expression for words with ≥3 codepoints (trigram tokenizer's minimum
   *  unit). Empty string if no word qualifies. */
  matchExpr: string;
  /** Words under 3 codepoints — too short to appear in a trigram MATCH
   *  expression (they can't form even one trigram). Enforced instead via
   *  `text LIKE '%word%'` against the same table, which SQLite's trigram
   *  tokenizer explicitly supports as an index-accelerated path (fts5.html
   *  §4.3.4: "FTS5 tables that use the trigram tokenizer also support
   *  indexed GLOB and LIKE pattern matching"). */
  likeTerms: string[];
}

/** Render positive terms into a trigram query. The trigram layer doesn't
 *  understand OR grouping or phrase adjacency (it's a fuzzy substring-assist
 *  layer, not the precise one) — every word from every group is still
 *  required (implicit AND), same as before this fix. Negated terms are
 *  excluded from the caller before this runs (see tokenizeQuery). */
function renderTrigram(groups: TermGroup[]): TrigramQuery {
  const words = groups.flatMap((g) => g.terms.flatMap((t) => t.text.split(/\s+/).filter(Boolean)));
  const longWords = words.filter((w) => [...w].length >= 3);
  const shortWords = words.filter((w) => [...w].length < 3);
  return {
    matchExpr: longWords.length > 0 ? longWords.map((w) => `"${w}"`).join(" ") : "",
    likeTerms: shortWords,
  };
}

/** Render positive terms into a language-layer MATCH expression: each
 *  term's content-word tokens (particles/endings stripped via the adapter)
 *  are AND'd together, mirroring renderPorterMatch's OR-of-AND-groups shape.
 *  A term the adapter's script doesn't detect (e.g. an English word in an
 *  otherwise-Korean query) contributes nothing to this layer — the porter
 *  layer already enforces full query semantics; this layer is a
 *  supplementary precision signal, not a replacement. */
function renderLanguageMatch(groups: TermGroup[], adapter: LanguageAdapter): string {
  const groupExprs = groups
    .map((g) => {
      const termExprs = g.terms
        .filter((t) => adapter.detect(t.text))
        .map((t) => adapter.tokenize(t.text))
        .filter((toks) => toks.length > 0)
        .map((toks) => toks.map((tok) => `"${tok}"`).join(" AND "));
      if (termExprs.length === 0) return null;
      return termExprs.length > 1 ? `(${termExprs.join(" AND ")})` : termExprs[0];
    })
    .filter((e): e is string => e !== null);
  return groupExprs.join(" OR ");
}

interface RawResult {
  rowid: number;
  session_id: string;
  project_id: string | null;
  ts: string;
  role: "user" | "assistant";
  text: string;
}

/** The turn the caller is in: its session and the ts of the question that
 *  opened the turn. Rows from there on are left out of results. */
interface CurrentTurn {
  session_id: string;
  ts: string;
}

export interface SearchOptions {
  /** The session making the call. Its current turn (the question just asked
   *  and whatever followed it) is left out of results: that question matches
   *  its own keywords and used to come back as the top hit. */
  currentSessionId?: string;
}

function currentTurnOf(db: Database.Database, sessionId: string | undefined): CurrentTurn | undefined {
  if (!sessionId) return undefined;
  const row = db
    .prepare("SELECT max(ts) AS ts FROM user_text WHERE session_id = ? AND role = 'user' AND type = 'user_message'")
    .get(sessionId) as { ts: string | null } | undefined;
  return row?.ts ? { session_id: sessionId, ts: row.ts } : undefined;
}

function buildWhere(
  ftsTable: string,
  matchExpr: string,
  likeTerms: string[],
  role: "user" | "assistant",
  project_id?: string,
  since?: string,
  until?: string,
  currentTurn?: CurrentTurn,
  humanOnly = false,
  session_id?: string,
): { where: string; bindings: unknown[]; hasMatch: boolean } {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  const hasMatch = matchExpr.length > 0;
  if (hasMatch) {
    conditions.push(`${ftsTable} MATCH ?`);
    bindings.push(matchExpr);
  }
  for (const term of likeTerms) {
    conditions.push("fts.text LIKE ?");
    bindings.push(`%${term}%`);
  }
  conditions.push("ut.role = ?");
  bindings.push(role);
  conditions.push("ut.type != 'continuation_summary'");
  if (session_id) {
    // A session named explicitly is searched whatever its kind, as
    // clens_stats shows one, and whole: a line copied into it from the
    // session it resumed is one of its own, with no other copy to hide here.
    conditions.push("ut.session_id = ?");
    bindings.push(session_id);
  } else {
    // Transcripts of clens's former background judge hold packed copies of
    // real conversations, twice their size, and outranked them. One-shot
    // programmatic runs (mostly benchmarks and tests started with `claude -p`
    // or `codex exec`) and the subagents they started are not the user's
    // conversations either.
    conditions.push(workKindClause("s"));
    // A message copied into a resumed session is found once.
    conditions.push(notCopiedClause("ut.event_uuid", "ut.session_id"));
  }
  // role "user" asks for what the user said. In a subagent's thread the
  // "user" is the agent that started it.
  if (humanOnly) conditions.push("s.kind IS NOT 'subagent'");
  conditions.push(notNoise("ut"));
  if (project_id) { conditions.push("s.project_id = ?"); bindings.push(project_id); }
  if (since) { conditions.push("ut.ts >= ?"); bindings.push(since); }
  if (until) { conditions.push("ut.ts <= ?"); bindings.push(until); }
  if (currentTurn) {
    conditions.push("NOT (ut.session_id = ? AND ut.ts >= ?)");
    bindings.push(currentTurn.session_id, currentTurn.ts);
  }
  return { where: conditions.join(" AND "), bindings, hasMatch };
}

/** `text` trimmed and cut to `max` characters (code points), marked with
 *  "…" when cut. */
export function cutChars(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? chars.slice(0, max).join("") + "…" : chars.join("");
}

/** SQL condition that is false for a stored row holding no conversation:
 *  Claude Code's interrupt marker, an empty message, an imported session's
 *  marker and tool log, the fixed "No response requested." reply, and a
 *  command message the old parser stored with its "/word"s cut out (leaving
 *  "<command-name><>"-style remnants; rows re-parsed since hold what was
 *  typed after the command, and count as conversation). */
export function notNoise(alias: string): string {
  const t = `${alias}.text`;
  return `NOT (substr(${t}, 1, 28) = '[Request interrupted by user'
    OR trim(${t}) = ''
    OR substr(${t}, 1, 20) = '[external_agent_tool'
    OR ${t} = '<EXTERNAL SESSION IMPORTED>'
    OR ${t} = 'No response requested.'
    OR substr(${t}, 1, 15) = '<local-command-'
    OR substr(${t}, 1, 19) = '<task-notification>'
    OR substr(${t}, 1, 13) = '<bash-stdout>'
    OR (substr(${t}, 1, 9) = '<command-' AND instr(${t}, '<command-args></command-args>') > 0)
    OR (${alias}.is_command = 1 AND ${t} LIKE '%<command-%<>%'))`;
}

const RRF_K_ASSISTANT = 80;

function runLayer(
  db: Database.Database,
  ftsTable: string,
  query: { matchExpr: string; likeTerms: string[] },
  role: "user" | "assistant",
  params: SearchParams,
  fetchLimit: number,
  currentTurn?: CurrentTurn,
): RawResult[] {
  if (!query.matchExpr && query.likeTerms.length === 0) return [];
  const { where, bindings, hasMatch } = buildWhere(
    ftsTable,
    query.matchExpr,
    query.likeTerms,
    role,
    params.project_id,
    params.since,
    params.until,
    currentTurn,
    params.role === "user",
    params.session_id,
  );
  // fts.rank is only meaningful when a MATCH constraint ran against the
  // table this query; a LIKE-only query (all words <3 codepoints) has no
  // rank to sort by, so fall back to recency.
  const orderBy = hasMatch ? "fts.rank" : "ut.ts DESC";
  const sql = `
    SELECT fts.rowid, ut.session_id, s.project_id, ut.ts, ut.role, ut.text
    FROM ${ftsTable} fts
    JOIN user_text ut ON ut.rowid = fts.rowid
    JOIN session s ON s.id = ut.session_id
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ?
  `;
  try {
    return db.prepare(sql).all(...bindings, fetchLimit) as RawResult[];
  } catch {
    return [];
  }
}

/** Search for already-tokenized term groups, plus the total number of matched
 *  rows (before the `limit` slice), so the caller can tell whether more
 *  matches exist than were returned. The count is a floor: the per-layer
 *  candidate pool is capped at ~3x limit, so for very common terms it plateaus
 *  below the true corpus total — but it is always ≥ the returned count and >
 *  limit whenever more genuinely exist, which is exactly the "is anything
 *  hidden?" signal the footer needs. */
function searchGroups(
  db: Database.Database,
  params: SearchParams,
  groups: TermGroup[],
  negatedTerms: string[],
  currentTurn: CurrentTurn | undefined,
): { results: SearchResult[]; totalMatched: number } {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const fetchLimit = Math.max(limit * 3, 30);
  const porterQuery = { matchExpr: renderPorterMatch(groups), likeTerms: [] as string[] };
  const trigramQuery = renderTrigram(groups);

  const layers: { table: string; query: { matchExpr: string; likeTerms: string[] } }[] = [
    { table: "user_text_fts", query: porterQuery },
    { table: "user_text_fts_trigram", query: trigramQuery },
  ];
  for (const code of listKnownLanguageCodes()) {
    const adapter = getLanguageAdapter(code);
    if (!adapter) continue; // not installed — no layer, same as before language support existed
    const matchExpr = renderLanguageMatch(groups, adapter);
    if (matchExpr) layers.push({ table: languageFtsTable(code), query: { matchExpr, likeTerms: [] } });
  }

  // RRF fusion: user K=60 (higher weight), assistant K=80 (lower weight).
  // Every layer runs for both roles so no layer is weighted differently
  // from the others beyond that user/assistant split. A `role` filter narrows
  // this to just that author's passes — the cheapest noise cut for "find what
  // I said" (Task 2, item 1) — without touching the per-role RRF weights.
  const scores = new Map<number, number>();
  const rows = new Map<number, RawResult>();

  const fuse = (results: RawResult[], k: number) => {
    for (const [i, r] of results.entries()) {
      scores.set(r.rowid, (scores.get(r.rowid) ?? 0) + 1 / (k + i + 1));
      rows.set(r.rowid, r);
    }
  };
  const roles: ("user" | "assistant")[] = params.role ? [params.role] : ["user", "assistant"];
  for (const layer of layers) {
    for (const role of roles) {
      fuse(runLayer(db, layer.table, layer.query, role, params, fetchLimit, currentTurn), role === "user" ? RRF_K : RRF_K_ASSISTANT);
    }
  }

  // Neither layer's MATCH clause can fully enforce NOT (exclusion) or exact
  // phrase adjacency on its own: searchUserText unions results across every
  // layer, and the trigram layer doesn't understand negation or phrase
  // boundaries (renderTrigram flattens everything to individually-required
  // words). A row the porter layer would correctly exclude/reject can still
  // surface via the trigram layer. The only place all layers' results are
  // already merged into one set is here, after scoring — so both guarantees
  // are enforced as a post-filter over the full scored candidate pool,
  // before slicing to `limit` (fetchLimit's 3x headroom keeps enough
  // candidates for this filter to still fill the page in the common case).
  //
  // A term counts as satisfied either by literal substring (the raw-text
  // check every layer implicitly relies on) OR — for a term a registered
  // language adapter detects — by its content-word tokens all appearing in
  // that row's language-layer indexed text. Without the second path, a
  // language-layer match for a particle-attached query ("리팩토링을") would
  // pass the MATCH clause (the layer correctly stripped the particle) only
  // to be rejected here for not containing "리팩토링을" literally, silently
  // undoing the entire point of that layer.
  const langIndexedTextLookups = new Map<string, (rowid: number) => string | undefined>();
  for (const code of listKnownLanguageCodes()) {
    const adapter = getLanguageAdapter(code);
    if (!adapter) continue;
    let stmt: Database.Statement;
    try {
      stmt = db.prepare(`SELECT text FROM ${languageFtsTable(code)} WHERE rowid = ?`);
    } catch {
      // Schema lag: the adapter registered (e.g. ja/zh's embedded dictionary
      // loads unconditionally once the package is installed) but this
      // table doesn't exist yet because applySchema() only runs from the
      // indexer (driver.ts), not from the MCP server — treat exactly like
      // "not installed" instead of crashing the whole search.
      continue;
    }
    const cache = new Map<number, string | undefined>();
    langIndexedTextLookups.set(code, (rowid: number) => {
      if (cache.has(rowid)) return cache.get(rowid);
      const row = stmt.get(rowid) as { text: string } | undefined;
      cache.set(rowid, row?.text);
      return row?.text;
    });
  }
  const termSatisfied = (term: QueryTerm, r: RawResult): boolean => {
    const lower = r.text.toLowerCase();
    if (lower.includes(term.text.toLowerCase()) || lower.includes(term.raw.toLowerCase())) return true;
    // Phrase terms require adjacency, which the language layer's tokenized-
    // content-word check below cannot verify (it only checks that each
    // token appears somewhere in the row, regardless of order/adjacency) —
    // fall back to substring-only enforcement for phrases, same as before
    // language layers existed.
    if (term.phrase) return false;
    for (const [code, lookup] of langIndexedTextLookups) {
      const adapter = getLanguageAdapter(code)!;
      if (!adapter.detect(term.text)) continue;
      const queryTokens = adapter.tokenize(term.text);
      if (queryTokens.length === 0) continue;
      const indexed = lookup(r.rowid);
      if (indexed && queryTokens.every((tok) => indexed.includes(tok))) return true;
    }
    return false;
  };
  const satisfiesGroup = (r: RawResult) =>
    groups.length === 0 || groups.some((g) => g.terms.every((t) => termSatisfied(t, r)));
  let sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([rowid]) => rows.get(rowid)!)
    .filter((r) => satisfiesGroup(r));
  // Known asymmetry: unlike termSatisfied's positive-match path, negation
  // has no language-layer normalization — "NOT 리팩토링을" (particle-
  // attached) won't exclude a row that only contains the bare form
  // "리팩토링". Under-exclusion, not a false positive, and not a regression
  // (NOT never had language-layer support before this feature); left as a
  // known gap rather than in scope for this change's acceptance criteria.
  if (negatedTerms.length > 0) {
    sorted = sorted.filter((r) => !negatedTerms.some((neg) => r.text.toLowerCase().includes(neg.toLowerCase())));
  }
  const ranked = sorted.slice(0, limit);

  // Snippet probes: for each positive query term, its literal text plus — for
  // a term a registered language adapter detects — its content-word tokens.
  // This mirrors termSatisfied's two-path check so buildSnippet can locate the
  // match offset for a language-layer hit (e.g. "리팩토링을" matching a row
  // holding only "리팩토링") instead of degrading to a head cut. Built once and
  // reused across every result. Every matched row is searched and returned on
  // its own (both roles independently), so each hit's snippet comes from its
  // own text — the paired next-assistant-reply enrichment was removed with the
  // find/read split (Task 1): the full reply is fetched via clens_session.
  const snippetProbes: string[] = [];
  for (const g of groups) {
    for (const t of g.terms) {
      if (t.raw !== t.text) snippetProbes.push(t.raw);
      snippetProbes.push(t.text);
      for (const code of listKnownLanguageCodes()) {
        const adapter = getLanguageAdapter(code);
        if (adapter && adapter.detect(t.text)) snippetProbes.push(...adapter.tokenize(t.text));
      }
    }
  }

  const results = ranked.map((r) => ({
    session_id: r.session_id,
    project_id: r.project_id,
    ts: r.ts,
    role: r.role,
    snippet: buildSnippet(r.text, snippetProbes),
    score: Math.round((scores.get(r.rowid) ?? 0) * 1e4) / 1e4,
  }));
  // sorted is the full post-filter candidate pool; ranked is its first `limit`.
  return { results, totalMatched: sorted.length };
}

/** Search plus the total number of matched rows (see searchGroups). Words
 *  are AND'ed, so a query worded differently from the message it is after,
 *  such as a paraphrase, often matches nothing. When a multi-word query finds
 *  nothing, it is retried with each word on its own and `partial` is set, so
 *  the caller can say the hits hold only some of the words. */
export function searchWithTotal(
  db: Database.Database,
  params: SearchParams,
  opts: SearchOptions = {},
): { results: SearchResult[]; totalMatched: number; partial: boolean } {
  const currentTurn = currentTurnOf(db, opts.currentSessionId);
  const { groups, negatedTerms } = tokenizeQuery(params.query);
  const every = searchGroups(db, params, groups, negatedTerms, currentTurn);
  const terms = groups.length === 1 ? groups[0]!.terms : [];
  if (every.results.length === 0 && terms.length >= 2) {
    const some = searchGroups(db, params, terms.map((t) => ({ terms: [t] })), negatedTerms, currentTurn);
    if (some.results.length > 0) return { ...some, partial: true };
  }
  return { ...every, partial: false };
}

/** Convenience wrapper returning only the results array (the common case).
 *  Callers that need to know whether matches were hidden past `limit` — the
 *  MCP server, to build an honest "+N more" footer — use searchWithTotal. */
export function searchUserText(db: Database.Database, params: SearchParams, opts: SearchOptions = {}): SearchResult[] {
  return searchWithTotal(db, params, opts).results;
}

export interface SearchTextOptions {
  maxBytes: number;
  context: number;
  allProjects: boolean;
}

/** One search as the clens_search tool prints it: results with `context`
 *  neighbours, fitted into `maxBytes`, with a note when no message held
 *  every word. */
export function searchText(
  db: Database.Database,
  params: SearchParams,
  opts: SearchOptions,
  out: SearchTextOptions,
): string {
  const { results, totalMatched, partial } = searchWithTotal(db, params, opts);
  if (out.context > 0) {
    for (const r of results) r.context = neighborsOf(db, r.session_id, r.ts, out.context);
  }
  const text = formatSearchResults(results, out.maxBytes, totalMatched, out.allProjects);
  const note = partial ? "No message contains every word of the query; these contain some of them.\n\n" : "";
  return note + text;
}

/** Several searches with the same filters, one `### query:` section each.
 *  The headers and the blank lines between sections are paid for out of
 *  `maxBytes`; the rest is shared evenly. formatSearchResults always keeps
 *  its top hit, so each query's best hit survives a small share. */
export function searchManyText(
  db: Database.Database,
  base: Omit<SearchParams, "query">,
  queries: string[],
  opts: SearchOptions,
  out: SearchTextOptions,
): string {
  const headers = queries.map((q) => `### query: ${q}\n`);
  const overhead = headers.reduce((n, h) => n + Buffer.byteLength(h), 0) + 2 * (queries.length - 1);
  const per = Math.max(0, Math.floor((out.maxBytes - overhead) / queries.length));
  return queries
    .map((query, i) => headers[i]! + searchText(db, { ...base, query }, opts, { ...out, maxBytes: per }))
    .join("\n\n");
}
