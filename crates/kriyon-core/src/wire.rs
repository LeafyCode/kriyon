//! Length-prefixed frame protocol for the per-session [PTY daemon] socket.
//!
//! Wire layout per frame: `[u8 tag][u32 len (LE)][payload (len bytes)]`. Pure
//! encode/decode — no IO. The decoder tolerates partial reads (Unix-stream
//! boundaries are arbitrary) and skips unknown/malformed tags without panicking,
//! so a protocol-version skew degrades instead of crashing the daemon.
//!
//! One thing it cannot skip is a frame longer than [`MAX_PAYLOAD_LEN`]: the
//! bytes after such a header can't be told apart from the next frame, so the
//! decoder refuses it with [`FrameTooLarge`] and the caller drops the connection.

const TAG_OUTPUT: u8 = 0;
const TAG_STDIN: u8 = 1;
const TAG_RESIZE: u8 = 2;
const TAG_ATTACH: u8 = 3;
const TAG_SHUTDOWN: u8 = 4;
const TAG_BUSY: u8 = 5;
const TAG_REPAINT: u8 = 6;

const HEADER_LEN: usize = 5;

/// The most payload one frame may carry, bounding what a bad header can make a
/// process buffer. PTY output arrives in chunks of a few kilobytes, but a screen
/// snapshot of a large, colourful screen can pass this (tens of MB at the
/// 1000x1000 size cap), so a sender splits anything long with [`chunked`].
pub const MAX_PAYLOAD_LEN: usize = 16 * 1024 * 1024;

/// A header announced more payload than [`MAX_PAYLOAD_LEN`]. The stream can't be
/// read past it, so the connection it arrived on is finished.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a frame announced {len} payload bytes; the limit is {MAX_PAYLOAD_LEN}")]
pub struct FrameTooLarge {
    /// The payload length the header claimed.
    pub len: u32,
}
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

/// Split a byte stream into frames small enough for any decoder to accept. The
/// two streams ([`Frame::Stdin`], [`Frame::Output`]) carry no message boundaries,
/// so where a long one is cut doesn't matter.
pub fn chunked(bytes: &[u8], wrap: fn(Vec<u8>) -> Frame) -> impl Iterator<Item = Frame> + '_ {
    bytes
        .chunks(MAX_PAYLOAD_LEN)
        .map(move |chunk| wrap(chunk.to_vec()))
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
        debug_assert!(
            payload.len() <= MAX_PAYLOAD_LEN,
            "a {}-byte payload passes the frame limit; split it with `chunked`",
            payload.len()
        );
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
    /// Set once a frame was refused. Nothing after it can be decoded, so the
    /// decoder stops keeping bytes and repeats the refusal.
    refused: Option<FrameTooLarge>,
}

