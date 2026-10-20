# ADR 0035 — Bring back a Structured view, fed by the companion

**Date:** 2026-10-03
**Status:** Accepted
**Supersedes:** [ADR-0019](0019-remove-the-structured-pane.md)

## Context

ADR-0019 removed the Studio pane: it re-rendered the transcript with 14 block
kinds, reconciled prompt echoes, lagged the terminal, read a tree as a list,
and froze WebKit with DOM weight — second-best at its own job next to a live
terminal.

The [Kriyon Companion] (ADR-0034) changes the source. `session.append` hands
every kept row as it is stored, with its transcript uuid, numbered by the mod;
nothing is reconstructed or reconciled.

## Decision

- **A smaller view, not the old one.** Each turn is its prompt, a folded "What
  Claude did" (steps, in-between text, "Thought for N s"), and the reply. Four
  item kinds. It summarizes the terminal; it doesn't mirror it.
- **Exact or off.** The tab is enabled only while the session's companion is on;
  otherwise it is disabled and says why, and the terminal stays one click away.
  Without the companion the in-between text isn't available from hooks, so the
  view would only be close — not good enough.
- **History from the transcript, as a tree.** Rows from before the companion
  connected (a resume, a late load) come from the transcript, following
  `parentUuid` from the newest main row — never file order, so a rewound branch
  never shows. Such turns carry a "From transcript" chip.
- **Thinking.** The API hides raw thinking; the view shows "Thought for N s"
  when the transcript recorded how long.
- **DOM weight.** Mounted only for the session on screen, never in a warm pane;
  turns are folded by default and capped at the newest 200.
- **Read-only.** Replies are typed in the terminal.

## Consequences

- The transcript parser stays headless for everything else.
- If the mod API changes, the view degrades to its "needs the companion" notice.
