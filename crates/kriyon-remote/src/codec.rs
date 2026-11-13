//! Framing for the remote protocol (spec §3): `[u32 length, big-endian]`, then
//! the message's postcard encoding, which starts with its tag as a varint.
//!
//! Limits are per direction and, device to host, per message: the decoder
//! reads the tag as soon as it arrives and refuses a length over that
//! message's limit before the body is buffered. An unknown tag is skipped and
//! reported, so the host can answer `UnknownMessage`; trailing bytes after a
//! known message are ignored, so a newer peer may append fields.
//!
//! Same shape as `kriyon_core::wire::FrameDecoder`: push bytes, pop
//! messages, and after an error every call repeats it — close the stream.

use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::message::{FromDevice, FromDeviceKind, PairFromDevice, PairToDevice, ToDevice};

const KIB: usize = 1024;
const LEN_PREFIX: usize = 4;

/// A message enum that can go on the wire, with its limits.
pub trait Wire: Serialize + DeserializeOwned {
    /// How many tags (variants) this side knows. Higher tags are unknown.
    const KNOWN_TAGS: u32;
    /// The longest any message in this direction may be.
    const MAX_LEN: usize;
    /// The longest a message with `tag` may be, tag included. Unknown tags
    /// get the limit for "anything else".
    fn max_len(tag: u32) -> usize;
}

impl Wire for FromDevice {
    const KNOWN_TAGS: u32 = 10;
    const MAX_LEN: usize = 64 * KIB;
    fn max_len(tag: u32) -> usize {
        match FromDeviceKind::from_tag(tag) {
            Some(FromDeviceKind::Input | FromDeviceKind::Compose) => 64 * KIB,
            Some(FromDeviceKind::PushToken) => 2 * KIB,
            _ => 4 * KIB,
        }
    }
}

impl Wire for ToDevice {
    const KNOWN_TAGS: u32 = 11;
    const MAX_LEN: usize = 1024 * KIB;
    fn max_len(_tag: u32) -> usize {
        Self::MAX_LEN
    }
}

impl Wire for PairFromDevice {
    const KNOWN_TAGS: u32 = 1;
    const MAX_LEN: usize = 4 * KIB;
    fn max_len(_tag: u32) -> usize {
        Self::MAX_LEN
    }
}

impl Wire for PairToDevice {
    const KNOWN_TAGS: u32 = 3;
    const MAX_LEN: usize = 4 * KIB;
    fn max_len(_tag: u32) -> usize {
        Self::MAX_LEN
    }
}

/// A protocol error: the stream can't be read any further. Close it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodecError {
    /// A length over the limit for its direction or message.
    TooLong { len: usize, max: usize },
    /// A message whose tag or fields don't decode.
    Malformed,
}

/// One thing read off the stream.
#[derive(Debug, PartialEq, Eq)]
pub enum Decoded<M> {
    Message(M),
    /// A tag this side doesn't know; its bytes were skipped.
    Unknown {
        tag: u32,
    },
}

