//! The [Output gate]: decides what a session's output does on its way to the
//! webview, so the reader never waits on a webview that has stopped painting.
//!
//! The webview paints on animation frames and reports each painted batch back
//! as bytes drained. A hidden window gets no frames, so it stops reporting —
//! and a reader that waited for it would stop reading the session's pty, which
//! pauses the program inside it (the 12 Nov hidden-window freeze). The gate
//! tracks `in_flight = delivered − drained`:
//!
//! - below the high-water mark, output is delivered straight through;
//! - above it, while the webview is still draining, the reader briefly waits,
//!   so a window that draws paces the reader and nothing is dropped here;
//! - once the webview has drained nothing for [`STALL_AFTER`], it counts as
//!   stalled: the reader stops waiting, and output is held, up to a byte cap,
//!   then released in order, a slice at a time, as the webview drains again;
//! - past the cap, the held bytes are dropped, and so is everything after them
//!   until the webview catches up. It is then told to ask the daemon for a
//!   screen repaint, which rebuilds the current screen from the daemon's own
//!   emulator — that emulator sees every byte, so nothing on screen is lost.
//!
//! Pure state: no IO, no threads, time passed in. The caller holds it under one
//! lock and delivers whatever it returns while still holding that lock, so
//! bytes reach the webview in the order the session wrote them.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// How long the webview may drain nothing, with output in flight, before it
/// counts as stalled. A drawing window drains every frame (about 16 ms); a
/// hidden one never does. The longest a session is paused by a hidden window.
pub const STALL_AFTER: Duration = Duration::from_millis(500);

/// How long, after asking for a repaint, output is dropped while the screen
/// that answers it is awaited. Past it, output flows again.
pub const SCREEN_WAIT: Duration = Duration::from_secs(2);

/// A webview's gate paces, then holds, output once this many bytes are
/// delivered but not drained.
pub const WEBVIEW_HIGH_WATER: usize = 128 * 1024;
/// A webview's gate releases held output once in-flight bytes drain to this.
pub const WEBVIEW_LOW_WATER: usize = 16 * 1024;
/// The most output a webview's gate holds while it has stopped painting (a
/// hidden window gets no animation frames). Past it the held bytes are dropped
/// and the webview repaints from the daemon's screen when it is back: the
/// app's memory per session, however long the window stays hidden.
pub const WEBVIEW_HOLD_CAP: usize = 1024 * 1024;
/// A webview's hold while a remote device is an onlooker of its session: the
/// reader then never waits for the window, so it holds as much as the
/// daemon's Output history keeps, from which "Show earlier output" can
/// back-fill a cut.
pub const WEBVIEW_ONLOOKED_HOLD_CAP: usize = 4 * 1024 * 1024;

/// Delivered where output is cut, so the dropped bytes cannot leave the
/// terminal's parser mid-sequence: string terminator (ends an OSC or DCS that
/// lost its end), then end of synchronized output (DEC 2026). Both do nothing
/// in a terminal that was not in the middle of either.
pub const CUT_SEAL: &[u8] = b"\x1b\\\x1b[?2026l";

/// What the webview should get after it reports bytes drained.
#[derive(Debug, PartialEq, Eq)]
pub enum CatchUp {
    /// Nothing to send.
    Nothing,
    /// Held output, in order, to deliver now.
    Deliver(Vec<u8>),
    /// Output was dropped while the webview was away: ask the daemon to resend
    /// its screen snapshot.
    Repaint,
}

/// Flow state for one session's output to the webview. See the module docs.
#[derive(Debug)]
pub struct OutputGate {
    /// Pace, then hold, output once this many bytes are in flight. Also the
    /// largest slice of held output released at once.
    high: usize,
    /// Release held output once in-flight bytes drain to this or below.
    low: usize,
    /// The most output the gate holds before it drops it and repaints instead.
    cap: usize,
    /// Bytes delivered to the webview but not yet reported drained.
    in_flight: usize,
    /// When the webview last showed it is keeping up: its last report of
    /// bytes drained, or a delivery made while next to nothing was in flight.
    progress_at: Instant,
    held: VecDeque<u8>,
    /// Output has been dropped since the webview last caught up.
    skipped: bool,
    /// The daemon sends its screen apart from output (see `expect_screens`).
    screens: bool,
    /// When a repaint was asked for whose screen has not come yet: output
    /// until then would be drawn on the old screen, so it is dropped, for at
    /// most [`SCREEN_WAIT`].
    awaiting_screen: Option<Instant>,
    /// The hold cap to come back down to (see `set_remote_onlooker`): the
    /// cap in force stays above what is already held until that drains.
    cap_target: usize,
}

