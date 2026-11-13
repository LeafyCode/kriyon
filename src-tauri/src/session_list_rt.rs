//! The host's [Session list]: the store's session rows joined with what the
//! app knows live (each [Session runtime], its watcher's heartbeat, its [PTY
//! daemon]'s [CLI dialog]), handed to `kriyon_core::standing::session_list`.
//! Answers without the window, for remote devices.

use std::collections::HashMap;
use std::time::{Instant, SystemTime};

use kriyon_core::ask::PendingAsk;
use kriyon_core::cli_dialog::dialog_showing;
use kriyon_core::session::SessionId;
use kriyon_core::standing::{session_list, RuntimeFacts, SessionFacts, SessionListEntry};

use crate::store::SessionRow;
use crate::{AppState, StoreState};

/// What the app knows live about one session, snapshotted from its locks.
#[derive(Clone, Debug, Default)]
struct Live {
    runtime: Option<RuntimeFacts>,
    ask: Option<PendingAsk>,
    last_seen_ms: Option<i64>,
    /// The daemon's own screen shows a [CLI dialog].
    dialog_on_screen: bool,
}

/// Join the store's `rows` with what is known `live` about each, and when
/// the [Activity log] last saw each work (`last_active`, by session id).
fn gather(
    rows: Vec<SessionRow>,
    live: &HashMap<SessionId, Live>,
    last_active: &HashMap<String, i64>,
) -> Vec<SessionFacts> {
    rows.into_iter()
        .map(|row| {
            let known = live.get(&SessionId(row.id.clone()));
            SessionFacts {
                put_away: row.archived_at.is_some() || row.parked_at.is_some(),
                created_at_ms: row.created_at,
                runtime: known.and_then(|k| k.runtime.clone()).unwrap_or_default(),
                last_seen_ms: known.and_then(|k| k.last_seen_ms),
                last_active_ms: last_active.get(&row.id).copied(),
                dialog_open: known
                    .is_some_and(|k| dialog_showing(k.dialog_on_screen, k.ask.as_ref())),
                id: row.id,
                title: row.title,
                project_id: row.project_id,
            }
        })
        .collect()
}

/// The [Session list] now.
///
/// # Errors
/// When the store cannot be read.
pub fn current(state: &AppState, store: &StoreState) -> Result<Vec<SessionListEntry>, String> {
    let rows = store.0.lock().list_sessions().map_err(|e| e.to_string())?;
    let now = Instant::now();
    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    // One lock at a time, each released before the next.
    let mut live: HashMap<SessionId, Live> = HashMap::new();
    for (id, runtime) in state.runtimes.lock().iter() {
        let entry = live.entry(id.clone()).or_default();
        entry.runtime = Some(runtime.list_facts(now, now_ms));
        entry.ask = runtime.ask().cloned();
    }
    for (id, watch) in state.watchers.lock().iter() {
        live.entry(id.clone()).or_default().last_seen_ms =
            i64::try_from(watch.last_pump_millis()).ok();
    }
    for (id, session) in state.sessions.lock().iter() {
        live.entry(id.clone()).or_default().dialog_on_screen =
            session.engine.dialog().is_some_and(|d| d.open);
    }
    let last_active = crate::activity_rt::last_active_by_session();
    Ok(session_list(gather(rows, &live, &last_active), now_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kriyon_core::ask::AskKind;
    use kriyon_core::session::SessionStatus;

    fn row(id: &str) -> SessionRow {
        SessionRow {
            id: id.into(),
            project_id: "p".into(),
            title: format!("title {id}"),
            cwd: "/w".into(),
            worktree_path: None,
            created_at: 7,
            claude_session_id: None,
            archived_at: None,
            baseline_oid: None,
            title_locked: false,
            nested_under: None,
            parent_session_id: None,
            parked_at: None,
            pinned_at: None,
        }
    }

    fn by_id(facts: &[SessionFacts], id: &str) -> SessionFacts {
        facts.iter().find(|f| f.id == id).cloned().expect("listed")
    }

    #[test]
    fn rows_are_joined_with_what_is_known_live() {
        let mut live = HashMap::new();
        live.insert(
            SessionId("asking".into()),
            Live {
                runtime: Some(RuntimeFacts {
                    status: SessionStatus::Waiting,
                    needs_you: true,
                    ..RuntimeFacts::default()
                }),
                // A question shows as a dialog even before the screen says so.
                ask: Some(PendingAsk {
                    kind: AskKind::Question,
                    text: "Which?".into(),
                    asked_at: None,
                }),
                last_seen_ms: Some(99),
                dialog_on_screen: false,
            },
        );
        live.insert(
            SessionId("menu".into()),
            Live {
                dialog_on_screen: true,
                ..Live::default()
            },
        );
        let facts = gather(
            vec![
                row("asking"),
                row("menu"),
                row("not started"),
                SessionRow {
                    archived_at: Some(1),
                    ..row("archived")
                },
                SessionRow {
                    parked_at: Some(1),
                    ..row("parked")
                },
            ],
            &live,
            &HashMap::from([("not started".to_string(), 5)]),
        );
        let asking = by_id(&facts, "asking");
        assert!(asking.runtime.needs_you);
        assert!(asking.dialog_open);
        assert_eq!(asking.last_seen_ms, Some(99));
        assert_eq!(asking.title, "title asking");
        assert_eq!(asking.created_at_ms, 7);
        assert!(by_id(&facts, "menu").dialog_open);
        let fresh = by_id(&facts, "not started");
        assert_eq!(fresh.runtime, RuntimeFacts::default());
        assert!(!fresh.dialog_open);
        assert_eq!(fresh.last_seen_ms, None);
        assert_eq!(fresh.last_active_ms, Some(5), "from the activity log");
        assert_eq!(asking.last_active_ms, None);
        assert!(by_id(&facts, "archived").put_away);
        assert!(by_id(&facts, "parked").put_away);
        assert!(!asking.put_away);
    }
}
