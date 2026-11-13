//! Starting a [Session], one way for everyone: save its rows, then open its
//! shell, then launch `claude` (architecture review #3). The desktop and a
//! [Remote device] differ only in where the shell's output goes: a
//! [`SessionSink`].
//!
//! - The desktop window's sink is its three IPC channels ([`WindowSink`]).
//! - A session a device started has no window yet: [`NoViewer`] drops its
//!   output unpaced (devices are served from the daemon's events anyway). When
//!   the person opens it, the window's sink replaces it in the session's
//!   [`SinkSlot`] and the window is sent the screen.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;

/// Where a session's shell output, foreground-busy changes and death go.
pub trait SessionSink: Send + Sync + 'static {
    /// Output for a window, paced by its `report_drained`.
    fn output(&self, bytes: Vec<u8>);
    /// A command started or stopped in the shell.
    fn busy(&self, busy: bool);
    /// The shell exited or its daemon died, underneath the app.
    fn exited(&self);
    /// Whether a window shows this output, and so reports it drained. Output
    /// for no window must not be held for one.
    fn viewer(&self) -> bool {
        true
    }
}

/// No window shows the session yet.
pub struct NoViewer;

impl SessionSink for NoViewer {
    fn output(&self, _bytes: Vec<u8>) {}
    fn busy(&self, _busy: bool) {}
    fn exited(&self) {}
    fn viewer(&self) -> bool {
        false
    }
}

/// The desktop window's three channels.
pub struct WindowSink {
    pub output: tauri::ipc::Channel<Vec<u8>>,
    pub busy: tauri::ipc::Channel<bool>,
    pub exit: tauri::ipc::Channel<bool>,
}

impl SessionSink for WindowSink {
    fn output(&self, bytes: Vec<u8>) {
        let _ = self.output.send(bytes);
    }
    fn busy(&self, busy: bool) {
        let _ = self.busy.send(busy);
    }
    fn exited(&self) {
        let _ = self.exit.send(true);
    }
}

/// One session client's sink, which a window can take over, and whether the
/// shell behind it died.
pub struct SinkSlot {
    sink: RwLock<Arc<dyn SessionSink>>,
    exited: AtomicBool,
}

impl SinkSlot {
    #[must_use]
    pub fn new(sink: Arc<dyn SessionSink>) -> Self {
        Self {
            sink: RwLock::new(sink),
            exited: AtomicBool::new(false),
        }
    }

    /// The sink now.
    #[must_use]
    pub fn sink(&self) -> Arc<dyn SessionSink> {
        Arc::clone(&self.sink.read())
    }

    /// Hand the session's output to `sink` from now on.
    pub fn replace(&self, sink: Arc<dyn SessionSink>) {
        *self.sink.write() = sink;
    }

    pub fn output(&self, bytes: Vec<u8>) {
        self.sink().output(bytes);
    }

    pub fn busy(&self, busy: bool) {
        self.sink().busy(busy);
    }

    /// The shell died: told once, to the sink then.
    pub fn exited(&self) {
        if !self.exited.swap(true, Ordering::AcqRel) {
            self.sink().exited();
        }
    }

    /// Whether the shell behind it died; a new client is needed.
    #[must_use]
    pub fn is_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }
}

/// What starting a session came to.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    /// The shell was already running: reattached, or taken over.
    pub reattached: bool,
    /// The git baseline captured for its Changes view, when one was asked
    /// for and the folder is a repository (never the home folder).
    pub baseline_oid: Option<String>,
}

/// Start a session from the desktop: save its rows (its project's first,
/// when given), then open its shell with the window's channels, capturing
/// its git baseline at the same time when `baseline`. It returns once both
/// are done, so `claude`, launched after (`launch_claude`), never edits the
/// tree before the baseline is taken. One ordering, here, so no shell
/// starts before the rows that approve its folder.
///
/// # Errors
/// An invalid id, a refused folder or failed save, or why the shell
/// couldn't open.
#[tauri::command]
pub async fn start_session(
    app: tauri::AppHandle,
    project: Option<crate::store::ProjectRow>,
    session: crate::store::SessionRow,
    baseline: bool,
    on_output: tauri::ipc::Channel<Vec<u8>>,
    on_busy: tauri::ipc::Channel<bool>,
    on_exit: tauri::ipc::Channel<bool>,
) -> Result<Started, String> {
    let sink = Arc::new(WindowSink {
        output: on_output,
        busy: on_busy,
        exit: on_exit,
    });
    start(&app, project, session, baseline, sink).await
}

