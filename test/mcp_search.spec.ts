import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applySchema } from "../src/indexer/schema.js";
import { searchUserText, searchWithTotal, formatSearchResults, notNoise, DEFAULT_SEARCH_MAX_BYTES, searchText, searchManyText } from "../src/mcp/search.js";
import { neighborsOf } from "../src/mcp/session.js";
import { registerLanguage, resetLanguageRegistry } from "../src/indexer/lang/registry.js";
import { UTC_TIME, withTz } from "./tz.js";

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
      ('e3', 's3', '2026-06-20T10:00:00Z', 'user'),
      ('e4', 's1', '2026-06-01T11:00:00Z', 'user');
    INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
      ('e1', 's1', '2026-06-01T10:00:00Z', '인증 미들웨어 리팩토링해줘'),
      ('e2', 's2', '2026-06-15T10:00:00Z', '인증 토큰 만료 처리 어떻게 해'),
      ('e3', 's3', '2026-06-20T10:00:00Z', '데이터베이스 마이그레이션 작업'),
      ('e4', 's1', '2026-06-01T11:00:00Z', '아니 그게 아니고 인증 빼줘');
  `);
}

describe("mcp/search.ts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    seed(db);
  });

  it("FTS5 table exists and is populated via trigger", () => {
    const rows = db.prepare("SELECT count(*) AS n FROM user_text_fts").get() as { n: number };
    expect(rows.n).toBe(4);
  });

  it("returns matching rows for a keyword", () => {
    const results = searchUserText(db, { query: "인증" });
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.snippet).toMatch(/인증/);
    }
  });

  it("filters by project_id", () => {
    const results = searchUserText(db, { query: "인증", project_id: "proj-b" });
    expect(results.length).toBe(0);

    const results2 = searchUserText(db, { query: "인증", project_id: "proj-a" });
    expect(results2.length).toBe(3);
    expect(results2.every((r) => r.project_id === "proj-a")).toBe(true);
  });

  it("filters by session_id, the named session only", () => {
    const results = searchUserText(db, { query: "인증", session_id: "s1" });
    expect(results.map((r) => r.session_id)).toEqual(["s1", "s1"]);
    db.exec(`
      INSERT INTO session (id, project_id, kind, parent_id) VALUES ('agent-x', 'proj-a', 'subagent', 's1');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('e9', 'agent-x', '2026-06-01T10:30:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES ('e9', 'agent-x', '2026-06-01T10:30:00Z', '인증 코드 검토');
    `);
    expect(searchUserText(db, { query: "인증", session_id: "s1" })).toHaveLength(2);
    expect(searchUserText(db, { query: "인증", session_id: "s1", project_id: "proj-b" })).toHaveLength(0);
  });

  it("searches a named session whatever its kind, copied lines included", () => {
    db.exec(`
      INSERT INTO session (id, project_id, kind) VALUES ('run', 'proj-a', 'exec'), ('resumed', 'proj-a', 'interactive');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('x1', 'run', '2026-06-02T10:00:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('x1', 'run', '2026-06-02T10:00:00Z', '벤치마크 실행'),
        ('e1', 'resumed', '2026-06-01T10:00:00Z', '인증 미들웨어 리팩토링해줘');
    `);
    expect(searchUserText(db, { query: "벤치마크" })).toHaveLength(0);
    expect(searchUserText(db, { query: "벤치마크", session_id: "run" }).map((r) => r.session_id)).toEqual(["run"]);
    // e1's event row belongs to s1, so the copy in "resumed" is found only there.
    expect(searchUserText(db, { query: "미들웨어" }).map((r) => r.session_id)).toEqual(["s1"]);
    expect(searchUserText(db, { query: "미들웨어", session_id: "resumed" }).map((r) => r.session_id)).toEqual(["resumed"]);
  });

  it("filters by since", () => {
    const results = searchUserText(db, { query: "인증", since: "2026-06-10T00:00:00Z" });
    expect(results.length).toBe(1);
    expect(results[0]?.session_id).toBe("s2");
  });

  it("respects limit", () => {
    const results = searchUserText(db, { query: "인증", limit: 1 });
    expect(results.length).toBe(1);
  });

  it("caps limit at 100", () => {
    const results = searchUserText(db, { query: "인증", limit: 9999 });
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it("returns empty array for no match", () => {
    const results = searchUserText(db, { query: "xyzzy_no_match" });
    expect(results).toEqual([]);
  });

  it("result shape has required fields", () => {
    const results = searchUserText(db, { query: "마이그레이션" });
    expect(results.length).toBe(1);
    const r = results[0]!;
    expect(r).toHaveProperty("session_id");
    expect(r).toHaveProperty("project_id");
    expect(r).toHaveProperty("ts");
    expect(r).toHaveProperty("role");
    expect(r).toHaveProperty("snippet");
    expect(r).toHaveProperty("score");
    // Full original text and the paired assistant reply are intentionally NOT
    // in the search result — they are fetched lazily via clens_session.
    expect(r).not.toHaveProperty("text");
    expect(r).not.toHaveProperty("assistant_response");
    expect(typeof r.score).toBe("number");
  });

  it("FTS5 trigger removes rows on user_text delete", () => {
    db.exec(`DELETE FROM user_text WHERE session_id = 's1'`);
    const count = db.prepare("SELECT count(*) AS n FROM user_text_fts").get() as { n: number };
    expect(count.n).toBe(2);
  });
});

/**
 * Regression: sanitizeTrigramQuery used to silently DROP words under 3
 * Unicode codepoints from the trigram MATCH expression (the trigram
 * tokenizer's minimum unit). For a mixed-length multi-word query like
 * "skill 사용", the trigram layer degraded to matching "skill" ALONE,
 * so rows containing "skill" but not "사용" were still returned via RRF
 * fusion as if they matched the full two-word query.
 *
 * Fix: short words are enforced via `text LIKE '%word%'` against the same
 * trigram table instead of being dropped (SQLite's trigram tokenizer
 * explicitly supports LIKE as an index-accelerated path — fts5.html §4.3.4).
 */
describe("mcp/search.ts — short-word (<3 codepoint) AND enforcement", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES
        ('s1', 'proj-a', '2026-06-01T10:00:00Z'),
        ('s2', 'proj-a', '2026-06-02T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', 'user'),
        ('e2', 's2', '2026-06-02T10:00:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', 'skill 사용법 좀 확인해줘'),
        ('e2', 's2', '2026-06-02T10:00:00Z', 'skill 관련 문서 찾아줘');
    `);
  });

  it("a two-word query with one short word (사용, 2 codepoints) excludes rows missing that word", () => {
    // e1 has both "skill" and "사용" (inside 사용법). e2 has "skill" but no "사용" anywhere.
    const results = searchUserText(db, { query: "skill 사용" });
    expect(results.length).toBe(1);
    expect(results[0]!.session_id).toBe("s1");
  });

  it("does not regress: a single long-word query still matches both rows sharing that word", () => {
    const results = searchUserText(db, { query: "skill" });
    expect(results.length).toBe(2);
  });

  it("a query where EVERY word is short (<3 codepoints) still returns matches via LIKE fallback, not silently empty", () => {
    // "사용" alone (2 codepoints) — matchExpr would be empty; must not early-return [].
    const results = searchUserText(db, { query: "사용" });
    expect(results.length).toBe(1);
    expect(results[0]!.session_id).toBe("s1");
  });
});

