/**
 * Files a Bash command writes, read off the command text the transcript
 * keeps: redirects (`>`, `>>`, `&>`, `N>`), `tee`, in-place `sed -i` and
 * `perl -i`, and python or node scripts run from a heredoc, a here-string or
 * `-c`/`-e` that open a file for writing. Paths come back absolute, placed
 * against the line's cwd and the command's own `cd`s.
 *
 * Only what the text names is taken. A path known only when the command runs
 * (`$VAR`, `$(…)`, a glob, a brace list) is left out, and so is every relative
 * path after a `cd` into such a place. Whether the command succeeded is not
 * known here: a failed command's files are taken too.
 */
import { posix } from "node:path";

interface Word {
  /** The word with quotes removed; each expansion leaves HOLE in its place. */
  text: string;
  /** False when the shell would expand the word (a variable, $( ), a glob, …),
   *  so `text` is not the value the command saw. */
  literal: boolean;
}

/** Stands in for an expansion inside a word's text, so a script path built
 *  from one (`python3 -c "open('$D/x', 'w')"`) is not taken without it. */
const HOLE = "\u0000";

interface Redirect {
  op: string;
  fd: string;
  target: Word | null;
  /** A heredoc's body. */
  body: string | null;
}

interface SimpleCommand {
  words: Word[];
  redirects: Redirect[];
  /** The operator that ended it: && || ; | & a newline, or ( ) */
  sep: string;
}

/** `( )` is a subshell; `{ }` runs in the current shell unless it is part of
 *  a pipeline or runs in the background. A close carries the operator after
 *  it, which decides that and ends a `cd x || …` branch. */
type Item =
  | { kind: "cmd"; cmd: SimpleCommand }
  | { kind: "open"; group: "paren" | "brace" }
  | { kind: "close"; group: "paren" | "brace"; sep: string };

const WORD_END = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", "<", ">"]);
const REDIRECT_RE = /^(\d*)(&>>|&>|>>|>\||>&|<<<|<<-|<<|<&|<>|>|<)/;
const OPERATOR_RE = /^(&&|\|\||;;&|;;|;&|;|\|&|\||&)/;
/** Reserved words a command can start with before its name: `if [[ … ]]`,
 *  `then case …`. */
const LEADING_WORDS = new Set(["!", "{", "do", "then", "else", "elif", "if", "while", "until", "time"]);

/** Where the arithmetic command `((` at `at` ends, or null when the parens are
 *  two subshells, as in `((cd a) && b)`: arithmetic closes both at once. */
function arithmeticEnd(src: string, at: number): number | null {
  let depth = 0;
  for (let j = at; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")") {
      depth--;
      if (depth === 0) return j + 1;
      if (depth === 1 && src[j + 1] !== ")") return null;
    }
  }
  return src.length;
}

/** Calls nested deeper than this (each `"$(` level is three) are taken to run
 *  to the end of the command, so the skipping below cannot overflow the stack. */
const MAX_NESTING = 600;

/** Index just past the `)` that closes the `(` at `open`, skipping quotes,
 *  nested parens and heredoc bodies; the end of `src` when it never closes. */
