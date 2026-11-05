import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tools print local time (src/util/time.ts); in UTC that is the stored
    // string, so asserted times hold on any machine. Tests of other zones use
    // withTz (test/tz.ts).
    env: { TZ: "UTC" },
  },
});
