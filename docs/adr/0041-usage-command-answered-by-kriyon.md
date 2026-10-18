# ADR 0041 — `/usage` in the Structured view is answered by Kriyon

**Date:** 2026-10-11
**Status:** Accepted
**Builds on:** [ADR-0038](0038-usage-shows-only-what-claude-reports.md) (context and plan limits), [ADR-0040](0040-cli-dialogs-answered-in-the-terminal.md) (CLI dialogs)

## Context

Typing `/usage` (or `/cost`, which Claude Code 2.1.296 opens on the same
pane) in the Structured view's composer sent it to the CLI. The CLI opens a
full-screen pane and writes nothing to the transcript. Since ADR-0040 that
pane shows as a terminal over the view, which the user has to read in the
CLI's layout and close with Esc. Before that fix the view looked stuck.

Kriyon already has the figures people open `/usage` for: the session's
context window and the account's 5-hour and weekly [Plan limits], as Claude
reports them (ADR-0038).

## Decision

- **In the Structured view, `/usage` and `/cost` on their own open a
  [Usage card]** in the conversation instead of being sent to Claude. The
  card shows where it was asked, after the turns begun before it, under the
  command as typed. Nothing is typed into the terminal.
- **The card is live, not a snapshot.** It reads the same stores the
  Inspector does, so its figures move as Claude reports new ones. Figures
  Claude hasn't reported show as "—" or a short note, never an estimate.
- **A limit at 80% or more is called out** in the card's header (amber), and
  one at 100% says it is reached (coral).
- **One card per session.** Asking again moves it to the newest place; Close
  removes it. It is never persisted.
- **Claude's own pane stays one click away** ("Claude's full panel"): it has
  what Kriyon doesn't receive, such as per-model weekly limits and the cost
  breakdown. That button sends `/usage` to the CLI, whose pane then shows as a
  CLI dialog (ADR-0040).
  The button waits while a CLI dialog is open (its Enter would answer the
  dialog) and while a sent prompt is still pending (it would replace it).
- **It needs no turns**, so it also shows under the notice when Kriyon
  Companion is off; `/usage` is never swallowed without an answer.
- **The Inspector and the card read one [Plan limits view]**, so the same
  limit has the same colour and reset time on both.
- **The Raw view is unchanged**: `/usage` there goes to the CLI as typed.
- The slash menu tags `/usage` and `/cost` "Opens here" in the Structured
  view, so the difference is visible before Enter.
- `/stats` is not answered by Kriyon: its activity history is not something
  Kriyon receives.

## Consequences

- `/usage` from the Structured view no longer appears in Claude Code's own
  prompt history, since it never reaches the CLI.
- If Claude Code changes what `/usage` shows, the card won't follow; the
  "Claude's full panel" button still reaches the real one.
