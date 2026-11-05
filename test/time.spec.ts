import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { timeParam } from "../src/mcp/time_param.js";
import { localTs, TIME_INPUT_HINT, utcBound } from "../src/util/time.js";
import { withTz } from "./tz.js";

// Expected values are E7's table (docs/experiments/2026-11-05-local-time/e7-output.txt).
const STORED = ["2026-11-05T01:20:20.871Z", "2026-06-22T02:00:10Z", "2026-03-08T07:30:00.000Z"] as const;
const INPUTS = [
  "2026-11-04", "2026-02-30", "2026-11-04T10:00", "2026-11-04 10:00", "2026-11-05T10:20:20.871+09:00",
  "2026-11-05T01:20:20.871Z", "2026-11-04t10:00z", "2026-11", "yesterday", "", " 2026-11-04 ",
] as const;

const ZONES: Record<string, { local: string[]; bound: (string | null)[] }> = {
  UTC: {
    local: ["2026-11-05T01:20:20.871Z", "2026-06-22T02:00:10Z", "2026-03-08T07:30:00.000Z"],
    bound: [
      "2026-11-04T00:00:00.000Z", null, "2026-11-04T10:00:00.000Z", "2026-11-04T10:00:00.000Z", "2026-11-05T01:20:20.871Z",
      "2026-11-05T01:20:20.871Z", "2026-11-04T10:00:00.000Z", null, null, null, "2026-11-04T00:00:00.000Z",
    ],
  },
  "Asia/Seoul": {
    local: ["2026-11-05T10:20:20.871+09:00", "2026-06-22T11:00:10+09:00", "2026-03-08T16:30:00.000+09:00"],
    bound: [
      "2026-11-03T15:00:00.000Z", null, "2026-11-04T01:00:00.000Z", "2026-11-04T01:00:00.000Z", "2026-11-05T01:20:20.871Z",
      "2026-11-05T01:20:20.871Z", "2026-11-04T10:00:00.000Z", null, null, null, "2026-11-03T15:00:00.000Z",
    ],
  },
  "America/New_York": {
    local: ["2026-11-04T20:20:20.871-05:00", "2026-06-21T22:00:10-04:00", "2026-03-08T03:30:00.000-04:00"],
    bound: [
      "2026-11-04T05:00:00.000Z", null, "2026-11-04T15:00:00.000Z", "2026-11-04T15:00:00.000Z", "2026-11-05T01:20:20.871Z",
      "2026-11-05T01:20:20.871Z", "2026-11-04T10:00:00.000Z", null, null, null, "2026-11-04T05:00:00.000Z",
    ],
  },
  "Asia/Kathmandu": {
    local: ["2026-11-05T07:05:20.871+05:45", "2026-06-22T07:45:10+05:45", "2026-03-08T13:15:00.000+05:45"],
    bound: [
      "2026-11-03T18:15:00.000Z", null, "2026-11-04T04:15:00.000Z", "2026-11-04T04:15:00.000Z", "2026-11-05T01:20:20.871Z",
      "2026-11-05T01:20:20.871Z", "2026-11-04T10:00:00.000Z", null, null, null, "2026-11-03T18:15:00.000Z",
    ],
  },
};

// The UTC form a printed time stands for; "back" in E7's table.
const BACK = ["2026-11-05T01:20:20.871Z", "2026-06-22T02:00:10.000Z", "2026-03-08T07:30:00.000Z"];

describe.each(Object.entries(ZONES))("in %s", (zone, want) => {
  it.each(STORED.map((s, i) => [s, want.local[i], BACK[i]] as const))("localTs(%s) is %s and reads back as %s", (stored, local, back) => {
    withTz(zone, () => {
      expect(localTs(stored)).toBe(local);
      expect(utcBound(local!)).toBe(back);
    });
  });

  it.each(INPUTS.map((s, i) => [s, want.bound[i]] as const))("utcBound(%j) is %s", (input, bound) => {
    withTz(zone, () => expect(utcBound(input)).toBe(bound));
  });

  it("returns what is not a stored time unchanged", () => {
    withTz(zone, () => {
      expect(localTs("?")).toBe("?");
      expect(localTs("garbage")).toBe("garbage");
    });
  });
});

describe("src/util/time.ts", () => {
  // The hooks print through it: an import here (zod grew each hook bundle
  // from tens of kilobytes to over half a megabyte) lands in every hook.
  it("imports nothing", () => {
    expect(readFileSync(new URL("../src/util/time.ts", import.meta.url), "utf8")).not.toMatch(/^import /m);
  });
});

describe("timeParam", () => {
  it("rejects an unreadable time with the hint", () => {
    const r = timeParam.safeParse("yesterday");
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(TIME_INPUT_HINT);
  });

  it("turns a printed time into UTC", () => {
    expect(timeParam.parse("2026-11-05T10:20:20.871+09:00")).toBe("2026-11-05T01:20:20.871Z");
  });
});
