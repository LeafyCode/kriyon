//! App-side [PTY daemon] lifecycle IO: stopping a daemon the app is not
//! attached to, reaping [Orphan daemon]s, and [Daemon adoption].
//!
//! The decisions — which ids are owned, which daemon is an orphan, when an
//! orphan is asked and when it is forced, whether a pid may be signalled at all
//! — are pure and live in [`kriyon_core::orphan`] and
//! [`kriyon_core::tree_stop`]. This module gathers their inputs (the store, the
//! process table, the run dir) and carries out their answers.

use std::collections::HashSet;
use std::io::Write as _;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use kriyon_core::orphan::{orphan_daemons, terminal_pane_ids, OrphanDaemon, ReapStep};
use kriyon_core::proc::ProcessTree;
use kriyon_core::session::SessionId;
use kriyon_core::tree_stop::may_signal;
use kriyon_core::wire::Frame;
use tauri::Manager as _;

use crate::daemon_client::DaemonClient;
use crate::{AppState, Session, StoreState};

/// The layout key the frontend persists [Project terminal] tabs and panes under.
const TERMINALS_KEY: &str = "terminals";
/// A `Shutdown` frame is a handful of bytes; a write that blocks this long means
/// the daemon is wedged, and the caller falls back to a signal.
const SHUTDOWN_WRITE_TIMEOUT: Duration = Duration::from_secs(1);

/// Send `signal` to `pid` if the [Signal gate] allows it. The one door every
/// signal the app sends goes through. Best-effort: a vanished pid is fine.
#[cfg(unix)]
pub(crate) fn signal_gated(pid: i32, signal: libc::c_int) {
    let own_pid = i32::try_from(std::process::id()).unwrap_or(0);
    if may_signal(pid, &[own_pid]) {
        // SAFETY: plain kill(2) on a pid the gate has proven is > 1 and not
        // ours; no memory involved.
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

/// The file whose `flock` marks the instance that owns a [Run dir].
const OWNER_LOCK: &str = ".owner.lock";
/// How long a non-owning instance waits for the daemon's greeting before
/// concluding its connection was never accepted. The greeting is the first
/// thing a daemon writes to a client it accepts, so this is only ever waited
/// out by a connection genuinely stuck in another instance's backlog.
const ACCEPT_WAIT: Duration = Duration::from_millis(250);

/// Become, or confirm being, the instance that owns `run`. Exactly one running
/// instance holds the lock; the kernel releases it when that process exits,
/// however it exits, so ownership is inherited rather than leaked. Idempotent.
///
/// Two instances on one run dir is a real workflow: a dev build beside the
/// installed app shares its identifier, store and run dir. Only the owner may
/// reap, adopt, or stop a daemon it does not provably hold — see
/// [`kriyon_core::daemon::may_stop_held`] for what goes wrong otherwise.
#[cfg(unix)]
fn claim_run_dir(held: &parking_lot::Mutex<Option<std::fs::File>>, run: &Path) -> bool {
    use std::os::unix::io::AsRawFd as _;

    let mut held = held.lock();
    if held.is_some() {
        return true;
    }
    if std::fs::create_dir_all(run).is_err() {
        return false;
    }
    let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(run.join(OWNER_LOCK))
    else {
        return false;
    };
    // SAFETY: flock(2) on a descriptor this function owns; no memory involved.
    // Non-blocking: a held lock is an answer ("not the owner"), never a wait.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return false;
    }
    *held = Some(file);
    true
}

#[cfg(not(unix))]
fn claim_run_dir(_held: &parking_lot::Mutex<Option<std::fs::File>>, _run: &Path) -> bool {
    false
}

/// Whether this instance owns its [Run dir] — claiming it if nobody does.
pub(crate) fn owns_run_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(run) = resolve_run_dir(app) else {
        return false;
    };
    claim_run_dir(&app.state::<AppState>().run_dir_lock, &run)
}

/// Stop the daemon behind a connection this instance holds — or, if this
/// instance has no right to, just let go of it. The one place that decision is
/// made, for close, quit, and a session closed while it was still starting.
pub(crate) fn stop_held(owns_run_dir: bool, engine: &DaemonClient) {
    use kriyon_core::session::SessionEngine as _;

    // Short-circuits: the owner never waits.
    let accepted = || engine.wait_accepted(ACCEPT_WAIT);
    if kriyon_core::daemon::may_stop_held(owns_run_dir, owns_run_dir || accepted()) {
        let _ = engine.close();
    } else {
        engine.release();
    }
}

