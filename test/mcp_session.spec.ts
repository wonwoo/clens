import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applySchema } from "../src/indexer/schema.js";
import { formatSessionMessages, sessionContext } from "../src/mcp/session.js";
import { UTC_TIME, withTz } from "./tz.js";

let db: Database.Database;

const LOG = "H".repeat(5_000) + "M".repeat(15_001) + "T".repeat(5_000);
const AT_LIMIT = "가".repeat(20_000);
const EMOJI = "😀".repeat(20_001);

beforeAll(() => {
  db = new Database(":memory:");
  applySchema(db);
  const add = db.prepare("INSERT INTO user_text (event_uuid, session_id, ts, text, is_command, role, type) VALUES (?, 's', ?, ?, 0, ?, ?)");
  add.run("u1", "2026-10-01T00:00:01Z", "short question", "user", "user_message");
  add.run("u2", "2026-10-01T00:00:02Z", LOG, "user", "user_message");
  add.run("a1", "2026-10-01T00:00:03Z", AT_LIMIT, "assistant", "assistant_message");
  add.run("u3", "2026-10-01T00:00:04Z", EMOJI, "user", "user_message");
});

afterAll(() => db.close());

const texts = (full?: boolean) =>
  sessionContext(db, { session_id: "s", around_ts: "2026-10-01T00:00:02Z", full }).map((m) => m.text);

describe("clens_session — long messages", () => {
  it("cuts the middle of a message over 20,000 characters, keeping 5,000 at each end", () => {
    const [short, log, atLimit] = texts();
    expect(short).toBe("short question");
    expect(log).toBe("H".repeat(5_000) + "\n…[15001 chars cut; full: true returns the whole message]…\n" + "T".repeat(5_000));
    expect(atLimit).toBe(AT_LIMIT);
  });

  it("counts characters as code points and never splits one", () => {
    const emoji = texts()[3]!;
    expect(emoji.startsWith("😀".repeat(5_000) + "\n…[10001 chars cut;")).toBe(true);
    expect(emoji.endsWith("…\n" + "😀".repeat(5_000))).toBe(true);
  });

  it("returns every message whole with full: true", () => {
    expect(texts(true)).toEqual(["short question", LOG, AT_LIMIT, EMOJI]);
  });
});

describe("clens_session — output", () => {
  it("numbers each message with its role and its time in the server's zone", () => {
    const messages = sessionContext(db, { session_id: "s", around_ts: "2026-10-01T00:00:01Z", limit: 2 });
    const out = withTz("Asia/Seoul", () => formatSessionMessages(messages));
    expect(out.startsWith("[1] USER 2026-10-01T09:00:01+09:00\nshort question\n\n[2] USER 2026-10-01T09:00:02+09:00\n")).toBe(true);
    expect(out).not.toMatch(UTC_TIME);
  });
});
