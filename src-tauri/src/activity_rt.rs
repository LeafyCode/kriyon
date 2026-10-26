//! Runs the [Activity store]: opens it, ingests every [Hook spool] on a
//! background thread, cleans up spools it has fully read, applies retention,
//! and serves the Activity tab's commands.
//!
//! The store sits in one process-wide slot so the status seed can read the
//! kept spool lines of a session whose spool is already gone.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::Emitter as _;

use crate::activity_store::{
    ingest_spool, ActivityStats, ActivityStepDetail, ActivityStore, ActivityTurn, CompanionFacts,
    Spool, RETENTION_DAYS, SIZE_CAP_BYTES,
};

/// How often the ingester looks at the spools.
const INGEST_EVERY: Duration = Duration::from_secs(3);

/// How often retention runs (and once, shortly after launch).
const PRUNE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const FIRST_PRUNE_AFTER: Duration = Duration::from_secs(10);

/// A fully-read spool of a session with no live process goes once it has been
/// quiet this long.
const SPOOL_IDLE_BEFORE_DELETE: Duration = Duration::from_secs(60 * 60);

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

static STORE: OnceLock<Mutex<ActivityStore>> = OnceLock::new();

/// Open `activity.db` in `data_dir`. Best-effort: without it the Activity tab
/// is empty and status works as before.
pub fn open(data_dir: &Path) {
    match ActivityStore::open(&data_dir.join("activity.db")) {
        Ok(store) => {
            let _ = STORE.set(Mutex::new(store));
        }
        Err(e) => eprintln!("kriyon: activity log unavailable: {e}"),
    }
}

fn with_store<T>(
    f: impl FnOnce(&mut ActivityStore) -> Result<T, crate::activity_store::ActivityError>,
) -> Result<T, String> {
    let store = STORE.get().ok_or("the activity log is unavailable")?;
    f(&mut store.lock()).map_err(|e| e.to_string())
}

/// The spool lines kept for `session_id`, for the status seed when its spool
/// is gone. Empty when there are none or the store is unavailable.
#[must_use]
pub fn seed_lines(session_id: &str) -> Vec<String> {
    with_store(|s| s.seed_lines(session_id)).unwrap_or_default()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityChanged {
    session_id: String,
}

/// Whether a session still has processes (a live [PTY daemon]). When the
/// process table can't be read, every session counts as live, so nothing is
/// deleted on a guess.
fn liveness() -> impl Fn(&str) -> bool {
    let survey = crate::status_rt::process_table();
    move |id: &str| {
        survey
            .as_ref()
            .is_none_or(|s| s.tree().daemon_pids(id).next().is_some())
    }
}

/// Start the background ingester for the spools under `home`.
pub fn spawn_ingester<R: tauri::Runtime>(app: tauri::AppHandle<R>, home: PathBuf) {
    std::thread::spawn(move || {
        let mut next_prune = Instant::now() + FIRST_PRUNE_AFTER;
        loop {
            ingest_pass(&app, &home);
            bridge_pass(&app, &home);
            if Instant::now() >= next_prune {
                prune_pass(&home);
                abandoned_pass(&app, &home);
                next_prune = Instant::now() + PRUNE_EVERY;
            }
            std::thread::sleep(INGEST_EVERY);
        }
    });
}

/// Every spool file in `events_dir` as (session id, path). Files whose name
/// isn't a valid session id are left alone.
fn spools(events_dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(events_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension()? != "jsonl" {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            kriyon_core::daemon::is_valid_session_id(&id).then_some((id, path))
        })
        .collect()
}

/// The spools this app may ingest. A dev or smoke build beside the installed
/// app shares `~/.claude/kriyon`; each ingests (and so deletes after reading)
/// only its own sessions' spools, or one app would take the other's history.
/// Any app may still remove files past retention ([`abandoned`]).
fn ingestible(spools: &[(String, PathBuf)], owned: &HashSet<String>) -> Vec<String> {
    spools
        .iter()
        .map(|(id, _)| id.clone())
        .filter(|id| owned.contains(id))
        .collect()
}

/// The sessions whose files no app here will ever clean up: nothing owns them,
/// nothing runs for them, and every file they left — hook spool, bridge spool,
/// partial reply, usage snapshot — has sat untouched past `retention`. Their
/// own app removes them on close; these are what a crash, an app removed
/// before it could, or an older build left behind.
fn abandoned(
    home: &Path,
    owned: &HashSet<String>,
    is_live: &dyn Fn(&str) -> bool,
    retention: Duration,
) -> Vec<String> {
    let dirs = [
        kriyon_core::paths::events_dir(home),
        kriyon_core::paths::bridge_dir(home),
        kriyon_core::paths::usage_dir(home),
    ];
    // Each id's most recent idle time across all its files.
    let mut least_idle: std::collections::BTreeMap<String, Duration> =
        std::collections::BTreeMap::new();
    for entry in dirs
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flatten()
        .flatten()
    {
        let path = entry.path();
        let Some(id) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.split('.').next())
        else {
            continue;
        };
        if !kriyon_core::daemon::is_valid_session_id(id) || owned.contains(id) {
            continue;
        }
        let idle = idle_for(&path).unwrap_or_default();
        least_idle
            .entry(id.to_string())
            .and_modify(|least| *least = (*least).min(idle))
            .or_insert(idle);
    }
    least_idle
        .into_iter()
        .filter(|(id, idle)| *idle > retention && !is_live(id))
        .map(|(id, _)| id)
        .collect()
}

