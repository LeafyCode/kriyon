//! Length-prefixed frame protocol for the per-session [PTY daemon] socket.
//!
//! Wire layout per frame: `[u8 tag][u32 len (LE)][payload (len bytes)]`. Pure
//! encode/decode — no IO. The decoder tolerates partial reads (Unix-stream
//! boundaries are arbitrary) and skips unknown/malformed tags without panicking,
//! so a protocol-version skew degrades instead of crashing the daemon.

const TAG_OUTPUT: u8 = 0;
const TAG_STDIN: u8 = 1;
const TAG_RESIZE: u8 = 2;
const TAG_ATTACH: u8 = 3;
const TAG_SHUTDOWN: u8 = 4;
const TAG_BUSY: u8 = 5;
const TAG_REPAINT: u8 = 6;

const HEADER_LEN: usize = 5;
const DIMS_LEN: usize = 4;
const BUSY_LEN: usize = 1;

/// One message on the session socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    /// Raw PTY bytes, daemon → app.
    Output(Vec<u8>),
    /// Bytes to write to the child's stdin, app → daemon.
    Stdin(Vec<u8>),
    /// Resize the child's PTY, app → daemon.
    Resize { cols: u16, rows: u16 },
    /// First frame after a client connects; carries the initial size.
    Attach { cols: u16, rows: u16 },
    /// Terminate the child and exit the daemon, app → daemon.
    Shutdown,
    /// Whether the child shell has a foreground command running, daemon → app.
    /// Derived from the tty's foreground process group; pushed on change and once
    /// on attach so a reattaching client learns the current state.
    Busy(bool),
    /// Ask the daemon to resend its screen snapshot as an `Output` frame,
    /// app → daemon. Sent when a terminal (re)attaches to an already-live
    /// session — a remounted xterm starts blank and the socket-level attach
    /// repaint only happens once per connection.
    Repaint,
}

fn dims(cols: u16, rows: u16) -> Vec<u8> {
    let mut v = Vec::with_capacity(DIMS_LEN);
    v.extend_from_slice(&cols.to_le_bytes());
    v.extend_from_slice(&rows.to_le_bytes());
    v
}

impl Frame {
    /// Serialize the frame to its wire bytes.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        let (tag, payload): (u8, Vec<u8>) = match self {
            Frame::Output(b) => (TAG_OUTPUT, b.clone()),
            Frame::Stdin(b) => (TAG_STDIN, b.clone()),
            Frame::Resize { cols, rows } => (TAG_RESIZE, dims(*cols, *rows)),
            Frame::Attach { cols, rows } => (TAG_ATTACH, dims(*cols, *rows)),
            Frame::Shutdown => (TAG_SHUTDOWN, Vec::new()),
            Frame::Busy(busy) => (TAG_BUSY, vec![u8::from(*busy)]),
            Frame::Repaint => (TAG_REPAINT, Vec::new()),
        };
        let len = u32::try_from(payload.len()).unwrap_or(u32::MAX);
        let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
        out.push(tag);
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&payload);
        out
    }
}

/// Accumulates bytes read off the socket and yields complete [`Frame`]s.
#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    #[must_use]
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Append freshly-read bytes.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Pop the next complete frame, if one is fully buffered. Unknown or
    /// malformed (e.g. wrong-length dims) frames are consumed and skipped.
    pub fn next_frame(&mut self) -> Option<Frame> {
        loop {
            if self.buf.len() < HEADER_LEN {
                return None;
            }
            let tag = self.buf[0];
            let len = u32::from_le_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]);
            let len = usize::try_from(len).unwrap_or(usize::MAX);
            if self.buf.len() < HEADER_LEN + len {
                return None;
            }
            let payload = self.buf[HEADER_LEN..HEADER_LEN + len].to_vec();
            self.buf.drain(..HEADER_LEN + len);
            match tag {
                TAG_OUTPUT => return Some(Frame::Output(payload)),
                TAG_STDIN => return Some(Frame::Stdin(payload)),
                TAG_RESIZE if payload.len() == DIMS_LEN => {
                    return Some(Frame::Resize {
                        cols: u16::from_le_bytes([payload[0], payload[1]]),
                        rows: u16::from_le_bytes([payload[2], payload[3]]),
                    });
                }
                TAG_ATTACH if payload.len() == DIMS_LEN => {
                    return Some(Frame::Attach {
                        cols: u16::from_le_bytes([payload[0], payload[1]]),
                        rows: u16::from_le_bytes([payload[2], payload[3]]),
                    });
                }
                TAG_SHUTDOWN => return Some(Frame::Shutdown),
                TAG_BUSY if payload.len() == BUSY_LEN => {
                    return Some(Frame::Busy(payload[0] != 0));
                }
                TAG_REPAINT => return Some(Frame::Repaint),
                // Unknown tag, or a Resize/Attach/Busy with bad length: skip.
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_each_frame() {
        let frames = vec![
            Frame::Output(vec![1, 2, 3, 0, 255]),
            Frame::Stdin(b"ls -la\n".to_vec()),
            Frame::Resize {
                cols: 120,
                rows: 40,
            },
            Frame::Attach { cols: 80, rows: 24 },
            Frame::Shutdown,
            Frame::Busy(true),
            Frame::Busy(false),
            Frame::Repaint,
        ];
        let mut dec = FrameDecoder::new();
        for f in &frames {
            dec.push(&f.encode());
        }
        let mut got = Vec::new();
        while let Some(f) = dec.next_frame() {
            got.push(f);
        }
        assert_eq!(got, frames);
    }

    #[test]
    fn decodes_across_split_buffers() {
        let f = Frame::Output(b"hello world".to_vec());
        let bytes = f.encode();
        let mut dec = FrameDecoder::new();
        // Feed one byte at a time: no frame until the last byte lands.
        for (i, b) in bytes.iter().enumerate() {
            dec.push(&[*b]);
            if i + 1 < bytes.len() {
                assert!(dec.next_frame().is_none(), "no full frame yet at byte {i}");
            }
        }
        assert_eq!(dec.next_frame(), Some(f));
        assert_eq!(dec.next_frame(), None);
    }

    #[test]
    fn unknown_tag_is_skipped_not_panic() {
        let mut dec = FrameDecoder::new();
        // tag 99 (unknown), len 1, one payload byte — must be consumed, no panic.
        dec.push(&[99, 1, 0, 0, 0, 7]);
        assert_eq!(dec.next_frame(), None);
        // A valid frame after the bad one still decodes.
        dec.push(&Frame::Shutdown.encode());
        assert_eq!(dec.next_frame(), Some(Frame::Shutdown));
    }

    #[test]
    fn empty_buffer_yields_nothing() {
        let mut dec = FrameDecoder::new();
        assert_eq!(dec.next_frame(), None);
    }
}
