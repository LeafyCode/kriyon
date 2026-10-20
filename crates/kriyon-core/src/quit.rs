//! [Quit intent] — what the app's exit does to the [Session]s still alive.
//!
//! A [PTY daemon] outlives the app, so *every* exit has to decide on purpose
//! whether its sessions go with it. A deliberate quit stops them: a `claude`
//! tree holding half a gigabyte with no window anywhere is a leak, not a
//! feature. An accident — a crash, a force-quit — never reaches this code at
//! all, which is exactly the [Handover] that lets the next launch reattach.

use serde::{Deserialize, Serialize};

/// What an exit should do to live sessions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuitIntent {
    /// Stop every session. The only thing a quit gesture can mean — and
    /// therefore also what an exit that never passed the quit gate gets (the
    /// Dock's Quit, a logout): those still reach the exit handler, and must not
    /// leave sessions behind.
    #[default]
    StopAll,
    /// Touch nothing. An update restart: the next launch reattaches.
    Handover,
}

impl QuitIntent {
    /// Whether live sessions are left running.
    ///
    /// A quit is a quit. There is no "quit but keep that turn going": the quit
    /// gate's only choice is whether to go through with it, so the one exit a
    /// user can ask for stops everything. Work is never lost by it — the
    /// conversation survives (`claude --resume`), and the dialog names the
    /// background commands that do not, before anything is signalled.
    #[must_use]
    pub const fn spares(self) -> bool {
        matches!(self, Self::Handover)
    }

    /// Whether the frontend may ask for this intent. `Handover` is decided by
    /// the app itself (an update restart), never by a quit gesture.
    #[must_use]
    pub const fn is_user_choice(self) -> bool {
        !matches!(self, Self::Handover)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exit_nobody_chose_anything_for_stops_every_session() {
        assert_eq!(QuitIntent::default(), QuitIntent::StopAll);
        assert!(!QuitIntent::StopAll.spares());
    }

    #[test]
    fn a_handover_touches_nothing() {
        assert!(QuitIntent::Handover.spares());
    }

    #[test]
    fn a_handover_is_never_a_user_choice() {
        assert!(QuitIntent::StopAll.is_user_choice());
        assert!(!QuitIntent::Handover.is_user_choice());
    }

    #[test]
    fn the_wire_names_are_camel_case() {
        let parsed: QuitIntent = serde_json::from_str("\"stopAll\"").expect("parse");
        assert_eq!(parsed, QuitIntent::StopAll);
        assert!(serde_json::from_str::<QuitIntent>("\"nonsense\"").is_err());
    }

    #[test]
    fn letting_work_finish_is_gone_from_the_wire() {
        // A quit is a quit: the only choice the dialog offers is to cancel it.
        assert!(serde_json::from_str::<QuitIntent>("\"letWorkingFinish\"").is_err());
    }
}
