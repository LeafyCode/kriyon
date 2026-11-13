//! Per-device outgoing queues (spec §5, back-pressure). The host's main loop
//! only pushes and never waits on a network write.
//!
//! - **Session queue**: one per open session, [`SessionQueue`] — the same
//!   [Skip ahead] queue the PTY daemon keeps for its client. Full means drop
//!   what is queued and send a fresh snapshot (`skipped: true`). A new one
//!   starts with the screen: [`SessionQueue::starting_with_screen`].
//! - **Control queue**: one per connection, [`ControlQueue`]. Its messages
//!   (control changes, refusals, statuses) can't be skipped, so full means
//!   the device has stopped reading: close the connection.

use std::collections::VecDeque;

use kriyon_core::skip_ahead::FRAME_UPKEEP;
pub use kriyon_core::skip_ahead::{Next, SkipAheadQueue as SessionQueue};

/// The most a device's session queue holds: room for two of the largest
/// messages (1 MiB).
pub const SESSION_QUEUE_LIMIT: usize = 2 * 1024 * 1024;

/// The most a device's control queue holds before the connection is closed.
pub const CONTROL_QUEUE_LIMIT: usize = 256 * 1024;

/// The control queue is full: the device stopped reading. Close the
/// connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlQueueFull;

/// Encoded control-stream messages waiting for one device.
#[derive(Debug)]
pub struct ControlQueue {
    messages: VecDeque<Vec<u8>>,
    bytes: usize,
    limit: usize,
}

impl ControlQueue {
    #[must_use]
    pub fn new(limit: usize) -> Self {
        Self {
            messages: VecDeque::new(),
            bytes: 0,
            limit,
        }
    }

    /// Queue an encoded message. Never blocks.
    ///
    /// # Errors
    /// [`ControlQueueFull`] when it would pass the limit; nothing is queued.
    pub fn push(&mut self, message: Vec<u8>) -> Result<(), ControlQueueFull> {
        let cost = message.len().saturating_add(FRAME_UPKEEP);
        if self.bytes.saturating_add(cost) > self.limit {
            return Err(ControlQueueFull);
        }
        self.bytes += cost;
        self.messages.push_back(message);
        Ok(())
    }

    /// The next message to send, oldest first.
    pub fn pop(&mut self) -> Option<Vec<u8>> {
        let message = self.messages.pop_front()?;
        self.bytes -= message.len() + FRAME_UPKEEP;
        Some(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::encode;
    use crate::message::ToDevice;

    fn update(seq: u64, len: usize) -> Vec<u8> {
        encode(&ToDevice::Update {
            run: 1,
            seq,
            bytes: vec![0; len],
        })
        .expect("encodes")
    }

    #[test]
    fn a_device_that_just_opened_a_session_gets_the_screen_first() {
        let mut q = SessionQueue::starting_with_screen(SESSION_QUEUE_LIMIT);
        // Output before the snapshot is sent is already in it.
        q.push(update(1, 10));
        assert_eq!(q.pop(), Next::SkipAhead);
        q.push(update(2, 10));
        assert_eq!(q.pop(), Next::Frame(update(2, 10)));
    }

    #[test]
    fn a_slow_device_skips_ahead_instead_of_holding_the_session() {
        let mut q = SessionQueue::new(SESSION_QUEUE_LIMIT);
        for seq in 1..=3 {
            q.push(update(seq, 1000 * 1024));
        }
        assert_eq!(q.pop(), Next::SkipAhead);
        assert_eq!(q.pop(), Next::Empty);
    }

    #[test]
    fn control_messages_come_out_in_order() {
        let mut q = ControlQueue::new(CONTROL_QUEUE_LIMIT);
        q.push(b"one".to_vec()).expect("room");
        q.push(b"two".to_vec()).expect("room");
        assert_eq!(q.pop(), Some(b"one".to_vec()));
        assert_eq!(q.pop(), Some(b"two".to_vec()));
        assert_eq!(q.pop(), None);
    }

    #[test]
    fn a_full_control_queue_means_close_the_connection() {
        let mut q = ControlQueue::new(1000);
        q.push(vec![0; 600]).expect("room");
        assert_eq!(q.push(vec![0; 600]), Err(ControlQueueFull));
        // Nothing was dropped silently: what was queued is still there.
        assert_eq!(q.pop(), Some(vec![0; 600]));
    }

    #[test]
    fn many_tiny_control_messages_count_their_upkeep() {
        let mut q = ControlQueue::new(1000);
        let mut queued = 0;
        while q.push(vec![1]).is_ok() {
            queued += 1;
        }
        assert!(queued < 20, "{queued} one-byte messages fit in 1000 bytes");
    }

    #[test]
    fn popping_makes_room_again() {
        let mut q = ControlQueue::new(1000);
        q.push(vec![0; 600]).expect("room");
        q.pop();
        q.push(vec![0; 600]).expect("room again");
    }
}
