//! Live per-session status runtime: a thin shell over the [Session runtime]
//! ([`kriyon_core::runtime::SessionRuntime`], which owns each session's status
//! fusion + mirrored ask in `kriyon-core`). This module only locks the runtime
//! map, emits `session-status` to the frontend, and dispatches OS notifications.

use std::time::Instant;

use kriyon_core::runtime::SessionRuntime;
use kriyon_core::session::{SessionId, SessionStatus};
use kriyon_core::status::NotifyDecision;
use serde::Serialize;
use tauri::{Emitter as _, Manager as _};

use crate::{AppState, StoreState};

/// Payload emitted to the frontend on each status change.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusUpdate {
    /// When the newest replayed event actually happened (the hook's ISO
    /// timestamp), for a seeded update. `None` on a live update, and on a
    /// replay whose events carry no timestamp.
    ///
    /// Without it the frontend can only stamp a seeded status with "now", which
    /// tells the recency projection that every session was active at launch —
    /// burying the age-based "N older" fold, since nothing is ever old enough.
    last_event_at: Option<String>,
    /// True when this status was reconstructed by replaying the events file at
    /// launch rather than observed live. The frontend needs the distinction for
    /// the same reason [`SessionRuntime`] does: a replayed finish is output the
    /// user saw days ago, so it must not relight "needs you" on every launch.
    seeded: bool,
    session_id: String,
    status: SessionStatus,
    summary: String,
}

/// Resolve a session's (project name, session title) from the store for
/// notification display. Falls back to the raw session id + empty title when
/// the row is missing (an unpersisted or just-created session), so a
/// notification never fails to render.
fn session_display(store: &StoreState, session_id: &SessionId) -> (String, String) {
    let store = store.0.lock();
    // One indexed lookup, not a scan of every session + project row — this runs
    // on the notification path (see `recompute_and_emit`).
    store
        .session_identity(&session_id.0)
        .ok()
        .flatten()
        .map_or_else(
            || (session_id.0.clone(), String::new()),
            |id| (id.project, id.title),
        )
}

/// Recompute a session's status + summary from its runtime and emit a
/// `session-status` event if either changed. A no-op if the session has no
/// runtime (already closed, or never started).
pub fn recompute_and_emit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, session_id: &SessionId) {
    let state = app.state::<AppState>();
    let now = Instant::now();

    // Focus is read before the runtime lock (separate locks, never nested).
    // A live turn finishing while the user is not looking at this session
    // marks it finished-with-unseen-output, which counts on the badge until
    // the user focuses it (see SessionRuntime::note_unseen_done).
    let window_focused = *state.window_focused.lock();
    let active_is_this = state.focused.lock().as_ref() == Some(session_id);
    let on_screen_now = window_focused && active_is_this;

    // One fold, one lock: commit the recompute, mark an off-screen finish as
    // unseen, cancel a pending fire the session has moved past, and arm a new
    // one if this transition deserves it. The shell used to do that from
    // outside in four separate lock windows.
    let env = kriyon_core::runtime::ObserveEnv {
        window_focused,
        active_is_this,
        preference: *state.notify_pref.lock(),
    };
    debug_assert_eq!(on_screen_now, env.on_screen());
    let outcome = {
        let mut runtimes = state.runtimes.lock();
        let Some(runtime) = runtimes.get_mut(session_id) else {
            return;
        };
        runtime.observe(now, &env)
    };
    if let Some(change) = outcome.change {
        let payload = StatusUpdate {
            last_event_at: None, // live: it is happening now
            seeded: false,
            session_id: session_id.0.clone(),
            status: change.status,
            summary: change.summary.clone(),
        };
        let _ = app.emit("session-status", payload);

        // Leaving an attention state (the user answered the prompt, or Claude
        // resumed on its own) makes any banner shown for it stale — pull it.
        // The pending fire was already cancelled inside the fold.
        if outcome.withdraw {
            crate::notify::withdraw(app, &session_id.0);
        }

        // A committed status change can move a session in or out of "needs you"
        // (e.g. running → waiting), so refresh the menu-bar badge now rather than
        // waiting for the next ticker pass.
        crate::refresh_needs_you_badge(app);

        // Trace every transition's decision inputs so the notification path stays
        // debuggable from captured stderr, alongside the offline events-replay
        // workflow. The fold already armed it if it fires: a spurious attention
        // state that flips straight back to work is disarmed before its settle
        // window elapses, so it never pings; a genuine one is delivered by
        // `fire_settled_notification` (below, and on the 2s ticker).
        if let Some(decision) = outcome.decision {
            eprintln!(
                "kriyon: status-change session={} prev={:?} next={:?} on_screen={} unread={} pref={:?} fires={}",
                session_id.0,
                change.prev,
                change.status,
                decision.on_screen(),
                decision.already_unread,
                decision.preference,
                decision.should_fire(),
            );
        }
    }

    // Deliver any armed notification whose settle window has now elapsed. Runs on
    // every call — the live event that armed it (too soon), later events, and the
    // 2s ticker that re-drives this for every session — so a genuine block always
    // surfaces within ~a tick even if no further event arrives.
    fire_settled_notification(app, session_id, window_focused, active_is_this);
}

