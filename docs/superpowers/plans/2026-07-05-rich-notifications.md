# Rich Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich Kriyon's OS notifications to name the project + session, distinguish the event with a leading emoji, carry the pending-ask text, and focus the exact session on click — with no inline reply.

**Architecture:** The *decision* to notify (`should_notify` + `preference_allows` + focus + 5s coalesce) stays untouched in `kriyon-core::status` / `status_rt.rs`. A new pure `notification_content` function in `kriyon-core` builds the emoji/title/body from `(SessionStatus, Option<&PendingAsk>, project, title)`. The latest `PendingAsk` is mirrored into `AppState` from the activity snapshot (the canonical computation stays the watcher's projection). On macOS the notification is shown by a native module (`mac-notification-sys`) that captures the session id in its own thread and, on click, focuses the window and emits `focus-session` to the frontend; the frontend routes to that session's Raw view. Notify-only — no reply (see ADR 0008).

**Tech Stack:** Rust (Tauri v2, `kriyon-core`), `mac-notification-sys` (macOS native notifications), React + Zustand (frontend), Vitest + `cargo test`.

## Global Constraints

- **Mac-first.** The native notification path is `#[cfg(target_os = "macos")]`; other targets keep the existing Tauri-plugin path. Never break the non-macOS build.
- **Never keystroke-inject / write composed bytes into a live PTY.** Notify-only; the click focuses the session, the user answers in the Raw view. (`AGENTS.md` invariant; ADR 0005; ADR 0008.)
- **The Rust↔JS IPC boundary is a trust boundary.** The `focus-session` payload's `sessionId` is untrusted on the frontend: ignore it if it matches no known session.
- **Pure logic lives in `crates/kriyon-core`** (unit-testable without Tauri); `src-tauri` is the thin shell.
- **A term must appear in `CONTEXT.md` before it becomes a type/module name** — this plan adds `NotificationContent` and so adds a glossary line (Task 2).
- **`pnpm check` must pass before every commit.** Never hand-format — run `pnpm fix`. Conventional commits, small and frequent.
- **Emoji, exact:** ❓ `\u{2753}` question · 🔑 `\u{1F511}` permission · 📋 `\u{1F4CB}` plan · ⏳ `\u{23F3}` waiting-no-ask · ✅ `\u{2705}` done · ⚠️ `\u{26A0}\u{FE0F}` error. Separator `·` is `\u{00B7}`.

---

### Task 1: Native notification module + click proof (SPIKE, gated)

This is the load-bearing risk. It must be proven in a **bundled `.app`** (notifications with actions do not reliably work under `pnpm dev` / an unbundled binary). Do this first; do not wire the rest until the click round-trips.

**Files:**
- Modify: `src-tauri/Cargo.toml` (add the macOS-only dependency)
- Modify: `src-tauri/src/notify.rs` (add `show` + `FocusSessionPayload`; keep `notification_body` for now)

**Interfaces:**
- Produces: `crate::notify::show(app: &tauri::AppHandle, session_id: &str, title: &str, body: &str)` — shows one OS notification; on click, focuses the main window and emits `focus-session` `{ sessionId }`. macOS-native; falls back to the Tauri plugin off-macOS.

- [ ] **Step 1: Add the macOS-only dependency**

In `src-tauri/Cargo.toml`, add a target-scoped dependency block (pin the exact patch version cargo resolves):

```toml
[target.'cfg(target_os = "macos")'.dependencies]
mac-notification-sys = "0.6"
```

- [ ] **Step 2: Pin the crate API**

Run `cargo doc -p mac-notification-sys --no-deps --open` (or read `~/.cargo/registry/.../mac-notification-sys-*/src/lib.rs`). Confirm three things and adjust Step 3 to match the installed version exactly:
1. `send_notification(title: &str, subtitle: Option<&str>, message: &str, options: Option<&Notification>) -> Result<NotificationResponse, Error>` — the parameter order/types.
2. `NotificationResponse` variants — expected: `Click`, `ActionButton(String)`, `CloseButton(String)`, `Reply(String)`, `None`.
3. `Notification::new().main_button(MainButton::SingleAction("Open"))` — the builder + `MainButton` variant names.

Expected: the signatures above hold on 0.6.x. If `send_notification` blocks the calling thread until the notification is interacted-with/dismissed, that is the intended behaviour (the session id rides in our thread's closure, so no OS payload round-trip is needed).

- [ ] **Step 3: Implement `show` + `FocusSessionPayload`**

In `src-tauri/src/notify.rs`, add:

```rust
use serde::Serialize;
use tauri::{Emitter as _, Manager as _};

/// Payload for the `focus-session` event: the session the user clicked a
/// notification for. Camel-cased to match the other session-* events.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusSessionPayload {
    session_id: String,
}

/// Show an OS notification for `session_id`. On macOS this is native
/// (`mac-notification-sys`) so a click reliably lands: the session id is
/// captured in this thread's closure, and on click we bring the window forward
/// and emit `focus-session`. Best-effort — any failure is swallowed so a
/// missing permission or backend never disrupts the session runtime.
#[cfg(target_os = "macos")]
pub fn show(app: &tauri::AppHandle, session_id: &str, title: &str, body: &str) {
    let app = app.clone();
    let session_id = session_id.to_string();
    let title = title.to_string();
    let body = body.to_string();
    // send_notification blocks until the user interacts/dismisses, so it runs
    // on its own thread. Notifications are infrequent (coalesced, transition-
    // gated), so at most a handful of these threads are ever parked at once.
    std::thread::spawn(move || {
        use mac_notification_sys::{send_notification, MainButton, Notification, NotificationResponse};
        let opts = Notification::new().main_button(MainButton::SingleAction("Open"));
        match send_notification(&title, None, &body, Some(&opts)) {
            Ok(NotificationResponse::Click | NotificationResponse::ActionButton(_)) => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
                let _ = app.emit("focus-session", FocusSessionPayload { session_id });
            }
            _ => {}
        }
    });
}

/// Off-macOS: the existing Tauri-plugin path (no click routing).
#[cfg(not(target_os = "macos"))]
pub fn show(app: &tauri::AppHandle, _session_id: &str, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt as _;
    let _ = app.notification().builder().title(title).body(body).show();
}
```

If Step 2 found the window label is not `"main"`, use the label from `src-tauri/tauri.conf.json` (`app.windows[].label`).

- [ ] **Step 4: Temporarily call `show` on app launch to prove the click**

In `src-tauri/src/lib.rs`, inside `.setup(|app| { ... })` (after the store is managed), add a temporary probe:

```rust
crate::notify::show(&app.handle(), "probe-session", "\u{2753} kriyon \u{00B7} probe", "click me");
```

- [ ] **Step 5: Build a bundled app and verify the click round-trips**

Run: `pnpm tauri build --debug`
Then launch the built app from `src-tauri/target/debug/bundle/macos/*.app` (open the `.app`, not the bare binary — bundling is what makes notifications fire).

Expected: a notification `❓ kriyon · probe / click me` appears. Clicking it (or its "Open" button) brings the window forward. Add a `println!("focus-session emitted for {session_id}")` before the `app.emit` and confirm it prints to the app's stderr (`Console.app`, or run the `.app`'s binary from a terminal).

**Acceptance (manual gate):** clicking the notification triggers the Rust handler (the println fires) and focuses the window. If `NotificationResponse::Click` never arrives on 0.6.x, fall back to `objc2` + `objc2-user-notifications` (`UNUserNotificationCenter` with a `UNNotificationCategory` + delegate) — same `show` signature, heavier body — and record the switch in ADR 0008. Do not proceed past this task until the click lands.

- [ ] **Step 6: Remove the probe and commit**

Delete the Step 4 probe line and the Step 5 `println!`. Run `pnpm fix`.

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/notify.rs
git commit -m "feat(notify): native macOS notification with click-to-focus"
```

---

### Task 2: Pure notification content builder

**Files:**
- Create: `crates/kriyon-core/src/notification.rs`
- Modify: `crates/kriyon-core/src/lib.rs` (add `pub mod notification;`)
- Modify: `CONTEXT.md` (glossary line for the new type)
- Test: inline `#[cfg(test)] mod tests` in `crates/kriyon-core/src/notification.rs`

**Interfaces:**
- Consumes: `crate::session::SessionStatus`, `crate::ask::{AskKind, PendingAsk}` (existing).
- Produces:
  - `pub struct NotificationContent { pub title: String, pub body: String }`
  - `pub fn notification_content(status: SessionStatus, ask: Option<&PendingAsk>, project: &str, title: &str) -> Option<NotificationContent>`

- [ ] **Step 1: Add the glossary line**

In `CONTEXT.md`, add under the notification-related terms (near **Notify preference**):

```markdown
- **Notification content** (`NotificationContent`) — the rendered pieces of one OS
  notification: a `title` line (`<emoji> <project> · <session title>`) and a `body`
  (the attention label, plus the [Pending ask]'s own line when there is one). A pure
  function of ([Status], [Pending ask], project name, session title), built in
  `kriyon-core` so it is unit-testable without Tauri. The leading emoji mirrors the
  sidebar `kindIcon` meanings. _Avoid_: notification payload, alert.
```

- [ ] **Step 2: Write the failing tests**

Create `crates/kriyon-core/src/notification.rs` with only the tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::{AskKind, PendingAsk};
    use crate::session::SessionStatus;

    fn ask(kind: AskKind, text: &str) -> PendingAsk {
        PendingAsk { kind, text: text.to_string(), asked_at: None }
    }

    #[test]
    fn waiting_question_uses_question_emoji_and_ask_text() {
        let a = ask(AskKind::Question, "Which migration strategy?");
        let c = notification_content(SessionStatus::Waiting, Some(&a), "auth-service", "Fix login flow")
            .expect("attention state");
        assert_eq!(c.title, "\u{2753} auth-service \u{00B7} Fix login flow");
        assert_eq!(c.body, "needs your input\nWhich migration strategy?");
    }

    #[test]
    fn waiting_permission_uses_key_emoji() {
        let a = ask(AskKind::Permission, "Allow Bash?");
        let c = notification_content(SessionStatus::Waiting, Some(&a), "web", "Deploy")
            .expect("attention state");
        assert_eq!(c.title, "\u{1F511} web \u{00B7} Deploy");
        assert_eq!(c.body, "needs permission\nAllow Bash?");
    }

    #[test]
    fn waiting_plan_uses_clipboard_emoji() {
        let a = ask(AskKind::PlanApproval, "Approve plan: ship it");
        let c = notification_content(SessionStatus::Waiting, Some(&a), "web", "Plan")
            .expect("attention state");
        assert_eq!(c.title, "\u{1F4CB} web \u{00B7} Plan");
        assert_eq!(c.body, "plan ready for review\nApprove plan: ship it");
    }

    #[test]
    fn waiting_without_ask_uses_hourglass_and_generic_body() {
        let c = notification_content(SessionStatus::Waiting, None, "web", "Task")
            .expect("attention state");
        assert_eq!(c.title, "\u{23F3} web \u{00B7} Task");
        assert_eq!(c.body, "needs your input");
    }

    #[test]
    fn done_uses_check_emoji() {
        let c = notification_content(SessionStatus::Done, None, "web", "Task")
            .expect("attention state");
        assert_eq!(c.title, "\u{2705} web \u{00B7} Task");
        assert_eq!(c.body, "session finished");
    }

    #[test]
    fn error_uses_warning_emoji() {
        let c = notification_content(SessionStatus::Error, None, "web", "Task")
            .expect("attention state");
        assert_eq!(c.title, "\u{26A0}\u{FE0F} web \u{00B7} Task");
        assert_eq!(c.body, "session error");
    }

    #[test]
    fn idle_and_running_have_no_content() {
        assert_eq!(notification_content(SessionStatus::Idle, None, "web", "T"), None);
        assert_eq!(notification_content(SessionStatus::Running, None, "web", "T"), None);
    }

    #[test]
    fn trims_project_title_and_ask_text() {
        let a = ask(AskKind::Question, "  spaced?  ");
        let c = notification_content(SessionStatus::Waiting, Some(&a), "  web  ", "  Task  ")
            .expect("attention state");
        assert_eq!(c.title, "\u{2753} web \u{00B7} Task");
        assert_eq!(c.body, "needs your input\nspaced?");
    }

    #[test]
    fn blank_ask_text_falls_back_to_label_only() {
        let a = ask(AskKind::Question, "   ");
        let c = notification_content(SessionStatus::Waiting, Some(&a), "web", "Task")
            .expect("attention state");
        assert_eq!(c.body, "needs your input");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p kriyon-core notification`
Expected: FAIL — `notification_content` / `NotificationContent` not found (unresolved import).

- [ ] **Step 4: Implement the builder**

At the top of `crates/kriyon-core/src/notification.rs` (above the tests), add:

```rust
//! Pure notification content — the emoji, title line, and body for an
//! attention [Status], enriched with the project name, [Session title], and
//! [Pending ask]. No Tauri, no OS: unit-testable. See CONTEXT.md
//! "Notification content" and ADR 0008.

use crate::ask::{AskKind, PendingAsk};
use crate::session::SessionStatus;

/// The rendered pieces of one OS notification (see CONTEXT.md).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotificationContent {
    pub title: String,
    pub body: String,
}

/// Build the notification content for a status the user should be told about,
/// or `None` for the non-attention states (`Idle`, `Running`). A `waiting`
/// status refines its emoji + label to the [`PendingAsk`] kind when one is known.
#[must_use]
pub fn notification_content(
    status: SessionStatus,
    ask: Option<&PendingAsk>,
    project: &str,
    title: &str,
) -> Option<NotificationContent> {
    let (emoji, label) = match status {
        SessionStatus::Waiting => match ask.map(|a| a.kind) {
            Some(AskKind::Question) => ("\u{2753}", "needs your input"),
            Some(AskKind::Permission) => ("\u{1F511}", "needs permission"),
            Some(AskKind::PlanApproval) => ("\u{1F4CB}", "plan ready for review"),
            None => ("\u{23F3}", "needs your input"),
        },
        SessionStatus::Done => ("\u{2705}", "session finished"),
        SessionStatus::Error => ("\u{26A0}\u{FE0F}", "session error"),
        SessionStatus::Idle | SessionStatus::Running => return None,
    };

    let title_line = format!("{emoji} {} \u{00B7} {}", project.trim(), title.trim());

    let ask_text = ask.map(|a| a.text.trim()).filter(|t| !t.is_empty());
    let body = match ask_text {
        Some(text) => format!("{label}\n{text}"),
        None => label.to_string(),
    };

    Some(NotificationContent { title: title_line, body })
}
```

Then add `pub mod notification;` to `crates/kriyon-core/src/lib.rs` (alphabetically among the existing `pub mod` lines).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p kriyon-core notification`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

Run `pnpm fix` (formats any touched TS; Rust is `cargo fmt` via the same check).

```bash
git add crates/kriyon-core/src/notification.rs crates/kriyon-core/src/lib.rs CONTEXT.md
git commit -m "feat(core): pure notification content builder with per-event emoji"
```

---

### Task 3: Mirror the pending ask + resolve project/title for dispatch

**Files:**
- Modify: `src-tauri/src/lib.rs` (add `asks` field to `AppState`)
- Modify: `src-tauri/src/commands.rs` (populate `asks` in the Activity handler; clear it in `close_session`)
- Modify: `src-tauri/src/status_rt.rs` (add the `session_display` helper)

**Interfaces:**
- Consumes: `kriyon_core::ask::PendingAsk`, `crate::store::{StoreState, SessionRow, ProjectRow}` (existing), `SessionActivity.pending_ask` (existing).
- Produces:
  - `AppState.asks: Mutex<HashMap<SessionId, Option<kriyon_core::ask::PendingAsk>>>`
  - `fn session_display(store: &crate::StoreState, session_id: &SessionId) -> (String, String)` in `status_rt.rs` — returns `(project_name, session_title)`, falling back to the raw session id + empty title when the row is absent.

- [ ] **Step 1: Add the `asks` field to `AppState`**

In `src-tauri/src/lib.rs`, in `struct AppState`, add after the `notify_pref` field:

```rust
    /// The latest known [Pending ask] per session, mirrored from the activity
    /// snapshot so the OS-notification dispatch can name *what* a `waiting`
    /// session wants. `None` = no open ask (dispatch falls back to a generic
    /// label). Kept here — not in the status tracker — so the canonical ask
    /// computation stays the watcher's projection (single source).
    pub asks: Mutex<HashMap<SessionId, Option<kriyon_core::ask::PendingAsk>>>,
```

(`AppState` already `#[derive(Default)]`, and `HashMap`/`Mutex` are already imported — no import change needed.)

- [ ] **Step 2: Populate `asks` in the Activity signal handler**

In `src-tauri/src/commands.rs`, find the `WatchSignal::Activity(snapshot)` arm (~line 442) and replace it with:

```rust
            WatchSignal::Activity(snapshot) => {
                // Mirror the ask into shared state so the OS-notification
                // dispatch (status_rt) can name what a waiting session wants.
                // The snapshot is the canonical computation; we cache its ask.
                app.state::<AppState>()
                    .asks
                    .lock()
                    .insert(cb_id.clone(), snapshot.pending_ask.clone());
                let _ = app.emit(
                    "session-activity",
                    ActivityPayload {
                        session_id: cb_id.0.clone(),
                        snapshot,
                    },
                );
            }
```

Ensure `use tauri::Manager as _;` is in scope in `commands.rs` (needed for `app.state::<AppState>()`); add it to the file's imports if absent.

- [ ] **Step 3: Clear `asks` on session close**

In `src-tauri/src/commands.rs`, in `close_session` (~line 315), alongside the existing `state.watchers.lock().remove(...)` / `state.status.lock().remove(...)` lines, add:

```rust
    state.asks.lock().remove(&session_id);
```

- [ ] **Step 4: Add the `session_display` helper (with a test)**

In `src-tauri/src/status_rt.rs`, add the helper and a unit test. First the failing test at the bottom of the file:

```rust
#[cfg(test)]
mod tests {
    use super::session_display;
    use crate::store::{ProjectRow, SessionRow, Store, StoreState};
    use kriyon_core::session::SessionId;
    use parking_lot::Mutex;

    fn row(id: &str, project_id: &str, title: &str) -> SessionRow {
        SessionRow {
            id: id.to_string(),
            project_id: project_id.to_string(),
            title: title.to_string(),
            cwd: "/tmp".to_string(),
            worktree_path: None,
            created_at: 0,
            claude_session_id: None,
            archived_at: None,
        }
    }

    fn project(id: &str, name: &str) -> ProjectRow {
        ProjectRow {
            id: id.to_string(),
            name: name.to_string(),
            path: "/tmp".to_string(),
            color: None,
            setup_command: None,
        }
    }

    #[test]
    fn resolves_project_name_and_title() {
        let store = Store::open_in_memory().expect("store");
        store.upsert_project(&project("p1", "auth-service")).expect("project");
        store.upsert_session(&row("s1", "p1", "Fix login flow")).expect("session");
        let state = StoreState(Mutex::new(store));
        let (project, title) = session_display(&state, &SessionId("s1".to_string()));
        assert_eq!(project, "auth-service");
        assert_eq!(title, "Fix login flow");
    }

    #[test]
    fn missing_row_falls_back_to_session_id() {
        let store = Store::open_in_memory().expect("store");
        let state = StoreState(Mutex::new(store));
        let (project, title) = session_display(&state, &SessionId("ghost".to_string()));
        assert_eq!(project, "ghost");
        assert_eq!(title, "");
    }
}
```

Confirm the store's in-memory constructor + upsert names in `src-tauri/src/store.rs` (expected `Store::open_in_memory`, `upsert_project`, `upsert_session`); adjust the test to the actual names if they differ.

- [ ] **Step 5: Run the test to verify it fails**

Run: `cargo test -p kriyon --lib status_rt`
Expected: FAIL — `session_display` not found.

- [ ] **Step 6: Implement `session_display`**

In `src-tauri/src/status_rt.rs`, add near the top (after imports) and add `use crate::StoreState;` to the imports:

```rust
/// Resolve a session's (project name, session title) from the store for
/// notification display. Falls back to the raw session id + empty title when
/// the row is missing (an unpersisted or just-created session), so a
/// notification never fails to render.
fn session_display(store: &StoreState, session_id: &SessionId) -> (String, String) {
    let store = store.0.lock();
    let session = store
        .list_sessions()
        .ok()
        .and_then(|rows| rows.into_iter().find(|r| r.id == session_id.0));
    match session {
        Some(s) => {
            let project = store
                .list_projects()
                .ok()
                .and_then(|ps| ps.into_iter().find(|p| p.id == s.project_id))
                .map_or_else(|| s.project_id.clone(), |p| p.name);
            (project, s.title)
        }
        None => (session_id.0.clone(), String::new()),
    }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cargo test -p kriyon --lib status_rt`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/src/status_rt.rs
git commit -m "feat(notify): mirror pending ask + resolve project/title for dispatch"
```

---

### Task 4: Wire the enriched dispatch into the status runtime

**Files:**
- Modify: `src-tauri/src/status_rt.rs` (use `notification_content` + `notify::show`)
- Modify: `src-tauri/src/notify.rs` (delete the now-unused `notification_body` + its tests)

**Interfaces:**
- Consumes: `kriyon_core::notification::notification_content` (Task 2), `crate::notify::show` (Task 1), `AppState.asks` + `session_display` (Task 3).

- [ ] **Step 1: Replace the dispatch tail in `recompute_and_emit`**

In `src-tauri/src/status_rt.rs`, replace the block from `let Some(body) = notification_body(...)` through `dispatch(app, &session_id.0, &body);` (the lines after the `should_notify`/`preference_allows` gate) with:

```rust
    let ask = state.asks.lock().get(session_id).cloned().flatten();
    let store = app.state::<StoreState>();
    let (project, title) = session_display(&store, session_id);
    let Some(content) =
        kriyon_core::notification::notification_content(change.status, ask.as_ref(), &project, &title)
    else {
        return;
    };
    crate::notify::show(app, &session_id.0, &content.title, &content.body);
```

Update the imports at the top of the file: remove `use crate::notify::{dispatch, notification_body};` and rely on the fully-qualified `crate::notify::show` above (or `use crate::notify::show;`). Keep `use tauri::Manager as _;` (already present via `Manager`) so `app.state::<StoreState>()` resolves.

- [ ] **Step 2: Delete the dead `notification_body`**

In `src-tauri/src/notify.rs`, delete `pub fn notification_body(...)` and its three `#[cfg(test)]` tests (`notification_body_none_for_non_attention`, `notification_body_some_for_attention`, `notification_body_appends_summary`) — the pure content now lives in `kriyon-core::notification`. Keep `show` (Task 1).

- [ ] **Step 3: Verify the whole workspace compiles and tests pass**

Run: `pnpm check`
Expected: PASS — Rust builds (macOS + the cfg gate), `cargo test` green, `tsc` green. Fix any unused-import warnings clippy flags (`pedantic` is enforced).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/status_rt.rs src-tauri/src/notify.rs
git commit -m "feat(notify): dispatch rich project/session/ask notifications"
```

---

### Task 5: Frontend — focus the session on notification click

**Files:**
- Modify: `src/ipc/bridge.ts` (add `onFocusSession`)
- Modify: `src/state/actions.ts` (add `focusSessionFromNotification`)
- Modify: `src/state/backendListeners.ts` (install the `focus-session` listener)
- Test: `src/state/actions.test.ts` (new or existing) for `focusSessionFromNotification`

**Interfaces:**
- Consumes: `useSessions` (`sessions`, `setActiveSession`), `useLayout` (`setView`, `setTranscriptView`) — same trio `NeedsYouOverlay.openEntry` uses.
- Produces:
  - `onFocusSession(cb: (sessionId: string) => void): Promise<() => void>` in `bridge.ts`
  - `focusSessionFromNotification(sessionId: string): void` in `actions.ts`

- [ ] **Step 1: Add the `onFocusSession` bridge subscription**

In `src/ipc/bridge.ts`, mirror `onSessionStatus` (~line 119). The backend payload is `{ sessionId: string }`:

```typescript
/**
 * Subscribe to backend `focus-session` events, emitted when the user clicks an
 * OS notification. Resolves to an unlisten fn. No-ops outside the Tauri webview.
 */
export function onFocusSession(
  cb: (sessionId: string) => void
): Promise<() => void> {
  if (!hasTauri()) {
    return Promise.resolve(() => {});
  }
  return listen<{ sessionId: string }>("focus-session", (event) =>
    cb(event.payload.sessionId)
  );
}
```

Match the exact `hasTauri()` guard style used by the neighbouring `onSession*` functions in the file.

- [ ] **Step 2: Write the failing test for `focusSessionFromNotification`**

In `src/state/actions.test.ts` (create if absent; follow the import + reset pattern in `src/state/sessions.test.ts`):

```typescript
import { beforeEach, expect, test } from "vitest";
import { focusSessionFromNotification } from "./actions.ts";
import { useLayout, DEFAULT_LAYOUT } from "./layout.ts";
import { useSessions } from "./sessions.ts";
import { idleSession } from "./sessions.ts"; // use the same helper sessions.test.ts uses

beforeEach(() => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useSessions.setState({ sessions: [], activeId: null });
});

