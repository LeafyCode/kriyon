# ADR 0028 — Strip only named Claude Code identity variables at spawn

**Date:** 2026-10-03
**Status:** Accepted
**Relates to:** [ADR-0024](0024-claude-fullscreen-rendering.md)

## Context

When Kriyon is itself launched from a Claude Code session (a `pnpm tauri dev`
run from the Bash tool, say), the hosted `claude` inherits the launcher's
"you are running inside me" markers. `claude` then treats itself as a nested
instance and does not persist its transcript, so Kriyon has nothing to read.
`is_agent_identity_var` (`crates/kriyon-core/src/session.rs`) names the
variables the PTY daemon removes before it starts the shell.

It matched every `CLAUDE_CODE*` key. That prefix is also where the CLI keeps
most of its user configuration — the [environment variables
page](https://code.claude.com/docs/en/env-vars) lists well over a hundred
`CLAUDE_CODE_*` settings and only a handful of markers. So any of these, set in
Kriyon's launch environment (`launchctl setenv`, a parent shell), was silently
dropped:

- `CLAUDE_CODE_PLUGIN_DIRS` — the plugins and mods the user loads.
- `CLAUDE_CODE_NO_FLICKER`, `CLAUDE_CODE_DISABLE_MOUSE`,
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` — the renderer choice ADR-0024 promised
  Kriyon would never override.
- `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`
  — authentication and provider selection.

Values set in the shell profile were unaffected, because the shell re-exports
them after the strip. That is why the bug went unseen.

## Decision

**Strip an explicit list of identity markers; pass everything else.**

The list is the variables the docs say Claude Code sets in the processes it
spawns ("Set by Claude Code", "Set automatically", "Claude Code sets this"):
`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_EFFORT`, `CLAUDE_PID`, `CLAUDE_JOB_DIR`, `CLAUDE_CODE_BRIDGE_SESSION_ID`,
`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`,
`CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_REMOTE_SESSION_ID`, and the plugin-scoped
`CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`. To these we add the undocumented
markers a real v2.1.287 Bash tool shell carries: `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_SESSION_ATTENDED`, plus
`CLAUDE_CODE_VERSION` from the previous rule. We also strip
`CLAUDE_CODE_SSE_PORT`: an IDE sets it in its own terminal so `claude` attaches
to that IDE, and a session Kriyon hosts must not attach to whichever editor
happened to launch Kriyon.

### Why this direction, not "prefix minus a keep-list"

The two directions fail differently when the CLI adds a variable we don't know:

- **Prefix + keep-list** drops every new user setting until Kriyon ships an
  update. The setting's absence is silent: auth falls back, plugins don't load,
  the renderer flips. The user can't see why, and the list to keep in sync is
  long and grows with almost every CLI release.
- **Explicit identity list** lets a new marker through. The one marker the
  nested-transcript guarantee rests on is `CLAUDE_CODE_CHILD_SESSION` — the docs
  name it as the signal behind nesting detection (see
  `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE`) — and it is on the list. A new marker
  leaking is, at worst, the bug this function already exists to fix, visible in
  the one setup that triggers it (Kriyon launched from Claude Code), and fixed
  by adding one name.

The second failure is rarer, narrower and easier to diagnose, and the list is
short and documented. The tests pin both halves: the full set of `CLAUDE*`
keys from a real nested shell is stripped, and a sample of user settings
(plugin dirs, renderer, auth, provider) passes.

### Rejected: set `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`

It would make the guarantee hold even if a marker leaked. But it is Kriyon
setting a CLI variable on the user's behalf, which ADR-0024 rules out, and the
docs note it had no effect in some releases. Keep it in reserve if the explicit
list proves leaky.

## Consequences

- User `CLAUDE_CODE_*` settings in Kriyon's launch environment now reach
  `claude`, keeping ADR-0024's promise.
- When the CLI documents a new "set by Claude Code" variable, add it to
  `AGENT_IDENTITY_VARS` and the nested-shell test.