/// Fire an armed notification once it has outlived its settle window and still
/// qualifies. The armed state was set by [`recompute_and_emit`] on a fireable
/// transition; here the decision is rebuilt from the stashed pre-attention status
/// and the session's *current* status/focus/latch, so a session focused during
/// the wait, or coalesced against a recent fire, stays quiet.
///
/// The fire is claimed atomically — the armed state is read and disarmed under
/// one lock — so a concurrent event/ticker pass cannot also deliver it. If the
/// rebuilt decision then says stay quiet, the disarm already stands: we did not
/// want to fire.
fn fire_settled_notification<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &SessionId,
    window_focused: bool,
    active_is_this: bool,
) {
    let state = app.state::<AppState>();
    let now = Instant::now();

    let timing = kriyon_core::runtime::SettleTiming {
        settle: kriyon_core::status::NOTIFY_SETTLE,
        quiet: kriyon_core::status::PTY_QUIET,
        max_defer: kriyon_core::status::NOTIFY_MAX_DEFER,
    };
    let claim = {
        let mut runtimes = state.runtimes.lock();
        let Some(runtime) = runtimes.get_mut(session_id) else {
            return;
        };
        runtime.claim_settled(now, &timing)
    };
    let Some(claim) = claim else {
        return;
    };
    let next = claim.next;

    let decision = NotifyDecision {
        prev: claim.prev,
        next,
        window_focused,
        active_is_this,
        already_unread: claim.already_unread,
        preference: *state.notify_pref.lock(),
        secs_since_last_notify: claim.secs_since_last_notify,
    };
    let store = app.state::<StoreState>();
    let Some(content) =
        kriyon_core::notification::notification_plan(&decision, claim.ask.as_ref(), || {
            session_display(&store, session_id)
        })
    else {
        return;
    };
    eprintln!(
        "kriyon: notify-settled session={} status={next:?}",
        session_id.0
    );
    let sound = *state.notify_sound.lock();
    crate::notify::show(
        app,
        &session_id.0,
        &content.title,
        &content.subtitle,
        &content.body,
        sound,
    );

    let mut runtimes = state.runtimes.lock();
    if let Some(runtime) = runtimes.get_mut(session_id) {
        runtime.record_notified(Instant::now());
    }
}

/// Cap on how much of a session's events file is replayed when seeding a fresh
/// subscription. 256 KiB of trailing events is hundreds of turns — far more
/// than needed to settle the terminal status — while keeping the subscribe
/// path cheap for the multi-megabyte files long sessions accumulate.
pub(crate) const SEED_TAIL_MAX_BYTES: u64 = 256 * 1024;

/// The trailing complete lines of `path`, reading at most `max_bytes` from the
/// end. When the read starts mid-file the first (partial) line is dropped.
/// Missing/unreadable files yield an empty list — seeding is best-effort.
/// The recorded hook events a seed replays: the parsed tail of the session's
/// events file. Shared by the status seed and the activity seed so both
/// replay the same history.
///
/// A session whose spool was already cleaned up replays the lines the
/// [Activity store] kept for it instead, so a resumed session still starts
/// from its last known state.
pub(crate) fn read_seed_events(
    events_path: &std::path::Path,
) -> Vec<kriyon_core::hooks::HookEvent> {
    seed_lines_or(events_path, crate::activity_rt::seed_lines)
        .iter()
        .filter_map(|line| kriyon_core::hooks::parse_hook_line(line))
        .collect()
}

