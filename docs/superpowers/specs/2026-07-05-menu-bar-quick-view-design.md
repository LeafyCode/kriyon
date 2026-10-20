# Menu Bar Quick View — design spec

**Date:** 2026-07-05
**Branch:** `feat/ui-refresh`
**Design source:** design mockups (not in this repo), variants **a — grouped**, **b — compact**.

## Goal

A macOS menu-bar icon for Kriyon. Left-click opens a glassy popover that shows, at a glance,
which sessions **need you** and which are **running**. Clicking a row jumps straight into that
session's terminal. Users pick **grouped** or **compact** layout in Preferences.

Non-goals (YAGNI): answering prompts inline, completed/history rows, dynamic per-content window
resize, menu-bar-first mode (hiding the Dock), Windows/Linux tray polish.

## Locked decisions

1. **Row click → go to the session.** Bring Kriyon forward, focus that session's terminal; the user
   answers in the terminal. No keystroke injection (ADR 0008).
   The compact-mode `APPROVE` / `ALLOW` pill is a **label only** — it describes the ask; clicking navigates.
2. **Keep the Dock icon.** The menu-bar icon is a companion quick-view, not a replacement.
3. **Active only.** Two groups: needs-you + running. No completed/"Done" rows (the mockup's
   `billing-worker` row is dropped).
4. **Right-click → native menu:** Open Kriyon · New session ⌘N · Preferences · Quit.

## Architecture

The popover is glassy and custom-rendered (blur, gradients, status dots, two-line rows, monospace
branch names) — a native `NSMenu` cannot draw it. So the panel is a **separate webview window**, and
the tray icon toggles it.

### Tray icon (Rust)

- Built in `src-tauri/src/lib.rs` `.setup()` via `tauri::tray::TrayIconBuilder`. The `tray-icon`
  feature is already enabled in `src-tauri/Cargo.toml` — no dependency change.
- New module `src-tauri/src/tray.rs` owns: icon creation, panel toggle, positioning, blur-hide,
  the native right-click menu, and the live attention badge.
- **Monochrome template icon** (`icon_as_template(true)` on macOS) so it adapts to light/dark menu bars.
- **Left-click** (`TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }`)
  → toggle the panel window (show+position+focus if hidden, hide if visible).
  Set `show_menu_on_left_click(false)` so left-click reaches `on_tray_icon_event` and the native menu
  is right-click only.
- **Right-click** → native `Menu` with items `open` (Open Kriyon), `new` (New session ⌘N),
  `prefs` (Preferences), `quit` (Quit), handled in `on_menu_event`.
- **Positioning:** register `tauri-plugin-positioner`; wire `tauri_plugin_positioner::on_tray_event`
  in `on_tray_icon_event`, then `window.move_window(Position::TrayCenter)` before showing.

### Panel window

- Separate Tauri window, label `"tray"`, url `tray.html`.
- Options: `decorations(false)`, `transparent(true)`, `always_on_top(true)`, `resizable(false)`,
  `visible(false)` initially, fixed size (~400×540 grouped; internal scroll for overflow).
- **Blur-hide:** `on_window_event` → `WindowEvent::Focused(false)` hides the window (menu-bar convention).
- **Frosted look:** `window-vibrancy` (Popover/HUD material) + `"macOSPrivateApi": true` in
  `src-tauri/tauri.conf.json` for real macOS blur matching the mockup's `backdrop-filter`.
- Created lazily on first click (or pre-created hidden in `.setup()`), then reused (hidden, not destroyed).

### Panel frontend (separate entry)

- New Vite entry `tray.html` → `src/tray/main.tsx` mounting `<TrayPanel>`. Added to
  `build.rollupOptions.input`. Small bundle — **no xterm / PTY / main app shell**.
- Components: `TrayPanel` (header, groups, footer, mode switch), `GroupedRow`, `CompactRow`,
  `EmptyState`.
- On mount: run `applyTheme(activeTheme)` (publishes `--kr-*` vars in this window), then
  `installSessionListeners()` + `listSessions()` + `listProjects()`. Subscribes to the same backend
  streams the main window uses: `session-status`, `session-activity`, `session-heartbeat`.
- Reuses existing helpers: `buildNeedsYouEntries` / `formatDuration` (`src/state/needsYou.ts`),
  `statusMeta` / `statusDotStyle` (`src/theme/status.ts`), the notification emoji/label map
  (mirror of `crates/kriyon-core/src/notification.rs`), and `src/theme/tokens.ts`.
- `hasTauri()` guards so the panel no-ops safely in a plain browser (Playwright QA).

## Data flow

### Populating the panel

- **Needs you** = sessions whose status is `Waiting` or that carry a `pendingAsk`
  (`SessionActivity.pendingAsk`), sorted longest-blocked first (reuse `buildNeedsYouEntries`).
  Row shows: status dot, session title, `⎇ branch`, ask text (emoji per `AskKind`), blocked duration.
- **Running** = sessions whose status is `Running`. Row shows: pulsing dot, title, `⎇ branch`,
  one-line activity summary (the `summary` from `session-status` / `progress_summary`), elapsed.
