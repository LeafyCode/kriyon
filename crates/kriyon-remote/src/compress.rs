//! Compression of screen updates and snapshots (spec §3): each is one
//! independent zstd frame, no dictionary, with its content size in the frame
//! header.
//!
//! A decoder trusts none of it: the frame must state its content size, at most
//! [`MAX_DECOMPRESSED`], be decoded with a window of at most
//! 2^[`WINDOW_LOG_MAX`], and be the only thing in the bytes. Anything else is
//! a protocol error, and the device sends `Resync`.
//!
//! A compressed snapshot that doesn't fit in one message goes as numbered
//! `SnapshotPart`s; [`snapshot_messages`] splits it and [`SnapshotParts`]
//! joins it back.

use crate::message::ToDevice;

/// The most one frame may decompress to.
pub const MAX_DECOMPRESSED: usize = 8 * 1024 * 1024;

/// The largest decoding window, as a power of two (8 MiB).
pub const WINDOW_LOG_MAX: u32 = 23;

/// The most compressed bytes one snapshot message carries, leaving room in a
/// 1 MiB message for its other fields.
pub const SNAPSHOT_PART_LEN: usize = 1024 * 1024 - 1024;

/// zstd's default level: fast, and plenty for terminal output.
const LEVEL: i32 = 3;

/// Why bytes couldn't be compressed or decompressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompressError {
    /// More than [`MAX_DECOMPRESSED`] bytes, stated or found.
    TooBig,
    /// The frame doesn't state its content size.
    NoContentSize,
    /// Not exactly one valid zstd frame, or a window over the limit.
    Malformed,
    /// Snapshot parts that don't fit together.
    PartsMismatch,
}

/// Compress `bytes` into one frame with its content size.
///
/// # Errors
/// [`CompressError::TooBig`] over [`MAX_DECOMPRESSED`], which no decoder would
/// take.
pub fn compress(bytes: &[u8]) -> Result<Vec<u8>, CompressError> {
    use zstd::zstd_safe::CParameter;
    if bytes.len() > MAX_DECOMPRESSED {
        return Err(CompressError::TooBig);
    }
    let mut compressor =
        zstd::bulk::Compressor::new(LEVEL).map_err(|_| CompressError::Malformed)?;
    compressor
        .set_parameter(CParameter::ContentSizeFlag(true))
        .map_err(|_| CompressError::Malformed)?;
    compressor
        .compress(bytes)
        .map_err(|_| CompressError::Malformed)
}

/// Decompress one frame, refusing anything a decoder shouldn't trust.
///
/// # Errors
/// A [`CompressError`]; treat it as a protocol error and resync.
pub fn decompress(frame: &[u8]) -> Result<Vec<u8>, CompressError> {
    use zstd::zstd_safe::{self, DParameter};
    let stated = zstd_safe::get_frame_content_size(frame)
        .map_err(|_| CompressError::Malformed)?
        .ok_or(CompressError::NoContentSize)?;
    let size = usize::try_from(stated).map_err(|_| CompressError::TooBig)?;
    if size > MAX_DECOMPRESSED {
        return Err(CompressError::TooBig);
    }
    // Exactly one frame: a second one would go past the stated size.
    let first_frame =
        zstd_safe::find_frame_compressed_size(frame).map_err(|_| CompressError::Malformed)?;
    if first_frame != frame.len() {
        return Err(CompressError::Malformed);
    }
    let mut decompressor = zstd::bulk::Decompressor::new().map_err(|_| CompressError::Malformed)?;
    decompressor
        .set_parameter(DParameter::WindowLogMax(WINDOW_LOG_MAX))
        .map_err(|_| CompressError::Malformed)?;
    let bytes = decompressor
        .decompress(frame, size)
        .map_err(|_| CompressError::Malformed)?;
    if bytes.len() == size {
        Ok(bytes)
    } else {
        Err(CompressError::Malformed)
    }
}

/// The fields every snapshot message carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotHead {
    pub run: u64,
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
    pub skipped: bool,
}

