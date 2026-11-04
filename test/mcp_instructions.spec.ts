import { describe, expect, it } from "vitest";

import { SEARCH_DESCRIPTION, SERVER_INSTRUCTIONS, STATS_DESCRIPTION } from "../src/mcp/instructions.js";

// Claude Code cuts server instructions and each tool description at 2,048
// characters without telling the agent, so text past that never arrives.
describe("text sent to the agent", () => {
  it("fits Claude Code's 2,048-character cap", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
    expect(SEARCH_DESCRIPTION.length).toBeLessThanOrEqual(2048);
    expect(STATS_DESCRIPTION.length).toBeLessThanOrEqual(2048);
  });

  it("sends the agent to a branch's checks when asked whether work was tested or deployed", () => {
    expect(SERVER_INSTRUCTIONS).toContain("(clens_left_off branch)");
  });

  it("tells the agent to fetch the current session's record after compaction", () => {
    expect(SERVER_INSTRUCTIONS).toContain('session_id "current" after compaction');
  });

  // Agents read their own transcript file to get back turns a compaction
  // dropped, taking "what is already in this conversation" to cover them.
  it("sends the agent to clens_session, not the transcript, for turns a compaction dropped", () => {
    expect(SERVER_INSTRUCTIONS).toContain('Earlier turns a compaction dropped are not in it: read them with clens_session, session_id "current"');
    expect(SERVER_INSTRUCTIONS).not.toContain("already in this conversation");
    expect(SEARCH_DESCRIPTION).toContain("unless a compaction dropped them");
  });
});
