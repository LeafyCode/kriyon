//! A client's bounded outgoing queue with [Skip ahead].
//!
//! Whoever produces a session's output pushes frames here and never waits.
//! Whoever writes to the client pops them, at the client's pace. When the
//! client falls so far behind that the queue would pass its limit, the queued
//! frames are dropped and the next pop says [`Next::SkipAhead`]: send a fresh
//! Screen snapshot instead. Frames pushed in between are dropped too, because
//! that snapshot, taken when it is sent, already shows what they drew.
//!
//! So a slow or stuck client costs about `limit` bytes of memory at most and
//! never slows the session or another client. Pure state: no threads, no IO.

use std::collections::VecDeque;

/// What holding one frame costs beyond its bytes: its own allocation and its
/// slot in the queue. Counted against the limit, so a stream of tiny frames
/// (a spinner, echoed keystrokes) can't hold many times the limit in memory.
const FRAME_UPKEEP: usize = 64;

/// What the writer should send the client next.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    /// Send this frame.
    Frame(Vec<u8>),
    /// Send a fresh Screen snapshot: what was queued is gone.
    SkipAhead,
    /// Nothing to send; wait for more.
    Empty,
}

/// Frames waiting for one client, capped at `limit` bytes.
#[derive(Debug)]
pub struct SkipAheadQueue {
    frames: VecDeque<Vec<u8>>,
    bytes: usize,
    limit: usize,
    skipped: bool,
}

impl SkipAheadQueue {
    /// An empty queue holding at most `limit` bytes of frames.
    #[must_use]
    pub fn new(limit: usize) -> Self {
        Self {
            frames: VecDeque::new(),
            bytes: 0,
            limit,
            skipped: false,
        }
    }

    /// A queue whose first pop is [`Next::SkipAhead`]: a client that has just
    /// arrived starts from the current screen.
    #[must_use]
    pub fn starting_with_screen(limit: usize) -> Self {
        let mut queue = Self::new(limit);
        queue.skipped = true;
        queue
    }

    /// Queue a frame. Never blocks. If the queue would pass its limit, it
    /// skips ahead instead; while a skip is pending, the frame is dropped.
    pub fn push(&mut self, frame: Vec<u8>) {
        if self.skipped {
            return;
        }
        let cost = frame.len().saturating_add(FRAME_UPKEEP);
        if self.bytes.saturating_add(cost) > self.limit {
            self.skip_ahead();
            return;
        }
        self.bytes += cost;
        self.frames.push_back(frame);
    }

    /// Drop everything queued; the next pop is [`Next::SkipAhead`].
    pub fn skip_ahead(&mut self) {
        self.frames.clear();
        self.bytes = 0;
        self.skipped = true;
    }

    /// Whether there is nothing left to send: no frame and no fresh screen.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty() && !self.skipped
    }

    /// Take what the client should get next.
    pub fn pop(&mut self) -> Next {
        if let Some(frame) = self.frames.pop_front() {
            self.bytes -= frame.len() + FRAME_UPKEEP;
            return Next::Frame(frame);
        }
        if std::mem::take(&mut self.skipped) {
            return Next::SkipAhead;
        }
        Next::Empty
    }
}

#[cfg(test)]
mod tests {
    use super::{Next, SkipAheadQueue};

    fn frame(len: usize) -> Vec<u8> {
        vec![b'x'; len]
    }

    #[test]
    fn frames_come_out_in_the_order_they_went_in() {
        let mut q = SkipAheadQueue::new(1000);
        q.push(b"one".to_vec());
        q.push(b"two".to_vec());
        assert_eq!(q.pop(), Next::Frame(b"one".to_vec()));
        assert_eq!(q.pop(), Next::Frame(b"two".to_vec()));
        assert_eq!(q.pop(), Next::Empty);
    }

    #[test]
    fn a_queue_that_would_pass_its_limit_skips_ahead() {
        let mut q = SkipAheadQueue::new(1000);
        q.push(frame(600));
        q.push(frame(600));
        assert_eq!(
            q.pop(),
            Next::SkipAhead,
            "the queued frames are dropped; the client gets a fresh screen instead"
        );
        assert_eq!(q.pop(), Next::Empty);
    }

    #[test]
    fn frames_after_the_overflow_are_dropped_until_the_screen_is_sent() {
        let mut q = SkipAheadQueue::new(1000);
        q.push(frame(600));
        q.push(frame(600));
        q.push(b"covered by the snapshot".to_vec());
        assert_eq!(q.pop(), Next::SkipAhead);
        q.push(b"after".to_vec());
        assert_eq!(q.pop(), Next::Frame(b"after".to_vec()));
    }

    #[test]
    fn the_limit_frees_up_as_frames_go_out() {
        let mut q = SkipAheadQueue::new(1000);
        q.push(frame(600));
        assert_eq!(q.pop(), Next::Frame(frame(600)));
        q.push(frame(600));
        assert_eq!(
            q.pop(),
            Next::Frame(frame(600)),
            "no skip: the first frame left"
        );
    }

    #[test]
    fn asking_to_skip_ahead_drops_the_queue() {
        let mut q = SkipAheadQueue::new(1000);
        q.push(b"stale".to_vec());
        q.skip_ahead();
        assert_eq!(q.pop(), Next::SkipAhead);
        assert_eq!(q.pop(), Next::Empty);
    }

    #[test]
    fn many_tiny_frames_count_their_upkeep_too() {
        let mut q = SkipAheadQueue::new(1000);
        for _ in 0..1000 {
            q.push(b"x".to_vec());
        }
        assert_eq!(
            q.pop(),
            Next::SkipAhead,
            "a thousand 1-byte frames cost far more than 1000 bytes to hold"
        );
    }

    #[test]
    fn a_queue_is_empty_only_with_nothing_left_to_send() {
        let mut q = SkipAheadQueue::new(1000);
        assert!(q.is_empty());
        q.push(b"x".to_vec());
        assert!(!q.is_empty());
        let _ = q.pop();
        assert!(q.is_empty());
        q.skip_ahead();
        assert!(
            !q.is_empty(),
            "a pending fresh screen is still something to send"
        );
    }

    #[test]
    fn a_new_queue_starts_with_a_fresh_screen() {
        let mut q = SkipAheadQueue::starting_with_screen(100);
        assert_eq!(q.pop(), Next::SkipAhead);
    }
}
