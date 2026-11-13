//! [Output history]: the most recent output of a session, kept by its daemon.
//!
//! The [Screen snapshot] rebuilds only the visible screen. When a client
//! skips ahead, or a terminal attaches after output it never saw, what scrolled
//! past is gone from it. The Output history keeps the raw output bytes, up to
//! a byte limit, so a client can ask for them ("Show earlier output").
//!
//! The oldest bytes go first. After a trim the history starts at a line start
//! when a line break is within a few KB, so a replay usually doesn't open with
//! half a line or half an escape code. It can't restore the colours or modes
//! set before the cut. Pure state: no threads, no IO.

use std::collections::VecDeque;

/// Bytes are kept in chunks of up to this size, so a stream of tiny writes
/// (echoed keystrokes, a spinner) doesn't cost an allocation each.
const CHUNK_LEN: usize = 64 * 1024;

/// How far past a trim to look for a line break. Bounded, so a history that
/// is one long line never makes each push scan all of it.
const LINE_SEARCH_LEN: usize = 4096;

/// The most recent output of a session, at most `limit` bytes.
#[derive(Debug)]
pub struct OutputHistory {
    chunks: VecDeque<Vec<u8>>,
    /// Bytes of the front chunk already trimmed away. Kept as an offset, so
    /// a trim never moves the rest of the chunk.
    front_start: usize,
    len: usize,
    limit: usize,
}

impl OutputHistory {
    /// An empty history that keeps at most `limit` bytes.
    #[must_use]
    pub fn new(limit: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            front_start: 0,
            len: 0,
            limit,
        }
    }

    /// Add output; past the limit, the oldest output goes.
    pub fn push(&mut self, bytes: &[u8]) {
        match self.chunks.back_mut() {
            Some(last) if last.len() + bytes.len() <= CHUNK_LEN => last.extend_from_slice(bytes),
            _ if bytes.is_empty() => return,
            _ => self.chunks.push_back(bytes.to_vec()),
        }
        self.len += bytes.len();
        if self.len > self.limit {
            let at_line_start = self.drop_front(self.len - self.limit);
            if !at_line_start {
                if let Some(line_end) = self.next_line_break() {
                    self.drop_front(line_end + 1);
                }
            }
        }
    }

    /// Everything kept, oldest first.
    #[must_use]
    pub fn contents(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.len);
        for chunk in self.live_chunks() {
            out.extend_from_slice(chunk);
        }
        out
    }

    /// The kept bytes, chunk by chunk, without the trimmed front.
    fn live_chunks(&self) -> impl Iterator<Item = &[u8]> {
        self.chunks.iter().enumerate().map(|(i, chunk)| {
            if i == 0 {
                &chunk[self.front_start..]
            } else {
                chunk.as_slice()
            }
        })
    }

    /// Drop the oldest `n` bytes. Returns whether what is left starts a line
    /// (the last byte dropped was a line break).
    fn drop_front(&mut self, mut n: usize) -> bool {
        let mut at_line_start = true;
        while n > 0 {
            let Some(front) = self.chunks.front() else {
                break;
            };
            let kept = front.len() - self.front_start;
            if kept <= n {
                at_line_start = front.last() == Some(&b'\n');
                n -= kept;
                self.len -= kept;
                self.chunks.pop_front();
                self.front_start = 0;
            } else {
                self.front_start += n;
                at_line_start = front[self.front_start - 1] == b'\n';
                self.len -= n;
                n = 0;
            }
        }
        at_line_start
    }

    /// Where the first line break is, within [`LINE_SEARCH_LEN`] bytes.
    fn next_line_break(&self) -> Option<usize> {
        self.live_chunks()
            .flat_map(<[u8]>::iter)
            .take(LINE_SEARCH_LEN)
            .position(|&byte| byte == b'\n')
    }
}

#[cfg(test)]
mod tests {
    use super::OutputHistory;

    #[test]
    fn keeps_output_in_order() {
        let mut history = OutputHistory::new(1000);
        history.push(b"one\n");
        history.push(b"two\n");
        assert_eq!(history.contents(), b"one\ntwo\n");
    }

    #[test]
    fn an_empty_history_has_nothing() {
        assert_eq!(OutputHistory::new(1000).contents(), b"");
    }

    #[test]
    fn past_its_limit_the_oldest_output_goes_first() {
        let mut history = OutputHistory::new(10);
        history.push(b"aaaa\n");
        history.push(b"bbbb\n");
        history.push(b"cccc\n");
        assert_eq!(history.contents(), b"bbbb\ncccc\n");
    }

    #[test]
    fn a_trimmed_history_starts_at_a_line_start() {
        let mut history = OutputHistory::new(12);
        history.push(b"first line\nsecond\n");
        assert_eq!(
            history.contents(),
            b"second\n",
            "a replay must not open with half a line (or half an escape code)"
        );
    }

    #[test]
    fn output_with_no_line_break_is_still_cut_to_the_limit() {
        let mut history = OutputHistory::new(4);
        history.push(b"abcdefgh");
        assert_eq!(history.contents(), b"efgh");
    }

    #[test]
    fn never_holds_more_than_its_limit() {
        let mut history = OutputHistory::new(100);
        for i in 0..1000 {
            history.push(format!("line {i}\n").as_bytes());
            assert!(history.contents().len() <= 100);
        }
        assert!(history.contents().ends_with(b"line 999\n"));
    }
}
