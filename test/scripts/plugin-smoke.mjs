#!/usr/bin/env node
/**
 * plugin-smoke.mjs — runs the plugin folder the way Claude Code and Codex do,
 * from a copy outside the repository, so the bundles can reach only the
 * dependencies the plugin installs itself.
 *
 * Installs from plugin/package-lock.json as Claude Code does (`npm ci
 * --ignore-scripts`), indexes fixture sessions with `start.mjs index`,
 * starts the server with `start.mjs mcp` and searches it, records an item
 * in the ledger and lists it, runs the compaction hook for one session,
 * Codex's hold guidance hook with and without a working directory, and the
 * ledger list hook for the project of that item and for another one, runs
 * the tool-failure hook on a `gh` that another session found missing, and
 * asks which session wrote a line.
 * Runs in UTC, then starts a second server in Asia/Seoul to check that tools
 * and the compaction hook print local time and read times given back.
 * Needs `npm run build` first and the npm registry. Touches nothing outside
 * a temporary folder.
 *
 *   node test/scripts/plugin-smoke.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// A session whose `gh` call failed, for the tool-failure hook.
const line = (uuid, parentUuid, timestamp, type, content, sessionId = "gh") => ({ uuid, parentUuid, timestamp, type, sessionId, cwd: "/fixture/cwd", message: { role: type, content } });
writeFileSync(
  join(project, "gh.jsonl"),
  [
    line("g1", null, "2026-06-22T01:00:00Z", "user", "open the PR"),
    line("g2", "g1", "2026-06-22T01:00:05Z", "assistant", [{ type: "tool_use", id: "toolu_gh", name: "Bash", input: { command: "gh pr create" } }]),
    line("g3", "g2", "2026-06-22T01:00:06Z", "user", [{ type: "tool_result", tool_use_id: "toolu_gh", is_error: true, content: "Exit code 127\n(eval):1: command not found: gh" }]),
    line("g4", "g3", "2026-06-22T01:00:10Z", "assistant", [{ type: "text", text: "gh is not installed here, so I pushed with git." }]),
  ].map((l) => JSON.stringify(l)).join("\n") + "\n",
);
// A session that wrote a line after the user agreed to it, for clens_left_off's text.
const KEY_LINE = "const key = `${sessionId}:${name}`;";
writeFileSync(
  join(project, "why.jsonl"),
  [
    line("w1", null, "2026-06-22T02:00:00Z", "user", "make the cache key per session", "why"),
    line("w2", "w1", "2026-06-22T02:00:05Z", "assistant", [{ type: "text", text: "Keying the cache by session keeps two sessions apart; shall I?" }], "why"),
    line("w3", "w2", "2026-06-22T02:00:10Z", "user", "do it", "why"),
    line("w4", "w3", "2026-06-22T02:00:15Z", "assistant", [{ type: "tool_use", id: "toolu_why", name: "Edit", input: { file_path: "/fixture/cwd/src/cache.ts", old_string: "const key = name;", new_string: KEY_LINE } }], "why"),
    line("w5", "w4", "2026-06-22T02:00:16Z", "user", [{ type: "tool_result", tool_use_id: "toolu_why", content: "The file has been updated." }], "why"),
  ].map((l) => JSON.stringify(l)).join("\n") + "\n",
);
// A session just before midnight UTC, which is the next day in Asia/Seoul,
// for the local-time checks.
writeFileSync(
  join(project, "late.jsonl"),
  [
    line("l1", null, "2026-06-21T16:00:00.250Z", "user", "write the late night deploy note", "late"),
    line("l2", "l1", "2026-06-21T16:00:05.500Z", "assistant", [{ type: "text", text: "the deploy note is written" }], "late"),
  ].map((l) => JSON.stringify(l)).join("\n") + "\n",
);
cpSync(join(REPO, "plugin"), plugin, {
  recursive: true,
  filter: (src) => !["node_modules", ".clens-install.lock"].includes(basename(src)),
});

// TZ pins the zone the server prints times in, so the checks below hold on
// any machine; the local-time checks set their own.
const env = { ...getDefaultEnvironment(), ...dirs, TZ: "UTC" };
let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n${detail}`}`);
  if (!ok) failed = true;
};
const client = new Client({ name: "plugin-smoke", version: "0.0.0" });
const localClient = new Client({ name: "plugin-smoke-local", version: "0.0.0" });
const textOf = (result) => result.content?.[0]?.text ?? "";
try {
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: plugin, env, stdio: "ignore" });
  // The first run builds better-sqlite3 under the install lock. A lock left
  // by a process killed while installing, whose pid no longer runs, is taken
  // over at once, not after the 5 minutes a lock is otherwise waited for.
  const lock = join(plugin, ".clens-install.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(spawnSync(process.execPath, ["-e", ""]).pid));
  const first = spawnSync("node", ["start.mjs", "index"], { cwd: plugin, env, stdio: "ignore", timeout: 150_000 });
  check("install lock of a dead process", first.status === 0 && !existsSync(lock), `status ${first.status}, signal ${first.signal}, lock left: ${existsSync(lock)}`);

  await client.connect(new StdioClientTransport({ command: "node", args: [join(plugin, "start.mjs"), "mcp"], cwd: plugin, env }));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort().join(",");
  check("tools", names === "clens_hold,clens_left_off,clens_pending,clens_recent,clens_search,clens_session,clens_stats", names);
  const holdProps = tools.find((t) => t.name === "clens_hold").inputSchema.properties;
  const holdLimits = [holdProps.item.maxLength, holdProps.words.maxLength, holdProps.waits_for.maxLength].join(",");
  check("clens_hold length limits", holdLimits === "300,500,200", holdLimits);
  const found = await client.callTool({ name: "clens_search", arguments: { query: "brainstorming", project_id: "-fixture-cwd", limit: 3 } });
  const text = found.content?.[0]?.text ?? "";
  check("search", !found.isError && text.includes("session:test"), text);
  const wrote = await client.callTool({ name: "clens_left_off", arguments: { file: "src/cache.ts", text: KEY_LINE } });
  const wroteText = wrote.content?.[0]?.text ?? "";
  check("line origin", !wrote.isError && wroteText.includes("session:why") && wroteText.includes("request 2026-06-22T02:00:10") && wroteText.includes("shall I?"), wroteText);
  const noFile = await client.callTool({ name: "clens_left_off", arguments: { text: KEY_LINE } });
  check("line origin (no file)", noFile.isError === true && (noFile.content?.[0]?.text ?? "").includes("text needs file"), JSON.stringify(noFile));
  const held = await client.callTool({
    name: "clens_hold",
    arguments: { project_id: "-fixture-cwd", item: "Add a due date to tasks", status: "held", words: "let's park it" },
  });
  const heldText = held.content?.[0]?.text ?? "";
  const pending = await client.callTool({ name: "clens_pending", arguments: { project_id: "-fixture-cwd" } });
  const pendingText = pending.content?.[0]?.text ?? "";
  check(
    "hold and pending",
    !held.isError && heldText.startsWith("Recorded ") && !pending.isError &&
      pendingText.includes("Ledger for -fixture-cwd: 1 held, 0 dropped, 0 done") &&
      pendingText.includes("Add a due date to tasks") && pendingText.includes(`words: "let's park it"`),
    `${heldText}\n${pendingText}`,
  );
  // An agent that replaces only the slashes sends -fixture.cwd for a
  // directory /fixture.cwd; the server turns it into Claude Code's id.
  const dotFound = await client.callTool({ name: "clens_search", arguments: { query: "brainstorming", project_id: "-fixture.cwd", limit: 3 } });
  const dotFoundText = dotFound.content?.[0]?.text ?? "";
  const dotPending = await client.callTool({ name: "clens_pending", arguments: { project_id: "-fixture.cwd" } });
  const dotPendingText = dotPending.content?.[0]?.text ?? "";
  check(
    "project id with a dot",
    !dotFound.isError && dotFoundText.includes("session:test") && !dotPending.isError &&
      dotPendingText.includes("Ledger for -fixture-cwd: 1 held, 0 dropped, 0 done"),
    `${dotFoundText}\n${dotPendingText}`,
  );

  const hook = execFileSync("node", [join(plugin, "hooks", "compact.mjs")], {
    env,
    input: JSON.stringify({ session_id: "test", source: "compact" }),
    encoding: "utf8",
  });
  check("compact hook", hook.includes('"additionalContext":"clens work record of this session'), hook.slice(0, 500));
  const compactGarbage = execFileSync("node", [join(plugin, "hooks", "compact.mjs")], { env, input: "", encoding: "utf8" });
  check("compact hook (bad input)", compactGarbage === "", compactGarbage.slice(0, 500));
  const guidance = execFileSync("node", [join(plugin, "hooks", "hold_guidance.mjs")], {
    env,
    input: JSON.stringify({ source: "startup" }),
    encoding: "utf8",
  });
  check("hold guidance hook", guidance.includes('"hookEventName":"SessionStart"') && guidance.includes("call clens_hold"), guidance.slice(0, 500));
  // The item recorded above for -fixture-cwd, listed for a session in /fixture/cwd.
  const runHook = (name, input) =>
    execFileSync("node", [join(plugin, "hooks", name)], { env, input: JSON.stringify(input), encoding: "utf8" });
  const ledgerList = runHook("ledger_list.mjs", { source: "startup", cwd: "/fixture/cwd" });
  check("ledger list hook", ledgerList.includes('"hookEventName":"SessionStart"') && ledgerList.includes("Add a due date to tasks"), ledgerList.slice(0, 500));
  const otherList = runHook("ledger_list.mjs", { source: "startup", cwd: "/elsewhere" });
  check("ledger list hook (other project)", otherList === "", otherList.slice(0, 500));
  const guidanceList = runHook("hold_guidance.mjs", { source: "startup", cwd: "/fixture/cwd" });
  check("hold guidance hook (with list)", guidanceList.includes("call clens_hold") && guidanceList.includes("Add a due date to tasks"), guidanceList.slice(0, 500));

  const failure = execFileSync("node", [join(plugin, "hooks", "tool_failure.mjs")], {
    env,
    input: JSON.stringify({
      hook_event_name: "PostToolUseFailure", session_id: "later", cwd: "/fixture/cwd", tool_name: "Bash",
      tool_input: { command: "gh run list" }, error: "Exit code 127\n(eval):1: command not found: gh",
    }),
    encoding: "utf8",
  });
  check("tool failure hook", failure.includes("pushed with git"), failure.slice(0, 500));
  // Codex sends PostToolUse with the output as tool_response, and wants its event name back.
  const codexInput = JSON.stringify({
    hook_event_name: "PostToolUse", session_id: "later-codex", cwd: "/fixture/cwd", tool_name: "Bash",
    tool_input: { command: "gh run list" }, tool_response: "zsh:1: command not found: gh\n",
  });
  const codexFailure = execFileSync("node", [join(plugin, "hooks", "tool_failure.mjs")], { env, input: codexInput, encoding: "utf8" });
  check("tool failure hook (Codex)", codexFailure.includes('"hookEventName":"PostToolUse"') && codexFailure.includes("pushed with git"), codexFailure.slice(0, 500));
  const codexAgain = execFileSync("node", [join(plugin, "hooks", "tool_failure.mjs")], { env, input: codexInput, encoding: "utf8" });
  check("tool failure hook (once per session)", codexAgain === "", codexAgain.slice(0, 500));
  const garbage = execFileSync("node", [join(plugin, "hooks", "tool_failure.mjs")], { env, input: "not json", encoding: "utf8" });
  check("tool failure hook (bad input)", garbage === "", garbage.slice(0, 500));

  const localEnv = { ...env, TZ: "Asia/Seoul" };
  await localClient.connect(new StdioClientTransport({ command: "node", args: [join(plugin, "start.mjs"), "mcp"], cwd: plugin, env: localEnv }));
  const localHit = textOf(await localClient.callTool({
    name: "clens_search", arguments: { query: "deploy note", session_id: "late", role: "user", limit: 1 },
  }));
  check("local search", localHit.includes("2026-06-22T01:00:00.250+09:00  session:late"), localHit);
  const around = textOf(await localClient.callTool({
    name: "clens_session", arguments: { session_id: "late", around_ts: "2026-06-22T01:00:00.250+09:00", limit: 1 },
  }));
  check("local session", around.includes("USER 2026-06-22T01:00:00.250+09:00") && around.includes("write the late night deploy note"), around);
  const sinceArgs = { query: "deploy note", project_id: "-fixture-cwd", since: "2026-06-22" };
  const localSince = await localClient.callTool({ name: "clens_search", arguments: sinceArgs });
  const utcSince = textOf(await client.callTool({ name: "clens_search", arguments: sinceArgs }));
  check(
    "local since",
    !localSince.isError && textOf(localSince).includes("session:late") && utcSince === "No results found.",
    `${textOf(localSince)}\n--- UTC:\n${utcSince}`,
  );
  const badTime = await localClient.callTool({ name: "clens_search", arguments: { query: "deploy note", since: "yesterday" } });
  check(
    "bad time",
    badTime.isError === true && textOf(badTime).startsWith("Invalid params") && textOf(badTime).includes("not a date or time"),
    JSON.stringify(badTime),
  );
  const localPending = textOf(await localClient.callTool({ name: "clens_pending", arguments: { project_id: "-fixture-cwd" } }));
  check("local pending", /\+09:00/.test(localPending) && !/\d{2}:\d{2}:\d{2}(\.\d+)?Z/.test(localPending), localPending);
  const localHook = execFileSync("node", [join(plugin, "hooks", "compact.mjs")], {
    env: localEnv,
    input: JSON.stringify({ session_id: "late", source: "compact" }),
    encoding: "utf8",
  });
  check("local compact hook", localHook.includes("2026-06-22T01:00:00.250+09:00"), localHook.slice(0, 500));
} catch (e) {
  check("run", false, e instanceof Error ? e.message : String(e));
} finally {
  await client.close().catch(() => {});
  await localClient.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