/// Ask the daemon behind `socket` to [Tree stop] itself, without an attached
/// [Daemon client]. `true` if the frame was handed to the socket.
///
/// The daemon serves one client at a time, so this connection may wait its turn
/// in the accept backlog; bytes written before the close are still delivered
/// when the daemon gets to it.
pub(crate) fn shutdown_detached(socket: &Path) -> bool {
    let Ok(mut stream) = UnixStream::connect(socket) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(SHUTDOWN_WRITE_TIMEOUT));
    stream.write_all(&Frame::Shutdown.encode()).is_ok() && stream.flush().is_ok()
}

/// Stop a daemon the app cannot talk to. New daemons turn SIGTERM into a
/// [Tree stop]; one from before that change simply dies, which closes its PTY
/// and hangs up the shell — no worse than before.
#[cfg(unix)]
fn terminate_daemon(pid: i32) {
    signal_gated(pid, libc::SIGTERM);
}

/// End a daemon that was asked to stop and did not: SIGKILL everything under it
/// in `tree`, then the daemon. `tree` must be the sweep `daemon_pid` came from,
/// so the pid is known to still be that daemon.
#[cfg(unix)]
fn force_stop(tree: &ProcessTree, daemon_pid: i32) {
    for pid in tree.descendants_of(daemon_pid) {
        signal_gated(pid, libc::SIGKILL);
    }
    signal_gated(daemon_pid, libc::SIGKILL);
}

/// How many times a connect to a daemon that is demonstrably alive is retried
/// before the daemon is judged unreachable, and how long between tries.
const RECONNECT_TRIES: u32 = 5;
const RECONNECT_PAUSE: Duration = Duration::from_millis(100);
/// How long a terminated daemon gets to [Tree stop] itself before it is forced.
const RETIRE_TIMEOUT: Duration = Duration::from_secs(4);
const RETIRE_POLL: Duration = Duration::from_millis(250);

/// Stop the daemon of a session this run never attached to — the session was
/// restored from the store but its pane never mounted, so no [Daemon client]
/// holds it. Without this, closing such a session deleted its row and left the
/// daemon, shell and `claude` running forever with nothing able to reach them.
#[cfg(unix)]
pub(crate) fn stop_unattached(run: &Path, id: &str) {
    let Some(socket) = kriyon_core::daemon::session_socket_path(run, id) else {
        return;
    };
    if shutdown_detached(&socket) {
        return;
    }
    // Nobody answered the socket. A daemon may still be alive behind a deleted
    // socket file; find it in the process table instead. A sweep taken *now*:
    // a signal must never follow a pid read from a seconds-old table.
    let Some(survey) = crate::status_rt::process_table_fresh() else {
        return;
    };
    for pid in survey.tree().daemon_pids(id) {
        terminate_daemon(pid);
    }
}

#[cfg(not(unix))]
pub(crate) fn stop_unattached(_run: &Path, _id: &str) {}

