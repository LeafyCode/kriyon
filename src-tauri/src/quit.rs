//! Quitting: routing the gesture through the frontend's close gate, and carrying
//! out the [Quit intent] on the way out.

use std::collections::HashSet;

use kriyon_core::proc::daemon_session_id;
use kriyon_core::quit::QuitIntent;
use tauri::Manager as _;

use crate::AppState;

/// Ask to quit the way the window's close button does: close the main window,
/// which raises `close-requested` in the webview, where the gate decides whether
/// live work — a Project terminal running a process, a session mid-turn — needs
/// a confirmation first (see `terminal/closeOnQuit`). The gate owns the outcome
/// from there, and quits via the `quit_app` command once it is satisfied.
///
/// This is why the macOS app menu's Quit is a custom item rather than
/// [`tauri::menu::PredefinedMenuItem::quit`]: that one sends `terminate:`
/// straight to the window server, and tao offers no cancellable `applicationShouldTerminate`
/// hook, so neither the gate nor `RunEvent::ExitRequested` would ever see it.
/// Quitting from the Dock icon's menu sends the same message and so stays
/// ungated — the one quit gesture that cannot ask. It still reaches
/// `RunEvent::Exit`, so [`stop_sessions_on_exit`] still runs for it.
///
/// With no main window there is nothing to gate, so exit directly.
pub fn request_quit(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.close();
    } else {
        app.exit(0);
    }
}

