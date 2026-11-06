#!/usr/bin/env node
// SessionStart hook (matcher "startup|resume|clear|compact"), registered for
// Claude Code only (plugin/hooks/hooks.json): lists the held and dropped items
// of the project the session runs in from clens's ledger, so the agent marks
// a held item done when it finishes it and does not propose a dropped one
// again. Claude Code reads the guidance itself (HOLD_GUIDANCE) from the server
// instructions; Codex gets the list from src/hooks/hold_guidance.ts. `npm run
// build` bundles it into plugin/hooks/ledger_list.mjs.
import { ledgerContext } from "./ledger_context.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const list = ledgerContext(input);
if (list === null) process.exit(0);

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: list } }),
);
