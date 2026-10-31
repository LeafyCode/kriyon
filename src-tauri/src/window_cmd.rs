//! Clipboard access and window/tray control: reading the OS pasteboard,
//! revealing or quitting the main window from a tray click, and the
//! menu-bar popover's poll (`session_snapshots`) — the tray is itself a
//! Tauri webview window, so its data feed lives beside the commands that
//! show/hide/focus windows rather than off on its own. `session_is_known` is
//! the shared trust-boundary check: a tray click always brings the app
//! forward, but only steers focus at a specific session once its id is
//! confirmed live.

use kriyon_core::session::SessionId;

use crate::AppState;
use crate::StoreState;

/// Read the OS clipboard's plain text. The Rust core owns OS access; the
/// frontend must not call `navigator.clipboard` (it rejects in the packaged
/// `WKWebView`). An empty pasteboard yields "".
///
/// # Errors
/// Returns an error string if the pasteboard is unavailable or holds no text.
#[tauri::command]
pub fn read_clipboard() -> Result<String, String> {
    arboard::Clipboard::new()
        .and_then(|mut cb| cb.get_text())
        .map_err(|e| e.to_string())
}

/// Whether `id` names a live session. The frontend-supplied id crosses the IPC
/// trust boundary, so every navigation command checks this before acting on it.
pub fn session_is_known(state: &AppState, id: &SessionId) -> bool {
    state.sessions.lock().contains_key(id)
}

/// Payload for the `focus-session` event: the (Kriyon) session id a clicked
/// tray row points at. Reuses the existing notification-focus pipeline
/// (`focusSessionFromNotification`) so the panel and OS notifications share one
/// path to bring a session forward.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusPayload {
    session_id: String,
}

/// Bring the main window forward and focus it, then hide the tray popover.
/// Shared by every panel navigation command and the tray's own menu.
pub fn reveal_main_and_hide_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager as _;

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
    }
}

/// Reveal the session a clicked tray row points at, reusing the notification
/// focus pipeline (`focus-session` → `focusSessionFromNotification`).
///
/// A click always brings the app forward, so a tray row is never a dead click
/// even in the edge where a row's session has a status tracker but no live
/// `AppState.sessions` entry. The `focus-session` emit — the part that drives a
/// specific session forward — stays gated on the id being known (trust
/// boundary): an unknown id reveals the window but does not steer focus.
///
/// # Errors
/// Infallible today; returns `Result` for command-signature uniformity.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn reveal_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    use tauri::Emitter as _;

    reveal_main_and_hide_tray(&app);
    let id = SessionId(session_id.clone());
    if session_is_known(&state, &id) {
        let _ = app.emit("focus-session", FocusPayload { session_id });
    }
    Ok(())
}

/// Reveal the main window (the panel's "Open Kriyon" / expand action).
///
/// # Errors
/// Infallible today; returns `Result` for command-signature uniformity.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    reveal_main_and_hide_tray(&app);
    Ok(())
}

/// Reveal the app and ask the frontend to start a new session. The one way in
/// for the popover's button, the tray menu and the app menu's ⌘N, so they
/// cannot drift apart.
pub fn request_new_session<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Emitter as _;

    reveal_main_and_hide_tray(app);
    let _ = app.emit("new-session", ());
}

/// Reveal the app and ask the frontend to open Settings. The one way in for
/// the popover's gear and the tray menu's Preferences.
pub fn request_preferences<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Emitter as _;

    reveal_main_and_hide_tray(app);
    let _ = app.emit("open-preferences", ());
}

/// The popover's New session button: see [`request_new_session`].
///
/// # Errors
/// Infallible today; returns `Result` for command-signature uniformity.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn new_session(app: tauri::AppHandle) -> Result<(), String> {
    request_new_session(&app);
    Ok(())
}