test("focuses a known session and routes to its raw view", () => {
  useSessions.getState().addSession(
    idleSession({
      archivedAt: null,
      claudeSessionId: null,
      createdAt: 0,
      cwd: "/tmp",
      id: "s1",
      projectId: "p1",
      title: "Fix login",
      worktreePath: null,
    })
  );
  focusSessionFromNotification("s1");
  expect(useSessions.getState().activeId).toBe("s1");
  expect(useLayout.getState().layout.view).toBe("studio");
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});

test("ignores an unknown session id (untrusted IPC input)", () => {
  focusSessionFromNotification("ghost");
  expect(useSessions.getState().activeId).toBeNull();
});
```

Confirm the `useSessions` active-id field name (`activeId`) and the `idleSession` helper against `src/state/sessions.ts`; adjust if they differ.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/state/actions.test.ts`
Expected: FAIL — `focusSessionFromNotification` is not exported.

- [ ] **Step 4: Implement `focusSessionFromNotification`**

In `src/state/actions.ts`, add (importing `useLayout` from `./layout.ts` if not already imported):

```typescript
/**
 * Focus the session a clicked OS notification points at, routing to its Raw
 * view — the same landing as the Needs-you overlay's Enter. `sessionId` crosses
 * the IPC trust boundary, so an unknown id is ignored rather than trusted.
 */
export function focusSessionFromNotification(sessionId: string): void {
  const sessions = useSessions.getState();
  if (!sessions.sessions.some((session) => session.id === sessionId)) {
    return;
  }
  sessions.setActiveSession(sessionId);
  const layout = useLayout.getState();
  layout.setView("studio");
  layout.setTranscriptView("raw");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/state/actions.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Install the `focus-session` listener**

In `src/state/backendListeners.ts`, add a listener alongside the others in `installSessionListeners`. Since `onFocusSession`'s callback shape (`(sessionId: string)`) differs from the snapshot listeners, install it directly rather than via `installBackendListener`:

```typescript
  const unlistenFocus = { current: undefined as (() => void) | undefined };
  let cancelledFocus = false;
  void onFocusSession((sessionId) => focusSessionFromNotification(sessionId)).then(
    (fn) => {
      if (cancelledFocus) {
        fn();
      } else {
        unlistenFocus.current = fn;
      }
    }
  );