/// `create_session` could not connect to `id`'s socket. That alone does not
/// mean the daemon is gone: its socket file may have been deleted, or the
/// connect may have failed transiently. Spawning a replacement regardless — the
/// old behaviour — unlinks the path and strands the live daemon for good.
///
/// So: if a daemon for `id` is alive, retry the connect (returning the stream to
/// reattach with); if it stays unreachable it can never be reattached, so retire
/// it — SIGTERM, which it turns into a [Tree stop], then force — and only then
/// let the caller spawn.
///
/// `Ok(None)` means the path is clear for a fresh daemon. `Err` means a live
/// daemon still holds it and this instance may not retire it
/// ([`may_bind_session_socket`]): the create must refuse rather than bind, since
/// binding unlinks the path and would strand that daemon for good.
///
/// # Errors
/// Returns an error string when a live daemon holds the socket and this
/// instance is not the [Run dir]'s owner.
#[cfg(unix)]
pub(crate) fn recover_unreachable_daemon(
    id: &str,
    socket: &Path,
    may_retire: bool,
) -> Result<Option<UnixStream>, String> {
    // Always a sweep taken now: every answer here is followed by a signal or by
    // a decision to unlink a socket.
    let live = || -> Vec<i32> {
        crate::status_rt::process_table_fresh()
            .map_or_else(Vec::new, |survey| survey.tree().daemon_pids(id).collect())
    };
    if live().is_empty() {
        return Ok(None);
    }
    for _ in 0..RECONNECT_TRIES {
        std::thread::sleep(RECONNECT_PAUSE);
        if let Ok(stream) = UnixStream::connect(socket) {
            return Ok(Some(stream));
        }
    }
    if !kriyon_core::daemon::may_bind_session_socket(true, may_retire) {
        // Not this instance's daemon to stop, and therefore not its socket to
        // take: the run dir's owner may be using it through a connection it
        // already holds. Spawning here would unlink the path out from under a
        // live daemon and strand it — unreachable, unreapable, still holding a
        // claude tree. Refuse instead.
        return Err(format!(
            "session {id} is being served by another Kriyon instance's daemon"
        ));
    }

    eprintln!("kriyon: daemon for session={id} is alive but unreachable; retiring it");
    for pid in live() {
        terminate_daemon(pid);
    }
    let deadline = std::time::Instant::now() + RETIRE_TIMEOUT;
    while std::time::Instant::now() < deadline {
        std::thread::sleep(RETIRE_POLL);
        if live().is_empty() {
            return Ok(None);
        }
    }
    if let Some(survey) = crate::status_rt::process_table_fresh() {
        let tree = survey.tree();
        let stuck: Vec<i32> = tree.daemon_pids(id).collect();
        for pid in stuck {
            force_stop(&tree, pid);
        }
    }
    Ok(None)
}

#[cfg(not(unix))]
pub(crate) fn recover_unreachable_daemon(
    _id: &str,
    _socket: &Path,
    _may_retire: bool,
) -> Result<Option<UnixStream>, String> {
    Ok(None)
}

/// Every id something owns: session rows that are not put away (archived or
/// parked), persisted [Terminal pane]s outside a fully [Parked project], and
/// whatever this run is attached to. `None` when ownership cannot
/// be established — the store or the terminals blob is unreadable — and the
/// caller must then reap nothing.
///
/// Derived here from the store, never supplied by the frontend: a failed
/// hydration leaves the frontend store empty, and "nothing is owned" would reap
/// every live session.
fn owned_ids<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<HashSet<String>> {
    let (rows, terminals) = {
        let store = app.state::<StoreState>();
        let store = store.0.lock();
        (
            store.list_sessions().ok()?,
            store.load_layout(TERMINALS_KEY).ok()?,
        )
    };
    let parked = fully_parked_projects(&rows);
    let mut owned: HashSet<String> = rows
        .into_iter()
        .filter(|row| !row.is_put_away())
        .map(|row| row.id)
        .collect();
    owned.extend(terminal_pane_ids(terminals.as_deref(), &parked)?);
    let state = app.state::<AppState>();
    owned.extend(state.sessions.lock().keys().map(|id| id.0.clone()));
    Some(owned)
}

/// Projects every one of whose open sessions is parked (and that has at least
/// one): parking a project stops its [Project terminal]s too, and they stay
/// stopped until one of its sessions comes back.
fn fully_parked_projects(rows: &[crate::store::SessionRow]) -> HashSet<String> {
    let mut parked = HashSet::new();
    let mut live = HashSet::new();
    for row in rows.iter().filter(|row| row.archived_at.is_none()) {
        if row.parked_at.is_some() {
            parked.insert(row.project_id.clone());
        } else {
            live.insert(row.project_id.clone());
        }
    }
    parked.retain(|project| !live.contains(project));
    parked
}

pub(crate) fn resolve_run_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let home = app
        .path()
        .home_dir()
        .ok()
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))?;
    crate::commands::run_dir(app, &home).ok()
}

/// The periodic daemon housekeeping: reap [Orphan daemon]s, and adopt survivors
/// whenever this instance has just become the [Run dir]'s owner — at launch, or
/// later, when the instance that held it exits and ownership passes here.
pub(crate) fn lifecycle_pass<R: tauri::Runtime>(app: &tauri::AppHandle<R>, at_launch: bool) {
    let was_owner = app.state::<AppState>().run_dir_lock.lock().is_some();
    reap_pass(app, at_launch);
    if owns_run_dir(app) && !was_owner {
        adopt_live_daemons(app);
    }
}

