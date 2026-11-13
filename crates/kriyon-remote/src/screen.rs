//! [Screen update] numbering on both ends (spec §6).
//!
//! `seq` counts a [Session run]'s output updates, the same numbers for every
//! device. A snapshot is "the screen as of update `seq`", so the next update
//! a device expects after it is `seq + 1`, and one device's resync never makes
//! a gap for another. A new run starts again from 0.
//!
//! The device never guesses: an update from another run, or one that skips a
//! number, means it asks for a fresh snapshot (`Resync`, at most once per
//! [`RESYNC_EVERY`]) and ignores updates until the snapshot comes.

use std::time::{Duration, Instant};

/// The least time between two `Resync`s from one device for one session.
pub const RESYNC_EVERY: Duration = Duration::from_secs(1);

/// The host's numbering for one session.
#[derive(Clone, Debug)]
pub struct ScreenSeq {
    run: u64,
    last_seq: u64,
    dialog_changed_at: Option<u64>,
}

impl ScreenSeq {
    /// A new [Session run], numbered from 0.
    #[must_use]
    pub fn new(run: u64) -> Self {
        Self {
            run,
            last_seq: 0,
            dialog_changed_at: None,
        }
    }

    #[must_use]
    pub fn run(&self) -> u64 {
        self.run
    }

    /// The `seq` for the next output update.
    pub fn next_update(&mut self) -> u64 {
        self.last_seq = self.last_seq.saturating_add(1);
        self.last_seq
    }

    /// The `seq` a snapshot taken now carries: the last update it includes.
    #[must_use]
    pub fn snapshot_seq(&self) -> u64 {
        self.last_seq
    }

    /// A CLI dialog appeared or changed in the output up to the last update.
    /// Input sent before a device saw that update is then stale.
    pub fn dialog_changed(&mut self) {
        self.dialog_changed_at = Some(self.last_seq);
    }

    /// The `seq` at which a dialog last appeared or changed this run.
    #[must_use]
    pub fn dialog_changed_at(&self) -> Option<u64> {
        self.dialog_changed_at
    }
}

/// What a device does with an update.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Follow {
    /// Draw it.
    Draw,
    /// Drop it: old, or waiting for a snapshot.
    Ignore,
    /// Drop it and send `Resync`.
    Resync,
}

/// A device's view of one session's numbering.
#[derive(Clone, Debug, Default)]
pub struct ScreenFollower {
    /// The run and last drawn `seq`, once a snapshot has come.
    at: Option<(u64, u64)>,
    /// Updates no longer follow on: waiting for a snapshot.
    lost: bool,
    last_resync: Option<Instant>,
}

impl ScreenFollower {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A snapshot came: draw it, and follow on from it.
    pub fn snapshot(&mut self, run: u64, seq: u64) {
        self.at = Some((run, seq));
        self.lost = false;
    }

    /// An update came.
    pub fn update(&mut self, run: u64, seq: u64, now: Instant) -> Follow {
        let Some((at_run, at_seq)) = self.at else {
            return Follow::Ignore;
        };
        if !self.lost && run == at_run {
            if seq <= at_seq {
                return Follow::Ignore;
            }
            if at_seq.checked_add(1) == Some(seq) {
                self.at = Some((run, seq));
                return Follow::Draw;
            }
        }
        self.lost = true;
        let asked_lately = self
            .last_resync
            .is_some_and(|asked| now.saturating_duration_since(asked) < RESYNC_EVERY);
        if asked_lately {
            return Follow::Ignore;
        }
        self.last_resync = Some(now);
        Follow::Resync
    }

    /// The last update drawn, for `seen_seq` on input. `None` before the
    /// first snapshot.
    #[must_use]
    pub fn seen_seq(&self) -> Option<u64> {
        self.at.map(|(_, seq)| seq)
    }

    /// The run being shown, for `run` on input.
    #[must_use]
    pub fn run(&self) -> Option<u64> {
        self.at.map(|(run, _)| run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_numbers_updates_from_one_each_run() {
        let mut s = ScreenSeq::new(9);
        assert_eq!(s.snapshot_seq(), 0);
        assert_eq!(s.next_update(), 1);
        assert_eq!(s.next_update(), 2);
        assert_eq!(s.snapshot_seq(), 2, "a snapshot includes update 2");
        let s = ScreenSeq::new(10);
        assert_eq!((s.run(), s.snapshot_seq()), (10, 0));
    }

    #[test]
    fn the_host_notes_the_update_a_dialog_changed_in() {
        let mut s = ScreenSeq::new(9);
        assert_eq!(s.dialog_changed_at(), None);
        s.next_update();
        s.next_update();
        s.dialog_changed();
        assert_eq!(s.dialog_changed_at(), Some(2));
    }

    #[test]
    fn a_device_draws_updates_that_follow_on() {
        let t = Instant::now();
        let mut f = ScreenFollower::new();
        assert_eq!(f.seen_seq(), None);
        f.snapshot(9, 4);
        assert_eq!(f.update(9, 5, t), Follow::Draw);
        assert_eq!(f.update(9, 6, t), Follow::Draw);
        assert_eq!((f.run(), f.seen_seq()), (Some(9), Some(6)));
    }

    #[test]
    fn an_update_before_the_first_snapshot_is_ignored() {
        let mut f = ScreenFollower::new();
        assert_eq!(f.update(9, 1, Instant::now()), Follow::Ignore);
    }

    #[test]
    fn an_old_update_is_ignored() {
        let t = Instant::now();
        let mut f = ScreenFollower::new();
        f.snapshot(9, 4);
        assert_eq!(f.update(9, 4, t), Follow::Ignore, "already in the snapshot");
        assert_eq!(f.update(9, 5, t), Follow::Draw);
    }

    #[test]
    fn a_gap_asks_for_a_snapshot_and_ignores_until_it_comes() {
        let t = Instant::now();
        let mut f = ScreenFollower::new();
        f.snapshot(9, 4);
        assert_eq!(f.update(9, 6, t), Follow::Resync);
        // Even the one that would have followed on: the screen is unknown now.
        assert_eq!(f.update(9, 7, t), Follow::Ignore);
        assert_eq!(f.seen_seq(), Some(4));
        f.snapshot(9, 7);
        assert_eq!(f.update(9, 8, t), Follow::Draw);
    }

    #[test]
    fn a_new_run_asks_for_a_snapshot() {
        let t = Instant::now();
        let mut f = ScreenFollower::new();
        f.snapshot(9, 4);
        assert_eq!(f.update(10, 1, t), Follow::Resync);
    }

    #[test]
    fn resync_is_asked_at_most_once_a_second() {
        let t = Instant::now();
        let mut f = ScreenFollower::new();
        f.snapshot(9, 4);
        assert_eq!(f.update(9, 6, t), Follow::Resync);
        // The snapshot was lost too: still waiting, asking again only later.
        assert_eq!(
            f.update(9, 9, t + Duration::from_millis(500)),
            Follow::Ignore
        );
        assert_eq!(f.update(9, 10, t + RESYNC_EVERY), Follow::Resync);
    }
}
