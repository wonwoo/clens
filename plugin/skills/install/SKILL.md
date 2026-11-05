---
name: install
description: |
  Install clens's Korean, Japanese or Chinese analyzer (ko, ja, zh), so
  clens_search finds messages in that language by word, not only by
  characters. Use when the user asks to install or set up an analyzer or
  word-level search for one of these languages: "/clens:install ko",
  "한국어 분석기 설치해 줘", "set up Japanese search", in any language.
when_to_use: |
  Trigger when the user asks for one of these analyzers. English needs none.
---

# Install a language analyzer

This skill runs the CLI inside the clens plugin: `start.mjs install <lang>`
downloads the analyzer into `~/.clens/models/<lang>/`, then rebuilds the
index so past messages are indexed with it.

## Steps

1. **Pick the language.** Take `ko`, `ja` or `zh` from the arguments or the
   user's words (Korean, Japanese, Chinese). When it is not clear which one,
   ask. For any other language, say clens has analyzers only for these three,
   and that other text is still found by its characters.
2. **Find the plugin.** This file is `skills/install/SKILL.md` inside the
   clens plugin, so the plugin's folder is two levels above this file's
   folder; `start.mjs` is in it. Use that absolute path, not a copy of clens
   found elsewhere.
3. **Run it.** `node "<plugin folder>/start.mjs" install <lang>`. It goes
   online (GitHub for `ko`, the npm registry for `ja` and `zh`) and writes
   under `~/.clens`, so where a sandbox blocks either, ask the user to approve
   running it outside the sandbox. The rebuild takes minutes with a long
   history: give the command the longest timeout the tool allows, or run it
   in the background and wait for it to finish.
4. **Report.** On success the last line starts with `clens install <lang>:
   done.` Tell the user the analyzer is installed and that every open Claude
   Code and Codex session, this one included, must be closed and started
   again: a session already running keeps indexing without the analyzer. On
   failure, quote the `failed:` line; nothing else changed, and search keeps
   working by characters.

## Limits

- Run it once per language. Running it again downloads the analyzer again and
  rebuilds the index again.