/// One [Orphan daemon] pass. Runs at launch (`at_launch`, where an unowned
/// daemon is unambiguous and is asked at once) and on the ticker (where an
/// orphan must be seen on consecutive passes first). Never blocks on a daemon
/// and never touches an owned one.
#[cfg(unix)]
pub(crate) fn reap_pass<R: tauri::Runtime>(app: &tauri::AppHandle<R>, at_launch: bool) {
    // Another running instance owns this run dir: its sessions are not in this
    // instance's memory, and one it created a moment ago is not in the store
    // yet either. Nothing here can be told apart from an orphan, so reap nothing.
    if !owns_run_dir(app) {
        return;
    }
    let Some(owned) = owned_ids(app) else {
        eprintln!("kriyon: ownership unreadable; skipping the orphan-daemon pass");
        return;
    };
    // Taken now, never from the cache: a `Force` step SIGKILLs from this table.
    let (Some(run), Some(survey)) = (
        resolve_run_dir(app),
        crate::status_rt::process_table_fresh(),
    ) else {
        return;
    };
    let tree = survey.tree();
    let orphans = orphan_daemons(&tree, &run.to_string_lossy(), &owned);
    let steps = app
        .state::<AppState>()
        .orphans
        .lock()
        .observe(&orphans, at_launch);
    for (orphan, step) in steps {
        carry_out(&tree, &run, &orphan, step);
    }
    let min_age = if at_launch {
        Duration::ZERO
    } else {
        STALE_RUN_FILE_AGE
    };
    let swept = remove_stale_run_files(&run, &owned, &tree, min_age);
    forget_closed(app, &swept);
}

#[cfg(not(unix))]
pub(crate) fn reap_pass<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _at_launch: bool) {}

#[cfg(unix)]
fn carry_out(tree: &ProcessTree, run: &Path, orphan: &OrphanDaemon, step: ReapStep) {
    match step {
        ReapStep::Wait => {}
        ReapStep::Shutdown => {
            eprintln!(
                "kriyon: stopping orphan daemon session={} pid={}",
                orphan.session_id, orphan.pid
            );
            let asked = kriyon_core::daemon::session_socket_path(run, &orphan.session_id)
                .is_some_and(|socket| shutdown_detached(&socket));
            if !asked {
                terminate_daemon(orphan.pid);
            }
        }
        ReapStep::Force => {
            eprintln!(
                "kriyon: forcing orphan daemon session={} pid={}",
                orphan.session_id, orphan.pid
            );
            force_stop(tree, orphan.pid);
        }
    }
}

/// How long an unowned run file with no live daemon must have sat untouched
/// before a ticker pass removes it. A session being created writes its log and
/// seed prompt a moment before its daemon shows up and anything owns it.
const STALE_RUN_FILE_AGE: Duration = Duration::from_secs(2 * 60);

/// Delete run-dir leftovers (`.sock`, `.b`, `.prompt`, `.log`) whose session
/// nothing owns and no live daemon serves, once untouched for `min_age`, and
/// return those sessions' ids. The run dir is this app identity's own, so an id
/// swept here is a session of this app that has ended — the cue to remove the
/// rest of its files ([`forget_closed`]).
fn remove_stale_run_files(
    run: &Path,
    owned: &HashSet<String>,
    tree: &ProcessTree,
    min_age: Duration,
) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(run) else {
        return Vec::new();
    };
    let mut swept = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_run_file = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| matches!(ext, "sock" | "b" | "prompt" | "log"));
        let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if !is_run_file
            || !kriyon_core::daemon::is_valid_session_id(id)
            || owned.contains(id)
            || tree.daemon_pids(id).next().is_some()
            || !untouched_for(&path, min_age)
        {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            swept.push(id.to_string());
        }
    }
    swept.sort();
    swept.dedup();
    swept
}

fn untouched_for(path: &Path, min_age: Duration) -> bool {
    min_age.is_zero()
        || std::fs::symlink_metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= min_age)
}

