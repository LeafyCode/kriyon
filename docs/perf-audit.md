# Kriyon performance & resource audit

_Date: 2026-07-12._

## What shipped (this branch)

| Fix | Result | Commit |
|---|---|---|
| Release build profile (thin LTO + strip) | **binary 20.9 MB → 11.3 MB** (46% smaller, faster cold launch) | `build:` |
| Terminal input sent as raw bytes, not a number array | no ~3.8× inflation on pastes | `perf(ipc)` |
| Memoized usage totals | sidebar footer / composer / inspector stop rescanning every session on every tick | `perf(sidebar)` |
| Watcher skips unchanged task/usage files | no disk read+parse per idle poll (per open session) | `perf(watcher)` |
| Dropped 3 unused dependencies | smaller install, no accidental bloat | `chore(deps)` |

Every change kept `pnpm check` green (773 FE tests + full Rust suite).

**Deliberately deferred** (marginal or risky — see notes at each item below): lazy-loading the terminal (mount-lifecycle risk for little gain on a local-loaded app), caching the SQLite lists (the frequent path already doesn't scan; only the rare notification path does), font subsetting (can't drop weights the terminal uses; needs a font toolchain), sidebar-ordering re-sort (fixing it means untangling ordering logic many tests depend on — already gated from re-render), transcript virtualization (bounded by the 1000-event cap; windowing variable-height rows is high-risk), `default_branch` cache and daemon poll intervals (user-triggered / negligible).

---

_Original findings below._

## Verdict

The hard parts are already built right: terminals stay alive across view switches, terminal output uses fast binary transfer with back-pressure, transcripts are read by tailing (not re-reading whole files), and boot doesn't do heavy work before the window shows. So there's no rewrite here — just a set of targeted fixes.

The wins fall in three buckets:
- **Snappier UI** — a few always-on sidebar/composer pieces redo the same heavy math on every line an agent prints.
- **Lower idle drain** — a background thread per session re-reads files every 0.3s even when nothing changed.
- **Smaller & faster to launch** — the release build has no size settings, so the app ships ~21 MB unstripped.

---

## Do these first (biggest bang)

### 1. Stop the sidebar and composer from re-doing math on every printed line
While any agent is streaming output, several always-visible pieces recompute totals over every stored event, many times a second, on the main thread. This is the main cause of jank and typing lag during active sessions.

- **Usage total in the sidebar footer** re-adds up every event of every session on every update — `src/sidebar/UsageFooter.tsx:51`.
- **The composer** re-adds the active session's usage on every line, causing input lag exactly while output is flowing — `src/layout/PromptBar.tsx:431`.
- **Sidebar ordering** re-sorts all sessions on every printed line, even though the order rarely changes — `src/sidebar/Sidebar.tsx:107`, `src/sidebar/ProjectGroup.tsx:303`.
- **The "needs you" list** rescans all sessions (and stringifies items) on every update — `src/sidebar/NeedsYouSection.tsx:186`.

**One fix covers most of it:** these already receive ready-made usage/activity snapshots from the backend — read those instead of re-deriving from the raw event lists. Keep a running total in the store rather than re-summing.

**Effort:** medium. **Impact:** high — this is what makes the app feel slow when it's busy.

### 2. Give the release build size settings
There is no `[profile.release]` anywhere, so the shipped app is 20.9 MB with 40k debug symbols left in, and it pages in slower on a cold launch.

Add to the root `Cargo.toml`:
```toml
[profile.release]
lto = true
codegen-units = 1
strip = true
panic = "abort"
```
This also shrinks the bundled terminal helper binary. **Realistic result: ~8–12 MB instead of 21 MB.**

**Effort:** trivial (4 lines). **Impact:** high on size and cold-launch speed.

### 3. Cut idle background work in the file watcher
Every open session runs a thread that re-reads and re-parses its task files and usage file **every 0.3 seconds, even when nothing changed** — `src-tauri/src/watcher.rs:491,617`. At 10–20 sessions that's continuous disk and CPU churn while completely idle, and it keeps the machine from ever fully resting (worse battery).

