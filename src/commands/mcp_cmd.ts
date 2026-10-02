/**
 * `clens mcp` — starts the MCP stdio server.
 *
 * This is a thin shim that just re-executes the compiled MCP server entrypoint
 * as a child process so the server's top-level await doesn't pollute the CLI
 * dispatcher's own async context.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

export async function mcpCommand(): Promise<number> {
  // This file compiles to dist/commands/; the server is dist/mcp/server.js.
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.js");
  const child = spawn(process.execPath, [serverPath], {
    stdio: "inherit",
    env: process.env,
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
