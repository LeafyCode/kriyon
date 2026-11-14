//! Telling that the computer slept: the app's main loop ticks every second,
//! and a tick that finds the wall clock far past the last one means the
//! process didn't run meanwhile (the lid closed, Modern Standby). What runs
//! over the network, remote access's links above all, then acts at once
//! rather than waiting out its own timers.

use std::time::{Duration, SystemTime};

/// A gap between ticks this long means the computer slept (or the clock was
/// set ahead, which is handled the same and costs nothing).
pub const RESUME_GAP: Duration = Duration::from_secs(10);

/// The last tick's wall clock, to tell a wake from it.
#[derive(Clone, Copy, Debug, Default)]
pub struct ResumeWatch {
    last: Option<SystemTime>,
}

impl ResumeWatch {
    /// A tick at `now`: whether the computer slept since the last one.
    pub fn tick(&mut self, now: SystemTime) -> bool {
        let slept = self
            .last
            .is_some_and(|last| now.duration_since(last).is_ok_and(|gap| gap >= RESUME_GAP));
        self.last = Some(now);
        slept
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tick_long_after_the_last_is_a_wake_and_steady_ticks_are_not() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let mut watch = ResumeWatch::default();
        assert!(!watch.tick(t), "the first tick has nothing to compare");
        assert!(!watch.tick(t + Duration::from_secs(1)));
        assert!(
            !watch.tick(t + Duration::from_secs(9)),
            "a slow tick isn't a sleep"
        );
        assert!(watch.tick(t + Duration::from_secs(9) + RESUME_GAP), "slept");
        assert!(
            !watch.tick(t + Duration::from_secs(10) + RESUME_GAP),
            "once"
        );
        // A clock set back is no wake.
        assert!(!watch.tick(t));
    }
}
