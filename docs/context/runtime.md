# App runtime, resources and usage

Boot, the per-session runtime, memory and process limits, usage numbers, stopping processes, and updates.

Part of the Kriyon glossary. The index and the naming rule are in [`CONTEXT.md`](../../CONTEXT.md).

- **Boot phase** (`BootPhase`) — where a [Session] is in launching `claude`: `idle | booting |
  resumeFailed | live`. Distinct from [Status] (which describes a *live* session's turn). One pure
  reducer (`nextBootPhase`) owns every transition, and the coordinator owns the single boot-overlay
  safety-net timer, cancelled on each transition — so no stale timer can clear a later boot, and the
  `booting`/`resumeFailed` flags no longer drift across files. `booting` drives the loading overlay;
  `resumeFailed` drives the [Session] recovery prompt after a `claude --resume` that never started.
  _Avoid_: boot state (collides with `SessionStatus`), booting flag.
- **Main session lock** (`MainSessionLock`) — the rule picking which [Claude session id] is a
  terminal's *main* interactive agent, since one events file accumulates events from many claude
  sessions (restarts, subagents, one-shot `claude -p`). Converges on the live session: re-locks
  when the current main ends, refuses to lock onto a one-shot (temp transcript), and trusts the
  [Status-line] id as authoritative. Shared by the [Status] tracker and `HookActivity` so they
  can't disagree. _Avoid_: main agent id, primary session.
- **Session runtime** (`SessionRuntime`) — the one home for a [Session]'s live runtime state:
  its [Status] tracker and the mirrored open [Pending ask], behind one interface
  (`needs_you()`, `status()`, `ask()`, `from_history()`). `needs_you()` = Waiting, an open
  [Pending ask], or finished-with-unseen-output (a live Done/Error that landed off-screen,
  cleared on focus or a new turn; never seeded from history). The menu-bar badge counts
  runtimes where `needs_you()` holds and shows still-running sessions separately (`2 ▸3`,
  see `tray_title`); the tray rows and the OS-notification dispatch read the same
  object, so no surface can join status and ask differently from another. The ask is still
  *computed* by the [Session activity projection] (single source); the runtime only holds
  the mirrored value. _Avoid_: session state (that's `SessionStatus`), tracker map.
- **Watch route** (`watch_route::route`) — the single consumer of a session watch's
  `WatchSignal`s, routing each variant to the [Session runtime] fold and the frontend
  events. A named module generic over the Tauri runtime so the routing table is unit-tested
  under the mock runtime, instead of living as an untestable closure inside a command.
  _Avoid_: signal handler, dispatcher.
- **Event subscription helper** (`onEvent`) — the frontend's one race-safe wrapper for
  backend event streams: `subscribe` resolves to its unlisten later, and if teardown ran
  first the unlisten fires on resolve. Main window and tray both use it; no other
  subscribe→unlisten wiring may exist. _Avoid_: listener installer (that's the per-store
  `install*Listeners` tables built on top of it).
- **Status-line** — Kriyon's wrapper around Claude's `statusLine` command. For a Kriyon [Session]
  it captures a live [Usage snapshot] and the main [Claude session id] (only the main interactive
  TUI renders a status line, so that id authoritatively anchors the [Main session lock]); for
  *every* `claude` it leaves a [Limit reading]. Then it renders the user's own status line
  unchanged.
- **Usage snapshot** (`UsageSnapshot`) — the live context-window reading captured by the
  [Status-line] wrapper, per [Session]: Claude's own `usedPercentage`, the window size, and the
  tokens in the window now. The only source of the context figure — without one, none is shown.
  Not a session total: Kriyon shows no session token total and no cost, because no documented
  source gives an exact one (ADR-0038).
- **Plan limits** (`PlanLimits`) — how much of the Claude plan's 5-hour and weekly windows the
  account has used, with each window's reset time, as Claude Code reports them (`rate_limits`).
  Account-wide, not per [Session]; merged from every [Limit reading]. Absent on an API-key login.
  One window's use and reset time is a `LimitWindow`.
- **Limit reading** — one `claude` session's latest `rate_limits`, written by the [Status-line]
  wrapper to `~/.claude/kriyon/limits/<claude-session-id>.json`, in or outside Kriyon. Only as
  fresh as that session's last reply, so the merge keeps the highest use within a window and the
  latest window across them; a reading whose windows have all reset is deleted. The app's
  `LimitsReader` caches the readings and does the merge on the background ticker.
- **Session footprint** — the physical memory (`ri_phys_footprint`, in MB) a [Session]'s whole
  process tree holds: its [PTY daemon] plus every descendant (shell, `claude`, MCP servers,
  spawned dev servers). Sampled by the backend ticker; shown as the sidebar row's memory chip
  and the tray total. Never RSS, which misreads under memory pressure.
- **Memory budget** (`MemoryBudget`) — the user's whole-app [Session footprint] ceiling (MB).
  Crossing it fires one cooldown-limited OS warning naming the top sessions. Also the scale the
  sidebar's per-session memory chip colours against, so the chip and the warning agree on
  what "a lot" means.
- **Session resources** (`SessionResources`) — what a [Session]'s processes cost right now: its
  [Session footprint] plus its CPU (percent of one core over the last sample interval, so it can
  exceed 100). CPU needs two samples, keyed by pid and process start time so a reused pid is never
  diffed against its predecessor; before the second sample it reads "—". One `proc_pid_rusage`
  call per pid gives both numbers. A session is charged its ppid tree plus processes that left it
  but still hold its terminal, plus daemonized processes that still carry its `KRIYON_SESSION` env
  (and the children of both); each pid is charged to one session only.
- **Resource sweep** (`ResourceSweep`) — one sampling pass's result: each [Session]'s
  [Session resources] plus the whole-app totals. The totals are part of the sweep, not re-summed
  per surface, so the sidebar chips, the tray readout and the [Memory budget] check can never
  disagree. _Avoid_: footprint sweep.
- **Process tree** (`ProcessTree`) — an indexed view over one `ps` sweep, and the one place
  that knows how a [Session] maps onto processes: which rows are its [PTY daemon]s, what holds
  its terminal foreground, which pid is its `claude`, and every pid it costs.
- **Sleeping session** — a [Session] whose `claude` process Kriyon stopped to reclaim its
  [Session footprint], while the daemon, shell, and sidebar row stay. Only quiescent sessions
  (idle at the shell prompt, no busy state, no live background shells) are ever slept; waking
  resumes via `claude --resume` with the same [Claude session id].
- **Sleep ledger** (`SleepLedger`) — where every [Session] sits in the [Sleeping session]
  lifecycle: `Awake` → `Stopping` (signalled, shell not yet seen back at its prompt) →
  `Asleep`, plus `Stuck` for one that could not be resumed within the retry window. One map
  behind one lock, so each transition is indivisible and closing a session forgets it whole.
- **Usage card** (`UsageCard`, `useUsageCards`) — Kriyon's own answer to `/usage` (and `/cost`)
  typed in the [Structured view]'s composer: the [Session]'s context window and the account's
  [Plan limits], live, shown in the conversation where it was asked and never sent to Claude. A limit
  at 80% or more is called out. One per session, until closed; "Claude's full panel" opens the CLI's
  own pane (ADR-0041). _Avoid_: usage popup, usage modal
- **Plan limits view** (`planLimitsView`, `usePlanLimitsView`) — the single resolved answer for the
  account's [Plan limits] that every surface reads: each reported window with its label, rounded
  percent, reset time and tone (amber from 80%, coral at 100%), and the one warning worth raising.
  The Inspector and the [Usage card] both read it, so they never word or colour a limit differently.
- **Session usage view** (`sessionUsageView`) — the single resolved answer for a [Session]'s usage
  that every surface reads: the context-percent and compact label, from the [Usage snapshot] only.
  The composer and the inspector both read it, so they can never show a different context-% for
  the same session.
- **Tree stop** (`tree_stop`) — ending everything a [PTY daemon] hosts: snapshot the [Stop
  target]s *before* signalling (ancestry is lost once a parent dies), ask politely (SIGHUP the
  shell, SIGTERM the rest), wait a bounded grace, re-sweep, SIGKILL whatever is still the same
  process, then exit. The only way a daemon ever exits — `Shutdown`, a lapsed [Detached lease], or
  its shell dying — so a daemon never leaves descendants behind. A stop is never a close: it
  changes no persisted state. _Avoid_: kill, teardown (that is the app-side bookkeeping).
- **Surveyor** (`Surveyor`) — the OS half of a [Tree stop], behind one interface: the sweep, the
  kernel-session membership `ps` cannot report, the signal, the reap and the clock. Everything
  above it — snapshot before signalling, bounded grace, re-survey, force only from a sweep taken
  this instant — is a state machine over survey results, and holds the invariants ADR 0022 states;
  the seam is what lets those be tested against synthetic rows rather than a live process table.
  Two adapters: the real one in the daemon, an in-memory one in tests. _Avoid_: process provider,
  ps wrapper.
- **Process survey** (`ProcessSurvey`) — one `ps` sweep together with the [`ProcessIndex`] built
  over it, cached and handed out as a pair. The index is the expensive half, so handing out rows
  alone left every caller rebuilding it; `survey.tree()` binds the two for a read. _Avoid_:
  process table (that is the raw rows), process list.
- **Stop target** (`StopTarget`) — one process a [Tree stop] must end: a pid plus the command line
  it had when snapshotted, so a later sweep can tell the same process from a reused pid. The set is
  the union of the daemon's transitive children and every process in the shell's kernel session —
  each covers the other's blind spot (a child that called `setsid()` keeps its parent; an orphan
  reparented to launchd keeps its session).
- **Signal gate** (`may_signal`) — the one pure check every signal Kriyon sends passes first:
  never pid ≤ 1 (`0` is our own group, `-1` every process we own), never a protected pid (ourselves,
  our ancestors, the app). _Avoid_: pid check.
- **Handover** — an app exit that leaves [Session] daemons running on purpose so the next launch
  reattaches: crash, force-quit, update restart, webview reload. The opposite of a deliberate
  quit, which [Tree stop]s every [Session]. _Avoid_: detach (that is one client leaving).
- **Quit intent** (`QuitIntent`) — what the app's exit should do to live [Session]s: `StopAll`
  (the default, the only one a quit gesture can ask for, and what an ungated Dock quit gets) or
  `Handover` (touch nothing — an update restart).
- **Daemon adoption** — at launch, connecting a sink-less [Daemon client] to every live [PTY
  daemon] a store row owns, so a [Session] nobody has opened yet is still live to the [Footprint
  sweep], the [Sleep ledger] and `close_session`. Replaced by the real client when its pane first
  mounts.
- **Orphan daemon** — a [PTY daemon] whose [Session socket] is in Kriyon's run dir but whose id no
  session row or [Terminal pane] owns, or whose row is an [Archived session]. Reaped at launch and
  on the ticker; an *owned* daemon that merely fails a probe is never reaped.
- **Detached lease** — how long a [PTY daemon] with no client tolerates a silent PTY before it
  [Tree stop]s itself. Output or an attach renews it. What bounds a [Handover] nobody returns to.
- **Stop cost** (`StopCost`) — what stopping a [Session] would destroy right now: its [Session
  engagement], running [Background shell]s (named), unsent work. The one answer the close confirm,
  the archive action, the quit gate and *Stop all sessions* all read, so they can never disagree.
- **SWR resource** (`SwrResource`) — the keyed stale-while-revalidate core both
  History-page discovery and repo-status fetching sit behind: a per-key value
  cache (the "stale" served synchronously via `peek`) plus a per-key monotonic
  seq-guard, so a slow early response can never overwrite a fresher one, with
  loading/failed transitions surfaced to the adapter and stale-on-error (a
  failed refetch keeps serving the last cached value; only a cold failure —
  nothing cached — is admitted). `clear` is the cache-clear / test seam.
  _Avoid_: cache, store, SWR hook.
- **AppKit exception guard** (`appkit_guard`) — the `@try`/`@catch` Kriyon puts back *under*
  tao's `sendEvent:` overrides. Those overrides are `extern "C"` Rust functions, and rustc plants
  an abort-on-unwind shim inside each such body, so an `NSException` raised anywhere below one
  kills the process instead of reaching AppKit's own handler — which is how a macOS 26 Campo
  (Writing Tools) assertion killed 0.9.0 (ADR-0025). Because the shim lives in tao's *own* frame,
  wrapping tao's method from outside does nothing; the guard re-points `NSApplication`'s and
  `NSWindow`'s own `sendEvent:` — the Objective-C methods tao supers into — at a trampoline that
  runs the original inside `objc2::exception::catch`. An AppKit bug then costs one dropped event,
  logged, rather than the app. macOS only; a no-op elsewhere. _Avoid_: crash handler (it catches
  nothing Rust raises), panic guard.
- **Update channel** — which builds an installed Kriyon updates to: `stable` (from `main`, the
  default), `beta` (from `dev`, run by hand) or `nightly` (from `dev`, every night it changed).
  A version names its channel: `x.y.z`, `x.y.z-beta.N`, `x.y.z-nightly.YYYYMMDD.N` (ADR 0045,
  ADR 0046). _Avoid_: track, ring.
- **Update feed** — one channel's `latest.json`: the newest version, its notes, and per platform
  the update file's URL and signature. Stable's is the latest GitHub release's; beta's and
  nightly's live on the fixed `feed-beta` and `feed-nightly` pre-releases. Checked by
  `scripts/publish.mjs check-feed` before it moves (ADR 0046). Not the [Diff feed]. _Avoid_:
  manifest, appcast.
- **Channel step-down** — installing an *older* build from a calmer [Update channel] the user moved
  to (nightly → beta, beta → stable), which plain "only newer" would never offer, since semver
  sorts `x.y.z-nightly.…` after `x.y.z-beta.…`. Offered while the running build is noisier than
  the chosen channel, after a clear prompt and a backup of the data folder's databases; once the
  calmer build runs, "only newer" holds again. More than one minor back it waits for the channel
  instead, since saved data only promises the previous minor (ADR 0047). _Avoid_: downgrade
  (too broad: the feed can never downgrade within a channel), rollback.
- **Skipped version** — the one version "Skip this version" hides from quiet update checks. "Check
  now" still shows it, and any newer version is offered as usual. Kept in Rust's `UpdatePrefs`.
- **Boot time** — how long one session took from Kriyon launching or resuming `claude` (the
  [Boot phase] entering `booting`) to the session going live (its `SessionStart` hook). Kept
  per session for this run only and shown in the Inspector as "Start time". A reading, not a
  record. _Avoid_: startup latency, TTFT.
- **Pty prewarm** — opening a session's pty and shell when the pointer rests on its sidebar row
  (150 ms) while its pane isn't mounted, so a click only has `claude` left to start. Never
  launches `claude` and never reports a failure; the activation that follows retries.
  _Avoid_: preload, warm start (a [Warm pane] is a different thing).
- **Limit pace** — a forecast of when one [Plan limits] window runs out if its use keeps
  rising at the rate of the last hour, shown only when that comes before the window resets
  ("Weekly limit runs out in about 9h at this rate"). Arithmetic on Claude's own figures, kept
  in memory from the readings Kriyon saw; never a token count. ADR-0050. _Avoid_: burn rate,
  usage forecast.
