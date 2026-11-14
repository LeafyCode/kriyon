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
/// are done, or the baseline has taken [`BASELINE_WAIT`] (it then comes
/// later), so `claude`, launched after (`launch_claude`), doesn't edit the
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
    session: crate::store::SessionRow,
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
    // Waited for up to BASELINE_WAIT, so claude (launched after) doesn't
    // edit the tree first; a slower one (a huge repository) isn't, and is
    // kept and told to the window when it comes.
    let baseline_oid = match capture {
        Some(capture) => {
            let (late_app, late_id) = (app.clone(), session.id.clone());
            baseline_within(capture, BASELINE_WAIT, move |oid| {
                keep_baseline(&late_app, &late_id, &oid);
                let _ = tauri::Emitter::emit(
                    &late_app,
                    SESSION_BASELINE_EVENT,
                    LateBaseline {
                        session_id: late_id,
                        baseline_oid: oid,
                    },
                );
            })
            .await
        }
        None => None,
    };
    let reattached = opened?;
    if let Some(oid) = &baseline_oid {
        keep_baseline(app, &session.id, oid);
    }
    Ok(Started {
        reattached,
        baseline_oid,
    })
}

/// How long a start waits for its git baseline (ADR 0015): past it, claude
/// launches and the baseline comes later ([`SESSION_BASELINE_EVENT`]).
pub const BASELINE_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// The event that tells the window a session's baseline came after its
/// start returned.
pub const SESSION_BASELINE_EVENT: &str = "session-baseline";

/// A session's baseline that came late.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LateBaseline {
    session_id: String,
    baseline_oid: String,
}

/// The baseline `capture` gives within `wait`; past it, `None`, and `late`
/// gets the baseline when (if) it comes.
async fn baseline_within(
    capture: tauri::async_runtime::JoinHandle<Option<String>>,
    wait: std::time::Duration,
    late: impl FnOnce(String) + Send + 'static,
) -> Option<String> {
    let mut capture = Box::pin(capture);
    if let Ok(done) = tokio::time::timeout(wait, capture.as_mut()).await {
        return done.ok().flatten();
    }
    tauri::async_runtime::spawn(async move {
        if let Ok(Some(oid)) = capture.await {
            late(oid);
        }
    });
    None
}

/// Keep session `id`'s baseline with its row, alone: a rename or a pin
/// made while the shell opened stays. The window records it too.
fn keep_baseline<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str, oid: &str) {
    use tauri::Manager as _;
    let _ = app
        .state::<crate::StoreState>()
        .0
        .lock()
        .set_baseline_oid(id, oid);
}

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
    request: kriyon_remote_link::host_runtime::RemoteStart,
) -> Result<String, kriyon_remote::message::RefuseReason> {
    use tauri::Manager as _;
    let key = (device, request.request_id);
    app.state::<crate::AppState>()
        .remote_starts
        .once(key, start_remote_once(&app, device, request))
        .await
}

/// Whether a start goes on for a device whose role is `role_now`: only a
/// Controller's, still paired.
fn still_may_start(
    role_now: Option<kriyon_remote::message::Role>,
) -> Result<(), kriyon_remote::message::RefuseReason> {
    use kriyon_remote::message::{RefuseReason, Role};
    match role_now {
        Some(Role::Controller) => Ok(()),
        Some(Role::Viewer) => Err(RefuseReason::NotAllowed),
        None => Err(RefuseReason::NotPaired),
    }
}

async fn start_remote_once(
    app: &tauri::AppHandle,
    device: kriyon_remote::message::EndpointId,
    request: kriyon_remote_link::host_runtime::RemoteStart,
) -> Result<String, kriyon_remote::message::RefuseReason> {
    use kriyon_remote::message::{RefuseReason, Role};
    use kriyon_remote_link::host_runtime::ServeHost as _;
    use tauri::{Emitter as _, Manager as _};
    fn store(app: &tauri::AppHandle) -> tauri::State<'_, crate::StoreState> {
        app.state::<crate::StoreState>()
    }
    let now = kriyon_remote_link::host_runtime::now_ms();
    let request_id = request.request_id;
    // The store and the folder check touch the disk: off the runtime.
    let looking = (app.clone(), request.project_id.clone());
    let (made, project) = tauri::async_runtime::spawn_blocking(move || {
        let (app, project_id) = looking;
        let host = crate::remote_host_rt::AppServeHost(app.clone());
        // Checked again here: the device may have been removed or made a
        // Viewer since the check, and the project may have changed.
        still_may_start(host.role_now(&device, Role::Controller))?;
        if let Some(made) = host.started(&device, &request_id) {
            return Ok((Some(made), None));
        }
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
        let recorded =
            crate::remote_starts::record(&store(&app).0.lock(), &device, &request_id, &id, now);
        recorded
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
                crate::remote_starts::fail(&store(&app).0.lock(), &device, &request_id, &id);
            })
            .await;
            return Err(RefuseReason::StartFailed);
        }
    };
    // Watched from now, window or not: its status, the Needs-you list and
    // its phone alerts, its saved claude id and its readable view need it.
    // Before claude starts, so its first hooks are heard.
    watch_remote(app, &id).await;
    launch_remote_claude(app, &id).await;
    // The baseline as kept now: one that came after the start's wait may be
    // saved by now, its own event sent before the window knew the session.
    // Read and told under the store's lock, which a late baseline's save
    // takes too, so its event (sent after the save) follows this one.
    {
        let store = store(app);
        let store = store.0.lock();
        let baseline_oid = store
            .session_row(&id)
            .ok()
            .flatten()
            .and_then(|row| row.baseline_oid)
            .or(started.baseline_oid);
        let _ = app.emit(
            SESSION_ADDED_EVENT,
            crate::store::SessionRow {
                baseline_oid,
                ..session
            },
        );
    }
    Ok(id)
}