function skipParens(src: string, open: number, nesting = 0): number {
  if (nesting > MAX_NESTING) return src.length;
  let depth = 0;
  const heredocs: { delim: string; strip: boolean }[] = [];
  let i = open;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { const e = src.indexOf("'", i + 1); i = e === -1 ? src.length : e + 1; continue; }
    if (c === '"') { i = skipDoubleQuoted(src, i, nesting + 1); continue; }
    if (c === "`") { i = skipBackticks(src, i); continue; }
    if (src.startsWith("<<<", i)) { i += 3; continue; }
    if (c === "<" && src.startsWith("<<", i)) {
      const m = /^<<(-?)\s*(['"]?)([^\s'"();&|<>]+)\2/.exec(src.slice(i, i + 256));
      if (m) { heredocs.push({ delim: m[3]!, strip: m[1] === "-" }); i += m[0].length; continue; }
    }
    if (c === "\n" && heredocs.length > 0) { i = skipHeredocBodies(src, i + 1, heredocs.splice(0)).end; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
    i++;
  }
  return src.length;
}

/** Index just past the `"` that closes the one at `open`. */
function skipDoubleQuoted(src: string, open: number, nesting = 0): number {
  if (nesting > MAX_NESTING) return src.length;
  let i = open + 1;
  while (i < src.length && src[i] !== '"') {
    if (src[i] === "\\") i += 2;
    else if (src[i] === "$" || src[i] === "`") i = skipExpansion(src, i, nesting + 1);
    else i++;
  }
  return Math.min(i + 1, src.length);
}

function skipBackticks(src: string, open: number): number {
  let i = open + 1;
  while (i < src.length && src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, src.length);
}

/** Index just past the expansion (`$x`, `${…}`, `$(…)`, `` `…` ``) at `at`. */
function skipExpansion(src: string, at: number, nesting = 0): number {
  if (src[at] === "`") return skipBackticks(src, at);
  const next = src[at + 1];
  if (next === "(") return skipParens(src, at + 1, nesting + 1);
  if (next === "{") {
    const e = src.indexOf("}", at + 2);
    return e === -1 ? src.length : e + 1;
  }
  const m = /^[A-Za-z_]\w*|^[0-9?$!#@*-]/.exec(src.slice(at + 1, at + 257));
  return at + 1 + (m ? m[0].length : 0);
}

/** Reads heredoc bodies starting at `start` (the line after the command), in
 *  order; each ends at a line equal to its delimiter (leading tabs removed for
 *  `<<-`), or at the end of `src`. */
function skipHeredocBodies(
  src: string,
  start: number,
  heredocs: { delim: string; strip: boolean }[],
): { end: number; bodies: string[] } {
  let i = start;
  const bodies: string[] = [];
  for (const h of heredocs) {
    const lines: string[] = [];
    while (i < src.length) {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      const line = src.slice(i, end);
      i = nl === -1 ? src.length : nl + 1;
      if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
      lines.push(line);
    }
    bodies.push(lines.join("\n"));
  }
  return { end: i, bodies };
}

/** Splits a command into simple commands and subshell brackets. */
function parse(src: string, home: string | null): Item[] {
  const items: Item[] = [];
  let cur: SimpleCommand = { words: [], redirects: [], sep: "" };
  let pending: { redirect: Redirect; delim: string; strip: boolean }[] = [];
  let awaitingDelim: { redirect: Redirect; strip: boolean } | null = null;
  let awaitingTarget: Redirect | null = null;
  // Inside [[ ]], < and > compare strings.
  let inTest = false;
  // Open case statements: "head" up to `in`, "pattern" up to the pattern's
  // `)`, whose ( | ) are not subshells or pipes, then "body" up to `;;`.
  const cases: ("head" | "pattern" | "body")[] = [];
  let i = 0;
  // True while every word of the current command is a LEADING_WORDS one.
  let atStart = true;
  const atCommandStart = () => atStart;

  const finish = (sep: string) => {
    awaitingTarget = null;
    awaitingDelim = null;
    const last = items.at(-1);
    if (cur.words.length > 0 || cur.redirects.length > 0) {
      cur.sep = sep;
      items.push({ kind: "cmd", cmd: cur });
    } else if (last?.kind === "close" && sep !== "(" && sep !== ")" && sep !== "") {
      last.sep = sep;
    }
    cur = { words: [], redirects: [], sep: "" };
    inTest = false;
    atStart = true;
  };

  const pushWord = (word: Word) => {
    if (awaitingDelim !== null) {
      pending.push({ redirect: awaitingDelim.redirect, delim: word.text, strip: awaitingDelim.strip });
      awaitingDelim = null;
    } else if (awaitingTarget !== null) {
      awaitingTarget.target = word;
      awaitingTarget = null;
    } else if (cases.at(-1) === "pattern") {
      // A pattern word is not a command; `esac` closes the statement.
      if (word.text === "esac") cases.pop();
    } else if (cur.words.length === 0 && cur.redirects.length === 0 && (word.text === "{" || word.text === "}")) {
      if (word.text === "{") items.push({ kind: "open", group: "brace" });
      else items.push({ kind: "close", group: "brace", sep: "" });
    } else {
      const start = atCommandStart();
      if (!LEADING_WORDS.has(word.text)) atStart = false;
      if (start && word.text === "[[") inTest = true;
      else if (word.text === "]]") inTest = false;
      if (start && word.text === "case") cases.push("head");
      else if (start && word.text === "esac" && cases.at(-1) === "body") cases.pop();
      cur.words.push(word);
      if (cases.at(-1) === "head" && word.text === "in") {
        finish("");
        cases[cases.length - 1] = "pattern";
      }
    }
  };

  const readWord = (): Word => {
    let text = "";
    let literal = true;
    if (src[i] === "~") {
      const after = src[i + 1];
      if (home !== null && (after === undefined || after === "/" || WORD_END.has(after))) {
        text = home;
        i++;
      } else {
        literal = false;
      }
    }
    while (i < src.length) {
      const c = src[i]!;
      if (WORD_END.has(c) && !(inTest && (c === "<" || c === ">"))) break;
      if (c === "\\") {
        if (src[i + 1] !== "\n") text += src[i + 1] ?? "";
        i += 2;
      } else if (c === "'") {
        const e = src.indexOf("'", i + 1);
        const end = e === -1 ? src.length : e;
        text += src.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"') {
          const d = src[i]!;
          if (d === "\\" && i + 1 < src.length) {
            const n = src[i + 1]!;
            if ('$`"\\\n'.includes(n)) { if (n !== "\n") text += n; }
            else text += d + n;
            i += 2;
          } else if (d === "$" || d === "`") {
            literal = false;
            text += HOLE;
            i = skipExpansion(src, i);
          } else {
            text += d;
            i++;
          }
        }
        i++;
      } else if (c === "$" && src[i + 1] === "'") {
        // $'…' with backslash escapes.
        literal = false;
        text += HOLE;
        i += 2;
        while (i < src.length && src[i] !== "'") i += src[i] === "\\" ? 2 : 1;
        i++;
      } else if (c === "$" && src[i + 1] === '"') {
        i++;
      } else if (c === "$" || c === "`") {
        literal = false;
        text += HOLE;
        i = skipExpansion(src, i);
      } else {
        if (c === "*" || c === "?" || c === "[" || c === "{") literal = false;
        text += c;
        i++;
      }
    }
    return { text, literal };
  };

  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
    if (c === "\n") {
      finish("\n");
      i++;
      if (pending.length > 0) {
        const r = skipHeredocBodies(src, i, pending);
        pending.forEach((p, k) => { p.redirect.body = r.bodies[k] ?? ""; });
        pending = [];
        i = r.end;
      }
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (cases.at(-1) === "pattern" && (c === "(" || c === "|" || c === ")")) {
      if (c === ")") cases[cases.length - 1] = "body";
      i++;
      continue;
    }
    if (inTest) {
      // && || ( ) inside [[ ]] combine tests; they end no command.
      const n = src.startsWith("&&", i) || src.startsWith("||", i) ? 2 : c === "(" || c === ")" ? 1 : 0;
      if (n > 0) { i += n; continue; }
    }
    const arithmetic = src.startsWith("((", i) ? arithmeticEnd(src, i) : null;
    if (arithmetic !== null) {
      // An arithmetic command: its < and > compare numbers.
      i = arithmetic;
      pushWord({ text: "", literal: false });
      continue;
    }
    if (!inTest) {
      if ((c === "<" || c === ">") && src[i + 1] === "(") {
        // Process substitution.
        i = skipParens(src, i + 1);
        pushWord({ text: "", literal: false });
        continue;
      }
      const r = REDIRECT_RE.exec(src.slice(i, i + 16));
      if (r) {
        i += r[0].length;
        const redirect: Redirect = { op: r[2]!, fd: r[1]!, target: null, body: null };
        cur.redirects.push(redirect);
        awaitingTarget = null;
        awaitingDelim = null;
        if (redirect.op === "<<" || redirect.op === "<<-") awaitingDelim = { redirect, strip: redirect.op === "<<-" };
        else awaitingTarget = redirect;
        continue;
      }
    }
    const op = OPERATOR_RE.exec(src.slice(i, i + 3));
    if (op) {
      finish(op[1]!);
      i += op[1]!.length;
      if (op[1]!.startsWith(";;") || op[1] === ";&") {
        if (cases.at(-1) === "body") cases[cases.length - 1] = "pattern";
      }
      continue;
    }
    if (c === "(") { finish("("); items.push({ kind: "open", group: "paren" }); i++; continue; }
    if (c === ")") { finish(")"); items.push({ kind: "close", group: "paren", sep: "" }); i++; continue; }
    pushWord(readWord());
  }
  finish("");
  return items;
}

/** Output redirects that open their target for writing. */
const WRITE_OPS = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<>"]);
/** Words that come before the command name without being it. */
const PREFIX_WORDS = new Set([
  "!", "{", "}", "do", "done", "then", "else", "elif", "fi", "if", "while", "until", "esac",
  "exec", "command", "builtin", "nohup",
]);
/** Commands that run the rest of the line, and the options of theirs that take
 *  a value (`sudo -u root tee …`, `env -u NAME sed …`). */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["time", new Set<string>()],
  ["npx", new Set(["-p", "--package"])],
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
  ["sudo", new Set(["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir",
    "-h", "--host", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout"])],
]);
/** Longer than any real path: a runaway `cd a; cd a; …` stops growing here. */
const MAX_PATH = 4096;
const ASSIGNMENT_RE = /^[A-Za-z_]\w*=/;
const PYTHON_RE = /^python(\d+(\.\d+)?)?$/;
const JS_RUNNERS = new Set(["node", "tsx", "ts-node", "bun"]);

/** `path` made absolute against `dir`; null when `dir` is unknown or the
 *  result is longer than MAX_PATH. */
function resolvePath(path: string, dir: string | null): string | null {
  const full = path.startsWith("/") ? path : dir === null ? null : dir + "/" + path;
  return full === null || full.length > MAX_PATH ? null : posix.normalize(full);
}

function place(path: string, dir: string | null): string | null {
  if (path === "" || path === "-" || path.startsWith("/dev/")) return null;
  // A hole, or a $ or ` the shell expands in an unquoted heredoc body.
  if (path.includes(HOLE) || path.includes("$") || path.includes("`")) return null;
  return resolvePath(path, dir);
}

const placeWord = (w: Word, dir: string | null): string | null => (w.literal ? place(w.text, dir) : null);

/** The directory a cd with these arguments moves to; null when unknown. */
function cdTarget(args: Word[], dir: string | null, home: string | null): string | null {
  let k = 0;
  while (k < args.length && /^-[LPe@]+$/.test(args[k]!.text)) k++;
  if (args[k]?.text === "--") k++;
  const target = args[k];
  if (target === undefined) return home;
  if (target.text === "-" || !target.literal) return null;
  return resolvePath(target.text, dir);
}

/** The files an in-place sed edits; none when it is not in place. */
function sedFiles(args: Word[]): Word[] {
  let inPlace = false;
  let scriptGiven = false;
  const operands: Word[] = [];
  for (let a = 0; a < args.length; a++) {
    const t = args[a]!.text;
    if (t === "--") { operands.push(...args.slice(a + 1)); break; }
    if (t.startsWith("--")) {
      if (t === "--in-place" || t.startsWith("--in-place=")) inPlace = true;
      else if (t === "--expression" || t === "--file") { scriptGiven = true; a++; }
      else if (t.startsWith("--expression=") || t.startsWith("--file=")) scriptGiven = true;
      else if (t === "--line-length") a++;
      continue;
    }
    if (t.length > 1 && t.startsWith("-")) {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c]!;
        if (ch === "i") {
          inPlace = true;
          // BSD sed takes the backup suffix as the next argument ('' for none);
          // GNU sed takes none, and the next argument is the script.
          const next = args[a + 1];
          if (c === t.length - 1 && next !== undefined && (next.text === "" || /^\.[\w.-]*$/.test(next.text))) a++;
          break;
        }
        if (ch === "e" || ch === "f") {
          scriptGiven = true;
          if (c === t.length - 1) a++;
          break;
        }
        if (ch === "l") {
          if (c === t.length - 1) a++;
          break;
        }
      }
      continue;
    }
    operands.push(args[a]!);
  }
  if (!inPlace) return [];
  return scriptGiven ? operands : operands.slice(1);
}

/** The files an in-place perl edits; none when it is not in place. */
function perlFiles(args: Word[]): Word[] {
  let inPlace = false;
  let codeGiven = false;
  const operands: Word[] = [];
  for (let a = 0; a < args.length; a++) {
    const t = args[a]!.text;
    if (operands.length === 0 && t === "--") continue;
    if (operands.length === 0 && t.length > 1 && t.startsWith("-")) {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c]!;
        if (ch === "e" || ch === "E") {
          codeGiven = true;
          if (c === t.length - 1) a++;
          break;
        }
        // -i takes the rest of the cluster as a backup suffix; -I, -M, -m, -F,
        // -C and -x take the rest as their value.
        if (ch === "i") { inPlace = true; break; }
        if ("IMmFCx".includes(ch)) break;
        // -0 and -l take octal digits.
        if (ch === "0" || ch === "l") while (/[0-7]/.test(t[c + 1] ?? "")) c++;
      }
      continue;
    }
    operands.push(args[a]!);
  }
  if (!inPlace) return [];
  return codeGiven ? operands : operands.slice(1);
}

