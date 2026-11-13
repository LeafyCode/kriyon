//! The app as [`crate::remote_serve`] sees it: its sessions, their gates, and
//! whether a remote device looks on.

use kriyon_core::cli_dialog::dialog_showing;
use kriyon_core::session::SessionId;
use kriyon_remote::authorize::{Dialog, PendingWrite};
use kriyon_remote::control::{Change, HostIsTyping};
use kriyon_remote::message::{EndpointId, RefuseReason, Role, SessionInfo};
use tauri::Manager as _;

use crate::daemon_client::DaemonEvent;
use crate::remote_serve::{LiveSession, Serve, ServeHost};
use crate::{AppState, StoreState};

/// How many times a snapshot ask is tried, [`ASK_RETRY`] apart.
const ASK_TRIES: u32 = 40;
const ASK_RETRY: std::time::Duration = std::time::Duration::from_millis(50);

/// Session `id` served while its start is under way: unless [`Self::keep`]
/// is called, dropping it stops serving it, so a failed start leaves nothing
/// registered.
pub struct Attached {
    app: tauri::AppHandle,
    id: SessionId,
    kept: bool,
}

impl Attached {
    /// The start succeeded: keep serving it.
    pub fn keep(mut self) {
        self.kept = true;
    }
}

impl Drop for Attached {
    fn drop(&mut self) {
        if !self.kept {
            detach(&self.app, &self.id);
        }
    }
}

/// A newly registered client for session `id`: tell it a remote device
/// looks on, if one has the session open (a wake or a reattach while a
/// device watches).
pub fn note_engine(
    app: &tauri::AppHandle,
    id: &SessionId,
    engine: &crate::daemon_client::DaemonClient,
) {
    if app
        .try_state::<Serve>()
        .is_some_and(|serve| serve.is_onlooked(&id.0))
    {
        engine.set_remote_onlooker(true);
    }
}

/// Serve session `id` to remote devices, before its daemon client is built:
/// the daemon names its run in its first frame. Snapshot requests go out on
/// the blocking pool, so the daemon reader that makes them never takes the
/// sessions lock (a close can hold it while joining that reader).
#[must_use = "dropping it stops serving the session"]
pub fn attach(app: &tauri::AppHandle, id: &SessionId) -> Attached {
    let attached = Attached {
        app: app.clone(),
        id: id.clone(),
        kept: false,
    };
    let Some(serve) = app.try_state::<Serve>() else {
        return attached;
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
                // A new run's ask can come before its client is registered;
                // asked again for a moment rather than lost, which would
                // leave the device waiting for a snapshot nobody makes.
                for _ in 0..ASK_TRIES {
                    let engine = app
                        .state::<AppState>()
                        .sessions
                        .lock()
                        .get(&id)
                        .map(|session| std::sync::Arc::clone(&session.engine));
                    if engine.is_some_and(|engine| engine.request_snapshot(requester).is_ok()) {
                        return;
                    }
                    std::thread::sleep(ASK_RETRY);
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
    attached
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

/// The person typed at the host into session `id`: if that took typing
/// control back from a device, every device hears it.
pub fn host_took<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &SessionId,
    took: &kriyon_remote::writer::HostTook,
) {
    if let (Some(change), Some(serve)) = (took.change, app.try_state::<Serve>()) {
        serve.broadcast_control(&id.0, change);
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

impl AppServeHost {
    /// Session `id`'s daemon client, cloned out from under the sessions lock.
    fn engine(&self, id: &SessionId) -> Option<std::sync::Arc<crate::daemon_client::DaemonClient>> {
        self.0
            .state::<AppState>()
            .sessions
            .lock()
            .get(id)
            .map(|session| std::sync::Arc::clone(&session.engine))
    }
}

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

    fn device_input(
        &self,
        id: &str,
        device: &EndpointId,
        role: Role,
        write: &PendingWrite,
        bytes: &[u8],
    ) -> Result<bool, RefuseReason> {
        let id = SessionId(id.to_string());
        let engine = self.engine(&id).ok_or(RefuseReason::NoSuchSession)?;
        self.0.state::<AppState>().writers.device_input(
            &id,
            &engine,
            device,
            Some(role),
            write,
            bytes,
        )
    }

    fn device_resize(
        &self,
        id: &str,
        device: &EndpointId,
        role: Role,
        write: &PendingWrite,
        size: (u16, u16),
    ) -> Result<(), RefuseReason> {
        let id = SessionId(id.to_string());
        let engine = self.engine(&id).ok_or(RefuseReason::NoSuchSession)?;
        self.0.state::<AppState>().writers.device_resize(
            &id,
            &engine,
            device,
            Some(role),
            write,
            size,
        )
    }

    fn take(&self, id: &str, device: EndpointId) -> Result<Option<Change>, HostIsTyping> {
        self.0.state::<AppState>().writers.take(
            &SessionId(id.to_string()),
            device,
            std::time::Instant::now(),
        )
    }

    fn release(&self, device: &EndpointId) -> Vec<(String, Change)> {
        let state = self.0.state::<AppState>();
        let engines: Vec<(
            SessionId,
            std::sync::Arc<crate::daemon_client::DaemonClient>,
        )> = state
            .sessions
            .lock()
            .iter()
            .map(|(id, session)| (id.clone(), std::sync::Arc::clone(&session.engine)))
            .collect();
        state
            .writers
            .release_device(device, &engines)
            .into_iter()
            .filter_map(|(id, took)| Some((id.0, took.change?)))
            .collect()
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
