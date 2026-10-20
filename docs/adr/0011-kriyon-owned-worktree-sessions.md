# ADR 0011 — Worktree sessions ride Kriyon's own git machinery, not `claude --worktree`

**Date:** 2026-07-11
**Status:** Accepted

## Context

Kriyon added opt-in [Worktree] sessions: a session can be started in a fresh
git worktree (the sidebar's per-project worktree action and the [Spawn
dialog]), so parallel work never collides in one checkout. Claude Code itself
ships a native mechanism — `claude --worktree <name>` creates a worktree under
`.claude/worktrees/`, copies `.worktreeinclude`-matched files, locks the tree
while the agent runs, and offers cleanup on exit. The obvious question: shell
out to that instead of maintaining our own creation path?

## Decision: Kriyon creates the worktree; `claude` just runs inside it

`claude --worktree` creates the worktree *after* launch, from inside the PTY.
Kriyon must know the working directory *before* it spawns the PTY daemon: the
session row persists `worktreePath`, repo-status polling, the branch chip, the
[Session diff]/merge panel, and the remove-worktree flow all key off it. Riding
the CLI flag would leave the GUI blind to where its own session lives (or
scraping the terminal to find out — exactly the coupling the loose-coupling
rule forbids).

So the existing pipeline stays authoritative:
`worktree_path_for` → `create_worktree` → `bootstrap_worktree` (env files
copied, dependencies installed, project setup command), then the session's PTY
launches with its cwd **inside** the worktree. Claude Code keys transcripts by
cwd, so `--resume` works natively; no transcript relocation is needed.
Worktrees live at the sibling convention `<repo>-worktrees/<branch>`, outside
the repo, so they can never be committed by accident and need no `.gitignore`
entry.

## Consequences

- The user-visible result matches `claude worktree` (fresh branch, own folder,
  env/deps ready) while the GUI keeps full lifecycle control: indicators,
  guarded removal (plain `git worktree remove` first, `--force` only after an
  explicit discard confirm), and merge-back via the Review panel.
- Worktrees created by other tools (including `claude --worktree`) are simply
  not Kriyon's to manage — `git worktree list` still sees them, and nothing in
  Kriyon breaks; they just carry no session row.
- If Claude Code's worktree features grow must-have behavior (e.g.
  `.worktreeinclude`), Kriyon's bootstrap is the single place to mirror it.
