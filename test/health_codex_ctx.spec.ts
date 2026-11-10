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
});
