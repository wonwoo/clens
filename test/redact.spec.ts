import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const SCRIPT = join(process.cwd(), "test/scripts/redact.ts");

function runRedact(inputPath: string, outputPath: string): void {
  execFileSync("npx", ["tsx", SCRIPT, inputPath, outputPath], { stdio: "pipe" });
}

describe("redact.ts", () => {
  let workDir: string;
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "clens-redact-"));
  });
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("preserves line count 1:1 (including trailing newline)", () => {
    const input = [
      JSON.stringify({ uuid: "u1", parentUuid: null, sessionId: "s1", type: "user" }),
      JSON.stringify({ uuid: "u2", parentUuid: "u1", sessionId: "s1", type: "assistant" }),
    ].join("\n") + "\n";
    const inPath = join(workDir, "in1.jsonl");
    const outPath = join(workDir, "out1.jsonl");
    writeFileSync(inPath, input);
    runRedact(inPath, outPath);
    const out = readFileSync(outPath, "utf8");
    expect(out.split("\n").length).toBe(input.split("\n").length);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("rewrites sessionId → 'test' and uuids → evt-<line>", () => {
    const input =
      JSON.stringify({ uuid: "abc-1", parentUuid: null, sessionId: "S", type: "user" }) +
      "\n" +
      JSON.stringify({ uuid: "abc-2", parentUuid: "abc-1", sessionId: "S", type: "assistant" }) +
      "\n";
    const inPath = join(workDir, "in2.jsonl");
    const outPath = join(workDir, "out2.jsonl");
    writeFileSync(inPath, input);
    runRedact(inPath, outPath);
    const lines = readFileSync(outPath, "utf8").trim().split("\n");
    const l1 = JSON.parse(lines[0]!);
    const l2 = JSON.parse(lines[1]!);
    expect(l1.uuid).toBe("evt-1");
    expect(l1.sessionId).toBe("test");
    expect(l1.parentUuid).toBeNull();
    expect(l2.uuid).toBe("evt-2");
    expect(l2.parentUuid).toBe("evt-1");
    expect(l2.sessionId).toBe("test");
  });

  it("strips absolute paths and secrets", () => {
    const input =
      JSON.stringify({
        uuid: "u",
        sessionId: "s",
        cwd: "/Users/someone/code",
        type: "user",
        message: {
          role: "user",
          content: "edit /Users/x/a.ts and key=sk-AAAAAAAAAAAAAAAAAAAAAAAA",
        },
      }) + "\n";
    const inPath = join(workDir, "in3.jsonl");
    const outPath = join(workDir, "out3.jsonl");
    writeFileSync(inPath, input);
    runRedact(inPath, outPath);
    const out = readFileSync(outPath, "utf8");
    expect(out.includes("/Users/")).toBe(false);
    expect(out.includes("sk-AAAA")).toBe(false);
    expect(out.includes("<redacted-secret>")).toBe(true);
    expect(out.includes("</path/redacted>")).toBe(true);
    const parsed = JSON.parse(out.trim());
    expect(parsed.cwd).toBe("/fixture/cwd");
  });

  it("preserves gitBranch verbatim", () => {
    const input =
      JSON.stringify({
        uuid: "u",
        sessionId: "s",
        gitBranch: "feature/Users-area",
        type: "user",
      }) + "\n";
    const inPath = join(workDir, "in4.jsonl");
    const outPath = join(workDir, "out4.jsonl");
    writeFileSync(inPath, input);
    runRedact(inPath, outPath);
    const parsed = JSON.parse(readFileSync(outPath, "utf8").trim());
    expect(parsed.gitBranch).toBe("feature/Users-area");
  });

  it("dangling parentUuid (uuid never seen) becomes null", () => {
    const input =
      JSON.stringify({ uuid: "x1", parentUuid: "nonexistent", sessionId: "s", type: "user" }) +
      "\n";
    const inPath = join(workDir, "in5.jsonl");
    const outPath = join(workDir, "out5.jsonl");
    writeFileSync(inPath, input);
    runRedact(inPath, outPath);
    const parsed = JSON.parse(readFileSync(outPath, "utf8").trim());
    expect(parsed.uuid).toBe("evt-1");
    expect(parsed.parentUuid).toBeNull();
  });
});
