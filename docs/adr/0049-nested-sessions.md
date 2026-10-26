# ADR 0049 — Nested sessions: Claude may ask Kriyon to start a session, and only the person's words start one

**Date:** 2026-10-26
**Status:** Accepted
**Amends:** [ADR-0034](0034-kriyon-companion-mod.md) ("never registers a tool"; "read-only")

## Context

Claude Code's desktop app now lets a session start other sessions for
parallel work. Each one reports back to the session that started it, and the
sidebar shows them nested under it. People who run several sessions at once
in Kriyon start the extra ones by hand and then carry results between them.

ADR-0034 kept the Companion read-only: it never registers a tool and never
steers. A session can't start another without a tool, and it can't report
back without sending something.

The desktop app's own rule is the right default. A session starts at once
only when the person asked for it in their own words to that session.
Anything else becomes a suggestion they click: Claude's own idea, a peer
session's message, a scheduled run, a subagent. That blocks a prompt
injected through a file or a peer message from fanning out sessions that
spend the person's plan.

## Decision

- **One tool, deferred.** In a Kriyon session the Companion registers
  `start_session` (`mcp__kriyon-companion__start_session`). It is left behind
  ToolSearch, so only its name costs tokens until Claude asks for it.
- **The mod reports who asked; Kriyon decides.** The mod remembers the origin
  of the newest prompt the main loop read. A call counts as `user_asked` only
  when Claude said the person asked, the call is on the main loop, and that
  prompt was typed at the terminal (`composer`) or sent over Remote Control
  (`bridge`). Everything else is `own_initiative`. The request travels as
  one more bridge event, so the daemon's owner check still drops posts from
  a nested `claude -p`.
- **Kriyon starts only what the person asked for, under their cap.** The Rust
  core validates every field: prompt and title are trimmed and capped, and a
  branch name that isn't plainly safe is dropped. It then decides:
  `user_asked` while fewer sessions run than the [Nested session cap]
  (default 4) starts in the background. Anything else is a [Session
  proposal] card on the lead session, and nothing starts until the person
  presses Start.
- **Requests are kept once.** Each is stored by its tool call's id in the
  activity store, so a re-read spool can't start it twice. The UI takes the
  requests only after the saved sessions have loaded, so a request posted
  while Kriyon was closed still finds its lead session.
- **A nested session is a real session.** It has its own terminal and its own
  daemon, in the lead session's folder or on a new worktree, and the person
  can open and steer it like any session. The sidebar lists it under its
  lead session (`nested_under`). The person can also start one by hand with
  Split off.
- **One report, from the right conversation.** Kriyon launches the nested
  `claude` with `--session-id <id>` and `KRIYON_REPORT_TO` / `KRIYON_REPORT_FROM`.
  When that conversation's first turn ends, its Companion sends the reply
  once to the lead session with `$.session.send`, Claude Code's own
  cross-session delivery. The lead session's inbound setting still applies.
  A `claude` run inside the nested session inherits the env but has another
  conversation id, so it never reports.

## Consequences

- The Companion is no longer strictly read-only. It adds one tool, and in a
  nested session it sends one message. It still never answers for a hook,
  changes a prompt or tool call, or approves anything. `claude plugin
  validate` lists the new calls (`$.tool.register`, `$.session.send`) and env
  reads.
- With the Companion off there is no tool, so Claude can't start sessions.
  Split off still works.
- An unanswered suggestion lives in memory only; a restart forgets it.
- Later turns of a nested session don't report back. The person is steering
  it directly by then.
