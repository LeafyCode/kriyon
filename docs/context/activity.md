# Session activity, Needs-you and notifications

What a session is doing right now, when it needs the user, and how Kriyon tells them.

Part of the Kriyon glossary. The index and the naming rule are in [`CONTEXT.md`](../../CONTEXT.md).

- **Session engagement** (`SessionEngagement`) — how busy a [Session] is with *Claude itself*,
  as one of `running` (a turn in flight), `starting` (still launching, so no hook has fired and
  its status is still idle) or `quiet` (nothing a stop would interrupt — including a session
  whose processes have already died). Derived once from status, [Boot phase] and the recorded
  exit, so the three can never be read in disagreeing combinations: a session cannot be counted
  as both working and starting, and no consumer re-implements the "is anything at stake" test.
  Distinct from [Background shell]s, which a stop also ends but which are counted separately.
  _Avoid_: busy, activity (that's [Session activity]).
- **Subagent** — a nested agent a Session spawns via Claude Code's Agent tool (named `Task` in
  older builds). Has no PTY and no cwd of its own; runs to completion and returns a result to its
  parent Session — at once, or later as a [Background agent] when launched in the background (the
  default in current builds). Detected from Claude Code's live hook events (see [Session activity]), not from
  the transcript and not driven by Kriyon. Its result text is revealed on demand in the Inspector;
  its own conversation is not reconstructed anywhere. _Avoid_: child session, sidechain, task.
- **Background shell** — a Bash command the Session launched with `run_in_background`, tracked by
  its `bash_id`. _Avoid_: background task, background job, background process.
- **Main turn** — the [Main agent]'s own turn: opened by its prompt or tool calls, ended by its
  `Stop`/`StopFailure`. Distinct from the session being busy: a session whose main turn has ended
  can still be `running` on [Background agent]s. _Avoid_: turn state, conversation turn.
- **Waiting for** (`WaitingFor`) — whose request a `waiting` [Status] holds for the user: the
  [Main agent] (blocked inside a tool of its own), a named [Subagent], or unattributed. Only the
  agent that raised a block can lift it by carrying on; the main agent's own question is never
  lifted by a subagent working. The [Pending ask] follows the same rule: a subagent's permission
  dialog is an ask until that subagent carries on. _Avoid_: blocker, block owner.
- **In-flight work** (`InFlightWork`) — one entry of the list Claude Code attaches to each `Stop`
  hook (`background_tasks`): background work still running when the turn ended, as an `id` and a
  type (`subagent`, `workflow`, `shell`, `monitor`, …). Each `Stop` resends the whole list. See
  ADR 0027. _Avoid_: background task, pending work.
- **Background agent** — [In-flight work] that is agent work (`subagent`, `workflow`, `teammate`,
  `cloud session`): the Session is paused on it and will be woken when it reports back. While a
  `Stop` lists any, the [Status] stays `running` ("Waiting on N agents…"), not `done`. Shells and
  monitors are in-flight work but never Background agents. _Avoid_: async agent, pending agent.
- **Session activity** — the live, derived state of a Session beyond its `SessionStatus`: its
  running Subagents, Background shells, and current Task list. Reconstructed from the signals
  Claude Code writes live — hook events (subagents/shells) and the task store
  `~/.claude/tasks/<claude-id>/` — rather than the transcript, which needs correlation the hooks
  already give. Ephemeral; shown in the Inspector. _Avoid_: session state (that's `SessionStatus`).
  Also carries the session's open [Pending ask].
- **Session activity projection** (`SessionActivityProjection`) — the single fold that
  reconstructs [Session activity] from the hook-event stream. Owns the two inner projections
  (`HookActivity` for subagents/shells, `AskState` for the [Pending ask]) behind one `ingest`, so
  their coordination — a turn-ending `Stop` both [Settle]s subagents and clears the ask on the same
  event — lives and is tested in one place, not smeared across two `.ingest` call sites.
  _Avoid_: activity reducer, ask reducer.
- **Main agent** (`MainAgent`) — the top-level `claude` in a [Session] (the one driving the
  conversation), as opposed to a [Subagent] it spawns. In [Session activity] it carries only its
  in-flight [Tool activity]. _Avoid_: parent agent, root agent.
- **Tool activity** (`ToolActivity`) — one tool the [Main agent] or a [Subagent] is currently
  running: a `toolName`, an optional `target` (a file path or command summary), and `startedAt`.
  Set on a tool's `PreToolUse`, cleared on its `PostToolUse`. Enrichment over the core spawn/state
  view; renders as "Editing Foo.tsx". _Avoid_: current action, running tool.
- **Current tool** (`currentTool`) — the [Tool activity] in flight for an agent right now, or none.
- **Agent id / Agent type** (`agentId` / `agentType`) — the runtime id and the type (e.g.
  `"Explore"`) Claude Code stamps on a [Subagent]'s internal tool events. Kriyon binds `agentId` to
  a [Subagent] lazily, by `agentType` + spawn order, to attribute its [Current tool]. Enrichment
  only; the spawn list, counts, states, and results never depend on it.
- **Settle** — forcing any still-`running` [Subagent] to `done` and clearing every [Current tool]
  when the [Main agent]'s turn ends (`Stop`) or the session ends (`SessionEnd`), so [Session
  activity] never sticks in a false "running" state. A `Stop` spares the [Background agent]s its
  list still names; everything else it settles is proven finished.
