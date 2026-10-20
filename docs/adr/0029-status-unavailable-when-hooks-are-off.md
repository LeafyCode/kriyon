# ADR 0029 — Say "status unavailable" when settings turn Kriyon's hooks off

**Date:** 2026-10-03
**Status:** Accepted; amended by [ADR-0031](0031-read-every-managed-source.md) (reads every managed source)
**Relates to:** [ADR-0002](0002-best-effort-background-shell-status.md), [ADR-0014](0014-session-runtime-owns-status-and-ask.md), [ADR-0027](0027-a-session-waiting-on-background-agents-is-not-done.md)

## Context

Kriyon learns a session's status only from the settings hooks it installs in
`~/.claude/settings.json`, and its usage from a custom status line. Claude Code
turns both off when [`disableAllHooks`](https://code.claude.com/docs/en/settings-reference#disableallhooks)
is `true` — in any settings file, after precedence (managed > local > project >
user) — or when managed settings set `allowManagedHooksOnly`. The key also stops
installed mods, and users reach for it to silence a misbehaving plugin.

Kriyon did not notice. No hook fired, so every session read **idle** forever,
usage stayed at "—", "Needs you" stayed empty, and the command center, whose
watcher heartbeat still ran, vouched for that idle as fresh. A confident wrong
state is the one thing the status surfaces must never show.

While checking this we also looked at Claude Code 2.1.287 mods that hold a tool
call (`await $.ui.ask(...)` before `next`). User-settings `PreToolUse` hooks run
only after the last mod calls `next`, and `$.ui.ask` is not a documented
`Notification` type, so during the hold the session reads **running**, not
waiting. Status does not stick: the next tool event or `Stop` moves it on as
usual. That gap is not fixed here; a mod-side bridge is the honest fix for it.

## Decision

**Detect hooks-off at session start and show "status unavailable" instead of a
status.**

- `kriyon_core::hooks::hooks_off` is a pure function over the parsed settings
  scopes. It returns the scope that turns the hooks off (`HooksOff`: managed,
  local, project, user) or `None`. Malformed files and non-boolean values count
  as unset, so the check can never fail a session.
- `create_session` reads the four files (managed
  `/Library/Application Support/ClaudeCode/managed-settings.json`,
  `<cwd>/.claude/settings.local.json`, `<cwd>/.claude/settings.json`,
  `~/.claude/settings.json`) and emits `session-hooks-off`. Only the scope name
  crosses IPC, never file contents.
- The sidebar row always shows "Status unavailable · hooks off in <file>", and
  the command center reads the session as `unknown`. `SessionStatus` gains no
  variant: a new status would ripple into notifications, the tray badge and the
  notify policy, none of which have anything to say about a status nobody knows.

We do not fake a status from the transcript or the PTY. The terminal is still
the source of truth, and the row now says plainly that Kriyon can't see it.

## Consequences

- Best effort: a `--settings` flag is invisible to Kriyon (MDM profiles and
  server-managed settings were too, until ADR-0031), and the check runs at session start, so a setting
  changed mid-session shows on the next start.
- If the user turns hooks back on, the next session start clears the state.
