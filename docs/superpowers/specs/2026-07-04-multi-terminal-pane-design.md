# Multi-terminal pane (Project terminals) — design

**Date:** 2026-07-04
**Status:** Implemented on `feat/ui-refresh`
**Branch target:** `feat/ui-refresh` (or a dedicated `feat/project-terminals`)

## Revision (2026-07-04, post-implementation feedback)

Three changes from the original design, made after live QA:

1. **No top-level Terminals view.** The separate `"terminals"` view in the switcher was
   dropped. There is one host — the bottom **Terminal dock** — reached only from the
   title-bar `>_` icon (with a live pane-count chip).
2. **Full-height toggle instead of a second host.** The dock has a maximize control that
   fills the working column (the Claude content + composer collapse). The **sidebar and
   inspector stay visible** — they live outside the center column. `layout.terminalDockFullHeight`.
3. **⌘/Ctrl+D splits the active pane** (Warp-style). Opt-in per terminal via an `onSplitChord`
   prop on the shared `Terminal`, so only Project terminals intercept it — the Claude
   terminal, and Ctrl+D/EOF everywhere, are untouched.

The terminal UI was also aligned to the shell's design system (Segmented-style tabs,
hover-revealed close via the existing `kr-reveal` convention, consistent icon buttons, a
crisp SVG split icon, and a restrained accent count chip).

### Running-process awareness (2026-07-05)

4. **Busy detection — daemon foreground process group (rock-solid).** The PTY daemon polls the
   tty's foreground process group (`tcgetpgrp(master)` via portable-pty's `process_group_leader()`)
   every 250 ms: an interactive shell claims the terminal at its prompt, and job control moves each
   foreground command into its own group, so `foreground != shell_pid` ⟺ a command is running.
   This is a **kernel/tty fact, shell-agnostic** (zsh, bash, fish) and **survives webview reloads**
   because the daemon — not the webview — owns the master fd. The daemon pushes a new `Frame::Busy`
   on change and replays the current state on attach (so a reattached client learns it at once).
   `DaemonClient` forwards it via an `on_busy` channel; `sessionHost` routes it (through a
   registered handler, avoiding an import cycle) to `useTerminals.setPaneBusy`, which is guarded to
   ignore ids that aren't real panes (Claude sessions are always "busy" while claude runs).
   `busyPanes` is ephemeral (not persisted). **Replaced the earlier OSC-133 approach**, which was
   zsh-only and reset on reload.
5. **Warn before closing** a tab/pane with a running process — a modal confirm
   (`TerminalCloseConfirm`, on the shared `Overlay`) with a destructive "Close & stop".
6. **Live title-bar indicator** — the `>_` mark and count chip take an accent pulse
   (`kr-term-pulse`, reduced-motion-safe) whenever any Project terminal is busy.

**Wire/protocol note:** `Frame::Busy(bool)` (tag 5) is daemon → app only; the decoder already
skips unknown tags, so an old app + new daemon (or vice versa) degrades instead of breaking.
The sidecar binary must be rebuilt (`node scripts/sidecar-ptyd.mjs`) for the change to reach the
real app — the Tauri backend must be restarted, not just hot-reloaded.

## Goal

Let a user run multiple ordinary shell terminals per Project — dev servers, build
commands, log tailing — alongside the Claude view. Terminals live in **tabs**, and a
tab can be **split** into side-by-side (or stacked) panes. Available in two places the
user toggles between: a bottom **dock** under the Claude view, and a full-height
**view**. A small indicator shows when terminals are running.

Non-goal today (YAGNI): recursive/nested split trees, terminal sharing across projects,
persisting *live processes* across app quit, per-pane shell selection UI, search/scrollback
UX beyond xterm defaults, drag-to-reorder tabs.

## New terminology (must be added to `CONTEXT.md` before these become type/module names)

- **Project terminal** — a shell the user runs inside a [Project (Workspace)] that does
  **not** host a Claude [Session]: no transcript, no [Status], no sidebar entry. It reuses
  the [Session]'s PTY plumbing ([PTY daemon], [Session socket], [Daemon client]) but is a
  plain login shell. _Avoid_: "task terminal" (collides with [Task]), "utility session".
- **Terminal tab** — a named group of one or more [Terminal pane]s within one Project.
- **Terminal pane** — one [Project terminal] in a split. Each pane is backed by its own
  [PTY daemon], keyed by a fresh Kriyon UUID (same key type as a [Session] id).
- **Terminal workspace** — the shared React component + store that renders tabs and panes;
  mounted in both the [Terminal dock] and the [Terminal view].
- **Terminal dock** — the resizable bottom-panel host in the workspace center column.
- **Terminal view** — the full-height top-level view host, in the view switcher.

## Key decisions (settled with the user)

1. **Scope: per Project.** Terminals group under the active [Project (Workspace)]; default
   cwd is the project root/worktree; shared across all Claude Sessions in that project.
