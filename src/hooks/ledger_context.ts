// The ledger list both SessionStart hooks print (src/hooks/ledger_list.ts in
// Claude Code, src/hooks/hold_guidance.ts in Codex): the held and dropped
// items of the project the session runs in, so an agent in any session can
// mark a held item done by its id and does not propose a dropped one again.
// It reads only the ledger file, never the index, so it needs neither
// better-sqlite3 nor the MCP server.
import { formatLedgerList, readLedger } from "../mcp/ledger.js";
import { ledgerPath } from "../util/paths.js";

/** The ledger list for the project of a SessionStart hook input (the JSON
 *  text the hook reads from stdin), or null when there is nothing to add.
 *  Never throws: a session must start whatever the input or the ledger. */
export function ledgerContext(input: string): string | null {
  let event: unknown;
  try {
    event = JSON.parse(input);
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const { cwd } = event as { cwd?: unknown };
  if (typeof cwd !== "string" || cwd === "") return null;
  // The project_id the tools tell the agent to pass (HOLD_DESCRIPTION).
  const project_id = cwd.replace(/\//g, "-");
  let ledger;
  try {
    ledger = readLedger(ledgerPath());
  } catch {
    return null;
  }
  return formatLedgerList(ledger.items, project_id);
}
