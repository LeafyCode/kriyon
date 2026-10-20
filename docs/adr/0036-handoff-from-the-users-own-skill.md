# ADR 0036 — Offer a handoff from the user's own skill, at zero token cost

**Date:** 2026-10-03
**Status:** Accepted, amended 2026-10-16 (see Amendment)
**Relates to:** [ADR-0005](0005-session-lifecycle-verbs.md)

## Context

Users already write handoff notes with their own Claude Code skills (for
example `/mattpocock-skills:handoff`, which writes a `*handoff*.md` into the temp
folder). Picking that file up and starting a new session with it took
copy-paste.

## Decision

- **No Kriyon skill, no tool, no model call.** Kriyon watches its own hook events:
  a prompt that runs a slash command whose name contains "handoff" (one list of
  fragments, easy to extend), a `Write` of a `*handoff*.md` in a temp folder, or
  a `Bash` command naming one (counted only if the file changed during the turn,
  so a command that merely reads an old handoff doesn't offer it).
  When the turn ends, a card offers [Open] [Copy path] [Dismiss].
- **A click opens it.** Open reuses the Spawn dialog with an editable seed: the
  handoff file's own starting-prompt section ("Next prompt", "Start with", …),
  pointing back at the file; else `Read <path> and continue. Focus: <args>` with
  the handoff command's arguments; else `Read <path> and continue.` The user's
  confirm is the click that spends their plan. Nothing is sent automatically.
- **The path is validated in Rust** before it reaches the UI: canonical, inside
  a temp folder after following symlinks, `.md`, a regular file, at most 256 KB.
- **The link is kept.** Every follow-up records `parent_session_id`, shown as
  "↓ from <parent>" on its row.

## Consequences

- Works with any handoff skill that writes such a file; a skill writing
  elsewhere isn't picked up.

## Amendment — 2026-10-16: a handoff the session wrote may live in the home folder

Handoff notes kept with a project, such as `~/Projects/acme-handoffs/phase6/HANDOFF.md`, were
never offered: every cue required a temp folder, and the turn ended without a card or any
sign of why.

- **A `Write` may put a [Handoff file] anywhere under the home folder**, as well as in a temp
  folder. The session itself made the file during the turn, so it is the handoff that turn
  produced, not an old file it happened to touch.
- **Hidden folders stay out**: no component between the home folder and the file may start
  with a dot (`~/.claude`, `~/.ssh`, a repo's `.git`), and neither may the file name. A home
  folder of `/` counts for nothing.
- **A `Bash` command naming a file, and the search after a handoff command, stay in temp
  folders.** A command can name any file, and a search of the whole home folder would be slow
  and would offer files nobody meant as a handoff.
- The rule lives in one place, `HandoffPlaces` in `kriyon-core`, and every cue goes through
  it. The home folder counts as given and in its real form, since Claude Code writes through
  the physical path of a symlinked home. The Rust shell checks the canonical path against
  the same rule, so a link out of the home folder still fails.