/// The popover's gear: see [`request_preferences`].
///
/// # Errors
/// Infallible today; returns `Result` for command-signature uniformity.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn open_preferences(app: tauri::AppHandle) -> Result<(), String> {
    request_preferences(&app);
    Ok(())
}

/// Quit the whole app — the same exit the tray's "Quit Kriyon" runs.
///
/// The frontend owns the close gate (a running Project terminal or a session
/// mid-turn asks first), so the window's close button routes here once that
/// gate clears, carrying what the user chose for the sessions still alive. The
/// stopping itself happens in `RunEvent::Exit` (see
/// [`crate::quit::stop_sessions_on_exit`]) — process control belongs to Rust,
/// and the frontend only knows about the panes it happens to have mounted.
///
/// It cannot use the JS `window.destroy()`: that only destroys the window,
/// leaving the app alive behind the tray with no way to rebuild the main window,
/// and it is not granted by the capability ACL anyway.
///
/// # Errors
/// Returns an error string if `intent` is not one a quit gesture may choose.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn quit_app(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    intent: kriyon_core::quit::QuitIntent,
) -> Result<(), String> {
    if !intent.is_user_choice() {
        return Err("not a quit the user can choose".to_string());
    }
    *state.quit_intent.lock() = intent;
    app.exit(0);
    Ok(())
}

/// A complete, self-contained render row for one session in the menu-bar
/// popover: current live status + open ask + the display fields (title, project,
/// branch) resolved from the store. The tray draws straight from these on each
/// poll, so it never depends on a pre-seeded frontend store or on catching the
/// `session-status` event stream from the moment a session changes.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    session_id: String,
    title: String,
    project_name: String,
    branch: Option<String>,
    status: kriyon_core::session::SessionStatus,
    summary: String,
    pending_ask: Option<kriyon_core::ask::PendingAsk>,
    /// Whether this session needs the user, computed once in the backend via
    /// [`kriyon_core::tray_badge::session_needs_you`]. The popover partitions on
    /// this flag instead of re-deriving the rule, so the tray rows and the
    /// menu-bar badge count can never diverge.
    needs_you: bool,
    /// The session's latest [Session footprint] in MB, or `None` before the
    /// first sample lands.
    memory_mb: Option<u64>,
}

/// What the tray polls: one row per live session plus the whole-app
/// [Session footprint] total.
///
/// The total rides along rather than being re-summed from the rows, because
/// the two are drawn from different maps — rows come from the [Session
/// runtime] map, the total from the memory sampler's sweep over the sessions
/// map — and a session present in one but not the other would make a
/// client-side sum quietly disagree with the number the [Memory budget]
/// warning uses.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySnapshot {
    pub sessions: Vec<SessionSnapshot>,
    pub total_memory_mb: u64,
    /// Whole-app CPU percent (of one core) from the same sweep, or `None`
    /// until the sampler has two samples to diff.
    pub total_cpu_pct: Option<f64>,
}

/// Current live status + open ask + display fields for every tracked session,
/// built from the [Session runtime] map and the store. Reflects what the
/// sidebar shows right now (not the persisted rows, which are always idle).
/// The tray polls this so an already-running/waiting session shows its real
/// state regardless of when the popover's webview initialized.
///
/// # Errors
/// Infallible today; returns `Result` for command-signature uniformity.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn session_snapshots(
    state: tauri::State<'_, AppState>,
    store: tauri::State<'_, StoreState>,
) -> Result<TraySnapshot, String> {
    Ok(session_snapshots_inner(&state, &store))
}

