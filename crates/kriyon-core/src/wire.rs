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
const TAG_REQUEST_HISTORY: u8 = 7;
const TAG_HISTORY: u8 = 8;
const TAG_HISTORY_END: u8 = 9;
const TAG_DIALOG: u8 = 10;

const HEADER_LEN: usize = 5;

/// The most payload one frame may carry, bounding what a bad header can make a
/// process buffer. PTY output arrives in chunks of a few kilobytes, but a screen
/// snapshot of a large, colourful screen can pass this (tens of MB at the
/// 1000x1000 size cap), so a sender splits anything long with [`ByteStream`].
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
/// `[open u8][generation u64 LE]`.
const DIALOG_LEN: usize = 9;

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
    /// Ask the daemon for its [Output history], app → daemon. Answered with
    /// zero or more `History` frames, then one `HistoryEnd`. Requests made
    /// before an answer goes out share it: ask again only after `HistoryEnd`.
    RequestHistory,
    /// Part of the [Output history], daemon → app, oldest first. Kept apart
    /// from `Output`, so earlier output is never drawn as if it were live. It
    /// can overlap the `Output` that follows it (ADR-0060).
    History(Vec<u8>),
    /// The last frame of an [Output history] answer, daemon → app: the
    /// `History` frames before it, since the last `HistoryEnd`, are all of it.
    HistoryEnd,
    /// The [CLI dialog] on the daemon's screen, daemon → app: whether one
    /// shows, and its [Dialog generation]. Sent when the generation moves,
    /// and once on attach. In order with `Output`, so the receiver knows
    /// which output the change came after.
    Dialog { open: bool, generation: u64 },
}

/// A frame kind that carries a stream of bytes with no message boundaries, so
/// a long run can be cut into frames anywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ByteStream {
    /// [`Frame::Output`].
    Output,
    /// [`Frame::History`].
    History,
    /// [`Frame::Stdin`].
    Stdin,
}

impl ByteStream {
    /// `bytes` as encoded frames of this kind, each within
    /// [`MAX_PAYLOAD_LEN`], written straight from `bytes`: the one copy a
    /// frame needs, where building [`Frame`]s and encoding them makes three.
    /// No bytes, no frame.
    #[must_use]
    pub fn encode(self, bytes: &[u8]) -> Vec<u8> {
        self.encode_parts(&[bytes])
    }

    /// [`Self::encode`] for a stream held in `parts`, in order: frames are
    /// filled across their boundaries, written straight from each.
    #[must_use]
    pub fn encode_parts(self, parts: &[&[u8]]) -> Vec<u8> {
        let tag = match self {
            ByteStream::Output => TAG_OUTPUT,
            ByteStream::History => TAG_HISTORY,
            ByteStream::Stdin => TAG_STDIN,
        };
        let total: usize = parts.iter().map(|part| part.len()).sum();
        let mut out = Vec::with_capacity(total + total.div_ceil(MAX_PAYLOAD_LEN) * HEADER_LEN);
        let mut left = total;
        let mut room = 0;
        for part in parts {
            let mut part: &[u8] = part;
            while !part.is_empty() {
                if room == 0 {
                    room = left.min(MAX_PAYLOAD_LEN);
                    out.push(tag);
                    // At most `MAX_PAYLOAD_LEN`, which fits in a `u32`.
                    out.extend_from_slice(&u32::try_from(room).unwrap_or(u32::MAX).to_le_bytes());
                }
                let (now, rest) = part.split_at(part.len().min(room));
                out.extend_from_slice(now);
                room -= now.len();
                left -= now.len();
                part = rest;
            }
        }
        out
    }
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
            Frame::RequestHistory => (TAG_REQUEST_HISTORY, Vec::new()),
            Frame::History(b) => (TAG_HISTORY, b.clone()),
            Frame::HistoryEnd => (TAG_HISTORY_END, Vec::new()),
            Frame::Dialog { open, generation } => {
                let mut v = Vec::with_capacity(DIALOG_LEN);
                v.push(u8::from(*open));
                v.extend_from_slice(&generation.to_le_bytes());
                (TAG_DIALOG, v)
            }
        };
        debug_assert!(
            payload.len() <= MAX_PAYLOAD_LEN,
            "a {}-byte payload passes the frame limit; split it with `ByteStream`",
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
                TAG_REQUEST_HISTORY => return Ok(Some(Frame::RequestHistory)),
                TAG_HISTORY => return Ok(Some(Frame::History(payload))),
                TAG_HISTORY_END => return Ok(Some(Frame::HistoryEnd)),
                TAG_DIALOG if payload.len() == DIALOG_LEN => {
                    let mut generation = [0; 8];
                    generation.copy_from_slice(&payload[1..]);
                    return Ok(Some(Frame::Dialog {
                        open: payload[0] != 0,
                        generation: u64::from_le_bytes(generation),
                    }));
                }
                // Unknown tag, or a Resize/Attach/Busy/Dialog with bad length: skip.
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
    #[should_panic(expected = "split it with `ByteStream`")]
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
            Frame::RequestHistory,
            Frame::History(b"earlier\n".to_vec()),
            Frame::HistoryEnd,
            Frame::Dialog {
                open: true,
                generation: u64::MAX - 1,
            },
            Frame::Dialog {
                open: false,
                generation: 7,
            },
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
    fn a_dialog_frame_of_the_wrong_length_is_skipped() {
        let mut dec = FrameDecoder::new();
        dec.push(&[TAG_DIALOG, 2, 0, 0, 0, 1, 0]);
        dec.push(&Frame::Busy(true).encode());
        assert_eq!(dec.next_frame(), Ok(Some(Frame::Busy(true))));
    }

    #[test]
    fn a_byte_stream_encodes_as_its_frames_would() {
        assert!(
            ByteStream::Output.encode(b"").is_empty(),
            "nothing to send, no frame"
        );
        for bytes in [&b"x"[..], b"hello world"] {
            assert_eq!(
                ByteStream::Output.encode(bytes),
                Frame::Output(bytes.to_vec()).encode()
            );
            assert_eq!(
                ByteStream::History.encode(bytes),
                Frame::History(bytes.to_vec()).encode()
            );
        }
    }

    #[test]
    fn a_stream_in_parts_encodes_as_the_whole_would() {
        let whole = vec![5u8; MAX_PAYLOAD_LEN + 7];
        let (a, b) = whole.split_at(MAX_PAYLOAD_LEN - 3);
        assert_eq!(
            ByteStream::History.encode_parts(&[a, &[], b]),
            ByteStream::History.encode(&whole)
        );
        assert_eq!(
            ByteStream::Stdin.encode_parts(&[&[], &[]]),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn a_long_byte_stream_is_cut_into_frames_the_decoder_accepts() {
        let bytes = vec![7u8; MAX_PAYLOAD_LEN + 10];
        let mut dec = FrameDecoder::new();
        dec.push(&ByteStream::Output.encode(&bytes));
        assert_eq!(
            dec.next_frame(),
            Ok(Some(Frame::Output(vec![7; MAX_PAYLOAD_LEN])))
        );
        assert_eq!(dec.next_frame(), Ok(Some(Frame::Output(vec![7; 10]))));
        assert_eq!(dec.next_frame(), Ok(None));
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
        dec.push(&ByteStream::Stdin.encode(&bytes));
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
