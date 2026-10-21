// `npm run build`: bundles src/ into the plugin folder, plugin/, which both
// Claude Code and Codex install as it is in git, and writes the plugin's
// package.json. Its dependencies are the two packages left out of the bundles,
// which plugin/start.mjs installs on a first run: better-sqlite3 is a native
// module, and kiwi-nlp loads the .wasm file beside its own entry.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const EXTERNAL = ["better-sqlite3", "kiwi-nlp"];

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: EXTERNAL,
  logLevel: "warning",
  // CommonJS dependencies such as proper-lockfile call require(), which an
  // ES module has not got.
  banner: { js: "import { createRequire as __clensRequire } from 'node:module'; const require = __clensRequire(import.meta.url);" },
};
await build({ ...common, entryPoints: ["src/mcp/server.ts"], outfile: "plugin/dist/server.js" });
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "plugin/dist/cli.js" });
await build({ ...common, entryPoints: ["src/hooks/compact.ts"], outfile: "plugin/hooks/compact.mjs" });
chmodSync("plugin/dist/cli.js", 0o755);

const root = JSON.parse(readFileSync("package.json", "utf8"));
const pkg = {
  name: root.name,
  version: root.version,
  private: true,
  license: root.license,
  type: "module",
  engines: root.engines,
  dependencies: Object.fromEntries(EXTERNAL.map((name) => [name, root.dependencies[name]])),
};
const text = JSON.stringify(pkg, null, 2) + "\n";
if (!existsSync("plugin/package-lock.json") || readFileSync("plugin/package.json", "utf8") !== text) {
  writeFileSync("plugin/package.json", text);
  // Claude Code installs a plugin's dependencies from its lockfile.
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: "plugin", stdio: "inherit" });
}
