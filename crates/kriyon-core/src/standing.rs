//! The [Standing state] of a session and the host's [Session list], computed
//! in Rust so the host can answer without the window. The standing rule is
//! the desktop's `standingState` (`src/state/commandCenter.ts`); both are held
//! to `scripts/standing-cases.json`.

use serde::Serialize;

use crate::session::SessionStatus;

/// How long a session's watcher may go unheard-from before its last status
/// is no longer trusted: about three of the app's 2 s heartbeats.
pub const STALE_AFTER_MS: i64 = 6000;

/// The [Standing state] a session is shown with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StandingState {
    Running,
    AwaitingInput,
    Changed,
    Idle,
    Unknown,
}

/// The [Standing state] for a session: `Unknown` when its hooks are off (no
/// status ever arrives), when its watcher was never heard from, or when it was
/// last heard more than [`STALE_AFTER_MS`] from now in either direction;
/// otherwise its [Status], presented.
#[must_use]
pub fn standing_state(
    status: SessionStatus,
    hooks_off: bool,
    last_seen_ms: Option<i64>,
    now_ms: i64,
) -> StandingState {
    let fresh = last_seen_ms.is_some_and(|seen| (now_ms - seen).abs() <= STALE_AFTER_MS);
    if hooks_off || !fresh {
        return StandingState::Unknown;
    }
    match status {
        SessionStatus::Running => StandingState::Running,
        SessionStatus::Waiting => StandingState::AwaitingInput,
        SessionStatus::Done | SessionStatus::Error => StandingState::Changed,
        SessionStatus::Idle => StandingState::Idle,
    }
}

/// What a session's [Session runtime] says, for the [Session list]. The
/// default is a session with no runtime yet: idle, needing nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeFacts {
    pub status: SessionStatus,
    pub hooks_off: bool,
    /// The runtime's `needs_you`.
    pub needs_you: bool,
    /// When its status last changed; `None` falls back to the row's creation.
    pub last_change_ms: Option<i64>,
}

impl Default for RuntimeFacts {
    fn default() -> Self {
        Self {
            status: SessionStatus::Idle,
            hooks_off: false,
            needs_you: false,
            last_change_ms: None,
        }
    }
}

/// What the host knows about one session, gathered from its store row, its
/// [Session runtime], its watcher and its [PTY daemon].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionFacts {
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub created_at_ms: i64,
    /// Archived or parked: not on the rail, so not listed.
    pub put_away: bool,
    pub runtime: RuntimeFacts,
    /// When its watcher was last heard from.
    pub last_seen_ms: Option<i64>,
    /// When the [Activity log] last saw it work: the change time to fall back
    /// on before its creation, after an app restart.
    pub last_active_ms: Option<i64>,
    /// A [CLI dialog] shows (see `cli_dialog::dialog_showing`).
    pub dialog_open: bool,
    /// Its [Session digest], for remote devices' Home.
    pub digest: crate::session_digest::SessionDigest,
}

/// One session in the [Session list].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListEntry {
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub status: SessionStatus,
    pub standing: StandingState,
    pub needs_you: bool,
    pub dialog_open: bool,
    pub last_change_ms: i64,
    /// Its [Session digest]: for remote devices, not the desktop's list.
    #[serde(skip)]
    pub digest: crate::session_digest::SessionDigest,
}

