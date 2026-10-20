//! [Sleeping session] runtime: the ticker pass that stops a long-idle
//! session's `claude` (and only `claude`), and the wake path that types
//! `claude --resume` back into the shell on demand.
//!
//! The decisions and the lifecycle bookkeeping are pure
//! ([`kriyon_core::sleep`]); this module owns the IO: reading the process
//! table, sending the stop signal, and typing the resume command. Two
//! invariants the pure layer encodes and this layer must honor: the signal
//! goes to exactly the foreground `claude` pid (never the shell, never the
//! process group — dev servers live in that tree), and the resume command is
//! typed only into a shell verified to sit at its prompt.

use std::time::Instant;

use kriyon_core::proc::{ProcessTree, PtyForeground};
use kriyon_core::session::{SessionEngine as _, SessionId, SessionStatus};
use kriyon_core::sleep::{
    can_type_resume, is_quiescent, should_sleep, SleepCandidate, SleepState, SleepTransition,
};
use serde::Serialize;
use tauri::{Emitter as _, Manager as _};

use crate::AppState;

/// Payload for the `session-sleeping` event: where the session now sits in the
/// [Sleeping session] lifecycle. A phase rather than a boolean, so a session
/// Kriyon could not wake is distinguishable from one peacefully asleep instead
/// of sitting moon-marked forever with only stderr to explain it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SleepingUpdate {
    session_id: String,
    /// `"asleep"`, `"stuck"` or `"awake"`.
    state: &'static str,
}

/// Tell the frontend a session's wire phase (`"asleep"` / `"stuck"` /
/// `"awake"` / `"waking"`).
fn emit_wire<R: tauri::Runtime>(app: &tauri::AppHandle<R>, session_id: &str, wire: &'static str) {
    let _ = app.emit(
        "session-sleeping",
        SleepingUpdate {
            session_id: session_id.to_string(),
            state: wire,
        },
    );
}

/// Tell the frontend where a session now sits, from a known [`SleepState`].
fn emit_state<R: tauri::Runtime>(app: &tauri::AppHandle<R>, session_id: &str, state: SleepState) {
    emit_wire(app, session_id, state.wire_name());
}

/// Emit the session's current wire phase as the ledger sees it right now —
/// including `"waking"` for an in-flight wake, which [`emit_state`] cannot
/// express (it is a [`Phase`], not a [`SleepState`]). Reads under the lock,
/// emits with it released.
fn emit_current_phase<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &AppState, id: &str) {
    let wire = state.sleep.lock().wire_phase(id);
    emit_wire(app, id, wire);
}

/// Send SIGTERM to exactly one pid, through the [Signal gate] every signal the
/// app sends passes. Best-effort: a vanished pid is fine.
#[cfg(unix)]
fn terminate(pid: i32) {
    crate::daemon_rt::signal_gated(pid, libc::SIGTERM);
}

#[cfg(not(unix))]
fn terminate(_pid: i32) {}

/// One sleep pass, run from the background ticker alongside the memory
/// sampler: refresh idle clocks, confirm pending stops, retry a focused
/// session's wake, then stop any new candidates the policy approves.
///
/// The ledger lock is taken briefly and is never held across IO.
pub fn sleep_pass<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    let policy = *state.auto_sleep.lock();

    let ids: Vec<SessionId> = {
        let sessions = state.sessions.lock();
        sessions.keys().cloned().collect()
    };
    if ids.is_empty() {
        return;
    }

    refresh_idle_clocks(&state, &ids);

    let Some(survey) = crate::status_rt::process_table() else {
        return; // Untrustworthy sweep: change nothing this pass.
    };
    let tree = survey.tree();

    confirm_stops(app, &state, &tree);
    confirm_wakes(app, &state, &tree);
    reconcile_live_claude(app, &state, &tree);

    let focused = state.focused.lock().clone();

    // A focused Asleep session should be awake (the wake-on-focus attempt can
    // race the shell's return to its prompt); retry here until it lands, or
    // until the retry window marks it Stuck. Only Asleep is auto-retried: once
    // Stuck (a resume that keeps failing — e.g. a purged conversation id), the
    // periodic retry stops so we don't re-type a doomed `claude --resume` into
    // the terminal forever. A fresh user focus still retries a Stuck session
    // via `set_focused_session`. A wake mid-confirm is `Waking` (state() reads
    // Asleep), so `begin_wake` inside `attempt_wake` no-ops rather than
    // re-typing.
    if let Some(session_id) = &focused {
        if state.sleep.lock().state(&session_id.0) == SleepState::Asleep {
            attempt_wake(app, &session_id.0);
        }
    }

    stop_candidates(app, &state, &ids, &tree, focused.as_ref(), &policy);
}

