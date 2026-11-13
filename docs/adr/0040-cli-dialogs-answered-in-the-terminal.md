# ADR 0040 — CLI dialogs are answered in the terminal, shown over the Structured view

**Date:** 2026-10-08
**Status:** Accepted
**Builds on:** [ADR-0035](0035-structured-view-from-the-companion.md),
[ADR-0037](0037-structured-view-takes-input-like-the-cli.md)

## Context

Claude Code often asks for keys in its own terminal: an `AskUserQuestion`
question, a permission prompt, a plan to approve, an MCP form, and the menus
slash commands open (`/mcp`, `/model`, `/config`, `/resume`, `/permissions`,
`/hooks`, `/rewind`, …). The Structured view showed none of them, so a user
there saw Claude stall and had to guess that the Raw tab held a question.
Worse, a message sent from the composer meanwhile was typed into the dialog,
and its Enter picked whatever option was selected — "Yes" on a permission.

Drawing these natively was considered and rejected. The menus have no event
and no data a mod can read; only questions, permissions and plans are reported
(by the hooks, as a [Pending ask]). Their keys, layouts and options change from
release to release, and an answer replayed as guessed keystrokes could pick the
wrong option. The terminal is the source of truth (AGENTS.md).

## Decision

- **A [CLI dialog] shows the session's own terminal over the Structured view**
  until it closes. The tab stays on Structured; this is a detour, like the one
  a permission prompt already takes from the Command centre.
- **It is known two ways**, either one enough: the screen, where every dialog
  checked on 2.1.294 ends in a key hint containing "Esc to …" ("↑/↓ to
  navigate · Enter to confirm · Esc to cancel"), and the [Pending ask] of a
  question or a plan to approve (the only signal for a plan, whose screen has
  no key hint). The working line's "esc to interrupt" is lower case and
  doesn't count. On 2.1.296 some slash commands open a pane with no hint at
  the bottom: `/usage`, `/cost` and `/stats` are taller than the screen, so
  their hint scrolls out of sight, and `/skills` draws its hint at the top.
  Every pane checked (21 commands) starts with a rule of `▔` across the
  terminal, which the input box never shows, so that rule counts too. It
  counts only from the row's first column and when it fills most of the row:
  Claude's replies and tool output are indented, so the glyph quoted there
  never opens a dialog. A permission's ask is not used: it stays open until the
  approved tool finishes, so a three-minute test run would keep the terminal
  up and the composer blocked long after the prompt was answered. Its screen
  has the hint.
- The screen is read once per beat per session, shared by everything that
  asks (the composer, the detour, a [Sent prompt] waiting to settle).
- **The terminal keeps the Raw view's box**, so the CLI is never resized when a
  dialog comes and goes. Under the Structured view it stays laid out, only
  invisible (not `display: none`): a terminal never measured keeps a grid
  that doesn't match the CLI's, and its screen reads as garbage.
- **It can be put aside** ("Back to Structured"); a pill then offers it again
  until the dialog closes. The dialog itself is only ever closed by the CLI's
  own keys.
- **The composer doesn't send while a dialog is open**, in any view: it says
  why and keeps the draft.
- The screen is read from the CLI's live rows (`baseY`), not the rows the user
  scrolled back to.
- **A [Sent prompt] is settled once a dialog it opened closes.** A slash
  command's menu closed with Esc writes nothing to the transcript, so no turn
  would ever arrive to clear the "working" line. This, like the sent prompt's
  other settle rules, runs for the session whichever view is on screen.
- **Esc in the Structured view doesn't stop Claude while a dialog is open**,
  put aside or not: it would reach the dialog and cancel it.

## Consequences

- Every dialog, including ones added in later releases, is answerable from the
  Structured view, exactly as the CLI draws it, with no per-dialog code.
- A future dialog with neither an "Esc to" hint nor a pane's `▔` rule, and
  without a hook, is missed: the view looks stalled as before, and the Raw tab
  still has it.
- A question or plan [Pending ask] left open by a missed hook keeps the
  terminal up; "Back to Structured" gets past it, and the next turn boundary
  clears it.

## Update 2026-11-13 — the host knows too

Remote access must refuse typing a device sends into a dialog it never saw, and
the window may be hidden or closed, so the desktop's screen read is not enough.

- **The [PTY daemon] reads its own screen.** After each output read it applies
  the same rule (`kriyon_core::cli_dialog::dialog_on_screen`) to its `vt100`
  emulator. The desktop's `dialogOnScreen` and the Rust one are held to the
  same screens, `crates/kriyon-core/scripts/dialog-screens.json`, so they
  cannot drift. The desktop keeps its own read, which already works.
- **A [Dialog generation] marks every change.** It moves when a dialog appears,
  closes, or changes while it shows, starts from the daemon's start time so a
  restart never repeats one, and travels as a `Dialog` frame in order with the
  output. Whoever numbers the screen updates knows which update a change came
  after; the remote host refuses input from a device that had not seen it. The
  app keeps the last one per session (`DaemonClient::dialog`), and
  `dialog_showing` adds a question's or plan's [Pending ask] as before.
- **Cheap under the lock.** The look reads only the rows that can decide: those
  that start with the rule's glyph (one cell each) and the last two filled
  rows, and hashes the whole screen only while a dialog shows. It runs on
  every read that ends a burst of output, and every 50 ms during a flood of
  full reads. Measured (release, 200x50 screen): about 5 µs a look against
  about 55 µs to emulate one 8 KB read; a dialog drawn mid-flood is seen up to
  50 ms late.
