import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const SCRIPT = join(process.cwd(), "test/scripts/synth-corpus.ts");
const FIXTURE = join(process.cwd(), "test/fixtures/brainstorm-session.jsonl");

function runSynth(outDir: string, count: number, seed = 42): void {
  execFileSync(
    "npx",
    ["tsx", SCRIPT, FIXTURE, outDir, "--count", String(count), "--seed", String(seed)],
    { stdio: "pipe" },
  );
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonl(full));
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

describe("synth-corpus.ts", () => {
  let workDir: string;
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "clens-synth-"));
  });
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("dry-run --count 5 produces 5 valid sessions", () => {
    const outDir = join(workDir, "small");
    runSynth(outDir, 5);
    const files = walkJsonl(outDir);
    expect(files.length).toBe(5);

    for (const f of files) {
      const content = readFileSync(f, "utf8");
      const lines = content.split("\n").filter((l) => l.length > 0);
      let parsed = 0;
      let unparseable = 0;
      const sessionIds = new Set<string>();
      for (const line of lines) {
        const obj = JSON.parse(line);
        if (obj.__unparseable__) {
          unparseable += 1;
          continue;
        }
        parsed += 1;
        if (typeof obj.sessionId === "string") sessionIds.add(obj.sessionId);
      }
      expect(unparseable).toBe(0);
      expect(parsed).toBeGreaterThan(900);
      // exactly one sessionId per file (synth-N)
      expect(sessionIds.size).toBe(1);
      const only = [...sessionIds][0]!;
      expect(only).toMatch(/^synth-\d+$/);
    }
  });

  it("preserves total line count per session (cardinality invariant)", () => {
    const outDir = join(workDir, "card");
    runSynth(outDir, 3);
    const files = walkJsonl(outDir);
    const fixtureLines = readFileSync(FIXTURE, "utf8").split("\n").length;
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n").length;
      expect(lines).toBe(fixtureLines);
    }
  });

  it("parentUuid chains stay internally consistent (no dangling refs to fixture-original uuids)", () => {
    const outDir = join(workDir, "chain");
    runSynth(outDir, 2);
    const files = walkJsonl(outDir);
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0);
      const seenUuids = new Set<string>();
      for (const line of lines) {
        const obj = JSON.parse(line);
        if (typeof obj.uuid === "string") seenUuids.add(obj.uuid);
      }
      for (const line of lines) {
        const obj = JSON.parse(line);
        // No raw fixture evt-<n> references should leak; new ids must be evt-<n>-<m>
        if (typeof obj.uuid === "string") {
          expect(obj.uuid).toMatch(/^evt-\d+-\d+$/);
        }
        if (typeof obj.parentUuid === "string") {
          // parentUuid that is a string must reference a seen new-style uuid
          expect(obj.parentUuid).toMatch(/^evt-\d+-\d+$/);
          expect(seenUuids.has(obj.parentUuid)).toBe(true);
        }
      }
    }
  });

  it("timestamps shift by N hours per session", () => {
    const outDir = join(workDir, "ts");
    runSynth(outDir, 3);
    const files = walkJsonl(outDir).sort();
    // Find a fixture line with a timestamp
    const fixtureLines = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.length > 0);
    let baselineTs: string | null = null;
    let baselineIdx = -1;
    for (let i = 0; i < fixtureLines.length; i++) {
      const obj = JSON.parse(fixtureLines[i]!);
      if (typeof obj.timestamp === "string") {
        baselineTs = obj.timestamp;
        baselineIdx = i;
        break;
      }
    }
    expect(baselineTs).not.toBeNull();

    // Each synth session N should have the same baselineIdx event shifted by N hours.
    for (const f of files) {
      const m = /synth-(\d+)\.jsonl$/.exec(f);
      const n = Number(m![1]);
      const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0);
      const obj = JSON.parse(lines[baselineIdx]!);
      const baseMs = Date.parse(baselineTs!);
      const newMs = Date.parse(obj.timestamp);
      const deltaHours = (newMs - baseMs) / 3600000;
      expect(deltaHours).toBeCloseTo(n, 5);
    }
  });

  it("rotates cwd across 10 synthetic project paths", () => {
    const outDir = join(workDir, "cwd");
    runSynth(outDir, 12);
    const files = walkJsonl(outDir);
    // Collect distinct cwd values seen across all sessions
    const cwds = new Set<string>();
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0);
      for (const line of lines) {
        const obj = JSON.parse(line);
        if (typeof obj.cwd === "string") cwds.add(obj.cwd);
      }
    }
    // With count=12, we should hit at least 9-10 distinct project paths (rotation modulo 10)
    expect(cwds.size).toBeGreaterThanOrEqual(9);
    for (const c of cwds) {
      expect(c).toMatch(/^\/fixture\/proj-[a-j]$/);
    }
  });
});