/** What an interpreter runs: inline code, its stdin, or a script file. */
function interpreterRun(name: string, args: Word[]): { code: string[]; readsStdin: boolean; script: Word | null } {
  const python = PYTHON_RE.test(name);
  const code: string[] = [];
  for (let a = 0; a < args.length; a++) {
    const t = args[a]!.text;
    if (python) {
      if (t === "-c") { code.push(args[a + 1]?.text ?? ""); return { code, readsStdin: false, script: null }; }
      if (t === "-m") return { code, readsStdin: false, script: null };
      if (t === "-X" || t === "-W") { a++; continue; }
    } else {
      if (t === "-e" || t === "--eval" || t === "-p" || t === "--print") { code.push(args[a + 1]?.text ?? ""); a++; continue; }
      if (t.startsWith("--eval=")) { code.push(t.slice("--eval=".length)); continue; }
      if (t === "-r" || t === "--require" || t === "--import" || t === "--loader" || t === "-C") { a++; continue; }
    }
    if (t === "-") return { code, readsStdin: true, script: null };
    if (t.startsWith("-")) continue;
    return { code, readsStdin: false, script: args[a]! };
  }
  return { code, readsStdin: code.length === 0, script: null };
}

// ----- Scripts -----

const STR = String.raw`'([^'\n]*)'|"([^"\n]*)"|` + "`([^`$]*)`";
// A literal, or a name that is the whole argument (not `path` of `path.join(…)`).
const ARG = String.raw`\s*(?:(?:${STR})|([A-Za-z_]\w*)(?=\s*[,)]))`;
const WRITE_CALLS: readonly RegExp[] = [
  // open(p, 'w') and open(p, encoding=…, mode='a'); the mode is checked below.
  new RegExp(String.raw`\bopen\(${ARG}\s*,\s*(?:mode\s*=\s*)?(?:${STR})`, "g"),
  new RegExp(String.raw`\bopen\(${ARG}\s*,[^)]{0,300}?\bmode\s*=\s*(?:${STR})`, "g"),
  // Path(p) and pathlib.Path(p) alike: \b falls before the P in both.
  new RegExp(String.raw`\bPath\(${ARG}\s*\)\.write_(?:text|bytes)\(`, "g"),
  new RegExp(String.raw`\b([A-Za-z_]\w*)\.write_(?:text|bytes)\(`, "g"),
  new RegExp(String.raw`\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\(${ARG}`, "g"),
];
/** Python open() modes that write. */
const WRITE_MODE_RE = /^[rwaxbt+]*[wax+][rwaxbt+]*$/;
/** Longest def/for header and block looked at, so pathological input stays
 *  linear. */
