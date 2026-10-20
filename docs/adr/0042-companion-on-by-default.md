# ADR 0042 — Kriyon Companion is offered on by default

**Date:** 2026-10-08
**Status:** Accepted
**Amends:** [ADR-0034](0034-kriyon-companion-mod.md) (its "Opt-in" bullet)

## Context

ADR-0034 kept the companion off until the user turned it on. The Structured
view (ADR-0035) only works with it, and early users could not find their way
there: the welcome screen left the switch off, and the Structured tab looked
clickable but did nothing — the reason showed only in a hover tooltip.

## Decision

- **The welcome screen offers the companion on**, next to the other additions,
  with the same plain text about what it sees and what it never does. Consent
  is still the one Continue: nothing is written before it, and the switch can
  be turned off there or in Settings.
- **The Structured tab is never disabled.** With the companion off, the view
  says so and offers "Turn on Kriyon Companion" (which also turns the status
  hooks on, since the companion rides in their plugin). Sessions started after
  that get it; a running one asks for a restart.
- Saved prefs are not changed: a user who turned the companion off keeps it
  off, and is offered it from the Structured view instead.

## Consequences

- New installs get the Structured view without a trip to Settings.
- The mod still loads only in Kriyon's sessions, only on the plugin route, and
  stays read-only; an org that blocks side-loading still gets no switch.
