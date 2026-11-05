import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySchema } from "../src/indexer/schema.js";
import { formatLineOrigins, lineOrigins } from "../src/mcp/line_origin.js";
import { UTC_TIME, withTz } from "./tz.js";

let db: Database.Database;

const LINE = 'const name = "cache key";';
const OTHER = "export const TTL_MS = 60_000;";

function msg(uuid: string, session: string, ts: string, role: "user" | "assistant", text: string): void {
  db.prepare("INSERT INTO event (uuid, session_id, ts, role) VALUES (?, ?, ?, ?)").run(uuid, session, ts, role);
  db.prepare("INSERT INTO user_text (event_uuid, session_id, ts, text, role, type) VALUES (?, ?, ?, ?, ?, ?)").run(
    uuid, session, ts, text, role, role === "user" ? "user_message" : "assistant_message",
  );
}
/** One edit call, with a file_op row for each path it edited. */
function call(uuid: string, session: string, ts: string, name: string, input: string, paths: string[]): void {
  db.prepare("INSERT OR IGNORE INTO event (uuid, session_id, ts, role) VALUES (?, ?, ?, 'assistant')").run(uuid, session, ts);
  db.prepare("INSERT INTO tool_call (event_uuid, session_id, ts, name, input_json) VALUES (?, ?, ?, ?, ?)").run(uuid, session, ts, name, input);
  for (const path of paths) {
    db.prepare("INSERT INTO file_op (event_uuid, session_id, ts, tool, path) VALUES (?, ?, ?, ?, ?)").run(
      uuid, session, ts, name === "exec" ? "apply_patch" : name, path,
    );
  }
}
const edit = (uuid: string, session: string, ts: string, path: string, oldString: string, newString: string) =>
  call(uuid, session, ts, "Edit", JSON.stringify({ file_path: path, old_string: oldString, new_string: newString }), [path]);
const patch = (...sections: [string, string[]][]) =>
  ["*** Begin Patch", ...sections.flatMap(([file, lines]) => [`*** Update File: ${file}`, "@@", ...lines]), "*** End Patch"].join("\n");
const origins = (text: string, params = {}, file = "src/cache.ts") =>
  lineOrigins(db, file, text, params).map((o) => [o.session_id, o.edited_at, o.tool]);

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  db.exec(`
    INSERT INTO project (id, cwd) VALUES ('-w-app', '/w/app'), ('-w-web', '/w/web');
    INSERT INTO session (id, project_id, kind, parent_id, cwd, source) VALUES
      ('a', '-w-app', 'interactive', NULL, '/w/app', 'claude'),
      ('b', '-w-app', 'interactive', NULL, '/w/app', 'codex'),
      ('c', '-w-app', 'interactive', NULL, '/w/app', 'claude'),
      ('a-sub', '-w-app', 'subagent', 'a', '/w/app', 'claude'),
      ('web', '-w-web', 'interactive', NULL, '/w/web', 'claude');
  `);
});

afterEach(() => db.close());

