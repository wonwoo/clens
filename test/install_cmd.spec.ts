import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// npm and the reindex are stand-ins: the install itself is checked by hand,
// against the real registry.
const { execFileSync, runIndex } = vi.hoisted(() => ({
  execFileSync: vi.fn((): never => {
    throw new Error("Command failed: npm install");
  }),
  runIndex: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync,
}));
vi.mock("../src/indexer/driver.js", () => ({ runIndex }));

import { installCommand, linderaInstallArgs } from "../src/commands/install_cmd.js";

describe("commands/install_cmd.ts — unsupported language", () => {
  it("rejects a language with no installer, without touching the network or filesystem", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await installCommand({ lang: "fr" });
      expect(code).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unsupported language 'fr'"));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("ko, ja, zh"));
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

describe("commands/install_cmd.ts — ja and zh", () => {
  it("installs the pinned Lindera package under the language's model dir, outside any package.json", () => {
    expect(linderaInstallArgs("ja", "/m/ja")).toEqual(
      ["install", "--prefix", "/m/ja", "--no-save", "--no-audit", "--no-fund", "lindera-wasm-nodejs-ipadic@2.0.0"],
    );
    expect(linderaInstallArgs("zh", "/m/zh").at(-1)).toBe("lindera-wasm-nodejs-cc-cedict@2.0.0");
  });

  it("returns 1 and does not reindex when npm fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clens-install-"));
    const saved = process.env.CLENS_INDEX_DIR;
    process.env.CLENS_INDEX_DIR = dir;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await installCommand({ lang: "ja" })).toBe(1);
      expect(execFileSync).toHaveBeenCalled();
      expect(runIndex).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("clens install ja: failed"));
    } finally {
      stderr.mockRestore();
      if (saved === undefined) delete process.env.CLENS_INDEX_DIR;
      else process.env.CLENS_INDEX_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The analyzer is in place once npm succeeds; a failed rebuild after it
  // (another clens holding the index lock, say) must say so, so the user
  // rebuilds instead of installing again.
  it("returns 1 and says the analyzer is installed when the reindex fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clens-install-"));
    const saved = process.env.CLENS_INDEX_DIR;
    process.env.CLENS_INDEX_DIR = dir;
    execFileSync.mockImplementationOnce(() => Buffer.from("") as never);
    runIndex.mockRejectedValueOnce(Object.assign(new Error("indexer busy"), { exitCode: 4 }));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await installCommand({ lang: "ja" }).catch((e: Error) => `threw: ${e.message}`);
      const said = stderr.mock.calls.map(([s]) => String(s)).join("");
      expect(
        {
          code,
          said: said.includes(
            "clens install ja: failed: the analyzer is installed, but the index rebuild failed: indexer busy. " +
              "Run `start.mjs index --rebuild` to rebuild it.\n",
          ),
        },
        "install whose reindex fails",
      ).toEqual({ code: 1, said: true });
    } finally {
      stderr.mockRestore();
      if (saved === undefined) delete process.env.CLENS_INDEX_DIR;
      else process.env.CLENS_INDEX_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