const MAX_HEADER = 2000;
const MAX_BLOCK = 20000;

function literalOf(m: RegExpMatchArray, first: number): string | undefined {
  return m[first] ?? m[first + 1] ?? m[first + 2];
}

type ScriptLang = "python" | "js";

/** Which characters of a script are code (1) and which are inside a string or
 *  a comment (0), so that `code = "open('x', 'w')"` is not read as a write. */
function codeMask(body: string, lang: ScriptLang): Uint8Array {
  const code = new Uint8Array(body.length).fill(1);
  // The last code character that is not a space: a / after one of these opens
  // a JavaScript regex literal rather than dividing.
  let prev = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    const start = i;
    if ((lang === "python" && c === "#") || (lang === "js" && c === "/" && body[i + 1] === "/")) {
      const e = body.indexOf("\n", i);
      i = e === -1 ? body.length : e;
    } else if (lang === "js" && c === "/" && body[i + 1] === "*") {
      const e = body.indexOf("*/", i + 2);
      i = e === -1 ? body.length : e + 2;
    } else if (lang === "js" && c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      let inClass = false;
      i++;
      while (i < body.length && body[i] !== "\n") {
        const d = body[i]!;
        if (d === "\\") { i += 2; continue; }
        i++;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
      }
      prev = "/";
    } else if (c === "'" || c === '"' || (lang === "js" && c === "`")) {
      const close = lang === "python" && body.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += close.length;
      while (i < body.length) {
        if (body[i] === "\\") { i += 2; continue; }
        if (body.startsWith(close, i)) { i += close.length; break; }
        // A one-line string ends at the line's end even when left open.
        if (close.length === 1 && c !== "`" && body[i] === "\n") break;
        i++;
      }
      prev = c;
    } else {
      if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") prev = c;
      i++;
      continue;
    }
    code.fill(0, start, Math.min(i, body.length));
  }
  return code;
}

