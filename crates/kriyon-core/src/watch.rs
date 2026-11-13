//! [Watcher]s: who is looking at which [Session] right now.
//!
//! "Someone is looking" protects a session from being stopped behind their
//! back — auto-sleep never sleeps a watched session. Today the only watcher is
//! the desktop app's focused pane; a remote device is meant to become another
//! [`Watcher`] here, so every rule that asks "is anyone looking?" counts it
//! without changing.

use std::collections::HashMap;

/// Something that can be looking at a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Watcher {
    /// The desktop app, looking at its focused session.
    Desktop,
}

/// Which session each [`Watcher`] is looking at. A watcher looks at one
/// session at most; a session may have several watchers.
#[derive(Clone, Debug, Default)]
pub struct Watchers {
    looking_at: HashMap<Watcher, String>,
}

impl Watchers {
    /// Record what `watcher` is looking at now: `Some(session)`, or `None` when
    /// it looks at nothing.
    pub fn look(&mut self, watcher: Watcher, session_id: Option<&str>) {
        match session_id {
            Some(id) => {
                self.looking_at.insert(watcher, id.to_owned());
            }
            None => {
                self.looking_at.remove(&watcher);
            }
        }
    }

    /// Whether any watcher is looking at `session_id`.
    #[must_use]
    pub fn is_watched(&self, session_id: &str) -> bool {
        self.looking_at.values().any(|id| id == session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nobody_watches_a_session_until_a_watcher_looks_at_it() {
        let mut watchers = Watchers::default();
        assert!(!watchers.is_watched("a"));
        watchers.look(Watcher::Desktop, Some("a"));
        assert!(watchers.is_watched("a"));
        assert!(!watchers.is_watched("b"));
    }

    #[test]
    fn a_watcher_looks_at_one_session_at_a_time() {
        let mut watchers = Watchers::default();
        watchers.look(Watcher::Desktop, Some("a"));
        watchers.look(Watcher::Desktop, Some("b"));
        assert!(!watchers.is_watched("a"));
        assert!(watchers.is_watched("b"));
        watchers.look(Watcher::Desktop, None);
        assert!(!watchers.is_watched("b"));
    }
}
