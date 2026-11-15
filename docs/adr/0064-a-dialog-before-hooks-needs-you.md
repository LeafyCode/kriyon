# ADR 0064 — A dialog on screen before any hook needs you

**Date:** 2026-11-15
**Status:** Accepted
**Relates to:** [ADR-0040](0040-cli-dialogs-answered-in-the-terminal.md), [ADR-0063](0063-no-handover-of-typing-control.md)

## Context

A session's status, and so whether it "needs you", comes from Claude Code's hooks. Claude
Code asks whether to trust a new folder before it loads any plugin, so Kriyon's hooks can't
report that question. Testing on the Windows PC showed it: the phone's readable view said
Claude was asking, while the desktop list, the phone's Home and the session chip all said
Idle. The person's decision: the trust prompt counts as Needs you everywhere.

## Decision

- **A dialog on the session's own screen, before any hook event, is Waiting.** The daemon's
  dialog watch already sees CLI dialogs on screen (ADR-0040). Every 2 s tick the app tells
  each session's runtime whether one shows (`SessionRuntime::note_screen_dialog`). While no
  hook has driven the tracker, an open dialog makes the status Waiting, with the summary
  "Asks before it starts"; when it closes, Idle again. The rule is
  `kriyon_core::status::StatusTracker`'s.
- **Hooks decide once they run.** After the first hook event the screen's dialogs change
  nothing: permission prompts and questions are the hooks' to report, and a menu the person
  opened (`/mcp`) must not read as Needs you.
- **Best effort, never in the way.** It only reads state the daemon already sends, at most a
  tick late, and changes no session's process or input.

## Consequences

- The desktop list, the command center, the tray badge, alerts and every remote device's
  list show the trust prompt as Needs you, from the one status.
- A session whose hooks are off still reads Unknown: with hooks off no status is claimed.