/// The sessions this app's store holds — the only ones it ingests or cleans
/// up early. Empty (touch nothing) when the store can't be read.
fn owned_sessions<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> HashSet<String> {
    use tauri::Manager as _;
    app.state::<crate::StoreState>()
        .0
        .lock()
        .list_sessions()
        .map(|rows| rows.into_iter().map(|r| r.id).collect())
        .unwrap_or_default()
}

fn idle_for(path: &Path) -> Option<Duration> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok()
}

/// Remove a spool and its cursor, so a new spool for the id starts at 0.
fn remove_spool(spool: Spool, id: &str, path: &Path) {
    if std::fs::remove_file(path).is_ok() {
        let _ = with_store(|s| s.forget_cursor(spool, id));
    }
}

/// What the companion says about one conversation of a session; `None` when
/// it never posted or the store is unavailable.
#[must_use]
pub fn companion_facts(session_id: &str, conversation: Option<&str>) -> Option<CompanionFacts> {
    with_store(|s| s.companion(session_id, conversation))
        .ok()
        .flatten()
}

/// Read a session's [Bridge spool] now, ahead of the next pass, so the
/// Structured view gets its newest rows while Claude works instead of up to
/// [`INGEST_EVERY`] late. Best-effort; the pass reads whatever this missed.
pub fn ingest_bridge_now(home: &Path, session_id: &str) {
    let path = kriyon_core::paths::bridge_spool(home, session_id);
    let _ = with_store(|s| ingest_spool(s, Spool::Bridge, session_id, &path));
}

/// The companion's rows for a session, in order, for the Structured view.
#[must_use]
pub fn bridge_rows(session_id: &str) -> Vec<String> {
    with_store(|s| s.bridge_rows(session_id)).unwrap_or_default()
}

/// Every file Kriyon keeps for a session whose processes are gone: its hook
/// spool (and cursor), usage snapshot, bridge spool and partial reply. The one
/// place a "this session is gone" decision turns into deleted files.
pub(crate) fn forget_files(home: &Path, id: &str) {
    remove_spool(Spool::Hook, id, &kriyon_core::paths::events_file(home, id));
    remove_spool(
        Spool::Bridge,
        id,
        &kriyon_core::paths::bridge_spool(home, id),
    );
    let _ = std::fs::remove_file(kriyon_core::paths::bridge_partial(home, id));
    let _ = std::fs::remove_file(kriyon_core::paths::usage_file(home, id));
}