/// The assembly behind [`session_snapshots`], taking plain state references so
/// it is testable without a Tauri app: one pass over the runtimes map (status,
/// summary, ask, and the `needs_you` flag all come off the same
/// [Session runtime]), joined with each session's [Session identity].
fn session_snapshots_inner(state: &AppState, store: &StoreState) -> TraySnapshot {
    let live: Vec<(
        SessionId,
        kriyon_core::session::SessionStatus,
        String,
        Option<kriyon_core::ask::PendingAsk>,
        bool,
    )> = {
        let runtimes = state.runtimes.lock();
        runtimes
            .iter()
            .map(|(id, rt)| {
                (
                    id.clone(),
                    rt.status(),
                    rt.summary().to_string(),
                    rt.ask().cloned(),
                    rt.needs_you(),
                )
            })
            .collect()
    };
    // Resolve display fields from the store (title, project name, branch).
    let (rows, projects) = {
        let store = store.0.lock();
        (
            store.list_sessions().unwrap_or_default(),
            store.list_projects().unwrap_or_default(),
        )
    };
    let memory = state.memory.lock().clone();
    let sessions = live
        .into_iter()
        .map(|(id, status, summary, pending_ask, needs_you)| {
            let identity = crate::store::session_identity(&rows, &projects, &id.0);
            let title = identity
                .as_ref()
                .map_or_else(|| id.0.clone(), |i| i.title.clone());
            let project_name = identity
                .as_ref()
                .map(|i| i.project.clone())
                .unwrap_or_default();
            let branch = identity.and_then(|i| i.branch);
            SessionSnapshot {
                memory_mb: memory.per_session.get(&id.0).map(|row| row.memory_mb),
                session_id: id.0,
                title,
                project_name,
                branch,
                status,
                summary,
                pending_ask,
                needs_you,
            }
        })
        .collect();
    TraySnapshot {
        sessions,
        total_memory_mb: memory.total_mb,
        total_cpu_pct: memory.total_cpu_pct,
    }
}

#[cfg(test)]
mod tests {
    use super::read_clipboard;

    #[test]
    #[ignore = "requires a real system pasteboard; run locally on macOS"]
    fn read_clipboard_round_trips_a_set_value() {
        let mut cb = arboard::Clipboard::new().expect("clipboard");
        cb.set_text("kriyon-clip-probe".to_string()).expect("set");
        assert_eq!(read_clipboard().expect("read"), "kriyon-clip-probe");
    }
}

#[cfg(test)]
mod tray_command_tests {
    use super::{session_is_known, session_snapshots_inner};
    use crate::store::{ProjectRow, SessionRow, Store};
    use crate::{AppState, StoreState};
    use kriyon_core::hooks::HookEvent;
    use kriyon_core::runtime::SessionRuntime;
    use kriyon_core::session::{SessionId, SessionStatus};
    use parking_lot::Mutex;
    use std::time::Instant;

    #[test]
    fn known_id_is_recognized_unknown_is_not() {
        let state = AppState::default();
        // An empty session map: nothing is known. This is the security-relevant
        // path — an unknown id must never be trusted by a navigation command.
        assert!(!session_is_known(&state, &SessionId("ghost".into())));
    }

