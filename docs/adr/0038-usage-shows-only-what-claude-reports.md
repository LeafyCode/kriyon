# ADR 0038 — Usage shows only what Claude reports exactly: context and plan limits

**Date:** 2026-10-11
**Status:** Accepted
**Amends:** [ADR-0033](0033-hooks-per-session-after-consent.md) (the status line now captures in every `claude`)

## Context

The Inspector's Usage section showed a "tokens" figure and a session cost.
The cost matched Claude Code's own estimate, but it is an API list-price
figure: on a Pro or Max plan nobody is billed that amount, so it misleads.
The token figure was wrong. It came from the status line's
`context_window.total_input_tokens`, which Claude documents as the tokens in
the context window *now*, from the last reply, not a session total. Its
fallback, a frontend sum over transcript events, counted a message once per
content block, skipped cache tokens, and lost events past the 1,000-event cap.

We tried counting session tokens properly and checked the result against
Claude Code's own cost on 348 past sessions. Counting each API message once
from the transcripts, subagents included, came out about 17% low at the
median and 25% low by dollars:

- Claude Code saves most subagent replies before they finish. In our data 84%
  of subagent messages hold only the stream's first snapshot, so about two
  thirds of subagent output tokens never reach a file.
- Requests outside the conversation are not in any transcript: web
  fetch/search helper calls, title generation, compaction.
- The final per-model totals (`cost-state`) are written only when the session
  exits.

The Companion mod sees each conversation request's final usage (`turn.step`),
but it still misses the helper calls. No documented source gives an exact
session token total; only the cost ledger covers every call, and it is in
dollars.

What people actually budget against is the plan's 5-hour and weekly windows.
Claude Code passes these to the status-line command as `rate_limits`
(documented, on Pro/Max logins). Those windows belong to the account, so
reading them only in Kriyon's sessions would go stale whenever the user runs
`claude` anywhere else.

## Decision

Kriyon shows a usage figure only when Claude reports it exactly. Otherwise it
shows nothing.

- **No cost and no session token total**, anywhere. That covers the
  Inspector, the sidebar footer, the usage snapshot, and the transcript
  events.
- **The context bar shows only Claude's own `used_percentage`.** Next to it is
  the status line's in-window token count. With no status-line reading, the
  bar shows "—". It is never estimated.
- **Plan limits come from the status line in every `claude`.** The wrapper
  that ADR-0033 already installs in `~/.claude/settings.json` (opt-in, "Live
  usage") now runs the capture script in every session, not just Kriyon's. It
  writes only the `five_hour` and `seven_day` percentages and reset times, to
  `~/.claude/kriyon/limits/<claude-session-id>.json`. Nothing else is read or
  written for a non-Kriyon session.
- **Merging without timestamps.** A session's reading is only as fresh as its
  last reply, and an idle session keeps repeating an old one. Within a window,
  use only grows; a new window has a later reset time. So the merge keeps the
  highest use among readings with the same reset time (within 10 minutes) and
  the latest window across them. It drops a window once its reset time passes,
  and deletes a reading when all its windows have reset.
- **The limit bars say where their numbers come from.** The status line gets
  whole percentages from the last reply, while `/usage` asks the server
  directly. In practice the status line can read 1 point lower, and the hover
  text says so.

## What this does not do

- It makes no extra API calls. It does not read credentials, call
  undocumented usage endpoints (ADR-0030), or read `~/.claude.json`.
- It does not show the model-specific weekly limit `/usage` lists (for
  example Fable). The status line does not carry it. The only documented
  source is the Agent SDK's `/usage` report, which would need Kriyon to run
  its own Claude Code session on the user's login.
- Usage on claude.ai or the desktop app shows up only after the next CLI
  reply anywhere.
- With "Live usage" off, or on an API-key login, there are no limit bars.
- It cannot tell accounts apart: the status line carries no account id. Every
  reading under `~/.claude` is taken as the same account's. After switching
  login with `/login`, the old account's readings can still count until their
  windows reset.

## Consequences

- Every `claude` on the Mac starts one short Python process per status-line
  update while "Live usage" is on. Before this change, that happened only in
  Kriyon's sessions.
- If Claude Code later documents an exact token total, or adds a scoped weekly
  window to the status line, Kriyon can show it.