2. **Lifecycle: reattach-on-reload, die-on-quit.** Panes survive a webview reload by
   reattaching to their running [PTY daemon] (the existing crash-survival path). On real app
   quit, each Project-terminal daemon is explicitly closed so dev servers stop cleanly. This
   is a deliberate difference from Claude [Session]s, whose daemons intentionally *survive*
   quit for crash-recovery. **Mechanism:** the frontend listens to Tauri's window
   `onCloseRequested` (fires on real quit, **not** on webview reload — that's what
   distinguishes the two) and calls `close_session` for every Project-terminal pane before
   the window closes. Keeps the backend unchanged; the frontend already knows which ids are
   Project terminals (they live in `useTerminals`). See Risks for macOS close-vs-quit
   semantics to verify.
3. **Two hosts, one core.** Dock and view render the same `TerminalWorkspace` off one store.
4. **Split-pane resizing: `react-resizable-panels`.** Small, maintained, React 19-compatible.
5. **Split model: flat 1D splits per tab** (a row *or* column of 2–4 panes), not recursive.

## Architecture

### Backend — no changes required

A [Terminal pane] reuses the existing generic PTY stack verbatim:

- `create_session(id, cwd, on_output)` — mints/reattaches a [PTY daemon]. Already generic:
  it spawns `$SHELL` in `cwd` with a private `ZDOTDIR` that **sources the user's real
  `.zshrc`** (so `nvm`, `PATH`, aliases work in a dev server), and sets `KRIYON_SESSION`
  (harmless — the Claude Code hook it gates never fires because we never run `claude`).
- `write_stdin`, `resize_pty`, `report_drained`, `close_session` — reused as-is.

The only difference from a Claude [Session] is what the **frontend does not do**: it never
calls `launchClaudeOnce` and never calls `watch_transcript`. So a pane gets a plain shell.

`AppState.sessions` (the app-side live-daemon registry keyed by id) will also hold
Project-terminal daemons. That map is really "connected PTY daemons," not "Claude sessions,"
so this is correct reuse; `close_session` already cleans an entry up.

> Verified against `src-tauri/src/commands.rs:129–234` and
> `crates/kriyon-core/src/shellinit.rs`.

### Frontend — the new surface

```
useTerminals (new store, src/state/terminals.ts)
  terminalsByProject: Record<projectId, ProjectTerminalState>
  ProjectTerminalState = { tabs: TerminalTab[]; activeTabId: string }
  TerminalTab  = { id; title; panes: TerminalPane[]; activePaneId; direction: "row"|"column" }
  TerminalPane = { id: string /* PTY UUID */; cwd: string }

  actions: openTab, closeTab, renameTab, setActiveTab,
           splitPane(tabId, direction), closePane, setActivePane,
           setDirection, hasLiveTerminals(projectId) -> boolean
```

- **`TerminalWorkspace`** (`src/terminal/TerminalWorkspace.tsx`) — reads the active Project's
  `ProjectTerminalState`; renders a **tab strip** (add `+`, close `×`, double-click rename,
  active highlight) and the active tab's **pane grid**.
- **`TabPaneGrid`** — wraps `react-resizable-panels` (`PanelGroup` + `Panel` +
  `PanelResizeHandle`, exact names pinned at implementation — see Risks) laying out the tab's
  panes in `direction`. Each `Panel` renders one `TerminalPaneView`.
- **`TerminalPaneView`** — thin wrapper that renders the existing `Terminal.tsx` for the
  pane's id + cwd, with a per-pane header (cwd label, split, close). It calls
  `ensureSession`/`attachTerminal` (existing `sessionHost.ts`) and **does not** call
  `launchClaudeOnce`.
- **Hosts:**
  - `TerminalDock` — a resizable bottom panel in `Shell.tsx`'s center column (`contentStyle`
    region), toggled by a control + `Ctrl+\`` (chord TBD), rendering `TerminalWorkspace`.
  - `TerminalView` — a new `layout.view` value (e.g. `"terminals"`) rendering the same
    `TerminalWorkspace` full-height, reachable from the view switcher in `Shell.tsx`.
- **Indicator** — a small "● N" badge showing the count of live panes **across all projects**
  (so you know something is running even while viewing a different project or the Claude view),
  shown in the TitleBar/view bar via a `useTerminals` count selector. Rendered once; both hosts
  read the same store.

### Reuse map (share, don't duplicate)

| Need | Reuse |
|---|---|
| xterm render + PTY wiring + resize/fit + teardown | `src/terminal/Terminal.tsx` (unchanged) |
| PTY session registry, buffering, attach/detach | `src/terminal/sessionHost.ts` (`ensureSession`, `attachTerminal`, `disposeSession`) |
| Spawn/reattach/kill a shell | `create_session` / `close_session` (unchanged) |
| Split resizing | `react-resizable-panels` |
| Toggle/collapse chrome patterns | follow `CollapsePanel` / `ResizeHandle` conventions for the dock |
| Layout persistence | existing `save_layout`/`load_layout` SQLite blob |