/// "Sleep idle sessions now": one pass with [`AutoSleep::NOW`], so it works with
/// auto-sleep off and ignores how briefly a session has been idle — while every
/// gate that protects work still applies. Returns how many sessions were told
/// to stop; each is confirmed Asleep by the normal ticker pass.
pub fn sleep_idle_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> usize {
    let state = app.state::<AppState>();
    let ids: Vec<SessionId> = state.sessions.lock().keys().cloned().collect();
    if ids.is_empty() {
        return 0;
    }
    refresh_idle_clocks(&state, &ids);
    let Some(survey) = crate::status_rt::process_table() else {
        return 0;
    };
    let tree = survey.tree();
    let focused = state.focused.lock().clone();
    stop_candidates(
        app,
        &state,
        &ids,
        &tree,
        focused.as_ref(),
        &kriyon_core::sleep::AutoSleep::NOW,
    )
}

/// Stop the `claude` of every session `policy` approves, and return how many.
/// The ledger lock is taken briefly and is never held across IO.
fn stop_candidates<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    ids: &[SessionId],
    tree: &ProcessTree,
    focused: Option<&SessionId>,
    policy: &kriyon_core::sleep::AutoSleep,
) -> usize {
    if !policy.enabled {
        return 0;
    }

    // Read everything the policy needs under one short lock, then act with it
    // released — `terminate` and the store read must never run under it.
    let now = Instant::now();
    let inputs: Vec<(SessionId, Option<u64>, bool, bool, bool)> = {
        let ledger = state.sleep.lock();
        ids.iter()
            .map(|id| {
                (
                    id.clone(),
                    ledger.idle_secs(&id.0, now),
                    ledger.has_running_shells(&id.0),
                    ledger.has_running_subagents(&id.0),
                    ledger.is_settling_or_asleep(&id.0),
                )
            })
            .collect()
    };

    let mut approved: Vec<(SessionId, String)> = Vec::new();
    for (id, idle_secs, has_running_shells, has_running_subagents, already_settling) in inputs {
        if already_settling {
            continue;
        }
        // Cheap gates first: looking the claude id up is a store read per
        // session per pass, and on a busy workspace nearly every session fails
        // a quiescence gate anyway.
        let quiescent = SleepCandidate {
            foreground: tree.foreground(&id.0),
            idle_secs,
            focused: focused == Some(&id),
            has_running_shells,
            has_running_subagents,
            claude_id: None,
        };
        if !is_quiescent(policy, &quiescent) {
            continue;
        }
        let stored = stored_claude_id(app, &id.0);
        let candidate = SleepCandidate {
            claude_id: stored.as_deref(),
            ..quiescent
        };
        if !should_sleep(policy, &candidate) {
            continue;
        }
        // `should_sleep` already required a safe id and a live claude; the id
        // is re-checked here so a session is never stopped without a way back.
        // The *pid* is deliberately not taken from `tree`: see `signallable`.
        let Some(claude_id) = stored else {
            continue;
        };
        approved.push((id, claude_id));
    }
    stop_approved(state, &approved)
}

/// Signal each approved session's `claude`, and open its stop in the ledger.
///
/// The pids come from a sweep taken *here*, never from the cached table that
/// approved the session: that table is up to [`PROCESS_TABLE_TTL`] old, and a
/// `claude` that exited inside that window leaves its number free for an
/// unrelated process to take (ADR 0022 — a signal never follows a pid read from
/// a seconds-old table). An unreadable sweep signals nothing: a session that
/// stays awake costs memory, a wrong SIGTERM costs someone else's work.
fn stop_approved(state: &AppState, approved: &[(SessionId, String)]) -> usize {
    if approved.is_empty() {
        return 0;
    }
    let Some(survey) = crate::status_rt::process_table_fresh() else {
        return 0;
    };
    let fresh = survey.tree();
    let mut stopped = 0;
    for (id, claude_id, pid) in signallable(&fresh, approved) {
        eprintln!("kriyon: sleeping session={} claude_pid={pid}", id.0);
        terminate(pid);
        state
            .sleep
            .lock()
            .begin_stop(id.0.clone(), claude_id, Instant::now());
        stopped += 1;
    }
    stopped
}

