#!/usr/bin/env node
// SessionStart hook (matcher "compact"): right after Claude Code or Codex
// compacts a conversation, put that session's clens work record back into its
// context, the record clens_left_off gives for session_id "current". `npm run
// build` bundles it into plugin/hooks/compact.mjs.
//
// In the plugin, the MCP server's first run installs better-sqlite3
// (plugin/start.mjs). Until it has, or while there is no index yet, the hook
// adds nothing rather than failing.
import { formatSessionRecordWithin, sessionRecord } from "../mcp/left_off.js";
import { indexDbPath } from "../util/paths.js";

let Database: typeof import("better-sqlite3");
try {
  ({ default: Database } = await import("better-sqlite3"));
} catch {
  process.exit(0);
}

// Claude Code moves a hook's output of about 10,000 characters or more to a
// file and shows only its start.
const MAX_CHARS = 9000;
const END = "END-OF-CLENS-RECORD";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { session_id: sessionId, source } = JSON.parse(input);
if (source !== "compact" || typeof sessionId !== "string") process.exit(0);

let record;
try {
  const db = new Database(indexDbPath(), { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  record = sessionRecord(db, sessionId);
  db.close();
} catch {
  process.exit(0);
}
if (!record) process.exit(0);

const head =
  "clens work record of this session, from its transcript (the conversation was just compacted). " +
  "Read more of it with clens_session.\n";
const room = MAX_CHARS - head.length - END.length - 80;
let body = formatSessionRecordWithin(record, room);
if (body.length > room) body = body.slice(0, room) + `\n… cut; clens_left_off session_id "current" gives it whole.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${head}${body}\n${END}` },
  }),
);
