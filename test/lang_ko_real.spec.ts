/**
 * The ONE integration test that proves acceptance criterion (a) against the
 * real kiwi-nlp analyzer + real downloaded model, not a fake tokenizer.
 * Every other language-layer test (lang_registry.spec.ts, writer_lang.spec.ts,
 * mcp_search.spec.ts) uses a fake adapter to verify plumbing quickly and
 * deterministically — that's legitimate for wiring, but insufficient on its
 * own to prove the feature actually works end-to-end (see QA finding this
 * feature was previously HOLD'd over exactly this gap).
 *
 * Requires test/fixtures/kiwi-model/ (~104MB, gitignored — not checked in).
 * Skipped, not failed, when that fixture is absent (fresh clone, CI without
 * the model) so `npm test` still passes everywhere else.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKoreanAdapter } from "../src/indexer/lang/ko.js";

const MODEL_DIR = join(process.cwd(), "test/fixtures/kiwi-model");
const hasFixture = existsSync(MODEL_DIR);

async function buildRealKoreanAdapter() {
  const { KiwiBuilder, Match } = await import("kiwi-nlp");
  const kiwiEntry = createRequire(import.meta.url).resolve("kiwi-nlp");
  const wasmPath = join(dirname(kiwiEntry), "kiwi-wasm.wasm");

  const modelFiles: Record<string, Uint8Array> = {};
  for (const name of readdirSync(MODEL_DIR)) {
    modelFiles[name] = new Uint8Array(readFileSync(join(MODEL_DIR, name)));
  }

  const builder = await KiwiBuilder.create(wasmPath);
  const kiwi = await builder.build({ modelFiles });
  return createKoreanAdapter({
    analyze: (text: string) => kiwi.analyze(text, Match.allWithNormalizing),
  });
}

describe.skipIf(!hasFixture)("indexer/lang/ko.ts — real kiwi-nlp + real model (integration)", () => {
  it("particle-attached and bare forms tokenize to the same content word", async () => {
    const adapter = await buildRealKoreanAdapter();

    const withParticle = adapter.tokenize("리팩토링을");
    const bare = adapter.tokenize("리팩토링");

    expect(withParticle).toEqual(bare);
    expect(withParticle).toContain("리팩토링");
  });

  it("strips particles/endings from a full sentence, keeping the content words", async () => {
    const adapter = await buildRealKoreanAdapter();

    const tokens = adapter.tokenize("회사에서 사용하는 코드를 리팩토링을 진행했습니다.");
    expect(tokens).toContain("리팩토링");
    expect(tokens).toContain("회사");
    // Particles/endings must not survive as standalone tokens.
    expect(tokens).not.toContain("을");
    expect(tokens).not.toContain("를");
    expect(tokens).not.toContain("에서");
  });

  // Regression: real kiwi-nlp tags a Latin-script loanword as "SL" and a
  // following particle as its own J-tag (e.g. "Kiwi의" -> [{"Kiwi",SL},
  // {"의",JKG}]). isContentTag() used to exclude anything starting with
  // "S" on the assumption S* meant punctuation, which also silently
  // dropped SL — the actual content word — leaving zero tokens instead of
  // ["Kiwi"]. Found via manual MCP testing: a query mixing a foreign
  // word with a Korean particle ("Kiwi의 ...") returned zero results.
  it("keeps a foreign/Latin-script word (SL) attached to a Korean particle as a content token", async () => {
    const adapter = await buildRealKoreanAdapter();

    const tokens = adapter.tokenize("Kiwi의 20000자 제한");
    expect(tokens).toContain("Kiwi");
  });

  // Numbers (SN) and Chinese characters (SH) share the same "starts with S
  // but isn't punctuation" shape as SL — same regression class.
  it("keeps a number (SN) as a content token instead of dropping it like punctuation", async () => {
    const adapter = await buildRealKoreanAdapter();

    const tokens = adapter.tokenize("숫자 20000개");
    expect(tokens).toContain("20000");
  });
});
