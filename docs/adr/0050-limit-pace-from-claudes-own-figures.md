# ADR 0050 — Limit pace: a forecast built only from Claude's own limit figures

**Date:** 2026-10-26
**Status:** Accepted
**Amends:** [ADR-0038](0038-usage-shows-only-what-claude-reports.md) (adds one derived figure)

## Context

Running several sessions at once uses the plan's 5-hour and weekly windows
much faster than one session does. People report a weekly limit going in a
few hours and finding out only when Claude stops. ADR-0038 shows a limit only
as Claude reports it, so Kriyon could say "Weekly limit at 82%" but not "at
this rate it runs out tonight".

## Decision

- **Kriyon keeps each window's readings while it runs**, in memory: the
  percentage Claude reported and when Kriyon saw it, started over when the
  window's reset time changes. Nothing is written to disk.
- **The [Limit pace] reads the rate over the last hour**: from the hour's
  first reading to now, at the window's current figure. It needs ten minutes
  of readings and a rise of at least one point before it says anything.
- **It warns only when the window would run out before it resets**, worded
  as a forecast: "Weekly limit runs out in about 9h at this rate". The
  Inspector shows it under the limit bars; the Usage card shows it when no
  limit is at 80% yet.
- **Still no token count and no cost.** The forecast is arithmetic on the
  two figures ADR-0038 already shows, never an estimate of tokens.

## Consequences

- The warning appears only after Kriyon has watched a window rise for a
  while, so a fresh launch says nothing for the first ten minutes.
- A quiet hour lowers the rate, so the warning fades when work slows.