```

and include its teardown in the returned cleanup function:

```typescript
    cancelledFocus = true;
    unlistenFocus.current?.();
```

Import `onFocusSession` from `../ipc/bridge.ts` and `focusSessionFromNotification` from `./actions.ts` at the top. If the file already has a simpler idiom for one-off listeners, follow that instead — the requirement is only that the listener is installed once and torn down with the rest.

- [ ] **Step 7: Verify everything is green**

Run: `pnpm check`
Expected: PASS (types, lint, all FE + Rust tests).

- [ ] **Step 8: End-to-end verification in a bundled app**

Run: `pnpm tauri build --debug` and launch the `.app`. Start a session, trigger a `waiting` state (let Claude ask a question) with the window **unfocused** (click another app). Confirm: a notification `❓ <project> · <title> / needs your input / <question>` appears; clicking it brings Kriyon forward and lands on that session's Raw view.

- [ ] **Step 9: Commit**

```bash
git add src/ipc/bridge.ts src/state/actions.ts src/state/actions.test.ts src/state/backendListeners.ts
git commit -m "feat(notify): focus the clicked session in its raw view"
```

---

## Self-Review

**Spec coverage:**
- Rich notification stating project + event → Tasks 2–4 (title `emoji project · title`, body label + ask). ✓
- Per-event visual using the sidebar icon *meanings* → Task 2 emoji map (mirrors `kindIcon`). ✓
- "Which project / what is it (question, done, error)" → Task 2 status + ask kind. ✓
- Click focuses the right session → Tasks 1 (native click) + 5 (frontend route). ✓
- Inline reply → deliberately dropped, recorded in ADR 0008. ✓ (out of scope by decision)

**Placeholder scan:** No TBD/TODO. Every code step shows the code; every test step shows the assertions. Two honest "confirm the exact name against the source" checks remain (Task 1 Step 2 crate API, Task 3 Step 4 store getters, Task 5 store field names) — these are verification steps for names that live outside the files being written, not placeholders for logic.

**Type consistency:** `notification_content(status, ask, project, title) -> Option<NotificationContent>` is defined in Task 2 and consumed identically in Task 4. `show(app, session_id, title, body)` defined in Task 1, called in Task 4. `AppState.asks` defined in Task 3, read in Task 4. `focus-session` payload is `{ sessionId }` in Task 1 (Rust, camelCase) and `{ sessionId }` in Task 5 (TS) — consistent. `focusSessionFromNotification(sessionId)` defined in Task 5 Step 4, used in Step 6.