/**
 * Regression: sanitizeQuery used to strip quotes and drop NOT/AND/OR tokens
 * entirely, silently degrading "login NOT bug" into "login AND bug" (the
 * opposite of what was asked) and "\"exact phrase\"" into two independently
 * AND'd words (matching non-adjacent, out-of-order occurrences). The tool's
 * own description promises phrase/NOT/OR support, so this was a documented
 * capability that actively inverted results rather than just being missing.
 */
describe("mcp/search.ts — NOT / OR / phrase FTS5 operators", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', 'user'),
        ('e2', 's1', '2026-06-01T10:01:00Z', 'user'),
        ('e3', 's1', '2026-06-01T10:02:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', '로그인 성공 케이스 테스트'),
        ('e2', 's1', '2026-06-01T10:01:00Z', '로그인 버그 재현됨'),
        ('e3', 's1', '2026-06-01T10:02:00Z', '결제 버그 있음');
    `);
  });

  it("NOT excludes rows containing the negated term, even though it shares the positive term", () => {
    const results = searchUserText(db, { query: "로그인 NOT 버그" });
    expect(results.map((r) => r.snippet)).toEqual(["로그인 성공 케이스 테스트"]);
  });

  it("OR returns the union of either term", () => {
    const results = searchUserText(db, { query: "테스트 OR 결제" });
    const texts = results.map((r) => r.snippet).sort();
    expect(texts).toEqual(["결제 버그 있음", "로그인 성공 케이스 테스트"].sort());
  });

  it("OR keeps what each word alone finds as part of a longer word", () => {
    db.exec(`
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e5', 's1', '2026-06-01T10:04:00Z', 'user'),
        ('e6', 's1', '2026-06-01T10:05:00Z', 'user'),
        ('e7', 's1', '2026-06-01T10:06:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('e5', 's1', '2026-06-01T10:04:00Z', 'we need preauthentication here'),
        ('e6', 's1', '2026-06-01T10:05:00Z', 'run the postmigration step'),
        ('e7', 's1', '2026-06-01T10:06:00Z', 'mydb is down');
    `);
    const found = (query: string) => searchUserText(db, { query }).map((r) => r.snippet).sort();
    expect(found("authentication")).toEqual(["we need preauthentication here"]);
    expect(found("authentication OR migration")).toEqual(["run the postmigration step", "we need preauthentication here"]);
    // A word under three characters is found inside a longer word on its own
    // (LIKE), but not under OR: a LIKE per group scanned the table each time.
    expect(found("db")).toEqual(["mydb is down"]);
    expect(found("db OR migration")).toEqual(["run the postmigration step"]);
  });

  it("exact phrase requires adjacency, not just both words present anywhere", () => {
    const results = searchUserText(db, { query: '"로그인 버그"' });
    expect(results.map((r) => r.snippet)).toEqual(["로그인 버그 재현됨"]);
  });

  it("phrase query does not match the same two words out of order/non-adjacent", () => {
    db.exec(`
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('e4', 's1', '2026-06-01T10:03:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('e4', 's1', '2026-06-01T10:03:00Z', '버그 때문에 어제부터 로그인이 안됨');
    `);
    const results = searchUserText(db, { query: '"로그인 버그"' });
    expect(results.map((r) => r.snippet)).toEqual(["로그인 버그 재현됨"]);
  });

  // Regression: a snippet shows each run of whitespace as one space, and a
  // phrase copied from it found nothing where the message breaks the line.
  it("a phrase matches across a line break or a double space, as a snippet shows it", () => {
    db.exec("INSERT INTO event (uuid, session_id, ts, role) VALUES ('e4', 's1', '2026-06-01T10:03:00Z', 'user')");
    db.prepare("INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES ('e4', 's1', '2026-06-01T10:03:00Z', ?)")
      .run(`${"앞부분 ".repeat(60)}말이 많네 \n\n색인  먼저 하라는거`);

    const results = searchUserText(db, { query: '"많네 색인 먼저"' });
    expect(results).toHaveLength(1);
    expect(results[0]!.snippet).toContain("말이 많네 색인 먼저 하라는거");
    expect(searchUserText(db, { query: '하라는거 NOT "많네 색인"' })).toEqual([]);
  });

  // Regression: a negated word was compared in its cleaned form, so one with
  // a ":" or brackets ("https //x", "foobar") never matched the message.
  it("NOT excludes a word with punctuation, as written", () => {
    db.exec(`
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e4', 's1', '2026-06-01T10:03:00Z', 'user'),
        ('e5', 's1', '2026-06-01T10:04:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('e4', 's1', '2026-06-01T10:03:00Z', '배포 문서는 https://example.com/deploy 에 있음'),
        ('e5', 's1', '2026-06-01T10:04:00Z', '배포 전에 foo(bar) 호출 확인');
    `);
    const found = (query: string) => searchUserText(db, { query }).map((r) => r.snippet);
    expect(found("배포 NOT https://example.com/deploy")).toEqual(["배포 전에 foo(bar) 호출 확인"]);
    expect(found('배포 NOT "https://example.com/deploy"')).toEqual(["배포 전에 foo(bar) 호출 확인"]);
    expect(found("배포 NOT foo(bar)")).toEqual(["배포 문서는 https://example.com/deploy 에 있음"]);
    // A prefix still excludes what starts with it, as before.
    expect(found("배포 NOT exampl*")).toEqual(["배포 전에 foo(bar) 호출 확인"]);
  });
});

/**
 * clens_search runs both user and assistant layers (for RRF), so a match may
 * be user- or assistant-authored. SearchResult carries a `role` field so the
 * formatter labels each hit correctly (a match found only in an assistant
 * message must read "Assistant:", not "User:"). The former next-assistant-reply
 * enrichment was removed with the find/read split (Task 1) — every matching
 * row now surfaces on its own with a snippet of its own text; the surrounding
 * conversation is fetched via clens_session.
 */
describe("mcp/search.ts — role labeling for assistant-authored matches", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', 'user'),
        ('e2', 's1', '2026-06-01T10:01:00Z', 'assistant'),
        ('e3', 's1', '2026-06-01T10:02:00Z', 'user'),
        ('e4', 's1', '2026-06-01T10:03:00Z', 'assistant');
      INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', '로그인 문제 있어', 'user', 'user_message'),
        ('e2', 's1', '2026-06-01T10:01:00Z', '고유키워드제타789로 원인을 찾았습니다', 'assistant', 'assistant_message'),
        ('e3', 's1', '2026-06-01T10:02:00Z', '오 그렇구나 고마워', 'user', 'user_message'),
        ('e4', 's1', '2026-06-01T10:03:00Z', '천만에요 추가로 확인할까요', 'assistant', 'assistant_message');
    `);
  });

  it("a match found only in an assistant message is labeled role: assistant with a snippet of its own text", () => {
    const results = searchUserText(db, { query: "고유키워드제타789" });
    expect(results.length).toBe(1);
    expect(results[0]!.role).toBe("assistant");
    expect(results[0]!.snippet).toContain("고유키워드제타789");
  });

  it("a match found in a user message returns role: user with a snippet of the user text (no paired reply)", () => {
    const results = searchUserText(db, { query: "로그인 문제" });
    expect(results.length).toBe(1);
    expect(results[0]!.role).toBe("user");
    expect(results[0]!.snippet).toContain("로그인 문제");
    // The assistant reply is no longer attached to the search result — it is
    // reachable via clens_session, not duplicated into every matching row.
    expect(results[0]!.snippet).not.toContain("고유키워드제타789");
  });
});