/** The header of the def, function or for at `at` and the block it controls,
 *  each [start, end): python by indentation, JavaScript by braces. */
function blockOf(body: string, code: Uint8Array, at: number, lang: ScriptLang): { header: [number, number]; block: [number, number] } {
  const none = { header: [at, at] as [number, number], block: [at, at] as [number, number] };
  const headerLimit = Math.min(body.length, at + MAX_HEADER);
  if (lang === "python") {
    // The header ends at the first ':' outside brackets.
    let depth = 0;
    let colon = -1;
    for (let j = at; j < headerLimit; j++) {
      if (code[j] !== 1) continue;
      const ch = body[j];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === ":" && depth === 0) { colon = j; break; }
    }
    if (colon === -1) return none;
    const nl = body.indexOf("\n", colon);
    const eol = nl === -1 ? body.length : nl;
    const rest = body.slice(colon + 1, eol).trim();
    if (rest !== "" && !rest.startsWith("#")) return { header: [at, colon], block: [colon + 1, eol] };
    const indentAt = (from: number) => {
      let k = from;
      while (body[k] === " " || body[k] === "\t") k++;
      return k - from;
    };
    const headerIndent = indentAt(body.lastIndexOf("\n", at) + 1);
    const blockLimit = Math.min(body.length, eol + MAX_BLOCK);
    let end = eol;
    let p = eol + 1;
    while (p < blockLimit) {
      const n = body.indexOf("\n", p);
      const le = n === -1 ? body.length : n;
      if (body.slice(p, le).trim() !== "") {
        if (indentAt(p) <= headerIndent) break;
        end = le;
      }
      p = le + 1;
    }
    return { header: [at, colon], block: [eol + 1, end] };
  }
  // JavaScript: the header's parens, then a { } block or one statement.
  let j = body.indexOf("(", at);
  if (j === -1 || j >= headerLimit) return none;
  let depth = 0;
  for (; j < headerLimit; j++) {
    if (code[j] !== 1) continue;
    if (body[j] === "(") depth++;
    else if (body[j] === ")" && --depth === 0) break;
  }
  if (j >= headerLimit) return none;
  const blockLimit = Math.min(body.length, j + MAX_BLOCK);
  let k = j + 1;
  while (k < blockLimit && /\s/.test(body[k]!)) k++;
  if (body[k] === "{") {
    let d = 0;
    for (let m = k; m < blockLimit; m++) {
      if (code[m] !== 1) continue;
      if (body[m] === "{") d++;
      else if (body[m] === "}" && --d === 0) return { header: [at, j], block: [k, m + 1] };
    }
    return { header: [at, j], block: [k, blockLimit] };
  }
  let m = k;
  while (m < blockLimit && !(code[m] === 1 && (body[m] === ";" || body[m] === "\n"))) m++;
  return { header: [at, j], block: [k, m] };
}