- Header counts: "N need you · M running". A light timer (≈1–5s while open) refreshes relative times.

### Row click → session (reuse notification pipeline)

The panel window has its **own** zustand store; calling `setActiveSession` there would not affect the
main window. So navigation routes through Rust:

- Panel invokes command `reveal_session(session_id)`.
- Rust validates `session_id` against `AppState.sessions` (IPC trust boundary; reject unknown ids),
  then: main window `unminimize()` + `show()` + `set_focus()`, `app.emit("focus-session", { session_id })`,
  and hides the `"tray"` window.
- The main window's existing `onFocusSession → focusSessionFromNotification` (`src/state/actions.ts`)
  selects the session, switches to studio + raw transcript. **Zero new main-window wiring.**

### Footer / menu actions

- **Open Kriyon** → command `show_main_window()` (reveal + focus main, hide panel).
- **New session ⌘N** (footer button and right-click menu item) → command `new_session()`: reveal main
  window + `app.emit("new-session")`. A small handler in the main window opens its existing
  new-session flow. (If v1 should omit this, the button reveals the app only.)
- **Preferences** (right-click menu) → reveal main + `app.emit("open-preferences")` (main window opens
  the Preferences surface).
- **Quit** → `app.exit(0)`.

### Live tray badge (panel closed)

`src-tauri/src/status_rt.rs`'s existing 2s ticker already reads `AppState.asks`. Extend it to compute
the needs-you count and call `tray.set_title(Some("N"))` (or clear when 0), so the menu-bar icon shows
attention even when the popover is closed.

## Settings: grouped vs compact

- Add `menuBarMode: "grouped" | "compact"` to the `Layout` interface + `DEFAULT_LAYOUT`
  (`src/state/layout.ts`), with `setMenuBarMode`, default **`grouped`**.
- Add a `parseMenuBarMode` validator line to `parseLayout` (`src/state/persistence.ts`) — without it
  the field silently drops on reload.
- Preferences UI: a two-option control next to notify-preference / theme.
- The panel reads `menuBarMode` from hydrated layout on boot and listens for a `"menu-bar-mode"` event
  the main window emits when the setting changes (cross-window `emit` broadcasts to all windows).
  **No Rust state** — the mode only affects the JS-rendered panel.

## Layout details (from the design)

- **Grouped (a):** header (Kriyon glyph, "N need you · M running", gear + expand icons);
  `NEEDS YOU` section (amber `#E0A32E`) with count badge and rich rows (dot, name, branch, ask text,
  duration, chevron); divider; `RUNNING` section (green `#4CC38A`) with count and activity rows;
  footer (Open Kriyon · New session ⌘N button, indigo gradient).
- **Compact (b):** header ("Sessions" + inline "N need you" / "M running"); one dense list —
  needs-you rows carry an action-pill label (`APPROVE` / `ALLOW`) on the right, running rows carry a
  timestamp; group divider; footer (Open Kriyon · New session ⌘N).
- Colors/spacing/fonts come from `src/theme/tokens.ts` + `src/theme/status.ts` — no hardcoded values
  (map the mockup's literal hexes onto existing tokens: amber→`status.waiting`, green→`status.running`,
  indigo→`accent`).

## Edge cases

- **Empty:** "No sessions running" + New session button.
- **Theme:** panel re-applies theme on the `themeId` change (same `--kr-*` seam as the main window).
- **Stale/no-Tauri:** `hasTauri()` guard; panel renders inert with no backend.
- **Unknown session id** on `reveal_session`: rejected in Rust; `focusSessionFromNotification` also
  guards on the frontend.

## Testing (TDD — failing test first)

- **Rust unit (`crates/kriyon-core` / `src-tauri`):** needs-you count derivation from `asks`;
  `reveal_session` rejects an id not in `AppState.sessions`.
- **Frontend unit:** grouped/compact selector partitions sessions into the two groups; empty state;
  mode switch swaps layout; emoji/label mapping matches the Rust vocabulary.
- **Browser QA:** drive `<TrayPanel>` via the `window.__kriyon` store seam with fake sessions
  (Playwright), grouped and compact, empty and populated.

## Files touched

| Area | File |
|---|---|
| Tray icon, panel toggle, native menu, badge | `src-tauri/src/tray.rs` (new), `src-tauri/src/lib.rs` |
| Panel commands | `src-tauri/src/commands.rs` (`reveal_session`, `show_main_window`, `new_session`) |
| Live badge | `src-tauri/src/status_rt.rs` |
| Transparency / vibrancy | `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (`window-vibrancy`, `tauri-plugin-positioner`) |
| Panel entry + UI | `tray.html` (new), `src/tray/main.tsx` (new), `src/tray/TrayPanel.tsx` (new), rows |
| Vite entry | `vite.config.ts` |
| Setting | `src/state/layout.ts`, `src/state/persistence.ts`, Preferences UI |
| Reused (unchanged) | `src/state/actions.ts`, `src/state/backendListeners.ts`, `src/state/needsYou.ts`, `src/theme/status.ts`, `src/theme/tokens.ts` |
