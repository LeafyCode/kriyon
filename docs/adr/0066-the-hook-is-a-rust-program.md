# ADR 0066 — The hook is a Rust program, shipped with the app

**Date:** 2026-11-15
**Status:** Accepted
**Relates to:** [ADR-0055](0055-windows-support.md), [ADR-0039](0039-only-the-claude-holding-the-terminal-speaks-for-a-session.md)

## Context

Kriyon's Claude Code hook and status-line capture were two Python scripts
(`kriyon-hook.py`, `kriyon-usage.py`). Windows ships no Python, so on a Windows
computer without one installed a session had no live status, no Needs you and
no usage (ADR-0055 named this the largest remaining Windows gap). Python's
start-up also costs every hook event tens of milliseconds, and the scripts were
a second language for the logic that `kriyon_core::hooks` reads.

## Decision

- **One program, `kriyon-hook`, in its own crate.** The pure logic (the event
  record, the usage and limit readings, JSON written as the scripts wrote it)
  is its library, unit-tested without Tauri; the binary is a thin shell with
  three modes: `event` (a hook), `usage <session>` (the status line's capture)
  and `model` (the fallback status line).
- **Shipped as a Tauri sidecar** beside `kriyon-ptyd`, built and staged by the
  same `scripts/sidecar-ptyd.mjs`. The app copies it to
  `~/.claude/kriyon/bin/kriyon-hook[.exe]` when it applies the integration, so
  the hook command names a path that doesn't move with the app, and an update
  never has to replace a file a running hook holds. The copy is only made when
  it differs, beside then renamed in.
- **Same output, byte for byte.** Golden files recorded from the Python scripts
  over 60 hook payloads and 5 status-line payloads pin the binary's output, and
  the contract tests read what it writes with the parser Kriyon uses.
- **Never breaks or slows Claude.** It prints nothing on stdout (stdout from
  some hooks becomes Claude's context), always exits 0, reads at most 64 MiB of
  stdin, parses leniently (anything unexpected records less, never fails), and
  its one subprocess, the terminal check on macOS and Linux, has a 2-second
  limit and fails open as the script did. It writes only under
  `~/.claude/kriyon`, owner-only.
- **Existing installs move over by themselves.** The hook command keeps the
  `kriyon-hook` marker, so `merge_hook_config` replaces the old Python entries
  and leaves the person's own hooks alone; the status-line wrapper is rewritten
  to call the program. Running it again changes nothing.
- **The old scripts stay as stubs.** Claude Code reads its hooks when a
  session starts, so a `claude` started before the update still runs the old
  `python … kriyon-hook.py`. With the file gone Python exits 2, which Claude
  reads as "block the tool"; so each old script becomes comments only, which
  exits 0 and prints nothing. Without Python the old command fails as
  "command not found", which Claude treats as a non-blocking error.
- **Quoting.** The command is the program's path quoted for the POSIX shell
  Claude Code runs hooks in (Git Bash on Windows, with forward slashes), so a
  home folder with a space or an apostrophe works.

## Consequences

- No Python anywhere: Windows hooks work out of the box, and the "hooks need
  Python" state becomes "the hook program isn't installed", seen only when the
  app's copy is missing.
- The app bundle carries one more small binary for each architecture.
- Changing what the hook records means changing Rust and regenerating the
  affected golden files deliberately; a silent change fails the golden test.