impl FrameDecoder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Append freshly-read bytes. After a refused frame they are dropped.
    pub fn push(&mut self, bytes: &[u8]) {
        if self.refused.is_none() {
            self.buf.extend_from_slice(bytes);
        }
    }

    /// Pop the next complete frame, if one is fully buffered. Unknown or
    /// malformed (e.g. wrong-length dims) frames are consumed and skipped.
    ///
    /// # Errors
    ///
    /// [`FrameTooLarge`] when a header announces more than [`MAX_PAYLOAD_LEN`]
    /// bytes, and on every call after that: drop the connection.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameTooLarge> {
        if let Some(refused) = self.refused {
            return Err(refused);
        }
        loop {
            if self.buf.len() < HEADER_LEN {
                return Ok(None);
            }
            let tag = self.buf[0];
            let announced =
                u32::from_le_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]);
            let len = match usize::try_from(announced) {
                Ok(len) if len <= MAX_PAYLOAD_LEN => len,
                _ => {
                    let refused = FrameTooLarge { len: announced };
                    self.refused = Some(refused);
                    self.buf = Vec::new();
                    return Err(refused);
                }
            };
            if self.buf.len() < HEADER_LEN + len {
                return Ok(None);
            }
            let payload = self.buf[HEADER_LEN..HEADER_LEN + len].to_vec();
            self.buf.drain(..HEADER_LEN + len);
            match tag {
                TAG_OUTPUT => return Ok(Some(Frame::Output(payload))),
                TAG_STDIN => return Ok(Some(Frame::Stdin(payload))),
                TAG_RESIZE if payload.len() == DIMS_LEN => {
                    return Ok(Some(Frame::Resize {
                        cols: u16::from_le_bytes([payload[0], payload[1]]),
                        rows: u16::from_le_bytes([payload[2], payload[3]]),
                    }));
                }
                TAG_ATTACH if payload.len() == DIMS_LEN => {
                    return Ok(Some(Frame::Attach {
                        cols: u16::from_le_bytes([payload[0], payload[1]]),
                        rows: u16::from_le_bytes([payload[2], payload[3]]),
                    }));
                }
                TAG_SHUTDOWN => return Ok(Some(Frame::Shutdown)),
                TAG_BUSY if payload.len() == BUSY_LEN => {
                    return Ok(Some(Frame::Busy(payload[0] != 0)));
                }
                TAG_REPAINT => return Ok(Some(Frame::Repaint)),
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
    #[cfg(debug_assertions)]
    #[should_panic(expected = "split it with `chunked`")]
    fn encoding_a_frame_the_decoder_would_refuse_is_a_bug() {
        let _ = Frame::Output(vec![0; MAX_PAYLOAD_LEN + 1]).encode();
    }

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
        while let Ok(Some(f)) = dec.next_frame() {
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
                assert_eq!(dec.next_frame(), Ok(None), "no full frame yet at byte {i}");
            }
        }
        assert_eq!(dec.next_frame(), Ok(Some(f)));
        assert_eq!(dec.next_frame(), Ok(None));
    }

    #[test]
    fn unknown_tag_is_skipped_not_panic() {
        let mut dec = FrameDecoder::new();
        // tag 99 (unknown), len 1, one payload byte — must be consumed, no panic.
        dec.push(&[99, 1, 0, 0, 0, 7]);
        assert_eq!(dec.next_frame(), Ok(None));
        // A valid frame after the bad one still decodes.
        dec.push(&Frame::Shutdown.encode());
        assert_eq!(dec.next_frame(), Ok(Some(Frame::Shutdown)));
    }

    /// The bug this guards: a header may announce up to 4 GiB of payload. The
    /// decoder used to wait for all of it, keeping every byte pushed meanwhile,
    /// so one bad header from the other end of the socket grew the process
    /// without bound.
    #[test]
    fn a_header_announcing_a_huge_payload_is_not_buffered() {
        let mut dec = FrameDecoder::new();
        dec.push(&[TAG_OUTPUT, 0xFF, 0xFF, 0xFF, 0xFF]);
        let refused = Err(FrameTooLarge { len: u32::MAX });
        assert_eq!(dec.next_frame(), refused);
        dec.push(&vec![0u8; 1024 * 1024]);
        assert_eq!(dec.next_frame(), refused, "the refusal is final");
        assert!(
            dec.buf.is_empty(),
            "the decoder kept {} bytes of a frame it can never finish",
            dec.buf.len()
        );
    }

    #[test]
    fn a_frame_one_byte_over_the_limit_is_refused() {
        let over = u32::try_from(MAX_PAYLOAD_LEN + 1).expect("the limit fits a u32");
        let mut dec = FrameDecoder::new();
        dec.push(&[TAG_STDIN]);
        dec.push(&over.to_le_bytes());
        assert_eq!(dec.next_frame(), Err(FrameTooLarge { len: over }));
    }

    #[test]
    fn a_frame_at_the_limit_still_decodes() {
        let frame = Frame::Output(vec![7; MAX_PAYLOAD_LEN]);
        let mut dec = FrameDecoder::new();
        dec.push(&frame.encode());
        assert_eq!(dec.next_frame(), Ok(Some(frame)));
    }

    #[test]
    fn a_long_stream_is_cut_into_frames_a_decoder_accepts() {
        let bytes = vec![3; MAX_PAYLOAD_LEN + 10];
        let mut dec = FrameDecoder::new();
        for frame in chunked(&bytes, Frame::Stdin) {
            dec.push(&frame.encode());
        }
        let mut got = Vec::new();
        while let Ok(Some(Frame::Stdin(part))) = dec.next_frame() {
            got.push(part.len());
        }
        assert_eq!(got, vec![MAX_PAYLOAD_LEN, 10]);
        assert_eq!(dec.next_frame(), Ok(None));
    }

    #[test]
    fn empty_buffer_yields_nothing() {
        let mut dec = FrameDecoder::new();
        assert_eq!(dec.next_frame(), Ok(None));
    }
}
