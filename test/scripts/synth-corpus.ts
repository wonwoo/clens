#!/usr/bin/env tsx
/**
 * synth-corpus.ts — 1.5×-author-scale synthetic corpus generator for clens.
 *
 * Implements docs/execplans/2026-06-21-clens-execplan.md §17 Phase 0:
 *   "Each synthetic session is a clone of the fixture with:
 *    (a) new sessionId (synth-<n>),
 *    (b) new uuid per event (evt-<n>-<m>),
 *    (c) parentUuid rewritten to the corresponding new uuid (no orphans),
 *    (d) timestamp time-shifted by n * 1 hour,
 *    (e) cwd rotated among 10 synthetic project paths,
 *    (f) tool_call input payloads padded with whitespace to hit byte volume.
 *   Cardinalities preserved. Seeded (default 42)."
 *
 * Layout produced:
 *   <out>/<synthetic-project-N>/<sessionId>.jsonl
 *
 * Usage:
 *   tsx test/scripts/synth-corpus.ts <fixture.jsonl> <outDir> [--count N] [--seed S] [--pad-bytes B]
 *
 * Defaults: --count 1000, --seed 42, --pad-bytes 0
 *
 * Notes:
 *   - parentUuid rewrites use the new (evt-<n>-<m>) ids. A parent uuid not seen
 *     as a top-level event uuid stays null in the output (matches the redactor
 *     contract).
 *   - tool_call input padding adds a `"_pad": "<spaces>"` key to the JSON object
 *     when the original `input` is an object — this keeps the JSON parseable and
 *     does not change Claude's tool semantics. When `input` is a string, a
 *     trailing space run is appended; this is a no-op for whitespace-tolerant
 *     parsers but does change the original string content. We log how many
 *     tool_calls were padded so callers can audit.
 *   - The generator does NOT change any token-usage numbers (cost-honesty).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, exit, stderr } from "node:process";

interface SynthArgs {
  fixture: string;
  outDir: string;
  count: number;
  seed: number;
  padBytes: number;
}

function parseArgs(argList: string[]): SynthArgs {
  const positional: string[] = [];
  let count = 1000;
  let seed = 42;
  let padBytes = 0;
  for (let i = 0; i < argList.length; i++) {
    const a = argList[i]!;
    if (a === "--count") {
      count = Number(argList[++i]);
    } else if (a === "--seed") {
      seed = Number(argList[++i]);
    } else if (a === "--pad-bytes") {
      padBytes = Number(argList[++i]);
    } else if (a.startsWith("--")) {
      stderr.write(`unknown flag: ${a}\n`);
      exit(2);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2 || !Number.isFinite(count) || count < 1) {
    stderr.write(
      "usage: tsx test/scripts/synth-corpus.ts <fixture.jsonl> <outDir> [--count N] [--seed S] [--pad-bytes B]\n",
    );
    exit(2);
  }
  return {
    fixture: positional[0]!,
    outDir: positional[1]!,
    count,
    seed,
    padBytes,
  };
}

const PROJECT_PATHS = [
  "/fixture/proj-a",
  "/fixture/proj-b",
  "/fixture/proj-c",
  "/fixture/proj-d",
  "/fixture/proj-e",
  "/fixture/proj-f",
  "/fixture/proj-g",
  "/fixture/proj-h",
  "/fixture/proj-i",
  "/fixture/proj-j",
];

/** mulberry32: tiny seeded PRNG. Output in [0,1). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Stats {
  sessions: number;
  events_total: number;
  tool_calls_padded: number;
  parent_uuid_rewrites: number;
  parent_uuid_dangling: number;
}

function shiftTimestamp(ts: unknown, hours: number): unknown {
  if (typeof ts !== "string") return ts;
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return ts;
  return new Date(parsed + hours * 3600 * 1000).toISOString();
}

function padString(s: string, n: number): string {
  return n > 0 ? s + " ".repeat(n) : s;
}

function padToolCallInput(
  input: unknown,
  padBytes: number,
  stats: Stats,
): unknown {
  if (padBytes <= 0) return input;
  if (input === null || input === undefined) return input;
  if (typeof input === "string") {
    stats.tool_calls_padded += 1;
    return padString(input, padBytes);
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    stats.tool_calls_padded += 1;
    return { ...(input as Record<string, unknown>), _pad: " ".repeat(padBytes) };
  }
  return input;
}

/**
 * Rewrite uuid/parentUuid fields and shift timestamps inside one event object,
 * walking content blocks for tool_use input padding.
 */
