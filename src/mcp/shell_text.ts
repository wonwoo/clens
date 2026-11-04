/**
 * Reading shell text out of stored tool calls: the commands one call ran;
 * which parts of each line are shell code rather than quoted text, a comment
 * or a heredoc body (the session record's git lines, left_off.ts); and the
 * programs a command runs, read in the order the shell reads it (the checks
 * on a branch, checks.ts).
 */

import { execCodeCommands } from "../util/codex_exec.js";

/** The command of a shell input: a Claude Code Bash input's `command` or a
 *  Codex exec_command input's `cmd`. The parser keeps a shell input up to
 *  64 KB and cuts a longer one, which leaves it invalid JSON, so the command
 *  is then read off the front of the text, where it always sits. */
export function commandOf(inputJson: string | null): string | null {
  if (inputJson === null) return null;
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { command, cmd } = parsed as { command?: unknown; cmd?: unknown };
    return typeof command === "string" ? command : typeof cmd === "string" ? cmd : null;
  } catch {
    const m = /"(?:command|cmd)":"((?:[^"\\]|\\.)*)/.exec(inputJson);
    if (m === null) return null;
    try {
      return JSON.parse('"' + m[1]! + '"') as string;
    } catch {
      // The cut fell inside an escape such as \u00.
      return m[1]!;
    }
  }
}

/** Older Codex's exec_command_begin input: the command's words joined, a
 *  shell with -c first (`bash -lc npm test`); group 1 is what it ran. */
const JOINED_SHELL_C = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c[A-Za-z]*\s+([\s\S]*?)\s*$/;

/** The shell commands one call ran: a Bash or exec_command input's command,
 *  the commands Codex exec code runs through tools.exec_command, or what an
 *  older Codex exec_command_begin event ran. */
export function shellCommands(name: string, inputJson: string | null): string[] {
  if (name !== "exec") return [commandOf(inputJson)].filter((c): c is string => c !== null);
  const commands = execCodeCommands(inputJson ?? "").map((c) => c.cmd);
  // Its words were joined with their quotes gone, so what follows -c is the
  // command itself; no exec code starts with `bash -lc`.
  const joined = commands.length === 0 && inputJson !== null ? JOINED_SHELL_C.exec(inputJson) : null;
  return joined === null ? commands : [joined[1]!];
}

/** A heredoc opener (<<EOF, <<'EOF', <<-"EOF"), not a here-string (<<<). */
const HEREDOC = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/;

/** A shell run with -c (or -lc, -ec, …) before the string it runs:
 *  `/bin/zsh -lc '…'`, as older Codex wraps every command. */