/// The messages that carry a compressed snapshot: one `Snapshot`, or
/// `SnapshotPart`s of at most [`SNAPSHOT_PART_LEN`] bytes each.
#[must_use]
pub fn snapshot_messages(head: SnapshotHead, compressed: &[u8]) -> Vec<ToDevice> {
    let SnapshotHead {
        run,
        seq,
        cols,
        rows,
        skipped,
    } = head;
    if compressed.len() <= SNAPSHOT_PART_LEN {
        return vec![ToDevice::Snapshot {
            run,
            seq,
            cols,
            rows,
            bytes: compressed.to_vec(),
            skipped,
        }];
    }
    let chunks = compressed.chunks(SNAPSHOT_PART_LEN);
    // At most 8 MiB / ~1 MiB parts, so the count always fits.
    let count = u32::try_from(chunks.len()).unwrap_or(u32::MAX);
    chunks
        .zip(0..)
        .map(|(bytes, index)| ToDevice::SnapshotPart {
            run,
            seq,
            cols,
            rows,
            skipped,
            index,
            count,
            bytes: bytes.to_vec(),
        })
        .collect()
}

/// A device joining `SnapshotPart`s back into one compressed snapshot.
#[derive(Debug, Default)]
pub struct SnapshotParts {
    head: Option<SnapshotHead>,
    count: u32,
    bytes: Vec<u8>,
    next: u32,
}

