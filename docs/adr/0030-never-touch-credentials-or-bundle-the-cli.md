# ADR 0030 — Never touch credentials, and never bundle or alter the CLI

**Date:** 2026-10-03
**Status:** Accepted
**Relates to:** [ADR-0028](0028-strip-only-named-claude-code-identity-vars.md)

## Context

Kriyon hosts the user's own `claude` CLI in a real terminal. That is ordinary
use of Claude Code: the user installs it, signs in through Anthropic's own flow,
and talks to it themselves. The rules below follow Anthropic's Consumer Terms
and the Claude Code legal page, which rule out third-party clients that reuse
a subscriber's login, automated or non-human access, and redistributing or
reverse-engineering the software.

The Kriyon Companion work adds hooks, a mod that can submit prompts, run
`/clear` and call `$.model.fork`, and handoff into a new session. Each of those
is a point where a convenience could tip Kriyon from "a window around the CLI"
into "an unofficial client of the user's plan". This ADR lists the lines
Kriyon does not cross, as a standing rule, so no later feature crosses one by
accident.

## Decision

**Kriyon is a window around the user's own, unmodified Claude Code. It never
handles their identity and never spends their plan without them.**

Kriyon never:

1. **Reads or stores credentials.** No reading `~/.claude/.credentials.json`,
   OAuth tokens, API keys, or macOS Keychain items, and no copying them into
   Kriyon's own storage.
2. **Sets auth environment variables.** Kriyon does not set
   `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or any other auth variable on
   the sessions it spawns. Variables the user set themselves pass through
   untouched (ADR-0028); Kriyon neither adds nor removes them.
3. **Calls Anthropic's API with the user's tokens.** Every model request comes
   from the `claude` binary the user installed, never from Kriyon's own code.
4. **Bundles, downloads, or patches the `claude` binary.** Kriyon finds the
   user's install and runs it as it is. It does not ship a copy, fetch one, or
   modify one on disk or in memory.
5. **Decompiles or reverse-engineers the CLI.** Kriyon relies only on
   documented surfaces: the terminal, the transcript files, hooks, settings,
   plugins and the mods API.
6. **Switches between accounts to get around limits.** No account pools, no
   rotating logins, no feature that exists to stretch usage beyond the user's
   one plan.
7. **Spends plan usage without a fresh click.** Every action that sends a
   prompt, runs a command or forks the model (`$.prompt.submit`,
   `$.command.run`, `$.model.fork`, handoff into a new session) runs only
   because the user clicked for that one action. No timers, auto-continue,
   "keep working" loops, auto-approval or unattended modes. Actions that spend
   plan usage say so in the UI.

## Consequences

- Login, logout, plan choice and usage limits stay entirely in Claude Code.
  Kriyon can show what the transcript reports, but it can't sign the user in or
  pick an account for them.
- Features that would need any of the above (an "auto-continue" toggle, a
  bundled CLI for one-click setup, a built-in chat that calls the API) are out
  of scope. Proposing one needs a new ADR and a review of Anthropic's current terms first.
- Reviewers check new IPC commands, mod actions and spawn code against this
  list. A change that reads a credential path, sets an auth variable, or sends
  a prompt without a click is a bug against this ADR.
- The About panel, website footer and README carry the matching disclaimer:
  Kriyon is independent, not affiliated with Anthropic, and runs the user's own
  unmodified install under their own agreement with Anthropic.