impl OutputGate {
    /// A gate with the given watermarks and hold cap, in bytes.
    #[must_use]
    pub fn new(high: usize, low: usize, cap: usize, now: Instant) -> Self {
        Self {
            high,
            low,
            cap,
            in_flight: 0,
            progress_at: now,
            held: VecDeque::new(),
            skipped: false,
            screens: false,
            awaiting_screen: None,
            cap_target: cap,
        }
    }

    /// The daemon sends its screen apart from output (`Frame::Screen`), so
    /// after a repaint is asked for, output is dropped until the screen comes.
    pub fn expect_screens(&mut self) {
        self.screens = true;
    }

    /// The daemon's screen for the webview: always delivered, and the end of
    /// any wait for one. It supersedes held output and ends a cut.
    pub fn offer_screen(&mut self, bytes: Vec<u8>, now: Instant) -> Vec<u8> {
        // It shows everything read before it: what is held is already on it,
        // and drawn after it would land on the new screen. Any cut is over.
        self.awaiting_screen = None;
        self.held = VecDeque::new();
        self.skipped = false;
        if self.in_flight <= self.low {
            self.progress_at = now;
        }
        self.in_flight = self.in_flight.saturating_add(bytes.len());
        bytes
    }

    /// Whether a remote device is an onlooker of this session: the hold cap
    /// is then [`WEBVIEW_ONLOOKED_HOLD_CAP`], else [`WEBVIEW_HOLD_CAP`].
    pub fn set_remote_onlooker(&mut self, onlooked: bool) {
        self.cap_target = if onlooked {
            WEBVIEW_ONLOOKED_HOLD_CAP
        } else {
            WEBVIEW_HOLD_CAP
        };
        // Raised at once; lowered only once what is held fits under it, so
        // the change itself never cuts.
        if self.held.len() <= self.cap_target || self.cap_target > self.cap {
            self.cap = self.cap_target;
        }
    }

    /// The most output this gate holds before it cuts.
    #[must_use]
    pub fn hold_cap(&self) -> usize {
        self.cap
    }

    /// The gate for a webview that draws a session's terminal (ADR-0059).
    #[must_use]
    pub fn for_webview(now: Instant) -> Self {
        Self::new(WEBVIEW_HIGH_WATER, WEBVIEW_LOW_WATER, WEBVIEW_HOLD_CAP, now)
    }

    /// A gate that delivers everything at once and never paces or holds: for
    /// a client with no webview to report drained bytes.
    #[must_use]
    pub fn unpaced(now: Instant) -> Self {
        Self::new(usize::MAX, usize::MAX, 0, now)
    }

    /// Until when the reader should wait before offering more output: `Some`
    /// while the webview is behind — past the high mark, or with output still
    /// held — but still draining. `None` when output can be offered now: the
    /// webview is keeping up, or it has stalled, or output is being dropped.
    #[must_use]
    pub fn pace_until(&self, now: Instant) -> Option<Instant> {
        let behind = self.in_flight >= self.high || !self.held.is_empty();
        if !behind || self.skipped {
            return None;
        }
        let deadline = self.progress_at + STALL_AFTER;
        (now < deadline).then_some(deadline)
    }