/// Remove every other file Kriyon keeps for sessions swept from the run dir
/// whose row is gone (closed, not archived). Closing deletes the row while the
/// daemon is still stopping, so the files could not go then; this is when they
/// can. An archived session keeps its row and its files.
fn forget_closed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, swept: &[String]) {
    if swept.is_empty() {
        return;
    }
    let Ok(rows) = app.state::<StoreState>().0.lock().list_sessions() else {
        return;
    };
    let Some(home) = app.path().home_dir().ok() else {
        return;
    };
    let stored: HashSet<String> = rows.into_iter().map(|row| row.id).collect();
    for id in swept.iter().filter(|id| !stored.contains(*id)) {
        crate::activity_rt::forget_files(&home, id);
    }
}

/// [Daemon adoption]: attach a sink-less client to every owned daemon that is
/// still alive — the survivors of a [Handover] — so the [Resource sweep], the
/// [Sleep ledger] and `close_session` see a session nobody has opened yet.
///
/// An owned daemon that cannot be reached is left exactly as it is: a failed
/// probe is never a reason to stop anything.
pub(crate) fn adopt_live_daemons<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // Only the run dir's owner adopts. A second instance's connections would
    // queue behind the owner's and then *take the slot* the next time the owner
    // let go — leaving the owner's own reconnect waiting forever on a blank
    // terminal.
    if !owns_run_dir(app) {
        eprintln!("kriyon: another instance owns the run dir; not adopting or reaping");
        return;
    }
    let (Some(owned), Some(run)) = (owned_ids(app), resolve_run_dir(app)) else {
        return;
    };
    let state = app.state::<AppState>();
    for id in owned {
        if state.sessions.lock().contains_key(&SessionId(id.clone())) {
            continue;
        }
        let Some(socket) = kriyon_core::daemon::session_socket_path(&run, &id) else {
            continue;
        };
        let Ok(stream) = UnixStream::connect(&socket) else {
            continue;
        };
        let engine = match DaemonClient::adopt(stream, SessionId(id.clone())) {
            Ok(engine) => engine,
            Err(e) => {
                eprintln!("kriyon: could not adopt daemon session={id} ({e})");
                continue;
            }
        };
        // Insert only into a vacant slot, decided under the one lock. The check
        // above and this insert are not atomic: `create_session` for the
        // session the user is looking at can land in between, and replacing its
        // real client with this sink-less one would blank that terminal.
        let displaced = {
            use std::collections::hash_map::Entry;
            match state.sessions.lock().entry(SessionId(id.clone())) {
                Entry::Vacant(slot) => {
                    slot.insert(Session {
                        engine: std::sync::Arc::new(engine),
                        zdotdir: None,
                    });
                    None
                }
                Entry::Occupied(_) => Some(engine),
            }
        };
        // Dropped outside the lock: letting go joins a reader thread.
        if displaced.is_none() {
            eprintln!("kriyon: adopted live daemon session={id}");
        }
        drop(displaced);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kriyon_core::wire::FrameDecoder;
    use parking_lot::Mutex;
    use std::io::Read as _;
    use std::os::unix::net::UnixListener;

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(AppState::default());
        app.manage(StoreState(parking_lot::Mutex::new(
            crate::store::Store::open_in_memory().expect("in-memory store"),
        )));
        app
    }

    fn session_row(id: &str, archived_at: Option<i64>) -> crate::store::SessionRow {
        crate::store::SessionRow {
            id: id.to_string(),
            project_id: "p1".to_string(),
            title: id.to_string(),
            cwd: "/x".to_string(),
            worktree_path: None,
            created_at: 1,
            claude_session_id: None,
            archived_at,
            baseline_oid: None,
            title_locked: false,
            parent_session_id: None,
            nested_under: None,
            parked_at: None,
        }
    }

    fn seed_project(app: &tauri::App<tauri::test::MockRuntime>) {
        let store = app.state::<StoreState>();
        store
            .0
            .lock()
            .upsert_project(&crate::store::ProjectRow {
                id: "p1".to_string(),
                name: "demo".to_string(),
                path: "/x".to_string(),
                color: None,
                setup_command: None,
            })
            .expect("project");
    }

    #[test]
    fn parked_sessions_and_a_fully_parked_projects_panes_are_not_owned() {
        let app = mock_app();
        seed_project(&app);
        {
            let store = app.state::<StoreState>();
            let store = store.0.lock();
            store
                .upsert_project(&crate::store::ProjectRow {
                    id: "p2".to_string(),
                    name: "parked".to_string(),
                    path: "/y".to_string(),
                    color: None,
                    setup_command: None,
                })
                .expect("second project");
            store
                .upsert_session(&session_row("live", None))
                .expect("row");
            store
                .upsert_session(&crate::store::SessionRow {
                    parked_at: Some(5),
                    ..session_row("parked-in-live-project", None)
                })
                .expect("row");
            store
                .upsert_session(&crate::store::SessionRow {
                    project_id: "p2".to_string(),
                    parked_at: Some(5),
                    ..session_row("parked-session", None)
                })
                .expect("row");
            store
                .save_layout(
                    TERMINALS_KEY,
                    r#"{"p1": {"tabs": [{"panes": [{"id": "pane-1"}]}]}, "p2": {"tabs": [{"panes": [{"id": "pane-2"}]}]}}"#,
                )
                .expect("layout");
        }

        let owned = owned_ids(app.handle()).expect("readable ownership");

        assert!(owned.contains("live"));
        // p1 still has a live session, so its terminal is still in use.
        assert!(owned.contains("pane-1"));
        // A parked session is stopped, so a daemon still serving it is a leftover.
        assert!(!owned.contains("parked-in-live-project"));
        assert!(!owned.contains("parked-session"));
        // Every session of p2 is parked: its terminals were stopped too.
        assert!(!owned.contains("pane-2"));
    }

    #[test]
    fn live_rows_and_saved_panes_are_owned_and_archived_rows_are_not() {
        let app = mock_app();
        seed_project(&app);
        {
            let store = app.state::<StoreState>();
            let store = store.0.lock();
            store
                .upsert_session(&session_row("live", None))
                .expect("row");
            store
                .upsert_session(&session_row("shelved", Some(99)))
                .expect("row");
            store
                .save_layout(
                    TERMINALS_KEY,
                    r#"{"p1": {"activeTabId": "t", "tabs": [{"id": "t", "panes": [{"id": "pane-1"}]}]}}"#,
                )
                .expect("layout");
        }

        let owned = owned_ids(app.handle()).expect("readable ownership");

        assert!(owned.contains("live"));
        assert!(
            owned.contains("pane-1"),
            "a saved Project-terminal pane is owned"
        );
        // Archiving stops a session, so a daemon still serving one is a leftover.
        assert!(!owned.contains("shelved"));
    }

    #[test]
    fn unreadable_ownership_is_unknown_not_empty() {
        // The difference between "nothing is owned" and "cannot tell" is the
        // difference between reaping every live session and reaping none.
        let app = mock_app();
        seed_project(&app);
        {
            let store = app.state::<StoreState>();
            let store = store.0.lock();
            store
                .upsert_session(&session_row("live", None))
                .expect("row");
            store
                .save_layout(TERMINALS_KEY, "{this is not json")
                .expect("layout");
        }

        assert_eq!(owned_ids(app.handle()), None);
    }

    #[test]
    fn only_one_instance_at_a_time_can_own_a_run_dir() {
        let dir = tempfile::tempdir().expect("tmp dir");
        let first = Mutex::new(None);
        let second = Mutex::new(None);

        assert!(claim_run_dir(&first, dir.path()));
        assert!(claim_run_dir(&first, dir.path()), "re-asking is idempotent");
        assert!(
            !claim_run_dir(&second, dir.path()),
            "a second instance must be told it is not the owner"
        );

        // The owner exits (or crashes — the kernel drops the lock with it).
        *first.lock() = None;
        assert!(claim_run_dir(&second, dir.path()), "ownership is inherited");
    }

    /// The HIGH-severity regression this guards: a dev build running beside the
    /// installed app (same identifier, store and run dir) quits, and leaves a
    /// `Shutdown` queued in every daemon the installed app is using.
    #[test]
    fn a_second_instance_never_stops_a_session_the_first_is_using() {
        use crate::daemon_client::test_support::spawn_greeting_daemon;

        let dir = tempfile::tempdir().expect("tmp dir");
        let socket = dir.path().join("s.sock");
        let shutdowns = spawn_greeting_daemon(&socket);

        let installed = DaemonClient::adopt(
            UnixStream::connect(&socket).expect("connect"),
            SessionId("s".into()),
        )
        .expect("installed app");
        assert!(installed.wait_accepted(Duration::from_secs(2)));
        let dev_build = DaemonClient::adopt(
            UnixStream::connect(&socket).expect("connect"),
            SessionId("s".into()),
        )
        .expect("dev build");

        // The dev build quits. It does not own the run dir.
        stop_held(false, &dev_build);
        // Later the installed app reloads its webview: its client lets go.
        drop(installed);
        std::thread::sleep(Duration::from_millis(300));

        assert_eq!(*shutdowns.lock().expect("lock"), 0);
    }

    #[test]
    fn the_owner_stops_what_it_holds_and_so_does_anyone_the_daemon_accepted() {
        use crate::daemon_client::test_support::spawn_greeting_daemon;

        for owns_run_dir in [true, false] {
            let dir = tempfile::tempdir().expect("tmp dir");
            let socket = dir.path().join("s.sock");
            let shutdowns = spawn_greeting_daemon(&socket);
            let client = DaemonClient::adopt(
                UnixStream::connect(&socket).expect("connect"),
                SessionId("s".into()),
            )
            .expect("client");
            assert!(client.wait_accepted(Duration::from_secs(2)));

            stop_held(owns_run_dir, &client);
            std::thread::sleep(Duration::from_millis(200));

            assert_eq!(*shutdowns.lock().expect("lock"), 1, "owner={owns_run_dir}");
        }
    }

    #[test]
    fn a_detached_shutdown_reaches_the_daemon_as_a_shutdown_frame() {
        let dir = tempfile::tempdir().expect("tmp dir");
        let socket = dir.path().join("s.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        let daemon = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().expect("accept");
            let mut bytes = Vec::new();
            conn.read_to_end(&mut bytes).expect("read");
            let mut decoder = FrameDecoder::new();
            decoder.push(&bytes);
            decoder.next_frame()
        });

        assert!(shutdown_detached(&socket));
        assert_eq!(daemon.join().expect("join"), Some(Frame::Shutdown));
    }

    #[test]
    fn a_detached_shutdown_to_a_dead_socket_reports_failure() {
        let dir = tempfile::tempdir().expect("tmp dir");
        assert!(!shutdown_detached(&dir.path().join("nobody-home.sock")));
    }

    fn ptyd_row(pid: i32, run: &Path, id: &str) -> kriyon_core::proc::ProcRow {
        kriyon_core::proc::ProcRow {
            pid,
            ppid: 1,
            tpgid: -1,
            cmd: format!(
                "kriyon-ptyd --socket {}/{id}.sock --id {id}",
                run.to_string_lossy()
            ),
        }
    }

    fn left_in(run: &Path) -> Vec<String> {
        let mut left: Vec<String> = std::fs::read_dir(run)
            .expect("read dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        left
    }

    #[test]
    fn stale_run_files_go_but_owned_and_live_ones_stay() {
        let dir = tempfile::tempdir().expect("tmp dir");
        let run = dir.path();
        for name in [
            "gone.sock",
            "gone.prompt",
            "gone.log",
            "gone.b",
            "owned.log",
            "owned.b",
            "live.sock",
            "live.b",
            "notes.txt",
        ] {
            std::fs::write(run.join(name), b"").expect("seed");
        }
        let rows = vec![ptyd_row(100, run, "live")];
        let owned: HashSet<String> = HashSet::from(["owned".to_string()]);

        let swept = remove_stale_run_files(run, &owned, &ProcessTree::new(&rows), Duration::ZERO);

        assert_eq!(
            left_in(run),
            vec!["live.b", "live.sock", "notes.txt", "owned.b", "owned.log"]
        );
        assert_eq!(swept, vec!["gone".to_string()]);
    }

    #[test]
    fn a_run_file_younger_than_the_grace_stays() {
        // A session being created writes its log and seed prompt a moment
        // before its daemon shows up and before anything owns it.
        let dir = tempfile::tempdir().expect("tmp dir");
        let run = dir.path();
        std::fs::write(run.join("new.log"), b"").expect("seed");
        std::fs::write(run.join("new.prompt"), b"").expect("seed");

        let swept = remove_stale_run_files(
            run,
            &HashSet::new(),
            &ProcessTree::new(&[]),
            Duration::from_secs(60),
        );

        assert_eq!(left_in(run), vec!["new.log", "new.prompt"]);
        assert_eq!(swept, Vec::<String>::new());
    }
}
