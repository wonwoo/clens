import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executedCommands } from "../src/mcp/shell_text.js";

// The reader is checked against bash itself: each command runs in bash with
// stand-ins for the programs below, which log the arguments they got, and
// the programs executedCommands finds in the command's text must be the
// ones bash ran. Commands are compared as sets: a loop runs one many times.
const LOGGED = ["npm", "npx", "curl", "wget", "gradlew", "pytest", "go", "git"];

let dir: string;
let log: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "clens-shell-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "app"));
  log = join(dir, "log");
  // One write per line: commands bash runs at once (diff <(a) <(b)) would
  // otherwise mix their lines in the log.
  const logger = '#!/bin/sh\ns=$(printf "\\037"); line=${0##*/}\nfor a in "$@"; do line="$line$s$a"; done\nprintf "%s\\n" "$line" >> "$LOG"\n';
  for (const name of LOGGED) writeFileSync(join(bin, name), logger);
  writeFileSync(join(dir, "gradlew"), logger);
  // timeout may be missing (macOS) or real; either way it runs the rest.
  writeFileSync(join(bin, "timeout"), '#!/bin/sh\nwhile case "$1" in -*) true;; *) false;; esac; do shift; done\nshift\nexec "$@"\n');
  for (const name of [...LOGGED, "timeout"]) chmodSync(join(bin, name), 0o755);
  chmodSync(join(dir, "gradlew"), 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function ranInBash(command: string): string[] {
  writeFileSync(log, "");
  spawnSync("bash", ["-c", command], {
    cwd: dir,
    env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, LOG: log, HOME: dir },
    stdio: "ignore",
    timeout: 10_000,
  });
  return [...new Set(readFileSync(log, "utf8").split("\n").filter((l) => l !== ""))].sort();
}

function readByUs(command: string): string[] {
  const base = (w: string) => w.slice(w.lastIndexOf("/") + 1);
  return [...new Set(executedCommands(command)
    .filter(({ argv }) => LOGGED.includes(base(argv[0]!)))
    .map(({ argv }) => [base(argv[0]!), ...argv.slice(1)].join("\x1f")))].sort();
}

const COMMANDS = [
  './gradlew :core:test --tests "a.B"',
  "timeout 580 ./gradlew --offline -q :core:test",
  "npm test 2>&1 | tail -1",
  "npx vitest run x",
  "cd app && pytest -q",
  "(cd app && npm test)",
  "L=/dev/null; ./gradlew :core:test > $L 2>&1",
  "go test ./...",
  "./gradlew spotlessCheck",
  'grep -n "a\\|vitest" /dev/null',
  'echo "npm test"',
  "echo '$(pytest -q)'",
  "cat <<'EOF' >/dev/null\nimport os; npx vitest\nEOF",
  "./gradlew tasks # test",
  "bash -c 'npm test'",
  'bash -c "cd app && pytest -q"',
  "bash -c 'npm test -- --testNamePattern='\\''login'\\'''",
  'bash -c "npm \\\ntest"',
  "curl -s \\\nhttp://localhost:8080/h",
  "./gradlew \\\n:core:test",
  "echo 'a\\\nb'; npm test",
  "# explanation \\\nnpm test",
  "cat <<'EOF'\ntext\\\nEOF\nnpm test",
  "npm te\\\nst",
  'curl "http://local\\\nhost:8080/"',
  "echo x \\ \nnpm test",
  "sh \\\n-c 'npm test'",
  "git push origin dev-deploy",
  "git checkout sandbox-deploy && git merge --ff-only feature/x",
  "curl --version # https://api.prod.example.com/health",
  'echo "$(npm test)"',
  "echo `npm test`",
  "FOO=1 npm test",
  "env CI=1 npm test",
  "nice -n 5 npm test",
  "npm test & wait",
  "if true; then npm test; fi",
  "for i in 1 2; do npm test; done",
  "x=$(curl -s http://localhost:8080/h)",
  "cat <<EOF >/dev/null\n$HOME\nEOF\nnpm test",
  "{ npm test; }",
  "npm test && git push origin HEAD:refs/heads/feature/x",
  'echo "a # not a comment"; npm test',
  "npm run test:unit",
  "cat <<-EOF >/dev/null\n\tbody\n\tEOF\nnpm test",
  "bash -c 'cd app; npm test' && curl -s \"http://localhost:8080/a?b=1\"",
  "echo $( (cd app && npm test) )",
  "npm test >/dev/null 2>&1 && wget -q -O- http://localhost:8080/",
  "x='it''s'; npm test",
  "cat <(curl -s http://localhost:8080/h) >/dev/null",
  "diff <(npm test) <(go test ./...) >/dev/null",
  "cat <<\\EOF\nbody\\\nEOF\nnpm test",
  "cat <<EOF >/dev/null\nbody\\\\\nEOF\nnpm test",
  "bash -o pipefail -c 'npm test'",
  "bash -O extglob -c 'npm test'",
  "npm $'te\\x73t'",
  "bash -c $'npm test\\ncurl -s http://localhost:8080/h'",
  "echo $'a\\'b'; npm test",
  "printf '%s\\n' $'\\UFFFFFFFF'; npm test",
];

describe("executedCommands against bash", () => {
  it.each(COMMANDS)("%j runs what bash runs", (command) => {
    expect(readByUs(command)).toEqual(ranInBash(command));
  });

  // Not compared with bash: what bash 3.2 (macOS) and 4+ do differs, or an
  // argument's value comes from running a command substitution, which the
  // reader does not run.
  it("reads |& as a pipe, as bash 4 and later do", () => {
    expect(executedCommands("npm test |& tail -1").map((c) => c.argv)).toEqual([["npm", "test"], ["tail", "-1"]]);
  });

  it("reads a heredoc inside $( ) to its end and goes on after it", () => {
    const commands = executedCommands('git commit -m "$(cat <<\'EOF\'\nsubject\n\nbody\nEOF\n)" && git push');
    expect(commands.map((c) => c.argv.slice(0, 2).join(" "))).toEqual(["cat", "git commit", "git push"]);
    expect(commands.at(-1)!.text).toBe("git push");
  });

  // The reader reads text and runs nothing, so it cannot tell which branch
  // of a conditional ran: it lists every command a call holds.
  it("lists the commands of both branches of a conditional", () => {
    expect(executedCommands("if false; then npm test; else go test ./...; fi").map((c) => c.argv[0])).toEqual(["false", "npm", "go"]);
  });

  it("reads deeply nested $( ) without running out of stack", () => {
    const deep = "$(".repeat(3000) + "npm test" + ")".repeat(3000);
    expect(() => executedCommands(deep)).not.toThrow();
  });

  it("finds the programs bash ran in each command, not an empty list", () => {
    // Guards the comparison itself: the stand-ins must have logged something.
    expect(ranInBash("npm test")).toEqual(["npm\x1ftest"]);
  });
});
