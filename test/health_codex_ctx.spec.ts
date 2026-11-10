import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { analyzeHealth } from "../src/analyzer/health.js";
import { applySchema } from "../src/indexer/schema.js";

// Codex's input_tokens is the whole prompt and cached_input_tokens a part of
// it, which the parser stores as in_tok and cache_r. Claude Code reports the
// cache reads and writes apart from input_tokens.
function db(): Database.Database {
  const d = new Database(":memory:");
  applySchema(d);
  d.exec(`
    INSERT INTO session (id, project_id, kind, source) VALUES
      ('cx', '-p', 'interactive', 'codex'),
      ('cc', '-p', 'interactive', 'claude');
    INSERT INTO event (uuid, session_id, ts, role, in_tok, cache_r, cache_w) VALUES
      ('x1', 'cx', '2026-07-01T00:00:01.000Z', 'assistant', 100, 90, 0),
      ('x2', 'cx', '2026-07-01T00:00:02.000Z', 'assistant', 200, 180, 0),
      ('x3', 'cx', '2026-07-01T00:00:03.000Z', 'assistant', 300, 270, 0),
      ('x4', 'cx', '2026-07-01T00:00:04.000Z', 'assistant', 400, 360, 0),
      ('c1', 'cc', '2026-07-01T00:00:01.000Z', 'assistant', 10, 100, 10),
      ('c2', 'cc', '2026-07-01T00:00:02.000Z', 'assistant', 10, 200, 10),
      ('c3', 'cc', '2026-07-01T00:00:03.000Z', 'assistant', 10, 300, 10),
      ('c4', 'cc', '2026-07-01T00:00:04.000Z', 'assistant', 10, 400, 10);
  `);
  return d;
}

describe("context size", () => {
  it("counts a Codex turn's cached input once, as part of its input", () => {
    const detail = analyzeHealth(db(), { mode: "session", params: { session_id: "cx" } }).context_bloat_detail;
    expect(
      { max_ctx: detail?.max_ctx, median_ctx: detail?.median_ctx },
      "Codex context size",
    ).toEqual({ max_ctx: 400, median_ctx: 300 });
  });

  it("adds a Claude Code turn's cache reads and writes to its input", () => {
    const detail = analyzeHealth(db(), { mode: "session", params: { session_id: "cc" } }).context_bloat_detail;
    expect({ max_ctx: detail?.max_ctx, median_ctx: detail?.median_ctx }).toEqual({ max_ctx: 420, median_ctx: 320 });
  });

  it("puts Codex and Claude Code turns on the same scale in a project", () => {
    const detail = analyzeHealth(db(), { mode: "project", params: { project_id: "-p" } }).context_bloat_detail;
    expect(
      { max_ctx: detail?.max_ctx, max_session_id: detail?.max_session_id },
      "largest context in a project with Codex and Claude Code",
    ).toEqual({ max_ctx: 420, max_session_id: "cc" });
  });

  // A Codex turn writes its token counts on one event (its task_complete);
  // its replies and tool calls carry none, so most Codex assistant events
  // have in_tok 0. Counted as context size 0, they made the median 0 and the
  // ratio n/a for a Codex session.
  it("leaves out assistant events that carry no token counts", () => {
    const d = db();
    d.exec(`
      INSERT INTO session (id, project_id, kind, source) VALUES ('cz', '-q', 'interactive', 'codex');
      INSERT INTO event (uuid, session_id, ts, role, in_tok, cache_r, cache_w) VALUES
        ('z1', 'cz', '2026-07-01T00:00:01.000Z', 'assistant', 0, 0, 0),
        ('z2', 'cz', '2026-07-01T00:00:02.000Z', 'assistant', 0, 0, 0),
        ('z3', 'cz', '2026-07-01T00:00:03.000Z', 'assistant', 100, 90, 0),
        ('z4', 'cz', '2026-07-01T00:00:04.000Z', 'assistant', 0, 0, 0),
        ('z5', 'cz', '2026-07-01T00:00:05.000Z', 'assistant', 0, 0, 0),
        ('z6', 'cz', '2026-07-01T00:00:06.000Z', 'assistant', 200, 180, 0),
        ('z7', 'cz', '2026-07-01T00:00:07.000Z', 'assistant', 0, 0, 0),
        ('z8', 'cz', '2026-07-01T00:00:08.000Z', 'assistant', 300, 270, 0),
        ('z9', 'cz', '2026-07-01T00:00:09.000Z', 'assistant', 0, 0, 0),
        ('za', 'cz', '2026-07-01T00:00:10.000Z', 'assistant', 400, 360, 0);
    `);
    const facts = analyzeHealth(d, { mode: "session", params: { session_id: "cz" } });
    expect(
      { ratio: facts.context_bloat_ratio, ...facts.context_bloat_detail },
      "context size of a Codex session with token-less events",
    ).toEqual({ ratio: 1.33, max_ctx: 400, median_ctx: 300, sample_size: 4, max_session_id: "cz", max_ts: "2026-07-01T00:00:10.000Z" });
  });
});
