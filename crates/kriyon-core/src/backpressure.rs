//! Reader-side backpressure: pause a PTY reader when the frontend's output sink
//! falls behind, resume it once the sink has drained.
//!
//! The reader tracks `pending = sent − drained`. [`Backpressure::after_send`] is
//! called by the reader right after handing `n` bytes to the sink; if `pending`
//! climbs above `high`, the reader parks on a condvar until the frontend reports
//! enough bytes drained (via [`Backpressure::report_drained`]) that `pending`
//! falls to/below `low`, or until the engine is [`Backpressure::close`]d. This is
//! pure synchronisation logic with no PTY or Tauri coupling.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};

/// Tracks in-flight (sent-but-not-drained) output bytes and parks the reader
/// when the consumer falls too far behind.
pub struct Backpressure {
    /// Bytes sent to the sink but not yet acknowledged as drained.
    pending: Mutex<usize>,
    /// Signalled when `pending` drops to/below `low` or the engine is closed.
    cvar: Condvar,
    /// Park threshold: once `pending` exceeds this, the reader blocks.
    high: usize,
    /// Resume threshold: a parked reader unparks once `pending` is at/below this.
    low: usize,
    /// Set on teardown so a parked reader always wakes and never deadlocks.
    closed: AtomicBool,
}

impl Backpressure {
    /// Create a backpressure gate with the given `high`/`low` watermarks.
    #[must_use]
    pub fn new(high: usize, low: usize) -> Self {
        Self {
            pending: Mutex::new(0),
            cvar: Condvar::new(),
            high,
            low,
            closed: AtomicBool::new(false),
        }
    }

    /// Reader calls this right after handing `n` bytes to the output sink.
    ///
    /// Adds `n` to `pending`; if `pending` now exceeds `high`, BLOCKS until
    /// `pending` falls to/below `low` (drained) or the engine is closed.
    pub fn after_send(&self, n: usize) {
        let Ok(mut pending) = self.pending.lock() else {
            // A poisoned lock means a panicked holder; never park forever.
            return;
        };
        *pending = pending.saturating_add(n);
        if *pending > self.high {
            while *pending > self.low && !self.closed.load(Ordering::Relaxed) {
                let Ok(guard) = self.cvar.wait(pending) else {
                    return;
                };
                pending = guard;
            }
        }
    }

    /// Frontend-driven (via the `report_drained` command). Subtracts `n` from
    /// `pending` (saturating), and if `pending` is at/below `low`, wakes any
    /// parked reader. Safe to call with more bytes than are pending.
    pub fn report_drained(&self, n: usize) {
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        *pending = pending.saturating_sub(n);
        if *pending <= self.low {
            self.cvar.notify_all();
        }
    }

    /// Wake any parked reader so teardown never hangs. Idempotent.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.cvar.notify_all();
    }

    /// Current pending (sent − drained) byte count. For tests.
    #[must_use]
    pub fn pending(&self) -> usize {
        self.pending.lock().map_or(0, |p| *p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn after_send_under_high_returns_immediately() {
        let bp = Backpressure::new(100, 10);
        bp.after_send(50);
        assert_eq!(bp.pending(), 50);
        // A second send still under high also returns without blocking.
        bp.after_send(40);
        assert_eq!(bp.pending(), 90);
    }

    #[test]
    fn slow_consumer_parks_then_resumes_with_no_byte_loss() {
        let bp = Arc::new(Backpressure::new(100, 10));
        let reader = Arc::clone(&bp);

        // Reader sends well above HIGH and then parks waiting for drain.
        let handle = thread::spawn(move || {
            reader.after_send(250);
        });

        // It must stay parked: pending stays at 250 while above LOW.
        let mut parked = false;
        for _ in 0..20 {
            thread::sleep(Duration::from_millis(50));
            if bp.pending() == 250 {
                parked = true;
                break;
            }
        }
        assert!(parked, "reader should have parked with pending == 250");

        // Still parked a moment later (no spurious unpark before drain).
        thread::sleep(Duration::from_millis(50));
        assert!(
            !handle.is_finished(),
            "reader must remain parked while pending is above LOW"
        );

        // Drain down to/below LOW: 250 - 240 = 10 <= low(10) -> unpark.
        bp.report_drained(240);
        handle.join().expect("reader thread should join");

        // Exact accounting: sent 250, drained 240 -> pending 10.
        assert_eq!(bp.pending(), 10);
    }

    #[test]
    fn close_unparks_a_parked_reader() {
        let bp = Arc::new(Backpressure::new(100, 10));
        let reader = Arc::clone(&bp);

        let handle = thread::spawn(move || {
            reader.after_send(500);
        });

        // Wait until it has parked.
        for _ in 0..20 {
            thread::sleep(Duration::from_millis(50));
            if bp.pending() == 500 {
                break;
            }
        }

        // No report_drained at all; close must wake the parked reader.
        bp.close();
        handle
            .join()
            .expect("reader thread should join after close");
        assert_eq!(bp.pending(), 500);
    }

    #[test]
    fn report_drained_over_subtracts_saturating() {
        let bp = Backpressure::new(100, 10);
        bp.after_send(20);
        // Drain more than was ever sent: saturates to 0, no panic.
        bp.report_drained(1000);
        assert_eq!(bp.pending(), 0);
        // And the condvar was signalled (a fresh parked reader can still unpark).
        let shared = Arc::new(bp);
        let reader = Arc::clone(&shared);
        let handle = thread::spawn(move || reader.after_send(200));
        for _ in 0..20 {
            thread::sleep(Duration::from_millis(50));
            if shared.pending() == 200 {
                break;
            }
        }
        shared.report_drained(200);
        handle.join().expect("reader thread should join");
        assert_eq!(shared.pending(), 0);
    }
}
