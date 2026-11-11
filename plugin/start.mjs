#!/usr/bin/env node
// Entry point of the clens plugin, for Claude Code and Codex: `start.mjs mcp`
// runs the MCP server, any other arguments run the clens CLI.
//
// Neither tool builds a plugin, and neither installs a working
// better-sqlite3: Codex copies the plugin and installs nothing, and Claude
// Code runs `npm ci --ignore-scripts`, which skips the script that fetches
// better-sqlite3's native binary. So the first run installs the runtime
// dependencies into this folder, or rebuilds better-sqlite3, before loading
// dist/, the bundles `npm run build` writes from the repository's src/.
//
// The server runs in this process, not a child: it finds the calling
// session through its parent process (detectCurrentSessionId).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const deps = Object.keys(pkg.dependencies ?? {});
const log = (msg) => process.stderr.write(`clens: ${msg}\n`);

const missing = () => deps.filter((name) => !existsSync(join(root, "node_modules", name, "package.json")));
function sqliteLoads() {
  try {
    const Database = createRequire(join(root, "package.json"))("better-sqlite3");
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
}

// npm's own CLI run through this node, so a missing or different `npm` on
// PATH does not matter; npm's output goes to stderr, since stdout carries
// the MCP protocol.
function npm(args) {
  const beside = process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const [file, argv] = existsSync(beside)
    ? [process.execPath, [beside, ...args]]
    : [process.platform === "win32" ? "npm.cmd" : "npm", args];
  execFileSync(file, argv, { cwd: root, stdio: ["ignore", 2, 2], shell: process.platform === "win32" && file === "npm.cmd" });
}

// Whether the process that took the install lock is gone, killed while
// installing: its pid, written in the lock, no longer runs. False while the
// pid is not written yet.
function holderGone(lock) {
  let pid;
  try {
    pid = Number(readFileSync(join(lock, "pid"), "utf8"));
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e?.code === "ESRCH";
  }
}

// Sessions that start together must not run npm in the same folder at once:
// the first takes a lock directory, the others wait for it to go.
function withInstallLock(fn) {
  const lock = join(root, ".clens-install.lock");
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      const stale = (() => { try { return Date.now() - statSync(lock).mtimeMs > 5 * 60_000; } catch { return false; } })();
      if (stale || holderGone(lock) || Date.now() > deadline) rmSync(lock, { recursive: true, force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  try {
    writeFileSync(join(lock, "pid"), String(process.pid));
    fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function ensureDependencies() {
  if (missing().length === 0 && sqliteLoads()) return;
  withInstallLock(() => {
    if (missing().length > 0) {
      log("installing runtime dependencies (first run only)…");
      // Without scripts, as Claude Code installs; the rebuild below fetches
      // better-sqlite3's binary.
      npm(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
    }
    if (!sqliteLoads()) {
      log("building better-sqlite3 for this Node.js (first run only)…");
      npm(["rebuild", "better-sqlite3"]);
    }
  });
  if (missing().length > 0 || !sqliteLoads()) {
    throw new Error(`dependencies could not be installed in ${root}; run \`npm install --omit=dev\` there`);
  }
}

try {
  ensureDependencies();
} catch (e) {
  log(`${e?.message ?? e}`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "mcp") {
  await import(pathToFileURL(join(root, "dist", "server.js")).href);
} else {
  process.argv = [process.argv[0], join(root, "dist", "cli.js"), ...(command === undefined ? [] : [command, ...rest])];
  await import(pathToFileURL(join(root, "dist", "cli.js")).href);
}
