# ADR 0039 — Only the `claude` holding the session's terminal speaks for it

**Date:** 2026-10-11
**Status:** Accepted
**Relates to:** [ADR-0028](0028-strip-only-named-claude-code-identity-vars.md), [ADR-0033](0033-hooks-per-session-after-consent.md), [ADR-0034](0034-kriyon-companion-mod.md)

## Context

Everything Kriyon learns from inside Claude Code is tied to a [Session] by env vars it
sets in the session's shell: `KRIYON_SESSION` (hooks, status line), `CLAUDE_CODE_PLUGIN_DIRS`
(the companion folder) and `KRIYON_BRIDGE_SOCKET` (the companion's posts). Every process the
session's `claude` starts inherits them.

So a `claude` started from inside a session speaks for it. We saw this happen: Claude ran a
test script that drove nested `claude` runs ("reply with just ok", then a series of slash
commands). Each one fired Kriyon's hooks as the session. The last nested run's `Stop` marked
the session done while the real turn was still running. Its `SessionStart` re-pointed the
session at the nested conversation, and its prompt renamed the session "Ok reply". The
session stayed wrong until the real `claude` fired its next event. Clearing env vars in the
Bash tool can't fix this, because a script, an MCP server or a plugin can start a `claude`
with any env it likes.

## Decision

**A session's events count only from its [Owning claude]: the process that leads the
foreground process group of the session's PTY.**

The kernel already keeps the facts this needs, and a child can't fake them by copying env:

- Claude Code runs each Bash command in a new session with no controlling terminal, so a
  nested `claude -p` has no terminal at all.
- A script that opens a pty for a nested `claude` puts it on a different terminal.
- The session's own `claude` is a job the shell started on the session's PTY, so it leads
  that terminal's foreground group.

How each channel checks:

- **Hooks and status line.** The daemon sets `KRIYON_TTY` (the PTY's device path) in the
  shell's env. Claude Code sets `CLAUDE_PID` (its own pid) for the hook and status-line
  commands it runs. The scripts compare `ps -o pgid=,tpgid=,tty= -p $CLAUDE_PID` with
  `KRIYON_TTY` and exit without writing anything when the `claude` isn't the owner. The
  plan limits reading still records from every `claude`, because those limits belong to the
  account, not the session (ADR-0038).
- **Companion bridge.** The daemon reads the posting process from the socket
  (`LOCAL_PEERPID`). It then gets that process's group, terminal and foreground group from
  `proc_pidinfo`, and compares them with the PTY it hosts. A post from any other process gets
  a normal reply but is not kept, so the nested mod has nothing to retry.

The rule itself is `kriyon_core::proc::TerminalSeat::owns_session`, and the Python scripts
mirror it.

The daemon always removes an inherited `KRIYON_TTY` before setting its own. A Kriyon
started from a Kriyon terminal would otherwise pass that terminal's name to its sessions.

**Fail open.** When a check can't run, the event is kept, as it was before this change. That
covers a session whose daemon predates `KRIYON_TTY`, a CLI that sets no `CLAUDE_PID`, `ps`
failing, and the bridge off macOS. A dropped event from the real session would be worse than
a nested event getting through.

### Rejected

- **Pin the session to one Claude session id.** `/clear`, `/resume` and restarting `claude`
  all change the id legitimately, so this can't separate "a new conversation in this terminal"
  from "a nested one".
- **Unset Kriyon's vars in Bash tool commands** (a SessionStart `CLAUDE_ENV_FILE`). This only
  covers the Bash tool, and a script can still set the vars again.
- **Check ancestry by process name.** An npm install runs as `node`, and a wrapper script adds
  processes in between. Being the foreground group on the right terminal works the same way
  however `claude` was started.

## Consequences

- A `claude` that Claude, a script or a tool starts inside a session no longer changes that
  session's status, Claude session id, title, usage or Structured view.
- A `claude` run inside a terminal multiplexer within a Kriyon session (tmux) sits on the
  multiplexer's terminal, so it no longer reports to the session.
- Sessions whose daemon started before this change keep the old behaviour until their
  terminal is restarted.
- Each hook and status-line run now also starts `ps` (a few milliseconds).
- The check trusts `CLAUDE_PID`. Current CLIs set it to their own pid for every hook. A
  nested CLI old enough to leave it unset would inherit the outer `claude`'s pid and get
  through. We accept that over walking the process tree, which would break whenever
  Claude Code changes how it starts hooks.
