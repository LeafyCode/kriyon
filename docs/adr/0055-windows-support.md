# ADR 0055 — Kriyon on Windows

**Date:** 2026-11-02
**Status:** Accepted

## Context

Kriyon was built Mac-first: its session daemon talks over a Unix socket, stops
a session by sweeping `ps` and sending signals, reads busy state from the
terminal's foreground process group, and hosts zsh. People asked for Windows.
Windows 10 (1803+) and 11 have pseudo consoles (ConPTY), Unix-domain sockets,
and Job Objects, which together cover everything the daemon needs. Claude Code
runs natively on Windows and runs hook commands through Git Bash.

## Decision

- **Same daemon, same protocol.** The [Session socket] stays a Unix-domain
  socket; Windows gets the stream type from `uds_windows` behind
  `kriyon_core::uds`. Socket paths, the stale-socket rule and every frame are
  unchanged.
- **A Job Object is the Windows [Tree stop].** The daemon puts its shell in a
  job created with `KILL_ON_JOB_CLOSE`, whose only handle is the daemon's.
  Everything the shell starts joins it, so stopping the job ends the whole
  tree, and the daemon ending for any reason — `Shutdown`, `TerminateProcess`
  from the app's reaper, a panic — closes the handle and ends it too. There is
  no sweep and no pid-reuse guard to get wrong. Forcing a stuck daemon ends
  only the daemon: its job takes the tree, and Windows parent pids go stale,
  so walking "children" by them could end unrelated processes.
- **The daemon answers ConPTY's opening cursor query.** ConPTY asks the
  terminal where the cursor is (`ESC[6n`) and runs nothing until it hears
  back, and the shell starts before any app is attached. The daemon answers
  the first one (`ESC[1;1R`) and strips it, so an attached xterm never answers
  twice.
- **PowerShell is the session shell.** `powershell.exe` ships with every
  supported Windows; `$SHELL` there is a Git Bash path and is ignored. Launch
  lines (`claude --resume`, a seeded first prompt, a nested session's env) are
  written in PowerShell, with the seeded prompt read as UTF-8 and escaped for
  Windows PowerShell's native argument passing, and a nested session's env
  removed again when its `claude` ends. Rust tells the frontend the shell's
  language with each session, so the launch line always matches the shell.
- **Daemons run from a per-build copy.** Windows can't replace a running
  program's file, and daemons outlive the app, so a daemon run from the install
  folder would make every update fail while any session is open. The app
  copies `kriyon-ptyd.exe` into `<run dir>/bin/<size>-<modified>/` and runs it
  from there; older copies go once nothing runs from them.
- **The process table comes from the OS, shaped like `ps`.** A Toolhelp
  snapshot plus each process's own command line become the same `ProcRow`s,
  and Windows stands in for the terminal foreground where it matters: a
  daemon's shell with a child is running that child. The daemon's busy signal
  uses the same rule, read from its job's members, so a process a finished
  command left behind never holds a session busy.
- **Hooks need a real Python.** The hook scripts are Python, and Windows ships
  none (`python3` there is a Store stub that fails). Kriyon finds a real
  `python.exe` and writes its full path into the hook command, or else uses
  the `py` launcher; with neither, it leaves the hook entries out instead of
  letting every event print a hook error, and each session says its status is
  unavailable because the hooks need Python. The companion module needs no
  Python and still loads.
- **Paths are compared in one spelling.** `canonicalize` goes through `dunce`
  (no `\\?\` verbatim paths, which no event or user path ever matches; clippy
  bans the standard one), repo-relative paths are written with `/`, and the
  frontend reads `C:\`-style paths by either separator. A long path `dunce`
  must keep verbatim is compared in its ordinary form. A file's identity is its
  volume and file index, as a Unix one is its device and inode.
- **No menu bar on Windows.** Tauri's default menu would add a Quit that
  skips the close gate, and everything it would hold is in the window or the
  tray. Shortcuts only the menu bar gives (⌘N) are not shown there, and copy
  that names the Help menu is marked `{mac:…}` where it is written.
- **File names Windows would read as something else are refused.** A trailing
  dot or space, `:` (a file stream), other characters Windows forbids, and
  device names such as `NUL`; `.git.` would otherwise become `.git`. A delete
  that can't go to the Recycle Bin asks first rather than deleting for good.

## Consequences

- One codebase and one protocol; the Windows-only code is the Job Object, the
  process table, the per-build daemon copy and a handful of `cfg(windows)`
  file-system and spawn details (no console windows for helper programs).
- Status hooks on Windows depend on Python being installed. Porting the hook
  scripts to a small Rust program would remove that dependency; it is the
  largest remaining Windows gap.
- The Release workflow builds the Windows NSIS installer beside the Mac build,
  into the same draft release, with its own update feed file, `windows.json`
  (ADR 0056, docs/RELEASING.md). It is not
  code-signed yet, so SmartScreen warns and Smart App Control can block it;
  the signing service is still to be chosen.
