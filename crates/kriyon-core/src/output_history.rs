//! [Output history]: the most recent output of a session, kept by its daemon.
//!
//! The [Screen snapshot] rebuilds only the visible screen. When a client
//! skips ahead, or a terminal attaches after output it never saw, what scrolled
//! past is gone from it. The Output history keeps the raw output bytes, up to
//! a byte limit, so a client can ask for them ("Show earlier output").
//!
//! The oldest bytes go first. Adding output stays cheap: the front is dropped
//! in steps, keeping up to a sixteenth over the limit, and nothing is searched.
//! Reading cuts to the limit and to a line start when a line break is within a
//! few KB, so a replay usually doesn't open with half a line or half an escape
//! code. It can't restore the colours or modes set before the cut. Pure state:
//! no threads, no IO.

use std::collections::VecDeque;

/// Bytes are kept in chunks of up to this size, so a stream of tiny writes
/// (echoed keystrokes, a spinner) doesn't cost an allocation each.
const CHUNK_LEN: usize = 64 * 1024;

/// How far past the cut a read looks for a line break. Bounded, so a history
/// that is one long line is never scanned whole.
const LINE_SEARCH_LEN: usize = 4096;

/// The most recent output of a session: reads give at most `limit` bytes;
/// up to a sixteenth more is kept between trims.
#[derive(Debug)]
pub struct OutputHistory {
    chunks: VecDeque<Vec<u8>>,
    /// Bytes of the front chunk already trimmed away. Kept as an offset, so
    /// a trim never moves the rest of the chunk.
    front_start: usize,
    len: usize,
    limit: usize,
    /// The last byte trimmed away was a line break (or nothing was trimmed).
    front_at_line_start: bool,
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
            front_at_line_start: true,
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
        // Trimmed in steps of a sixteenth of the limit, never per push, and
        // without looking for a line start: that is left to `contents`, which
        // runs only when a client asks. A push stays cheap even when the
        // output has no line breaks at all.
        if self.len > self.limit + self.limit / 16 {
            self.front_at_line_start = self.drop_front(self.len - self.limit);
        }
    }

    /// The most recent output, oldest first: at most the limit, and starting
    /// at a line start when one is within [`LINE_SEARCH_LEN`] bytes of where
    /// the limit cuts (and output follows it).
    #[must_use]
    pub fn contents(&self) -> Vec<u8> {
        self.parts().concat()
    }

    /// [`Self::contents`] as the slices it is made of, for a caller that
    /// copies them once straight into where they go.
    #[must_use]
    pub fn parts(&self) -> Vec<&[u8]> {
        let mut skip = self.start();
        let mut parts = Vec::new();
        for chunk in self.live_chunks() {
            if skip >= chunk.len() {
                skip -= chunk.len();
                continue;
            }
            parts.push(&chunk[skip..]);
            skip = 0;
        }
        parts
    }

    /// How many of the kept bytes [`Self::contents`] leaves out: those past
    /// the limit, then the rest of a line the cut fell in.
    fn start(&self) -> usize {
        let over = self.len.saturating_sub(self.limit);
        let cut_mid_line = if over > 0 {
            self.byte_at(over - 1) != Some(b'\n')
        } else {
            !self.front_at_line_start
        };
        if !cut_mid_line {
            return over;
        }
        match self.line_break_from(over) {
            // Only when output follows it: never an empty answer.
            Some(at) if at + 1 < self.len => at + 1,
            _ => over,
        }
    }

    /// The kept byte at `index`.
    fn byte_at(&self, mut index: usize) -> Option<u8> {
        for chunk in self.live_chunks() {
            if index < chunk.len() {
                return Some(chunk[index]);
            }
            index -= chunk.len();
        }
        None
    }

    /// Where the first line break at or after `from` is, looking no further
    /// than [`LINE_SEARCH_LEN`] bytes.
    fn line_break_from(&self, from: usize) -> Option<usize> {
        let mut offset = 0;
        let mut budget = LINE_SEARCH_LEN;
        for chunk in self.live_chunks() {
            let end = offset + chunk.len();
            if end > from && budget > 0 {
                let start = from.saturating_sub(offset);
                let window = &chunk[start..chunk.len().min(start + budget)];
                if let Some(at) = window.iter().position(|&byte| byte == b'\n') {
                    return Some(offset + start + at);
                }
                budget -= window.len();
            }
            offset = end;
        }
        None
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

    #[test]
    fn a_long_run_of_output_is_still_cut_to_a_line_start_when_read() {
        // Pushes trim in steps and never look for a line break; reading does.
        let mut history = OutputHistory::new(1600);
        for i in 0..400 {
            history.push(format!("line {i:03}\n").as_bytes());
        }
        let contents = history.contents();
        assert!(contents.len() <= 1600);
        assert!(contents.starts_with(b"line "), "starts at a line start");
        assert!(contents.ends_with(b"line 399\n"));
    }

    #[test]
    fn a_cut_whose_only_line_break_ends_the_history_keeps_what_it_has() {
        let mut history = OutputHistory::new(10);
        history.push(b"aaaaaaaaaaaaaaa\n");
        assert_eq!(history.contents(), b"aaaaaaaaa\n", "never an empty answer");
    }

    #[test]
    fn its_parts_are_its_contents() {
        let mut history = OutputHistory::new(1600);
        for i in 0..400 {
            history.push(format!("line {i:03}\n").as_bytes());
        }
        assert_eq!(history.parts().concat(), history.contents());
    }
}
