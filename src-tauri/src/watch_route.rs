//! [Watch route] — the single consumer of a session watch's
//! [`WatchSignal`]s, routing each variant to app state and frontend events.
//!
//! This routing table used to be a ~95-line closure inlined in the
//! `watch_transcript` command — the one place where transport (Tauri emits),
//! state mutation (the [Session runtime] fold), and policy met, and the least
//! tested layer of the status pipeline. As a named module generic over
//! [`tauri::Runtime`] it is exercised end-to-end under the mock runtime: a
//! signal goes in, the runtimes map and the emitted events come out.

use kriyon_core::session::SessionId;
use kriyon_core::transcript::StudioEvent;
use tauri::Emitter as _;

use crate::watcher::WatchSignal;

/// Payload for the `session-usage` event: the session id plus its latest live
/// usage snapshot (from the statusLine wrapper).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UsagePayload {
    session_id: String,
    snapshot: kriyon_core::hooks::UsageSnapshot,
}

/// Payload for the `session-activity` event: the session id plus its latest
/// reconstructed activity snapshot (running subagents, background shells, tasks).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityPayload {
    session_id: String,
    snapshot: kriyon_core::activity::SessionActivity,
}

/// Payload for the `session-title` event: the (Kriyon) session id plus the
/// latest [Session title] Claude wrote (`ai-title`).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TitlePayload {
    session_id: String,
    title: String,
}

/// Payload for the `session-claude-id` event: the (Kriyon) session id plus the
/// [Claude session id] learned from hook events, persisted for `claude --resume`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeIdPayload {
    session_id: String,
    claude_session_id: String,
}

/// Payload for the `session-ready` event: fired when a session's underlying
/// (resumed or freshly started) Claude has fired its first live `SessionStart`
/// hook and is therefore up and idle. Drives dismissing the loading overlay.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyPayload {
    session_id: String,
}

