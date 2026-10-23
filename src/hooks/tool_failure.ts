#!/usr/bin/env node
// PostToolUseFailure hook in Claude Code, PostToolUse in Codex (which has no
// failure event and runs it after every command): when a shell command fails
// in a way a retry does not fix, tell the agent what an earlier session did
// after the same failure (failure_hint.ts). `npm run build` bundles it into
// plugin/hooks/tool_failure.mjs.
//
// Like compact.ts, it adds nothing rather than failing while better-sqlite3
// is not installed yet or there is no index.
import { alreadyTold, failureHint, hintKey, rememberTold } from "./failure_hint.js";
import { hintsSeenDir, indexDbPath } from "../util/paths.js";

let Database: typeof import("better-sqlite3");
try {
  ({ default: Database } = await import("better-sqlite3"));
} catch {
  process.exit(0);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
let event: {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: { command?: unknown };
  error?: unknown;
  tool_response?: unknown;
};
try {
  event = JSON.parse(input);
} catch {
  process.exit(0);
}
const sessionId = event.session_id;
if (event.tool_name !== "Bash" || typeof sessionId !== "string") process.exit(0);
// Claude Code passes the failure as `error`; Codex passes every command's
// output as `tool_response`, with no exit code.
const output =
  typeof event.error === "string" ? event.error : typeof event.tool_response === "string" ? event.tool_response : JSON.stringify(event.tool_response ?? "");
// Most outputs, all of Codex's successful ones, have no key: done before the
// index is opened.
const key = hintKey(output);
if (!key || alreadyTold(hintsSeenDir(), sessionId, key.key)) process.exit(0);

let hint: string | null;
try {
  const db = new Database(indexDbPath(), { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 2000");
  hint = failureHint(
    db,
    { sessionId, cwd: typeof event.cwd === "string" ? event.cwd : null, command: String(event.tool_input?.command ?? ""), output },
    Date.now(),
  );
  db.close();
} catch {
  process.exit(0);
}
if (!hint) process.exit(0);
try {
  rememberTold(hintsSeenDir(), sessionId, key.key, Date.now());
} catch {
  // Not noted: the hint may come again in this session, but it still goes out.
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: typeof event.hook_event_name === "string" ? event.hook_event_name : "PostToolUseFailure",
      additionalContext: hint,
    },
  }),
);
