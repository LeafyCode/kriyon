# ADR 0044 — Agent governance for a public repo

**Date:** 2026-10-15
**Status:** Accepted
**Updates:** ADR 0001 (three-layer agent governance)

## Context

ADR 0001 set up three layers: short always-on rules, on-demand skills, and tools that enforce
what can be enforced. That still holds. What changed is that Kriyon is about to become a public
repository with outside contributors, and the setup had gaps:

- `CONTEXT.md` had grown to 91 KB, too big to read on every task.
- Only Claude got the folder rules: there was no rule file for `crates/`, and nothing for
  Copilot. Copying rules into one file per tool drifts; another LeafyCode repo has eight such
  copies, and they skip the safety rules.
- No model or effort was set anywhere, so every review ran on each person's own defaults.
- "Only run `pr-fix` when asked" was a sentence, not a setting.
- The guard hook blocked two git commands and failed open: a crash in it let everything through.
  It also blocked text that only mentioned a rule, such as a heredoc writing a doc.
- Context7 was named in `AGENTS.md` but not set up.
- A pull request from a stranger can change `.claude/` hooks, which run on the reviewer's
  machine with their keys.

## Decision

**One rulebook.** `AGENTS.md` stays the single source for every AI tool, under 200 lines,
written as calm rules with a one-line reason each. Each folder with its own rules (`src/`,
`src-tauri/`, `crates/`) has an `AGENTS.md` and a one-line `CLAUDE.md` that imports it. The root
`CLAUDE.md` imports `AGENTS.md` and adds the five mistakes agents make most often here.
`.github/copilot-instructions.md` only points to `AGENTS.md`. No per-tool copies.

**A split glossary.** `CONTEXT.md` is an index naming every term and the area file under
`docs/context/` that defines it. The naming rule still points at `CONTEXT.md`.

**Model and effort in files.** The review roles are agent files in `.claude/agents/`, with
read-only tools: `pr-finder` (Opus, medium effort), `pr-scorer` (Opus, high effort) and
`code-lookup` (Haiku). The review skills launch them by name. The team default for everyday
work is Opus 5.5 at medium effort, high for hard bugs and reviews, never max. It is documented
in `docs/AI.md` and not forced in the shared settings, so each person can still choose.

**Side effects need a person.** Skills that change code or act on GitHub for the person
(`pr-fix` edits, commits and pushes; `triage` labels and comments on issues; `release` when it
lands) set `disable-model-invocation: true`, so only typing the command starts them.
`pr-review` stays startable by asking: it only posts review comments and never edits, and
`AGENTS.md` still says to run it only when asked.

**A guard that fails closed.** `.claude/hooks/guard-bash.mjs` is the one PreToolUse(Bash) hook.
It blocks skipping git hooks, force push, `git reset --hard`, branch deletion and `tauri dev`,
and ignores heredoc bodies. Any error inside it blocks, and the hook entry sets
`onFailure: "block"` for crashes it can't catch. It also pipes bare full test runs through a
filter that keeps failures and the summary. The shared `.claude/settings.json` holds only
team-wide settings; personal approvals stay in the gitignored `settings.local.json`.

**Context7** ships in `.mcp.json`.

**Claude on GitHub.** `claude.yml` runs `anthropics/claude-code-action`, pinned to a commit,
when someone with write access types `@claude`. It follows ADR 0043's workflow rules and is off
while the repo is private; its `ANTHROPIC_API_KEY` secret is set at launch. It never runs on a
fork's pull request: the action restores only `.claude/`, `.mcp.json` and the root `CLAUDE.md`
from the base branch, so the fork's `AGENTS.md` and folder rule files would reach Claude as
instructions in a job holding the key. Its first step stops the job for a fork.

**Reviewing strangers' code.** Never open Claude inside a fork's branch. Review it with
`/pr-review` from a clean `dev` checkout, which reads the pull request through GitHub.

**Skills and the review engine stay in the repo** for now. Later, the shared review engine moves
into one public LeafyCode plugin, and each repo keeps only its own `repo-rules.md` and
`precedents.md`.

## Consequences

- Every AI tool reads the same rules, and the guard holds even when its own code breaks.
- Claude Code 2.1.295 or later is needed for `onFailure`. `docs/AI.md` states it; an older
  version still runs the hook but lets a crash through.
- The glossary index must list every term. A new term needs its entry in an area file and its
  name in the index.
- The test-output filter only touches exact, known commands, because a rewrite approves the
  command it runs. A new full-suite script must be added to its list to be filtered.
- ADR 0001's layers stand. This ADR replaces its details: `CLAUDE.md` is no longer only
  `@AGENTS.md`, and the hook is `guard-bash.mjs`, not `guard-git.mjs`.
