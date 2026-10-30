# ADR 0034 — Kriyon Companion: an opt-in, read-only mod over a local socket

**Date:** 2026-10-03
**Status:** Accepted; amended by [ADR-0049](0049-nested-sessions.md) (one tool, one report)
**Relates to:** [ADR-0022](0022-session-processes-end-on-intent-survive-accidents.md), [ADR-0030](0030-never-touch-credentials-or-bundle-the-cli.md), [ADR-0033](0033-hooks-per-session-after-consent.md)

## Context

Hooks give Kriyon most of what it needs, but not everything: the rows the
conversation keeps (the in-between text of a turn), which permission rule
allowed a tool, and turn boundaries with reasons. Claude Code 2.1.287+ mods see
all of it. The mod API is early access, an org can block mods, and a mod sees
every prompt and output — so it has to be optional, small and plainly limited.

## Decision

- **Opt-in.** Off by default (now on by default: ADR-0042); a Settings switch, with what it sees and what it
  never does written next to it. It rides in the [Companion folder], so it loads
  only in Kriyon's sessions and only on the plugin hook route.
- **Read-only.** Every hook passes its event on unchanged and posts *after*
  `next`, without awaiting the post. It never returns a decision, rewrites a
  prompt or result, registers a tool (a tool definition costs tokens on every
  request), calls a model, reads credentials, or touches anything outside
  `~/.claude/kriyon/`. It reads one env var, `KRIYON_BRIDGE_SOCKET`. Checked
  with `claude plugin validate`, which lists exactly the hooks, calls and env
  reads above.
- **Transport.** `$.http.fetch` over a per-session Unix socket served by the
  session's PTY daemon, which redacts each event and appends it to the bridge
  spool. The daemon lives as long as the session and survives app crashes
  (ADR-0022); the app reads the spool. No TCP port, nothing leaves the Mac.
- **Order.** The mod numbers its posts; fire-and-forget posts may land out of
  order, so readers sort by that number, not by arrival.
- **Status.** One chip per session: on, starting (or waiting for folder trust),
  silent (hooks fire, the mod doesn't — Claude Code too old or mods off),
  blocked by the org, or needs a restart. Every feature the companion feeds
  falls back to hooks when it isn't on.

## Consequences

- With the companion off, Kriyon works exactly as before from hooks.
- The Structured view needs the companion (its rows are exact only from
  `session.append`) and says so when it's off.
- The mod changes only with Kriyon releases; the folder is written by Kriyon,
  never a symlink.