/// Whether ingest has read all of one of a session's spools (or it has none).
fn fully_read(spool: Spool, path: &Path, id: &str) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return true;
    };
    with_store(|s| s.cursor(spool, id))
        .ok()
        .flatten()
        .is_some_and(|c| u64::try_from(c.offset).is_ok_and(|o| o >= meta.len()))
}

fn ingest_pass<R: tauri::Runtime>(app: &tauri::AppHandle<R>, home: &Path) {
    let dir = kriyon_core::paths::events_dir(home);
    let spools = spools(&dir);
    if spools.is_empty() {
        return;
    }
    let is_live = liveness();
    let retention = retention();
    let too_old =
        |id: &str| idle_for(&dir.join(format!("{id}.jsonl"))).is_some_and(|i| i > retention);
    for id in ingestible(&spools, &owned_sessions(app)) {
        let path = dir.join(format!("{id}.jsonl"));
        if too_old(&id) && !is_live(&id) {
            // Too old to keep: never imported, just gone.
            forget_files(home, &id);
            continue;
        }
        match with_store(|s| ingest_spool(s, Spool::Hook, &id, &path)) {
            Ok(true) => {
                let _ = app.emit(
                    "activity-changed",
                    ActivityChanged {
                        session_id: id.clone(),
                    },
                );
            }
            Ok(false) => {}
            Err(e) => {
                eprintln!("kriyon: activity ingest failed for {id}: {e}");
                continue;
            }
        }
        let idle = idle_for(&path).unwrap_or_default();
        if fully_read(Spool::Hook, &path, &id) && idle > SPOOL_IDLE_BEFORE_DELETE && !is_live(&id) {
            remove_spool(Spool::Hook, &id, &path);
        }
    }
}

/// Ingest each owned [Bridge spool] like the hook spool, tell the UI when a
/// session's companion posted, and clean up fully read spools of ended
/// sessions.
fn bridge_pass<R: tauri::Runtime>(app: &tauri::AppHandle<R>, home: &Path) {
    let dir = kriyon_core::paths::bridge_dir(home);
    let spools = spools(&dir);
    if spools.is_empty() {
        return;
    }
    let is_live = liveness();
    for id in ingestible(&spools, &owned_sessions(app)) {
        let path = dir.join(format!("{id}.jsonl"));
        match with_store(|s| ingest_spool(s, Spool::Bridge, &id, &path)) {
            Ok(true) => {
                let _ = app.emit(
                    "companion-changed",
                    ActivityChanged {
                        session_id: id.clone(),
                    },
                );
            }
            Ok(false) => {}
            Err(e) => {
                eprintln!("kriyon: companion ingest failed for {id}: {e}");
                continue;
            }
        }
        let idle = idle_for(&path).unwrap_or_default();
        if fully_read(Spool::Bridge, &path, &id) && idle > SPOOL_IDLE_BEFORE_DELETE && !is_live(&id)
        {
            remove_spool(Spool::Bridge, &id, &path);
        }
    }
}

fn retention() -> Duration {
    Duration::from_secs(u64::try_from(RETENTION_DAYS).unwrap_or(30) * 86_400)
}

/// Remove the files of every [`abandoned`] session. Skipped when the store
/// can't be read: an empty owned set would make this app's own sessions look
/// abandoned.
fn abandoned_pass<R: tauri::Runtime>(app: &tauri::AppHandle<R>, home: &Path) {
    let owned = owned_sessions(app);
    if owned.is_empty() {
        return;
    }
    for id in abandoned(home, &owned, &liveness(), retention()) {
        forget_files(home, &id);
    }
}

