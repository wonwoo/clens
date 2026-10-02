import { describe, expect, it } from "vitest";

import { shellWrittenFiles } from "../src/indexer/shell_writes.js";

const HOME = "/home/u";
const w = (command: string, cwd: string | null = "/w") => shellWrittenFiles(command, cwd, HOME);

describe("shellWrittenFiles — redirects", () => {
  it("takes > and >> targets, relative ones against cwd", () => {
    expect(w("echo hi > out.txt")).toEqual(["/w/out.txt"]);
    expect(w("echo hi >> /abs/log.txt")).toEqual(["/abs/log.txt"]);
    expect(w("echo hi >| clobber.txt")).toEqual(["/w/clobber.txt"]);
    expect(w("echo hi >out.txt")).toEqual(["/w/out.txt"]);
  });

  it("takes fd and &> redirects to a file, not fd duplication or /dev", () => {
    expect(w("cmd 2> err.log")).toEqual(["/w/err.log"]);
    expect(w("cmd 3>fd3.log")).toEqual(["/w/fd3.log"]);
    expect(w("cmd &> all.log")).toEqual(["/w/all.log"]);
    expect(w("cmd &>> all.log")).toEqual(["/w/all.log"]);
    expect(w("cmd >& all.log")).toEqual(["/w/all.log"]);
    expect(w("cmd 2>&1")).toEqual([]);
    expect(w("cmd 1>&2")).toEqual([]);
    expect(w("cmd >&-")).toEqual([]);
    expect(w("cmd 2>/dev/null")).toEqual([]);
    expect(w("cmd >/dev/null 2>&1")).toEqual([]);
    expect(w("cmd &>/dev/null")).toEqual([]);
  });

  it("keeps a quoted target whole and normalizes .. and .", () => {
    expect(w('echo x > "my file.txt"')).toEqual(["/w/my file.txt"]);
    expect(w("echo x > 'a b/c.txt'")).toEqual(["/w/a b/c.txt"]);
    expect(w("echo x > ../up.txt", "/w/app")).toEqual(["/w/up.txt"]);
    expect(w("echo x > ./here.txt")).toEqual(["/w/here.txt"]);
  });

  it("lists a file written twice once, in first-seen order", () => {
    expect(w("echo a > b.txt; echo c >> b.txt; echo d > a.txt")).toEqual(["/w/b.txt", "/w/a.txt"]);
  });

  it("reads no redirect inside quotes, comments, [[ ]], (( )) or process substitution", () => {
    expect(w('echo "a > b"')).toEqual([]);
    expect(w("echo 'a >> b'")).toEqual([]);
    expect(w("node -e 'if (a > b) console.log(1)'")).toEqual([]);
    expect(w("echo x # > commented.txt")).toEqual([]);
    expect(w('[[ "$a" > "$b" ]] && echo yes')).toEqual([]);
    expect(w("(( n > 3 )) && echo big")).toEqual([]);
    expect(w("for ((i=0; i>3; i++)); do :; done")).toEqual([]);
    expect(w("diff <(sort a) <(sort b)")).toEqual([]);
    expect(w("echo x | tee >(cat) > /dev/null")).toEqual([]);
  });

  it("leaves out a target known only when the command runs", () => {
    expect(w('echo > "$f"')).toEqual([]);
    expect(w("echo > $OUT/x.txt")).toEqual([]);
    expect(w("echo > ${DIR}/x.txt")).toEqual([]);
    expect(w("echo > $(date +%s).log")).toEqual([]);
    expect(w("echo > `date`.log")).toEqual([]);
    expect(w("echo > *.txt")).toEqual([]);
    expect(w("echo > out{1,2}.txt")).toEqual([]);
    expect(w("echo > ~other/x.txt")).toEqual([]);
  });

  it("expands ~ and ~/ to the home directory", () => {
    expect(w("echo x > ~/notes.md")).toEqual(["/home/u/notes.md"]);
    expect(shellWrittenFiles("echo x > ~/notes.md", "/w", null)).toEqual([]);
  });

  it("does not take an input redirect or a redirect with no target", () => {
    expect(w("grep -n x </path/redacted>")).toEqual([]);
    expect(w("sort < in.txt")).toEqual([]);
    expect(w("echo x >")).toEqual([]);
    expect(w("echo x > ;")).toEqual([]);
  });

  it("drops a relative target without a cwd but keeps an absolute one", () => {
    expect(w("echo > rel.txt; echo > /abs.txt", null)).toEqual(["/abs.txt"]);
  });

  it("takes a redirect after a pipeline, a loop or a block", () => {
    expect(w("ls | sort > sorted.txt")).toEqual(["/w/sorted.txt"]);
    expect(w("for i in 1 2; do echo $i; done > loop.log")).toEqual(["/w/loop.log"]);
    expect(w("{ echo a; echo b; } > block.txt")).toEqual(["/w/block.txt"]);
    expect(w("while read l; do echo \"$l\" >> out.txt; done < in.txt")).toEqual(["/w/out.txt"]);
    expect(w("if true; then echo x > then.txt; else echo y > else.txt; fi")).toEqual(["/w/then.txt", "/w/else.txt"]);
  });

  it("follows the shell through a case statement", () => {
    expect(w("case $x in a) echo > a.txt;; b) echo > b.txt;; esac; echo > after.txt")).toEqual([
      "/w/a.txt", "/w/b.txt", "/w/after.txt",
    ]);
  });

  it("skips the text of $( ) and backticks, heredoc and quotes included", () => {
    expect(w('echo "$(cat "a > b")" > out.txt')).toEqual(["/w/out.txt"]);
    expect(w("echo \"$(printf ')')\" > p.txt")).toEqual(["/w/p.txt"]);
    expect(w("x=`echo '>' y` && echo > t.txt")).toEqual(["/w/t.txt"]);
    const commit = [
      'git commit -q -F - <<\'EOF\' && echo done > marker.txt',
      "fix: it's the (last) one > really",
      "EOF",
    ].join("\n");
    expect(w(commit)).toEqual(["/w/marker.txt"]);
    const nested = [
      'git commit -m "$(cat <<\'EOF\'',
      "feat: don't stop (yet) > ever",
      "EOF",
      ')" && echo ok > after.txt',
    ].join("\n");
    expect(w(nested)).toEqual(["/w/after.txt"]);
  });
});