- **Command center** — the cross-project surface listing every [Session standing],
  grouped by [Project], with the [Needs-you rail] pinned on top. Read-only; selecting
  a standing focuses that [Session]. The product's orchestration view: the one place to
  watch many sessions across many projects. _Avoid_: dashboard, overview.
- **Session standing** (`SessionStanding`) — one [Session]'s entry in the [Command
  center]: a flat, cheap-to-diff record of `sessionId`, `projectId`, `worktree`, a
  [Standing state], `lastChangeMs`, and `lastSeenMs`. Derived (never stored) so it
  rebuilds from live state. Reconciles with [Status] rather than duplicating it: [Status]
  (`SessionStatus`) stays the one source-of-truth status; [Standing state] is its
  command-center projection plus a liveness overlay (see [Standing staleness]).
  _Avoid_: session summary, board entry.
- **Standing state** (`StandingState`) — the vocabulary the [Command center] renders:
  `running | awaiting_input | changed | idle | unknown`. A presentation of [Status]:
  `running→running`, `waiting→awaiting_input`, `done`/`error`→`changed`, `idle→idle`.
  `unknown` is shown honestly — a [Session standing] that has gone stale, never collapsed
  into `idle`.
- **Needs-you rail** — the pinned top section of the [Command center] gathering every
  [Session standing] whose [Standing state] is `awaiting_input`: the sessions actually
  blocked on the user. _Avoid_: attention list, inbox.