/** File paths a python or JavaScript script writes, as written in it. */
export function scriptWrites(body: string, lang: ScriptLang): string[] {
  const code = codeMask(body, lang);
  const isCode = (at: number | undefined) => at !== undefined && code[at] === 1;
  const vars = new Map<string, string>();
  const assign = new RegExp(
    String.raw`(?<![\w$.])(?:(?:const|let|var)\s+)?([A-Za-z_]\w*)\s*=(?!=)\s*(?:(?:pathlib\.)?Path\(\s*)?(?:${STR})`,
    "g",
  );
  for (const m of body.matchAll(assign)) if (isCode(m.index)) vars.set(m[1]!, literalOf(m, 2)!);

  const targets: string[] = [];
  // Names written to that no literal settles, with where each is written.
  const names = new Map<string, number[]>();
  const addName = (name: string, at: number) => {
    const list = names.get(name);
    if (list === undefined) names.set(name, [at]);
    else list.push(at);
  };
  WRITE_CALLS.forEach((re, k) => {
    for (const m of body.matchAll(re)) {
      if (!isCode(m.index)) continue;
      if (k === 3) { addName(m[1]!, m.index!); continue; }
      if (k <= 1 && !WRITE_MODE_RE.test(literalOf(m, 5) ?? "")) continue;
      const lit = literalOf(m, 1);
      if (lit !== undefined) targets.push(lit);
      else if (m[4] !== undefined) addName(m[4], m.index!);
    }
  });

  for (const [name, calls] of names) {
    const v = vars.get(name);
    if (v !== undefined) { targets.push(v); continue; }
    calls.sort((a, b) => a - b);
    // Whether a write to the name falls inside [start, end).
    const writesIn = ([start, end]: [number, number]) => {
      let lo = 0;
      let hi = calls.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (calls[mid]! < start) lo = mid + 1;
        else hi = mid;
      }
      return lo < calls.length && calls[lo]! < end;
    };
    // Functions whose first parameter has the name, called with literals, and
    // loops over a literal list with it. When some of them write to it inside
    // their own body, only those count (`save(path)` next to `load(path)`);
    // when none does, they all do, as when edit(path, …) only collects edits
    // that a later loop writes.
    const only = <T extends { block: [number, number] }>(found: T[]) =>
      found.some((f) => writesIn(f.block)) ? found.filter((f) => writesIn(f.block)) : found;
    const defs: { fn: string; block: [number, number] }[] = [];
    for (const d of body.matchAll(/\b(?:def|function)\s+(\w+)\s*\(\s*([A-Za-z_]\w*)/g)) {
      if (d[2] === name && isCode(d.index)) defs.push({ fn: d[1]!, block: blockOf(body, code, d.index!, lang).block });
    }
    for (const { fn } of only(defs)) {
      for (const c of body.matchAll(new RegExp(String.raw`\b${fn}\(\s*(?:${STR})`, "g"))) {
        if (isCode(c.index)) targets.push(literalOf(c, 1)!);
      }
    }
    const loop = lang === "python"
      ? new RegExp(String.raw`\bfor\s+${name}\s+in\s+[[(]`, "g")
      : new RegExp(String.raw`\bfor\s*\(\s*(?:const|let|var)\s+${name}\s+of\s+\[`, "g");
    const loops: { list: string; block: [number, number] }[] = [];
    for (const f of body.matchAll(loop)) {
      if (!isCode(f.index)) continue;
      const { header, block } = blockOf(body, code, f.index!, lang);
      loops.push({ list: body.slice(f.index! + f[0].length - 1, header[1]), block });
    }
    for (const { list } of only(loops)) {
      for (const s of list.matchAll(new RegExp(STR, "g"))) targets.push(literalOf(s, 1)!);
    }
  }
  return targets;
}

