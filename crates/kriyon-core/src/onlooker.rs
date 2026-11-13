//! [Onlooker]s: who is looking at which [Session] right now.
//!
//! "Someone is looking" protects a session from being stopped behind their
//! back — auto-sleep never sleeps a session someone is looking at. Today the only onlooker is
//! the desktop app's focused pane; a remote device is meant to become another
//! [`Onlooker`] here, so every rule that asks "is anyone looking?" counts it
//! without changing.

use std::collections::HashMap;

/// Something that can be looking at a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Onlooker {
    /// The desktop app, looking at its focused session.
    Desktop,
}

/// Which session each [`Onlooker`] is looking at. A onlooker looks at one
/// session at most; a session may have several onlookers.
#[derive(Clone, Debug, Default)]
pub struct Onlookers {
    looking_at: HashMap<Onlooker, String>,
}

impl Onlookers {
    /// Record what `onlooker` is looking at now: `Some(session)`, or `None` when
    /// it looks at nothing.
    pub fn look(&mut self, onlooker: Onlooker, session_id: Option<&str>) {
        match session_id {
            Some(id) => {
                self.looking_at.insert(onlooker, id.to_owned());
            }
            None => {
                self.looking_at.remove(&onlooker);
            }
        }
    }

    /// Whether any onlooker is looking at `session_id`.
    #[must_use]
    pub fn has_onlooker(&self, session_id: &str) -> bool {
        self.looking_at.values().any(|id| id == session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nobody_looks_at_a_session_until_an_onlooker_does() {
        let mut onlookers = Onlookers::default();
        assert!(!onlookers.has_onlooker("a"));
        onlookers.look(Onlooker::Desktop, Some("a"));
        assert!(onlookers.has_onlooker("a"));
        assert!(!onlookers.has_onlooker("b"));
    }

    #[test]
    fn an_onlooker_looks_at_one_session_at_a_time() {
        let mut onlookers = Onlookers::default();
        onlookers.look(Onlooker::Desktop, Some("a"));
        onlookers.look(Onlooker::Desktop, Some("b"));
        assert!(!onlookers.has_onlooker("a"));
        assert!(onlookers.has_onlooker("b"));
        onlookers.look(Onlooker::Desktop, None);
        assert!(!onlookers.has_onlooker("b"));
    }
}
