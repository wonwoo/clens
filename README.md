# clens

[한국어](README.ko.md)

Your coding agent forgets a session once it ends. So it asks again about what you settled last week, and brings back the approach you already dropped. clens indexes every conversation you had in Claude Code and Codex, and lets the agent look things up itself when it needs them.

It finds what you said in other projects too, and follows work you started in Claude Code and carried on in Codex. Korean is searched by word, so a different particle or verb ending still matches. It never calls an LLM, and nothing leaves your machine.

Ask it things like:

```txt
Why did we drop the retry logic?
```

```txt
Where did I leave off on this project? Who last changed src/app.ts?
```

```txt
What did I do yesterday?
```

```txt
Which files did I change and what did I commit before the compaction?
```

Status: pre-alpha.

## What it does

- Finds past discussions and decisions across every project. When you say "last time" or "we tried this before", the agent is told to look before it answers, without you asking.
- Shows where you left off in a project or on one file: the latest sessions with their last request, last reply and the files they edited.
- Lists the conversation in a time window, in order.
- Recovers after `/compact`. Right after a compaction the agent gets back what the summary tends to drop: your requests, edited files, the git commands that changed state, failed tool calls and hook blocks.
- Stops the same dead end twice. When a command the agent runs fails in a way a retry does not fix (a missing command, a refused operation, a host that does not resolve), the agent is told what it said next when another session hit the same failure.
- Keeps what Claude Code deletes. By default Claude Code deletes transcripts older than 30 days; a session clens has indexed stays searchable after its file is gone.
- Shows how you work: which tools and skills you use most, which files you change most, what hooks blocked, what fills the context.
- Recaps your recent work in this project, session by session (`/clens:recap`).
- Picks up in Claude Code the work you left in Codex, or the other way round (`/clens:continue`).
- Tells why a line of code is the way it is: finds the session that wrote it, with the request and the proposal you agreed to (`/clens:why`).
- Checks how often you had to make the same correction in earlier sessions, and turns it into lines for CLAUDE.md, AGENTS.md or a skill (`/clens:reflect`).
- Keeps track of what you set aside. When you put something off or drop it in a conversation, the agent records it, to list later with your words (`/clens:pending`).

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

Then open Codex, type `/hooks` and trust clens's hooks. Until then the compaction recovery, the failed-command hints and the recording of what you set aside do nothing.

The first session indexes your history in the background. A long history takes a few minutes; until then, answers cover what is indexed so far.

### Korean, Japanese and Chinese search

For word-level search in Korean, Japanese or Chinese, install that language's analyzer once: `ko`, `ja` or `zh`. In Claude Code, ask the agent to run `clens install ko`. In Codex, install the CLI from npm and run it yourself:

```sh
npm i -g @clens/cli
clens install ko
```

Then close every open Claude Code and Codex session and start again: a session that was already running keeps indexing without the new analyzer. Without it, those messages are still found by their characters. English needs nothing.

### Update

```sh
claude plugin marketplace update clens && claude plugin update clens@clens
codex plugin marketplace upgrade clens && codex plugin add clens@clens
```

If you set clens up by hand before (`claude mcp add`, `codex mcp add`, a compaction hook in your settings, linked skills), remove those entries, or clens runs twice.

## Skills

`/clens:recap` recaps your recent work in this project: what each session did, where it stopped and what is left, with commits tied to the sessions that made them.

`/clens:continue` picks up the work of your latest other session in this project without you retelling it. Use it when you switch tools, say from Codex to Claude Code.

`/clens:why` explains why a piece of code is the way it is. It finds the session whose edit wrote the line, so it works after a squash or a rebase too, and reads the request of that turn and the proposal you said yes to. When no stored edit has the line, it follows `git blame` to the session that made the commit.

`/clens:reflect` turns what you had to correct or explain in this session into proposed edits to CLAUDE.md or AGENTS.md and to skills. Each proposal comes with the earlier sessions where the same thing happened, and only what you pick is written. A rule that a hook or a script would enforce better than a line of text is listed apart, with each time it went wrong: when, and which command failed. Give it a period (`/clens:reflect 2w`, `/clens:reflect 10주`, up to 10 weeks) to review this project's sessions over that time instead. Each run's results and your decisions are kept in `~/.clens/reflect/`, and the next run takes them into account: what you declined is not proposed again unless the problem came back. A run on one session takes about 10 to 20 minutes; a period takes longer.

`/clens:pending` lists what you set aside in this project: what you held, dropped and finished, each with your words and the date. Say an item is done or was recorded by mistake, and it is updated. The ledger fills from conversations held after you install this version, and is kept in `~/.clens/ledger.jsonl`.