describe("shellWrittenFiles — heredocs", () => {
  it("takes the file a heredoc is written to, not redirects inside its body", () => {
    const cmd = ["cat > notes.md <<'EOF'", "line with > arrow and >> more", "EOF"].join("\n");
    expect(w(cmd)).toEqual(["/w/notes.md"]);
    expect(w(["cat <<EOF > swapped.md", "body > x", "EOF"].join("\n"))).toEqual(["/w/swapped.md"]);
  });

  it("ends a <<- body at a tab-indented delimiter and a << body only at an exact one", () => {
    expect(w(["cat <<-EOF > a.txt", "\tbody", "\tEOF", "echo > b.txt"].join("\n"))).toEqual(["/w/a.txt", "/w/b.txt"]);
    expect(w(["cat <<EOF > a.txt", "not EOF here", "  EOF", "EOF", "echo > b.txt"].join("\n"))).toEqual(["/w/a.txt", "/w/b.txt"]);
  });

  it("reads two heredocs in a row and the commands after them", () => {
    const cmd = [
      "cat > one.txt <<'A'", "1 > x", "A",
      "cat > two.txt <<'B'", "2 >> y", "B",
      "echo done >> log.txt",
    ].join("\n");
    expect(w(cmd)).toEqual(["/w/one.txt", "/w/two.txt", "/w/log.txt"]);
  });

  it("takes an unterminated heredoc body to the end without reading it as shell", () => {
    expect(w(["cat > open.txt <<'EOF'", "> not a redirect"].join("\n"))).toEqual(["/w/open.txt"]);
  });
});

