import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/indexer/schema.js";
import { prepareStatements, writeParsedEvent } from "../src/indexer/writer.js";
import { registerLanguage, resetLanguageRegistry } from "../src/indexer/lang/registry.js";
import type { ParsedEvent } from "../src/indexer/types.js";

function openMem(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  db.exec(`INSERT INTO session (id) VALUES ('s1')`);
  return db;
}

function userTextEvent(uuid: string, text: string): ParsedEvent {
  return {
    event: {
      uuid,
      session_id: "s1",
      parent_uuid: null,
      prompt_id: null,
      agent_id: null,
      is_sidechain: null,
      ts: "2026-01-01T00:00:00Z",
      role: "user",
      model: null,
      in_tok: 0,
      out_tok: 0,
      cache_r: 0,
      cache_w: 0,
      text_len: text.length,
      has_tool_use: 0,
      has_text: 1,
      has_tool_res: 0,
      user_turn_no: null,
      assistant_turn_no: null,
      source_file: "test.jsonl",
    },
    tool_calls: [],
    file_ops: [],
    user_texts: [
      {
        event_uuid: uuid,
        session_id: "s1",
        ts: "2026-01-01T00:00:00Z",
        text,
        is_command: 0,
        role: "user",
        type: "user_message",
      },
    ],
    skill_calls: [],
    agent_calls: [],
    slash_commands: [],
    system_reminders: [],
    hook_blocks: [],
    unknown_blocks: [],
  };
}

afterEach(() => {
  resetLanguageRegistry();
});

describe("writer.ts — per-language FTS insertion", () => {
  it("skips the ko layer entirely when no adapter is registered (not installed)", () => {
    const db = openMem();
    const stmts = prepareStatements(db);
    writeParsedEvent(stmts, userTextEvent("e1", "리팩토링을 진행했습니다"));
    const row = db.prepare("SELECT count(*) AS n FROM user_text_fts_lang_ko").get() as { n: number };
    expect(row.n).toBe(0);
    db.close();
  });

  it("inserts content tokens under the same rowid as user_text when the adapter is registered and detects the text", () => {
    registerLanguage({
      code: "ko",
      detect: (t) => t.includes("리팩토링"),
      tokenize: () => ["리팩토링", "진행"],
    });
    const db = openMem();
    const stmts = prepareStatements(db);
    writeParsedEvent(stmts, userTextEvent("e1", "리팩토링을 진행했습니다"));

    const userTextRow = db.prepare("SELECT rowid FROM user_text WHERE event_uuid = 'e1'").get() as { rowid: number };
    const langRow = db
      .prepare("SELECT rowid, text FROM user_text_fts_lang_ko WHERE rowid = ?")
      .get(userTextRow.rowid) as { rowid: number; text: string } | undefined;
    expect(langRow?.text).toBe("리팩토링 진행");
    db.close();
  });

  it("skips insertion when the registered adapter's detect() returns false for this row", () => {
    registerLanguage({
      code: "ko",
      detect: () => false,
      tokenize: () => ["should not be used"],
    });
    const db = openMem();
    const stmts = prepareStatements(db);
    writeParsedEvent(stmts, userTextEvent("e1", "plain english text"));
    const row = db.prepare("SELECT count(*) AS n FROM user_text_fts_lang_ko").get() as { n: number };
    expect(row.n).toBe(0);
    db.close();
  });

  it("skips insertion when tokenize() returns no content tokens (e.g. particle-only text)", () => {
    registerLanguage({
      code: "ko",
      detect: () => true,
      tokenize: () => [],
    });
    const db = openMem();
    const stmts = prepareStatements(db);
    writeParsedEvent(stmts, userTextEvent("e1", "을를"));
    const row = db.prepare("SELECT count(*) AS n FROM user_text_fts_lang_ko").get() as { n: number };
    expect(row.n).toBe(0);
    db.close();
  });
});
