import { describe, expect, it } from "vitest";

import { execCodeCommands, execCodeScan } from "../src/util/codex_exec.js";

describe("execCodeCommands", () => {
  it("reads a literal cmd and workdir", () => {
    expect(execCodeCommands('await tools.exec_command({cmd:"git status",workdir:"/w/app"})')).toEqual([
      { cmd: "git status", workdir: "/w/app" },
    ]);
  });

  it("unescapes a single-quoted string", () => {
    expect(execCodeCommands("tools.exec_command({ cmd: 'echo \\'hi\\' > a.txt' })")).toEqual([
      { cmd: "echo 'hi' > a.txt", workdir: null },
    ]);
  });

  it("turns \\n in a string into a line break", () => {
    expect(execCodeCommands("tools.exec_command({cmd:\"cat > n.md <<'EOF'\\nx\\nEOF\"})")).toEqual([
      { cmd: "cat > n.md <<'EOF'\nx\nEOF", workdir: null },
    ]);
  });

  it("keeps a template without ${…} and skips one with it or a cmd that is not a literal", () => {
    expect(execCodeCommands("tools.exec_command({cmd:`ls -la`})")).toEqual([{ cmd: "ls -la", workdir: null }]);
    expect(execCodeCommands("tools.exec_command({cmd:`ls ${dir}`})")).toEqual([]);
    expect(execCodeCommands('const c = "ls"; tools.exec_command({cmd: c})')).toEqual([]);
    expect(execCodeCommands('tools.exec_command({cmd: "ls " + dir})')).toEqual([]);
  });

  it("reads the properties in any order, with quoted keys and other properties around them", () => {
    expect(execCodeCommands('tools.exec_command({workdir:"/w", cmd:"pwd", yield_time_ms:1000})')).toEqual([
      { cmd: "pwd", workdir: "/w" },
    ]);
    expect(execCodeCommands('tools.exec_command({"cmd":"pwd"})')).toEqual([{ cmd: "pwd", workdir: null }]);
  });

  it("reads every call, in order", () => {
    expect(execCodeCommands(
      'const [a, b] = await Promise.all([tools.exec_command({cmd:"npm test"}), tools.exec_command({cmd:"npm run build"})]);',
    )).toEqual([
      { cmd: "npm test", workdir: null },
      { cmd: "npm run build", workdir: null },
    ]);
  });

  it("skips calls inside comments and strings", () => {
    const code =
      "// tools.exec_command({cmd:'rm x'})\n" +
      "/* tools.exec_command({cmd:'rm y'}) */ const s = \"tools.exec_command({cmd:'rm z'})\"; await tools.exec_command({cmd:'ls'})";
    expect(execCodeCommands(code)).toEqual([{ cmd: "ls", workdir: null }]);
  });

  it("does not take other names, and stops without throwing on unterminated code", () => {
    expect(execCodeCommands('mytools.exec_command({cmd:"x"})')).toEqual([]);
    expect(execCodeCommands('tools.exec_commandx({cmd:"x"})')).toEqual([]);
    expect(execCodeCommands('tools.exec_command({cmd:"abc')).toEqual([]);
  });

  it("gives up on an object it loses track of and reads the calls after it", () => {
    // A ")" or "]" where a property should end: unbalanced code, or a regular
    // expression holding one (regular expressions are not recognised).
    for (const code of [
      'tools.exec_command({cmd:"x")',
      'tools.exec_command({cmd: "ls"]',
      'await tools.exec_command({cmd: s.replace(/\\)/g, ""), workdir: "/w"})',
      'await tools.exec_command({cmd: s.replace(/[)]/g, "-")})',
    ]) {
      expect(execCodeScan(code)).toEqual({ commands: [], built: 0 });
      expect(execCodeCommands(`${code}; await tools.exec_command({cmd:"git status"})`)).toEqual([
        { cmd: "git status", workdir: null },
      ]);
    }
  });
});

describe("execCodeScan", () => {
  it("counts the calls whose cmd is built at run time next to the literal commands", () => {
    expect(execCodeScan('await tools.exec_command({cmd:"ls"})')).toEqual({ commands: [{ cmd: "ls", workdir: null }], built: 0 });
    expect(execCodeScan('const c = "ls"; await tools.exec_command({cmd: c}); await tools.exec_command({cmd:`pwd ${x}`})')).toEqual({
      commands: [],
      built: 2,
    });
    expect(execCodeScan('// tools.exec_command({cmd: c})\nconst s = "tools.exec_command({cmd: c})";')).toEqual({ commands: [], built: 0 });
  });
});