## Data flow

1. User opens the dock/view for the active Project → if no state, seed one tab with one pane
   whose `cwd` = project root and `id` = `crypto.randomUUID()`.
2. `TerminalPaneView` mounts `Terminal.tsx` → `ensureSession(id, cwd)` → `create_session`
   spawns/reattaches a [PTY daemon]; output streams via the existing `Channel` + `WriteQueue`.
3. User types commands (e.g. `pnpm dev`) → `onData` → `write_stdin`. No Claude involvement.
4. Split → `splitPane` adds a `TerminalPane` to the tab; `react-resizable-panels` re-lays out;
   the new pane mounts its own terminal/daemon.
5. Close pane/tab → `disposeSession(id)` (→ `close_session` kills that daemon) and prune state.

## Renderer / WebGL strategy

WKWebView caps WebGL contexts (~16). Only **visible** terminals need a live renderer:
- Hidden tabs render `display:none` and their panes release the WebGL renderer (extend the
  existing active-gating in `Terminal.tsx:278–334` from "the one active session terminal" to
  "terminals currently visible": panes of the active tab + the Claude Raw view).
- Realistic visible count = 1–4 dock panes + 1 Claude terminal ≪ 16, so the cap is not a
  practical limit. Guardrail: cap concurrent WebGL to N and fall back to the canvas/DOM
  renderer beyond it (only if measurements ever show a problem — otherwise YAGNI).

## Persistence

Persist **tab/pane structure** (ids, titles, cwds, direction, split ratios), not live
processes, into the existing layout blob keyed by project. On relaunch, tabs/panes are
restored and re-spawn **fresh** shells (die-on-quit). Split ratios persist via
`react-resizable-panels` `autoSaveId`/`onLayout` mirrored into our store so it round-trips
through our own persistence rather than `localStorage`.

## Testing (TDD — write failing tests first)

- **Store unit tests** (`terminals.test.ts`): openTab seeds one pane; splitPane adds a pane
  and preserves active; closePane prunes and reassigns active; closing the last pane closes
  the tab; renameTab; per-project isolation; `hasLiveTerminals` count.
- **Pane lifecycle** (extend `sessionHost.test.ts`): a Project terminal calls `ensureSession`
  but **never** `launchClaudeOnce`; `disposeSession` closes the daemon.
- **Component tests**: `TerminalWorkspace` renders tab strip + grid; add/close/split wire to
  store actions; indicator reflects live count.
- **Backend**: no new Rust logic → no new Rust tests; existing `create_session`/`close_session`
  tests cover the reused path. Add one assertion that a plain-shell spawn (no Claude) works if
  a gap exists.
- **Manual/browser QA**: dev-server survives a Vite reload (reattach); quit kills daemons;
  split + resize; WebGL context count stays sane with 4 panes open.

## Risks / open items

1. **`react-resizable-panels` API drift.** The library has multiple major APIs
   (`PanelGroup`/`PanelResizeHandle` vs newer `Group`/`Separator`). **Pin an exact version and
   verify component names against its docs at implementation time** before writing code.
2. **WebGL gating change** touches `Terminal.tsx`, currently tuned for one active terminal.
   Change must keep Claude Raw view crisp; regression-test the single-terminal path.
3. **`AppState.sessions` now mixes** Claude-session daemons and Project-terminal daemons.
   Confirm no code assumes every entry is a Claude Session (e.g. status/watcher lookups). It
   shouldn't — those are separate maps — but audit during implementation.
4. **cwd default** uses the project root; a project with worktrees may want a picker later
   (out of scope now — default to root).
5. **Chord for the dock toggle** (`Ctrl+\``?) must not collide with `reservedChords.ts`.
6. **macOS close-vs-quit semantics.** On macOS, closing the single window may hide rather than
   quit the app. Verify `onCloseRequested` fires on the intended "stop terminals" moment and
   that async `close_session` cleanup completes before the window closes (preventDefault →
   await closes → close). If the single-window app truly quits on window close, this is
   straightforward; confirm during implementation.

## File touch list

- New: `src/state/terminals.ts`, `src/terminal/TerminalWorkspace.tsx`,
  `src/terminal/TabPaneGrid.tsx`, `src/terminal/TerminalPaneView.tsx`,
  `src/layout/TerminalDock.tsx`, `src/layout/TerminalView.tsx` (+ tests).
- Edit: `src/layout/Shell.tsx` (host mounts + view switch + indicator),
  `src/state/layout.ts` (dock open/height, `"terminals"` view), `src/terminal/Terminal.tsx`
  (visible-gating for WebGL), `src/terminal/sessionHost.ts` (only if a generic
  `ensureSession`-without-Claude path needs to be made explicit), `CONTEXT.md` (new terms),
  `package.json` (add `react-resizable-panels`).
- Backend: none expected.
