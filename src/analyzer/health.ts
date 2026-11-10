/**
 * Dimension 9 — health.
 *
 * - tool_errors: tool_call.is_error = 1 count.
 * - compaction_events: system_reminder rows with category='compaction', one
 *   per compaction (a Claude Code compact_boundary line or a Codex
 *   `compacted` item; see the parsers), plus the summary messages of a
 *   session that has no such row.
 * - context_bloat_ratio: max(ctx) / median(ctx) for assistant events in the
 *   scope, where ctx is in_tok + cache_r + cache_w for a Claude Code event and
 *   in_tok alone for a Codex event, whose cached tokens are part of its input.
 *   Events with no token counts (a Codex reply or tool call, a Claude Code
 *   line without usage) are left out. Heuristic surfacing of "context grew
 *   unmanageable".
 */

import type Database from "better-sqlite3";
import { eventWhere, sessionScopedWhere, type Scope } from "./scope.js";

export interface HealthFacts {
  tool_errors: number;
  compaction_events: number;
  context_bloat_ratio: number | null;
  context_bloat_detail: {
    max_ctx: number;
    median_ctx: number;
    sample_size: number;
    max_session_id: string;
    max_ts: string;
  } | null;
}

export function analyzeHealth(db: Database.Database, scope: Scope): HealthFacts {
  const toolScope = sessionScopedWhere(scope, "tc.session_id", "tc.ts", "tc.event_uuid");
  const eventScope = eventWhere(scope, "e");

  const toolErrors = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM tool_call tc WHERE is_error = 1 AND ${toolScope.sql}`,
      )
      .get(...toolScope.binds) as { c: number }
  ).c;

  // One system_reminder row per compaction, written by the parsers.
  const srScope = sessionScopedWhere(scope, "sr.session_id", "sr.ts", "sr.event_uuid");
  const compactions = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM system_reminder sr
         WHERE category = 'compaction' AND ${srScope.sql}`,
      )
      .get(...srScope.binds) as { c: number }
  ).c;
  // A Claude Code session indexed before the parser wrote compaction rows,
  // whose transcript is gone since, cannot be read again: its compactions
  // are left only as the summary each one starts the conversation again
  // with. Those count where the session has no compaction row; in a session
  // with both, they match one for one.
  const utScope = sessionScopedWhere(scope, "ut.session_id", "ut.ts", "ut.event_uuid");
  const summaryOnly = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM user_text ut
         WHERE ut.type = 'continuation_summary' AND ${utScope.sql}
           AND NOT EXISTS (SELECT 1 FROM system_reminder cr
                           WHERE cr.session_id = ut.session_id AND cr.category = 'compaction')`,
      )
      .get(...utScope.binds) as { c: number }
  ).c;

  // Context bloat: the distribution of assistant events' context size.
  // Claude Code reports cache reads and writes apart from input_tokens, so its
  // context is the sum. Codex's input_tokens already holds its
  // cached_input_tokens (the parser stores them as in_tok and cache_r), so a
  // Codex event counts in_tok only; the sum would count the cache twice. An
  // event with no session row is counted as before, by the sum.
  // Events with no token counts are left out: a Codex turn writes its counts
  // on one event, so its replies and tool calls carry 0, as does a Claude Code
  // line without usage; counted, they pulled the median down (to 0 for a
  // Codex session, leaving the ratio n/a). The WHERE repeats the expression:
  // reading the ctx alias there is a SQLite extension, not standard SQL.
  // session_id/ts ride along so a caller can find which turn the max was,
  // not just the ratio.
  const ctxRows = db
    .prepare(
      `SELECT e.session_id, e.ts,
              CASE WHEN s.source = 'codex' THEN e.in_tok
                   ELSE e.in_tok + e.cache_r + e.cache_w END AS ctx
       FROM event e LEFT JOIN session s ON s.id = e.session_id
       WHERE e.role = 'assistant' AND ${eventScope.sql}
         AND (CASE WHEN s.source = 'codex' THEN e.in_tok
                   ELSE e.in_tok + e.cache_r + e.cache_w END) > 0
       ORDER BY ctx`,
    )
    .all(...eventScope.binds) as Array<{ session_id: string; ts: string; ctx: number }>;
  let bloat: number | null = null;
  let bloatDetail: HealthFacts["context_bloat_detail"] = null;
  if (ctxRows.length >= 4) {
    const maxRow = ctxRows[ctxRows.length - 1]!;
    const medianCtx = ctxRows[Math.floor(ctxRows.length / 2)]!.ctx;
    if (medianCtx > 0) {
      bloat = Number((maxRow.ctx / medianCtx).toFixed(2));
      bloatDetail = {
        max_ctx: maxRow.ctx,
        median_ctx: medianCtx,
        sample_size: ctxRows.length,
        max_session_id: maxRow.session_id,
        max_ts: maxRow.ts,
      };
    }
  }

  return {
    tool_errors: toolErrors,
    compaction_events: compactions + summaryOnly,
    context_bloat_ratio: bloat,
    context_bloat_detail: bloatDetail,
  };
}
