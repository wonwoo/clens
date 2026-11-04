import { describe, expect, it } from "vitest";

import {
  HOLD_DESCRIPTION,
  HOLD_GUIDANCE,
  PENDING_DESCRIPTION,
  SEARCH_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  STATS_DESCRIPTION,
} from "../src/mcp/instructions.js";

// Claude Code cuts server instructions and each tool description without
// telling the agent, so text past the cut never arrives: at 4,096 characters
// in 2.1.318, at 2,048 in older releases.
describe("text sent to the agent", () => {
  it("fits Claude Code's 4,096-character cap, and keeps all but the ledger paragraph within 2,048", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
    expect(SERVER_INSTRUCTIONS.endsWith("\n\n" + HOLD_GUIDANCE)).toBe(true);
    expect(SERVER_INSTRUCTIONS.length - HOLD_GUIDANCE.length - 2).toBeLessThanOrEqual(2048);
    expect(SEARCH_DESCRIPTION.length).toBeLessThanOrEqual(2048);
    expect(STATS_DESCRIPTION.length).toBeLessThanOrEqual(2048);
    expect(HOLD_DESCRIPTION.length).toBeLessThanOrEqual(2048);
    expect(PENDING_DESCRIPTION.length).toBeLessThanOrEqual(2048);
  });

  // Picking one option recorded the others as held (R1, R5) until the
  // guidance said otherwise.
  it("tells the agent to record each set-aside item, and not the options left out of a pick", () => {
    expect(HOLD_GUIDANCE).toContain("call clens_hold once per item");
    expect(HOLD_GUIDANCE).toContain("picking one option");
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