/// The spool's tail, or — when the spool is gone — `kept(<session id>)`.
fn seed_lines_or(
    events_path: &std::path::Path,
    kept: impl FnOnce(&str) -> Vec<String>,
) -> Vec<String> {
    if events_path.exists() {
        return read_tail_lines(events_path, SEED_TAIL_MAX_BYTES);
    }
    events_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(kept)
        .unwrap_or_default()
}

/// The main-session id the status-line wrapper last recorded for a session —
/// the authoritative anchor both seeds replay against.
pub(crate) fn usage_anchor(usage_path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(usage_path)
        .ok()
        .and_then(|text| kriyon_core::hooks::parse_usage_snapshot(&text))
        .and_then(|snap| snap.authoritative_main_id().map(str::to_string))
}

pub(crate) fn read_tail_lines(path: &std::path::Path, max_bytes: u64) -> Vec<String> {
    use std::io::{Read as _, Seek as _, SeekFrom};

    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = match file.metadata() {
        Ok(meta) => meta.len(),
        Err(_) => return Vec::new(),
    };
    let start = len.saturating_sub(max_bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    // Lossy: a seek into the middle of a multi-byte character must not abort
    // the whole seed; the partial first line is dropped below anyway.
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    lines
}

/// Whether a `claude` could still be blocked in this session's terminal.
///
/// This used to ask `pgrep` whether the [PTY daemon] process existed, which is
/// almost always true and therefore gated nothing: daemons intentionally
/// outlive the app so a session's `claude` survives to be reattached, so a
/// working machine has dozens alive for sessions last touched days ago. What
/// the seed actually needs to know is whether a `claude` still holds the
/// terminal — see [`kriyon_core::proc`], which reads the same `tcgetpgrp`
/// state the daemon's own busy-poll uses, but from the process table so no
/// probe connection is needed (the daemon serves one client at a time, and
/// attaching a second would consume the real client's slot).
///
/// Fails open on everything except positive evidence to the contrary: being
/// wrong in the permissive direction re-shows a stale state, while being wrong
/// in the strict direction hides a session that genuinely needs the user.
fn claude_may_be_blocked(session_id: &SessionId) -> bool {
    let Some(survey) = process_table() else {
        return true; // Can't tell — behave as before the gate existed.
    };
    kriyon_core::proc::may_still_be_blocked(survey.tree().foreground(&session_id.0))
}

/// How long one `ps` sweep is reused. Every session subscribes (and therefore
/// seeds, on its own thread) within a moment of launch, so without sharing, a
/// 30-session workspace forks `ps` 30 times and re-parses ~900 rows each time.
/// The window is short enough that a session which exits mid-burst is still
/// caught on the next seed.
const PROCESS_TABLE_TTL: std::time::Duration = std::time::Duration::from_secs(2);

/// One sweep and the index built over it, kept together.
///
/// The cache used to hand out rows alone, and every caller then wrote
/// `survey.tree()` itself — so the cheap half (the `ps` fork) was
/// shared and the expensive half (indexing ~1500 rows into two hash maps) was
/// rebuilt per read. One sleep pass built it four times. Both halves are behind
/// `Arc`s, so a cache hit is two refcount bumps.
#[derive(Clone)]
pub(crate) struct ProcessSurvey {
    rows: std::sync::Arc<Vec<kriyon_core::proc::ProcRow>>,
    index: std::sync::Arc<kriyon_core::proc::ProcessIndex>,
}

impl ProcessSurvey {
    /// View this sweep. Cheap: the index is already built, and binding it is
    /// two pointer copies.
    pub(crate) fn tree(&self) -> kriyon_core::proc::ProcessTree<'_> {
        kriyon_core::proc::ProcessTree::bound(&self.rows, &self.index)
    }

    /// Every row of the sweep.
    pub(crate) fn rows(&self) -> &[kriyon_core::proc::ProcRow] {
        &self.rows
    }
}

/// A taken-at survey, cached between the launch burst's concurrent seeds.
type CachedTable = std::sync::Mutex<Option<(Instant, ProcessSurvey)>>;