const SHELL_C = /(?:^|[\s;&|(])(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c[A-Za-z]*\s+$/;

/** Which positions of `line` are shell code, not the inside of a '…' or "…"
 *  string or a comment. `stack` holds the quotes and $( ), ( ) and `…` still
 *  open from the lines before, and is updated; code in a $( ) or `…` inside
 *  "…" is code again, and so is the string a `sh -c` runs ('c or "c). */
function codePositions(line: string, stack: string[]): boolean[] {
  const code = new Array<boolean>(line.length).fill(false);
  for (let j = 0; j < line.length; j++) {
    const top = stack.at(-1);
    const c = line[j]!;
    if (top === "'") {
      if (c === "'") stack.pop();
      continue;
    }
    if ((top === "'c" && c === "'") || (top === '"c' && c === '"')) {
      stack.pop();
      continue;
    }
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (top === '"') {
      if (c === '"') stack.pop();
      else if (c === "$" && line[j + 1] === "(") {
        stack.push("(");
        j += 1;
      } else if (c === "`") stack.push("`");
      continue;
    }
    if (c === "#" && top !== "'c" && top !== '"c' && (j === 0 || /[\s;&|(]/.test(line[j - 1]!))) break;
    code[j] = true;
    if (c === "'" || c === '"') stack.push(SHELL_C.test(line.slice(0, j)) ? c + "c" : c);
    else if (c === "(") stack.push(c);
    else if (c === ")" && top === "(") stack.pop();
    else if (c === "`") {
      if (top === "`") stack.pop();
      else stack.push(c);
    }
  }
  return code;
}

/** Every line of `command` outside heredoc bodies, trimmed, oldest first:
 *  `code[i]` is true where `line[i]` is shell code (codePositions), and
 *  `body` is the heredoc body that line opens (lines joined by "\n"), or null.
 *  A heredoc's body is text (a commit message, a file being written), not
 *  commands; its closing line is skipped with it. */
export function codeLines(command: string): { line: string; code: boolean[]; body: string | null }[] {
  const lines = command.split("\n");
  const out: { line: string; code: boolean[]; body: string | null }[] = [];
  const stack: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const code = codePositions(line, stack);
    const opener = HEREDOC.exec(line);
    const heredoc = opener !== null && code[opener.index] ? opener : null;
    if (heredoc === null) {
      out.push({ line, code, body: null });
      continue;
    }
    const close = lines.findIndex((l, j) => j > i && l.trim() === heredoc[2]);
    const bodyEnd = close === -1 ? lines.length : close;
    out.push({ line, code, body: lines.slice(i + 1, bodyEnd).join("\n") });
    i = bodyEnd;
  }
  return out;
}

/** One simple command as the shell splits it: its words with quotes,
 *  escapes and line continuations taken off; where each word starts in
 *  `source`, the text it was read from; and where the command ends there,
 *  past its last word or redirection. */
export interface ShellCommand { words: string[]; starts: number[]; end: number; source: string }

/** The simple commands of `text`, read as bash reads it: '…' is literal;
 *  in "…" a backslash escapes only $ ` " \ and a line break; outside quotes
 *  a backslash escapes the next character, and with a line break it joins
 *  the lines; a # starting a word starts a comment to the line's end; ;, &,
 *  |, &&, ||, |&, (, ) and a line break end a command; a redirection and its
 *  target are not words; a heredoc's body, after the line that opens it, is
 *  skipped. The commands inside $( ) and `…`, which run too, come before the
 *  command holding them. */
export function readShell(text: string): ShellCommand[] {
  const out: ShellCommand[] = [];
  read(text, 0, false, out, 0);
  return out;
}

const OPERATOR_CHARS = "<>&|-";
/** Deeper $( ), `…` and <( ) are kept as text, not read: thousands of them
 *  ran the reader out of stack. */
const MAX_NESTING = 64;

/** One escape of $'…' at text[j] (just past the backslash): its character
 *  and where the text goes on, as bash decodes it. */
function ansiEscape(text: string, j: number): { char: string; next: number } {
  const c = text[j] ?? "";
  const simple: Record<string, string> = {
    a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?",
  };
  if (c in simple) return { char: simple[c]!, next: j + 1 };
  const code = (digits: RegExp, radix: number, from: number) => {
    const m = digits.exec(text.slice(from));
    const point = m === null ? NaN : parseInt(m[0], radix);
    // Past U+10FFFF there is no character; bash leaves the escape as it is.
    return m === null || point > 0x10ffff ? null : { char: String.fromCodePoint(point), next: from + m[0].length };
  };
  if (c === "x") return code(/^[0-9A-Fa-f]{1,2}/, 16, j + 1) ?? { char: "\\x", next: j + 1 };
  if (c === "u") return code(/^[0-9A-Fa-f]{1,4}/, 16, j + 1) ?? { char: "\\u", next: j + 1 };
  if (c === "U") return code(/^[0-9A-Fa-f]{1,8}/, 16, j + 1) ?? { char: "\\U", next: j + 1 };
  if (/[0-7]/.test(c)) return code(/^[0-7]{1,3}/, 8, j)!;
  if (c === "c" && j + 1 < text.length) return { char: String.fromCharCode(text.charCodeAt(j + 1) & 31), next: j + 2 };
  return { char: "\\" + c, next: j + 1 };
}

/** Reads `text` from `from`; returns where it stopped: the end, or, when
 *  `inSub`, just past the ) that closes the $( ) or <( ) it reads. */
function read(text: string, from: number, inSub: boolean, out: ShellCommand[], depth: number): number {
  let words: string[] = [];
  let starts: number[] = [];
  let end = from;
  let word: string | null = null;
  let wordStart = 0;
  let quoted = false;
  // The next word is a redirection's target, or a heredoc's delimiter.
  let target: "file" | "heredoc" | null = null;
  let stripTabs = false;
  // Subshells opened inside: their ) is not the one that ends a $( ).
  let parens = 0;
  const heredocs: { delimiter: string; quoted: boolean; stripTabs: boolean }[] = [];

  const begin = (at: number): void => {
    if (word !== null) return;
    word = "";
    wordStart = at;
    quoted = false;
  };
  /** Adds to the word, starting one at `at` when none is open. */
  const add = (at: number, chars: string): void => {
    begin(at);
    word = (word ?? "") + chars;
  };
  const finishWord = (at: number): void => {
    if (word === null) return;
    if (target === "heredoc") heredocs.push({ delimiter: word, quoted, stripTabs });
    else if (target === null) {
      words.push(word);
      starts.push(wordStart);
    }
    target = null;
    end = at;
    word = null;
  };
  const finishCommand = (): void => {
    if (words.length > 0) out.push({ words, starts, end, source: text });
    words = [];
    starts = [];
  };
  /** Past the bodies of the heredocs opened on the line that ended at i - 1. */
  const skipBodies = (i: number): number => {
    for (const h of heredocs) {
      while (i < text.length) {
        let lineEnd = text.indexOf("\n", i);
        if (lineEnd === -1) lineEnd = text.length;
        let line = text.slice(i, lineEnd);
        // In an unquoted heredoc a backslash and a line break join lines;
        // an escaped backslash (\\) at the end does not.
        while (!h.quoted && /(?:^|[^\\])(?:\\\\)*\\$/.test(line) && lineEnd < text.length) {
          let next = text.indexOf("\n", lineEnd + 1);
          if (next === -1) next = text.length;
          line = line.slice(0, -1) + text.slice(lineEnd + 1, next);
          lineEnd = next;
        }
        i = lineEnd + 1;
        if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.delimiter) break;
      }
    }
    heredocs.length = 0;
    return Math.min(i, text.length);
  };
  /** The text of `…` from i (just past the opening one) and where it ends. */
  const backquoted = (i: number): { inner: string; next: number } => {
    let inner = "";
    for (; i < text.length && text[i] !== "`"; i++) {
      if (text[i] === "\\" && /[`\\$]/.test(text[i + 1] ?? "")) i += 1;
      inner += text[i];
    }
    return { inner, next: i + 1 };
  };

  let i = from;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "\\") {
      if (next !== "\n") {
        add(i, next ?? "");
        // An escaped character quotes the word: <<\EOF is a quoted heredoc.
        quoted = true;
      }
      i += 2;
    } else if (c === "'") {
      begin(i);
      quoted = true;
      const close = text.indexOf("'", i + 1);
      const stop = close === -1 ? text.length : close;
      add(i, text.slice(i + 1, stop));
      i = stop + 1;
    } else if (c === "$" && next === "'") {
      // $'…' decodes backslash escapes (ansiEscape).
      begin(i);
      quoted = true;
      let j = i + 2;
      while (j < text.length && text[j] !== "'") {
        if (text[j] === "\\") {
          const e = ansiEscape(text, j + 1);
          add(i, e.char);
          j = e.next;
        } else {
          add(i, text[j]!);
          j += 1;
        }
      }
      i = j + 1;
    } else if (c === '"') {
      begin(i);
      quoted = true;
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        const d = text[j]!;
        if (d === "\\" && text[j + 1] === "\n") {
          j += 2;
        } else if (d === "\\" && /[$`"\\]/.test(text[j + 1] ?? "")) {
          add(i, text[j + 1]!);
          j += 2;
        } else if (d === "$" && text[j + 1] === "(") {
          const stop = depth < MAX_NESTING ? read(text, j + 2, true, out, depth + 1) : j + 2;
          add(i, text.slice(j, stop));
          j = stop;
        } else if (d === "`") {
          const { inner, next: stop } = backquoted(j + 1);
          if (depth < MAX_NESTING) read(inner, 0, false, out, depth + 1);
          add(i, text.slice(j, stop));
          j = stop;
        } else {
          add(i, d);
          j += 1;
        }
      }
      i = j + 1;
    } else if ((c === "$" || c === "<" || c === ">") && next === "(") {
      // A command substitution, or a process substitution <( ) or >( ):
      // a word whose commands run.
      const stop = depth < MAX_NESTING ? read(text, i + 2, true, out, depth + 1) : i + 2;
      add(i, text.slice(i, stop));
      i = stop;
    } else if (c === "$" && next === "{") {
      const close = text.indexOf("}", i);
      const stop = close === -1 ? text.length : close + 1;
      add(i, text.slice(i, stop));
      i = stop;
    } else if (c === "`") {
      const { inner, next: stop } = backquoted(i + 1);
      if (depth < MAX_NESTING) read(inner, 0, false, out, depth + 1);
      add(i, text.slice(i, stop));
      i = stop;
    } else if (c === "#" && word === null) {
      const lineEnd = text.indexOf("\n", i);
      i = lineEnd === -1 ? text.length : lineEnd;
    } else if (c === " " || c === "\t") {
      finishWord(i);
      i += 1;
    } else if (c === "\n") {
      finishWord(i);
      finishCommand();
      i = skipBodies(i + 1);
    } else if (c === ")") {
      finishWord(i);
      finishCommand();
      i += 1;
      if (parens > 0) parens -= 1;
      else if (inSub) return i;
    } else if (c === "(") {
      finishWord(i);
      finishCommand();
      parens += 1;
      i += 1;
    } else if (c === "<" || c === ">" || (c === "&" && next === ">")) {
      // A file descriptor right before it (2>) is part of the redirection.
      // (word is set inside the helpers above, which the type checker does not follow.)
      const open = word as string | null;
      if (open !== null && !quoted && /^\d+$/.test(open) && wordStart + open.length === i) word = null;
      else finishWord(i);
      let op = "";
      while (i < text.length && OPERATOR_CHARS.includes(text[i]!)) op += text[i++];
      if (op === "<<" || op === "<<-") {
        target = "heredoc";
        stripTabs = op === "<<-";
      } else {
        target = "file";
      }
      end = i;
    } else if (c === ";" || c === "&" || c === "|") {
      finishWord(i);
      finishCommand();
      i += next === c || (c === "|" && next === "&") ? 2 : 1;
    } else {
      add(i, c);
      i += 1;
    }
  }
  finishWord(i);
  finishCommand();
  return i;
}

/** A program a command runs, with its arguments, and the command's text
 *  from the program word on, line continuations taken out. */
export interface ExecutedCommand { argv: string[]; text: string }

/** Words that start a compound command or negate one, before its program. */
const RESERVED = new Set(["!", "{", "if", "then", "else", "elif", "do", "while", "until"]);
/** Words that close one, standing alone as a command. */
const CLOSING = new Set(["fi", "done", "esac", "}"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const base = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

/** The command a shell's -c runs: the first word after its options, or
 *  null without -c. -o and -O (alone or ending a group, as in -eo) and
 *  --rcfile and --init-file take the word after them. */
function shellScript(argv: string[]): string | null {
  let c = false;
  for (let j = 1; j < argv.length; j++) {
    const a = argv[j]!;
    if (a === "--") return c ? (argv[j + 1] ?? null) : null;
    if (a === "--rcfile" || a === "--init-file") {
      j += 1;
    } else if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a.startsWith("-") && a.includes("c")) c = true;
      if (/[oO]$/.test(a)) j += 1;
    } else if (!a.startsWith("--")) {
      return c ? a : null;
    }
  }
  return null;
}

/** The programs `command` runs, in reading order: each simple command's
 *  program past reserved words, NAME=value assignments and the wrappers
 *  sudo, time, env, exec, nohup, nice and timeout; for a shell given -c, the
 *  programs of the command it runs instead of the shell. */
export function executedCommands(command: string, depth = 0): ExecutedCommand[] {
  const out: ExecutedCommand[] = [];
  for (const { words: w, starts, end, source } of readShell(command)) {
    let k = 0;
    for (;;) {
      const word = w[k];
      if (word === undefined) break;
      const program = base(word);
      if (RESERVED.has(word) || ASSIGNMENT.test(word)) {
        k += 1;
      } else if (program === "sudo" || program === "time" || program === "exec" || program === "nohup") {
        k += 1;
        while (w[k]?.startsWith("-")) k += 1;
      } else if (program === "env") {
        k += 1;
        while (w[k] !== undefined && (w[k]!.startsWith("-") || ASSIGNMENT.test(w[k]!))) k += 1;
      } else if (program === "nice") {
        k += 1;
        if (w[k] === "-n") k += 2;
        else if (/^-\d+$/.test(w[k] ?? "")) k += 1;
      } else if (program === "timeout") {
        k += 1;
        while (w[k]?.startsWith("-")) k += ["-s", "-k", "--signal", "--kill-after"].includes(w[k]!) ? 2 : 1;
        k += 1; // the duration
      } else {
        break;
      }
    }
    const argv = w.slice(k);
    if (argv.length === 0 || (argv.length === 1 && CLOSING.has(argv[0]!))) continue;
    if (SHELLS.has(base(argv[0]!)) && depth < 4) {
      const script = shellScript(argv);
      if (script !== null) {
        out.push(...executedCommands(script, depth + 1));
        continue;
      }
    }
    out.push({ argv, text: source.slice(starts[k], end).replace(/\\\n[ \t]*/g, "").trim() });
  }
  return out;
}
