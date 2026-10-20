# Working on Kriyon with AI tools

Kriyon is built with a lot of help from AI coding agents, mostly Claude Code. This page is for
the people driving them: what is set up, the rules we work by, and how to keep the cost down.

**AI tools are optional.** If you contribute from outside the team, you don't need any of this.
The rules that apply to everyone are in [CONTRIBUTING.md](../CONTRIBUTING.md#using-ai-tools).

## Set up

- **Claude Code 2.1.295 or later.** Check with `claude --version`. Older versions quietly
  ignore newer settings, and the safety hook needs 2.1.295 to block when it crashes
  (`onFailure`).
- **Approve the Context7 MCP server** when Claude Code asks, the first time you open the repo.
  It is set up in `.mcp.json` and gives agents current library docs. No key is needed.
- Other agents (Codex, Cursor, Copilot, Gemini) read the same rules from
  [AGENTS.md](../AGENTS.md). Nothing else to install.

## Model and effort

| When | Model | Effort |
| --- | --- | --- |
| Everyday work | Opus 5.5 | medium |
| Hard bugs, reviews, design | Opus 5.5 | high |
| Quick searches | Haiku (the `code-lookup` agent) | — |

Medium on Opus 5.5 matches the previous Opus at high. **Avoid max**: it costs a lot and tends
to overthink. Set yours with `/model`, or with `model` and `effortLevel` in your own
`~/.claude/settings.json`. The review agents set their own (below), so reviews come out the
same for everyone.

## What is in the repo

**Rules.** [AGENTS.md](../AGENTS.md) is the one rulebook for every tool, with folder rules in
`src/`, `src-tauri/` and `crates/`. `CLAUDE.md` imports it and adds the five mistakes agents
make most here. [CONTEXT.md](../CONTEXT.md) is the glossary: an index of `docs/context/`.

**Skills** (`.claude/skills/`):

| Skill | What it does | Who starts it |
| --- | --- | --- |
| `engineering-workflow` | The loop from idea to merged PR: test first, keep green, ship. | Claude, when it starts a change |
| `pr-review` | Reviews a pull request and posts line comments. Never edits, never approves. Re-running checks only new commits. | Anyone, by asking |
| `pr-fix` | Reviews your own pull request, fixes the findings, re-checks, commits and pushes. | Only by typing `/pr-fix` |
| `triage` | Reads a new issue, drafts a reply asking for what's missing, suggests labels. Never closes. | Maintainers, `/triage` |

**Agents** (`.claude/agents/`), all read-only:

| Agent | Model, effort | Job |
| --- | --- | --- |
| `pr-finder` | Opus, medium | Finds problems in one area of a pull request |
| `pr-scorer` | Opus, high | The one judge that keeps only verified findings |
| `code-lookup` | Haiku | Quick "where is X" searches |

**Safety hook.** `.claude/hooks/guard-bash.mjs` runs before every shell command the agent
starts. It blocks `--no-verify`, `git push --force`, `git reset --hard`, deleting branches, and
`tauri dev`, and it blocks the command if the guard itself fails. It also trims the output of a
full test run to the failures and the summary.

**Settings.** `.claude/settings.json` is shared and holds only the hook. Your own approvals go
in `.claude/settings.local.json`, which git ignores. Keep them there.

**Claude on GitHub.** A maintainer can type `@claude` in an issue or pull request to get help.
Only people with write access can start it, and it doesn't run on pull requests from forks.

## Rules for teammates

- **Run `/pr-fix` on your pull request before asking a person to review it.** The reviewer's
  time goes on what a tool can't catch.
- **You own every line, whoever typed it.** Read it, run it, and be able to explain it in
  review.
- **Keep the `Co-Authored-By: Claude` line** that Claude Code adds to commits. It is the honest
  record that AI helped. When AI wrote most of the change, tick the AI box in the PR template
too.
- **One session, one task.** A fresh session per task keeps the context clean and the cost
  down. Plan before a big change: ask for the plan, read it, then let it build.
- **Merging, labels and GitHub settings are yours.** Agents ask first.
- **Before each stable release**, run `/code-review ultra` on the `dev` → `main` pull request
  for a deep cloud review.

## Reviewing someone else's code safely

**Never open Claude inside a stranger's branch.** A pull request can change `.claude/` hooks,
settings or `.mcp.json`, and those run on your machine with your keys the moment Claude Code
starts there.

Review a fork's pull request from your own clean `dev` checkout instead: `/pr-review <n>`
reads the pull request through GitHub and never needs the branch. If you must run their code,
use a throwaway container with no keys in it.

## Cost tips

- Start a new session for each task, and `/clear` between unrelated questions.
- Stay on medium effort; step up to high only when medium gets stuck.
- Let the `code-lookup` agent do broad searches. It runs on Haiku and keeps the file dumps out
  of your main session.
- Ask for `pnpm check` plainly. The hook already trims its output; redirecting it to a file
  and grepping is only needed for something the summary hides.
- Point the agent at the right glossary file or folder `AGENTS.md` instead of letting it read
  the whole tree.