/// Save the rows, then open the shell into `sink`, capturing the baseline
/// alongside when asked: the one start, for the desktop and a device.
///
/// # Errors
/// As [`start_session`].
pub async fn start(
    app: &tauri::AppHandle,
    project: Option<crate::store::ProjectRow>,
    mut session: crate::store::SessionRow,
    baseline: bool,
    sink: Arc<dyn SessionSink>,
) -> Result<Started, String> {
    if !kriyon_core::daemon::is_valid_session_id(&session.id) {
        return Err("invalid session id".to_string());
    }
    let saving = (app.clone(), session.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let (app, session) = saving;
        crate::store_cmd::save_rows(&app, project.as_ref(), &session)
    })
    .await
    .map_err(|e| e.to_string())??;
    let capture = baseline.then(|| {
        let (app, cwd) = (app.clone(), session.cwd.clone());
        tauri::async_runtime::spawn_blocking(move || {
            use tauri::Manager as _;
            crate::git_cmd::capture_baseline(&app, &app.state::<crate::StoreState>(), &cwd).ok()
        })
    });
    let opened =
        crate::commands::open_session(app, session.id.clone(), session.cwd.clone(), sink).await;
    let baseline_oid = match capture {
        Some(capture) => capture.await.ok().flatten(),
        None => None,
    };
    let reattached = opened?;
    if let Some(oid) = &baseline_oid {
        use tauri::Manager as _;
        session.baseline_oid = Some(oid.clone());
        // Kept with the row; the window records it too.
        let _ = app
            .state::<crate::StoreState>()
            .0
            .lock()
            .upsert_session(&session);
    }
    Ok(Started {
        reattached,
        baseline_oid,
    })
}

/// The remote starts under way, one lock each by (device, request), so a
/// resend that arrives while the first is still starting waits for it and
/// finds the session it made, while other starts go ahead.
static STARTING: std::sync::LazyLock<parking_lot::Mutex<Starting>> =
    std::sync::LazyLock::new(Default::default);

/// One lock for each (device, request) start under way.
type Starting = std::collections::HashMap<([u8; 32], [u8; 16]), Arc<tokio::sync::Mutex<()>>>;

/// The event that tells the window a session was started without it (by a
/// [Remote device]): the session's row, for its sidebar.
pub const SESSION_ADDED_EVENT: &str = "session-added";

/// Start a session as paired `device` asked (`StartSession`, its check
/// passed): in the project's folder, titled as asked or after the project,
/// never in a worktree, with a fresh `claude`. A resend of the same
/// `request_id` within a day gets the answer the first one got (spec §4):
/// the request is recorded before the shell opens; if the shell doesn't
/// open, the session's row goes and the request stays failed, so a resend
/// is refused the same way and never starts a session nobody waits for. The window hears of it
/// ([`SESSION_ADDED_EVENT`]) and shows it in its sidebar; opening it there
/// takes over its output.
///
/// # Errors
/// [`RefuseReason::NoSuchProject`] or [`RefuseReason::FolderNotAllowed`]
/// when the project changed since the check, or
/// [`RefuseReason::StartFailed`] when the store couldn't be read or written
/// or the shell didn't open.
pub async fn start_remote(
    app: tauri::AppHandle,
    device: kriyon_remote::message::EndpointId,
    request: crate::remote_serve::RemoteStart,
) -> Result<String, kriyon_remote::message::RefuseReason> {
    let key = (device, request.request_id);
    let lock = Arc::clone(STARTING.lock().entry(key).or_default());
    let started = {
        let _this_request = lock.lock().await;
        start_remote_once(&app, device, request).await
    };
    // Gone once no one else waits on it.
    let mut starting = STARTING.lock();
    if starting
        .get(&key)
        .is_some_and(|held| Arc::strong_count(held) <= 2)
    {
        starting.remove(&key);
    }
    started
}

async fn start_remote_once(
    app: &tauri::AppHandle,
    device: kriyon_remote::message::EndpointId,
    request: crate::remote_serve::RemoteStart,
) -> Result<String, kriyon_remote::message::RefuseReason> {
    use crate::remote_serve::ServeHost as _;
    use kriyon_remote::message::RefuseReason;
    use tauri::{Emitter as _, Manager as _};
    let now = crate::remote_rt::now_ms();
    let request_id = request.request_id;
    // The store and the folder check touch the disk: off the runtime.
    let looking = (app.clone(), request.project_id.clone());
    let (made, project) = tauri::async_runtime::spawn_blocking(move || {
        let (app, project_id) = looking;
        let host = crate::remote_host_rt::AppServeHost(app.clone());
        if let Some(made) = host.started(&device, &request_id) {
            return Ok((Some(made), None));
        }
        // Checked again here: the project may have changed since the check.
        host.project_folder(&project_id).allows()?;
        let project = app
            .state::<crate::StoreState>()
            .0
            .lock()
            .project_row(&project_id)
            .map_err(|_| RefuseReason::StartFailed)?
            .ok_or(RefuseReason::NoSuchProject)?;
        Ok((None, Some(project)))
    })
    .await
    .map_err(|_| RefuseReason::StartFailed)??;
    if let Some(made) = made {
        return made;
    }
    let Some(project) = project else {
        return Err(RefuseReason::StartFailed);
    };
    let session = remote_session_row(&project, request.title, now);
    let id = session.id.clone();
    // Recorded first, so a resend while the shell opens, or after a crash,
    // finds this session instead of starting a second.
    let recording = (app.clone(), id.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let (app, id) = recording;
        let store = app.state::<crate::StoreState>();
        let store = store.0.lock();
        let _ = store.prune_remote_starts(now);
        store.record_remote_start(&device, &request_id, &id, now)
    })
    .await
    .map_err(|_| RefuseReason::StartFailed)?
    .map_err(|_| RefuseReason::StartFailed)?;
    let started = match start(app, None, session.clone(), true, Arc::new(NoViewer)).await {
        Ok(started) => started,
        Err(why) => {
            eprintln!("kriyon: a remote start failed: {why}");
            // Nothing started: no row stays behind, and the request stays
            // failed for the day, so a resend is refused the same way
            // rather than starting a session nobody waits for.
            let failing = (app.clone(), id.clone());
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let (app, id) = failing;
                let store = app.state::<crate::StoreState>();
                let store = store.0.lock();
                let _ = store.fail_remote_start(&device, &request_id);
                let _ = store.delete_session(&id);
            })
            .await;
            return Err(RefuseReason::StartFailed);
        }
    };
    launch_remote_claude(app, &id).await;
    let _ = app.emit(
        SESSION_ADDED_EVENT,
        crate::store::SessionRow {
            baseline_oid: started.baseline_oid,
            ..session
        },
    );
    Ok(id)
}