impl SnapshotParts {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add part `index` of `count`. Returns the snapshot's head and its
    /// compressed bytes once the last part is in.
    ///
    /// # Errors
    /// [`CompressError::PartsMismatch`] for a part out of order or from another
    /// snapshot, and [`CompressError::TooBig`] past [`MAX_DECOMPRESSED`]
    /// compressed bytes. Start over with a `Resync`.
    pub fn add(
        &mut self,
        head: SnapshotHead,
        index: u32,
        count: u32,
        bytes: &[u8],
    ) -> Result<Option<(SnapshotHead, Vec<u8>)>, CompressError> {
        let follows_on = if index == 0 {
            *self = Self {
                head: Some(head),
                count,
                bytes: Vec::new(),
                next: 0,
            };
            true
        } else {
            self.head == Some(head) && self.count == count && self.next == index
        };
        if !follows_on || index >= count {
            *self = Self::default();
            return Err(CompressError::PartsMismatch);
        }
        if self.bytes.len().saturating_add(bytes.len()) > MAX_DECOMPRESSED {
            *self = Self::default();
            return Err(CompressError::TooBig);
        }
        self.bytes.extend_from_slice(bytes);
        self.next = index + 1;
        if self.next < count {
            return Ok(None);
        }
        let done = std::mem::take(self);
        Ok(done.head.map(|head| (head, done.bytes)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(len: usize) -> Vec<u8> {
        (0..len)
            .map(|i| b"\x1b[1mhello world\r\n"[i % 17])
            .collect()
    }

    const HEAD: SnapshotHead = SnapshotHead {
        run: 1,
        seq: 2,
        cols: 80,
        rows: 24,
        skipped: false,
    };

    #[test]
    fn output_comes_back_as_it_went() {
        let bytes = screen(50_000);
        let frame = compress(&bytes).expect("compresses");
        assert!(frame.len() < bytes.len());
        assert_eq!(decompress(&frame), Ok(bytes));
    }

    #[test]
    fn the_frame_states_its_content_size() {
        let frame = compress(&screen(1000)).expect("compresses");
        assert_eq!(
            zstd::zstd_safe::get_frame_content_size(&frame).ok(),
            Some(Some(1000))
        );
    }

    #[test]
    fn nothing_over_the_cap_is_compressed() {
        assert_eq!(
            compress(&vec![0; MAX_DECOMPRESSED + 1]),
            Err(CompressError::TooBig)
        );
        assert!(compress(&vec![0; MAX_DECOMPRESSED]).is_ok());
    }

    #[test]
    fn a_small_frame_that_unpacks_past_the_cap_is_refused() {
        // A zstd bomb: 64 MiB of zeros packs into a few kilobytes.
        let mut c = zstd::bulk::Compressor::new(LEVEL).expect("compressor");
        let bomb = c.compress(&vec![0; 64 * 1024 * 1024]).expect("compresses");
        assert!(bomb.len() < 64 * 1024);
        assert_eq!(decompress(&bomb), Err(CompressError::TooBig));
    }

    #[test]
    fn a_frame_without_its_content_size_is_refused() {
        let frame = zstd::stream::encode_all(&screen(1000)[..], LEVEL).expect("encodes");
        assert_eq!(
            zstd::zstd_safe::get_frame_content_size(&frame).ok(),
            Some(None),
            "a streamed frame doesn't know its size"
        );
        assert_eq!(decompress(&frame), Err(CompressError::NoContentSize));
    }

    #[test]
    fn a_second_frame_or_trailing_bytes_are_refused() {
        let frame = compress(&screen(1000)).expect("compresses");
        let mut two = frame.clone();
        two.extend_from_slice(&frame);
        assert_eq!(decompress(&two), Err(CompressError::Malformed));
        let mut trailing = frame;
        trailing.push(0);
        assert_eq!(decompress(&trailing), Err(CompressError::Malformed));
    }

    #[test]
    fn bytes_that_are_not_a_frame_are_refused() {
        assert_eq!(
            decompress(b"not zstd at all"),
            Err(CompressError::Malformed)
        );
        assert_eq!(decompress(&[]), Err(CompressError::Malformed));
    }

    #[test]
    fn a_small_snapshot_is_one_message() {
        let messages = snapshot_messages(HEAD, b"frame");
        assert_eq!(
            messages,
            [ToDevice::Snapshot {
                run: 1,
                seq: 2,
                cols: 80,
                rows: 24,
                bytes: b"frame".to_vec(),
                skipped: false,
            }]
        );
    }

    #[test]
    fn a_big_snapshot_goes_in_parts_that_join_back() {
        let compressed: Vec<u8> = (0..SNAPSHOT_PART_LEN * 2 + 10)
            .map(|i| u8::try_from(i % 251).expect("small"))
            .collect();
        let messages = snapshot_messages(HEAD, &compressed);
        assert_eq!(messages.len(), 3);
        let mut parts = SnapshotParts::new();
        let mut done = None;
        for message in messages {
            let ToDevice::SnapshotPart {
                run,
                seq,
                cols,
                rows,
                skipped,
                index,
                count,
                bytes,
            } = message
            else {
                panic!("parts only");
            };
            assert!(bytes.len() <= SNAPSHOT_PART_LEN);
            let head = SnapshotHead {
                run,
                seq,
                cols,
                rows,
                skipped,
            };
            done = parts.add(head, index, count, &bytes).expect("fits");
        }
        assert_eq!(done, Some((HEAD, compressed)));
    }

    #[test]
    fn parts_out_of_order_or_from_another_snapshot_are_refused() {
        let mut parts = SnapshotParts::new();
        assert_eq!(
            parts.add(HEAD, 1, 3, b"x"),
            Err(CompressError::PartsMismatch)
        );
        let mut parts = SnapshotParts::new();
        parts.add(HEAD, 0, 3, b"x").expect("first");
        let other = SnapshotHead { seq: 3, ..HEAD };
        assert_eq!(
            parts.add(other, 1, 3, b"x"),
            Err(CompressError::PartsMismatch)
        );
        let mut parts = SnapshotParts::new();
        parts.add(HEAD, 0, 3, b"x").expect("first");
        assert_eq!(
            parts.add(HEAD, 1, 4, b"x"),
            Err(CompressError::PartsMismatch)
        );
    }

    #[test]
    fn parts_past_the_cap_are_refused() {
        let mut parts = SnapshotParts::new();
        let big = vec![0; SNAPSHOT_PART_LEN];
        let mut result = Ok(None);
        for index in 0..20 {
            result = parts.add(HEAD, index, 20, &big);
            if result.is_err() {
                break;
            }
        }
        assert_eq!(result, Err(CompressError::TooBig));
    }
}
