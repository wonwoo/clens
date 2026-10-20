# clens

[한국어](README.ko.md)

A memory of your past Claude Code and Codex sessions, for your coding agent.

Your agent forgets a session once it ends. With clens it looks up what you decided, tried and changed before, in every project and in both tools, instead of guessing or asking you again. Everything stays on your machine.

```txt
Why did we drop the retry logic?
```

```txt
Where did I leave off on this project? Who last changed src/app.ts?
```

```txt
Which files did I change and what did I commit before the compaction?
```

Status: pre-alpha, not published to npm yet.

## What it does

- **Finds past discussions and decisions** across every project's conversations. Search understands Korean, Japanese and Chinese word forms, not just exact strings.
- **Tells you where you left off** in a project or on one file: the latest sessions with their last request, last reply and the files they edited.
- **Recovers after compaction.** Right after `/compact`, the agent gets back what the summary tends to drop: your requests, edited files, the git commands that changed state, failed tool calls and hook blocks.
- **Shows how you work:** which tools, skills and subagents you use, which files you change most, what hooks blocked, what fills the context, for one session, one project or all of them.
- **Keeps what Claude Code deletes.** Sessions stay searchable after Claude Code removes their transcripts.
- **Stays on your machine.** It never calls an LLM. It goes online only to install its npm dependencies on first run and to download the Korean search model.

## Install

Requires Node.js 20 or later.

### Claude Code

```sh
claude plugin marketplace add wonwoo/clens
claude plugin install clens@clens
```

In a running session, use `/plugin marketplace add wonwoo/clens` and `/plugin install clens@clens`, then `/reload-plugins`.

### Codex

```sh
codex plugin marketplace add wonwoo/clens
codex plugin add clens@clens
```

Then open Codex, type `/hooks` and trust clens's hook. Until then the compaction recovery does nothing.

The first session indexes your history in the background. A long history takes a few minutes; until then, answers cover what is indexed so far.

### Korean, Japanese and Chinese search

For word-level search in Korean, Japanese or Chinese, install that language's analyzer once: `ko`, `ja` or `zh`. In Claude Code, ask the agent to run `clens install ko`. In Codex, run this yourself. Then close every open Claude Code and Codex session and start again: a session that was already running keeps indexing without the new analyzer. Without it, those messages are still found by their characters. English needs nothing.

```sh
node ~/.codex/plugins/cache/clens/clens/<version>/plugin/start.mjs install ko
```

### Update

```sh
claude plugin marketplace update clens && claude plugin update clens@clens
codex plugin marketplace upgrade clens && codex plugin add clens@clens
```

If you set clens up by hand before (`claude mcp add`, `codex mcp add`, a compaction hook in your settings, linked skills), remove those entries, or clens runs twice.

## Skills

- `/clens:recap` recaps your recent work in this project: what each session did, where it stopped and what is left, with commits tied to the sessions that made them.
- `/clens:continue` picks up the work of your latest other session in this project, such as one you just left in the other tool.
- `/clens:reflect` turns what you had to correct in this session into proposed edits to CLAUDE.md or AGENTS.md and to skills, each with how often the same thing came up in your earlier sessions. Give it a period (`/clens:reflect 2w`, `/clens:reflect 10주`, up to 10 weeks) to review this project's sessions over that time instead. Nothing is written until you approve it. Each run's results and your decisions are kept in `~/.clens/reflect/`, and the next run takes them into account: what you declined is not proposed again unless the problem came back. A run on one session takes about 10 to 20 minutes; a period takes longer.
- `clens:stats` guides the agent through usage questions ("which skills do I use most", "what is filling my context").

In Codex, call a skill as `$clens:recap`.

## Limits

- Search matches words, not meaning. A question worded differently from the conversation can miss it; the agent then retries with other words.
- Tool output (command results, file contents) is not stored, only the messages and the tool calls. A failed call keeps the first 100 and last 200 characters of its output, which a session's record shows; they are not searched.
- An assistant reply over 4 KB is stored as its start and end, about 2 KB each, so words in its middle are not found.
- Files a script changes, or whose path is set only when a command runs (`$VAR`, a glob), can be missing from a session's edited files. The same goes for git commands run from inside a script.
- In Codex, the compaction recovery runs only after you trust the hook, and not after a subagent's compaction.

## Development

```sh
git clone https://github.com/wonwoo/clens && cd clens
npm install                    # also builds dist/
node dist/cli.js index         # first full index into ~/.clens/index.db
claude --plugin-dir .          # run the plugin from the clone, this session only
npm test && npm run typecheck
```

To register the MCP server by hand, point it at `dist/mcp/server.js` itself, not `clens mcp`; otherwise `session_id: "current"` stays on the session the server started in after `/clear` or `/resume`.

```sh
claude mcp add -s user clens -- node /absolute/path/to/clens/dist/mcp/server.js
codex mcp add clens -- node /absolute/path/to/clens/dist/mcp/server.js
```

The compaction hook is `hooks/compact.mjs`; `hooks/hooks.json` (Claude Code) and `.codex-plugin/hooks.json` (Codex) show how to register it.

The CLI:

```
clens index [--rebuild]     build or update the index
clens install ko|ja|zh      install the Korean, Japanese or Chinese analyzer
clens stats [--digest]      print the index's row counts, or a SHA-256 digest of each table
clens mcp                   run the MCP server
```

`CLENS_HOME`, `CLENS_CODEX_HOME` and `CLENS_INDEX_DIR` move `~/.claude`, `~/.codex` and `~/.clens`. Tests point all three at temporary folders, so they never touch your real ones. [CLAUDE.md](CLAUDE.md) holds the rules and invariants to keep when you change the code.

A release ships `dist/` in the repository, because neither Claude Code nor Codex builds a plugin: run `npm run build`, commit `dist/`, and raise `version` in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`. `claude plugin validate .` checks the Claude Code side.

## License

MIT
