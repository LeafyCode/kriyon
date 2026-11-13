//! The [Detached lease]: how long a [PTY daemon] no [Watcher] is attached to
//! tolerates a silent terminal before it [Tree stop]s itself.
//!
//! A daemon outlives the app on purpose, so something has to bound a daemon the
//! app never comes back to: one left to finish its turn at quit, the survivor of
//! a crash that was never followed by a relaunch, a machine the app was
//! uninstalled from. Without a bound those hold a `claude` tree until reboot.
//!
//! The signal is the PTY itself. A working `claude` repaints its spinner and
//! timer continuously; a finished one, or one blocked on a question nobody is
//! there to answer, prints nothing at all (measured: zero bytes across 80
//! seconds at the prompt). So "no [Watcher] *and* no output for the whole lease"
//! means there is no turn left to protect — and the conversation is on disk, so
//! stopping costs nothing a `claude --resume` will not bring back. Claude Code's
//! own background sessions draw the same line.
//!
//! This is the pure clock; the daemon feeds it and acts on [`lapsed`].
//!
//! [`lapsed`]: DetachedLease::lapsed

use std::time::{Duration, Instant};

/// Tracks how many [Watcher]s are attached to the daemon and when the lease
/// was last renewed. Pure: every method takes `now`.
///
/// A count, not a flag: any attached watcher means someone is looking, so one
/// leaving must not lapse the lease while another (a remote device, later)
/// still has the session open.
#[derive(Clone, Copy, Debug)]
pub struct DetachedLease {
    ttl: Duration,
    renewed_at: Instant,
    watchers: usize,
}

impl DetachedLease {
    /// A lease for a daemon that has just started: nobody attached yet, and the
    /// clock running from `now`. The app connects within moments of spawning a
    /// daemon, so the running clock only matters if it never does.
    #[must_use]
    pub const fn new(ttl: Duration, now: Instant) -> Self {
        Self {
            ttl,
            renewed_at: now,
            watchers: 0,
        }
    }

    /// The child printed something: it is alive and doing work.
    pub fn note_output(&mut self, now: Instant) {
        self.renewed_at = now;
    }

    /// A [Watcher] attached. While any is attached the lease cannot lapse —
    /// someone is looking, and the app governs the session itself (auto-sleep,
    /// close).
    pub fn note_attached(&mut self, now: Instant) {
        self.watchers = self.watchers.saturating_add(1);
        self.renewed_at = now;
    }

    /// A [Watcher] left. Once the last one is gone the lease runs from *this*
    /// moment, not from the last output: a session that sat quietly attached
    /// for hours must not lapse the instant the app goes away. A detach with
    /// no watcher attached is ignored rather than going negative.
    pub fn note_detached(&mut self, now: Instant) {
        self.watchers = self.watchers.saturating_sub(1);
        self.renewed_at = now;
    }

    /// Whether the daemon should [Tree stop] itself: no [Watcher] is attached
    /// and the terminal has been silent for the whole lease.
    #[must_use]
    pub fn lapsed(&self, now: Instant) -> bool {
        self.watchers == 0 && now.saturating_duration_since(self.renewed_at) >= self.ttl
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TTL: Duration = Duration::from_mins(30);

    /// One second short of [`TTL`].
    const ALMOST: Duration = Duration::from_secs(1799);

    fn after(start: Instant, secs: u64) -> Instant {
        start + Duration::from_secs(secs)
    }

    #[test]
    fn a_daemon_nobody_ever_attaches_to_lapses_after_the_lease() {
        let start = Instant::now();
        let lease = DetachedLease::new(TTL, start);
        assert!(!lease.lapsed(start + ALMOST));
        assert!(lease.lapsed(start + TTL));
    }

    #[test]
    fn an_attached_daemon_never_lapses_however_quiet() {
        // The app is alive and watching: an idle session is its business
        // (auto-sleep), not the lease's.
        let start = Instant::now();
        let mut lease = DetachedLease::new(TTL, start);
        lease.note_attached(after(start, 1));
        assert!(!lease.lapsed(after(start, 100_000)));
    }

    #[test]
    fn the_lease_runs_from_the_detach_not_from_the_last_output() {
        // Attached and silent for ten hours, then the app quits: the session
        // gets its full lease from that moment.
        let start = Instant::now();
        let mut lease = DetachedLease::new(TTL, start);
        lease.note_attached(start);
        let quit = start + Duration::from_hours(10);
        lease.note_detached(quit);
        assert!(!lease.lapsed(quit + ALMOST));
        assert!(lease.lapsed(quit + TTL));
    }

    #[test]
    fn output_while_detached_renews_the_lease() {
        // Left to finish its turn: every repaint of the spinner proves it is
        // still working, however long the turn takes.
        let start = Instant::now();
        let mut lease = DetachedLease::new(TTL, start);
        for minute in 1..=120 {
            let now = after(start, minute * 60);
            lease.note_output(now);
            assert!(!lease.lapsed(now));
        }
        // The turn ends; the terminal goes quiet; the lease runs out.
        let last = start + Duration::from_hours(2);
        assert!(!lease.lapsed(last + ALMOST));
        assert!(lease.lapsed(last + TTL));
    }

    #[test]
    fn a_reattach_cancels_a_lease_that_was_about_to_lapse() {
        let start = Instant::now();
        let mut lease = DetachedLease::new(TTL, start);
        lease.note_attached(start + ALMOST);
        assert!(!lease.lapsed(start + TTL + TTL));
    }

    #[test]
    fn the_lease_holds_while_any_watcher_is_still_attached() {
        // The desktop leaves while another watcher (a remote device, later)
        // still has the session open: nobody-is-looking has not happened yet.
        let start = Instant::now();
        let mut lease = DetachedLease::new(TTL, start);
        lease.note_attached(start);
        lease.note_attached(start);
        lease.note_detached(after(start, 60));
        assert!(!lease.lapsed(start + Duration::from_hours(10)));
        // The last one leaves: the lease runs from that moment.
        let last = start + Duration::from_hours(10);
        lease.note_detached(last);
        assert!(!lease.lapsed(last + ALMOST));
        assert!(lease.lapsed(last + TTL));
    }

    #[test]
    fn an_unmatched_detach_never_leaves_a_phantom_watcher() {
        let start = Instant::now();
        let mut lease = DetachedLease::new(TTL, start);
        lease.note_detached(start);
        lease.note_detached(start);
        lease.note_attached(start);
        lease.note_detached(start);
        assert!(lease.lapsed(start + TTL));
    }

    #[test]
    fn a_clock_that_reads_earlier_than_the_renewal_never_lapses() {
        let start = Instant::now();
        let mut lease = DetachedLease::new(TTL, start);
        lease.note_output(after(start, 50));
        assert!(!lease.lapsed(start));
    }
}