fn prune_pass(home: &Path) {
    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    let is_live = liveness();
    // A live session is kept, and so is one whose spool isn't fully read yet:
    // its newest lines would be lost with it. Decided before `prune` takes the
    // store: `fully_read` locks it too, and the lock is not reentrant.
    let unread: std::collections::HashSet<String> = with_store(|s| s.session_ids())
        .unwrap_or_default()
        .into_iter()
        .filter(|id| {
            !fully_read(Spool::Hook, &kriyon_core::paths::events_file(home, id), id)
                || !fully_read(
                    Spool::Bridge,
                    &kriyon_core::paths::bridge_spool(home, id),
                    id,
                )
        })
        .collect();
    let keep = |id: &str| is_live(id) || unread.contains(id);
    let dropped =
        match with_store(|s| s.prune(now_ms - RETENTION_DAYS * DAY_MS, SIZE_CAP_BYTES, &keep)) {
            Ok(dropped) => dropped,
            Err(e) => {
                eprintln!("kriyon: activity retention failed: {e}");
                return;
            }
        };
    for id in dropped {
        forget_files(home, &id);
    }
}

/// Forget everything Kriyon logged for one session: its activity, its spool
/// and its usage snapshot. A still-running session keeps its spool (its
/// status needs it); only what was already read is forgotten.
///
/// # Errors
/// When the store is unavailable or the delete fails.
pub fn forget_session(home: &Path, session_id: &str) -> Result<(), String> {
    with_store(|s| s.delete_session(session_id))?;
    if !liveness()(session_id) {
        forget_files(home, session_id);
    }
    Ok(())
}

/// A session's terminal died (shell exit or daemon crash): mark where each
/// of its spools stands, so what is open — now, or in lines written before
/// this and read later — is closed, and tell the UI. Cheap: runs on the exit
/// callback; the ingester reads the rest as usual.
pub fn note_session_exited<R: tauri::Runtime>(app: &tauri::AppHandle<R>, home: &Path, id: &str) {
    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    let marks: Vec<(Spool, crate::activity_store::SpoolCursor)> = [
        (Spool::Hook, kriyon_core::paths::events_file(home, id)),
        (Spool::Bridge, kriyon_core::paths::bridge_spool(home, id)),
    ]
    .into_iter()
    .filter_map(|(spool, path)| Some((spool, crate::activity_store::spool_mark(&path)?)))
    .collect();
    if let Err(e) = with_store(|s| s.close_open(id, now_ms, &marks)) {
        eprintln!("kriyon: could not close {id}'s open activity: {e}");
        return;
    }
    for event in ["activity-changed", "companion-changed"] {
        let _ = app.emit(
            event,
            ActivityChanged {
                session_id: id.to_string(),
            },
        );
    }
}

/// The newest turns of a session's [Activity log], newest first.
///
/// # Errors
/// On an invalid id or a database error.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn activity_turns(session_id: String, limit: Option<u32>) -> Result<Vec<ActivityTurn>, String> {
    kriyon_core::daemon::check_session_id(&session_id)?;
    let limit = i64::from(limit.unwrap_or(200).clamp(1, 1000));
    with_store(|s| s.turns(&session_id, limit))
}

/// One [Activity step] in full, for its detail dialog.
///
/// # Errors
/// On an invalid id or a database error.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn activity_step(
    session_id: String,
    step_id: i64,
) -> Result<Option<ActivityStepDetail>, String> {
    kriyon_core::daemon::check_session_id(&session_id)?;
    with_store(|s| s.step(&session_id, step_id))
}

/// One [Nested session] request, with the session that asked for it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedRequest {
    pub lead_session_id: String,
    pub request: kriyon_core::nested::SessionRequest,
}

/// Hand the UI every [Nested session] request the companions posted since
/// it last asked, each once (ADR-0049). The UI decides with
/// `nested_outcome`; nothing is started here.
///
/// # Errors
/// On a database error.
#[tauri::command]
pub fn take_session_requests() -> Result<Vec<NestedRequest>, String> {
    Ok(with_store(ActivityStore::take_session_requests)?
        .into_iter()
        .map(|(lead_session_id, request)| NestedRequest {
            lead_session_id,
            request,
        })
        .collect())
}

