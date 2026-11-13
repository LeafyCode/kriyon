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

    #[test]
    fn no_viewer_is_not_a_window() {
        assert!(!NoViewer.viewer());
    }
}
