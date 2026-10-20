# Session process lifecycle — end on intent, survive accidents

- **Status:** Accepted — implemented on `feat/session-process-lifecycle` (Phases 1–3). D3, D4, D8,
  D10 confirmed by the maintainer on 2026-09-20. See §10 for what changed while building it, and
  ADR 0022 for the decision record.
- **Register:** design spec + phased plan

## 1. Problem

Kriyon accumulates live `claude` trees and nothing reclaims them. The user-visible symptom is
RAM filling up over days. The belief going in was "closing a session doesn't kill `claude`".
That is only partly true; the real picture, verified against the code and a live probe of
`kriyon-ptyd`:

| Gesture | What happens today | Evidence |
|---|---|---|
| Close a session **opened this run** | `Shutdown` frame → daemon SIGHUPs the **shell pid only** → idle `claude` dies from the kernel's hangup. Anything in its own process group, backgrounded, or ignoring SIGHUP **survives, reparented to launchd**, and is untraceable afterwards. | `crates/kriyon-ptyd/src/pty.rs:172`, portable-pty `Child::kill`; probe: `nohup sleep` + `trap '' HUP` child both survived, daemon exited in 0.07 s |
| Close a session **never opened this run** | `close_session` returns `"session not found"` before any `Shutdown` is sent; the frontend swallows it; the row is deleted. Daemon + shell + `claude` run **forever, unreachable**. | `src-tauri/src/commands.rs:449`, `src/terminal/sessionHost.ts:485`; only active + warm panes ever call `create_session` (`src/App.tsx:90`) |
| Archive | Sets `archivedAt`. Daemon + `claude` keep running. | `src/state/sessions.ts:958` |
| Quit (⌘Q, tray, close button) | Project terminals are killed. **Session daemons deliberately survive.** Confirm only if a session is mid-turn. | `src/terminal/closeOnQuit.ts:94` |
| Relaunch | Only the active pane reattaches. Every other surviving daemon is **invisible** to the memory chip, the [Memory budget] warning, and auto-sleep — all three iterate `state.sessions`, i.e. attached sessions only. | `src-tauri/src/memory.rs:51`, `src-tauri/src/sleep_rt.rs:85` |
| Crash / force-quit | Daemons survive, reattach on relaunch. **This is the advertised feature and it works.** | FEATURES.md:130 |
| Daemon whose row is gone | Never reaped. No startup sweep exists. | — |

`crates/kriyon-core/src/proc.rs` already says it out loud: *"on a working machine dozens of
daemons are alive for sessions last touched days ago."* One live `claude` measured 527 MB RSS on
this machine (a single active session; RSS, not footprint). Ten forgotten sessions is on the
order of 5 GB.

So there are two distinct defects: **(a) leaks** — processes nobody can reach any more — and
**(b) policy** — quit keeping everything alive is the wrong default for a local app.

## 2. Research

Full agent reports are summarised here; links are the primary sources.

### 2.1 Terminals and IDEs — four patterns

1. **UI owns the PTY, kill on close** (Alacritty, Kitty, Ghostty, Terminal.app, Warp, Zed,
   JetBrains). Simple; a crash kills everything. SIGHUP-only is the norm and is exactly what
   leaks `claude` on tab close and quit. The usual fix captures the foreground process group,
   SIGTERMs, SIGKILLs after a grace period, and holds the app open through it.
