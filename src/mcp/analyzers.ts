/**
 * The language analyzers (src/indexer/lang/) take about 1.1 GB in a process,
 * most of it Korean's: kiwi's WASM build cannot use its quantized model and
 * unpacks the weights to floats. Claude Code and Codex start one server per
 * session, so only the watcher loads them; it needs them to index anyway.
 * Search needs them only to split the query's words into morphemes, so every
 * other server sends those words to the watcher over a local socket and gets
 * back each word's tokens.
 *
 * One request per connection: a line of JSON `{"texts": [...]}`, answered by a
 * line `{"<code>": [tokens or null, ...]}` with an entry for each analyzer the
 * watcher has, null for a text that analyzer does not detect.
 */
import { unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";

import { listKnownLanguageCodes, registeredLanguageAdapters } from "../indexer/lang/registry.js";
import type { LanguageAdapter } from "../indexer/lang/types.js";
import { analyzerSocketPath } from "../util/paths.js";

/** How long a search waits for the watcher. The watcher answers between
 *  files, and indexing one of the largest transcripts takes about 5 seconds. */
const ANSWER_TIMEOUT_MS = 10_000;
/** A request holds a query's words; one this long is not a request. */
const MAX_REQUEST_CHARS = 1_000_000;

let server: Server | null = null;

/** The tokens each analyzer of this process gives each text. */
function tokensOf(texts: string[]): Record<string, (string[] | null)[]> {
  const out: Record<string, (string[] | null)[]> = {};
  for (const a of registeredLanguageAdapters()) {
    out[a.code] = texts.map((t) => (a.detect(t) ? a.tokenize(t) : null));
  }
  return out;
}

function answer(socket: Socket): void {
  let request = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk: string) => {
    if (socket.writableEnded) return;
    request += chunk;
    const end = request.indexOf("\n");
    if (end < 0) {
      if (request.length > MAX_REQUEST_CHARS) socket.destroy();
      return;
    }
    let texts: unknown;
    try {
      texts = (JSON.parse(request.slice(0, end)) as { texts?: unknown }).texts;
    } catch {
      texts = undefined;
    }
    if (!Array.isArray(texts) || !texts.every((t) => typeof t === "string")) {
      socket.destroy();
      return;
    }
    socket.end(JSON.stringify(tokensOf(texts)) + "\n");
  });
}

function listen(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer(answer);
    s.once("error", reject);
    s.listen(path, () => {
      s.off("error", reject);
      s.on("error", (e) => console.error("clens: analyzer socket failed:", e.message));
      // Serving others never keeps this process alive on its own.
      s.unref();
      resolve(s);
    });
  });
}

/** Answer other servers with this process's analyzers. Only the holder of the
 *  watch lock calls this, so a socket file already at `path` is left by a
 *  watcher that is gone, or by one that lost the lock to this one, and is
 *  replaced either way. */
export async function serveAnalyzers(path = analyzerSocketPath()): Promise<void> {
  // This process served before and lost the watch lock. Its server was left
  // open then, as the file at its path was its successor's by the time; that
  // successor is gone now.
  await closeAnalyzerServer();
  try {
    server = await listen(path);
  } catch (e) {
    if ((e as { code?: string }).code !== "EADDRINUSE" || process.platform === "win32") throw e;
    unlinkSync(path);
    server = await listen(path);
  }
}

/** Stop serving. Closing a server removes the socket file at its path, so a
 *  watcher that loses the lock does not call this: the file may be its
 *  successor's by then. */
export async function closeAnalyzerServer(): Promise<void> {
  const s = server;
  server = null;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
}

/** Analyzers that answer for `texts` alone, from the watcher's reply. */
function adaptersFrom(texts: string[], line: string): LanguageAdapter[] {
  let reply: Record<string, unknown>;
  try {
    reply = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const adapters: LanguageAdapter[] = [];
  for (const code of listKnownLanguageCodes()) {
    const list = reply?.[code];
    if (!Array.isArray(list) || list.length !== texts.length) continue;
    const byText = new Map<string, string[] | null>();
    texts.forEach((t, i) => {
      const tokens: unknown = list[i];
      byText.set(t, Array.isArray(tokens) ? tokens.filter((s): s is string => typeof s === "string") : null);
    });
    adapters.push({
      code,
      detect: (t) => Array.isArray(byText.get(t)),
      tokenize: (t) => byText.get(t) ?? [],
    });
  }
  return adapters;
}

/** The watcher's analyzers, answering for `texts`. Empty when no watcher
 *  answers within `timeoutMs`: none is running, it is still loading its
 *  analyzers, or it is an older clens that does not serve them. */
export function remoteAnalyzers(
  texts: string[],
  path = analyzerSocketPath(),
  timeoutMs = ANSWER_TIMEOUT_MS,
): Promise<LanguageAdapter[]> {
  return new Promise((resolve) => {
    let reply = "";
    const socket = connect(path);
    const done = (adapters: LanguageAdapter[]) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(adapters);
    };
    const timer = setTimeout(() => done([]), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ texts }) + "\n"));
    socket.on("data", (chunk: string) => {
      reply += chunk;
      const end = reply.indexOf("\n");
      if (end >= 0) done(adaptersFrom(texts, reply.slice(0, end)));
    });
    socket.on("error", () => done([]));
    socket.on("close", () => done([]));
  });
}

/** The analyzers a search in this process uses for `texts`, a query's words:
 *  undefined when this process has its own (the watcher, or a server that was
 *  the watcher), so search takes those; otherwise the watcher's. */
export async function searchAnalyzers(
  texts: string[],
  path = analyzerSocketPath(),
): Promise<LanguageAdapter[] | undefined> {
  if (registeredLanguageAdapters().length > 0) return undefined;
  if (texts.length === 0) return [];
  return remoteAnalyzers(texts, path);
}