/**
 * Recall guarantee: two back-to-back user turns that both match are each
 * returned as their own result. (Before the find/read split this file also
 * guarded against the two turns double-pairing the same assistant reply; that
 * enrichment is gone, so there is no reply to mispair — only the "both turns
 * surface" guarantee remains relevant.)
 */
describe("mcp/search.ts — back-to-back matching user turns each surface independently", () => {
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

  it("both matching user turns are returned, each as its own user-role snippet", () => {
    const results = searchUserText(db, { query: "인증" });
    expect(results.length).toBe(2);
    const first = results.find((r) => r.ts === "2026-06-01T10:00:00Z")!;
    const second = results.find((r) => r.ts === "2026-06-01T10:00:30Z")!;
    expect(first.role).toBe("user");
    expect(second.role).toBe("user");
    expect(first.snippet).toContain("인증");
    expect(second.snippet).toContain("인증");
    // The assistant turn "확인했습니다 고쳤어요" is not folded into either result.
    expect(first.snippet).not.toContain("확인했습니다");
    expect(second.snippet).not.toContain("확인했습니다");
  });
});

/**
 * With the find/read split, both user and assistant rows are searched
 * independently and every matching row surfaces on its own — there is no
 * paired-reply enrichment, so an assistant message that matches the query
 * always appears as its own standalone hit (rather than being hidden because
 * it was some question's embedded reply). Each matching row appears exactly
 * once, keyed by its rowid, so there is no duplication risk either.
 */