describe("shellWrittenFiles — cd", () => {
  it("follows a leading cd, relative, absolute or home", () => {
    expect(w("cd sub && echo > x.txt")).toEqual(["/w/sub/x.txt"]);
    expect(w("cd /abs; echo > x.txt")).toEqual(["/abs/x.txt"]);
    expect(w("cd ~/proj && echo > x.txt")).toEqual(["/home/u/proj/x.txt"]);
    expect(w("cd && echo > x.txt")).toEqual(["/home/u/x.txt"]);
    expect(w("cd -P sub && echo > x.txt")).toEqual(["/w/sub/x.txt"]);
  });

  it("follows a cd in the middle of the command", () => {
    expect(w("echo > a.txt; cd sub; echo > b.txt")).toEqual(["/w/a.txt", "/w/sub/b.txt"]);
    expect(w("cd a && echo > 1.txt && cd ../b && echo > 2.txt")).toEqual(["/w/a/1.txt", "/w/b/2.txt"]);
    expect(w("cd sub || exit 1; echo > x.txt")).toEqual(["/w/sub/x.txt"]);
  });

  it("stops placing relative paths after a cd it cannot follow, but keeps absolute ones", () => {
    expect(w('cd "$DIR" && echo > rel.txt && echo > /abs.txt')).toEqual(["/abs.txt"]);
    expect(w("cd - && echo > rel.txt")).toEqual([]);
    expect(w("cd $(git rev-parse --show-toplevel) && echo > rel.txt")).toEqual([]);
  });

  it("undoes a cd made inside a subshell when it closes", () => {
    expect(w("(cd sub && echo > in.txt); echo > out.txt")).toEqual(["/w/sub/in.txt", "/w/out.txt"]);
    expect(w("( cd a && ( cd b && echo > ab.txt ) && echo > a.txt )")).toEqual(["/w/a/b/ab.txt", "/w/a/a.txt"]);
  });

  it("follows pushd and popd", () => {
    expect(w("pushd sub && echo > in.txt && popd && echo > out.txt")).toEqual(["/w/sub/in.txt", "/w/out.txt"]);
  });
});

describe("shellWrittenFiles — line continuation", () => {
  it("joins a line ending in a backslash instead of taking the backslash for a path", () => {
    expect(w("sed -i '' 's/a/b/' \\\n  file.ts")).toEqual(["/w/file.ts"]);
    expect(w("echo x \\\n  > out.txt")).toEqual(["/w/out.txt"]);
    expect(w("cat big.txt | \\\n  tee copy.txt")).toEqual(["/w/copy.txt"]);
  });
});

describe("shellWrittenFiles — tee", () => {
  it("takes every file argument, not options", () => {
    expect(w("echo x | tee out.txt")).toEqual(["/w/out.txt"]);
    expect(w("echo x | tee -a a.log b.log")).toEqual(["/w/a.log", "/w/b.log"]);
    expect(w("echo x | tee --append c.log")).toEqual(["/w/c.log"]);
    expect(w("echo x | tee")).toEqual([]);
    expect(w("echo x | sudo tee /etc/hosts > /dev/null")).toEqual(["/etc/hosts"]);
  });
});