**Fix:** check the file's modified-time first and skip the read/parse when unchanged; lengthen the fallback interval to 1–2s (the file-change notifier already catches real updates).

**Effort:** low. **Impact:** high for idle CPU/battery, and it scales with how many sessions you keep open.

---

## Worth doing

### 4. Split the frontend so the terminal loads on demand
Everything ships as one 822 KB chunk, including the whole terminal engine, even though the terminal only appears once you open a session — `vite.config.ts` (no code-splitting). Lazy-load the `Terminal` component and split the terminal engine into its own chunk so the sidebar/empty state paints faster.
**Effort:** low–medium. **Impact:** faster first paint.

### 5. Fix the one slow direction of terminal input
Keystrokes and pastes are sent as a list of numbers, which balloons ~3.8× and stutters on large pastes — `src/ipc/bridge.ts:71`. Send them as base64 (or raw bytes) instead. Output is already done the fast way; this just brings input in line.
**Effort:** low. **Impact:** removes lag on big pastes.

### 6. Cache the SQLite session/project lists in memory
The notification and menu-bar-tray paths re-scan the whole sessions and projects tables (under one shared lock) on every status change — `src-tauri/src/store.rs:275`, `src-tauri/src/status_rt.rs:28`. These lists only change when you create/rename/delete, so cache them and refresh on those events.
**Effort:** medium. **Impact:** less stutter during bursts of status changes; scales with session count.

### 7. Trim the fonts
4.25 MB of fonts ship — four full icon-patched weights at ~1 MB each — `dist/fonts/`. Confirm all four are actually used; drop or subset the ones that aren't.
**Effort:** low. **Impact:** ~2–4 MB smaller bundle.

### 8. Remove unused dependencies
`@xterm/addon-search`, `@xterm/addon-serialize`, and `@tauri-apps/plugin-updater` are declared but never used. Delete them from `package.json` so they can't accidentally bloat the bundle later.
**Effort:** trivial.

---

## Nice to have (lower priority)

- **Virtualize the structured transcript** — up to 1000 rows stay mounted and re-reconcile per line on long sessions (`src/studio/StudioView.tsx:77`). Render only what's visible. Matters mainly for very long sessions.
- **Cache the repo's default branch** — computing it can spawn up to 3 git processes each time (`src-tauri/src/git_cmd.rs:121`); it almost never changes.
- **Ease off the per-session daemon poll threads** — each session's helper wakes ~6×/sec to check state (`crates/kriyon-ptyd/src/server.rs:161,175`). Slowing these to ~0.5s halves the wakeups; minor, battery only.
- **Batch "bytes drained" reports for hidden terminals** — a backgrounded terminal under a flood reports per chunk (`src/terminal/sessionHost.ts:234`). Coalesce on a timer.

---

## Already good — don't touch

Verified working well, so no effort needed here:
- Terminals are kept mounted and just hidden on view switch — no blank-on-return.
- Terminal **output** already uses fast binary transfer with proper back-pressure (parks the reader when the UI falls behind).
- Transcripts/logs are read by tailing only the new bytes — no whole-file re-parsing, no O(n²).
- The database connection is opened once and shared, not per call.
- Boot doesn't spawn the terminal helper, scan sessions, or block first paint; session data loads in a small parallel batch and only the active session actually starts `claude`.
- xterm's WebGL renderer is attached only to the visible pane (respects the webview's context limit).
- Save-to-disk is guarded by a fingerprint, so streaming churn doesn't trigger writes.
- The per-second clock ticks are single shared timers that only re-render the small rows that use them.

---

## Suggested order

1. Sidebar/composer usage math (#1) — the "feels slow when busy" fix.
2. Release profile (#2) — 4 lines, big size/launch win.
3. Watcher idle work (#3) — idle CPU/battery.
4. Then #4–#8 as time allows; the "nice to have" list only when those specific situations bite.