// ----- The command -----

export function shellWrittenFiles(command: string, cwd: string | null, home: string | null): string[] {
  const found = new Set<string>();
  const add = (p: string | null) => { if (p !== null) found.add(p); };
  // Open ( ) and { } groups, each with the directory it started in and
  // whether it reads a pipe.
  const groups: { group: "paren" | "brace"; dir: string | null; piped: boolean }[] = [];
  const pushed: (string | null)[] = [];
  // Heredoc bodies written to a file, by that file, for a later `python3 file`.
  const writtenBodies = new Map<string, string>();
  let dir = cwd;
  let piped: string | null = null;
  let prevSep = "";
  // Where a `cd x || …` list ends up: the || branch runs only when the cd
  // failed, so it stays in the old directory up to the next && or the end of
  // the list, at the group depth the cd ran in.
  let afterOr: { dir: string | null; depth: number } | undefined;
  const pipe = (sep: string) => sep === "|" || sep === "|&";
  const endBranch = (sep: string) => {
    if (afterOr !== undefined && afterOr.depth === groups.length && sep !== "||" && !pipe(sep)) {
      dir = afterOr.dir;
      afterOr = undefined;
    }
  };

  for (const item of parse(command, home)) {
    if (item.kind === "open") {
      groups.push({ group: item.group, dir, piped: pipe(prevSep) });
      prevSep = "";
      continue;
    }
    if (item.kind === "close") {
      const g = groups.pop();
      if (g !== undefined) {
        // A subshell's cd ends with it; so does a { } group's in a pipeline or
        // the background.
        const own = g.group === "brace" && !g.piped && !pipe(item.sep) && item.sep !== "&";
        if (!own) dir = g.dir;
        if (afterOr !== undefined && afterOr.depth > groups.length) {
          if (own) afterOr.depth = groups.length;
          else afterOr = undefined;
        }
      }
      prevSep = item.sep;
      endBranch(item.sep);
      continue;
    }
    const { words, redirects, sep } = item.cmd;
    // A pipeline's commands and a background command run in subshells.
    const ownShell = sep !== "&" && sep !== "|" && sep !== "|&" && prevSep !== "|" && prevSep !== "|&";
    prevSep = sep;

    let stdin: string | null = piped;
    piped = null;
    for (const r of redirects) {
      if (r.op === "<<" || r.op === "<<-") stdin = r.body;
      else if (r.op === "<<<") stdin = r.target?.text ?? null;
    }
    let stdoutToFile = false;
    for (const r of redirects) {
      if (!WRITE_OPS.has(r.op) || r.target === null) continue;
      if (r.op === ">&" && /^(\d+|-)$/.test(r.target.text)) continue;
      const p = placeWord(r.target, dir);
      add(p);
      if (r.fd === "" || r.fd === "1") stdoutToFile = true;
      if (p !== null && stdin !== null) writtenBodies.set(p, stdin);
    }

    let k = 0;
    while (k < words.length) {
      const t = words[k]!.text;
      if (PREFIX_WORDS.has(t) || ASSIGNMENT_RE.test(t)) { k++; continue; }
      const valued = WRAPPERS.get(t);
      if (valued !== undefined) {
        k++;
        while (k < words.length) {
          const o = words[k]!.text;
          if (o === "--") { k++; break; }
          if (t === "env" && ASSIGNMENT_RE.test(o)) { k++; continue; }
          if (!o.startsWith("-")) break;
          k += valued.has(o) ? 2 : 1;
        }
        continue;
      }
      break;
    }
    const name = words[k]?.text ?? "";
    const args = words.slice(k + 1);

    if (name === "cd" || name === "pushd" || name === "popd") {
      if (ownShell) {
        let next: string | null;
        if (name === "popd") next = pushed.length > 0 ? pushed.pop()! : null;
        else {
          if (name === "pushd") pushed.push(dir);
          next = cdTarget(args, dir, home);
        }
        if (sep === "||") afterOr = { dir: next, depth: groups.length };
        else dir = next;
      }
    } else if (name === "tee") {
      let options = true;
      for (const a of args) {
        if (options && a.text === "--") { options = false; continue; }
        if (options && a.text.length > 1 && a.text.startsWith("-")) continue;
        add(placeWord(a, dir));
      }
    } else if (name === "sed") sedFiles(args).forEach((a) => add(placeWord(a, dir)));
    else if (name === "perl") perlFiles(args).forEach((a) => add(placeWord(a, dir)));
    else if (PYTHON_RE.test(name) || JS_RUNNERS.has(name)) {
      const run = interpreterRun(name, args);
      const scripts = [...run.code];
      if (run.readsStdin && stdin !== null) scripts.push(stdin);
      if (run.script !== null) {
        const p = placeWord(run.script, dir);
        const body = p === null ? undefined : writtenBodies.get(p);
        if (body !== undefined) scripts.push(body);
      }
      const lang = PYTHON_RE.test(name) ? "python" : "js";
      for (const s of scripts) for (const t of scriptWrites(s, lang)) add(place(t, dir));
    } else if (name === "cat" && sep === "|" && !stdoutToFile && stdin !== null && args.length === 0) {
      piped = stdin;
    }
    // The || branch ends here: the cd before it took effect.
    endBranch(sep);
  }
  return [...found];
}