describe("shellWrittenFiles — sed -i", () => {
  it("takes the files after the script, BSD and GNU forms", () => {
    expect(w("sed -i '' 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w('sed -i "" s/a/b/ b.ts')).toEqual(["/w/b.ts"]);
    expect(w("sed -i 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("sed -i.bak 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("sed -i .bak 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("sed -Ei 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("sed -E -i '' 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("sed --in-place 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("sed --in-place=.bak 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("sed -i -- 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
  });

  it("takes every file when the script comes from -e or -f", () => {
    expect(w("sed -i -e 's/a/b/' -e 's/c/d/' f1 f2")).toEqual(["/w/f1", "/w/f2"]);
    expect(w("sed -i '' -f fix.sed f.ts")).toEqual(["/w/f.ts"]);
    expect(w("sed -i --expression='s/a/b/' f.ts")).toEqual(["/w/f.ts"]);
  });

  it("takes nothing from a sed that is not in place, and drops a variable file", () => {
    expect(w("sed -n '1,5p' f.ts")).toEqual([]);
    expect(w("sed 's/a/b/' f.ts > out.ts")).toEqual(["/w/out.ts"]);
    expect(w("sed -i '' 's/a/b/' \"$f\" fixed.ts")).toEqual(["/w/fixed.ts"]);
  });
});

describe("shellWrittenFiles — perl -i", () => {
  it("takes the files of an in-place perl", () => {
    expect(w("perl -pi -e 's/a/b/' f1 f2")).toEqual(["/w/f1", "/w/f2"]);
    expect(w("perl -i -pe 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("perl -i.bak -pe 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("perl -0777 -pi -e 's/a/b/g' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("perl -lpi -e 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("perl -ne 'print if /x/' f.ts")).toEqual([]);
  });
});

describe("shellWrittenFiles — scripts", () => {
  const py = (body: string, head = "python3 - <<'EOF'") => w([head, body, "EOF"].join("\n"));

  it("takes a python heredoc's open() for writing, through a variable", () => {
    expect(py("p='x.md'\ns=open(p).read()\nopen(p,'w').write(s)")).toEqual(["/w/x.md"]);
    expect(py('with open("out.json", "w", encoding="utf-8") as f:\n    f.write("{}")')).toEqual(["/w/out.json"]);
    expect(py("open('a.log', 'a').write('x')")).toEqual(["/w/a.log"]);
    expect(py("open('b.bin', 'wb').write(b'')")).toEqual(["/w/b.bin"]);
    expect(py("open('c.txt', 'r+').write('x')")).toEqual(["/w/c.txt"]);
    expect(py("open('d.txt', 'x').write('x')")).toEqual(["/w/d.txt"]);
    expect(py("open('e.txt', encoding='utf-8', mode='w').write('x')")).toEqual(["/w/e.txt"]);
  });

  it("takes nothing from a python open() for reading", () => {
    expect(py("print(open('in.txt').read())")).toEqual([]);
    expect(py("print(open('in.txt', 'r').read())")).toEqual([]);
    expect(py("print(open('in.bin', 'rb').read())")).toEqual([]);
    expect(py("x = 'a'\nif x == 'w': pass\nprint(open(x).read())")).toEqual([]);
  });

  it("takes pathlib writes, directly or through a variable", () => {
    expect(py('from pathlib import Path\nPath("a.txt").write_text("x")')).toEqual(["/w/a.txt"]);
    expect(py("import pathlib\npathlib.Path('b.bin').write_bytes(b'')")).toEqual(["/w/b.bin"]);
    expect(py('p = Path("c.txt")\np.write_text("x")')).toEqual(["/w/c.txt"]);
  });

  it("takes a write through a function parameter or a loop over literals", () => {
    expect(py("def save(path, text):\n    open(path, 'w').write(text)\nsave('a.txt', 'x')\nsave(\"b.txt\", 'y')")).toEqual([
      "/w/a.txt", "/w/b.txt",
    ]);
    expect(py("for n in ['a.md', 'b.md']:\n    open(n, 'w').write('x')")).toEqual(["/w/a.md", "/w/b.md"]);
  });

  it("drops a script path the shell fills in before the script runs", () => {
    expect(w(`python3 -c "open('$SP/sfx/a.zip','wb').write(d)"`)).toEqual([]);
    expect(w(`node -e "fs.writeFileSync('\${D}/x.js', s)"`)).toEqual([]);
    expect(w(["python3 - <<EOF", "open('$D/x.txt', 'w')", "EOF"].join("\n"))).toEqual([]);
    expect(w(["python3 - <<EOF", "open('`pwd`/x.txt', 'w')", "EOF"].join("\n"))).toEqual([]);
    expect(w(`python3 -c "open('plain.txt','w')"`)).toEqual(["/w/plain.txt"]);
  });

  it("drops a python target it cannot resolve", () => {
    expect(py("import sys\nopen(sys.argv[1], 'w').write('x')")).toEqual([]);
    expect(py("name = input()\nopen(name, 'w').write('x')")).toEqual([]);
    expect(py("open(f'{d}/x.txt', 'w').write('x')")).toEqual([]);
    expect(py("open(base + '.bak', 'w').write('x')")).toEqual([]);
  });

  it("takes node writes from -e and from a heredoc", () => {
    expect(w(`node -e 'require("fs").writeFileSync("out.txt", "x")'`)).toEqual(["/w/out.txt"]);
    expect(w(`node -e 'const fs=require("fs"); const f="src/a.ts"; fs.writeFileSync(f, fs.readFileSync(f, "utf8"))'`)).toEqual(["/w/src/a.ts"]);
    expect(w(`node --eval "fs.appendFileSync('log.txt', 'x')"`)).toEqual(["/w/log.txt"]);
    expect(w(["node - <<'EOF'", "await writeFile(`w.txt`, d)", "fs.createWriteStream('s.log')", "EOF"].join("\n"))).toEqual([
      "/w/w.txt", "/w/s.log",
    ]);
    expect(w(`node -e 'fs.writeFileSync(\`\${dir}/x.txt\`, "x")'`)).toEqual([]);
    expect(w(`node -e 'for (const f of ["a.ts", "b.ts"]) fs.writeFileSync(f, "")'`)).toEqual(["/w/a.ts", "/w/b.ts"]);
  });

  it("takes python -c and tsx through npx", () => {
    expect(w(`python3 -c "open('o.txt','w').write('x')"`)).toEqual(["/w/o.txt"]);
    expect(w(`npx tsx -e 'writeFileSync("t.txt", "")'`)).toEqual(["/w/t.txt"]);
    expect(w(`env A=1 python3 -c "open('e.txt','w')"`)).toEqual(["/w/e.txt"]);
  });

  it("runs a script only when an interpreter runs it", () => {
    const written = ["cat > gen.py <<'EOF'", "open('x.txt', 'w').write('x')", "EOF"].join("\n");
    expect(w(written)).toEqual(["/w/gen.py"]);
    expect(w(written + "\npython3 gen.py")).toEqual(["/w/gen.py", "/w/x.txt"]);
    expect(w(["cat <<'EOF' | python3", "open('p.txt', 'w')", "EOF"].join("\n"))).toEqual(["/w/p.txt"]);
    expect(w(`python3 <<< "open('h.txt','w')"`)).toEqual(["/w/h.txt"]);
    expect(w(["cat <<'EOF'", "open('no.txt', 'w')", "EOF"].join("\n"))).toEqual([]);
    expect(w(["python3 -m json.tool <<'EOF'", "open('no.txt', 'w')", "EOF"].join("\n"))).toEqual([]);
  });

  it("places a script's relative paths in the directory it runs in", () => {
    expect(w(["cd sub && python3 - <<'EOF'", "open('x.txt', 'w')", "EOF"].join("\n"))).toEqual(["/w/sub/x.txt"]);
  });
});

describe("shellWrittenFiles — prefixes and robustness", () => {
  it("looks past assignments, env, sudo, command and time", () => {
    expect(w("FOO=1 sed -i 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("time sed -i 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("command tee t.txt < in")).toEqual(["/w/t.txt"]);
    expect(w("exec 3> fd.log")).toEqual(["/w/fd.log"]);
  });

  it("returns nothing for empty, blank or read-only commands", () => {
    expect(w("")).toEqual([]);
    expect(w("   \n  ")).toEqual([]);
    expect(w("git status && ls -la && grep -rn foo src")).toEqual([]);
  });

  it("does not throw on unbalanced quotes, parens or ANSI-C strings", () => {
    expect(() => w('echo "abc > x')).not.toThrow();
    expect(w('echo "abc > x')).toEqual([]);
    expect(() => w("echo $(unclosed > x")).not.toThrow();
    expect(() => w("echo ) > x")).not.toThrow();
    expect(w("echo $'a\\'b' > ansi.txt")).toEqual(["/w/ansi.txt"]);
    expect(() => w("cat <<")).not.toThrow();
    expect(() => w("sed -i")).not.toThrow();
    expect(() => w("perl -pi")).not.toThrow();
  });

  it("reads a 200 KB command quickly", () => {
    const big = "echo x > out.txt\n" + "python3 - <<'EOF'\n" + "s = '(' * 50 + \"'\" * 3\n".repeat(8000) + "EOF\n";
    const t0 = performance.now();
    expect(w(big)).toEqual(["/w/out.txt"]);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("shellWrittenFiles — QA findings", () => {
  it("does not overflow the stack on deeply nested $( ) inside quotes", () => {
    const nest = (n: number) => "echo " + '"$('.repeat(n) + "x" + ')"'.repeat(n);
    expect(() => w(nest(3000))).not.toThrow();
    expect(() => w(nest(20000))).not.toThrow();
  });

  it("reads no write out of strings or comments in a script", () => {
    const ts = ["cat > t.ts <<'EOF'", `const c = "python3 -c \\"open('j.json','w')\\"";`, "console.log(c)", "EOF", "npx tsx t.ts"].join("\n");
    expect(w(ts)).toEqual(["/w/t.ts"]);
    const py = ["python3 - <<'EOF'", `code = "open('x.txt','w')"`, "# open('y.txt','w')", `"""open('z.txt','w')"""`, "print(code)", "EOF"].join("\n");
    expect(w(py)).toEqual([]);
    const js = [
      "node - <<'EOF'",
      '// fs.writeFileSync("c.txt", s)',
      '/* writeFileSync("d.txt", s) */',
      `const s = t.replace(/'/g, "");`,
      'fs.writeFileSync("real.txt", s)',
      "EOF",
    ].join("\n");
    expect(w(js)).toEqual(["/w/real.txt"]);
    expect(w(["python3 - <<'EOF'", `s = "it's"`, "open('ok.txt', 'w')", "EOF"].join("\n"))).toEqual(["/w/ok.txt"]);
    expect(w(["python3 - <<'EOF'", `x = "p = 'fake.txt'"`, "open(p, 'w')", "EOF"].join("\n"))).toEqual([]);
  });

  it("does not take a case pattern's ) for the end of a subshell", () => {
    expect(w("(cd sub; case $x in a) echo > a.txt;; esac; echo > in.txt)")).toEqual(["/w/sub/a.txt", "/w/sub/in.txt"]);
    expect(w("case $x in (a|b) echo > ab.txt;; esac; echo > after.txt")).toEqual(["/w/ab.txt", "/w/after.txt"]);
    expect(w("case $x in a|b) echo > p.txt;; esac")).toEqual(["/w/p.txt"]);
    expect(w("case $x in\n  a) echo > nl.txt\n  ;;\nesac")).toEqual(["/w/nl.txt"]);
    // "case" as an argument starts no case statement.
    expect(w("echo case in; (cd sub; echo > s.txt); echo > t.txt")).toEqual(["/w/sub/s.txt", "/w/t.txt"]);
  });

  it("reads [[ ]] after if, while, ! and elif", () => {
    expect(w("if [[ a > b ]]; then echo > t.txt; fi")).toEqual(["/w/t.txt"]);
    expect(w("! [[ a < b ]] && echo > u.txt")).toEqual(["/w/u.txt"]);
    expect(w("while [[ $i > 0 ]]; do echo > w.txt; done")).toEqual(["/w/w.txt"]);
    expect(w("if false; then :; elif [[ a > b ]]; then echo > e.txt; fi")).toEqual(["/w/e.txt"]);
  });

  it("does not follow a cd in a pipeline or in the background, nor into the || branch", () => {
    expect(w("cd sub | true; echo > x.txt")).toEqual(["/w/x.txt"]);
    expect(w("ls | cd sub; echo > z.txt")).toEqual(["/w/z.txt"]);
    expect(w("cd sub & echo > y.txt")).toEqual(["/w/y.txt"]);
    expect(w("cd nope || echo > f.txt")).toEqual(["/w/f.txt"]);
    expect(w("cd sub || echo > f.txt; echo > g.txt")).toEqual(["/w/f.txt", "/w/sub/g.txt"]);
  });

  it("looks past the options of time, sudo and env, and takes tee files after --", () => {
    expect(w("time -p sed -i 's/a/b/' f.ts")).toEqual(["/w/f.ts"]);
    expect(w("sudo -u root tee /etc/x")).toEqual(["/etc/x"]);
    expect(w("sudo -E tee /etc/y")).toEqual(["/etc/y"]);
    expect(w("env -u FOO sed -i 's/a/b/' g.ts")).toEqual(["/w/g.ts"]);
    expect(w("echo x | tee -- -f")).toEqual(["/w/-f"]);
  });

  it("reads ((cd a) …) as nested subshells, not arithmetic", () => {
    expect(w("((cd a) && echo > n.txt)")).toEqual(["/w/n.txt"]);
    expect(w("((cd a && echo > in.txt) && echo > out.txt)")).toEqual(["/w/a/in.txt", "/w/out.txt"]);
  });

  it("stays fast on pathological input", () => {
    const time = (cmd: string) => {
      const t0 = performance.now();
      w(cmd);
      return performance.now() - t0;
    };
    expect(time("node -e '" + "writeFileSync(x);".repeat(30000) + "'")).toBeLessThan(500);
    expect(time("cd a; ".repeat(50000))).toBeLessThan(500);
    expect(time("python3 - <<'EOF'\n" + "a.".repeat(50000) + "\nEOF")).toBeLessThan(500);
  });
});

describe("shellWrittenFiles — QA round 2 findings", () => {
  it("keeps && || ( ) inside [[ ]] as part of the test", () => {
    expect(w("[[ -f x && a > b ]] && echo ok")).toEqual([]);
    expect(w("[[ ( a > b ) || c < d ]] && echo > t.txt")).toEqual(["/w/t.txt"]);
  });

  it("ends a cd's || branch at the next && and across a subshell", () => {
    expect(w("cd sub || (echo fail > f.txt); echo > g.txt")).toEqual(["/w/f.txt", "/w/sub/g.txt"]);
    expect(w("cd a || true && echo > x.txt")).toEqual(["/w/a/x.txt"]);
    expect(w("cd a || echo no || echo > n.txt; echo > y.txt")).toEqual(["/w/n.txt", "/w/a/y.txt"]);
  });

  it("does not follow a cd in a { } group that runs in a pipeline", () => {
    expect(w("{ cd sub; } | cat; echo > x.txt")).toEqual(["/w/x.txt"]);
    expect(w("{ cd sub; echo > in.txt; }; echo > out.txt")).toEqual(["/w/sub/in.txt", "/w/sub/out.txt"]);
  });

  it("takes a function's calls only when the write is inside that function", () => {
    const py = (lines: string[]) => w(["python3 - <<'EOF'", ...lines, "EOF"].join("\n"));
    expect(py([
      "def load(path):",
      "    return open(path).read()",
      "def save(path, d):",
      "    open(path, 'w').write(d)",
      "x = load('in.json')",
      "save('out.json', x)",
    ])).toEqual(["/w/out.json"]);
    expect(w(`node -e 'function read(p) { return fs.readFileSync(p) } function put(p, s) { fs.writeFileSync(p, s) } read("in.txt"); put("out.txt", "")'`)).toEqual(["/w/out.txt"]);
  });

  it("still takes a function that only collects edits applied later", () => {
    const py = [
      "python3 - <<'EOF'",
      "EDITS = []",
      "def edit(path, old, new):",
      "    EDITS.append((path, old, new))",
      "edit('README.md', 'a', 'b')",
      "edit(\"src/x.ts\", 'c', 'd')",
      "files = {}",
      "for path, old, new in EDITS:",
      "    files[path] = open(path).read().replace(old, new)",
      "for path, text in files.items():",
      "    open(path, 'w').write(text)",
      "EOF",
    ].join("\n");
    expect(w(py)).toEqual(["/w/README.md", "/w/src/x.ts"]);
  });

  it("takes a loop's list only when the write is inside the loop", () => {
    const py = (lines: string[]) => w(["python3 - <<'EOF'", ...lines, "EOF"].join("\n"));
    expect(py([
      "for n in ['a.md', 'b.md']:",
      "    print(open(n).read())",
      "for n in ['c.md']:",
      "    open(n, 'w').write('x')",
    ])).toEqual(["/w/c.md"]);
    expect(py(["for n in ['one.md']: open(n, 'w').write('x')"])).toEqual(["/w/one.md"]);
  });

  it("does not take a variable that is only the start of an expression", () => {
    expect(w(`node -e 'const path = "p.txt"; fs.writeFileSync(path.join(dir, "b"), s)'`)).toEqual([]);
    expect(w(`node -e 'const out = "o.txt"; fs.writeFileSync(out, s)'`)).toEqual(["/w/o.txt"]);
  });

  it("reads a here-string inside $( ) as a here-string, not a heredoc", () => {
    expect(w("x=$(\n tr a b <<< foo\n)\necho > after.txt")).toEqual(["/w/after.txt"]);
  });

  it("follows writes after $( ) nested thirty deep", () => {
    const nest = (n: number) => "echo " + '"$('.repeat(n) + "x" + ')"'.repeat(n) + "; echo > after.txt";
    expect(w(nest(30))).toEqual(["/w/after.txt"]);
  });

  it("stays fast on more pathological input", () => {
    const time = (cmd: string) => {
      const t0 = performance.now();
      w(cmd);
      return performance.now() - t0;
    };
    expect(time(`python3 -c "${"open(a, ".repeat(40000)}"`)).toBeLessThan(500);
    expect(time("python3 - <<'EOF'\n" + "for p in [".repeat(30000) + "\nEOF")).toBeLessThan(500);
    expect(time("python3 - <<'EOF'\n" + "for p in [\n".repeat(30000) + "open(p, 'w')\nEOF")).toBeLessThan(500);
    expect(time("! ".repeat(50000) + "echo")).toBeLessThan(500);
  });
});
