// Project ids are Claude Code's directory names for a project (Claude Code
// 2.1.322, `JD`), so the Claude Code and Codex sessions of one directory, the
// ledger items recorded there and the hooks that run there share one id.
// The hooks bundle this file, so it imports nothing.

/** Claude Code's cut: a longer name keeps this many characters and a hash. */
const MAX_NAME = 200;

/** The project id of a directory: every character other than an ASCII letter
 *  or digit becomes a dash, and a name over 200 characters keeps its first
 *  200 and gets a dash and a hash of the path. The regex has no `u` flag, so
 *  each UTF-16 code unit becomes one dash, as in Claude Code. */
export function projectIdOf(path: string): string {
  const name = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_NAME) return name;
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
  return `${name.slice(0, MAX_NAME)}-${Math.abs(h).toString(36)}`;
}

/** A project_id an agent derived by replacing only the slashes, or recorded
 *  in the ledger before ids followed Claude Code, as the id `projectIdOf`
 *  gives for paths of up to 200 sanitized characters; an id already in that
 *  form is unchanged. */
export function normalizeProjectId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "-");
}