    #[test]
    fn snapshot_rows_carry_identity_status_ask_and_needs_you() {
        // The tray's whole data model, assembled without a Tauri app: a blocked
        // session (permission ask) and an idle one, joined with their store
        // identities. The needs_you flag comes off the same runtime the status
        // does, so a row can never disagree with the badge rule.
        let state = AppState::default();
        {
            let mut runtimes = state.runtimes.lock();
            let mut blocked = SessionRuntime::new();
            let now = Instant::now();
            blocked.note_hook_event(&HookEvent {
                event: "Notification".to_string(),
                session_id: Some("c1".to_string()),
                message: Some("Claude needs your permission to use Bash".to_string()),
                ..HookEvent::default()
            });
            let _ = blocked.apply_recompute(now);
            let _ = blocked.set_ask(Some(kriyon_core::ask::PendingAsk {
                kind: kriyon_core::ask::AskKind::Permission,
                text: "Claude needs your permission to use Bash".to_string(),
                asked_at: None,
            }));
            runtimes.insert(SessionId("s-blocked".to_string()), blocked);
            runtimes.insert(SessionId("s-idle".to_string()), SessionRuntime::new());
        }

        let store = Store::open_in_memory().expect("store");
        store
            .upsert_project(&ProjectRow {
                id: "p1".to_string(),
                name: "kriyon".to_string(),
                path: "/tmp".to_string(),
                color: None,
                setup_command: None,
                parked_at: None,
            })
            .expect("project");
        store
            .upsert_session(&SessionRow {
                id: "s-blocked".to_string(),
                project_id: "p1".to_string(),
                title: "Fix the badge".to_string(),
                cwd: "/tmp".to_string(),
                worktree_path: None,
                created_at: 0,
                claude_session_id: None,
                archived_at: None,
                baseline_oid: None,
                title_locked: false,
                parent_session_id: None,
                nested_under: None,
            })
            .expect("session");
        let store = StoreState(Mutex::new(store));

        let mut rows = session_snapshots_inner(&state, &store).sessions;
        rows.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        assert_eq!(rows.len(), 2);

        let blocked = &rows[0];
        assert_eq!(blocked.session_id, "s-blocked");
        assert_eq!(blocked.title, "Fix the badge");
        assert_eq!(blocked.project_name, "kriyon");
        assert_eq!(blocked.status, SessionStatus::Waiting);
        assert!(blocked.pending_ask.is_some());
        assert!(blocked.needs_you);

        let idle = &rows[1];
        assert_eq!(idle.status, SessionStatus::Idle);
        assert!(!idle.needs_you, "an idle session must not count");
        // No store row: the id doubles as the title, never an empty render.
        assert_eq!(idle.title, "s-idle");
    }

    #[test]
    fn the_snapshot_total_is_the_sweeps_total_not_a_re_sum_of_rows() {
        // TraySnapshot exists so the tray's headline number is the authoritative
        // whole-app total (which counts sessions with no runtime row, e.g.
        // project terminals), never a client-side re-sum of the rows. Seed a
        // sweep whose total exceeds its row and assert the snapshot carries it.
        let state = AppState::default();
        state
            .runtimes
            .lock()
            .insert(SessionId("s1".to_string()), SessionRuntime::new());
        {
            let mut memory = state.memory.lock();
            memory.per_session.insert(
                "s1".to_string(),
                kriyon_core::memory::SessionResources {
                    memory_mb: 400,
                    cpu_pct: None,
                },
            );
            // 900 total > the 400 charged to the one row with a runtime: the
            // extra 500 is a session the tray rows don't include.
            memory.total_mb = 900;
        }
        let store = StoreState(Mutex::new(Store::open_in_memory().expect("store")));

        let snapshot = session_snapshots_inner(&state, &store);
        assert_eq!(snapshot.total_memory_mb, 900, "carries the sweep total");
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].memory_mb, Some(400));
        assert!(
            snapshot.total_memory_mb
                > snapshot
                    .sessions
                    .iter()
                    .filter_map(|s| s.memory_mb)
                    .sum::<u64>(),
            "the total is not a re-sum of the rows"
        );
    }
}

#[cfg(test)]
mod intent_tests {
    use super::{request_new_session, request_preferences};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tauri::Listener as _;

    /// Count how many times `event` reaches the app while `run` executes.
    fn emits(event: &str, run: impl FnOnce(&tauri::AppHandle<tauri::test::MockRuntime>)) -> usize {
        let app = tauri::test::mock_app();
        let seen = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&seen);
        app.listen_any(event, move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        run(app.handle());
        seen.load(Ordering::SeqCst)
    }

    // The tray menu, the popover and the app menu all go through these, so
    // each must reach the event the main window installs its handler on.
    #[test]
    fn new_session_reaches_the_main_windows_new_session_handler() {
        assert_eq!(emits("new-session", request_new_session), 1);
    }

    #[test]
    fn preferences_reaches_the_main_windows_open_preferences_handler() {
        assert_eq!(emits("open-preferences", request_preferences), 1);
    }
}