/// The one cached sweep shared by every reader.
fn process_table_cache() -> &'static CachedTable {
    static CACHE: std::sync::OnceLock<CachedTable> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

/// The process survey, taken at most once per [`PROCESS_TABLE_TTL`].
/// `None` means the sweep could not be trusted — callers must fail open.
pub(crate) fn process_table() -> Option<ProcessSurvey> {
    let mut cached = process_table_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((taken, survey)) = cached.as_ref() {
        if taken.elapsed() < PROCESS_TABLE_TTL {
            return Some(survey.clone());
        }
    }
    let rows = std::sync::Arc::new(sweep_process_table()?);
    let survey = ProcessSurvey {
        index: std::sync::Arc::new(kriyon_core::proc::ProcessIndex::build(&rows)),
        rows,
    };
    *cached = Some((Instant::now(), survey.clone()));
    Some(survey)
}

/// A sweep taken right now, bypassing (and refreshing) the cache. For the few
/// callers that act on "is this process *still* alive" inside a wait loop,
/// where a two-second-old answer would make the loop lie to itself.
pub(crate) fn process_table_fresh() -> Option<ProcessSurvey> {
    // Expire the cached sweep, then take the normal path so the fresh one is
    // cached for everyone else too.
    process_table_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    process_table()
}

/// One `ps` sweep. The fields are exactly those `parse_ps_rows` expects; `-ww`
/// disables the terminal-width truncation that would otherwise cut the session
/// id out of a long daemon command line.
///
/// Returns `None` — not an empty table — whenever the sweep is untrustworthy.
/// That distinction is the whole point: an empty row set looks exactly like
/// "this session has no daemon", which would hide *every* blocked session at
/// once. `ps` spawning but failing (an unsupported `-o` keyword on a future
/// macOS, a sandbox change, a failed fork) must fail open, loudly.
fn sweep_process_table() -> Option<Vec<kriyon_core::proc::ProcRow>> {
    let output = std::process::Command::new("ps")
        .args(["-axww", "-o", "pid=,ppid=,tpgid=,args="])
        .output()
        .ok()?;
    if !output.status.success() {
        eprintln!(
            "kriyon: ps failed ({}); trusting replayed attention state: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return None;
    }
    let rows = kriyon_core::proc::parse_ps_rows(&String::from_utf8_lossy(&output.stdout));
    if rows.is_empty() {
        eprintln!("kriyon: ps returned no usable rows; trusting replayed attention state");
        return None;
    }
    Some(rows)
}

/// Seed a just-subscribed session's status + open ask from the tail of its
/// on-disk events file, so status is a function of the recorded history rather
/// than of subscription timing. Without this, every app restart blanked all
/// statuses to Idle (a genuinely blocked session vanished from the menu-bar
/// badge) and a re-subscribe that missed a `Stop` could wedge a phantom
/// Waiting onto the badge forever.
///
/// Yields to the live stream at every step:
/// - skipped when a hook event has already driven the tracker, and abandoned
///   if one lands (or the authoritative anchor moves) while the replay runs —
///   the live fold could only be regressed by installing history under it;
/// - the replay is anchored to the authoritative main [Claude session id]
///   (the tracker's, else the usage snapshot's), so a prior claude that died
///   without `SessionEnd` cannot win the replay's lock;
/// - an attention state (Waiting / open ask) is only seeded when a `claude`
///   could still be holding this session's terminal (see
///   [`claude_may_be_blocked`]) — an exited claude's tail would otherwise
///   re-pin its stale permission prompt on the badge at every launch.
///
/// The ask rides the replayed [Session runtime], installed atomically with the
/// status under the one runtimes lock — there is no separate asks write for a
/// live value to race. Historical transitions are emitted as `session-status`
/// only; they never fire OS notifications.
pub fn seed_from_history<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &SessionId,
    events_path: &std::path::Path,
    usage_path: &std::path::Path,
) {
    let events = read_seed_events(events_path);
    if events.is_empty() {
        return;
    }

    let state = app.state::<AppState>();
    // Pre-replay snapshot of the runtime: a hook-driven runtime wins outright;
    // a usage-anchored main id must survive into (and gate) the replay.
    let runtime_anchor: Option<String> = {
        let runtimes = state.runtimes.lock();
        match runtimes.get(session_id) {
            Some(rt) if rt.is_hook_driven() => return,
            // [Hooks off]: no hook will ever retire a replayed status, so a
            // seed would only resurrect a stale one (ADR-0029).
            Some(rt) if rt.hooks_off() => return,
            Some(rt) => rt.main_session_id().map(str::to_string),
            None => None,
        }
    };
    let anchor = runtime_anchor.clone().or_else(|| usage_anchor(usage_path));

    let runtime = SessionRuntime::from_history(&events, anchor.as_deref(), Instant::now());
    let status = runtime.status();
    let summary = runtime.summary().to_string();

    // A terminal with no claude running in it cannot be waiting on anyone:
    // leave the runtime at Idle rather than resurrect the tail's stale block on
    // every launch.
    if runtime.needs_you() && !claude_may_be_blocked(session_id) {
        return;
    }

    {
        let mut runtimes = state.runtimes.lock();
        match runtimes.get(session_id) {
            // A live hook event landed while we replayed — the stream wins
            // (live set_ask + note_hook_event commit under this same lock, so
            // hook-driven implies the live ask is already in place too).
            Some(rt) if rt.is_hook_driven() || rt.hooks_off() => return,
            // The authoritative anchor moved mid-replay (a fresher usage
            // snapshot): our replay may be against a stale main — yield.
            Some(rt) if rt.main_session_id() != runtime_anchor.as_deref() => return,
            _ => {}
        }
        let has_ask = runtime.ask().is_some();
        runtimes.insert(session_id.clone(), runtime);
        // The seed path is otherwise silent (no notifications, no status-change
        // log); one line makes "why does this session show X after launch"
        // diagnosable from the app log.
        eprintln!(
            "kriyon: seeded session={} status={status:?} ask={has_ask} anchor={:?}",
            session_id.0,
            anchor.as_deref().unwrap_or("none"),
        );
    }

    let _ = app.emit(
        "session-status",
        StatusUpdate {
            // Newest-last file, so the last timestamped event is the session's
            // real last activity — what the age fold must measure from.
            last_event_at: events.iter().rev().find_map(|e| e.ts.clone()),
            seeded: true,
            session_id: session_id.0.clone(),
            status,
            summary,
        },
    );
    crate::refresh_needs_you_badge(app);
}

