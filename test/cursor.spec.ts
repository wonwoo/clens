import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySchema } from "../src/indexer/schema.js";
import { discoverFiles } from "../src/indexer/cursor.js";
import { SOURCE_ADAPTERS } from "../src/indexer/sources.js";
import type { SourceAdapter } from "../src/indexer/sources.js";

let tmpRoot: string;
let db: Database.Database;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "clens-cursor-"));
  db = new Database(":memory:");
  applySchema(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("discoverFiles — default registry", () => {
  it("discovers files from every currently registered adapter's sessionsDir", () => {
    // SOURCE_ADAPTERS reads real env-derived paths; just assert the registry
    // itself is what discoverFiles iterates by default (regression guard —
    // catches someone hardcoding a single source back into discoverFiles).
    const seen = new Set<string>();
    for (const adapter of SOURCE_ADAPTERS) seen.add(adapter.name);
    expect(seen).toEqual(new Set(["claude", "codex"]));
  });
});

describe("discoverFiles — extensibility via injected adapters", () => {
  it("a third-party adapter not in the global registry is discovered and tagged with its own source name", () => {
    const fakeRoot = join(tmpRoot, "cursor-sessions");
    mkdirSync(fakeRoot, { recursive: true });
    writeFileSync(join(fakeRoot, "session-1.jsonl"), '{"x":1}\n');

    const fakeAdapter: SourceAdapter = {
      name: "cursor",
      sessionsDir: () => fakeRoot,
      parse: () => {
        throw new Error("not exercised by discoverFiles");
      },
    };

    const discovered = discoverFiles(db, {}, [fakeAdapter]);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.source).toBe("cursor");
    expect(discovered[0]!.path).toBe(join(fakeRoot, "session-1.jsonl"));
    expect(discovered[0]!.needs_parse).toBe(true);
  });

  it("two injected adapters each contribute only their own files, un-mixed", () => {
    const rootA = join(tmpRoot, "a-sessions");
    const rootB = join(tmpRoot, "b-sessions");
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    writeFileSync(join(rootA, "s1.jsonl"), "{}\n");
    writeFileSync(join(rootB, "s2.jsonl"), "{}\n");

    const adapterA: SourceAdapter = {
      name: "windsurf",
      sessionsDir: () => rootA,
      parse: () => {
        throw new Error("not exercised");
      },
    };
    const adapterB: SourceAdapter = {
      name: "qwen",
      sessionsDir: () => rootB,
      parse: () => {
        throw new Error("not exercised");
      },
    };

    const discovered = discoverFiles(db, {}, [adapterA, adapterB]);
    const bySource = new Map(discovered.map((d) => [d.source, d.path]));

    expect(bySource.get("windsurf")).toBe(join(rootA, "s1.jsonl"));
    expect(bySource.get("qwen")).toBe(join(rootB, "s2.jsonl"));
  });

  it("an adapter whose sessionsDir does not exist yet contributes zero files without throwing", () => {
    const missingAdapter: SourceAdapter = {
      name: "future-tool",
      sessionsDir: () => join(tmpRoot, "does-not-exist"),
      parse: () => {
        throw new Error("not exercised");
      },
    };
    expect(() => discoverFiles(db, {}, [missingAdapter])).not.toThrow();
    expect(discoverFiles(db, {}, [missingAdapter])).toEqual([]);
  });
});
