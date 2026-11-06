#!/usr/bin/env node
// SessionStart hook, registered for Codex only (plugin/.codex-plugin/hooks.json):
// tells the agent to record in clens's ledger what the user sets aside
// (HOLD_GUIDANCE), then lists the held and dropped items of the project the
// session runs in (src/hooks/ledger_context.ts). Codex does not pass MCP
// server instructions to the model, where Claude Code reads the same text and
// gets the list from src/hooks/ledger_list.ts. `npm run build` bundles it into
// plugin/hooks/hold_guidance.mjs.
import { HOLD_GUIDANCE } from "../mcp/instructions.js";
import { ledgerContext } from "./ledger_context.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const list = ledgerContext(input);
const additionalContext = list === null ? HOLD_GUIDANCE : `${HOLD_GUIDANCE}\n\n${list}`;

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }),
);
