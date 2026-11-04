#!/usr/bin/env node
// SessionStart hook, registered for Codex only (plugin/.codex-plugin/hooks.json):
// tells the agent to record in clens's ledger what the user sets aside
// (HOLD_GUIDANCE). Codex does not pass MCP server instructions to the model,
// where Claude Code reads the same text. `npm run build` bundles it into
// plugin/hooks/hold_guidance.mjs.
import { HOLD_GUIDANCE } from "../mcp/instructions.js";

// Codex writes the event to stdin; the text is the same for every source, so
// it is read only to let Codex finish writing.
for await (const _ of process.stdin);

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: HOLD_GUIDANCE } }),
);