describe("mcp/search.ts — every matching row surfaces once, on its own", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', 'user'),
        ('e2', 's1', '2026-06-01T10:01:00Z', 'assistant'),
        ('e3', 's1', '2026-06-01T10:02:00Z', 'user'),
        ('e4', 's1', '2026-06-01T10:03:00Z', 'assistant');
      INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', '가이드 문서 찾아줘', 'user', 'user_message'),
        ('e2', 's1', '2026-06-01T10:01:00Z', '가이드 문서 여기 있습니다', 'assistant', 'assistant_message'),
        ('e3', 's1', '2026-06-01T10:02:00Z', '오늘 날씨 어때', 'user', 'user_message'),
        ('e4', 's1', '2026-06-01T10:03:00Z', '가이드라인 알려드릴게요', 'assistant', 'assistant_message');
    `);
  });

  it("all three rows containing the term surface, each exactly once with its own role", () => {
    const results = searchUserText(db, { query: "가이드" });
    // e1 (user), e2 (assistant), e4 (assistant) all contain 가이드; e3 does not.
    expect(results.length).toBe(3);
    const byTs = new Map(results.map((r) => [r.ts, r]));
    expect(byTs.get("2026-06-01T10:00:00Z")?.role).toBe("user");
    expect(byTs.get("2026-06-01T10:01:00Z")?.role).toBe("assistant");
    expect(byTs.get("2026-06-01T10:03:00Z")?.role).toBe("assistant");
    // No row is duplicated.
    expect(new Set(results.map((r) => r.ts)).size).toBe(3);
  });

  it("an assistant message that matches is no longer hidden as another row's embedded reply", () => {
    const results = searchUserText(db, { query: "가이드" });
    const embedded = results.find((r) => r.ts === "2026-06-01T10:01:00Z");
    expect(embedded).toBeDefined();
    expect(embedded?.role).toBe("assistant");
    expect(embedded?.snippet).toContain("가이드");
  });
});

/**
 * Language-layer acceptance criteria (see indexer/lang/registry.ts). Uses a
 * fake adapter (not the real kiwi-nlp analyzer — that's proven separately in
 * lang_ko_real.spec.ts, skipped when the real model fixture isn't present)
 * to verify search.ts's own layer-building/RRF-fusion logic in isolation.
 * With no adapter registered at all (the default state, "not installed"),
 * this layer is never queried — proven by the untouched tests above passing
 * unchanged throughout this file.
 */
describe("mcp/search.ts — language layer (criteria a & b)", () => {
  afterEach(() => {
    resetLanguageRegistry();
  });

  it("(a) a particle-attached query returns the identical result set as the bare-word query", () => {
    registerLanguage({
      code: "ko",
      detect: (t) => /[가-힣]/.test(t),
      tokenize: (t) => (t.replace(/[을를]$/, "") === "리팩토링" ? ["리팩토링"] : []),
    });
    const db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', '리팩토링 완료했습니다');
      INSERT INTO user_text_fts_lang_ko (rowid, text, session_id, ts)
        VALUES ((SELECT rowid FROM user_text WHERE event_uuid = 'e1'), '리팩토링', 's1', '2026-06-01T10:00:00Z');
    `);

    const withParticle = searchUserText(db, { query: "리팩토링을" });
    const bare = searchUserText(db, { query: "리팩토링" });
    expect(withParticle.map((r) => r.snippet)).toEqual(bare.map((r) => r.snippet));
    expect(withParticle.length).toBe(1);
  });

  it("(b) a row backed by both trigram and the language layer outranks a row the trigram layer alone would tie with it", () => {
    registerLanguage({
      code: "ko",
      detect: (t) => /[가-힣]/.test(t),
      tokenize: (t) => (t.includes("리팩토링") ? ["리팩토링"] : []),
    });
    const db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', 'user'),
        ('e2', 's1', '2026-06-01T10:00:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', '리팩토링 완료했습니다'),
        ('e2', 's1', '2026-06-01T10:00:00Z', '리팩토링 진행 중입니다');
      INSERT INTO user_text_fts_lang_ko (rowid, text, session_id, ts)
        VALUES ((SELECT rowid FROM user_text WHERE event_uuid = 'e1'), '리팩토링', 's1', '2026-06-01T10:00:00Z');
    `);
    // e2 has no language-layer row — only the trigram/porter layers back it,
    // same as before any language support existed.

    const results = searchUserText(db, { query: "리팩토링" });
    expect(results.length).toBe(2);
    expect(results[0]?.snippet).toBe("리팩토링 완료했습니다");
  });

  it("a query with no Hangul never touches the ko layer even when an adapter is registered", () => {
    let tokenizeCalled = false;
    registerLanguage({
      code: "ko",
      detect: (t) => /[가-힣]/.test(t),
      tokenize: (t) => {
        tokenizeCalled = true;
        return [t];
      },
    });
    const db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', 'refactor the auth middleware');
    `);
    searchUserText(db, { query: "refactor" });
    expect(tokenizeCalled).toBe(false);
  });

  // Regression: termSatisfied's language-layer path checked only that each
  // of a term's tokens appeared somewhere in the row's indexed text, with no
  // adjacency check — so a phrase query could match a row where the two
  // words appear far apart, breaking the pre-existing exact-phrase-adjacency
  // guarantee for any query a Korean adapter detects.
  it("(regression) an exact-phrase query still requires adjacency — the language layer must not bypass it", () => {
    registerLanguage({
      code: "ko",
      detect: (t) => /[가-힣]/.test(t),
      tokenize: (t) => t.split(/\s+/).filter(Boolean),
    });
    const db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', '코드 작성하고 나중에 리뷰 요청함');
      INSERT INTO user_text_fts_lang_ko (rowid, text, session_id, ts)
        VALUES ((SELECT rowid FROM user_text WHERE event_uuid = 'e1'), '코드 작성하고 나중에 리뷰 요청함', 's1', '2026-06-01T10:00:00Z');
    `);

    const results = searchUserText(db, { query: '"코드 리뷰"' });
    expect(results).toEqual([]);
  });

  // Regression: Kiwi splits a word by what follows it, so "써도" ending the
  // quoted phrase became "쓰" while the message, where "세션은" follows it,
  // kept "써도". The message then missed the language layer, and a longer
  // message quoting the phrase, found by every layer, outranked it.
  it("(regression) a quoted phrase is ranked without the language layer, which can split it unlike the message", () => {
    registerLanguage({
      code: "ko",
      detect: (t) => /[가-힣]/.test(t),
      tokenize: (t) => t.split(/\s+/).map((w) => (w === "써도" ? "쓰" : w)),
    });
    const db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', 'user'),
        ('e2', 's1', '2026-06-02T10:00:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', '코덱스 exec 써도 세션은 절로 가냐'),
        ('e2', 's1', '2026-06-02T10:00:00Z', '지난 대화 정리: 코덱스 exec 써도 세션은 절로 가냐고 물었고 이렇게 쓰면 된다고 답했다');
      INSERT INTO user_text_fts_lang_ko (rowid, text, session_id, ts) VALUES
        ((SELECT rowid FROM user_text WHERE event_uuid = 'e1'), '코덱스 exec 써도 세션 절로 가', 's1', '2026-06-01T10:00:00Z'),
        ((SELECT rowid FROM user_text WHERE event_uuid = 'e2'), '지난 대화 정리 코덱스 exec 쓰 세션 절로 가 묻 이렇게 쓰 되 답하', 's1', '2026-06-02T10:00:00Z');
    `);

    const results = searchUserText(db, { query: '"코덱스 exec 써도"' });
    expect(results.map((r) => r.snippet)).toEqual([
      "코덱스 exec 써도 세션은 절로 가냐",
      expect.stringContaining("지난 대화 정리"),
    ]);
  });

  // Regression: a real production crash. ja/zh's embedded dictionaries load
  // successfully as soon as the npm package is installed (unlike ko, which
  // also needs an external model directory), but applySchema() — which
  // creates each language's FTS table — only runs from the indexer
  // (driver.ts), never from the MCP server. If the indexer hasn't re-run
  // since a language was added to listKnownLanguageCodes(), the adapter is
  // registered but its table doesn't exist yet. db.prepare() against a
  // nonexistent table throws synchronously; previously nothing caught it,
  // so the whole search crashed instead of just skipping that layer.
  it("(regression) a registered adapter whose FTS table hasn't been created yet does not crash the search", () => {
    registerLanguage({
      code: "ko",
      detect: (t) => /[가-힣]/.test(t),
      tokenize: (t) => t.split(/\s+/).filter(Boolean),
    });
    const db = openMem();
    db.exec("DROP TABLE user_text_fts_lang_ko");
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', '리팩토링 완료했습니다');
    `);

    expect(() => searchUserText(db, { query: "리팩토링" })).not.toThrow();
    expect(searchUserText(db, { query: "리팩토링" }).map((r) => r.snippet)).toEqual(["리팩토링 완료했습니다"]);
  });
});

/**
 * Task 1: clens_search returns a match-CENTERED snippet, never the full
 * message and never a head cut. A head cut would drop a term that occurs deep
 * in a long message, making a genuine hit look irrelevant — the exact
 * relevance-judgment regression Task 1 forbids. These prove the snippet is
 * built around the match, shrinks large messages, and never loses the match.
 */
describe("mcp/search.ts — match-centered snippet (Task 1)", () => {
  let db: Database.Database;
  let longText: string;

  beforeEach(() => {
    db = openMem();
    // A long message whose matched term sits deep in the middle, with a unique
    // marker at the very start that a match-centered window must NOT include.
    const head = "HEADMARKER_ZZZ" + "가나다라마".repeat(120); // ~600+ chars before the match
    const tail = "바사아자차".repeat(120);
    longText = `${head}특이매칭토큰987${tail}`;
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', 'user');
    `);
    db.prepare(
      "INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', ?)",
    ).run(longText);
  });

  it("snippet contains the matched term even when it sits deep in the message", () => {
    const results = searchUserText(db, { query: "특이매칭토큰987" });
    expect(results.length).toBe(1);
    expect(results[0]!.snippet).toContain("특이매칭토큰987");
  });

  it("snippet is a window (not a head cut): excludes far-away start, is elided both ends", () => {
    const results = searchUserText(db, { query: "특이매칭토큰987" });
    const snip = results[0]!.snippet;
    expect(snip).not.toContain("HEADMARKER_ZZZ"); // head-cut would have kept the start
    expect(snip.startsWith("…")).toBe(true); // context trimmed before the match
    expect(snip.endsWith("…")).toBe(true); // context trimmed after the match
  });

  it("snippet is far smaller than the full message", () => {
    const results = searchUserText(db, { query: "특이매칭토큰987" });
    expect(results[0]!.snippet.length).toBeLessThan(longText.length / 2);
    expect(longText.length).toBeGreaterThan(1000);
  });

  it("a short message is returned whole, with no ellipsis", () => {
    const db2 = openMem();
    db2.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES ('e1', 's1', '2026-06-01T10:00:00Z', '짧은 인증 메시지');
    `);
    const results = searchUserText(db2, { query: "인증" });
    expect(results[0]!.snippet).toBe("짧은 인증 메시지");
  });
});

/**
 * Task 1: results are ordered by score (descending) and every result carries a
 * numeric score, so a byte budget can truncate from the least-relevant end.
 */
describe("mcp/search.ts — score field ordering", () => {
  it("results are ordered by descending score and score is numeric", () => {
    const db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', 'user'),
        ('e2', 's1', '2026-06-01T10:01:00Z', 'user'),
        ('e3', 's1', '2026-06-01T10:02:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', '인증 미들웨어'),
        ('e2', 's1', '2026-06-01T10:01:00Z', '인증 토큰 인증 재확인 인증'),
        ('e3', 's1', '2026-06-01T10:02:00Z', '데이터베이스');
    `);
    const results = searchUserText(db, { query: "인증" });
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) expect(typeof r.score).toBe("number");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });
});

