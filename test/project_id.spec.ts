import { describe, expect, it } from "vitest";

import { normalizeProjectId, projectIdOf } from "../src/util/project_id.js";

describe("util/project_id.ts — projectIdOf", () => {
  // The ids Claude Code 2.1.322 gives these directories: every character
  // other than a letter or digit becomes a dash, and a name over 200
  // characters is cut to 200 plus a dash and a hash of the path.
  it("gives Claude Code's directory name for a path", () => {
    expect(
      [
        "/Users/x/.claude/mascot",
        "/Users/x/Documents/New project",
        "/w/" + "a".repeat(250) + "/b.c",
        "C:\\Users\\x\\app",
        "/w/app",
      ].map(projectIdOf),
    ).toEqual([
      "-Users-x--claude-mascot",
      "-Users-x-Documents-New-project",
      "-w-" + "a".repeat(197) + "-nio7yp",
      "C--Users-x-app",
      "-w-app",
    ]);
  });
});

describe("util/project_id.ts — normalizeProjectId", () => {
  it("turns a slash-only id into Claude Code's and leaves one already in that form", () => {
    expect(["-Users-x-.claude-mascot", "-w-app", ""].map(normalizeProjectId)).toEqual(["-Users-x--claude-mascot", "-w-app", ""]);
  });
});