/// Record a Claude Code hook event + the open ask it arrived with (one
/// [`crate::watcher::WatchSignal::Status`] signal), then recompute and emit.
/// Ask and status commit under the single runtimes lock, so no interleaving —
/// seed install, another signal, a notification read — can observe one without
/// the other. Creates the runtime if absent.
pub fn note_status_signal<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &SessionId,
    event: &kriyon_core::hooks::HookEvent,
    ask: Option<kriyon_core::ask::PendingAsk>,
) {
    let ask_changed =
        crate::session_registry::with_runtime(&app.state::<AppState>(), session_id, |runtime| {
            let ask_changed = runtime.set_ask(ask);
            runtime.note_hook_event(event);
            ask_changed
        });
    recompute_and_emit(app, session_id);
    // An ask can open or clear while status stays `running` (a mid-turn
    // permission prompt), which moves the session in/out of "needs you";
    // refresh the badge for that case (a status change refreshed it already).
    if ask_changed {
        crate::refresh_needs_you_badge(app);
    }
}

/// Anchor a session's main claude id from the status-line wrapper's authoritative
/// signal, then recompute and emit. Only the main interactive TUI renders a
/// status line, so this corrects a heuristic mis-lock (e.g. onto a nested
/// one-shot) and re-anchors after a restart that emitted no `SessionEnd`. A
/// no-op for an empty id. A session with no runtime yet gets one holding the
/// anchor, so the history seed that follows replays against it, exactly as
/// the activity seed does.
pub fn note_authoritative_main<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &SessionId,
    claude_id: &str,
) {
    if claude_id.is_empty() {
        return;
    }
    crate::session_registry::with_runtime(&app.state::<AppState>(), session_id, |runtime| {
        runtime.set_authoritative_main(claude_id);
    });
    recompute_and_emit(app, session_id);
}