/**
 * Task 1: formatSearchResults caps total response bytes, truncating from the
 * least-relevant end and reporting the dropped count — never silently. The top
 * hit is always emitted even if it alone exceeds the cap (recall 무회귀).
 */
describe("mcp/search.ts — formatSearchResults byte budget", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      session_id: "s1",
      project_id: "proj-a",
      ts: `2026-06-01T10:${String(i).padStart(2, "0")}:00Z`,
      role: "user" as const,
      snippet: `결과 ${i} ` + "가나다라마바사".repeat(20),
      score: (n - i) / 100,
    }));

  it("empty results render a clear no-results message", () => {
    expect(formatSearchResults([], DEFAULT_SEARCH_MAX_BYTES)).toBe("No results found.");
  });

  it("caps total bytes under the budget and reports the dropped count", () => {
    const out = formatSearchResults(rows(50), 2000);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(2000 + 200); // budget + one "+N more" footer line
    expect(out).toMatch(/\+\d+ more match/);
    // The footer count must equal the actually-hidden rows.
    const shown = (out.match(/\n\[/g)?.length ?? 0) + (out.startsWith("[") ? 1 : 0);
    const m = out.match(/\+(\d+) more/);
    expect(Number(m![1])).toBe(50 - shown);
  });

  it("keeps the highest-ranked hits and drops the lowest-ranked ones", () => {
    const out = formatSearchResults(rows(50), 2000);
    expect(out).toContain("결과 0"); // top score
    expect(out).not.toContain("결과 49"); // lowest score, must be dropped
  });

  it("always emits the top hit even if it alone exceeds the budget (no silent recall loss)", () => {
    const one = rows(3).slice(0, 1);
    const out = formatSearchResults(one, 10); // absurdly small budget
    expect(out).toContain("결과 0");
    expect(out).not.toMatch(/\+\d+ more/); // nothing was dropped
  });

  it("does not add a '+N more' footer when everything fits", () => {
    const out = formatSearchResults(rows(2), DEFAULT_SEARCH_MAX_BYTES);
    expect(out).not.toMatch(/\+\d+ more/);
    expect(out).toContain("결과 0");
    expect(out).toContain("결과 1");
  });

  it("counts matches hidden past the limit, even when every shown result fits the budget", () => {
    // 5 results shown, but the search matched 40 rows total (35 fell past the
    // limit slice). With a huge budget nothing is dropped for SIZE, yet the
    // footer must still reveal the 35 hidden matches — the exact silent-loss
    // bug this fix closes.
    const out = formatSearchResults(rows(5), DEFAULT_SEARCH_MAX_BYTES, 40);
    expect(out).toMatch(/\+35 more match/);
    expect(out).toContain("결과 0");
    expect(out).toContain("결과 4");
  });

  it("combines size-drops and limit-overflow into one hidden count", () => {
    // 50 fetched, tiny budget shows only a few; totalMatched=200 means 150 more
    // beyond the fetched page too. hidden = 200 - shown.
    const out = formatSearchResults(rows(50), 2000, 200);
    const shown = (out.match(/\n\[/g)?.length ?? 0) + (out.startsWith("[") ? 1 : 0);
    const m = out.match(/\+(\d+) more/);
    expect(Number(m![1])).toBe(200 - shown);
  });
});

/**
 * Fix A: searchWithTotal reports how many rows matched before the `limit`
 * slice, so the tool can tell the caller when more matches exist than were
 * returned instead of a full page silently implying "that's all there is".
 */
describe("mcp/search.ts — searchWithTotal reports total matched", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');`);
    // 30 rows all containing 인증.
    const insE = db.prepare("INSERT INTO event (uuid, session_id, ts, role) VALUES (?, 's1', ?, 'user')");
    const insU = db.prepare("INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES (?, 's1', ?, ?)");
    for (let i = 0; i < 30; i++) {
      const ts = `2026-06-01T10:${String(i).padStart(2, "0")}:00Z`;
      insE.run("e" + i, ts);
      insU.run("e" + i, ts, `인증 관련 메시지 번호 ${i}`);
    }
  });

  it("totalMatched exceeds the returned count when more rows match than the limit", () => {
    const { results, totalMatched } = searchWithTotal(db, { query: "인증", limit: 10 });
    expect(results.length).toBe(10);
    expect(totalMatched).toBeGreaterThan(10); // there ARE more than the 10 shown
  });

  it("totalMatched equals the returned count when the whole match set fits the limit", () => {
    const { results, totalMatched } = searchWithTotal(db, { query: "인증", limit: 100 });
    expect(totalMatched).toBe(results.length); // nothing hidden
    expect(results.length).toBe(30);
  });

  it("searchUserText wrapper returns just the results array, unchanged", () => {
    const arr = searchUserText(db, { query: "인증", limit: 5 });
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(5);
  });
});

/**
 * Task 2, item 1: `role` and `until` search options. `role` restricts matches
 * to one author (the cheapest way to cut assistant-reply noise when hunting for
 * something the user said); `until` bounds the time window from above, mirroring
 * the existing `since` lower bound. Neither touches matching/ranking — they only
 * narrow the candidate rows (WHERE conditions).
 */