/// Each approved session's `claude` pid, re-derived from the sweep taken this
/// instant. A session whose `claude` is no longer under its daemon is dropped
/// rather than signalled — it has already gone, and its old number now belongs
/// to whoever the kernel gave it to.
fn signallable(
    fresh: &ProcessTree,
    approved: &[(SessionId, String)],
) -> Vec<(SessionId, String, i32)> {
    approved
        .iter()
        .filter_map(|(id, claude_id)| {
            fresh
                .claude_pid(&id.0)
                .map(|pid| (id.clone(), claude_id.clone(), pid))
        })
        .collect()
}

/// Track how long each session's status has sat at Idle/Done. Any active
/// status resets the clock; the entry starts counting when idleness is first
/// observed (never earlier — an unobserved past can't be trusted).
fn refresh_idle_clocks(state: &AppState, ids: &[SessionId]) {
    let statuses: Vec<(String, SessionStatus)> = {
        let runtimes = state.runtimes.lock();
        ids.iter()
            .filter_map(|id| runtimes.get(id).map(|rt| (id.0.clone(), rt.status())))
            .collect()
    };
    let now = Instant::now();
    let mut ledger = state.sleep.lock();
    for (id, status) in statuses {
        let idle = matches!(status, SessionStatus::Idle | SessionStatus::Done);
        ledger.note_idle(&id, idle, now);
    }
}

/// Feed each in-flight stop one observation of its terminal and act on whatever
/// the ledger decided. Confirmation is what makes the wake path safe: a session
/// is only ever asleep once its shell was *seen* at the prompt.
fn confirm_stops<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    tree: &ProcessTree,
) {
    let stopping = state.sleep.lock().stopping_ids();
    let now = Instant::now();
    for id in stopping {
        // One atomic ledger operation per observation: a session closed since
        // `stopping_ids` is simply gone, and cannot be confirmed back to life.
        let foreground = tree.foreground(&id);
        let transition = state.sleep.lock().observe(&id, foreground, now);
        match transition {
            Some(SleepTransition::Confirmed) => {
                eprintln!("kriyon: sleep confirmed session={id}");
                // Persist the mark only now — a confirmed stop is the first
                // point the session can be safely restored asleep after a
                // restart. Written before the emit so a crash between the two
                // still restores the moon next launch.
                persist_sleep_mark(app, &id, SleepState::Asleep);
                emit_state(app, &id, SleepState::Asleep);
            }
            Some(SleepTransition::Abandoned) => {
                eprintln!("kriyon: sleep abandoned (claude still up) session={id}");
            }
            // Vanished (closed mid-stop) and None need no action. Stuck/Woke
            // are listed for exhaustiveness only — `observe` never yields them
            // (they come solely from the wake path); if that ever changes, this
            // arm must grow an explicit branch.
            Some(SleepTransition::Vanished | SleepTransition::Stuck | SleepTransition::Woke)
            | None => {}
        }
    }
}

/// Clear the stop for any [Sleeping session] whose `claude` is observed back in
/// its terminal foreground — the user resumed it themselves (the `Stuck` UI
/// tells them to), or an earlier wake landed. Without this a manually-resumed
/// session sits moon-marked on a healthy claude forever, and the focused-wake
/// retry churns against it every pass.
fn reconcile_live_claude<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    tree: &ProcessTree,
) {
    let sleeping: Vec<String> = state
        .sleep
        .lock()
        .sleeping_sessions()
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let now = Instant::now();
    for id in sleeping {
        let foreground = tree.foreground(&id);
        if state.sleep.lock().note_resumed(&id, foreground, now) {
            eprintln!("kriyon: sleeping session resumed externally session={id}");
            persist_sleep_mark(app, &id, SleepState::Awake);
            emit_state(app, &id, SleepState::Awake);
        }
    }
}

