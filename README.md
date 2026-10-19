# clens

[한국어](README.ko.md)

clens gives your coding agent a memory of your past sessions. It indexes your Claude Code and Codex transcripts into a local SQLite database and hands the agent a few MCP tools to look things up there. The agent no longer has to guess what was decided, tried or changed before, or grep transcript files for it.

Status: pre-alpha, not published to npm yet.

## What it does for you

- **Finds past discussions and decisions.** Ask "why did we drop the retry logic?" and the agent searches every project's conversations, then reads the exchange around the hit. Search understands Korean, Japanese and Chinese word forms, not just exact strings.
- **Tells you where you left off.** For a project, or for one file, it lists the latest sessions with the last request, the last reply and the files each one edited. Files changed through shell commands (`>`, `tee`, `sed -i`, heredoc and `-c`/`-e` scripts) count as edits too.
- **Recovers after compaction.** With `session_id: "current"`, the agent gets this conversation's own work record: its requests, its last reply, edited files, the git commands that changed state, failed tool calls and hook blocks. Those are the facts a compaction summary tends to drop. With the compaction hook (below), the record arrives right after the compaction without being asked for.
- **Shows how you work.** It counts which tools, skills, slash commands and subagents you use, and which files you change most. It also shows which hooks blocked what, which tools' output fills the context, how often the context was compacted and how far it grew, error rates and time spent, for one session, one project or all of them.
- **Keeps what Claude Code deletes.** Claude Code removes old transcripts. Sessions already in the index stay searchable after their files are gone.
- **Stays on your machine.** It reads the transcript folders and writes only to `~/.clens/`, plus its own plugin folder for its npm dependencies. It never calls an LLM. It goes online only to install the plugin's npm dependencies on its first run and for `clens install ko`, which downloads the Korean morpheme model.

## How it works

```
~/.claude/projects/**/*.jsonl ─┐
                               ├─ indexer ─▶ ~/.clens/index.db (SQLite) ─▶ MCP server ─▶ agent
~/.codex/sessions/**/*.jsonl ──┘
```

`clens index` builds the index once. After that the MCP server keeps it current: while it runs, it watches the session folders and re-indexes each changed file.

The server gives the agent five tools:

| Tool | Use it for |
|---|---|
| `clens_search` | Keyword search over past messages, ranked by relevance. Takes up to five queries in one call. |
| `clens_session` | The conversation around one search hit. |
| `clens_recent` | Messages in a time window, newest first, with an optional keyword filter. |
| `clens_left_off` | Where work stopped: a project's or a file's latest sessions, or one session's work record (`"current"` after compaction). |
| `clens_stats` | Usage counts and trends for a session, a project or everything. |

The server also sends the agent short instructions on when to reach for these tools, so it uses them without being told to.

## Install

Requires Node.js 20 or later, with npm.

### As a plugin

clens is one plugin for both Claude Code and Codex. It brings the MCP server, the compaction hook and four skills.

Claude Code:

```sh
claude plugin marketplace add wonwoo/clens
claude plugin install clens@clens
```

In a running session, `/plugin marketplace add wonwoo/clens` and `/plugin install clens@clens` do the same; then run `/reload-plugins`.

Codex:

```sh
codex plugin marketplace add wonwoo/clens
codex plugin add clens@clens
```

Then open Codex, type `/hooks` and trust clens's hook. Codex runs a plugin's hooks only after you trust them, so until then the compaction hook does nothing.

On its first start, the MCP server installs its npm dependencies into the plugin folder, once per plugin version. Once a session writes to its transcript, it indexes all your transcripts in the background. A long history takes a few minutes; until then, answers cover what is indexed so far.

For Korean morpheme search, download the Korean model once and start a new session:

- Claude Code: ask the agent to run `clens install ko`. The plugin puts `clens` on the path of its shell.
- Codex: run `node ~/.codex/plugins/cache/clens/clens/<version>/plugin/start.mjs install ko`.

Japanese and Chinese search work without an install step.

The plugin's skills:

- `/clens:recap` writes a recap of your recent work in the current project: what each session did, where it stopped and what is left, with commits tied to the sessions that made them.
- `/clens:continue` picks up the work of your latest other session in this project, such as one you just left in the other tool.
- `/clens:reflect` turns what you had to correct in this session into proposed edits to CLAUDE.md or AGENTS.md and to skills, each with how often the same thing came up in your earlier sessions. Nothing is written until you approve it. A run takes about 10 to 20 minutes.
- `clens:stats` guides the agent through usage questions ("which skills do I use most", "what is filling my context").