`clens:stats` is not one you call. The agent reads it to answer usage questions such as "which skills do I use most" or "what is filling my context".

In Codex, call a skill as `$clens:recap`.

## How it works

clens reads the transcripts Claude Code keeps in `~/.claude/projects/` and Codex in `~/.codex/sessions/`, and indexes them into `~/.clens/index.db` (SQLite). While a session is open it keeps indexing new messages as they arrive. The agent reaches the index, and the ledger of what you set aside, through seven MCP tools:

| Tool | What it does |
|---|---|
| `clens_search` | Finds past messages by word |
| `clens_session` | Reads one session's conversation around a point |
| `clens_left_off` | Shows a project's or a file's latest sessions and where they stopped, and the checks run on a branch |
| `clens_recent` | Lists the messages in a time window, in order |
| `clens_stats` | Counts tools, files, hook blocks and context use |
| `clens_hold` | Records what you put off or dropped |
| `clens_pending` | Lists that ledger |

After a compaction, a hook (`hooks/compact.mjs`) puts that session's work record back into the conversation. When a shell command fails, another hook (`hooks/tool_failure.mjs`) compares it with the failures in the index; it runs on failures in Claude Code, and after every command in Codex, which has no failure event. clens goes online only to install its npm dependencies on first run and to download a language analyzer.

The agent writes the ledger to `~/.clens/ledger.jsonl`, apart from the index, so rebuilding the index leaves it as it is. In Codex a session-start hook (`hooks/hold_guidance.mjs`) tells the agent to record, since Codex does not pass the server's instructions to the model.

## Limits

- Search matches words, not meaning. A question worded differently from the conversation can miss it; the agent then retries with other words.
- Tool output (command results, file contents) is not stored, only the messages and the tool calls. A failed call keeps the first 100 and last 200 characters of its output, which a session's record shows; they are not searched.
- An assistant reply over 4 KB is stored as its start and end, about 2 KB each, so words in its middle are not found.
- Files a script changes, or whose path is set only when a command runs (`$VAR`, a glob), can be missing from a session's edited files. The same goes for git commands run from inside a script.
- In Codex, the compaction recovery runs only after you trust the hook, and not after a subagent's compaction.
- The agent records only what it recognises as set aside. Wording that sounds like agreement ("I guess that can't be helped") can be missed. In Codex nothing is recorded until you trust clens's hooks.

## Development

```sh
git clone https://github.com/wonwoo/clens && cd clens
npm install                    # also builds plugin/
node plugin/dist/cli.js index  # first full index into ~/.clens/index.db
claude --plugin-dir plugin     # run the plugin from the clone, this session only
npm test && npm run typecheck
```

To register the MCP server by hand, point it at `plugin/dist/server.js` itself, not `clens mcp`; otherwise `session_id: "current"` stays on the session the server started in after `/clear` or `/resume`.

```sh
claude mcp add -s user clens -- node /absolute/path/to/clens/plugin/dist/server.js
codex mcp add clens -- node /absolute/path/to/clens/plugin/dist/server.js
```

The compaction hook is `plugin/hooks/compact.mjs`, built from `src/hooks/compact.ts`, the failed-command hook `plugin/hooks/tool_failure.mjs`, built from `src/hooks/tool_failure.ts`, and the ledger guidance hook `plugin/hooks/hold_guidance.mjs`, built from `src/hooks/hold_guidance.ts` and registered for Codex only; `plugin/hooks/hooks.json` (Claude Code) and `plugin/.codex-plugin/hooks.json` (Codex) show how to register them.

The CLI:

```
clens index [--rebuild]     build or update the index
clens install ko|ja|zh      install the Korean, Japanese or Chinese analyzer
clens stats [--digest]      print the index's row counts, or a SHA-256 digest of each table
clens mcp                   run the MCP server
```

`CLENS_HOME`, `CLENS_CODEX_HOME` and `CLENS_INDEX_DIR` move `~/.claude`, `~/.codex` and `~/.clens`. Tests point all three at temporary folders, so they never touch your real ones. [AGENTS.md](AGENTS.md) holds the rules and invariants to keep when you change the code.

Both tools install `plugin/` as it is in the repository, since neither builds a plugin, so `npm run build` bundles `src/` into it and a change is committed with what it builds to. A release raises `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`), `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json`, rebuilds, pushes, then pushes the tag `v<x.y.z>`: the Release workflow checks that every version matches the tag and publishes `@clens/cli` to npm from that commit. `claude plugin validate plugin` checks the Claude Code side.

## License

MIT
