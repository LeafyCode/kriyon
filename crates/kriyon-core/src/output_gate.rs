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
//!   so a fast program is paced by a window that draws and nothing is lost;
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
    /// When the webview last showed it is draining: its last report, or the
    /// delivery that put bytes in flight after none were.
    progress_at: Instant,
    held: VecDeque<u8>,
    /// Output has been dropped since the webview last caught up.
    skipped: bool,
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
        }
    }

    /// A gate that delivers everything at once and never paces or holds: for
    /// a client with no webview to report drained bytes.
    #[must_use]
    pub fn unpaced(now: Instant) -> Self {
        Self::new(usize::MAX, usize::MAX, 0, now)
    }

    /// Until when the reader should wait before offering more output: `Some`
    /// while the webview is behind but still draining, `None` when output can
    /// be offered now (it is under the high mark, or the webview has stalled).
    #[must_use]
    pub fn pace_until(&self, now: Instant) -> Option<Instant> {
        if self.in_flight < self.high || self.skipped || !self.held.is_empty() {
            return None;
        }
        let deadline = self.progress_at + STALL_AFTER;
        (now < deadline).then_some(deadline)
    }

    /// The session wrote `bytes`. Returns what should go to the webview now —
    /// the bytes themselves, or [`CUT_SEAL`] at the moment output starts being
    /// dropped. Otherwise the gate has held or dropped them.
    pub fn offer(&mut self, bytes: Vec<u8>, now: Instant) -> Option<Vec<u8>> {
        if self.skipped {
            return None;
        }
        if self.held.is_empty() && self.in_flight < self.high {
            if self.in_flight == 0 {
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
    /// are in flight.
    pub fn drained(&mut self, n: usize, now: Instant) -> CatchUp {
        self.progress_at = now;
        self.in_flight = self.in_flight.saturating_sub(n);
        if self.in_flight > self.low {
            return CatchUp::Nothing;
        }
        if self.skipped {
            self.skipped = false;
            return CatchUp::Repaint;
        }
        if self.held.is_empty() {
            return CatchUp::Nothing;
        }
        let take = self.held.len().min(self.high);
        let slice: Vec<u8> = self.held.drain(..take).collect();
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
}