/// Write (or clear, with an awake state) a session's persisted [Sleeping
/// session] mark, so a stopped session is restored asleep after a restart.
/// Best-effort: a store write failure is logged, never propagated — the live
/// ledger stays authoritative this run regardless.
fn persist_sleep_mark<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str, state: SleepState) {
    let store = app.state::<crate::StoreState>();
    let store = store.0.lock();
    if let Err(e) = store.set_sleep_state(id, state.persist_mark()) {
        eprintln!("kriyon: failed to persist sleep mark session={id} ({e})");
    }
}

/// The session's persisted [Claude session id], if any.
fn stored_claude_id<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) -> Option<String> {
    let store = app.state::<crate::StoreState>();
    let store = store.0.lock();
    store
        .session_row(id)
        .ok()
        .flatten()
        .and_then(|row| row.claude_session_id)
}

/// Try to wake a [Sleeping session], recording the outcome in the ledger.
///
/// The whole attempt runs under a ledger wake claim
/// ([`kriyon_core::sleep::SleepLedger::begin_wake`]): exactly one caller gets
/// to type the resume. Without the claim, the focus command and the ticker's
/// retry — different threads, same focused sleeping session — could both pass
/// an "is it sleeping?" check and both type `claude --resume`, the second line
/// landing inside the freshly resumed claude as a prompt.
///
/// A failure is normal and expected — the shell may not be back at its prompt
/// for a beat — so it is not surfaced. Failing for the whole retry window is
/// not: that flips the session to `Stuck` and tells the frontend, once.
pub fn attempt_wake<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    let state = app.state::<AppState>();
    let Some(claude_id) = state.sleep.lock().begin_wake(id, Instant::now()) else {
        return; // Not stopped, or another wake already holds the claim.
    };
    // Show the spinner immediately — the click already committed to waking, and
    // the resume + claude startup take a beat. The row stays "waking" until
    // `confirm_wakes` sees claude back (or the wake fails below).
    emit_current_phase(app, &state, id);
    // Do the resume IO on a detached thread, not the caller's — this runs on the
    // single background ticker (and on the focus command), and the socket write
    // can block on a wedged daemon. The `Waking` claim taken above means a
    // second pass's `begin_wake` returns `None`, so at most one wake thread is
    // ever in flight per session.
    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || {
        match type_resume(&app, &id, &claude_id) {
            // The resume was typed, but typing is not proof it took: the session
            // stays `Waking` (still reads asleep, moon on) until `confirm_wakes`
            // sees a `claude` back in its foreground. This mirrors the stop
            // path — a signal is only confirmed once the shell is *seen* at its
            // prompt — so a resume that silently fails no longer reports awake.
            Ok(()) => {
                eprintln!("kriyon: wake typed session={id} resume={claude_id} (awaiting confirm)");
            }
            Err(e) => {
                eprintln!("kriyon: wake deferred session={id} ({e})");
                let st = app.state::<AppState>();
                let transition = st.sleep.lock().note_wake_failed(&id, Instant::now());
                if transition == Some(SleepTransition::Stuck) {
                    eprintln!("kriyon: wake stuck session={id} ({e})");
                    // Persist the upgraded mark so a stuck session is restored
                    // stuck, not falsely peaceful, after a restart.
                    persist_sleep_mark(&app, &id, SleepState::Stuck);
                }
                // The claim rolled back out of Waking (to Asleep, or Stuck):
                // drop the spinner and show the resolved phase (the moon
                // returns until the focused-retry begins a fresh wake).
                emit_current_phase(&app, &st, &id);
            }
        }
    });
}

