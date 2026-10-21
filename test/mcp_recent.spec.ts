import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { applySchema } from "../src/indexer/schema.js";
import {
  recentUserText,
  formatResults,
  DEFAULT_RECENT_MAX_BYTES,
  MAX_ROW_BYTES,
  type RecentResult,
} from "../src/mcp/recent.js";

function openMem(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seed(db: Database.Database): void {
  db.exec(`
    INSERT INTO project (id, cwd) VALUES ('proj-a', '/a'), ('proj-b', '/b');
    INSERT INTO session (id, project_id, started_at) VALUES
      ('s1', 'proj-a', '2026-06-01T10:00:00Z'),
      ('s2', 'proj-a', '2026-06-15T10:00:00Z'),
      ('s3', 'proj-b', '2026-06-20T10:00:00Z');
    INSERT INTO event (uuid, session_id, ts, role) VALUES
      ('e1', 's1', '2026-06-01T10:00:00Z', 'user'),
      ('e2', 's2', '2026-06-15T10:00:00Z', 'user'),
      ('e3', 's3', '2026-06-20T10:00:00Z', 'user');
    INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
      ('e1', 's1', '2026-06-01T10:00:00Z', '로그인 버그 고쳐줘'),
      ('e2', 's2', '2026-06-15T10:00:00Z', '인증 토큰 만료 처리'),
      ('e3', 's3', '2026-06-20T10:00:00Z', '로그인 버그 재현됨');
  `);
}

describe("mcp/recent.ts — optional query filter", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    seed(db);
  });

  it("without query, returns all rows in the range ordered by ts DESC (unchanged behavior)", () => {
    const results = recentUserText(db, { project_id: "proj-a" });
    expect(results.map((r) => r.session_id)).toEqual(["s2", "s1"]);
  });

  it("with query, narrows to rows whose text contains the keyword via LIKE, still ts DESC", () => {
    const results = recentUserText(db, { project_id: "proj-a", query: "로그인" });
    expect(results.map((r) => r.session_id)).toEqual(["s1"]);
  });

  it("query combines with since/until as an additional AND condition", () => {
    const results = recentUserText(db, {
      project_id: "proj-b",
      query: "재현",
      since: "2026-06-01T00:00:00Z",
    });
    expect(results.map((r) => r.session_id)).toEqual(["s3"]);
  });

  it("query with no match returns empty, not an error", () => {
    const results = recentUserText(db, { project_id: "proj-a", query: "존재하지않는단어" });
    expect(results).toEqual([]);
  });

  it("query also matches the reply shown with a message, not only the user's own words", () => {
    db.exec(`
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('e9', 's2', '2026-06-15T10:00:05Z', 'assistant');
      INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES
        ('e9', 's2', '2026-06-15T10:00:05Z', 'Redis 캐시 TTL을 30초로 줄였습니다', 'assistant', 'assistant_message');
    `);
    const results = recentUserText(db, { project_id: "proj-a", query: "TTL" });
    expect(results.map((r) => [r.session_id, r.assistant_response])).toEqual([["s2", "Redis 캐시 TTL을 30초로 줄였습니다"]]);
  });

  it("command messages are listed for what was typed after the command", () => {
    db.exec(`
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('c1', 's1', '2026-06-02T10:00:00Z', 'user'),
        ('c2', 's1', '2026-06-03T10:00:00Z', 'user'),
        ('c3', 's1', '2026-06-04T10:00:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text, is_command) VALUES
        ('c1', 's1', '2026-06-02T10:00:00Z', 'src/app/main.ts 리뷰 부탁', 1),
        ('c2', 's1', '2026-06-03T10:00:00Z', '', 1),
        ('c3', 's1', '2026-06-04T10:00:00Z', '<command-message>review<> <command-name><> <command-args>app.ts<>', 1);
    `);
    const ts = recentUserText(db, { project_id: "proj-a", since: "2026-06-02T00:00:00Z", until: "2026-06-05T00:00:00Z" }).map((r) => r.ts);
    expect(ts).toEqual(["2026-06-02T10:00:00Z"]);
  });

  it("lists only what the user wrote: no subagent prompt, exec run, task notification or teammate message", () => {
    db.exec(`
      INSERT INTO session (id, project_id, started_at, kind, parent_id) VALUES
        ('agent-x', 'proj-a', '2026-06-16T10:00:00Z', 'subagent', 's2'),
        ('x1', 'proj-a', '2026-06-16T11:00:00Z', 'exec', NULL);
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('a1', 'agent-x', '2026-06-16T10:00:00Z', 'user'),
        ('x2', 'x1', '2026-06-16T11:00:00Z', 'user'),
        ('n1', 's2', '2026-06-16T12:00:00Z', 'user'),
        ('t1', 's2', '2026-06-16T12:01:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('a1', 'agent-x', '2026-06-16T10:00:00Z', 'Read-only research. Report at most 8 items.'),
        ('x2', 'x1', '2026-06-16T11:00:00Z', 'Read-only benchmark prompt'),
        ('n1', 's2', '2026-06-16T12:00:00Z', '<task-notification><status>completed</status> Read-only</task-notification>'),
        ('t1', 's2', '2026-06-16T12:01:00Z', 'Another Claude session sent a message:
<teammate-message teammate_id="rA-judgment">Read-only findings saved</teammate-message>');
    `);
    expect(recentUserText(db, { project_id: "proj-a" }).map((r) => r.session_id)).toEqual(["s2", "s1"]);
    expect(recentUserText(db, { project_id: "proj-a", query: "Read-only" })).toEqual([]);
  });

  it("a later reply in the turn matches too, and is the one shown", () => {
    db.exec(`
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e8', 's2', '2026-06-15T10:00:03Z', 'assistant'),
        ('e9', 's2', '2026-06-15T10:00:09Z', 'assistant');
      INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES
        ('e8', 's2', '2026-06-15T10:00:03Z', '확인해 보겠습니다', 'assistant', 'assistant_message'),
        ('e9', 's2', '2026-06-15T10:00:09Z', '원인은 writableEvents 가 빠진 것이었습니다', 'assistant', 'assistant_message');
    `);
    const results = recentUserText(db, { project_id: "proj-a", query: "writableEvents" });
    expect(results.map((r) => [r.session_id, r.assistant_response])).toEqual([["s2", "원인은 writableEvents 가 빠진 것이었습니다"]]);
    // Without a query the first reply is still the one shown.
    expect(recentUserText(db, { project_id: "proj-a" })[0]!.assistant_response).toBe("확인해 보겠습니다");
  });
});