- **Pending ask** (`PendingAsk`) — the concrete thing a `waiting` [Session] wants from the
  user: a `question` (from `AskUserQuestion`), a `permission` (from a permission prompt), or a
  `plan_approval` (from `ExitPlanMode`), with `askedAt` and one line of text. Reconstructed
  live from hook events by `AskState`; cleared at every turn boundary (the settle guarantee).
  Rides the [Session activity] snapshot. The frontend adds a `best_effort` snippet tier (last
  assistant text) for waiting sessions with no exact ask — shown honestly, never as exact.
  _Avoid_: request, prompt (ambiguous with the user's prompt).
- **Viewed marker** (`ViewedMarker`) — the per-[Session] record of what the user had seen when
  they last left it: the wall-clock `ms` they looked, the monotonic append counter's value then
  (`appendSeq`), and the completed-[Task] count then (`tasksDone`). Stamped at activation; the
  [Needs-you section] and the sidebar's age fold both query it, through the one `unseenOutput`
  seam, for how much output has landed unseen. Because it stores the append counter — not an
  event-array length — that count survives the event ring's front-eviction at 1000 events, where a
  stored offset silently goes wrong. _Avoid_: seen count, last-viewed offset. Distinct from the
  [Jump rail]'s per-file `viewed` flag, which is about having scrolled past a file card, not about
  leaving a [Session].
- **Needs-you section** — the sidebar's pinned top group: sessions blocked on the user
  (rows with an exact [Pending ask] read as questions and are highlighted distinctly),
  sessions in error, and finished sessions with output the user has not seen yet (an
  entry clears when its session is focused). The sidebar sibling of the [Needs-you
  rail]; replaced the earlier cycling "Needs you" nav button. _Avoid_: attention list, inbox.
- **Needs-you overlay** — the ⌘⇧K-summonable panel rendering the same enriched list as the
  [Needs-you rail], from any view. ↑↓ selects, Enter focuses the session (routing to the
  [Raw view] when the [Pending ask] is exact), Esc closes. _Avoid_: inbox, notification center.
- **Standing staleness** — the liveness gate on a [Session standing]. When
  `now − lastSeenMs` exceeds the staleness window the standing renders `unknown` rather
  than a possibly-wrong concrete state ("no silent staleness"). Driven by the [Session
  heartbeat]; a dead or quiet watcher ages out into `unknown`. _Avoid_: timeout, expiry.
- **Session heartbeat** (`session-heartbeat`) — a periodic per-[Session] liveness ping
  the backend emits while a session's watch is alive, carrying the watcher's own last-pump
  wall-clock time as `lastSeenMs`. A watcher whose pump thread dies stops advancing that
  time, so its [Session standing] goes stale → `unknown`, even though heartbeat events keep
  arriving. _Avoid_: ping, keepalive, poll.
- **Notify preference** (`NotifyPreference`) — the user's cross-project OS-notification
  policy: `all | only_blocked | none`. Layered on top of the per-transition [Status]
  notify decision (`should_notify`) so the user can mute everything, or only be told about
  sessions blocked on input, across every project. _Avoid_: notification settings, mute.
- **Notify sound** (`NotifySound`) — the user's chosen OS-notification sound:
  `default` (keeps the system alert), `silent` (banner only), or one of the bundled
  `.wav` sounds (marimba, music_box, vibraphone, kalimba, bell) shipped in
  `src-tauri/sounds/`. Distinct from [Notify preference], which gates *which* sessions
  notify at all; this picks *what plays*. Resolves to a **Notify sound kind**
  (`NotifySoundKind`: `Silent`, `System`, or `Bundled(filename)`) via `kind()` — the one
  total function every consumer (notification + preview) matches on. _Avoid_: sound
  preference, ringtone.
- **Notification kind** (`NotificationKind`) — what a Claude Code `Notification` hook
  actually means for the [Session] it belongs to: a `Block` (a permission gate or an MCP
  elicitation dialog — the user cannot proceed), an `IdlePrompt` (the prompt has sat
  idle), `Informational` (a login succeeded, an elicitation resolved, a *background*
  agent reporting its own lifecycle — asks nothing of this session), or `Unknown`.
  Derived by `notification_kind` from Claude Code's structured `notification_type`,
  falling back to the message prose only for builds predating that field. The single
  classifier both the [Status] fold and the [Pending ask] read, so they can never
  disagree about the same notification. _Avoid_: notification category, alert type.
- **Notification content** (`NotificationContent`) — the rendered pieces of one OS
  notification: a `title` line (`<emoji> <project> · <session title>`) and a `body`
  (the attention label, plus the [Pending ask]'s own line when there is one). A pure
  function of ([Status], [Pending ask], project name, session title), built in
  `kriyon-core` so it is unit-testable without Tauri. The leading emoji mirrors the
  sidebar `kindIcon` meanings. _Avoid_: notification payload, alert.
- **Notification plan** (`notification_plan`) — the whole OS-notification policy
  behind one pure seam: it folds the notify decision (`NotifyDecision::should_fire`,
  the *when*) and the [Notification content] shaping (the *what*) into one function,
  returning the content to show or `None` to stay quiet. `should_fire` is evaluated
  exactly once; the caller passes a `display` closure resolving (project, title) that
  the plan invokes *only when it fires*, so the Tauri shell's store lock is deferred
  to the rare firing transition. The one place the decide-and-shape policy lives and
  is tested, instead of as untested inline glue in the status runtime. _Avoid_:
  notify plan, notification decision.
- **Settle window** (`NOTIFY_SETTLE`, `SessionRuntime::arm_notify` / `notify_ready`) — a
  fireable attention transition is *armed*, not fired: it must stay put for the window
  before it notifies, so a state that flips straight back to work (a spurious idle
  prompt, an auto-granted permission) is disarmed and never pings. The 2s badge ticker
  re-drives the check, so a genuine block still surfaces within ~a tick.
- **Pty-quiet confirm** (`PTY_QUIET`, `NOTIFY_MAX_DEFER`) — the second half of the
  [Settle window]: a settled notification is still held while the session's pty is
  producing output. Hook events and terminal bytes reach Kriyon on separate channels
  with no ordering between them, so a `Stop` can land while the screen is still filling;
  the terminal going quiet is the confirmation the hook alone cannot give. The veto only
  *defers* — the arm stands and the ticker retries — and yields entirely past
  `NOTIFY_MAX_DEFER`, so a forever-repainting TUI makes a notification late, never lost.
  A session whose pty output was never observed is never vetoed. _Avoid_: pty gate,
  output debounce.
- **Task progress** — how far a Session's [Task] list has got: done and total ("3/7"), the
  current item (the in-progress task's active form, else the next pending task) and whether
  every task is done. One derivation (`taskProgress`) that the sidebar row, the [Task strip]
  and the menu bar share. Shown only while the list is open. _Avoid_: todo count.
- **Task strip** — the one-line [Task progress] bar pinned between the session header and
  the terminal: count, a thin bar and the current item, unfolding to the whole list. Gone
  while there is no list and once every task is done. _Avoid_: todo bar, checklist header.