/// Encode `message` with its length prefix.
///
/// # Errors
/// [`CodecError::TooLong`] when it is over its limit; nothing is sent.
pub fn encode<M: Wire>(message: &M) -> Result<Vec<u8>, CodecError> {
    let body = postcard::to_allocvec(message).map_err(|_| CodecError::Malformed)?;
    let (tag, _) = postcard::take_from_bytes::<u32>(&body).map_err(|_| CodecError::Malformed)?;
    let max = M::max_len(tag).min(M::MAX_LEN);
    let len = u32::try_from(body.len()).map_err(|_| CodecError::TooLong {
        len: body.len(),
        max,
    })?;
    if body.len() > max {
        return Err(CodecError::TooLong {
            len: body.len(),
            max,
        });
    }
    let mut out = Vec::with_capacity(LEN_PREFIX + body.len());
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// Reads messages of type `M` from a byte stream.
pub struct Decoder<M> {
    buf: Vec<u8>,
    /// Where the next message starts in `buf`. Read messages are dropped from
    /// the front once per push, not once per message, so a read packed with
    /// tiny messages costs one shift, not one per message.
    start: usize,
    failed: Option<CodecError>,
    _message: PhantomData<M>,
}

impl<M: Wire> Default for Decoder<M> {
    fn default() -> Self {
        Self {
            buf: Vec::new(),
            start: 0,
            failed: None,
            _message: PhantomData,
        }
    }
}

impl<M: Wire> Decoder<M> {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Append freshly read bytes. After an error they are dropped.
    pub fn push(&mut self, bytes: &[u8]) {
        if self.failed.is_none() {
            self.buf.drain(..self.start);
            self.start = 0;
            self.buf.extend_from_slice(bytes);
        }
    }

    /// The next message, once it has fully arrived.
    ///
    /// # Errors
    /// A [`CodecError`], and the same one on every later call.
    pub fn next_message(&mut self) -> Result<Option<Decoded<M>>, CodecError> {
        if let Some(failed) = self.failed {
            return Err(failed);
        }
        let read = self.read();
        if let Err(failed) = read {
            self.failed = Some(failed);
            self.buf = Vec::new();
            self.start = 0;
        }
        read
    }

    fn read(&mut self) -> Result<Option<Decoded<M>>, CodecError> {
        let pending = &self.buf[self.start..];
        let Some(prefix) = pending.first_chunk::<LEN_PREFIX>() else {
            return Ok(None);
        };
        let len = usize::try_from(u32::from_be_bytes(*prefix)).unwrap_or(usize::MAX);
        if len > M::MAX_LEN {
            return Err(CodecError::TooLong {
                len,
                max: M::MAX_LEN,
            });
        }
        if len == 0 {
            return Err(CodecError::Malformed);
        }
        let arrived = &pending[LEN_PREFIX..];
        let frame = &arrived[..arrived.len().min(len)];
        let tag = match postcard::take_from_bytes::<u32>(frame) {
            Ok((tag, _)) => tag,
            // The tag's varint hasn't all arrived yet.
            Err(_) if frame.len() < len => return Ok(None),
            Err(_) => return Err(CodecError::Malformed),
        };
        let max = M::max_len(tag);
        if len > max {
            return Err(CodecError::TooLong { len, max });
        }
        if frame.len() < len {
            return Ok(None);
        }
        let decoded = if tag < M::KNOWN_TAGS {
            let (message, _trailing) =
                postcard::take_from_bytes::<M>(frame).map_err(|_| CodecError::Malformed)?;
            Decoded::Message(message)
        } else {
            Decoded::Unknown { tag }
        };
        self.start += LEN_PREFIX + len;
        Ok(Some(decoded))
    }

    /// Bytes held, waiting for the rest of a message. For tests.
    #[must_use]
    pub fn buffered(&self) -> usize {
        self.buf.len() - self.start
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{Epoch, RefuseReason};

    const EPOCH: Epoch = Epoch {
        host_boot_id: 7,
        counter: 1,
    };

    fn hello() -> FromDevice {
        FromDevice::Hello {
            app_version: "1.0".into(),
            protocol_minor: 2,
        }
    }

    fn input(len: usize) -> FromDevice {
        FromDevice::Input {
            run: 1,
            epoch: EPOCH,
            seen_seq: 3,
            bytes: vec![b'x'; len],
        }
    }

    /// A frame with `tag` and `body` as written, whatever they hold.
    fn raw(tag: u8, body: &[u8]) -> Vec<u8> {
        let len = u32::try_from(1 + body.len()).expect("small");
        let mut out = len.to_be_bytes().to_vec();
        out.push(tag);
        out.extend_from_slice(body);
        out
    }

    fn decoder() -> Decoder<FromDevice> {
        Decoder::new()
    }

    #[test]
    fn a_message_comes_back_as_it_went() {
        let mut d = decoder();
        d.push(&encode(&hello()).expect("encodes"));
        assert_eq!(d.next_message(), Ok(Some(Decoded::Message(hello()))));
        assert_eq!(d.next_message(), Ok(None));
    }

    #[test]
    fn the_length_is_big_endian_and_counts_the_tag_and_body() {
        let bytes = encode(&FromDevice::Resync).expect("encodes");
        assert_eq!(bytes, [0, 0, 0, 1, 2]);
    }

    #[test]
    fn a_message_split_across_reads_waits_for_the_rest() {
        let bytes = encode(&input(300)).expect("encodes");
        let mut d = decoder();
        for byte in &bytes[..bytes.len() - 1] {
            d.push(&[*byte]);
            assert_eq!(d.next_message(), Ok(None));
        }
        d.push(&bytes[bytes.len() - 1..]);
        assert_eq!(d.next_message(), Ok(Some(Decoded::Message(input(300)))));
    }

    #[test]
    fn several_messages_in_one_read_come_out_in_order() {
        let mut bytes = encode(&hello()).expect("encodes");
        bytes.extend(encode(&FromDevice::Resync).expect("encodes"));
        let mut d = decoder();
        d.push(&bytes);
        assert_eq!(d.next_message(), Ok(Some(Decoded::Message(hello()))));
        assert_eq!(
            d.next_message(),
            Ok(Some(Decoded::Message(FromDevice::Resync)))
        );
        assert_eq!(d.next_message(), Ok(None));
    }

    #[test]
    fn an_unknown_tag_is_skipped_and_the_next_message_still_reads() {
        let mut d = decoder();
        d.push(&raw(99, b"from a newer device"));
        d.push(&encode(&FromDevice::Resync).expect("encodes"));
        assert_eq!(d.next_message(), Ok(Some(Decoded::Unknown { tag: 99 })));
        assert_eq!(
            d.next_message(),
            Ok(Some(Decoded::Message(FromDevice::Resync)))
        );
    }

    #[test]
    fn trailing_bytes_after_a_known_message_are_ignored() {
        // A newer device appended a field to Resync.
        let mut d = decoder();
        d.push(&raw(2, b"new field"));
        assert_eq!(
            d.next_message(),
            Ok(Some(Decoded::Message(FromDevice::Resync)))
        );
    }

    #[test]
    fn a_length_over_the_direction_limit_fails_from_the_header_alone() {
        let mut d = decoder();
        d.push(&u32::MAX.to_be_bytes());
        let err = d.next_message();
        assert!(matches!(err, Err(CodecError::TooLong { .. })), "{err:?}");
        // Nothing is buffered, then or after.
        d.push(&[0; 1000]);
        assert_eq!(d.buffered(), 0);
        assert_eq!(d.next_message(), err);
    }

    #[test]
    fn a_length_over_its_message_limit_fails_once_the_tag_is_read() {
        // 5 KiB is fine for Input but over the 4 KiB for Hello.
        let mut d = decoder();
        let len = u32::try_from(5 * KIB).expect("small");
        d.push(&len.to_be_bytes());
        d.push(&[0]); // Hello's tag, and no body yet
        assert_eq!(
            d.next_message(),
            Err(CodecError::TooLong {
                len: 5 * KIB,
                max: 4 * KIB
            })
        );
    }

    #[test]
    fn each_device_message_has_its_own_limit() {
        let mut d = decoder();
        d.push(&encode(&input(60 * KIB)).expect("Input may be 64 KiB"));
        assert!(matches!(d.next_message(), Ok(Some(Decoded::Message(_)))));
        assert!(encode(&input(64 * KIB)).is_err(), "over 64 KiB with fields");
        let token = |len| FromDevice::PushToken {
            key_id: 1,
            sealed: vec![0; len],
        };
        assert!(encode(&token(KIB)).is_ok());
        assert!(encode(&token(2 * KIB)).is_err(), "PushToken is 2 KiB");
    }

    #[test]
    fn a_known_tag_whose_fields_do_not_decode_is_a_protocol_error() {
        let mut d = decoder();
        d.push(&raw(1, &[200])); // Open, with a string length past the end
        assert_eq!(d.next_message(), Err(CodecError::Malformed));
        assert_eq!(d.next_message(), Err(CodecError::Malformed));
    }

    #[test]
    fn an_empty_message_is_a_protocol_error() {
        let mut d = decoder();
        d.push(&0_u32.to_be_bytes());
        assert_eq!(d.next_message(), Err(CodecError::Malformed));
    }

    #[test]
    fn the_host_may_send_up_to_one_mebibyte() {
        let update = |len| ToDevice::Update {
            run: 1,
            seq: 1,
            bytes: vec![0; len],
        };
        let bytes = encode(&update(1000 * KIB)).expect("under 1 MiB");
        let mut d = Decoder::<ToDevice>::new();
        d.push(&bytes);
        assert!(matches!(d.next_message(), Ok(Some(Decoded::Message(_)))));
        assert!(encode(&update(1024 * KIB)).is_err());
    }

    #[test]
    fn a_refusal_round_trips_on_the_pair_alpn() {
        let refused = PairToDevice::Refused {
            reason: RefuseReason::TooOld { min_minor: 3 },
        };
        let mut d = Decoder::<PairToDevice>::new();
        d.push(&encode(&refused).expect("encodes"));
        assert_eq!(d.next_message(), Ok(Some(Decoded::Message(refused))));
    }
}
