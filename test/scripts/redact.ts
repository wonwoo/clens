#!/usr/bin/env tsx
/**
 * redact.ts — fixture redactor for clens.
 *
 * Implements the contract in docs/execplans/2026-06-21-clens-execplan.md §17 Phase 0.
 *
 * Line-by-line 1:1 transform of a raw Claude Code JSONL file. Replacements
 * are applied in this order on every string value reachable from the parsed
 * JSON object:
 *
 *   (i)   absolute filesystem paths      → </path/redacted>
 *   (ii)  ~/.claude/projects/<dir>/...   → <corpus>/.../
 *   (iii) secret-shaped strings          → <redacted-secret>
 *   (iv)  sessionId                      → "test"
 *   (v)   uuid                           → evt-<line-ordinal>
 *   (vi)  parentUuid                     → mapped evt-* via uuid table
 *   (vii) cwd                            → /fixture/cwd
 *   (viii) gitBranch                     → preserved
 *
 * The redactor never inserts or drops lines.
 *
 * Usage:
 *   tsx test/scripts/redact.ts <input.jsonl> <output.jsonl>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit, stderr } from "node:process";

const ABS_PATH_RE = /\/(?:Users|home|var|tmp|etc|opt|private|root)\/[^\s"'`<>]+/g;
const CLAUDE_PROJECTS_RE = /~\/\.claude\/projects\/[^\s"'`<>]+/g;
const SECRET_RES: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+/g,
];

const PRESERVED_KEYS = new Set(["gitBranch"]);
const SESSION_ID_KEYS = new Set(["sessionId", "session_id"]);
const CWD_KEYS = new Set(["cwd"]);
const UUID_KEYS = new Set(["uuid"]);
const PARENT_UUID_KEYS = new Set(["parentUuid", "parent_uuid"]);

interface UuidTable {
  /** raw uuid → evt-<ordinal> */
  map: Map<string, string>;
}

function redactString(s: string): string {
  let out = s;
  out = out.replace(CLAUDE_PROJECTS_RE, "<corpus>/...");
  out = out.replace(ABS_PATH_RE, "</path/redacted>");
  for (const re of SECRET_RES) out = out.replace(re, "<redacted-secret>");
  return out;
}

/** Walk every string value in a JSON tree and apply redactString in place. */
function redactStringsInPlace(node: unknown, keyContext: string | null = null): unknown {
  if (typeof node === "string") {
    if (keyContext !== null && PRESERVED_KEYS.has(keyContext)) return node;
    return redactString(node);
  }
  if (Array.isArray(node)) {
    return node.map((item) => redactStringsInPlace(item, null));
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      obj[k] = redactStringsInPlace(obj[k], k);
    }
    return obj;
  }
  return node;
}

/** Apply the structural rewrites (sessionId/uuid/parentUuid/cwd) on a parsed line. */
function applyStructural(node: unknown, table: UuidTable): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => applyStructural(item, table));
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (SESSION_ID_KEYS.has(k) && typeof v === "string") {
        obj[k] = "test";
        continue;
      }
      if (CWD_KEYS.has(k) && typeof v === "string") {
        obj[k] = "/fixture/cwd";
        continue;
      }
      if (UUID_KEYS.has(k) && typeof v === "string") {
        const mapped = table.map.get(v);
        if (mapped) obj[k] = mapped;
        continue;
      }
      if (PARENT_UUID_KEYS.has(k) && typeof v === "string") {
        const mapped = table.map.get(v);
        // If the parent uuid was never seen as a top-level uuid, keep null
        // (chain stays valid by becoming an orphan rather than dangling).
        obj[k] = mapped ?? null;
        continue;
      }
      obj[k] = applyStructural(v, table);
    }
    return obj;
  }
  return node;
}

interface RedactArgs {
  input: string;
  output: string;
}

function parseArgs(args: string[]): RedactArgs {
  if (args.length !== 2) {
    stderr.write("usage: tsx test/scripts/redact.ts <input.jsonl> <output.jsonl>\n");
    exit(2);
  }
  return { input: args[0]!, output: args[1]! };
}

function main(): void {
  const { input, output } = parseArgs(argv.slice(2));
  const raw = readFileSync(input, "utf8");
  // Preserve trailing-newline shape: split on \n, last element is "" iff input
  // ended in \n. We map only non-terminal lines (those followed by \n).
  const parts = raw.split("\n");
  const hadTrailingNewline = parts[parts.length - 1] === "";
  const lines = hadTrailingNewline ? parts.slice(0, -1) : parts;

  // Pass 1: build uuid → evt-<ordinal> map from top-level uuid fields.
  const table: UuidTable = { map: new Map() };
  const parsed: unknown[] = [];
  let parseErrors = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") {
      parsed.push(null);
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      parseErrors += 1;
      parsed.push({ __redact_unparseable__: true, raw_len: line.length });
      continue;
    }
    parsed.push(obj);
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      const u = (obj as Record<string, unknown>).uuid;
      if (typeof u === "string") {
        table.map.set(u, `evt-${i + 1}`);
      }
    }
  }

  // Pass 2: apply structural + string redaction, serialize.
  const outLines: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const node = parsed[i];
    if (node === null) {
      outLines.push("");
      continue;
    }
    if (
      node !== null &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      (node as Record<string, unknown>).__redact_unparseable__ === true
    ) {
      outLines.push("{\"__redact_unparseable__\":true}");
      continue;
    }
    const structurallyRewritten = applyStructural(node, table);
    const fullyRedacted = redactStringsInPlace(structurallyRewritten);
    outLines.push(JSON.stringify(fullyRedacted));
  }

  // Reassemble with the same trailing-newline shape as the input.
  const outBody = outLines.join("\n") + (hadTrailingNewline ? "\n" : "");
  writeFileSync(output, outBody, "utf8");

  stderr.write(
    `redact: ${lines.length} lines, uuid_map_size=${table.map.size}, parse_errors=${parseErrors}\n` +
      `  in:  ${input}\n  out: ${output}\n`,
  );
}

main();