/// The host's [Session list] at `now_ms`: every session not put away, those
/// that need the person first (the longest waiting first), then the rest (the
/// most recently changed first), the newest session first on a tie. A
/// session's last change is its runtime's, else the [Activity log]'s last
/// activity, else its creation, and a status change counts as its watcher
/// heard from: both as the desktop's command center does.
#[must_use]
pub fn session_list(facts: Vec<SessionFacts>, now_ms: i64) -> Vec<SessionListEntry> {
    let mut list: Vec<(i64, SessionListEntry)> = facts
        .into_iter()
        .filter(|f| !f.put_away)
        .map(|f| {
            // A status change is the watcher heard from, as on the desktop.
            let seen = f.last_seen_ms.max(f.runtime.last_change_ms);
            let entry = SessionListEntry {
                standing: standing_state(f.runtime.status, f.runtime.hooks_off, seen, now_ms),
                last_change_ms: f
                    .runtime
                    .last_change_ms
                    .or(f.last_active_ms)
                    .unwrap_or(f.created_at_ms),
                id: f.id,
                title: f.title,
                project_id: f.project_id,
                status: f.runtime.status,
                needs_you: f.runtime.needs_you,
                dialog_open: f.dialog_open,
                digest: f.digest,
            };
            (f.created_at_ms, entry)
        })
        .collect();
    list.sort_by(|(a_made, a), (b_made, b)| {
        let by_change = if a.needs_you {
            a.last_change_ms.cmp(&b.last_change_ms)
        } else {
            b.last_change_ms.cmp(&a.last_change_ms)
        };
        b.needs_you
            .cmp(&a.needs_you)
            .then(by_change)
            .then(b_made.cmp(a_made))
    });
    list.into_iter().map(|(_, entry)| entry).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        status: SessionStatus,
        hooks_off: bool,
        last_seen_ms: Option<i64>,
        now_ms: i64,
        standing: StandingState,
    }

    #[test]
    fn every_shared_case_stands_as_the_desktop_says() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../scripts/standing-cases.json")).expect("cases");
        assert!(cases.len() > 5);
        for case in cases {
            assert_eq!(
                standing_state(case.status, case.hooks_off, case.last_seen_ms, case.now_ms),
                case.standing,
                "{}",
                case.name
            );
        }
    }

    fn facts(id: &str) -> SessionFacts {
        SessionFacts {
            id: id.into(),
            title: format!("title {id}"),
            project_id: "p".into(),
            created_at_ms: 1_000,
            put_away: false,
            runtime: RuntimeFacts::default(),
            last_seen_ms: Some(50_000),
            last_active_ms: None,
            dialog_open: false,
            digest: crate::session_digest::SessionDigest::default(),
        }
    }

    fn changed_at(id: &str, ms: i64, needs_you: bool) -> SessionFacts {
        SessionFacts {
            runtime: RuntimeFacts {
                last_change_ms: Some(ms),
                needs_you,
                ..RuntimeFacts::default()
            },
            ..facts(id)
        }
    }

    #[test]
    fn a_put_away_session_is_not_listed() {
        let list = session_list(
            vec![
                SessionFacts {
                    put_away: true,
                    ..facts("parked")
                },
                facts("on the rail"),
            ],
            50_000,
        );
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["on the rail"]);
    }

    #[test]
    fn those_that_need_you_come_first_longest_waiting_first_then_most_recent() {
        let list = session_list(
            vec![
                changed_at("old idle", 10_000, false),
                changed_at("new ask", 40_000, true),
                changed_at("recent idle", 30_000, false),
                changed_at("old ask", 20_000, true),
            ],
            50_000,
        );
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["old ask", "new ask", "recent idle", "old idle"]);
    }

    #[test]
    fn an_entry_carries_its_standing_dialog_and_change_time() {
        let list = session_list(
            vec![SessionFacts {
                runtime: RuntimeFacts {
                    status: SessionStatus::Waiting,
                    needs_you: true,
                    ..RuntimeFacts::default()
                },
                dialog_open: true,
                ..facts("s")
            }],
            50_000,
        );
        assert_eq!(
            list,
            [SessionListEntry {
                id: "s".into(),
                title: "title s".into(),
                project_id: "p".into(),
                status: SessionStatus::Waiting,
                standing: StandingState::AwaitingInput,
                needs_you: true,
                dialog_open: true,
                // Never changed since it was made.
                last_change_ms: 1_000,
                digest: crate::session_digest::SessionDigest::default(),
            }]
        );
    }

    #[test]
    fn after_a_restart_the_activity_log_says_when_it_last_changed() {
        let list = session_list(
            vec![SessionFacts {
                last_active_ms: Some(30_000),
                ..facts("worked an hour ago")
            }],
            50_000,
        );
        assert_eq!(list[0].last_change_ms, 30_000);
        let live = session_list(
            vec![SessionFacts {
                last_active_ms: Some(30_000),
                ..changed_at("changed since", 40_000, false)
            }],
            50_000,
        );
        assert_eq!(live[0].last_change_ms, 40_000, "a live change wins");
    }

    #[test]
    fn a_fresh_status_change_counts_as_being_heard_from() {
        let list = session_list(
            vec![SessionFacts {
                last_seen_ms: None,
                runtime: RuntimeFacts {
                    status: SessionStatus::Waiting,
                    last_change_ms: Some(49_000),
                    ..RuntimeFacts::default()
                },
                ..facts("s")
            }],
            50_000,
        );
        assert_eq!(list[0].standing, StandingState::AwaitingInput);
    }

    #[test]
    fn equal_change_times_put_the_newest_session_first() {
        let list = session_list(
            vec![
                SessionFacts {
                    created_at_ms: 1_000,
                    ..facts("older")
                },
                SessionFacts {
                    created_at_ms: 2_000,
                    last_active_ms: Some(1_000),
                    ..facts("newer")
                },
            ],
            50_000,
        );
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["newer", "older"]);
    }
}