/// Route one [`WatchSignal`] for `session_id`: fold status+ask into the
/// [Session runtime], forward the transcript to `on_transcript` (the command's
/// IPC channel in production, a plain sink in tests), and emit the per-variant
/// frontend events.
pub fn route<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &SessionId,
    on_transcript: &impl Fn(StudioEvent),
    signal: WatchSignal,
) {
    match signal {
        // The hook tailer seeks to EOF on subscribe, so any SessionStart seen
        // here is live: the (resumed) claude has booted and is idle. Signal
        // the frontend to dismiss the loading overlay.
        WatchSignal::Status { event, ask } => {
            if kriyon_core::hook_signal::classify(&event)
                == kriyon_core::hook_signal::HookSignal::SessionStarted
            {
                let _ = app.emit(
                    "session-ready",
                    ReadyPayload {
                        session_id: session_id.0.clone(),
                    },
                );
            }
            crate::handoff_rt::note_hook_event(app, session_id, &event);
            crate::status_rt::note_status_signal(app, session_id, &event, ask);
        }
        WatchSignal::Transcript(event) => {
            on_transcript(event);
        }
        WatchSignal::Usage(snapshot) => {
            // The status-line wrapper reports the main interactive session's
            // claude id — authoritative, since a one-shot `claude -p` and
            // subagents render no status line. Anchor status to it so a
            // terminal that cycled through nested/ended sessions still tracks
            // the live one. Same accessor the activity path uses (watcher
            // pump), so both main-session locks anchor to the same id.
            if let Some(claude_id) = snapshot.authoritative_main_id() {
                crate::status_rt::note_authoritative_main(app, session_id, claude_id);
            }
            let _ = app.emit(
                "session-usage",
                UsagePayload {
                    session_id: session_id.0.clone(),
                    snapshot,
                },
            );
        }
        WatchSignal::Activity(snapshot) => {
            // The snapshot's [Background shell] claims have already been
            // re-derived from a sweep by the watch itself (`ActivitySource`),
            // upstream of its change gate — nothing in the hook stream closes a
            // shell (ADR 0002), so a retraction is the only signal a dead dev
            // server produces, and a quiet session emits no other.
            //
            // Mirror the two "live background work" vetoes for the sleep pass —
            // the ticker can't reach the watcher's projection directly. A
            // session whose claude hosts a live shell (a dev server), or is
            // orchestrating a running [Subagent], must never be slept: stopping
            // its claude would kill that work. The subagent case is the subtle
            // one — the main session reads Idle while a subagent runs (its hook
            // events are filtered by the [Main session lock]), so without this
            // veto the idle clock would sleep a session that is hard at work.
            {
                use kriyon_core::activity::{ShellStatus, SubagentState};
                use tauri::Manager as _;
                let state = app.state::<crate::AppState>();
                let running_shells = snapshot
                    .shells
                    .iter()
                    .any(|shell| shell.status == ShellStatus::Running);
                let running_subagents = snapshot
                    .subagents
                    .iter()
                    .any(|sub| sub.state == SubagentState::Running);
                let mut sleep = state.sleep.lock();
                sleep.note_running_shells(&session_id.0, running_shells);
                sleep.note_running_subagents(&session_id.0, running_subagents);
            }
            let _ = app.emit(
                "session-activity",
                ActivityPayload {
                    session_id: session_id.0.clone(),
                    snapshot,
                },
            );
        }
        WatchSignal::Title(title) => {
            let _ = app.emit(
                "session-title",
                TitlePayload {
                    session_id: session_id.0.clone(),
                    title,
                },
            );
        }
        WatchSignal::ClaudeId(claude_session_id) => {
            // Persist the id backend-side immediately, not only via the
            // frontend's debounced round-trip: the [Sleeping session] wake path
            // reads it straight from the store, and a webview reload or a lost
            // debounce would otherwise leave it stale (or missing) exactly when
            // auto-sleep needs it to guarantee the session can be woken.
            {
                use tauri::Manager as _;
                let store = app.state::<crate::StoreState>();
                let result = store
                    .0
                    .lock()
                    .set_claude_session_id(&session_id.0, &claude_session_id);
                if let Err(e) = result {
                    eprintln!(
                        "kriyon: failed to persist claude id session={} ({e})",
                        session_id.0
                    );
                }
            }
            let _ = app.emit(
                "session-claude-id",
                ClaudeIdPayload {
                    session_id: session_id.0.clone(),
                    claude_session_id,
                },
            );
        }
        // The transcript pipeline is headless (ADR 0019): nothing renders these
        // events, but usage totals, unseen-output badges, the Needs-you snippet
        // and the handoff prompt are all derived from them, so drift thins those
        // silently. This log is the only place it surfaces at all — it is the
        // signal that SUPPORTED_TRANSCRIPT_SCHEMA is due a bump (see ADR 0003).
        WatchSignal::Drift(report) => {
            eprintln!(
                "kriyon: session {} transcript-derived data degraded — drift {}/{} events unknown ({:.0}%), parser schema v{}",
                session_id.0,
                report.unknown_lines,
                report.total_lines,
                report.unknown_ratio() * 100.0,
                kriyon_core::transcript::SUPPORTED_TRANSCRIPT_SCHEMA,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::route;
    use crate::store::Store;
    use crate::{AppState, StoreState};
    use kriyon_core::ask::{AskKind, PendingAsk};
    use kriyon_core::hooks::HookEvent;
    use kriyon_core::session::{SessionId, SessionStatus};
    use kriyon_core::status::NotifyPreference;
    use kriyon_core::transcript::StudioEvent;
    use parking_lot::Mutex;
    use tauri::Manager as _;

    /// A mock-runtime app with managed state, notifications muted (the route
    /// under test is state + emits, not OS notification dispatch).
    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(AppState::default());
        app.manage(StoreState(Mutex::new(
            Store::open_in_memory().expect("in-memory store"),
        )));
        *app.state::<AppState>().notify_pref.lock() = NotifyPreference::None;
        app
    }

    fn sink() -> impl Fn(StudioEvent) {
        |_| {}
    }

    fn ev(event: &str) -> HookEvent {
        HookEvent {
            event: event.to_string(),
            session_id: Some("c1".to_string()),
            ..HookEvent::default()
        }
    }

    fn permission_ask() -> PendingAsk {
        PendingAsk {
            kind: AskKind::Permission,
            text: "Claude needs your permission to use Bash".to_string(),
            asked_at: None,
        }
    }

    #[test]
    fn a_turn_that_wrote_a_handoff_file_emits_session_handoff_on_stop() {
        use tauri::Listener as _;
        let app = mock_app();
        let handle = app.handle();
        let id = SessionId("s1".to_string());
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("handoff-test.md");
        std::fs::write(&file, "# Handoff").expect("write");

        let seen = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let sink_seen = seen.clone();
        handle.listen("session-handoff", move |e| {
            sink_seen.lock().push(e.payload().to_string());
        });

        let mut wrote = ev("PostToolUse");
        wrote.tool_name = Some("Write".to_string());
        wrote.target = Some(file.to_string_lossy().into_owned());
        for event in [wrote, ev("Stop")] {
            route(
                handle,
                &id,
                &sink(),
                crate::watcher::WatchSignal::Status { event, ask: None },
            );
        }

        let seen = seen.lock();
        assert_eq!(seen.len(), 1, "one card per finished handoff turn");
        let canonical = std::fs::canonicalize(&file).expect("canon");
        assert!(seen[0].contains("\"sessionId\":\"s1\""));
        assert!(seen[0].contains(&*canonical.to_string_lossy()));
    }

    #[test]
    fn status_signal_folds_status_and_ask_into_the_runtime() {
        let app = mock_app();
        let handle = app.handle();
        let id = SessionId("s1".to_string());

        let mut blocked = ev("Notification");
        blocked.message = Some("Claude needs your permission to use Bash".to_string());
        route(
            handle,
            &id,
            &sink(),
            crate::watcher::WatchSignal::Status {
                event: blocked,
                ask: Some(permission_ask()),
            },
        );

        let state = handle.state::<AppState>();
        let runtimes = state.runtimes.lock();
        let rt = runtimes.get(&id).expect("runtime created by the signal");
        assert_eq!(rt.status(), SessionStatus::Waiting);
        assert!(rt.ask().is_some(), "the ask rode the same signal");
        assert!(rt.needs_you());
    }

    #[test]
    fn ask_clearing_flips_needs_you_even_while_running() {
        // A mid-turn permission opens and resolves while status stays Running:
        // needs_you must follow the ask, not wait for a status transition.
        let app = mock_app();
        let handle = app.handle();
        let id = SessionId("s1".to_string());

        let mut pre = ev("PreToolUse");
        pre.tool_name = Some("Bash".to_string());
        route(
            handle,
            &id,
            &sink(),
            crate::watcher::WatchSignal::Status {
                event: pre,
                ask: Some(permission_ask()),
            },
        );
        {
            let state = handle.state::<AppState>();
            let runtimes = state.runtimes.lock();
            let rt = runtimes.get(&id).expect("runtime");
            assert_eq!(rt.status(), SessionStatus::Running);
            assert!(rt.needs_you(), "running + open ask needs the user");
        }

        let mut post = ev("PostToolUse");
        post.tool_name = Some("Bash".to_string());
        route(
            handle,
            &id,
            &sink(),
            crate::watcher::WatchSignal::Status {
                event: post,
                ask: None,
            },
        );
        let state = handle.state::<AppState>();
        let runtimes = state.runtimes.lock();
        let rt = runtimes.get(&id).expect("runtime");
        assert!(!rt.needs_you(), "the resolved ask must clear needs-you");
    }

    #[test]
    fn a_turn_finishing_off_screen_counts_until_seen() {
        // The user is not looking (window unfocused in this mock): a turn
        // ending must mark the session finished-with-unseen-output so the
        // menu-bar count includes it; focusing it clears the flag.
        let app = mock_app();
        let handle = app.handle();
        let id = SessionId("s1".to_string());

        route(
            handle,
            &id,
            &sink(),
            crate::watcher::WatchSignal::Status {
                event: ev("UserPromptSubmit"),
                ask: None,
            },
        );
        route(
            handle,
            &id,
            &sink(),
            crate::watcher::WatchSignal::Status {
                event: ev("Stop"),
                ask: None,
            },
        );

        let state = handle.state::<AppState>();
        {
            let runtimes = state.runtimes.lock();
            let rt = runtimes.get(&id).expect("runtime");
            assert_eq!(rt.status(), SessionStatus::Done);
            assert!(rt.needs_you(), "done off-screen = unseen output = counts");
        }
        state
            .runtimes
            .lock()
            .get_mut(&id)
            .expect("runtime")
            .mark_seen();
        assert!(!state.runtimes.lock().get(&id).expect("runtime").needs_you());
    }

    #[test]
    fn usage_signal_anchors_the_main_session_id() {
        let app = mock_app();
        let handle = app.handle();
        let id = SessionId("s1".to_string());

        // A runtime must exist (the command registers one on subscribe).
        handle
            .state::<AppState>()
            .runtimes
            .lock()
            .entry(id.clone())
            .or_default();

        let snapshot = kriyon_core::hooks::parse_usage_snapshot(
            r#"{"usedPercentage":10.0,"sessionId":"claude-main"}"#,
        )
        .expect("snapshot parses");
        route(
            handle,
            &id,
            &sink(),
            crate::watcher::WatchSignal::Usage(snapshot),
        );

        let state = handle.state::<AppState>();
        let runtimes = state.runtimes.lock();
        assert_eq!(
            runtimes.get(&id).expect("runtime").main_session_id(),
            Some("claude-main"),
        );
    }

    #[test]
    fn transcript_signal_reaches_the_sink() {
        let app = mock_app();
        let handle = app.handle();
        let id = SessionId("s1".to_string());
        let seen = std::cell::RefCell::new(0_usize);

        route(
            handle,
            &id,
            &|_ev| {
                *seen.borrow_mut() += 1;
            },
            crate::watcher::WatchSignal::Transcript(StudioEvent {
                id: "line-1:0".to_string(),
                event: kriyon_core::transcript::StructuredEvent::Prompt {
                    text: "hi".to_string(),
                },
            }),
        );
        assert_eq!(*seen.borrow(), 1);
    }
}
