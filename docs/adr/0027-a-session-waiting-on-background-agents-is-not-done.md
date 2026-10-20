# ADR 0027 — A session waiting on background agents is not done

**Date:** 2026-09-27
**Status:** Accepted
**Relates to:** [ADR-0002](0002-best-effort-background-shell-status.md), [ADR-0003](0003-ephemeral-session-activity-projection.md), [ADR-0014](0014-session-runtime-owns-status-and-ask.md)

## Context

Claude Code now runs subagents in the background by default. An `Agent` call
returns at once with a launch receipt (`{"isAsync": true, "status":
"async_launched", "agentId": …}`), the main agent's turn ends, and `Stop` fires
while the agents are still working. When an agent reports back, Claude Code wakes
the main agent with a `<task-notification>` prompt (a `UserPromptSubmit`), and
the turn that follows ends in another `Stop`.

Kriyon read every main `Stop` as Done. A recorded session
(`~/.claude/kriyon/events/faf1a384…jsonl`, Claude Code 2.1.283) showed what
followed:

1. The session read **Done** while nine agents were still running.
2. The agents' own tool events carry the main session's id, so the status
   flapped Done ↔ Running on each of them.
3. A minute after the turn ended, Claude Code's idle-prompt nudge arrived during
   one of those Running flaps. Mid-turn an idle prompt means a question is on
   screen, so the session read **Waiting for you** — a false "needs you".

The Inspector had the same root cause: it marked each background agent Done
the moment its launch receipt arrived.

## Decision

- **The main agent's `Stop` decides, using Claude Code's own list.** Since
  2.1.x the `Stop` payload carries `background_tasks`: the background work still
  in flight, which Claude Code documents as the way to tell "session is done"
  from "session is paused waiting for background work to wake it". The hook
  script records it trimmed to `{id, type}` ([In-flight work]).
- **Only agent work holds a session open.** A [Background agent] is an entry of
  type `subagent`, `workflow`, `teammate` or `cloud session`. Shells and monitors
  do not count — they can outlive the work the user asked for. Housekeeping
  types (`dream`, `auto-mode scan`, MCP tasks) do not count either. An unknown
  type does not count, so a type added after this build can never keep a session
  in Running.
- **A `Stop` with background agents keeps the session Running**, with the summary
  "Waiting on N agents…". Running is not an attention state, so nothing is
  announced. The `Stop` that ends with none left is the one that reads Done and
  notifies. Each `Stop` replaces the previous list outright, so a killed agent
  (which fires no `SubagentStop`) drops out on the next `Stop`, with no timeout.
- **The idle prompt is ignored only while agents hold the session.** The
  tracker records whether the [Main turn] is open. An idle prompt that arrives
  after the turn ended with agents still listed is ignored; with none listed it
  settles the session to Done, so nothing can wedge it in Running.
- **A block remembers whose it is ([Waiting for]).** A permission request that
  names a subagent is that subagent's. A block that names no agent is the main
  agent's while it is inside a tool of its own (its question, its plan, its
  permission), and unattributed otherwise.
  - Only the agent that raised a block can lift it by carrying on. An
    unattributed block is lifted by any agent's work, unless the main agent is
    inside a tool of its own. The main agent's own question is never lifted by
    an agent working.
  - A turn that ends while an agent's block is still on screen stays Waiting.
- **Otherwise a subagent's tool events never change the status.** They update
  the summary while the main turn is open (a foreground subagent's work shows),
  and they count as work for a tracker that has seen nothing else yet. They
  never reopen a Done session: after a `Stop` that listed no agent, a
  straggling event from a killed agent must not wedge the session in Running.
- **The re-entry latch applies only to a turn that ends Done.** A `Stop`
  re-entry that pauses on agents announced nothing, so it must not suppress the
  completion that follows.
- **Older builds keep today's behaviour.** A `Stop` without the list is taken at
  its word (Done).
- **The Inspector reads the same list,** through the same [Hook signal]
  classifier as status, so the two agree on which agents are still running.
  - A launch receipt keeps its [Subagent] running and binds its `agent_id`
    exactly, taking back a lazily-credited id or tool on the way. A receipt
    without a readable id is still a launch: the subagent runs until the turn
    ends.
  - A main turn end settles only the subagents it no longer lists.
    `SessionEnd` still settles everything.
- **`SubagentStart` / `SubagentStop` are not registered.** An empirical run
  showed that `SubagentStop` does not fire when an agent is killed, and that one
  agent can stop and start again under the same id. A counter kept from those
  hooks drifts, whereas the `Stop` list is always Claude Code's own answer.

## Consequences

- Replay after a restart folds identically, because the list lives on the
  recorded event.
- An agent that stops to wait on its own background shell drops out of the
  list, so the session reads Done until the agent wakes up. The list carries no
  owner field that could tie a shell to its agent. This is accepted: the gap is
  short, and the agent's report wakes the main agent, whose next `Stop` settles
  the session again.
- An agent that vanishes without Claude Code ever reporting back leaves the
  session Running until the next `Stop`. This is accepted: in that case Claude
  Code's own view is still that the work is in flight.
- The result text of a background agent reaches the main agent in its
  `<task-notification>`, which the hook script does not record. For now the
  Inspector shows no result for background agents, rather than the launch
  receipt it used to show.
- Session-scoped crons (`session_crons`, `/loop` wakeups) are out of scope: a
  session waiting on a timer reads Done.