In Codex, call a skill as `$clens:recap`.

To update:

```sh
claude plugin marketplace update clens && claude plugin update clens@clens
codex plugin marketplace upgrade clens && codex plugin add clens@clens
```

If you set clens up by hand before (`claude mcp add`, `codex mcp add`, a compaction hook in your settings, linked skills), remove those entries, or clens runs twice.

### From source

For development, run the plugin from a clone:

```sh
git clone https://github.com/wonwoo/clens && cd clens
npm install                    # also builds dist/
node dist/cli.js index         # first full index into ~/.clens/index.db
claude --plugin-dir .          # Claude Code, this session only
```

Or register the pieces yourself. Register `dist/mcp/server.js` itself, not `clens mcp`: the server finds the Claude Code conversation that called it through its parent process, which lets `session_id: "current"` and search's "leave out the current turn" follow `/clear` and `/resume`. Through `clens mcp`, the server's parent is that command, so both stay on the session the server started in. Codex names its session in every tool call, so `"current"` works there too.

```sh
claude mcp add -s user clens -- node /absolute/path/to/clens/dist/mcp/server.js
codex mcp add clens -- node /absolute/path/to/clens/dist/mcp/server.js
```

The compaction hook is `hooks/compact.mjs`, a `SessionStart` entry with the matcher `compact`: `hooks/hooks.json` has the Claude Code form and `.codex-plugin/hooks.json` the Codex one, which sets `additionalContextLimit` so Codex passes the whole record (the hook cuts it at 9,000 characters). Without it, Codex keeps output above about 2,500 tokens in a file and shows the model only its start and end.

## Things to ask

| You ask | The agent uses |
|---|---|
| "Why did we drop the retry logic?" | `clens_search`, then `clens_session` |
| "Where did I leave off?" / "Who last changed `src/app.ts`?" | `clens_left_off` |
| After `/compact`: "Which files did I change and what did I commit before the compaction?" | `clens_left_off` with `session_id: "current"` |
| "What did I do yesterday?" | `clens_left_off` or `clens_recent` with `since`/`until` |
| "Which skills have I used most this month?" | `clens_stats` |

## Command line

```
clens index [--rebuild]     build or update the index
clens install ko            download the Korean morpheme model
clens stats [--digest]      print the index's row counts, or a SHA-256 digest of each table
clens mcp                   run the MCP server
```

Paths can be moved with environment variables: `CLENS_HOME` (instead of `~/.claude`), `CLENS_CODEX_HOME` (instead of `~/.codex`) and `CLENS_INDEX_DIR` (instead of `~/.clens`).

## Limits

- Search is keyword search (whole words, substrings and ko/ja/zh morphemes), not semantic. A question worded differently from the conversation can miss it, and the agent is told to retry with other words.
- Tool outputs (command results, file contents) are not stored, only the messages and the tool calls.
- Shell edits are read from the command text. A path set only when the command ran (`$VAR`, `$(…)`, a glob), a script file written in an earlier call and then run by name, and `cp`, `mv` or `touch` are missed. In Codex `exec` code, a command whose `cmd` is built when the code runs is read from the record Codex keeps of the commands it ran, only while that `exec` call is the only one running.
- The git commands in a session record are read from the command text too. Git text inside a quoted string is not listed (a script given to `node -e` can hold git commands as data), so a git command a script runs, such as `os.system("git commit …")`, is missed; the string after `sh -c`, `bash -c` or `zsh -lc` counts as commands. A Codex `exec` command built at run time is not listed, and a shell input over 64 KB is stored cut, so git commands past the cut are missed.
- In Codex, no work record is put back after a subagent's compaction (Codex runs no hook there), and the compaction hook runs only after you trust it with `/hooks`.

## Development

```sh
npm test            # vitest
npm run typecheck
```

Tests never touch `~/.claude` or `~/.clens`: they point `CLENS_HOME`, `CLENS_CODEX_HOME` and `CLENS_INDEX_DIR` at temporary folders. [CLAUDE.md](CLAUDE.md) describes the architecture and the invariants the indexer keeps.

A release ships `dist/` in the repository, because neither Claude Code nor Codex builds a plugin: run `npm run build`, commit `dist/`, and raise `version` in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`. Codex copies a plugin again only when that version changes. `claude plugin validate .` checks the Claude Code side.

## License

MIT
