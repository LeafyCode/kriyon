//! The menu-bar attention badge label: how many sessions currently need the user.

use crate::session::SessionStatus;

/// The one membership rule for "this session needs the user": it is `Waiting`
/// (blocked on the user) or has an open [`crate::ask::PendingAsk`]. Evaluated
/// per session by [`crate::runtime::SessionRuntime::needs_you`] — the badge
/// counts runtimes where it holds and the popover partitions on the same flag
/// stamped onto each `SessionSnapshot`, so the two can never drift apart.
#[must_use]
pub fn session_needs_you(status: SessionStatus, has_open_ask: bool) -> bool {
    status == SessionStatus::Waiting || has_open_ask
}

/// The tray title for the session counts: a bare number is "sessions that need
/// you" (blocked, or finished with output you haven't seen), `▸n` is "sessions
/// still working". `None` clears the title (nothing needs you, nothing runs).
/// A bare number always means attention — running never inflates it. Kept pure
/// so the label rule is unit-tested without a live tray.
#[must_use]
pub fn tray_title(needs_you: usize, running: usize) -> Option<String> {
    match (needs_you, running) {
        (0, 0) => None,
        (n, 0) => Some(n.to_string()),
        (0, r) => Some(format!("\u{25b8}{r}")),
        (n, r) => Some(format!("{n} \u{25b8}{r}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{session_needs_you, tray_title};
    use crate::session::SessionStatus;

    #[test]
    fn all_quiet_clears_the_title() {
        assert_eq!(tray_title(0, 0), None);
    }

    #[test]
    fn needs_you_alone_is_a_bare_number() {
        assert_eq!(tray_title(2, 0).as_deref(), Some("2"));
    }

    #[test]
    fn running_alone_wears_the_working_glyph() {
        assert_eq!(tray_title(0, 3).as_deref(), Some("\u{25b8}3"));
    }

    #[test]
    fn both_counts_read_needs_first_then_running() {
        assert_eq!(tray_title(1, 3).as_deref(), Some("1 \u{25b8}3"));
    }

    #[test]
    fn session_needs_you_is_waiting_or_open_ask() {
        // Waiting always needs the user, regardless of ask.
        assert!(session_needs_you(SessionStatus::Waiting, false));
        assert!(session_needs_you(SessionStatus::Waiting, true));
        // A running/idle/done session needs the user only with an open ask
        // (e.g. a permission prompt fired mid-turn).
        assert!(session_needs_you(SessionStatus::Running, true));
        assert!(!session_needs_you(SessionStatus::Running, false));
        assert!(!session_needs_you(SessionStatus::Idle, false));
        assert!(!session_needs_you(SessionStatus::Done, false));
        assert!(!session_needs_you(SessionStatus::Error, false));
    }
}