/// Launch a fresh `claude` into a session a device started. Tried once more
/// if the shell didn't take the command; if it still doesn't, the session
/// stands as a shell, and opening it on the desktop launches `claude` then
/// (the launch claim was given back).
async fn launch_remote_claude(app: &tauri::AppHandle, id: &str) {
    use crate::commands::LaunchOutcome;
    use tauri::Manager as _;
    for _ in 0..2 {
        let launching = (app.clone(), id.to_string());
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let (app, id) = launching;
            crate::commands::launch_claude_in(
                &app,
                &app.state::<crate::AppState>(),
                &kriyon_core::session::SessionId(id),
                None,
                None,
                None,
            )
        })
        .await;
        if !matches!(outcome, Ok(LaunchOutcome::WriteFailed)) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    eprintln!("kriyon: claude couldn't be launched into a session a device started");
}

/// The row of a session a device started in `project`: its folder, the
/// asked title or the project's name, never a worktree.
fn remote_session_row(
    project: &crate::store::ProjectRow,
    title: Option<String>,
    now_ms: i64,
) -> crate::store::SessionRow {
    crate::store::SessionRow {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: project.id.clone(),
        title: title
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| project.name.clone()),
        cwd: project.path.clone(),
        worktree_path: None,
        created_at: now_ms,
        claude_session_id: None,
        archived_at: None,
        baseline_oid: None,
        title_locked: false,
        parent_session_id: None,
        nested_under: None,
        parked_at: None,
        pinned_at: None,
    }
}

#[cfg(test)]
mod tests {
    use parking_lot::Mutex;

    use super::*;

    #[derive(Default)]
    struct Recorder {
        output: Mutex<Vec<u8>>,
        exits: Mutex<u32>,
    }

    impl SessionSink for Recorder {
        fn output(&self, bytes: Vec<u8>) {
            self.output.lock().extend(bytes);
        }
        fn busy(&self, _busy: bool) {}
        fn exited(&self) {
            *self.exits.lock() += 1;
        }
    }

    #[test]
    fn a_window_that_takes_over_gets_the_output_from_then_on() {
        let slot = SinkSlot::new(Arc::new(NoViewer));
        slot.output(b"before".to_vec());
        let window = Arc::new(Recorder::default());
        slot.replace(Arc::clone(&window) as Arc<dyn SessionSink>);
        slot.output(b"after".to_vec());
        assert_eq!(window.output.lock().as_slice(), b"after");
    }

    #[test]
    fn a_death_is_told_once() {
        let window = Arc::new(Recorder::default());
        let slot = SinkSlot::new(Arc::clone(&window) as Arc<dyn SessionSink>);
        assert!(!slot.is_exited());
        slot.exited();
        slot.exited();
        assert!(slot.is_exited());
        assert_eq!(*window.exits.lock(), 1);
    }

    fn project() -> crate::store::ProjectRow {
        crate::store::ProjectRow {
            id: "/work/app".into(),
            name: "app".into(),
            path: "/work/app".into(),
            color: None,
            setup_command: Some("make".into()),
            pinned_at: None,
            folder_id: None,
        }
    }

    #[test]
    fn a_remote_session_runs_in_the_projects_folder_titled_as_asked_or_after_it() {
        let titled = remote_session_row(&project(), Some("Fix login".into()), 5);
        assert_eq!(titled.title, "Fix login");
        assert_eq!(titled.cwd, "/work/app");
        assert_eq!(titled.project_id, "/work/app");
        assert_eq!(titled.worktree_path, None, "never a worktree");
        assert_eq!(titled.created_at, 5);
        assert!(kriyon_core::daemon::is_valid_session_id(&titled.id));
        for untitled in [None, Some("  ".to_string())] {
            assert_eq!(remote_session_row(&project(), untitled, 5).title, "app");
        }
        assert_ne!(
            remote_session_row(&project(), None, 5).id,
            remote_session_row(&project(), None, 5).id
        );
    }

    #[test]
    fn no_viewer_is_not_a_window() {
        assert!(!NoViewer.viewer());
    }
}