2. **App-owned PTY daemon, reattach** (iTerm2, WezTerm mux, VS Code pty host). This is
   Kriyon's architecture. **iTerm2 is the direct precedent**: jobs run in server processes and
   survive crash, force-quit and upgrade — but **⌘Q kills them** (`killJobsInServersOnQuit =
   YES` by default); they are left running on quit *only* for a Sparkle update restart
   ([docs](https://iterm2.com/documentation-restoration.html),
   [source](https://github.com/gnachman/iTerm2/blob/master/sources/iTermController/iTermController.m)).
   It also ships an orphan-server adopter. VS Code kills PTYs orphaned in the pty host after a
   60 s reconnect grace
   ([source](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/terminal.ts)).
   Costs: orphan daemons need a reaper; UI↔daemon protocol skew after upgrades (WezTerm,
   tmux, zmx all bitten).
3. **Serialize and relaunch** (VS Code revive, Zellij, tmux-resurrect, Warp, JetBrains).
   Nothing is kept alive; state is rebuilt. Fits a CLI that has its own resume.
4. **Delegate to tmux/zellij/shpool.** External dependency, double emulation. Not for us.

Confirm prompts everywhere follow one rule: **ask only when something is actually running**
(Terminal.app, Kitty, Ghostty, WezTerm, Warp, VS Code `hasChildProcesses`).

### 2.2 Agent GUIs

- **Dominant convention:** process lifetime = tab/app lifetime. Close kills the whole tree,
  quit kills everything, continuity comes from persisted session ids + `claude --resume`.
  cmux ([session restore](https://cmux.com/blog/session-restore)), CCManager
  ([repo](https://github.com/kbwo/ccmanager)), Agentastic.
- **Persistent daemon across quit** is the minority, power-user position (one agent workspace
  argues "the default should be persistence, not cleanup", motivated by *updates*, not by quit)
  and it brings its own orphan, wedge and upgrade problems. Where a desktop agent app keeps a
  background process after the UI closes, users tend to report it as a bug.
- **The leak we have is common in this category.** Reports in several tools we looked at share
  one root cause — signal only the PTY root, and the agent tree reparents to PID 1 — with
  reported sizes from dozens of MCP processes (3.5 GB) to over a hundred orphans. The fix that
  works: **snapshot the tree, SIGTERM, SIGKILL after 2 s**.
- **Anthropic's own supervisor** (`claude --bg`, agent view) keeps sessions alive detached but
  **stops any that are idle and unattached for ~1 h** — "the conversation stays on disk" — and
  never interrupts a working session for an update
  ([docs](https://code.claude.com/docs/en/agent-view)). That is the lease in §5.7.

### 2.3 Three codebases read in depth

Source read at HEAD on 2026-09-20, not docs.

| | Who owns the terminals | Close a session | Quit | Crash / update | Cleanup of leftovers | Idle RAM |
|---|---|---|---|---|---|---|
| **Tool A** (a terminal app) | The app itself | SIGKILL to the shell pid only; no tree, no escalation. Orphaned `claude`/`node` processes are possible | Everything dies. Confirm only if something is running | Everything lost; layout and past output restored from SQLite, never processes. Keeping processes alive across restarts is considered not feasible; resuming agents is the open ask | None | None |
| **Tool B** (an agent multiplexer) | One background server per workspace | Good: every pid in the pane's session, HUP → TERM → KILL, 250 ms each. But lists pids once, and blocks the server ~570 ms | Agents keep running; stopping is a separate command | Server death kills all panes; next start re-types `claude --resume` into every pane at once | None | None. Users measure 650–930 MB per idle Claude pane and wrote their own reapers |
| **Tool C** (an agent workspace) | One shared background daemon | Thorough: whole tree + process groups + same-terminal stragglers, re-read each round, SIGKILL after 1 s, never its own ancestors. Records the intent to close *before* killing | **Kills nothing, by design.** Its quit option does not reach the current daemon; a real stop lives in Settings | Daemon survives; next launch adopts it; daemon upgrades itself by handing open terminals to a successor | Reaper every 5 min; a row-less session is killed only after two passes | None |

**Tool C is the useful lesson for our current design.** Its own root-cause document names
keep-alive-on-quit as a leak cause: a user hit the macOS 511-terminal ceiling with 16 sessions,
103 descendant processes, the largest tree at 5.4 GB; "nothing stops a daemon from living
forever". Its worst bugs all came from adoption and orphans: an update killed every shell
because a liveness probe timed out; a busy daemon was **orphaned forever when a fresh spawn
deleted its socket file**; a stale daemon kept a broken macOS security context so `gh` and TLS
failed. It already reversed one keep-alive decision because coupling "removes a class of wedged
adopted service bugs".

Kriyon has the socket bug latent today: `spawn_daemon` deletes the socket file unconditionally
(`src-tauri/src/commands.rs:65`) and the new daemon deletes it again
(`crates/kriyon-ptyd/src/server.rs:127`). One failed connect to a live daemon orphans it for
good. Fixed in §5.2.

Where Kriyon's design already differs from all three: a small daemon **per session** (no
shared daemon to wedge, no hand-over machinery needed), lazy resume on first view (resuming
everything at once brings all the RAM straight back), and idle sleep — a feature users of all
three ask for.

### 2.4 What users actually ask for

Consistent across every tracker checked:

1. Closing a session frees its RAM **now**.
2. ⌘Q leaves **zero** `claude`/node/MCP processes behind.
3. Relaunch restores the tabs and resumes the conversations.
4. An update or crash never silently destroys a working agent (one report describes a silent
   desktop update stopping 9 running sessions, twice).

We found no requests for local agents to survive a *deliberate* quit. Keep-alive requests are
about updates and crashes.
Memory-constrained users additionally ask for idle hibernation — which Kriyon already has
([Sleeping session]).

### 2.5 Claude CLI facts the design leans on

- The transcript is append-only and written incrementally; a hard-killed session resumes with
  `claude --resume <id>` on the **same** id and file. An in-flight tool call is dropped, not
  re-run ([sessions docs](https://code.claude.com/docs/en/sessions.md)). Kriyon's Sleep
  feature already depends on this in production (SIGTERM the `claude` pid, later type
  `--resume`).
- `claude` has repeatedly failed to die on hangup: changelog fixes in 2.1.19 and 2.1.46,
  reported again on 2.1.111/2.1.121 as PPID=1 orphans at 100 % CPU
  ([#56914](https://github.com/anthropics/claude-code/issues/56914)). Our probe saw an idle
  `claude` exit on hangup, but **the design must not depend on it**: escalate.
- Unsent text in `claude`'s own input box is lost on any kill. (Kriyon's composer draft and
  the close confirm from 825c57e already cover the Kriyon side.)

## 3. Decisions

The rule: **intent decides.** A deliberate gesture ends processes. An accident leaves them
running to be reattached. The conversation survives either way, so the only thing a kill ever
costs is an in-flight turn — and that is the one case we ask about.

| # | Decision | Choice |
|---|---|---|
| D1 | Close session | Stop the **whole tree**, reliably, whether or not the session was opened this run. UX unchanged. |
| D2 | Archive | Stops the tree too. Row, transcript, worktree untouched; opening it again resumes. |
| D3 | Quit (deliberate) | **Stops every session.** Next launch resumes lazily via `claude --resume` on first view (path already exists). The iTerm2 default. |
| D4 | Quit while a session is mid-turn | Existing confirm gains a third choice: **Let them finish** — working sessions are left to their daemons, idle ones stop. Leak-free because of D7. |
| D5 | Crash, force-quit, update restart, webview reload | **Handover:** daemons survive, reattach on launch. Unchanged, and now the contract the auto-update spec builds on. |
| D6 | Launch | **Adopt** every owned live daemon (so memory, budget, auto-sleep and close see it), then **reap** every daemon no row owns. |
| D7 | Abandoned daemons | **Detached lease:** no client *and* no PTY output for 30 min → the daemon stops its own tree. Covers "let them finish", a crash never followed by a relaunch, and uninstall. |
| D8 | No global "keep sessions running after quit" preference | YAGNI. D4 covers the real need per quit; a setting can come later if asked for. |
| D10 | Background commands a session started (dev servers, watchers) | They stop with the session — **after a warning that names them.** Close, archive, quit and *Stop all* ask first whenever something is actually running; a quiet session still closes with no dialog. No "close but keep it running" option: that is how orphans are made. To keep a dev server, keep the session. |
| D9 | A real "stop everything" | **Stop all sessions** in ⌘K and the tray — the same code path as quit, without quitting. In one tool we looked at, users had no working way to do this; its quit option never reached the daemon. |

Rejected: **keep-alive as the default** (what we have) — invisible 500 MB processes after ⌘Q
is the behaviour users of the tools we looked at report as a bug. **Kill everything always,
including on crash** — throws away the daemon architecture's one real advantage and makes
auto-update destructive. **Hide-to-menu-bar instead of quitting** — honest, but a bigger
product change than this problem needs; revisit separately.

## 4. Vocabulary (add to CONTEXT.md before any identifier uses it)

- **Tree stop** — ending a [PTY daemon]'s entire descendant tree: snapshot the descendants
  *before* signalling (ancestry is lost once a parent dies), ask politely, wait a bounded
  grace, SIGKILL whatever is left, then exit. The only way a daemon ever exits. _Avoid_: kill,
  teardown (that is the app-side bookkeeping).
- **Handover** — an app exit that leaves [Session] daemons running on purpose so the next
  launch reattaches: crash, force-quit, update restart, webview reload. The opposite of a
  deliberate quit. _Avoid_: detach (that is one client leaving).
- **Daemon adoption** — at launch, connecting a sink-less [Daemon client] to every live daemon
  a store row owns, so an unopened session is still a first-class live session to the
  [Footprint sweep], the [Sleep ledger] and `close_session`. Replaced by the real client when
  its pane first mounts.
- **Orphan daemon** — a `kriyon-ptyd` whose socket is in Kriyon's run dir but whose id no
  session row or [Terminal pane] owns (or whose row is archived). Reaped at launch.
- **Detached lease** — how long a daemon with no client tolerates a silent PTY before it
  [Tree stop]s itself. Output or an attach renews it.

## 5. Design

### 5.1 Tree stop — in the daemon

The daemon is the root of the tree, is alive at the moment it matters, and outlives the app —
so it owns the stop. The app fires `Shutdown` and never waits; **quit stays instant** while each
daemon finishes its own escalation.

1. Snapshot: one process-table sweep → the **union** of (a) every transitive child of the
   daemon's pid and (b) every pid whose session id (`getsid`) is the shell's. The walk is the
   existing pure `ProcessTree` logic in `kriyon-core::proc` (add `descendants_of(pid)`; today's
   `tree_pids` is keyed by session id). The two halves cover each other's blind spot: (a)
   catches a child that called `setsid()` (it keeps its `ppid` — a failure mode seen in other agent GUIs);
   (b) catches one already reparented to launchd but still in the shell's session — Tool B's
   approach. Add (c) anything else still holding the session's terminal — Tool C catches
   same-tty stragglers this way. Only a process that left the
   tree, the session *and* the terminal — a true daemonising double-fork — escapes, and it
   asked to; leave it.
2. Polite: SIGTERM every descendant except the shell (lets `claude` run SessionEnd hooks and
   stop its own MCP servers and bash children), SIGHUP the shell (interactive zsh ignores
   SIGTERM).
3. Grace: poll up to **2 s**.
4. Force: re-sweep; SIGKILL every snapshotted pid still alive whose identity still matches
   (PID-reuse guard: command line, or `pbi_start_tvsec` via `libproc`, already a `src-tauri`
   dependency), plus any new descendant.
5. Remove the socket, exit.

Applied on **every** daemon exit path — `Shutdown`, the lease, and the existing child-exit
reaper — so a daemon never exits leaving descendants.

**Signal-target guard (hard rule).** A stale pid that reaches `kill(-pgid, SIGKILL)` can kill
dozens of unrelated macOS processes; one terminal app hit exactly this, and its fix refuses any
target below 2 and checks identity first. Every signal Kriyon sends — tree stop, reaper, Sleep —
goes through one pure, unit-tested gate in `kriyon-core`: reject pid ≤ 1 (`0` is our own
group, `-1` is every process we own), reject our own pid and the app's, and require the pid to
come from the sweep just taken with a matching identity. Never a pid read from disk.

Two rules learned from the research:

- **Re-enumerate before each escalation step.** A single snapshot misses anything forked during
  the grace period, so it is never signalled. Step 4's re-sweep is not optional.
- **A stop is never a close.** A process dying — at quit, at reboot, from a signal — must never
  change persisted state. Reading "every pane died" at reboot as "the user closed everything"
  would wipe the saved sessions. In Kriyon only the explicit
  close gesture deletes a row; a stop leaves the row, the [Claude session id] and the
  worktree exactly as they were.

`ps` is invoked from `kriyon-ptyd` itself (the pure parse/walk stays in `kriyon-core`; the
existing invocation lives in `src-tauri` and the daemon cannot depend on it).

### 5.2 `close_session` works unattached

If the id is not in `state.sessions`: validate it, connect to its socket, send `Shutdown`.
Bookkeeping (watcher, runtime, sleep mark, footprint) is cleared first either way, as today.
With §5.4 this path is a fallback, but it is the fix for the permanent-orphan bug and must not
depend on adoption having succeeded.

**Never orphan a live daemon on spawn.** Before `spawn_daemon` deletes a socket file, check the
process table for a live `kriyon-ptyd --id <id>`. If one exists the connect failure was
transient: retry the connect; if it still fails, tree-stop that daemon by pid and only then
spawn. The daemon's own unconditional `remove_file` on start goes too — it binds only to a
path that is absent or provably dead. Tool C met the same bug; it is present in Kriyon today.

### 5.3 Quit is owned by Rust, at one choke point

Process control belongs to Rust (architecture rule), and the frontend only knows about mounted
hosts — which is how today's gate misses sessions. The choke point is **`RunEvent::Exit`**: on
macOS it is the one event every orderly exit reaches. ⌘Q, menu Quit and Dock ▸ Quit all send
`terminate:`, tao implements only `applicationWillTerminate:`, so `ExitRequested` never fires
for them and the quit cannot be cancelled there
([tauri#9198](https://github.com/tauri-apps/tauri/issues/9198), open) — but `Exit` does. A
crash or SIGKILL reaches nothing, which is exactly the handover we want. Managed-state `Drop`
does not run on exit ([tauri#14420](https://github.com/tauri-apps/tauri/issues/14420)), so it
cannot be the mechanism.

`lib.rs` moves from `.run(context)` to `.build(context)?.run(|app, event| …)`. The handler reads
a `QuitIntent` from `AppState`:

- `StopAll` — **the default when nothing set an intent** (so Dock ▸ Quit stops sessions too,
  just without the confirm). `Shutdown` to every entry in `state.sessions`, plus any owned live
  socket that was not adopted.
- `LetWorkingFinish` — same, but skip sessions whose [Session runtime] status is `Running`.
  Project terminals always stop (unchanged).
- `Handover` — send nothing. Set by the future update restart (§5.9), which must use
  `request_restart()`: `restart()` on the main thread skips both exit events.

**Never ask on a system-initiated exit.** Logout, shutdown and OS updates must not meet a
dialog: a hidden quit dialog can hang the app and abort a macOS update. Kriyon gets this for free —
the confirm lives on the window-close gate, which `terminate:` bypasses — and it must stay
that way: no dialog, and no blocking work, ever moves into `RunEvent::Exit`.

The handler only *writes frames* — milliseconds — and never waits; the daemons finish their own
escalation after the app is gone. `quit_app(mode)` sets the intent and calls `app.exit(0)`.

The frontend gate (`closeOnQuit.ts`) keeps deciding *whether to ask*; `closeAllProjectTerminals`
folds into the Rust path. Dialog when sessions are working: **Cancel · Let them finish · Stop
and quit**. Default button is *Let them finish*: the dialog only appears when there is
in-flight work, and destroying it should be the explicit choice. Copy names the count and says
finished sessions stop on their own.

### 5.3a Warn before stopping running work (D10)

Every terminal that gets this right follows one rule — **ask only when something is actually
running, and say what** (Terminal.app "processes other than the login shell", Kitty, Ghostty,
WezTerm, VS Code `hasChildProcesses`, Warp's "Show running processes"). User reports point the
same way from both sides: they want leftovers gone (dev servers "running for days… holding
ports"), and they want not to be surprised (work destroyed "with no warning, no consent").

Kriyon already has every input; this is wiring, not new tracking:

- The close confirm exists (`src/sidebar/sessionClose.ts`, `unsentWorkFor`: unsent composer
  draft, unsaved editor changes). It gains two signals: **Claude is mid-task**, and **running
  [Background shell]s** — already tracked per session with their command lines (ADR 0002,
  `BackgroundShell` in `src/types.ts`) and already what stops Sleep from sleeping a session
  (`has_running_shells`).
- One pure helper answers "what would stopping this session destroy?" and the close confirm,
  the archive action, the quit gate and *Stop all sessions* all read it, so they can never
  disagree.
- The dialog names things: *"Closing stops 2 running commands: `pnpm dev`, `cargo watch`."*
  Buttons: **Cancel · Stop and close**. Quit keeps its three buttons; *Let them finish*
  applies to Claude mid-task only — a dev server never "finishes", so at quit it is named in
  the warning and then stopped.
- Project terminals: today's confirm sees only the foreground command. Add background jobs
  the simple way — the shell has any child process — which is exactly Terminal.app's rule and
  has no false positives there (no `claude`, no MCP servers).

Background-shell tracking is best-effort (ADR 0002), so the warning can miss one. That is
acceptable: the tree stop is what guarantees nothing is left behind; the warning is a
courtesy, not the safety mechanism.

### 5.4 Adoption at launch

In Rust `setup`, after the store opens: owned ids = session rows ∪ pane ids parsed from the
`terminals` KV blob. For each with a connectable socket, insert a `DaemonClient` with a
discarding sink (output is dropped — the daemon's emulator keeps the snapshot current — and
drained immediately so backpressure never parks it). `create_session` already replaces a live
id's client and the daemon already repaints the newcomer, so first view needs no new path.

Result: the memory chip, tray total, [Memory budget] and auto-sleep become truthful for
sessions the user has not clicked yet, with no change to those subsystems.

### 5.5 Orphan reaper at launch

Same `setup` step, before adoption. One process-table sweep → rows that are `kriyon-ptyd` with
`--socket` **inside Kriyon's run dir** (never a test or foreign daemon) → parse `--id`.
Not owned, or owned by an archived row → `Shutdown` over the socket; if the socket is dead,
app-side TERM→KILL of that daemon's tree. Then delete stale `.sock` and `.prompt` files.

**Fails closed:** if the store read or the terminals blob fails to parse, reap nothing. The
owned set is derived in Rust from the store, never supplied by the frontend — a failed
hydration yields an empty frontend store and would otherwise reap every live session.

**A failed probe never kills an owned daemon.** If a liveness probe times out after an
update, treating the daemon as dead would kill every shell. An owned daemon that cannot be reached is left
alone and retried; only a daemon **no row owns** is ever reaped.

**It keeps running, on the existing ticker.** A close whose `Shutdown` never arrived must not
wait for the next launch — some users keep the app open for weeks. The memory sampler already
sweeps the process table; the same pass checks for orphan daemons. Two guards, both borrowed
from Tool C's reaper: an orphan is reaped only after **two consecutive passes**, and only if the
daemon is older than a minute — a brand-new session's daemon exists before its row is
persisted. The launch pass needs neither guard: nothing can have been created yet.

This also clears the orphan daemons existing users have already accumulated. `claude`
processes that *already* reparented to launchd from past closes cannot be attributed to
Kriyon and are out of scope (§8).

### 5.6 Archive

`archiveSession` disposes the session's daemon (tree stop) before setting the flag. Unarchive
or open → fresh daemon + `claude --resume`.

### 5.7 Detached lease

The daemon tracks `last_output` and whether a client is attached. No client and no output for
**30 min** → tree stop. A working `claude` repaints its spinner/timer continuously, so it is
never silent; a finished or blocked one is. A session blocked on a permission prompt with no
app running cannot be answered anyway; after resume Claude continues without the dropped call.
While the app runs, adoption keeps every owned daemon attached, so the lease only ever runs
with no app alive. Constant, not a setting.

### 5.8 Protocol compatibility

New app ↔ old daemon is now routine (handover across an update). `FrameDecoder` already skips
unknown tags. Rule recorded in the ADR: frames are append-only, never renumbered or
re-shaped. Daemons spawned by a pre-upgrade build keep the old SIGHUP-only `Shutdown` until
they next exit — at worst one more quit cycle. No version handshake yet (YAGNI until a frame
needs one).

### 5.9 Docs

- **ADR 0022** — "Session processes end on intent, survive accidents": reverses "Session
  daemons deliberately survive quit", cites iTerm2 and the Anthropic supervisor, records the
  append-only frame rule.
- FEATURES.md: rewrite the quit bullet (l.215), add "closing, archiving or quitting frees
  everything the session started"; keep "survive app crashes" (l.130).
- CONTEXT.md: §4 terms; amend [PTY daemon] and [Project terminal] entries.
- Release-cycle spec Phase 3: update restart = handover (skip `StopAll`, keep the mid-turn
  confirm out of the way — the session is not interrupted).

## 6. Plan

Four phases, each shippable alone, each `pnpm check` green, TDD throughout. On `dev`, typed
branches.

**Phase 1 — stop the leaks** (`fix/session-tree-stop`). No product behaviour changes; pure
defect fixes.
1. `kriyon-core::proc`: `descendants_of`, a pure `stop_plan` (who gets TERM, who gets HUP, who
   is force-killable after a re-sweep incl. the PID-reuse guard). Unit tests on fixture tables:
   setsid child, nohup background job, reparented survivor, reused pid, ppid cycle.
2. `kriyon-ptyd`: tree stop on all three exit paths. Integration test modelled on the probe —
   shell + `trap '' HUP` child + `nohup` background job → `Shutdown` → **zero survivors**,
   daemon gone ≤ 3 s.
3. The signal-target guard in `kriyon-core`, and route Sleep's existing `terminate` through it.
   Unit tests: pid 0, 1, -1, own pid, app pid, a pid absent from the sweep, a reused pid — all
   refused.
4. `close_session` unattached fallback. Test: spawn daemon, never `create_session`, close →
   daemon exits.
5. Never orphan a live daemon on spawn: process-table check before any socket unlink, in both
   `spawn_daemon` and the daemon's bind. Test: live daemon + failed connect → no second daemon,
   the first is still reachable.
6. Reaper + adoption in `setup`, then the reaper on the ticker. Pure: owned-set derivation,
   run-dir containment, fail-closed on a bad blob, the two-pass + age rule. Integration: orphan
   daemon reaped, owned daemon adopted and visible to the footprint sweep, unreachable owned
   daemon left alone, foreign-socket daemon untouched, minute-old row-less daemon spared.
7. Crash the app with a live session, relaunch, and check the survivor can still reach a local
   dev server and a TCC-protected folder (§9).

**Phase 2 — intent semantics** (`feat/quit-stops-sessions`).
8. Verify resume first, since it becomes the main road: the persisted [Claude session id] is
   still right after `/clear`, `/resume` and a compaction, and a mid-turn kill resumes cleanly
   (§9). Fix what that finds before changing quit.
9. `QuitIntent` + the `RunEvent::Exit` handler (`.build()?.run(…)`); `quit_app(mode)`; fold
   project-terminal teardown in. Test the intent → frames matrix under the mock runtime.
10. The "what would stopping destroy?" helper (D10): extend `unsentWorkFor` with Claude
    mid-task and running [Background shell]s; the close confirm names the commands. Project
    terminals count background jobs. Pure, table-tested.
10a. Quit dialog third option + copy, reading the same helper; `quitConfirmTarget` matrix
    tests extended.
11. **Stop all sessions** in ⌘K and the tray (D9) — the `StopAll` path without the exit.
12. Archive disposes the daemon.
13. ADR 0022, FEATURES, CONTEXT.

**Phase 3 — lease** (`feat/daemon-detached-lease`).
14. Spike first: log an idle `claude`'s PTY output for 30 min (at prompt, at a permission
    prompt, during a long tool call) to confirm silence ⇔ not working. If idle `claude` turns
    out chatty, fall back to a plain detached TTL.
15. Pure lease clock in `kriyon-core`; daemon wiring; integration test with a short injected
    TTL.

**Phase 4 — with auto-update** (release-cycle Phase 3): restart-as-handover.

Phase 1 alone fixes the RAM growth for anyone who closes sessions. Phase 2 fixes it for
everyone else.

## 7. Error handling

- Tree stop is best-effort at every step and always terminates: a failed `ps` sweep degrades to
  today's behaviour (SIGHUP shell, SIGKILL after grace) rather than hanging the daemon.
- A vanished pid is success, never an error.
- Reaper and adoption never block launch; failures log and skip.
- `quit_app` never waits on a daemon; an unreachable socket is skipped.

## 8. Out of scope

- Reaping `claude` processes already orphaned to launchd by past versions — no safe way to
  attribute them to Kriyon. Possible later: a diagnostic that lists stray `claude` processes
  and lets the user decide.
- Hide-to-menu-bar / "keep running in background" as an app mode.
- A global keep-alive-on-quit preference (D8).
- Daemon↔app version handshake.
- Using Anthropic's `claude --bg` supervisor — Kriyon hosts the interactive TUI in a real
  terminal; different product.

## 9. Open risks

- **Lease heuristic.** Silence ⇔ idle is inferred, not documented. Phase 3 starts with the
  spike; the fallback is a fixed detached TTL.
- **SIGTERM during a write.** Sleep already SIGTERMs `claude` in production without transcript
  damage, but it only fires on quiescent sessions. Stop-on-quit can hit a mid-turn session
  when the user chooses *Stop and quit*. The transcript is append-only and the docs state a
  hard kill is resumable; verify with a mid-turn kill + resume before shipping Phase 2.
- **Logout / shutdown.** AppKit routes these through `applicationShouldTerminate:`, which tao
  does not implement; whether `RunEvent::Exit` still fires is unverified. Harmless either way —
  the OS kills every process at logout — but confirm so the handler is not assumed to run.
- **Why hangup alone is not enough (XNU).** Closing the PTY master SIGHUPs only the *session
  leader* (the shell); the foreground group is hung up only once the leader exits, and
  background groups never are. That is the mechanism behind the probe's survivors and why §5.1
  signals the snapshot directly rather than trusting the kernel.
- **Daemon detachment.** `spawn_daemon` uses `process_group(0)`, not `setsid`. Launched from a
  terminal (dev builds), the daemon keeps that terminal's session and is hung up with it. No
  effect on a Finder/launchd launch; worth a `setsid` in Phase 1 for dev parity.
- **Resume becomes the main road.** Today most sessions reattach to a live `claude`; after D3
  every session resumes at every launch. Keeping the *first* session id seen means that after
  `/clear`, `/resume` or a compaction, `--resume` points at the wrong conversation. Kriyon tracks the live id via
  the hook and the [Main session lock]; before Phase 2 ships, verify the persisted id is still
  right after each of those three, and that a missing transcript falls into the existing
  resume-failure recovery rather than a dead pane.
- **macOS permissions after a handover.** A detached server can lose "responsible process"
  attribution, so its children lose Local Network access and TCC consent. Kriyon's daemon is spawned by the
  signed app, which is a different starting point, but nobody has checked what a daemon
  *reparented to launchd after a crash* can still do. Test in Phase 1: crash the app, then have
  the surviving session hit a local dev server and a TCC-protected folder.
- **Killing background work the user wanted kept.** A background job started inside a session
  now dies with it. Mitigated by D10's warning, but the warning is best-effort and can miss a
  job Kriyon never saw start. Still a behaviour change — call it out in the changelog.
- **Adoption cost.** One socket + one thread per live daemon at launch. With D3 live daemons
  at launch become rare (only after a handover), so this is small; measure with 30 daemons.

## 10. As built — what changed from the plan

Recorded so the spec and the code agree.

- **The reaper had a gap that could stop another build's sessions; the fix is structural.** The smoke build
  (`KriyonSmoke`, its own bundle identifier) has its own database but shared
  `~/.claude/kriyon/run` with the released app. Its store owns none of the released app's
  sessions, so its launch-time reaper would have stopped every one of them — and vice versa.
  Each app identity now has its own [Run dir] (`run` for the released identifier, so an update
  still finds its predecessor's daemons; `run-<identifier>` for any other build). This was not in
  the plan. It is the strongest argument in this document for "derive ownership in Rust and fail
  closed": the safety rules caught nothing here, because the smoke store was perfectly readable.
  Isolation is what makes the rule safe.
- **The tree is rooted at the shell, not the daemon** (§5.1). "Everything this terminal hosts"
  is the precise meaning, and it keeps a daemon's own short-lived `ps` children out of the
  snapshot. Same-terminal stragglers (5.1c) were dropped as redundant: a process with the
  session's controlling terminal is by definition in the session (5.1b).
- **Kernel session membership comes from `getsid(pid)`**, not from `ps`: on macOS `ps -o sess`
  prints a pointer, not an id. It is trusted only while the shell's pid is provably still ours —
  absent from the sweep, or still our own child — so a reused pid can never lend us its session.
- **The daemon turns SIGTERM into a tree stop.** Not in the plan, and needed by it: the reaper's
  fallback for a daemon whose socket is dead was "signal it", and on the default disposition
  that closes the PTY master and orphans the tree — the very leak being fixed. It also makes a
  plain `kill <pid>` safe.
- **`close_session` no longer reports an unknown id as an error.** A session with no live daemon
  is already closed. An *invalid* id still is an error (trust boundary).
- **D9 became "Sleep idle sessions now"**, not "Stop all sessions". Stopping the session on
  screen would have needed a new "stopped" pane state and its own recovery UI; [Sleeping session]
  already has all of it (the moon, wake-on-focus, stuck handling). `AutoSleep::NOW` waives only
  the idle threshold — it goes through the same `should_sleep`, so a session mid-turn, on screen,
  or running a subagent or background command is still never touched. In ⌘K and the tray menu.
- **`LetWorkingFinish` spares an untracked session while `claude` holds its terminal.** Only
  mounted panes subscribe a [Session runtime], so a session adopted after a handover and never
  opened has no status. Treating "unknown" as "idle" would silently kill a turn; the lease
  bounds the cost of being generous.
- **Archiving hands off the selection and the warm mount.** An archived session could previously
  stay on screen. Once archiving stops the process, a pane still wired to the stopped host would
  sit dead and stay blank after an un-archive.
- **`setsid` for the daemon was not done** (§9, "Daemon detachment"). It only matters for a dev
  build launched from a terminal, and its interaction with macOS "responsible process"
  attribution is unverified. Left as is rather than changed blind.

### What an independent review of the branch found, and what was done

An independent read-only review of the finished branch found the issues below. All were confirmed and fixed.

- **HIGH — a second instance could kill the first one's sessions, later.** `pnpm tauri dev`
  shares the installed app's identifier, store and run dir. The dev instance adopted every live
  daemon (its connections queued behind the installed app's), and on quit wrote `Shutdown` into
  each queued connection. The daemon would read it the next time the installed app let go of
  that session — a reload, or the first time the user opened it. A regression: before this
  branch a quit sent nothing. Fixed two ways that cover each other: exactly one instance owns a
  run dir (`flock`), and only the owner reaps, adopts, or stops a daemon it does not hold; and
  any other instance sends `Shutdown` only on a connection the daemon has greeted
  (`may_stop_held`). Both have regression tests.
- **MEDIUM — reachable while dying.** The socket stayed connectable through a stop of up to
  ~3 s, so a quick relaunch (or archive-then-open) reattached to a dying daemon. The daemon now
  unlinks first, on all three exit paths; tested by asserting the socket is gone while the
  daemon is still mid-stop.
- **MEDIUM — adoption could overwrite a real client** (check and insert were not atomic). Now
  inserts only into a vacant slot, under one lock.
- **LOW, all fixed:** signals following a cached (≤2 s old) process table → always a fresh
  sweep; the shell pid rooted a stop without re-verification → `hosted_shell`; a failed
  re-survey could force from a stale list → force only from a sweep taken that instant; a failed
  first sweep signalled only SIGHUP → falls back to the old HUP-then-KILL of the shell; only
  SIGTERM was turned into a tree stop → also SIGINT, SIGQUIT, SIGHUP; no panic hook → a panic on
  any thread tree-stops; unbounded socket writes could hang the exit → 5 s write timeout, and a
  failed write severs the connection so a half-written frame is never followed by another;
  recovery slept inside an async command → `spawn_blocking`; a close during an in-flight create
  resurrected the session → `closed_mid_create`; `LetWorkingFinish` trusted a `running` status a
  killed `claude` had frozen → vetoed, but only on positive evidence the shell is at its prompt;
  tests waited on the daemon without a bound → `exits_within`.
- **Left as is, knowingly:** `spawn_daemon` still unlinks the socket path before spawning. It
  now runs only after `recover_unreachable_daemon` has established that no live daemon serves
  that id, the daemon itself refuses a live path, and the frontend never issues two concurrent
  creates for one id.

### After the first smoke run — the quit gate lost its third button

Smoke-testing the finished branch in the real app turned up two changes, both made on it.

- **`LetWorkingFinish` is gone** (D4, and the `LetWorkingFinish` notes above are superseded).
  The dialog's *Let them finish* read as "keep the app open until the work is done"; it quit
  immediately and left detached daemons the lease stopped up to 30 minutes later. The gate now
  offers *Cancel · Stop and quit* only. See the amendment in ADR 0022. `claude_in_foreground`,
  the frozen-`running` veto and `ConfirmDialog`'s `alternative` slot went with it.
- **A background shell's `Running` was never retracted.** Nothing in the hook stream closes a
  shell (ADR 0002), so every command a session ever backgrounded stayed `Running` for the life of
  the session — a second instance's quit gate named three `seq` loops SIGKILLed across two earlier
  restarts. The [Stop cost] named dead dev servers and `has_running_shells` vetoed auto-sleep
  permanently. `activity::ShellWatch` now re-derives each claim from a sweep of the session's
  process tree, and treats the first pass differently from the rest: everything present then was
  replayed from the events file when the watch was seeded, so whatever no process backs is
  retracted at once, while a claim that turns up later is newborn and gets one free sighting for
  its fork to land. That split is needed because the snapshot introducing a claim is emitted from
  its `PreToolUse`, before Claude Code has forked the command — retracting there buried a live dev
  server and the quit gate stopped it without asking, which is worse than the stale claim. An
  unreadable table retracts nothing and costs a newborn nothing.
- **A session still starting up is a [Stop cost].** No hook has fired yet, so its status is
  `idle` and `midTurn` is false; a quit closed the app with no dialog while the user watched
  Claude start. `StopCost` gained `starting`, read from the `bootPhase` the frontend already
  keeps. A turn itself was never the gap: `UserPromptSubmit` sets `running` and it stays through
  every tool call until `Stop`.

### What a second review of the branch found, and what was done

A code review at high effort plus an architecture pass over the finished branch.
All eight findings confirmed against the code; all fixed.

- **HIGH — the shell retraction stopped running the moment a session went quiet.**
  `ActivitySource::snapshot` emits only when the serialized projection changed, and
  the sweep ran *downstream* of that gate, in `watch_route`. Nothing in the hook
  stream closes a shell (ADR 0002), so a dev server dying on its own changes the
  projection not at all — which meant the retraction was the one signal the gate
  could never pass. A quiet session kept its claim `Running` for good: auto-sleep
  vetoed permanently, a dead command named in every dialog. `ShellWatch` now lives
  in `ActivitySource` and reconciles *before* the gate, on the pump's own cadence,
  throttled to one sweep per two seconds (the process table's cache window) and
  skipped entirely for a session with no claims. `AppState.shell_watches` is gone
  with it — the watch dies with its session.
- **MEDIUM — a create could unlink a live daemon's socket.** `recover_unreachable_daemon`
  returned "path is clear" when it had just proved a daemon was alive but this
  instance may not retire it (a dev build beside the installed app). `spawn_daemon`
  then unlinked the path and bound over it, stranding that daemon: unreachable,
  unreapable (its id is owned), still holding a `claude` tree. The rule ADR 0022
  already states now has a name and a test — `kriyon_core::daemon::may_bind_session_socket`
  — and recovery returns `Result`, so the create refuses instead.
- **MEDIUM — the closed-mid-create guard asked the wrong question.** It marked the
  id only when the close found no client, but [Daemon adoption] puts a sink-less
  client in `sessions` for every owned id at launch, so from then on the close
  always found one. A close landing during that session's create let the create
  register a client for a deleted row — a phantom entry that also keeps the id
  looking owned, so no orphan sweep ever reaches what sits under it. Now keyed on
  an explicit in-flight mark (an RAII guard), which also ends the map's other life
  as a leak: closing a never-opened row used to add an id nobody would read, one
  per close, for the life of the process. `forget_session` collects the close's
  in-memory teardown into one tested place.
- **MEDIUM — closing and sleeping blocked the main thread.** A synchronous Tauri
  command runs there, and `close_session` took the run-dir `flock`, connected to a
  socket and forked `ps`; `stop_held` can add 250 ms more. Both commands are async
  now with the blocking half on a worker, and the tray's "Sleep idle sessions now"
  runs off the menu thread.
- **LOW — a sleep signalled a pid from the cached table.** Up to two seconds old,
  so a `claude` that exited in that window could have its number reused, and the
  [Signal gate] rules out only pid ≤ 1 and ourselves. Deciding and signalling are
  now separate: the cheap gates still read the cached table (a decision, not a
  signal), and the pids are re-derived from a sweep taken at the moment of
  signalling.
- **LOW — a longer live command revived its dead prefix.** Matching was a plain
  substring test, so `pnpm dev --filter api` kept re-promoting a `pnpm dev` that had
  already exited — a corpse no pass could retract. One live process now backs at
  most one claim, the most specific one it matches.
- **LOW — the dialog shredded multi-line commands and duplicated React keys.** The
  session row's selector joined the command list on a newline (Claude Code
  backgrounds multi-line commands routinely) and `ConfirmDialog` keyed each row by
  its own text (two shells can run the same command). Fixed with an explicit
  `packCommands`/`unpackCommands` separator and positional keys.
- **Also removed:** `setStatus`, which had no production caller and was a second
  writer of `status` bypassing the `bootPhase`/`exited` reconciliation `applyStatus`
  does.

### The architecture pass, and what was done

Seven deepening opportunities; none contradicts an ADR. All seven taken.

1. **Per-session state is one module.** `AppState` keyed seven structures by session
   id, filled from four places and released by a hand-written checklist at the one
   close site. `session_registry` owns `ensure_runtime`, `with_runtime`, `forget` and
   the create/close race guards. The locks stay fine-grained on purpose — `AppState`
   forbids holding two at once, and the engine is `Arc`-wrapped so a socket write
   happens with all of them released — so this is a lifecycle module, not a
   gatekeeper.
2. **A session's death reaches the [Session runtime].** See the MEDIUM fix above; it
   was a live cross-surface disagreement, not just a shape problem.
3. **The retract seam moved into the watch.** Taken as the HIGH fix above.
4. **The cached sweep hands out an index.** `ProcessIndex` holds positions rather
   than references, so it outlives the borrow and is cached with the rows it
   describes; `ProcessSurvey` is the pair and `survey.tree()` binds them. Twelve
   callers stopped rebuilding it. `ProcessTree::new` is unchanged for anyone holding
   rows alone, which is every test fixture.
5. **One [Session engagement] behind `StopCost`'s two booleans.** `midTurn` read
   `status` and `starting` read `bootPhase`; nothing but one store action kept them
   apart, and when both read true the dialog counted one session twice.
   `hasTotalStopCost` gives the quit gate the predicate the close confirm already had.
6. **`SessionRuntime::observe`.** Six public methods existed so `status_rt` could run
   the arm/settle dance from outside, at six lock acquisitions per event per session.
   `observe` and `claim_settled` fold it; the six are now private, and the settle
   policy is tested whole in `kriyon-core`.
7. **A `Surveyor` seam for ptyd's `tree_stop`.** Its `run` held every ADR 0022
   invariant that matters and had no tests, because it called `ps`, `getsid` and
   `kill` directly. The seam moved up to "a survey"; nine tests now pin the
   invariants, and two deliberate regressions were confirmed to fail them.

### Spike result for the lease (§5.7, plan item 14)

An idle `claude` hosted under `kriyon-ptyd` printed **0 bytes across 80 seconds** after settling
(3.4 KB to boot). The idle half of "silence ⇔ not working" holds. The busy half — that a working
`claude` repaints continuously — was **not** measured: it needs a real prompt, which spends the
user's tokens. It rests on the TUI's spinner/timer and on cmux shipping the same heuristic. If a
long silent tool call ever proves it wrong, the failure is a session stopped 30 minutes after the
app went away, resumable with its conversation intact — not lost work while the app is open,
because an attached daemon never lapses.

### Still to verify by hand (needs the real app and a real account)

1. Mid-turn **Stop and quit**, relaunch, open the session: the conversation resumes cleanly.
2. ~~**Let them finish**~~ — removed; see "the quit gate lost its third button" above. The
   [Detached lease] still needs verifying for a handover nobody returns to.
3. `/clear`, `/resume` and a compaction each leave the persisted [Claude session id] pointing at
   the right conversation (by code reading it follows the live id via `WatchSignal::ClaudeId`).
4. After a crash (`kill -9` the app), a surviving session can still reach a local dev server and
   a TCC-protected folder.
5. Dock ▸ Quit stops every session (it skips the gate but reaches `RunEvent::Exit`).
6. With the installed app running and sessions open, run `pnpm tauri dev`, quit it, then reload
   the installed app and open each session: every one is still alive. (Covered by unit tests
   against a fake daemon; worth seeing once for real.)