/**
 * Regression: the "next assistant reply" lookup found the nearest assistant
 * row after a matched user row's ts with no check for another user message
 * in between. Two back-to-back user turns with no reply between them (e.g.
 * a resent/expanded question) both independently satisfied that lookup and
 * ended up pointing at the very same later assistant row, so the same reply
 * text was attached — and thus duplicated — across two different results.
 */
describe("mcp/recent.ts — back-to-back user turns do not double-pair the same reply", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', 'user'),
        ('e2', 's1', '2026-06-01T10:00:30Z', 'user'),
        ('e3', 's1', '2026-06-01T10:01:00Z', 'assistant');
      INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', '인증 문제 있어요', 'user', 'user_message'),
        ('e2', 's1', '2026-06-01T10:00:30Z', '인증 문제 있어요 다시 말할게요', 'user', 'user_message'),
        ('e3', 's1', '2026-06-01T10:01:00Z', '확인했습니다 고쳤어요', 'assistant', 'assistant_message');
    `);
  });

  it("a resent question with no reply between the two turns leaves the earlier turn's assistant_response null", () => {
    const results = recentUserText(db, { project_id: "proj-a" });
    const first = results.find((r) => r.ts === "2026-06-01T10:00:00Z")!;
    const second = results.find((r) => r.ts === "2026-06-01T10:00:30Z")!;
    expect(first.assistant_response).toBeNull();
    expect(second.assistant_response).toBe("확인했습니다 고쳤어요");
  });
});

/**
 * formatResults applies a total-byte budget by dropping the OLDEST rows
 * (results arrive ts DESC) while keeping every emitted message body WHOLE —
 * recent's contract is full messages, not snippets, so a body is never
 * truncated mid-text. This is what bounds the response so a window with a few
 * huge pasted messages can no longer blow the caller's context.
 */
describe("mcp/recent.ts — formatResults byte budget", () => {
  function row(ts: string, text: string, assistant: string | null = null): RecentResult {
    return { session_id: "s1", ts, text, assistant_response: assistant };
  }

  it("empty results return the sentinel, no footer", () => {
    expect(formatResults([])).toBe("No results found.");
  });

  it("under budget: emits every row in order with no '+N more' footer", () => {
    const out = formatResults([row("2026-06-02T00:00:00Z", "second"), row("2026-06-01T00:00:00Z", "first")]);
    expect(out).toContain("[1]");
    expect(out).toContain("[2]");
    expect(out).toContain("second");
    expect(out).toContain("first");
    expect(out).not.toContain("more not shown");
  });

  it("over budget: keeps the most-recent rows whole and reports the dropped tail", () => {
    const big = "X".repeat(400);
    const rows = [
      row("2026-06-05T00:00:00Z", "A" + big),
      row("2026-06-04T00:00:00Z", "B" + big),
      row("2026-06-03T00:00:00Z", "C" + big),
      row("2026-06-02T00:00:00Z", "D" + big),
    ];
    const out = formatResults(rows, 700); // fits ~1 row of ~400+ bytes
    expect(out).toContain("A" + big); // most-recent body kept intact, untruncated
    expect(out).not.toContain("D" + big); // oldest dropped
    expect(out).toMatch(/\(\+\d+ more not shown/);
  });

  it("always emits the most-recent row even if it alone exceeds the budget", () => {
    const huge = "Y".repeat(5000);
    const out = formatResults([row("2026-06-02T00:00:00Z", huge), row("2026-06-01T00:00:00Z", "old")], 256);
    expect(out).toContain(huge); // top row emitted whole despite exceeding maxBytes
    expect(out).toContain("(+1 more not shown");
  });

  it("default budget is DEFAULT_RECENT_MAX_BYTES", () => {
    // A single row well under the default is emitted with no footer.
    const out = formatResults([row("2026-06-01T00:00:00Z", "small")]);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(DEFAULT_RECENT_MAX_BYTES);
    expect(out).not.toContain("more not shown");
  });
});

/**
 * Row-level hardening: the total-byte budget always emits the most-recent row,
 * so a single message larger than MAX_ROW_BYTES is the one case the budget
 * can't contain. That row's body is truncated (never emitted whole) with a
 * clens_session pointer, guaranteeing the response can never blow the MCP
 * ceiling — while ordinary large messages still pass through whole.
 */
describe("mcp/recent.ts — single oversized row is truncated, not dropped", () => {
  function row(ts: string, text: string, assistant: string | null = null): RecentResult {
    return { session_id: "s1", ts, text, assistant_response: assistant };
  }

  it("a single row over MAX_ROW_BYTES is truncated to fit, with a clens_session marker", () => {
    const huge = "X".repeat(MAX_ROW_BYTES + 20000);
    const out = formatResults([row("2026-06-01T00:00:00Z", huge)]);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_ROW_BYTES);
    expect(out).toContain("truncated");
    expect(out).toContain("clens_session");
    expect(out).not.toContain(huge); // full body NOT emitted whole
    expect(out).toContain(`session:s1`); // header (id) survives → still chainable
  });

  it("the omitted-char count in the marker is accurate", () => {
    const huge = "Y".repeat(MAX_ROW_BYTES + 5000);
    const out = formatResults([row("2026-06-01T00:00:00Z", huge)]);
    const m = out.match(/truncated (\d+) chars/);
    expect(m).not.toBeNull();
    const omitted = Number(m![1]);
    // kept chars = original 'Y' count minus omitted; the kept 'Y's must still be present
    const keptYs = (out.match(/Y+/)![0] || "").length;
    expect(keptYs).toBe(huge.length - omitted);
  });

  it("an ordinary large message under MAX_ROW_BYTES is kept WHOLE (no truncation)", () => {
    // 40KB is above the default maxBytes but below MAX_ROW_BYTES → emitted intact
    // as the most-recent row (always emitted), proving normal messages aren't cut.
    const big = "Z".repeat(40000);
    const out = formatResults([row("2026-06-01T00:00:00Z", big)]);
    expect(out).toContain(big);
    expect(out).not.toContain("truncated");
  });

  it("truncation never splits a multi-byte character", () => {
    // All 3-byte chars: a byte-naive cut could land mid-character.
    const huge = "가".repeat(MAX_ROW_BYTES); // > MAX_ROW_BYTES bytes (3 bytes each)
    const out = formatResults([row("2026-06-01T00:00:00Z", huge)]);
    // Round-trips cleanly (no replacement char from a broken code unit).
    expect(out).toBe(Buffer.from(out, "utf8").toString("utf8"));
    expect(out).not.toContain("�");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_ROW_BYTES);
  });
});
