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

  // "도커 빼고" while cleaning a disk was recorded as dropped: the rule asked
  // only whether something would not be done, not whether it outlives the task.
  it("keeps what only shapes the task at hand out of the ledger, and records work the user asks to note", () => {
    expect(HOLD_GUIDANCE).toContain("What only shapes the task at hand ends with it and is not recorded");
    expect(HOLD_GUIDANCE).toContain("record it as held");
    expect(HOLD_DESCRIPTION).toContain("Not for what only shapes the task at hand");
  });

  // The SessionStart hooks list the project's held and dropped items, so an
  // agent marks a finished item done in any session, not only after
  // clens_pending (the sentence tested in the 2026-11-05 runs R1-R15).
  it("tells the agent to mark a listed held item done, leave partial work held, and not propose a dropped item again", () => {
    expect(HOLD_GUIDANCE).toContain(
      "When you finish an item listed as held, at the start of the session or by clens_pending, record it done with clens_hold and its id",
    );
    expect(HOLD_GUIDANCE).toContain("if only part of it is done, leave it held");
    expect(HOLD_GUIDANCE).toContain("Do not propose a dropped item again unless the user brings it up");
    expect(HOLD_GUIDANCE).not.toContain("When you finish an item clens_pending listed as held");
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

  // "session_id and ts" sent agents to pass `ts`, which clens_session rejects.
  it("names clens_session's around_ts", () => {
    expect(SERVER_INSTRUCTIONS).toContain("session_id and ts as around_ts");
  });
});