#[cfg(test)]
mod tests {
    use super::{read_tail_lines, seed_lines_or, session_display};
    use crate::store::{ProjectRow, SessionRow, Store};
    use crate::{AppState, StoreState};
    use kriyon_core::session::SessionId;
    use parking_lot::Mutex;

    #[test]
    fn a_seed_falls_back_to_the_kept_lines_when_the_spool_is_gone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = dir.path().join("s1.jsonl");
        let kept = |id: &str| vec![format!("kept for {id}")];
        assert_eq!(seed_lines_or(&spool, kept), ["kept for s1"]);

        std::fs::write(&spool, "live line\n").expect("write");
        assert_eq!(seed_lines_or(&spool, kept), ["live line"]);
    }

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
            baseline_oid: None,
            title_locked: false,
            parent_session_id: None,
            nested_under: None,
        }
    }

    fn project(id: &str, name: &str) -> ProjectRow {
        ProjectRow {
            id: id.to_string(),
            name: name.to_string(),
            path: "/tmp".to_string(),
            color: None,
            setup_command: None,
            parked_at: None,
        }
    }

    #[test]
    fn resolves_project_name_and_title() {
        let store = Store::open_in_memory().expect("store");
        store
            .upsert_project(&project("p1", "auth-service"))
            .expect("project");
        store
            .upsert_session(&row("s1", "p1", "Fix login flow"))
            .expect("session");
        let state = StoreState(Mutex::new(store));
        let (project, title) = session_display(&state, &SessionId("s1".to_string()));
        assert_eq!(project, "auth-service");
        assert_eq!(title, "Fix login flow");
    }

    #[test]
    fn read_tail_lines_returns_whole_small_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("events.jsonl");
        std::fs::write(&path, "one\ntwo\nthree\n").expect("write");
        assert_eq!(read_tail_lines(&path, 1024), vec!["one", "two", "three"]);
    }

    #[test]
    fn read_tail_lines_drops_the_partial_first_line_when_capped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("events.jsonl");
        // 3 lines of 10 bytes each ("aaaaaaaaa\n"); a 15-byte cap starts
        // mid-line-2, so only the complete line 3 must survive.
        std::fs::write(&path, "aaaaaaaaa\nbbbbbbbbb\nccccccccc\n").expect("write");
        assert_eq!(read_tail_lines(&path, 15), vec!["ccccccccc"]);
    }

    #[test]
    fn read_tail_lines_of_missing_file_is_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            read_tail_lines(&dir.path().join("nope.jsonl"), 1024),
            [] as [String; 0]
        );
    }

    #[test]
    fn missing_row_falls_back_to_session_id() {
        let store = Store::open_in_memory().expect("store");
        let state = StoreState(Mutex::new(store));
        let (project, title) = session_display(&state, &SessionId("ghost".to_string()));
        assert_eq!(project, "ghost");
        assert_eq!(title, "");
    }

    #[test]
    fn a_status_line_id_that_lands_before_any_hook_still_anchors_the_seed() {
        // The usage signal can beat the first status signal. Its anchor must
        // not be dropped: the history seed replays against it, as the activity
        // seed does, rather than locking onto an earlier dead claude.
        use tauri::Manager as _;
        let app = tauri::test::mock_app();
        app.manage(AppState::default());
        app.manage(StoreState(Mutex::new(
            Store::open_in_memory().expect("store"),
        )));
        let dir = tempfile::tempdir().expect("tempdir");
        let events = dir.path().join("events.jsonl");
        std::fs::write(
            &events,
            concat!(
                r#"{"event":"UserPromptSubmit","session_id":"old"}"#,
                "\n",
                r#"{"event":"UserPromptSubmit","session_id":"live"}"#,
                "\n",
                r#"{"event":"Stop","session_id":"live"}"#,
                "\n",
            ),
        )
        .expect("events");
        let id = SessionId("sess-1".to_string());

        super::note_authoritative_main(app.handle(), &id, "live");
        super::seed_from_history(app.handle(), &id, &events, &dir.path().join("none.json"));

        let state = app.state::<AppState>();
        let runtimes = state.runtimes.lock();
        let runtime = runtimes.get(&id).expect("a seeded runtime");
        assert_eq!(runtime.main_session_id(), Some("live"));
    }
}
