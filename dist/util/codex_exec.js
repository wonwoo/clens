/**
 * The shell commands a Codex `exec` program runs through
 * tools.exec_command. exec ("code mode") is JavaScript the model writes, and
 * a command it runs exists only as a string literal in that code, such as
 * tools.exec_command({cmd:"npm test",workdir:"/w/app"}). Shared by the
 * indexer (the files those commands wrote) and the MCP server (the git lines
 * of a session record).
 *
 * Reads literals only: a cmd built when the code runs (a variable, a
 * template with ${…}, a concatenation) is skipped. Calls inside comments and
 * strings are not calls. Regular-expression literals are not recognised; a
 * "/" starts a comment only before "/" or "*". Never throws.
 */
const CALL_RE = /tools\s*\.\s*exec_command\s*\(\s*\{/y;
const KEY_RE = /[A-Za-z_$][\w$]*/y;
const WORD_CHAR_RE = /[\w$.]/;
export function execCodeCommands(code) {
    return execCodeScan(code).commands;
}
/** The literal commands of `code`, and how many of its tools.exec_command
 *  calls build their cmd at run time (no literal to read). */
export function execCodeScan(code) {
    const out = [];
    let built = 0;
    let i = 0;
    while (i < code.length) {
        const c = code[i];
        const skipped = skipNonCode(code, i);
        if (skipped !== i) {
            i = skipped;
        }
        else if (c === "t" && (i === 0 || !WORD_CHAR_RE.test(code[i - 1]))) {
            CALL_RE.lastIndex = i;
            const m = CALL_RE.exec(code);
            if (m === null) {
                i += 1;
                continue;
            }
            const obj = readObject(code, i + m[0].length);
            if (obj.closed && obj.cmd !== null)
                out.push({ cmd: obj.cmd, workdir: obj.workdir });
            else if (obj.closed)
                built += 1;
            i = obj.end;
        }
        else {
            i += 1;
        }
    }
    return { commands: out, built };
}
/** Past a comment, string or template starting at `i`, or `i` itself when
 *  none starts there. */
function skipNonCode(code, i) {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") {
        const end = code.indexOf("\n", i);
        return end === -1 ? code.length : end + 1;
    }
    if (c === "/" && code[i + 1] === "*") {
        const end = code.indexOf("*/", i + 2);
        return end === -1 ? code.length : end + 2;
    }
    if (c === '"' || c === "'")
        return readQuoted(code, i)?.end ?? code.length;
    if (c === "`")
        return readTemplate(code, i)?.end ?? code.length;
    return i;
}
function skipSpace(code, i) {
    for (;;) {
        while (i < code.length && /\s/.test(code[i]))
            i += 1;
        if (code[i] === "/" && (code[i + 1] === "/" || code[i + 1] === "*"))
            i = skipNonCode(code, i);
        else
            return i;
    }
}
/** The cmd and workdir literals of the object literal whose "{" is just
 *  before `start`, and the position past its "}". `closed` is false when the
 *  code ends first, or when a ")" or "]" stands where a property should end
 *  (unbalanced code, or a regular expression holding one); `end` is then
 *  that position. */
function readObject(code, start) {
    let cmd = null;
    let workdir = null;
    let i = start;
    for (;;) {
        i = skipSpace(code, i);
        if (i >= code.length)
            return { cmd, workdir, end: code.length, closed: false };
        if (code[i] === "}")
            return { cmd, workdir, end: i + 1, closed: true };
        if (code[i] === ",") {
            i += 1;
            continue;
        }
        let key = null;
        if (code[i] === '"' || code[i] === "'") {
            const s = readQuoted(code, i);
            if (s === null)
                return { cmd, workdir, end: code.length, closed: false };
            key = s.value;
            i = s.end;
        }
        else {
            KEY_RE.lastIndex = i;
            const m = KEY_RE.exec(code);
            if (m !== null) {
                key = m[0];
                i += m[0].length;
            }
        }
        i = skipSpace(code, i);
        if (code[i] !== ":") {
            // A shorthand, spread or computed property: no literal to read.
            i = skipValue(code, i);
            if (code[i] !== "," && code[i] !== "}")
                return { cmd, workdir, end: i, closed: false };
            continue;
        }
        i = skipSpace(code, i + 1);
        const lit = code[i] === '"' || code[i] === "'" ? readQuoted(code, i) : code[i] === "`" ? readTemplate(code, i) : undefined;
        if (lit === null)
            return { cmd, workdir, end: code.length, closed: false };
        if (lit !== undefined) {
            const after = skipSpace(code, lit.end);
            // The literal is the whole value only when the property ends there.
            if (lit.value !== null && (code[after] === "," || code[after] === "}")) {
                if (key === "cmd")
                    cmd = lit.value;
                else if (key === "workdir")
                    workdir = lit.value;
                i = after;
                continue;
            }
        }
        i = skipValue(code, i);
        if (code[i] !== "," && code[i] !== "}")
            return { cmd, workdir, end: i, closed: false };
    }
}
/** The position of the "," or "}" that ends the value starting at `i`, at
 *  the object's own depth, or the end of the code. */
function skipValue(code, i) {
    let depth = 0;
    while (i < code.length) {
        const skipped = skipNonCode(code, i);
        if (skipped !== i) {
            i = skipped;
            continue;
        }
        const c = code[i];
        if (c === "(" || c === "[" || c === "{")
            depth += 1;
        else if (c === ")" || c === "]" || c === "}") {
            if (depth === 0)
                return i;
            depth -= 1;
        }
        else if (c === "," && depth === 0)
            return i;
        i += 1;
    }
    return code.length;
}
/** A '…' or "…" string starting at `i`, unescaped, and the position past its
 *  closing quote; null when the code ends first. */
function readQuoted(code, i) {
    const quote = code[i];
    let value = "";
    let j = i + 1;
    while (j < code.length) {
        const c = code[j];
        if (c === quote)
            return { value, end: j + 1 };
        if (c === "\\") {
            const e = unescape(code, j);
            value += e.text;
            j = e.end;
        }
        else {
            value += c;
            j += 1;
        }
    }
    return null;
}
/** A `…` template starting at `i` and the position past it; its value is
 *  null when it holds a ${…} part, which is known only when the code runs.
 *  Null when the code ends first. */
function readTemplate(code, i) {
    let value = "";
    let j = i + 1;
    while (j < code.length) {
        const c = code[j];
        if (c === "`")
            return { value, end: j + 1 };
        if (c === "\\") {
            const e = unescape(code, j);
            if (value !== null)
                value += e.text;
            j = e.end;
        }
        else if (c === "$" && code[j + 1] === "{") {
            value = null;
            j = skipPlaceholder(code, j + 2);
        }
        else {
            if (value !== null)
                value += c;
            j += 1;
        }
    }
    return null;
}
/** Past the "}" that closes a template's ${…} part whose code starts at `i`. */
function skipPlaceholder(code, i) {
    let depth = 0;
    while (i < code.length) {
        const skipped = skipNonCode(code, i);
        if (skipped !== i) {
            i = skipped;
            continue;
        }
        const c = code[i];
        if (c === "{")
            depth += 1;
        else if (c === "}") {
            if (depth === 0)
                return i + 1;
            depth -= 1;
        }
        i += 1;
    }
    return code.length;
}
/** The text of the escape whose backslash is at `i`, as JavaScript reads
 *  it, and the position past the escape. */
function unescape(code, i) {
    const n = code[i + 1];
    if (n === undefined)
        return { text: "", end: i + 1 };
    const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
    if (n in simple)
        return { text: simple[n], end: i + 2 };
    if (n === "0" && !/[0-9]/.test(code[i + 2] ?? ""))
        return { text: "\0", end: i + 2 };
    if (n === "x") {
        const hex = code.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex))
            return { text: String.fromCharCode(parseInt(hex, 16)), end: i + 4 };
    }
    if (n === "u") {
        const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(code.slice(i + 2, i + 10));
        if (braced !== null) {
            const cp = parseInt(braced[1], 16);
            if (cp <= 0x10ffff)
                return { text: String.fromCodePoint(cp), end: i + 2 + braced[0].length };
        }
        const hex = code.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex))
            return { text: String.fromCharCode(parseInt(hex, 16)), end: i + 6 };
    }
    // A backslash before a line break continues the line.
    if (n === "\r" && code[i + 2] === "\n")
        return { text: "", end: i + 3 };
    if (n === "\n" || n === "\r" || n === " " || n === " ")
        return { text: "", end: i + 2 };
    return { text: n, end: i + 2 };
}
//# sourceMappingURL=codex_exec.js.map