describe("mcp/search.ts — role and until filters (Task 2 item 1)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', 'user'),
        ('e2', 's1', '2026-06-02T10:00:00Z', 'assistant'),
        ('e3', 's1', '2026-06-03T10:00:00Z', 'user'),
        ('e4', 's1', '2026-06-04T10:00:00Z', 'assistant');
      INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES
        ('e1', 's1', '2026-06-01T10:00:00Z', '인증 미들웨어 질문', 'user', 'user_message'),
        ('e2', 's1', '2026-06-02T10:00:00Z', '인증 미들웨어 설명 답변', 'assistant', 'assistant_message'),
        ('e3', 's1', '2026-06-03T10:00:00Z', '인증 토큰 다시 질문', 'user', 'user_message'),
        ('e4', 's1', '2026-06-04T10:00:00Z', '인증 토큰 설명 답변', 'assistant', 'assistant_message');
    `);
  });

  it("role='user' returns only user-authored matches", () => {
    const results = searchUserText(db, { query: "인증", role: "user" });
    expect(results.length).toBe(2);
    expect(results.every((r) => r.role === "user")).toBe(true);
  });

  it("role='assistant' returns only assistant-authored matches", () => {
    const results = searchUserText(db, { query: "인증", role: "assistant" });
    expect(results.length).toBe(2);
    expect(results.every((r) => r.role === "assistant")).toBe(true);
  });

  it("no role returns both authors (unchanged default)", () => {
    const results = searchUserText(db, { query: "인증" });
    expect(results.length).toBe(4);
    expect(new Set(results.map((r) => r.role))).toEqual(new Set(["user", "assistant"]));
  });

  it("until bounds the upper time edge", () => {
    // only e1 (06-01) and e2 (06-02) are at or before 06-02T12:00.
    const results = searchUserText(db, { query: "인증", until: "2026-06-02T12:00:00Z" });
    expect(results.map((r) => r.ts).sort()).toEqual([
      "2026-06-01T10:00:00Z",
      "2026-06-02T10:00:00Z",
    ]);
  });

  it("since + until bound a window from both ends", () => {
    // window covering only 06-02 and 06-03.
    const results = searchUserText(db, {
      query: "인증",
      since: "2026-06-02T00:00:00Z",
      until: "2026-06-03T23:59:59Z",
    });
    expect(results.map((r) => r.ts).sort()).toEqual([
      "2026-06-02T10:00:00Z",
      "2026-06-03T10:00:00Z",
    ]);
  });

  it("role and until compose (user-only, within window)", () => {
    const results = searchUserText(db, {
      query: "인증",
      role: "user",
      until: "2026-06-03T23:59:59Z",
    });
    // user rows: e1 (06-01), e3 (06-03); both <= until.
    expect(results.length).toBe(2);
    expect(results.every((r) => r.role === "user")).toBe(true);
  });

  it("totalMatched respects the role filter (no hidden cross-role matches)", () => {
    const { results, totalMatched } = searchWithTotal(db, { query: "인증", role: "user" });
    expect(totalMatched).toBe(results.length);
    expect(totalMatched).toBe(2); // only the 2 user rows, not all 4
  });

  it("role='user' leaves out a subagent's prompt, which its parent agent wrote; no role keeps it", () => {
    db.exec(`
      INSERT INTO session (id, project_id, kind, parent_id) VALUES ('agent-x', 'proj-a', 'subagent', 's1');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('x1', 'agent-x', '2026-06-01T10:01:00Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES
        ('x1', 'agent-x', '2026-06-01T10:01:00Z', '인증 미들웨어 리뷰해줘', 'user', 'user_message');
    `);
    expect(searchUserText(db, { query: "인증", role: "user" }).map((r) => r.session_id)).toEqual(["s1", "s1"]);
    expect(searchUserText(db, { query: "인증" }).some((r) => r.session_id === "agent-x")).toBe(true);
  });
});

describe("mcp/search.ts — URLs, colons and command messages", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e1', 's1', '2026-06-01T10:00:01Z', 'user'),
        ('e2', 's1', '2026-06-01T10:00:02Z', 'user'),
        ('e3', 's1', '2026-06-01T10:00:03Z', 'user'),
        ('e4', 's1', '2026-06-01T10:00:04Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text, is_command) VALUES
        ('e1', 's1', '2026-06-01T10:00:01Z', '참고 https://github.com/acme/widget-kit 링크', 0),
        ('e2', 's1', '2026-06-01T10:00:02Z', 'ecc:plan-prd 스킬 써볼까', 0),
        -- A command message as the parser now stores it: markup gone, the typed arguments kept.
        ('e3', 's1', '2026-06-01T10:00:03Z', 'src/app/main.ts 리뷰 부탁', 1),
        -- The same kind of message as the old parser stored it: every "/word" cut, tags left broken.
        ('e4', 's1', '2026-06-01T10:00:04Z', '<command-message>review<> <command-name><> <command-args>app.ts 리뷰 부탁<>', 1);
    `);
  });

  const tsOf = (query: string) => searchUserText(db, { query, project_id: "proj-a" }).map((r) => r.ts);

  it("a quoted full URL finds the message that contains it", () => {
    expect(tsOf('"https://github.com/acme/widget-kit"')).toEqual(["2026-06-01T10:00:01Z"]);
  });

  it("an unquoted full URL finds the message that contains it", () => {
    expect(tsOf("https://github.com/acme/widget-kit")).toEqual(["2026-06-01T10:00:01Z"]);
  });

  it("a word containing a colon finds the message that contains it", () => {
    expect(tsOf("ecc:plan-prd")).toEqual(["2026-06-01T10:00:02Z"]);
  });

  it("the arguments typed after a command are searchable, path included", () => {
    expect(tsOf('"src/app/main.ts"')).toEqual(["2026-06-01T10:00:03Z"]);
    expect(tsOf("리뷰 부탁")).toContain("2026-06-01T10:00:03Z");
  });

  it("an old command message with broken tags stays out of results", () => {
    expect(tsOf("리뷰 부탁")).not.toContain("2026-06-01T10:00:04Z");
    expect(tsOf("review")).toEqual([]);
  });
});

describe("mcp/search.ts — operators are uppercase only, as in FTS5", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('e1', 's1', '2026-06-01T10:00:01Z', 'user'),
        ('e2', 's1', '2026-06-01T10:00:02Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text) VALUES
        ('e1', 's1', '2026-06-01T10:00:01Z', 'error: native binary not found'),
        ('e2', 's1', '2026-06-01T10:00:02Z', 'native binary found and loaded');
    `);
  });

  const tsOf = (query: string) => searchUserText(db, { query, project_id: "proj-a" }).map((r) => r.ts).sort();

  it("a lowercase not is a word to find, not a negation", () => {
    expect(tsOf("native binary not found")).toEqual(["2026-06-01T10:00:01Z"]);
  });

  it("a lowercase and is a word to find", () => {
    expect(tsOf("found and loaded")).toEqual(["2026-06-01T10:00:02Z"]);
  });

  it("uppercase NOT still negates", () => {
    expect(tsOf("native binary NOT loaded")).toEqual(["2026-06-01T10:00:01Z"]);
  });
});

describe("mcp/search.ts — searching every project", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    seed(db);
  });

  it("without project_id, hits come from every project", () => {
    const projects = new Set(searchUserText(db, { query: "마이그레이션 OR 인증" }).map((r) => r.project_id));
    expect(projects).toEqual(new Set(["proj-a", "proj-b"]));
  });

  it("the formatted hits name their project only when the search spanned every project", () => {
    const results = searchUserText(db, { query: "마이그레이션" });
    expect(formatSearchResults(results, DEFAULT_SEARCH_MAX_BYTES, results.length, true)).toContain("project:proj-b");
    expect(formatSearchResults(results)).not.toContain("project:");
  });
});

describe("mcp/search.ts — the caller's current turn is left out", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('cur', 'proj-a', '2026-06-01T10:00:00Z'), ('old', 'proj-a', '2026-05-01T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('o1', 'old', '2026-05-01T10:00:01Z', 'assistant'),
        ('c1', 'cur', '2026-06-01T10:00:01Z', 'user'),
        ('c2', 'cur', '2026-06-01T10:00:02Z', 'assistant'),
        ('c3', 'cur', '2026-06-01T10:05:00Z', 'user'),
        ('c4', 'cur', '2026-06-01T10:05:01Z', 'assistant');
      INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES
        ('o1', 'old', '2026-05-01T10:00:01Z', 'ponytail 벤치마크: 비용 7.6% 증가', 'assistant', 'assistant_message'),
        ('c1', 'cur', '2026-06-01T10:00:01Z', 'ponytail 설치했던가', 'user', 'user_message'),
        ('c2', 'cur', '2026-06-01T10:00:02Z', 'ponytail 은 설치되어 있습니다', 'assistant', 'assistant_message'),
        ('c3', 'cur', '2026-06-01T10:05:00Z', 'ponytail 효과 있었나', 'user', 'user_message'),
        ('c4', 'cur', '2026-06-01T10:05:01Z', 'ponytail 기록을 찾아보겠습니다', 'assistant', 'assistant_message');
    `);
  });

  const tsOf = (opts: { currentSessionId?: string }) =>
    searchUserText(db, { query: "ponytail", project_id: "proj-a" }, opts).map((r) => r.ts).sort();

  it("the question just asked, and what followed it, do not come back", () => {
    expect(tsOf({ currentSessionId: "cur" })).toEqual([
      "2026-05-01T10:00:01Z",
      "2026-06-01T10:00:01Z",
      "2026-06-01T10:00:02Z",
    ]);
  });

  it("without a caller session nothing is left out", () => {
    expect(tsOf({})).toHaveLength(5);
  });

  it("another session's latest question is not left out", () => {
    expect(tsOf({ currentSessionId: "old" })).toContain("2026-06-01T10:05:00Z");
  });
});