/// Confirm each typed wake against its terminal: a `claude` back in the
/// foreground means the resume took, so the session is awake; a shell still at
/// its prompt past the confirm window means it did not, so roll back and retry
/// (accruing toward `Stuck`). The wake-side mirror of [`confirm_stops`].
fn confirm_wakes<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    tree: &ProcessTree,
) {
    let waking = state.sleep.lock().waking_ids();
    let now = Instant::now();
    for id in waking {
        let foreground = tree.foreground(&id);
        let transition = state.sleep.lock().observe_wake(&id, foreground, now);
        match transition {
            Some(SleepTransition::Woke) => {
                eprintln!("kriyon: wake confirmed session={id}");
            }
            Some(SleepTransition::Stuck) => {
                eprintln!("kriyon: wake stuck (resume did not take) session={id}");
            }
            // Vanished (closed mid-wake); or None = still waiting, or a
            // timeout-rollback to Asleep. The wire-phase check below tells the
            // last two apart, so no per-variant handling is needed here.
            _ => {}
        }
        // A wake still in flight stays `Waking` — keep the spinner up, touch
        // nothing. Once it leaves `Waking` (confirmed awake, stuck, rolled back
        // to asleep, or vanished), persist and emit the resolved phase so the
        // spinner clears.
        if state.sleep.lock().wire_phase(&id) != "waking" {
            persist_sleep_mark(app, &id, state.sleep.lock().state(&id));
            emit_current_phase(app, state, &id);
        }
    }
}

/// Restore a session's persisted [Sleeping session] state at launch, and seed
/// the frontend with its current sleep phase. Called once per session as its
/// watch is (re)established — the same per-attach hook `seed_from_history`
/// uses — so it runs whether the whole app restarted or only the webview
/// reloaded.
///
/// Three cases, in order:
/// 1. The [Sleep ledger] already tracks this session (a live stop this run, or
///    an earlier reconcile): re-emit its phase so a reloaded webview repaints
///    the moon. The ledger is authoritative; the store is not consulted.
/// 2. A persisted mark plus a shell physically back at its prompt (the daemon
///    outlived the app, `claude` stayed stopped): restore the ledger to that
///    phase and emit it.
/// 3. A persisted mark but the daemon is gone (`NoDaemon`) — the slept state no
///    longer exists, so the mark is stale: clear it. A `Claude`/`Unknown`
///    foreground is left untouched (a later launch reconciles it) to avoid
///    clearing a mark for a session mid-relaunch.
pub fn reconcile_persisted_sleep<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    let state = app.state::<AppState>();

    // Case 1: the ledger already knows. Re-emit for a reloaded frontend.
    let live = state.sleep.lock().state(id);
    if live != SleepState::Awake {
        emit_state(app, id, live);
        return;
    }

    let store = app.state::<crate::StoreState>();
    let (mark, claude_id) = {
        let store = store.0.lock();
        let mark = store.sleep_state(id).ok().flatten();
        let claude_id = store
            .session_row(id)
            .ok()
            .flatten()
            .and_then(|row| row.claude_session_id);
        (mark, claude_id)
    };
    let (Some(mark), Some(claude_id)) = (mark, claude_id) else {
        return; // No mark, or nothing to resume it with.
    };
    let Some(restore_state) = SleepState::from_persist_mark(&mark) else {
        // A mark this build does not understand: clear it rather than trust it.
        persist_sleep_mark(app, id, SleepState::Awake);
        return;
    };
    if !kriyon_core::sleep::is_safe_claude_id(&claude_id) {
        persist_sleep_mark(app, id, SleepState::Awake);
        return;
    }

    let foreground = crate::status_rt::process_table().map_or(PtyForeground::Unknown, |survey| {
        survey.tree().foreground(id)
    });
    match foreground {
        // Case 2: the stopped state physically survives.
        PtyForeground::ShellPrompt => {
            let stuck = restore_state == SleepState::Stuck;
            if state
                .sleep
                .lock()
                .restore(id.to_string(), claude_id.clone(), stuck)
            {
                eprintln!("kriyon: restored sleeping session={id} state={mark}");
                emit_state(app, id, restore_state);
            }
        }
        // Case 3: the daemon is gone; the mark is stale.
        PtyForeground::NoDaemon => {
            persist_sleep_mark(app, id, SleepState::Awake);
        }
        // Claude running, or an unreadable table: leave the mark for a later
        // launch rather than guess.
        PtyForeground::Claude | PtyForeground::Unknown => {}
    }
}