/// Carry out the [Quit intent] as the app exits. Called from `RunEvent::Exit` —
/// the one event every orderly exit reaches on macOS, gated or not (⌘Q, the
/// Dock's Quit and a logout all skip `ExitRequested`). A crash reaches nothing,
/// which is the [Handover] that lets the next launch reattach.
///
/// It only *writes frames*: each daemon runs its own [Tree stop] after the app
/// is gone, so the exit is never held up waiting for a process to die. Nothing
/// here may block or ask — a dialog on this path once hung another terminal
/// through a macOS update.
pub fn stop_sessions_on_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    let intent = *state.quit_intent.lock();
    if intent == QuitIntent::Handover {
        return;
    }

    // Past the `Handover` guard the intent is `StopAll`, which spares nothing:
    // a quit is a quit, and the gate already asked whether to go through with it.
    debug_assert!(!intent.spares());
    let survey = crate::status_rt::process_table();
    let tree = survey.as_ref().map(crate::status_rt::ProcessSurvey::tree);

    // Clone the handles out so no lock is held across a socket write.
    let attached: Vec<(String, std::sync::Arc<crate::daemon_client::DaemonClient>)> = state
        .sessions
        .lock()
        .iter()
        .map(|(id, session)| (id.0.clone(), std::sync::Arc::clone(&session.engine)))
        .collect();
    // Whether this instance may stop a daemon it does not provably hold. A dev
    // build beside the installed app shares its run dir; its quit must never
    // reach the installed app's sessions.
    let owns_run_dir = crate::daemon_rt::owns_run_dir(app);
    for (_id, engine) in &attached {
        crate::daemon_rt::stop_held(owns_run_dir, engine);
    }

    // A live daemon in this app's run dir that no client holds — adoption
    // missed it, or it was never reachable — still has to be told. By the owner
    // only: to anyone else, such a daemon is simply another instance's session.
    if !owns_run_dir {
        return;
    }
    let (Some(tree), Some(run)) = (tree.as_ref(), crate::daemon_rt::resolve_run_dir(app)) else {
        return;
    };
    let held: HashSet<&str> = attached.iter().map(|(id, _)| id.as_str()).collect();
    let run_str = run.to_string_lossy();
    for daemon in tree.daemons() {
        let Some(id) = daemon_session_id(daemon, &run_str) else {
            continue;
        };
        if !held.contains(id.as_str()) {
            crate::daemon_rt::stop_unattached(&run, &id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_client::test_support::spawn_greeting_daemon;
    use crate::daemon_client::DaemonClient;
    use crate::store::Store;
    use crate::{Session, StoreState};
    use kriyon_core::hooks::HookEvent;
    use kriyon_core::session::{SessionId, SessionStatus};
    use parking_lot::Mutex;
    use std::os::unix::net::UnixStream;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::{Duration, Instant};

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(AppState::default());
        app.manage(StoreState(Mutex::new(
            Store::open_in_memory().expect("in-memory store"),
        )));
        app
    }

    /// A fake daemon that greets its client (as the real one does — a client
    /// that was never greeted is never told to stop anything) and counts the
    /// `Shutdown` frames it reads.
    fn fake_daemon(dir: &std::path::Path, name: &str) -> (std::path::PathBuf, Arc<StdMutex<u32>>) {
        let socket = dir.join(format!("{name}.sock"));
        let shutdowns = spawn_greeting_daemon(&socket);
        (socket, shutdowns)
    }

    fn attach(app: &tauri::App<tauri::test::MockRuntime>, id: &str, socket: &std::path::Path) {
        let stream = UnixStream::connect(socket).expect("connect");
        let engine = DaemonClient::adopt(stream, SessionId(id.into())).expect("client");
        assert!(engine.wait_accepted(Duration::from_secs(2)), "greeted");
        app.state::<AppState>().sessions.lock().insert(
            SessionId(id.into()),
            Session {
                engine: Arc::new(engine),
                zdotdir: None,
            },
        );
    }

    /// Give `id` a [Session runtime] that is mid-turn.
    fn mark_running(app: &tauri::App<tauri::test::MockRuntime>, id: &str) {
        let mut event = HookEvent {
            event: "PreToolUse".to_string(),
            session_id: Some("claude-1".to_string()),
            ..HookEvent::default()
        };
        event.tool_name = Some("Bash".to_string());
        let mut runtime = kriyon_core::runtime::SessionRuntime::new();
        let now = Instant::now();
        runtime.note_hook_event(&event);
        runtime.apply_recompute(now);
        assert_eq!(runtime.status(), SessionStatus::Running);
        app.state::<AppState>()
            .runtimes
            .lock()
            .insert(SessionId(id.into()), runtime);
    }

    fn settled(shutdowns: &StdMutex<u32>) -> bool {
        // The frame crosses a socket to another thread; give it a beat.
        let asked = || *shutdowns.lock().expect("lock") > 0;
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline && !asked() {
            std::thread::sleep(Duration::from_millis(10));
        }
        asked()
    }

    #[test]
    fn an_exit_nobody_chose_anything_for_stops_every_session() {
        // The Dock's Quit never passes the gate, so no intent is ever set.
        let dir = tempfile::tempdir().expect("tmp dir");
        let app = mock_app();
        let (idle_socket, idle_asked) = fake_daemon(dir.path(), "idle");
        let (busy_socket, busy_asked) = fake_daemon(dir.path(), "busy");
        attach(&app, "idle", &idle_socket);
        attach(&app, "busy", &busy_socket);
        mark_running(&app, "busy");

        stop_sessions_on_exit(app.handle());

        assert!(settled(&idle_asked));
        assert!(
            settled(&busy_asked),
            "StopAll spares nothing, mid-turn or not"
        );
    }

    #[test]
    fn a_chosen_quit_stops_the_session_mid_turn_too() {
        // The gate's only choice is whether to quit at all. Once the user has
        // chosen to, nothing is left behind to finish on its own.
        let dir = tempfile::tempdir().expect("tmp dir");
        let app = mock_app();
        let (idle_socket, idle_asked) = fake_daemon(dir.path(), "idle");
        let (busy_socket, busy_asked) = fake_daemon(dir.path(), "busy");
        attach(&app, "idle", &idle_socket);
        attach(&app, "busy", &busy_socket);
        mark_running(&app, "busy");
        *app.state::<AppState>().quit_intent.lock() = QuitIntent::StopAll;

        stop_sessions_on_exit(app.handle());

        assert!(settled(&idle_asked));
        assert!(settled(&busy_asked), "a quit stops a turn in flight too");
    }

    #[test]
    fn a_handover_sends_nothing_at_all() {
        let dir = tempfile::tempdir().expect("tmp dir");
        let app = mock_app();
        let (socket, asked) = fake_daemon(dir.path(), "any");
        attach(&app, "any", &socket);
        *app.state::<AppState>().quit_intent.lock() = QuitIntent::Handover;

        stop_sessions_on_exit(app.handle());

        assert!(
            !settled(&asked),
            "an update restart must not touch sessions"
        );
    }
}