describe("mcp/search.ts — no message holds every word", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    seed(db);
  });

  it("falls back to messages holding some of the words, and says so", () => {
    const r = searchWithTotal(db, { query: "인증 존재하지않는단어" });
    expect(r.partial).toBe(true);
    expect(r.results.length).toBe(3);
    expect(r.results.every((x) => x.snippet.includes("인증"))).toBe(true);
  });

  it("keeps the all-words result when some message holds every word", () => {
    const r = searchWithTotal(db, { query: "인증 토큰" });
    expect(r.partial).toBe(false);
    expect(r.results.map((x) => x.ts)).toEqual(["2026-06-15T10:00:00Z"]);
  });

  it("a one-word query that matches nothing stays empty", () => {
    const r = searchWithTotal(db, { query: "존재하지않는단어" });
    expect(r).toMatchObject({ partial: false, results: [] });
  });

  it("an explicit OR query is not rewritten", () => {
    const r = searchWithTotal(db, { query: "없는단어하나 OR 없는단어둘" });
    expect(r).toMatchObject({ partial: false, results: [] });
  });
});

describe("mcp/search.ts — messages around each hit (context)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'proj-a', '2026-06-01T10:00:00Z'), ('s2', 'proj-a', '2026-06-02T10:00:00Z');
      INSERT INTO event (uuid, session_id, ts, role) VALUES
        ('c1', 's1', '2026-06-01T10:00:01Z', 'user'), ('c2', 's1', '2026-06-01T10:00:02Z', 'assistant'),
        ('c3', 's1', '2026-06-01T10:00:03Z', 'user'), ('c4', 's1', '2026-06-01T10:00:04Z', 'assistant'),
        ('c5', 's1', '2026-06-01T10:00:05Z', 'user'), ('c6', 's2', '2026-06-02T10:00:01Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES
        ('c1', 's1', '2026-06-01T10:00:01Z', 'the build is slow again', 'user', 'user_message'),
        ('c2', 's1', '2026-06-01T10:00:02Z', 'The cache key misses on every run.', 'assistant', 'assistant_message'),
        ('c3', 's1', '2026-06-01T10:00:03Z', 'so pin the lockfile hash', 'user', 'user_message'),
        ('c4', 's1', '2026-06-01T10:00:04Z', 'Pinned it; builds drop to 40s.', 'assistant', 'assistant_message'),
        ('c5', 's1', '2026-06-01T10:00:05Z', 'ok ship it', 'user', 'user_message'),
        ('c6', 's2', '2026-06-02T10:00:01Z', 'unrelated session', 'user', 'user_message');
    `);
  });

  afterEach(() => db.close());

  it("neighborsOf returns the nearest messages on each side, in order, from the same session only", () => {
    const n = neighborsOf(db, "s1", "2026-06-01T10:00:03Z", 1);
    expect(n.before.map((m) => m.text)).toEqual(["The cache key misses on every run."]);
    expect(n.after.map((m) => m.text)).toEqual(["Pinned it; builds drop to 40s."]);
    const wide = neighborsOf(db, "s1", "2026-06-01T10:00:03Z", 5);
    expect(wide.before.map((m) => m.ts)).toEqual(["2026-06-01T10:00:01Z", "2026-06-01T10:00:02Z"]);
    expect(wide.after.map((m) => m.ts)).toEqual(["2026-06-01T10:00:04Z", "2026-06-01T10:00:05Z"]);
  });

  it("shows the context lines around the hit, marked by offset", () => {
    const [hit] = searchUserText(db, { query: "lockfile" });
    expect(hit!.ts).toBe("2026-06-01T10:00:03Z");
    hit!.context = neighborsOf(db, hit!.session_id, hit!.ts, 2);
    const lines = formatSearchResults([hit!]).split("\n");
    expect(lines.slice(1)).toEqual([
      "  [-2] User: the build is slow again",
      "  [-1] Assistant: The cache key misses on every run.",
      `User: ${hit!.snippet}`,
      "  [+1] Assistant: Pinned it; builds drop to 40s.",
      "  [+2] User: ok ship it",
    ]);
  });

  it("cuts a long context message to one short line", () => {
    const long = { role: "assistant" as const, ts: "2026-06-01T10:00:00Z", text: "첫 줄\n\n" + "가".repeat(500) };
    const out = formatSearchResults([
      { session_id: "s1", project_id: "proj-a", ts: "2026-06-01T10:00:01Z", role: "user", snippet: "hit", score: 1, context: { before: [long], after: [] } },
    ]);
    const line = out.split("\n")[1]!;
    expect(line.startsWith("  [-1] Assistant: 첫 줄 가가")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(Array.from(line).length).toBeLessThan(270);
  });

  it("without context the output is unchanged", () => {
    const [hit] = searchUserText(db, { query: "lockfile" });
    expect(formatSearchResults([hit!]).split("\n")).toHaveLength(2);
  });
});

describe("mcp/search.ts — rows that are not conversation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMem();
    db.exec(`
      INSERT INTO project (id, cwd) VALUES ('proj-a', '/a');
      INSERT INTO session (id, project_id, kind) VALUES ('s1', 'proj-a', 'interactive'), ('judge', 'proj-a', 'pipeline');
    `);
    const rows: [string, string, string, string][] = [
      ["r1", "s1", "user", "rotate the signing key"],
      ["r2", "judge", "user", "USER: rotate the signing key USER: done"],
      ["r3", "s1", "user", "[Request interrupted by user] rotate"],
      ["r4", "s1", "assistant", "[external_agent_tool_result] rotate the signing key"],
      ["r5", "s1", "assistant", "rotate: key rotated"],
    ];
    rows.forEach(([uuid, sid, role, text], i) => {
      const ts = `2026-06-01T10:00:0${i}Z`;
      db.prepare("INSERT INTO event (uuid, session_id, ts, role) VALUES (?, ?, ?, ?)").run(uuid, sid, ts, role);
      db.prepare("INSERT INTO user_text (event_uuid, session_id, ts, text, role) VALUES (?, ?, ?, ?, ?)").run(uuid, sid, ts, text, role);
    });
  });

  afterEach(() => db.close());

  it("leaves out judge transcripts, interrupt markers and imported tool logs", () => {
    expect(searchUserText(db, { query: "rotate" }).map((r) => r.snippet).sort()).toEqual(["rotate the signing key", "rotate: key rotated"]);
  });

  it("leaves out one-shot exec runs", () => {
    db.exec(`
      INSERT INTO session (id, project_id, kind) VALUES ('run', 'proj-a', 'exec');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('x1', 'run', '2026-06-01T10:00:09Z', 'user');
      INSERT INTO user_text (event_uuid, session_id, ts, text, role) VALUES ('x1', 'run', '2026-06-01T10:00:09Z', 'rotate the signing key in a benchmark', 'user');
    `);
    expect(searchUserText(db, { query: "rotate" }).map((r) => r.session_id)).not.toContain("run");
  });

  it("leaves out the subagents of exec runs too", () => {
    db.exec(`
      INSERT INTO session (id, project_id, kind) VALUES ('run', 'proj-a', 'exec');
      INSERT INTO session (id, project_id, kind, parent_id) VALUES ('agent-r', 'proj-a', 'subagent', 'run');
      INSERT INTO event (uuid, session_id, ts, role) VALUES ('x2', 'agent-r', '2026-06-01T10:00:09Z', 'assistant');
      INSERT INTO user_text (event_uuid, session_id, ts, text, role) VALUES ('x2', 'agent-r', '2026-06-01T10:00:09Z', 'rotate the signing key for the benchmark', 'assistant');
    `);
    expect(searchUserText(db, { query: "rotate" }).map((r) => r.session_id)).not.toContain("agent-r");
  });

  it("notNoise matches only the known non-conversation rows", () => {
    const pick = (text: string) =>
      (db.prepare(`SELECT ${notNoise("x")} AS keep FROM (SELECT ? AS text, 0 AS is_command) x`).get(text) as { keep: number }).keep;
    expect(["[Request interrupted by user for tool use]", "  ", "<EXTERNAL SESSION IMPORTED>", "No response requested.", "[external_agent_tool_call: Edit]",
      "<local-command-stdout>Set model to Sonnet 5</local-command-stdout>", "<local-command-stderr>Error: not found</local-command-stderr>",
      "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>", "<bash-stdout>On branch main</bash-stdout>",
      "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
      "Another Claude session sent a message:\n<teammate-message teammate_id=\"rA-judgment\">\nsaved\n</teammate-message>",
      "<teammate-message teammate_id=\"team-lead\">\nYou are the security reviewer on this agent team.\n</teammate-message>"].map(pick)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(["ok", "No response requested. Then I added a test.", "a [Request interrupted by user] quote", "why is <local-command-stdout> in the log",
      "<bash-input>git status</bash-input>", "<command-name>/deploy</command-name>\n<command-args>push it</command-args>",
      "why does clens list <teammate-message> rows as mine?"].map(pick)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("mcp/search.ts — several queries in one call", () => {
  let db: Database.Database;
  const OUT = { maxBytes: DEFAULT_SEARCH_MAX_BYTES, context: 0, allProjects: false };

  beforeEach(() => {
    db = openMem();
    seed(db);
  });

  afterEach(() => db.close());

  it("gives one section per query, in the given order", () => {
    const text = searchManyText(db, {}, ["마이그레이션", "인증"], {}, OUT);
    expect(text.split("\n").filter((l) => l.startsWith("### query:"))).toEqual(["### query: 마이그레이션", "### query: 인증"]);
  });

  it("a query with no hits gives its header and No results found.", () => {
    const text = searchManyText(db, {}, ["인증", "zzznothing"], {}, OUT);
    expect(text).toContain("### query: zzznothing\nNo results found.");
  });

  it("each section keeps its top hit even with a small budget", () => {
    const text = searchManyText(db, {}, ["마이그레이션", "만료"], {}, { ...OUT, maxBytes: 300 });
    expect(text).toContain("데이터베이스 마이그레이션 작업");
    expect(text).toContain("인증 토큰 만료 처리 어떻게 해");
  });

  it("pays for the headers and joiners out of maxBytes", () => {
    const [q1, q2] = ["인증", "마이그레이션"];
    const overhead = Buffer.byteLength(`### query: ${q1}\n`) + Buffer.byteLength(`### query: ${q2}\n`) + 2;
    const per = Math.floor((2000 - overhead) / 2);
    const expected =
      `### query: ${q1}\n` + searchText(db, { query: q1 }, {}, { ...OUT, maxBytes: per }) +
      "\n\n" +
      `### query: ${q2}\n` + searchText(db, { query: q2 }, {}, { ...OUT, maxBytes: per });
    expect(searchManyText(db, {}, [q1, q2], {}, { ...OUT, maxBytes: 2000 })).toBe(expected);
  });

  it("searchText prefixes the partial-match note when no message holds every word", () => {
    const { results, totalMatched, partial } = searchWithTotal(db, { query: "인증 마이그레이션" });
    expect(partial).toBe(true);
    expect(searchText(db, { query: "인증 마이그레이션" }, {}, OUT)).toBe(
      "No message contains every word of the query; these contain some of them.\n\n" + formatSearchResults(results, OUT.maxBytes, totalMatched, false),
    );
  });

  it("searchText fills the messages around each hit when context is set", () => {
    const { results, totalMatched } = searchWithTotal(db, { query: "만료" });
    for (const r of results) r.context = neighborsOf(db, r.session_id, r.ts, 1);
    expect(searchText(db, { query: "만료" }, {}, { ...OUT, context: 1 })).toBe(formatSearchResults(results, OUT.maxBytes, totalMatched, false));
  });

  it("searchText on one query returns what searchWithTotal plus formatSearchResults gave", () => {
    const { results, totalMatched } = searchWithTotal(db, { query: "인증" });
    expect(searchText(db, { query: "인증" }, {}, OUT)).toBe(formatSearchResults(results, OUT.maxBytes, totalMatched, false));
  });
});

describe("mcp/search.ts — local time", () => {
  it("prints each hit's time in the server's zone", () => {
    const db = openMem();
    seed(db);
    const out = withTz("Asia/Seoul", () => formatSearchResults(searchUserText(db, { query: "인증" })));
    expect(out).toContain("2026-06-01T19:00:00+09:00  session:s1");
    expect(out).not.toMatch(UTC_TIME);
    db.close();
  });
});
