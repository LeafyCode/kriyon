//! The app as [`crate::remote_serve`] sees it: its sessions, their gates, and
//! whether a remote device looks on.

use kriyon_core::cli_dialog::dialog_showing;
use kriyon_core::session::SessionId;
use kriyon_remote::authorize::Dialog;
use kriyon_remote::message::SessionInfo;
use tauri::Manager as _;

use crate::daemon_client::DaemonEvent;
use crate::remote_serve::{LiveSession, Serve, ServeHost};
use crate::{AppState, StoreState};

/// Serve session `id` to remote devices, before its daemon client is built:
/// the daemon names its run in its first frame. Snapshot requests go out on
/// the blocking pool, so the daemon reader that makes them never takes the
/// sessions lock (a close can hold it while joining that reader).
pub fn attach(app: &tauri::AppHandle, id: &SessionId) {
    let Some(serve) = app.try_state::<Serve>() else {
        return;
    };
    let ask_app = app.clone();
    let ask_id = id.clone();
    let size_app = app.clone();
    let size_id = id.clone();
    serve.attach(
        &id.0,
        move |requester| {
            let app = ask_app.clone();
            let id = ask_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let engine = app
                    .state::<AppState>()
                    .sessions
                    .lock()
                    .get(&id)
                    .map(|session| std::sync::Arc::clone(&session.engine));
                if let Some(engine) = engine {
                    let _ = engine.request_snapshot(requester);
                }
            });
        },
        move || {
            size_app
                .state::<AppState>()
                .writers
                .facts(&size_id)
                .map_or(crate::session_writer::DEFAULT_SCREEN, |facts| facts.size)
        },
    );
}

/// One event from session `id`'s daemon, for remote devices and the
/// session's gate: its run, and where a dialog changed.
pub fn on_event(app: &tauri::AppHandle, id: &SessionId, event: DaemonEvent<'_>) {
    let Some(serve) = app.try_state::<Serve>() else {
        return;
    };
    let note = serve.on_event(&id.0, event);
    let state = app.state::<AppState>();
    if let Some(run) = note.run {
        state.writers.set_run(id, run);
    }
    if let Some((dialog, at)) = note.dialog {
        let ask = state
            .runtimes
            .lock()
            .get(id)
            .and_then(|runtime| runtime.ask().cloned());
        state.writers.set_dialog(
            id,
            Dialog {
                showing: dialog_showing(dialog.open, ask.as_ref()),
                changed_at_seq: Some(at),
            },
        );
    }
}

/// Stop serving session `id`: it closed.
pub fn detach(app: &tauri::AppHandle, id: &SessionId) {
    if let Some(serve) = app.try_state::<Serve>() {
        serve.detach(&id.0);
    }
}

/// [`ServeHost`] over the running app.
pub struct AppServeHost(pub tauri::AppHandle);

impl ServeHost for AppServeHost {
    fn host_name(&self) -> String {
        crate::remote_cmd::host_name()
    }

    fn sessions(&self) -> Vec<SessionInfo> {
        let state = self.0.state::<AppState>();
        let store = self.0.state::<StoreState>();
        crate::session_list_rt::current(&state, &store)
            .map(|list| list.into_iter().map(SessionInfo::from).collect())
            .unwrap_or_default()
    }

    fn session(&self, id: &str) -> Option<LiveSession> {
        let facts = self
            .0
            .state::<AppState>()
            .writers
            .facts(&SessionId(id.to_string()))?;
        Some(LiveSession {
            run: facts.run,
            control: facts.control,
            dialog: facts.dialog,
            size: facts.size,
        })
    }

    fn set_onlooked(&self, id: &str, onlooked: bool) {
        let engine = self
            .0
            .state::<AppState>()
            .sessions
            .lock()
            .get(&SessionId(id.to_string()))
            .map(|session| std::sync::Arc::clone(&session.engine));
        if let Some(engine) = engine {
            engine.set_remote_onlooker(onlooked);
        }
    }
}