function transformEvent(
  ev: Record<string, unknown>,
  ctx: {
    sessionId: string;
    uuidMap: Map<string, string>;
    hourShift: number;
    cwd: string;
    padBytes: number;
    stats: Stats;
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...ev };

  // sessionId
  if (typeof out.sessionId === "string") out.sessionId = ctx.sessionId;

  // cwd
  if (typeof out.cwd === "string") out.cwd = ctx.cwd;

  // timestamp shift
  if (typeof out.timestamp === "string") {
    out.timestamp = shiftTimestamp(out.timestamp, ctx.hourShift);
  }

  // uuid → mapped (already populated by caller)
  if (typeof out.uuid === "string") {
    const m = ctx.uuidMap.get(out.uuid);
    if (m) out.uuid = m;
  }

  // parentUuid → mapped or null
  if (typeof out.parentUuid === "string") {
    const m = ctx.uuidMap.get(out.parentUuid);
    if (m) {
      out.parentUuid = m;
      ctx.stats.parent_uuid_rewrites += 1;
    } else {
      out.parentUuid = null;
      ctx.stats.parent_uuid_dangling += 1;
    }
  }

  // tool_use input padding (walk message.content if array)
  if (out.message && typeof out.message === "object") {
    const msg = out.message as Record<string, unknown>;
    const content = msg.content;
    if (Array.isArray(content)) {
      msg.content = content.map((block) => {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "tool_use"
        ) {
          const b = block as Record<string, unknown>;
          return { ...b, input: padToolCallInput(b.input, ctx.padBytes, ctx.stats) };
        }
        return block;
      });
    }
  }

  return out;
}

function main(): void {
  const args = parseArgs(argv.slice(2));
  const raw = readFileSync(args.fixture, "utf8");
  const parts = raw.split("\n");
  const hadTrailingNewline = parts[parts.length - 1] === "";
  const lines = hadTrailingNewline ? parts.slice(0, -1) : parts;

  const rng = makeRng(args.seed);
  // Touch rng so future jitter additions remain seeded; not used yet to keep
  // perturbation strictly deterministic per (n, m).
  rng();

  // Parse fixture once; capture the multiset of top-level uuids so we can
  // produce a per-clone uuid map.
  const parsedFixture: unknown[] = [];
  const fixtureUuids: string[] = [];
  let parseErrors = 0;
  for (const line of lines) {
    if (line === "") {
      parsedFixture.push(null);
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      parseErrors += 1;
      parsedFixture.push({ __unparseable__: true });
      continue;
    }
    parsedFixture.push(obj);
    if (
      obj !== null &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      typeof (obj as { uuid?: unknown }).uuid === "string"
    ) {
      fixtureUuids.push((obj as { uuid: string }).uuid);
    }
  }

  mkdirSync(args.outDir, { recursive: true });
  const stats: Stats = {
    sessions: 0,
    events_total: 0,
    tool_calls_padded: 0,
    parent_uuid_rewrites: 0,
    parent_uuid_dangling: 0,
  };

  for (let n = 1; n <= args.count; n++) {
    const sessionId = `synth-${n}`;
    const projectIdx = n % PROJECT_PATHS.length;
    const cwd = PROJECT_PATHS[projectIdx]!;

    // Build uuid map for this clone:  fixtureUuid → evt-<n>-<m>
    const uuidMap = new Map<string, string>();
    fixtureUuids.forEach((u, idx) => {
      uuidMap.set(u, `evt-${n}-${idx + 1}`);
    });

    const ctx = {
      sessionId,
      uuidMap,
      hourShift: n,
      cwd,
      padBytes: args.padBytes,
      stats,
    };

    const outLines: string[] = [];
    for (const node of parsedFixture) {
      if (node === null) {
        outLines.push("");
        continue;
      }
      if (
        node !== null &&
        typeof node === "object" &&
        !Array.isArray(node) &&
        (node as { __unparseable__?: boolean }).__unparseable__
      ) {
        outLines.push("{\"__unparseable__\":true}");
        continue;
      }
      const ev = transformEvent({ ...(node as Record<string, unknown>) }, ctx);
      outLines.push(JSON.stringify(ev));
      stats.events_total += 1;
    }

    // Layout: <out>/proj-X/<sessionId>.jsonl
    const projDir = join(args.outDir, `proj-${projectIdx}`);
    mkdirSync(projDir, { recursive: true });
    const outPath = join(projDir, `${sessionId}.jsonl`);
    writeFileSync(
      outPath,
      outLines.join("\n") + (hadTrailingNewline ? "\n" : ""),
      "utf8",
    );
    stats.sessions += 1;
  }

  stderr.write(
    `synth-corpus: wrote ${stats.sessions} sessions, ${stats.events_total} events; ` +
      `parent_uuid rewrites=${stats.parent_uuid_rewrites} dangling=${stats.parent_uuid_dangling}; ` +
      `tool_call padded=${stats.tool_calls_padded}; fixture_parse_errors=${parseErrors}\n` +
      `  out: ${resolve(args.outDir)}\n`,
  );
}

main();
