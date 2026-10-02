import { describe, expect, it, vi } from "vitest";
import { installCommand } from "../src/commands/install_cmd.js";

describe("commands/install_cmd.ts — unsupported language", () => {
  it("rejects a language with no installer, without touching the network or filesystem", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await installCommand({ lang: "ja" });
      expect(code).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unsupported language 'ja'"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("rejects an unknown/made-up language code the same way", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await installCommand({ lang: "xx" });
      expect(code).toBe(2);
    } finally {
      stderr.mockRestore();
    }
  });
});