/// Watch session `id`, a device started, as the desktop watches what it
/// shows: with no window, its transcript events go nowhere. Opening it on the
/// desktop later watches it again, for the window.
async fn watch_remote(app: &tauri::AppHandle, id: &str) {
    let Ok(home) = crate::commands::resolve_home(app) else {
        eprintln!("kriyon: a session a device started can't be watched: no home folder");
        return;
    };
    let watching = (app.clone(), id.to_string());
    // Its seed reads the events file's tail: off the async runtime.
    let watched = tauri::async_runtime::spawn_blocking(move || {
        let (app, id) = watching;
        crate::commands::start_watch(&app, &home, kriyon_core::session::SessionId(id), |_| {})
    })
    .await;
    if let Ok(Err(why)) = watched {
        eprintln!("kriyon: a session a device started can't be watched: {why}");
    }
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
    /// A baseline that comes in time is the start's; a slow one isn't
    /// waited for past the cap, and is handed on when it comes.
    #[test]
    fn a_slow_baseline_is_not_waited_for_and_comes_later() {
        use std::time::Duration;
        tauri::async_runtime::block_on(async {
            let quick = tauri::async_runtime::spawn(async { Some("quick".to_string()) });
            let got =
                super::baseline_within(quick, Duration::from_secs(1), |_| panic!("not late")).await;
            assert_eq!(got.as_deref(), Some("quick"));

            let slow = tauri::async_runtime::spawn(async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                Some("slow".to_string())
            });
            let (late_tx, late_rx) = std::sync::mpsc::channel();
            let started = std::time::Instant::now();
            let got = super::baseline_within(slow, Duration::from_millis(50), move |oid| {
                let _ = late_tx.send(oid);
            })
            .await;
            assert_eq!(got, None, "not waited for");
            assert!(started.elapsed() < Duration::from_millis(250));
            let late = tauri::async_runtime::spawn_blocking(move || {
                late_rx.recv_timeout(Duration::from_secs(5))
            })
            .await
            .expect("joined");
            assert_eq!(late.as_deref(), Ok("slow"));
        });
    }

    /// A session a device started is watched with no window showing it:
    /// its hooks move its status, so it is on the Needs-you list the push
    /// wake reads, before the desktop ever opens it.
    #[test]
    fn a_session_nobody_opened_on_the_desktop_is_watched_and_can_need_you() {
        use std::io::Write as _;
        use tauri::Manager as _;
        let home = tempfile::tempdir().expect("tempdir");
        let app = tauri::test::mock_app();
        app.manage(crate::AppState::default());
        app.manage(crate::StoreState(parking_lot::Mutex::new(
            crate::store::Store::open_in_memory().expect("in-memory store"),
        )));
        let id = "started-from-a-phone";
        {
            let store = app.state::<crate::StoreState>();
            let store = store.0.lock();
            store
                .upsert_project(&crate::store::ProjectRow {
                    id: "p1".into(),
                    name: "demo".into(),
                    path: "/x".into(),
                    color: None,
                    setup_command: None,
                    pinned_at: None,
                    folder_id: None,
                })
                .expect("project");
            store
                .upsert_session(&crate::store::SessionRow {
                    id: id.into(),
                    project_id: "p1".into(),
                    title: "From the phone".into(),
                    cwd: "/x".into(),
                    worktree_path: None,
                    created_at: 1,
                    claude_session_id: None,
                    archived_at: None,
                    baseline_oid: None,
                    title_locked: false,
                    parent_session_id: None,
                    nested_under: None,
                    parked_at: None,
                    pinned_at: None,
                })
                .expect("session");
        }
        let events = kriyon_core::paths::events_file(home.path(), id);
        std::fs::create_dir_all(events.parent().expect("dir")).expect("mkdir");
        std::fs::write(&events, "").expect("events file");
        crate::commands::start_watch(
            app.handle(),
            home.path(),
            kriyon_core::session::SessionId(id.into()),
            |_| {},
        )
        .expect("watched");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&events)
            .expect("open");
        writeln!(file, r#"{{"event":"UserPromptSubmit","session_id":"c1"}}"#).expect("write");
        writeln!(
            file,
            r#"{{"event":"Notification","session_id":"c1","message":"Claude needs your permission to use Bash"}}"#
        )
        .expect("write");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let listed = crate::session_list_rt::current(
                &app.state::<crate::AppState>(),
                &app.state::<crate::StoreState>(),
                None,
            )
            .expect("listed");
            if listed
                .iter()
                .any(|session| session.id == id && session.needs_you)
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "never needed you: {listed:?}"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

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
    fn a_start_goes_on_only_while_its_device_is_still_a_controller() {
        use kriyon_remote::message::{RefuseReason, Role};
        assert_eq!(still_may_start(Some(Role::Controller)), Ok(()));
        assert_eq!(
            still_may_start(Some(Role::Viewer)),
            Err(RefuseReason::NotAllowed)
        );
        assert_eq!(still_may_start(None), Err(RefuseReason::NotPaired));
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