/// The IO half of a claimed wake: verify the shell still sits at its prompt
/// and type `claude --resume <id>` into it. The caller owns the ledger claim
/// and settles it on this result.
///
/// # Errors
/// Returns an error string when the stored claude id is not resumable, the
/// terminal is not at the shell prompt, or the stdin write fails.
fn type_resume<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    claude_id: &str,
) -> Result<(), String> {
    if !kriyon_core::sleep::is_safe_claude_id(claude_id) {
        return Err("stored claude id is not resumable".to_string());
    }
    let foreground = crate::status_rt::process_table().map_or(PtyForeground::Unknown, |survey| {
        survey.tree().foreground(id)
    });
    if !can_type_resume(foreground) {
        return Err("terminal is not at the shell prompt".to_string());
    }
    // Clone the daemon handle out from under the sessions lock, then release the
    // lock before the (blocking) socket write. Holding it across the write —
    // now on the ticker thread — would freeze every command that touches the
    // sessions map behind a wedged daemon.
    let engine = {
        let state = app.state::<AppState>();
        let sessions = state.sessions.lock();
        std::sync::Arc::clone(
            &sessions
                .get(&SessionId(id.to_string()))
                .ok_or_else(|| "session not found".to_string())?
                .engine,
        )
    };
    // A leading `\x15` (kill-line) clears whatever the user may have half-typed
    // at the prompt before the resume lands — the ShellPrompt check proves the
    // shell owns the terminal, not that its input line is empty. Without it a
    // wake that races the user's keystrokes would run `<their text>claude
    // --resume …` as one garbled command.
    engine
        .write_stdin(format!("\x15claude --resume {claude_id}\r").as_bytes())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kriyon_core::proc::ProcRow;

    /// A daemon for `session` hosting a shell whose terminal foreground is
    /// `claude` — or, with `fg` `None`, a shell sitting at its own prompt
    /// because `claude` has already exited.
    fn table(session: &str, fg: Option<(i32, &str)>) -> Vec<ProcRow> {
        let tpgid = fg.map_or(200, |(pid, _)| pid);
        let mut rows = vec![
            ProcRow {
                pid: 100,
                ppid: 1,
                tpgid: -1,
                cmd: format!("/Applications/Kriyon.app/…/kriyon-ptyd /Users/x/.claude/kriyon/run/{session}.sock"),
            },
            ProcRow {
                pid: 200,
                ppid: 100,
                tpgid,
                cmd: "/bin/zsh -l".into(),
            },
        ];
        if let Some((pid, cmd)) = fg {
            rows.push(ProcRow {
                pid,
                ppid: 200,
                tpgid,
                cmd: cmd.into(),
            });
        }
        rows
    }

    /// The wrong-kill this guards: the pass approved the session from a process
    /// table up to two seconds old, and in that window its `claude` exited. The
    /// number it held is free, and the [Signal gate] rules out only pid ≤ 1 and
    /// ourselves — so signalling it reaches whoever has it now.
    #[test]
    fn a_claude_gone_since_the_approving_sweep_is_never_signalled() {
        let rows = table("sess-abc", None);
        let fresh = ProcessTree::new(&rows);
        let approved = vec![(SessionId("sess-abc".into()), "claude-1".to_string())];

        assert!(
            signallable(&fresh, &approved).is_empty(),
            "no claude under the daemon any more: nothing to signal"
        );
    }

    #[test]
    fn a_claude_the_fresh_sweep_still_shows_is_signalled_at_its_current_pid() {
        let rows = table("sess-abc", Some((3000, "claude --resume abc")));
        let fresh = ProcessTree::new(&rows);
        let approved = vec![(SessionId("sess-abc".into()), "claude-1".to_string())];

        let targets = signallable(&fresh, &approved);

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].0 .0, "sess-abc");
        assert_eq!(targets[0].2, 3000, "the pid the sweep shows now");
    }

    /// A session the fresh sweep has lost must not take its neighbours with it.
    #[test]
    fn one_vanished_session_does_not_stop_the_others() {
        let mut rows = table("sess-abc", Some((3000, "claude")));
        rows.extend(table("sess-gone", None).into_iter().map(|row| ProcRow {
            pid: row.pid + 1000,
            ppid: if row.ppid == 1 { 1 } else { row.ppid + 1000 },
            ..row
        }));
        let fresh = ProcessTree::new(&rows);
        let approved = vec![
            (SessionId("sess-gone".into()), "claude-0".to_string()),
            (SessionId("sess-abc".into()), "claude-1".to_string()),
        ];

        let targets = signallable(&fresh, &approved);

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].0 .0, "sess-abc");
    }
}
