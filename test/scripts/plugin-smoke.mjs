#!/usr/bin/env node
/**
 * plugin-smoke.mjs — runs the plugin folder the way Claude Code and Codex do,
 * from a copy outside the repository, so the bundles can reach only the
 * dependencies the plugin installs itself.
 *
 * Installs from plugin/package-lock.json as Claude Code does (`npm ci
 * --ignore-scripts`), indexes a fixture session with `start.mjs index`,
 * starts the server with `start.mjs mcp` and searches it, and runs the
 * compaction hook for that session. Needs `npm run build` first and the npm
 * registry. Touches nothing outside a temporary folder.
 *
 *   node test/scripts/plugin-smoke.mjs
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const root = mkdtempSync(join(tmpdir(), "clens-plugin-smoke-"));
const plugin = join(root, "plugin");
const dirs = {
  CLENS_HOME: join(root, ".claude"),
  CLENS_CODEX_HOME: join(root, ".codex"),
  CLENS_INDEX_DIR: join(root, ".clens"),
};
const project = join(dirs.CLENS_HOME, "projects", "-fixture-cwd");
for (const dir of [project, dirs.CLENS_CODEX_HOME, dirs.CLENS_INDEX_DIR]) mkdirSync(dir, { recursive: true });
cpSync(join(REPO, "test", "fixtures", "brainstorm-session.jsonl"), join(project, "test.jsonl"));
cpSync(join(REPO, "plugin"), plugin, {
  recursive: true,
  filter: (src) => !["node_modules", ".clens-install.lock"].includes(basename(src)),
});

const env = { ...getDefaultEnvironment(), ...dirs };
let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n${detail}`}`);
  if (!ok) failed = true;
};
const client = new Client({ name: "plugin-smoke", version: "0.0.0" });
try {
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: plugin, env, stdio: "ignore" });
  execFileSync("node", ["start.mjs", "index"], { cwd: plugin, env, stdio: "ignore" });

  await client.connect(new StdioClientTransport({ command: "node", args: [join(plugin, "start.mjs"), "mcp"], cwd: plugin, env }));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort().join(",");
  check("tools", names === "clens_left_off,clens_recent,clens_search,clens_session,clens_stats", names);
  const found = await client.callTool({ name: "clens_search", arguments: { query: "brainstorming", project_id: "-fixture-cwd", limit: 3 } });
  const text = found.content?.[0]?.text ?? "";
  check("search", !found.isError && text.includes("session:test"), text);

  const hook = execFileSync("node", [join(plugin, "hooks", "compact.mjs")], {
    env,
    input: JSON.stringify({ session_id: "test", source: "compact" }),
    encoding: "utf8",
  });
  check("compact hook", hook.includes('"additionalContext":"clens work record of this session'), hook.slice(0, 500));
} catch (e) {
  check("run", false, e instanceof Error ? e.message : String(e));
} finally {
  await client.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