/// Whether a request starts now or becomes a suggestion: started only for
/// the person's own words and while fewer than `cap` sessions run.
///
/// # Errors
/// Never; a `Result` like every command.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn nested_outcome(
    initiation: kriyon_core::nested::Initiation,
    running: usize,
    cap: Option<usize>,
) -> Result<kriyon_core::nested::Outcome, String> {
    Ok(kriyon_core::nested::outcome(initiation, running, cap))
}

/// The log's size and retention, for Settings.
///
/// # Errors
/// On a database error.
#[tauri::command]
pub fn activity_stats() -> Result<ActivityStats, String> {
    with_store(|s| s.stats())
}

/// Delete one session's activity.
///
/// # Errors
/// On an invalid id, a missing HOME, or a database error.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn activity_delete_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    kriyon_core::daemon::check_session_id(&session_id)?;
    forget_session(&crate::commands::resolve_home(&app)?, &session_id)?;
    let _ = app.emit("activity-changed", ActivityChanged { session_id });
    Ok(())
}

/// Delete every session's activity. Spools of running sessions stay (their
/// status needs them) but are not read again from the start.
///
/// # Errors
/// On a missing HOME or a database error.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn activity_delete_all(app: tauri::AppHandle) -> Result<(), String> {
    let home = crate::commands::resolve_home(&app)?;
    let ids = with_store(|s| s.session_ids())?;
    with_store(|s| s.delete_all())?;
    let owned = owned_sessions(&app);
    let is_live = liveness();
    let mut gone: Vec<String> = spools(&kriyon_core::paths::events_dir(&home))
        .into_iter()
        .chain(spools(&kriyon_core::paths::bridge_dir(&home)))
        .map(|(id, _)| id)
        .filter(|id| owned.contains(id) && !is_live(id))
        .collect();
    gone.sort();
    gone.dedup();
    for id in &gone {
        forget_files(&home, id);
    }
    for session_id in ids {
        let _ = app.emit("activity-changed", ActivityChanged { session_id });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_apps_sessions_are_ingested_while_any_old_spool_can_go() {
        let tmp = tempfile::tempdir().expect("tempdir");
        for id in ["mine", "theirs"] {
            std::fs::write(tmp.path().join(format!("{id}.jsonl")), "").expect("write");
        }
        let owned: std::collections::HashSet<String> = ["mine".to_string()].into();
        assert_eq!(
            ingestible(&spools(tmp.path()), &owned),
            ["mine"],
            "another app on this Mac (a dev build) owns the rest: only age may remove it"
        );
    }

    fn touch(path: &Path, age: Duration) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let file = std::fs::File::create(path).expect("create");
        file.set_modified(SystemTime::now() - age)
            .expect("set mtime");
    }

    #[test]
    fn files_nobody_owns_go_once_every_one_is_past_retention() {
        let home = tempfile::tempdir().expect("tempdir");
        let home = home.path();
        let old = Duration::from_secs(40 * 86_400);
        let fresh = Duration::from_secs(60);
        // Owned or live: kept however old.
        touch(&kriyon_core::paths::events_file(home, "mine"), old);
        touch(&kriyon_core::paths::bridge_spool(home, "live"), old);
        // Every file old and nobody's: gone, whichever kinds it left.
        touch(&kriyon_core::paths::events_file(home, "closed"), old);
        touch(&kriyon_core::paths::usage_file(home, "closed"), old);
        touch(
            &kriyon_core::paths::bridge_partial(home, "only-partial"),
            old,
        );
        touch(&kriyon_core::paths::usage_file(home, "only-usage"), old);
        // One recent file means the session may still be in use elsewhere.
        touch(&kriyon_core::paths::usage_file(home, "busy"), old);
        touch(&kriyon_core::paths::bridge_spool(home, "busy"), fresh);

        let owned: HashSet<String> = ["mine".to_string()].into();
        let gone = abandoned(
            home,
            &owned,
            &|id| id == "live",
            Duration::from_secs(30 * 86_400),
        );

        assert_eq!(gone, ["closed", "only-partial", "only-usage"]);
    }
}