describe("lineOrigins", () => {
  it("finds an Edit that wrote the text, not one that only replaced it", () => {
    edit("e1", "a", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    edit("e2", "b", "2026-09-02T10:00:00Z", "/w/app/src/cache.ts", LINE, "const name = 'key';");
    expect(origins(LINE)).toEqual([["a", "2026-09-01T10:00:00Z", "Edit"]]);
  });

  it("finds a Write's content and a NotebookEdit's new source", () => {
    call("w1", "a", "2026-09-01T10:00:00Z", "Write", JSON.stringify({ file_path: "/w/app/src/cache.ts", content: `${OTHER}\n${LINE}\n` }), ["/w/app/src/cache.ts"]);
    call("n1", "b", "2026-09-02T10:00:00Z", "NotebookEdit", JSON.stringify({ notebook_path: "/w/app/nb.ipynb", new_source: LINE }), ["/w/app/nb.ipynb"]);
    expect(origins(LINE)).toEqual([["a", "2026-09-01T10:00:00Z", "Write"]]);
    expect(origins(LINE, {}, "nb.ipynb")).toEqual([["b", "2026-09-02T10:00:00Z", "NotebookEdit"]]);
  });

  it("finds a patch's + line under the file's own header only", () => {
    call("p1", "b", "2026-09-02T10:00:00Z", "apply_patch",
      patch(["src/cache.ts", [`-${LINE}`, "+const name = 'key';"]], ["src/other.ts", [`+${LINE}`]]),
      ["/w/app/src/cache.ts", "/w/app/src/other.ts"]);
    expect(origins(LINE)).toEqual([]);
    expect(origins(LINE, {}, "src/other.ts")).toEqual([["b", "2026-09-02T10:00:00Z", "apply_patch"]]);
    call("p2", "c", "2026-09-03T10:00:00Z", "apply_patch", patch(["/w/app/src/cache.ts", [`+    ${LINE}`]]), ["/w/app/src/cache.ts"]);
    expect(origins(LINE)).toEqual([["c", "2026-09-03T10:00:00Z", "apply_patch"]]);
  });

  it("finds a patch inside Codex exec code, written as a string literal", () => {
    const code = `const patch = ${JSON.stringify(patch(["src/cache.ts", ["-old", `+${LINE}`]]))};\ntext(await tools.apply_patch(patch));`;
    call("x1", "b", "2026-09-02T10:00:00Z", "exec", code, ["/w/app/src/cache.ts"]);
    expect(origins(LINE)).toEqual([["b", "2026-09-02T10:00:00Z", "exec"]]);
  });

  it("finds a patch line whose code holds \\n, in a raw patch and inside exec code", () => {
    const joined = 'return lines.map((l) => l.trim()).join("\\n");';
    call("p1", "a", "2026-09-01T10:00:00Z", "apply_patch", patch(["src/cache.ts", [`+  ${joined}`]]), ["/w/app/src/cache.ts"]);
    const code = `const patch = ${JSON.stringify(patch(["src/other.ts", [`+  ${joined}`]]))};\ntext(await tools.apply_patch(patch));`;
    call("x1", "b", "2026-09-02T10:00:00Z", "exec", code, ["/w/app/src/other.ts"]);
    expect(origins(joined)).toEqual([["a", "2026-09-01T10:00:00Z", "apply_patch"]]);
    expect(origins(joined, {}, "src/other.ts")).toEqual([["b", "2026-09-02T10:00:00Z", "exec"]]);
  });

  it("needs every line in one edit", () => {
    edit("e1", "a", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    edit("e2", "a", "2026-09-01T10:01:00Z", "/w/app/src/cache.ts", "", OTHER);
    edit("e3", "b", "2026-09-02T10:00:00Z", "/w/app/src/cache.ts", "", `  ${OTHER}\n\n  ${LINE}\n`);
    expect(origins(`${LINE}\n   \n${OTHER}`)).toEqual([["b", "2026-09-02T10:00:00Z", "Edit"]]);
  });

  it("matches the file by its tail or its whole path, and project_id, since and until narrow it", () => {
    edit("e1", "a", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    edit("e2", "web", "2026-09-05T10:00:00Z", "/w/web/src/cache.ts", "", LINE);
    expect(origins(LINE).map((o) => o[0])).toEqual(["a", "web"]);
    expect(origins(LINE, {}, "/w/web/src/cache.ts").map((o) => o[0])).toEqual(["web"]);
    expect(origins(LINE, {}, "cache.ts").map((o) => o[0])).toEqual(["a", "web"]);
    expect(origins(LINE, {}, "che.ts")).toEqual([]);
    expect(origins(LINE, { project_id: "-w-web" }).map((o) => o[0])).toEqual(["web"]);
    expect(origins(LINE, { since: "2026-09-02T00:00:00Z" }).map((o) => o[0])).toEqual(["web"]);
    expect(origins(LINE, { until: "2026-09-02T00:00:00Z" }).map((o) => o[0])).toEqual(["a"]);
  });

  it("gives each session once at its first edit, oldest first, cut by limit", () => {
    edit("e1", "c", "2026-09-03T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    edit("e2", "a", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    edit("e3", "a", "2026-09-04T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    edit("e4", "b", "2026-09-02T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    expect(origins(LINE)).toEqual([
      ["a", "2026-09-01T10:00:00Z", "Edit"],
      ["b", "2026-09-02T10:00:00Z", "Edit"],
      ["c", "2026-09-03T10:00:00Z", "Edit"],
    ]);
    expect(origins(LINE, { limit: 2 }).map((o) => o[0])).toEqual(["a", "b"]);
  });

  it("gives a subagent's edit as its parent's, with the parent's request and the reply before it", () => {
    msg("u0", "a", "2026-09-01T09:50:00Z", "user", "make the cache faster");
    msg("r1", "a", "2026-09-01T09:55:00Z", "assistant", "Keying by name avoids the hash; shall I?");
    msg("u1", "a", "2026-09-01T09:56:00Z", "user", "오케 그렇게 하자");
    msg("n1", "a", "2026-09-01T09:57:00Z", "user", "<task-notification><task-id>b1</task-id></task-notification>");
    msg("n2", "a", "2026-09-01T09:58:00Z", "user", "/compact");
    msg("s1", "a-sub", "2026-09-01T09:59:00Z", "user", "edit src/cache.ts as agreed");
    edit("e1", "a-sub", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    msg("r2", "a", "2026-09-01T10:05:00Z", "assistant", "Done.");
    const [o] = lineOrigins(db, "src/cache.ts", LINE, {});
    expect(o).toEqual({
      session_id: "a", project_id: "-w-app", source: "claude", edited_at: "2026-09-01T10:00:00Z", tool: "Edit",
      request: { ts: "2026-09-01T09:56:00Z", text: "오케 그렇게 하자" },
      reply_before: { ts: "2026-09-01T09:55:00Z", text: "Keying by name avoids the hash; shall I?" },
      last: null,
    });
  });

  it("adds the session's last turn that wrote the text again, after a rollback for one", () => {
    msg("r1", "a", "2026-09-01T09:55:00Z", "assistant", "Overwrite the whole document?");
    msg("u1", "a", "2026-09-01T09:56:00Z", "user", "do it");
    edit("e1", "a", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    // Written again in the same turn: still the first turn.
    edit("e2", "a", "2026-09-01T10:01:00Z", "/w/app/src/cache.ts", "", LINE);
    msg("u2", "a", "2026-09-01T10:10:00Z", "user", "roll it back");
    msg("r3", "a", "2026-09-01T10:20:00Z", "assistant", "A $slice on the push keeps it atomic; go?");
    msg("u3", "a", "2026-09-01T10:21:00Z", "user", "go ahead");
    edit("e3", "a", "2026-09-01T10:22:00Z", "/w/app/src/cache.ts", "", LINE);
    edit("e4", "a", "2026-09-01T10:23:00Z", "/w/app/src/cache.ts", "", LINE);
    const [o] = lineOrigins(db, "src/cache.ts", LINE, {});
    expect([o!.edited_at, o!.request?.text]).toEqual(["2026-09-01T10:00:00Z", "do it"]);
    expect(o!.last).toEqual({
      edited_at: "2026-09-01T10:23:00Z", tool: "Edit",
      request: { ts: "2026-09-01T10:21:00Z", text: "go ahead" },
      reply_before: { ts: "2026-09-01T10:20:00Z", text: "A $slice on the push keeps it atomic; go?" },
    });
  });

  it("gives no last turn when every edit was in the first turn", () => {
    msg("u1", "a", "2026-09-01T09:56:00Z", "user", "do it");
    edit("e1", "a", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    edit("e2", "a", "2026-09-01T10:01:00Z", "/w/app/src/cache.ts", "", LINE);
    expect(lineOrigins(db, "src/cache.ts", LINE, {})[0]!.last).toBeNull();
  });

  it("cuts the request and the reply, and gives null for neither", () => {
    msg("r1", "a", "2026-09-01T09:55:00Z", "assistant", "x".repeat(2000));
    msg("u1", "a", "2026-09-01T09:56:00Z", "user", "y".repeat(800));
    edit("e1", "a", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    edit("e2", "b", "2026-09-02T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    const [a, b] = lineOrigins(db, "src/cache.ts", LINE, {});
    expect(a!.request!.text).toBe(`${"y".repeat(500)}…`);
    expect(a!.reply_before!.text).toBe(`${"x".repeat(1500)}…`);
    expect([b!.request, b!.reply_before]).toEqual([null, null]);
  });

  it("does not count a resumed session's copy of an edit as a second writer", () => {
    edit("e1", "a", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    // The resumed session "c" starts with a copy of the line, same uuid.
    db.prepare("INSERT INTO tool_call (event_uuid, session_id, ts, name, input_json) SELECT event_uuid, 'c', ts, name, input_json FROM tool_call WHERE event_uuid = 'e1'").run();
    db.prepare("INSERT INTO file_op (event_uuid, session_id, ts, tool, path) SELECT event_uuid, 'c', ts, tool, path FROM file_op WHERE event_uuid = 'e1'").run();
    expect(origins(LINE).map((o) => o[0])).toEqual(["a"]);
  });
});

describe("formatLineOrigins", () => {
  it("lists each session with its request and the reply before it", () => {
    msg("r1", "a", "2026-09-01T09:55:00Z", "assistant", "Keying by name avoids the hash; shall I?");
    msg("u1", "a", "2026-09-01T09:56:00Z", "user", "오케 그렇게 하자");
    edit("e1", "a", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    expect(formatLineOrigins("src/cache.ts", lineOrigins(db, "src/cache.ts", LINE, {})).split("\n")).toEqual([
      '"src/cache.ts": 1 session wrote this text',
      "2026-09-01T10:00:00Z  session:a  project:-w-app  claude  Edit",
      "  request 2026-09-01T09:56:00Z: 오케 그렇게 하자",
      "  reply before it 2026-09-01T09:55:00Z: Keying by name avoids the hash; shall I?",
    ]);
    edit("e2", "b", "2026-09-02T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    expect(formatLineOrigins("src/cache.ts", lineOrigins(db, "src/cache.ts", LINE, {})).split("\n")).toEqual([
      '"src/cache.ts": 2 sessions wrote this text, the first first',
      "2026-09-01T10:00:00Z  session:a  project:-w-app  claude  Edit",
      "  request 2026-09-01T09:56:00Z: 오케 그렇게 하자",
      "  reply before it 2026-09-01T09:55:00Z: Keying by name avoids the hash; shall I?",
      "2026-09-02T10:00:00Z  session:b  project:-w-app  codex  Edit",
    ]);
  });

  it("shows the turn that wrote the text again under its session", () => {
    msg("u1", "a", "2026-09-01T09:56:00Z", "user", "do it");
    edit("e1", "a", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    msg("r2", "a", "2026-09-01T10:20:00Z", "assistant", "A $slice keeps it atomic; go?");
    msg("u2", "a", "2026-09-01T10:21:00Z", "user", "go ahead");
    call("p1", "a", "2026-09-01T10:22:00Z", "apply_patch", patch(["src/cache.ts", [`+${LINE}`]]), ["/w/app/src/cache.ts"]);
    expect(formatLineOrigins("src/cache.ts", lineOrigins(db, "src/cache.ts", LINE, {})).split("\n")).toEqual([
      '"src/cache.ts": 1 session wrote this text',
      "2026-09-01T10:00:00Z  session:a  project:-w-app  claude  Edit",
      "  request 2026-09-01T09:56:00Z: do it",
      "  written again 2026-09-01T10:22:00Z  apply_patch",
      "    request 2026-09-01T10:21:00Z: go ahead",
      "    reply before it 2026-09-01T10:20:00Z: A $slice keeps it atomic; go?",
    ]);
  });

  it("prints each edit, request and reply time in the server's zone", () => {
    msg("r1", "a", "2026-09-01T09:55:00Z", "assistant", "Keying by name avoids the hash; shall I?");
    msg("u1", "a", "2026-09-01T09:56:00Z", "user", "오케 그렇게 하자");
    edit("e1", "a", "2026-09-01T10:00:00Z", "/w/app/src/cache.ts", "", LINE);
    msg("u2", "a", "2026-09-01T10:21:00Z", "user", "go ahead");
    call("p1", "a", "2026-09-01T10:22:00Z", "apply_patch", patch(["src/cache.ts", [`+${LINE}`]]), ["/w/app/src/cache.ts"]);
    const out = withTz("Asia/Seoul", () => formatLineOrigins("src/cache.ts", lineOrigins(db, "src/cache.ts", LINE, {})));
    expect(out.split("\n")).toEqual([
      '"src/cache.ts": 1 session wrote this text',
      "2026-09-01T19:00:00+09:00  session:a  project:-w-app  claude  Edit",
      "  request 2026-09-01T18:56:00+09:00: 오케 그렇게 하자",
      "  reply before it 2026-09-01T18:55:00+09:00: Keying by name avoids the hash; shall I?",
      "  written again 2026-09-01T19:22:00+09:00  apply_patch",
      "    request 2026-09-01T19:21:00+09:00: go ahead",
      "    reply before it 2026-09-01T18:55:00+09:00: Keying by name avoids the hash; shall I?",
    ]);
    expect(out).not.toMatch(UTC_TIME);
  });

  it("says where to look when no edit wrote the text", () => {
    expect(formatLineOrigins("src/cache.ts", [])).toBe(
      '"src/cache.ts": no stored edit wrote this text. Edits are stored up to 2 KB, and text written by shell commands is not matched; git blame and the commits parameter may find the commit\'s session.',
    );
  });
});