    /// The session wrote `bytes`. Returns what should go to the webview now —
    /// the bytes themselves, or [`CUT_SEAL`] at the moment output starts being
    /// dropped. Otherwise the gate has held or dropped them.
    pub fn offer(&mut self, bytes: Vec<u8>, now: Instant) -> Option<Vec<u8>> {
        if self
            .awaiting_screen
            .is_some_and(|since| now.saturating_duration_since(since) >= SCREEN_WAIT)
        {
            self.awaiting_screen = None;
        }
        if self.skipped || self.awaiting_screen.is_some() {
            return None;
        }
        if self.held.is_empty() && self.in_flight < self.high {
            // A few bytes left in flight from earlier say nothing about now.
            if self.in_flight <= self.low {
                self.progress_at = now;
            }
            self.in_flight = self.in_flight.saturating_add(bytes.len());
            return Some(bytes);
        }
        if self.held.len().saturating_add(bytes.len()) <= self.cap {
            self.held.extend(bytes);
            return None;
        }
        self.held = VecDeque::new();
        self.skipped = true;
        self.in_flight = self.in_flight.saturating_add(CUT_SEAL.len());
        Some(CUT_SEAL.to_vec())
    }

    /// The webview reported `n` bytes drained. Safe to call with more than
    /// are in flight. A report of nothing is not progress.
    pub fn drained(&mut self, n: usize, now: Instant) -> CatchUp {
        if n > 0 {
            self.progress_at = now;
        }
        self.in_flight = self.in_flight.saturating_sub(n);
        if self.in_flight > self.low {
            return CatchUp::Nothing;
        }
        if self.skipped {
            self.skipped = false;
            self.awaiting_screen = self.screens.then_some(now);
            return CatchUp::Repaint;
        }
        if self.held.is_empty() {
            return CatchUp::Nothing;
        }
        let take = self.held.len().min(self.high);
        let (front, back) = self.held.as_slices();
        let from_front = take.min(front.len());
        let mut slice = Vec::with_capacity(take);
        slice.extend_from_slice(&front[..from_front]);
        slice.extend_from_slice(&back[..take - from_front]);
        self.held.drain(..take);
        if self.held.len() <= self.cap_target {
            self.cap = self.cap_target;
        }
        self.in_flight = self.in_flight.saturating_add(slice.len());
        CatchUp::Deliver(slice)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(now: Instant) -> OutputGate {
        // high 100, low 10, hold up to 150.
        OutputGate::new(100, 10, 150, now)
    }

    /// Fill the webview to the high mark, then let it stall.
    fn stalled(t0: Instant) -> (OutputGate, Instant) {
        let mut g = gate(t0);
        assert!(g.offer(vec![0; 100], t0).is_some());
        (g, t0 + STALL_AFTER)
    }

    #[test]
    fn output_goes_straight_through_while_the_webview_keeps_up() {
        let t0 = Instant::now();
        let mut g = gate(t0);
        assert_eq!(g.pace_until(t0), None);
        assert_eq!(g.offer(b"abc".to_vec(), t0), Some(b"abc".to_vec()));
        assert_eq!(g.drained(3, t0), CatchUp::Nothing);
        assert_eq!(g.offer(b"def".to_vec(), t0), Some(b"def".to_vec()));
    }

    #[test]
    fn a_webview_that_is_still_draining_paces_the_reader() {
        let t0 = Instant::now();
        let mut g = gate(t0);
        assert!(g.offer(vec![0; 120], t0).is_some());
        let soon = t0 + Duration::from_millis(100);
        assert_eq!(g.pace_until(soon), Some(t0 + STALL_AFTER));

        // A drain is progress: the next wait runs from it.
        let later = t0 + Duration::from_millis(400);
        assert_eq!(g.drained(5, later), CatchUp::Nothing);
        assert_eq!(g.pace_until(later), Some(later + STALL_AFTER));
        // Back under the high mark: no wait at all.
        assert_eq!(g.drained(20, later), CatchUp::Nothing);
        assert_eq!(g.pace_until(later), None);
    }

    #[test]
    fn a_webview_that_drains_nothing_stops_pacing_the_reader() {
        let t0 = Instant::now();
        let (mut g, t1) = stalled(t0);
        assert_eq!(g.pace_until(t1), None);
        // Holding: still no wait, however long it lasts.
        assert_eq!(g.offer(b"one".to_vec(), t1), None);
        assert_eq!(g.pace_until(t1 + Duration::from_secs(3600)), None);
    }

    #[test]
    fn a_webview_that_drains_again_after_a_stall_paces_the_reader_again() {
        let t0 = Instant::now();
        let (mut g, t1) = stalled(t0);
        assert_eq!(g.offer(vec![1; 140], t1), None);
        // The window is back: a slice goes out, the rest is still held.
        let t2 = t1 + Duration::from_millis(50);
        assert_eq!(g.drained(95, t2), CatchUp::Deliver(vec![1; 100]));
        // Pace again, or a fast program fills the cap and is cut while the
        // window draws.
        assert_eq!(g.pace_until(t2), Some(t2 + STALL_AFTER));
    }

    #[test]
    fn a_burst_after_a_quiet_spell_is_paced_not_taken_for_a_stall() {
        let t0 = Instant::now();
        let mut g = gate(t0);
        assert!(g.offer(vec![0; 20], t0).is_some());
        // A few bytes are still in flight when the session goes quiet.
        assert_eq!(g.drained(15, t0), CatchUp::Nothing);

        let later = t0 + Duration::from_secs(10);
        assert!(g.offer(vec![0; 100], later).is_some());
        assert_eq!(g.pace_until(later), Some(later + STALL_AFTER));
    }

    #[test]
    fn a_report_of_nothing_drained_is_not_progress() {
        let t0 = Instant::now();
        let mut g = gate(t0);
        assert!(g.offer(vec![0; 120], t0).is_some());
        assert_eq!(
            g.drained(0, t0 + Duration::from_millis(400)),
            CatchUp::Nothing
        );
        assert_eq!(g.pace_until(t0 + STALL_AFTER), None);
    }

    #[test]
    fn held_output_is_released_in_order_once_drained() {
        let t0 = Instant::now();
        let (mut g, t1) = stalled(t0);
        assert_eq!(g.offer(b"one".to_vec(), t1), None);
        assert_eq!(g.offer(b"two".to_vec(), t1), None);

        // Not yet down to the low mark: keep holding.
        assert_eq!(g.drained(50, t1), CatchUp::Nothing);
        assert_eq!(g.drained(45, t1), CatchUp::Deliver(b"onetwo".to_vec()));
    }

    #[test]
    fn held_output_is_released_a_high_mark_at_a_time() {
        let t0 = Instant::now();
        let (mut g, t1) = stalled(t0);
        assert_eq!(g.offer(vec![1; 70], t1), None);
        assert_eq!(g.offer(vec![2; 70], t1), None);

        let first = g.drained(100, t1);
        assert_eq!(first, CatchUp::Deliver([vec![1; 70], vec![2; 30]].concat()));
        assert_eq!(g.drained(100, t1), CatchUp::Deliver(vec![2; 40]));
    }

    /// Numbered bytes, so any reordering or loss shows.
    fn numbered(from: &mut u8, len: usize) -> Vec<u8> {
        (0..len)
            .map(|_| {
                *from = from.wrapping_add(1);
                *from
            })
            .collect()
    }

    #[test]
    fn held_output_keeps_its_order_across_many_holds_and_releases() {
        let t0 = Instant::now();
        let (mut g, t) = stalled(t0);
        let (mut n, mut sent, mut got) = (0u8, Vec::new(), Vec::new());
        for _ in 0..20 {
            // 70 + 70 held; a slice of 100 out; 70 more held while 40 still
            // are, so the held bytes wrap around inside the gate.
            for step in ["hold", "hold", "release", "hold", "release", "release"] {
                if step == "hold" {
                    let c = numbered(&mut n, 70);
                    sent.extend_from_slice(&c);
                    assert_eq!(g.offer(c, t), None, "behind, so held");
                } else {
                    let CatchUp::Deliver(out) = g.drained(usize::MAX, t) else {
                        panic!("expected held output");
                    };
                    got.extend_from_slice(&out);
                }
            }
            assert_eq!(g.drained(usize::MAX, t), CatchUp::Nothing);
            // Put the webview behind again for the next round.
            let c = numbered(&mut n, 100);
            sent.extend_from_slice(&c);
            got.extend_from_slice(&g.offer(c, t).expect("not behind"));
        }
        assert_eq!(got, sent);
    }

    #[test]
    fn new_output_waits_behind_held_output_so_order_is_kept() {
        let t0 = Instant::now();
        let (mut g, t1) = stalled(t0);
        assert_eq!(g.offer(b"one".to_vec(), t1), None);
        assert_eq!(g.drained(100, t1), CatchUp::Deliver(b"one".to_vec()));
        // Nothing held now, and in flight is under the high mark again.
        assert_eq!(g.offer(b"two".to_vec(), t1), Some(b"two".to_vec()));
    }

    #[test]
    fn past_the_cap_output_is_cut_sealed_and_repainted_when_the_webview_is_back() {
        let t0 = Instant::now();
        let (mut g, t1) = stalled(t0);
        assert_eq!(g.offer(vec![1; 140], t1), None);
        // 140 + 20 is over the cap of 150: everything held goes, and the cut
        // is sealed right after the last byte the webview got.
        assert_eq!(g.offer(vec![2; 20], t1), Some(CUT_SEAL.to_vec()));
        // Whatever comes after is dropped, however long the webview is away.
        for _ in 0..1000 {
            assert_eq!(g.offer(vec![3; 30], t1), None);
        }

        assert_eq!(g.drained(100 + CUT_SEAL.len(), t1), CatchUp::Repaint);
        // The repaint, and everything after it, flows again.
        assert_eq!(g.offer(b"screen".to_vec(), t1), Some(b"screen".to_vec()));
        assert_eq!(g.drained(6, t1), CatchUp::Nothing);
    }

    #[test]
    fn an_over_report_saturates_instead_of_wrapping() {
        let t0 = Instant::now();
        let mut g = gate(t0);
        assert!(g.offer(vec![0; 20], t0).is_some());
        assert_eq!(g.drained(1000, t0), CatchUp::Nothing);
        assert_eq!(g.offer(vec![0; 99], t0).map(|b| b.len()), Some(99));
    }

    #[test]
    fn an_unpaced_gate_delivers_everything_without_waiting() {
        let t0 = Instant::now();
        let mut g = OutputGate::unpaced(t0);
        for _ in 0..1000 {
            assert_eq!(g.pace_until(t0), None);
            assert!(g.offer(vec![0; 64 * 1024], t0).is_some());
        }
    }

    #[test]
    fn a_webview_gate_paces_at_its_high_mark_and_holds_up_to_its_cap() {
        let t0 = Instant::now();
        let mut g = OutputGate::for_webview(t0);
        assert!(g.offer(vec![0; WEBVIEW_HIGH_WATER - 1], t0).is_some());
        assert_eq!(g.pace_until(t0), None, "under the high mark");
        assert!(g.offer(vec![0; 1], t0).is_some());
        assert_eq!(g.pace_until(t0), Some(t0 + STALL_AFTER));
        let stalled = t0 + STALL_AFTER;
        assert_eq!(
            g.offer(vec![0; WEBVIEW_HOLD_CAP], stalled),
            None,
            "held, up to the cap"
        );
        assert_eq!(
            g.offer(vec![0; 1], stalled),
            Some(CUT_SEAL.to_vec()),
            "then cut"
        );
    }

    #[test]
    fn once_screens_come_apart_output_after_a_cut_waits_for_the_screen() {
        // Output read between the cut and the repaint would be drawn on the
        // old screen; with the daemon's screen in frames of its own, the gate
        // can drop it and let the screen through first.
        let t0 = Instant::now();
        let (mut g, t1) = stalled(t0);
        g.expect_screens();
        assert_eq!(g.offer(vec![1; 140], t1), None);
        assert_eq!(g.offer(vec![2; 20], t1), Some(CUT_SEAL.to_vec()));
        assert_eq!(g.drained(100 + CUT_SEAL.len(), t1), CatchUp::Repaint);
        assert_eq!(
            g.offer(b"stale".to_vec(), t1),
            None,
            "dropped until the screen"
        );
        assert_eq!(g.offer_screen(b"screen".to_vec(), t1), b"screen".to_vec());
        assert_eq!(g.offer(b"new".to_vec(), t1), Some(b"new".to_vec()));
    }

    #[test]
    fn a_screen_always_goes_through() {
        let t0 = Instant::now();
        let mut g = gate(t0);
        assert_eq!(g.offer_screen(b"screen".to_vec(), t0), b"screen".to_vec());
    }

    #[test]
    fn while_a_remote_device_looks_on_a_webview_holds_up_to_its_bigger_cap() {
        // The reader no longer waits for the window then, so the gate holds as
        // much as the daemon's Output history keeps, to back-fill a cut.
        let t0 = Instant::now();
        let mut g = OutputGate::for_webview(t0);
        g.set_remote_onlooker(true);
        assert!(g.offer(vec![0; WEBVIEW_HIGH_WATER], t0).is_some());
        let stalled = t0 + STALL_AFTER;
        assert_eq!(g.offer(vec![0; WEBVIEW_ONLOOKED_HOLD_CAP], stalled), None);
        assert_eq!(g.offer(vec![0; 1], stalled), Some(CUT_SEAL.to_vec()));
        g.set_remote_onlooker(false);
        assert_eq!(g.hold_cap(), WEBVIEW_HOLD_CAP);
    }

    #[test]
    fn a_screen_supersedes_held_output_and_ends_a_cut() {
        // Held bytes were read before the screen, so it already shows them;
        // drawn after it, they would land on the new screen.
        let t0 = Instant::now();
        let (mut g, t1) = stalled(t0);
        assert_eq!(g.offer(vec![1; 140], t1), None, "held");
        g.offer_screen(b"screen".to_vec(), t1);
        assert_eq!(
            g.drained(1000, t1),
            CatchUp::Nothing,
            "nothing older to release"
        );
        let (mut cut, t2) = stalled(t0);
        assert_eq!(cut.offer(vec![1; 140], t2), None);
        assert_eq!(cut.offer(vec![2; 20], t2), Some(CUT_SEAL.to_vec()));
        cut.offer_screen(b"screen".to_vec(), t2);
        assert_eq!(
            cut.offer(b"new".to_vec(), t2),
            None,
            "held, not dropped: the cut is over"
        );
        assert_eq!(cut.drained(1000, t2), CatchUp::Deliver(b"new".to_vec()));
    }

    #[test]
    fn a_screen_that_never_comes_is_not_waited_for_long() {
        let t0 = Instant::now();
        let (mut g, t1) = stalled(t0);
        g.expect_screens();
        assert_eq!(g.offer(vec![1; 140], t1), None);
        assert_eq!(g.offer(vec![2; 20], t1), Some(CUT_SEAL.to_vec()));
        assert_eq!(g.drained(100 + CUT_SEAL.len(), t1), CatchUp::Repaint);
        assert_eq!(g.offer(b"stale".to_vec(), t1), None);
        let later = t1 + SCREEN_WAIT;
        assert_eq!(g.offer(b"on".to_vec(), later), Some(b"on".to_vec()));
    }

    #[test]
    fn when_the_onlooker_leaves_what_is_held_is_kept_not_cut() {
        let t0 = Instant::now();
        let mut g = OutputGate::for_webview(t0);
        g.set_remote_onlooker(true);
        assert!(g.offer(vec![0; WEBVIEW_HIGH_WATER], t0).is_some());
        let stalled = t0 + STALL_AFTER;
        assert_eq!(g.offer(vec![0; 3 * WEBVIEW_HOLD_CAP], stalled), None);
        g.set_remote_onlooker(false);
        assert_eq!(g.offer(vec![0; 1], stalled), None, "held, not cut");
        assert_eq!(g.hold_cap(), WEBVIEW_ONLOOKED_HOLD_CAP, "until it drains");
        // Once what is held fits the window's own cap, that cap is back.
        let mut t = stalled;
        while g.hold_cap() != WEBVIEW_HOLD_CAP {
            t += Duration::from_millis(1);
            let _ = g.drained(usize::MAX, t);
        }
    }
}
