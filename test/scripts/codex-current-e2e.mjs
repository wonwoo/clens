#!/usr/bin/env node
/**
 * codex-current-e2e.mjs — end-to-end check that the built MCP server
 * resolves session_id "current" from a Codex tool call's _meta.
 *
 * Indexes a one-session Codex rollout into a temporary index with the built
 * CLI, starts dist/mcp/server.js over stdio and calls clens_left_off with
 * session_id "current": once with Codex's x-codex-turn-metadata in _meta
 * (must return that session's record) and once without it (must refuse).
 * Needs `npm run build` first. Touches nothing outside a temporary folder.
 *
 *   node test/scripts/codex-current-e2e.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SESSION = "codex-e2e";

const root = mkdtempSync(join(tmpdir(), "clens-codex-e2e-"));
const dirs = {
  CLENS_HOME: join(root, ".claude"),
  CLENS_CODEX_HOME: join(root, ".codex"),
  CLENS_INDEX_DIR: join(root, ".clens"),
};
const day = join(dirs.CLENS_CODEX_HOME, "sessions", "2026", "09", "29");
for (const dir of [dirs.CLENS_HOME, day, dirs.CLENS_INDEX_DIR]) mkdirSync(dir, { recursive: true });

const said = (ts, type, part, text) => ({
  timestamp: ts,
  type: "event_msg",
  payload: { type: "item_completed", item: { type, id: `i-${ts}`, content: [{ type: part, text }] } },
});
writeFileSync(
  join(day, `rollout-2026-09-29T00-00-00-${SESSION}.jsonl`),
  [
    { timestamp: "2026-09-29T00:00:00Z", type: "session_meta", payload: { id: SESSION, cwd: "/w/app", source: "cli" } },
    said("2026-09-29T00:00:01Z", "UserMessage", "text", "fix the login bug"),
    said("2026-09-29T00:00:02Z", "AgentMessage", "Text", "Fixed."),
  ].map((line) => JSON.stringify(line)).join("\n") + "\n",
);

// Only the paths go to the children: a CLAUDE_CODE_SESSION_ID in this
// shell's environment would otherwise name a session for the call without
// _meta.
const env = { ...getDefaultEnvironment(), ...dirs };
let failed = false;
const client = new Client({ name: "codex-current-e2e", version: "0.0.0" });
try {
  execFileSync("node", [join(REPO, "dist", "cli.js"), "index"], { env, stdio: "ignore" });
  await client.connect(new StdioClientTransport({ command: "node", args: [join(REPO, "dist", "mcp", "server.js")], env }));

  const textOf = (r) => (r.content?.[0]?.type === "text" ? r.content[0].text : "");
  const withMeta = await client.callTool({
    name: "clens_left_off",
    arguments: { session_id: "current" },
    _meta: { "x-codex-turn-metadata": { session_id: SESSION, thread_id: SESSION, turn_id: "t1" } },
  });
  const a = textOf(withMeta);
  if (!withMeta.isError && a.startsWith(`session:${SESSION}  project:-w-app  codex`) && a.includes("fix the login bug")) {
    console.log("PASS with _meta");
  } else {
    failed = true;
    console.log(`FAIL with _meta\n${a}`);
  }

  const withoutMeta = await client.callTool({ name: "clens_left_off", arguments: { session_id: "current" } });
  const b = textOf(withoutMeta);
  if (withoutMeta.isError && b.startsWith('session_id "current" is not available here')) {
    console.log("PASS without _meta");
  } else {
    failed = true;
    console.log(`FAIL without _meta\n${b}`);
  }
} catch (e) {
  failed = true;
  console.log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await client.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
