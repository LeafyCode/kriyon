//! A record nested inside a message that can still grow (spec §3): its
//! postcard bytes go on the wire with their length first, so a reader skips
//! fields it doesn't know and fills fields an older writer didn't send.
//!
//! Use it with serde's `with`: `#[serde(with = "crate::nested::one")]` on one
//! record, `#[serde(with = "crate::nested::list")]` on a list of them.
//!
//! - An older reader decodes the fields it knows and skips the rest of the
//!   record's bytes.
//! - A newer reader of an older writer's record decodes it as if it went on
//!   with zero bytes, so each missing field comes out as its zero: `None`,
//!   `false`, `0`, an empty `String` or `Vec`, an enum's tag-0 variant. A field
//!   appended to a nested record must mean "unknown" or "none" at that zero.
//! - A list item this reader can't read at all (an enum variant newer than
//!   it) is left out of the list; the rest of the message still counts. A
//!   single record it can't read is an error.
//!
//! A record cut short inside a field reads that field on into the zeros too;
//! the length in front bounds it, and nothing a host checks for safety is
//! read from a nested record.

use std::fmt;
use std::marker::PhantomData;

use serde::de::{DeserializeOwned, SeqAccess, Visitor};
use serde::{Deserializer, Serialize, Serializer};

/// Zero bytes a record from an older writer may be read past its end: more
/// than all the fields any later version appends.
const PAD: usize = 256;

/// One record's bytes, as written.
fn encode<T: Serialize, S: Serializer>(record: &T) -> Result<Vec<u8>, S::Error> {
    postcard::to_allocvec(record).map_err(serde::ser::Error::custom)
}

/// One record from its bytes: what it doesn't know of is skipped, what it
/// lacks is read as zero.
fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, postcard::Error> {
    match postcard::from_bytes(bytes) {
        Err(postcard::Error::DeserializeUnexpectedEnd) => {
            let mut padded = Vec::with_capacity(bytes.len() + PAD);
            padded.extend_from_slice(bytes);
            padded.resize(bytes.len() + PAD, 0);
            postcard::from_bytes(&padded)
        }
        decoded => decoded,
    }
}

/// A record's bytes, length first.
struct Bytes(Vec<u8>);

impl<'de> serde::Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Seen;
        impl Visitor<'_> for Seen {
            type Value = Bytes;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a nested record's bytes")
            }
            fn visit_bytes<E: serde::de::Error>(self, bytes: &[u8]) -> Result<Bytes, E> {
                Ok(Bytes(bytes.to_vec()))
            }
            fn visit_byte_buf<E: serde::de::Error>(self, bytes: Vec<u8>) -> Result<Bytes, E> {
                Ok(Bytes(bytes))
            }
        }
        deserializer.deserialize_bytes(Seen)
    }
}

/// `#[serde(with)]` for one nested record.
pub mod one {
    use super::{decode, encode, Bytes, DeserializeOwned, Deserializer, Serialize, Serializer};
    use serde::de::Error as _;
    use serde::Deserialize as _;

    /// # Errors
    /// When the record can't be encoded.
    pub fn serialize<T: Serialize, S: Serializer>(record: &T, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(&encode::<T, S>(record)?)
    }

    /// # Errors
    /// When the bytes aren't a record, even read as going on with zeros.
    pub fn deserialize<'de, T: DeserializeOwned, D: Deserializer<'de>>(
        d: D,
    ) -> Result<T, D::Error> {
        let Bytes(bytes) = Bytes::deserialize(d)?;
        decode(&bytes).map_err(D::Error::custom)
    }
}

/// `#[serde(with)]` for a list of nested records.
pub mod list {
    use super::{
        decode, encode, fmt, Bytes, DeserializeOwned, Deserializer, PhantomData, SeqAccess,
        Serialize, Serializer, Visitor,
    };
    use serde::ser::SerializeSeq;

    /// # Errors
    /// When a record can't be encoded.
    pub fn serialize<T: Serialize, S: Serializer>(records: &[T], s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(records.len()))?;
        for record in records {
            seq.serialize_element(&Raw(encode::<T, S>(record)?))?;
        }
        seq.end()
    }

    /// Bytes that serialize as bytes, not as a list of numbers.
    struct Raw(Vec<u8>);

    impl Serialize for Raw {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            s.serialize_bytes(&self.0)
        }
    }

    /// An item that isn't a record this reader can read, even as going on
    /// with zeros, is left out.
    ///
    /// # Errors
    /// When the list itself isn't one.
    pub fn deserialize<'de, T: DeserializeOwned, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Vec<T>, D::Error> {
        struct Records<T>(PhantomData<T>);
        impl<'de, T: DeserializeOwned> Visitor<'de> for Records<T> {
            type Value = Vec<T>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a list of nested records")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<T>, A::Error> {
                // Never trust the stated length for the allocation.
                let mut records = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(64));
                // One a reader can't read (a variant newer than it) is left
                // out: the rest of the list, and the message, still count.
                while let Some(Bytes(bytes)) = seq.next_element()? {
                    if let Ok(record) = decode(&bytes) {
                        records.push(record);
                    }
                }
                Ok(records)
            }
        }
        d.deserialize_seq(Records(PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    /// A record as an older build has it.
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Before {
        id: String,
        count: u32,
    }

    /// An appended enum field: its tag 0 means "unknown".
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    enum Kind {
        Unknown,
        Big,
    }

    /// The same record after a later build appended fields.
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct After {
        id: String,
        count: u32,
        note: Option<String>,
        shown: bool,
        at_ms: u64,
        names: Vec<String>,
        kind: Kind,
    }

    /// A message holding nested records, with a field after them that must
    /// still read right.
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(bound = "T: Serialize + serde::de::DeserializeOwned")]
    struct Message<T> {
        #[serde(with = "super::list")]
        records: Vec<T>,
        #[serde(with = "super::one")]
        first: T,
        after: String,
    }

    fn after(id: &str) -> After {
        After {
            id: id.into(),
            count: 3,
            note: Some("hi".into()),
            shown: true,
            at_ms: 99,
            names: vec!["a".into()],
            kind: Kind::Big,
        }
    }

    fn before(id: &str) -> Before {
        Before {
            id: id.into(),
            count: 3,
        }
    }

    #[test]
    fn an_older_reader_skips_the_fields_a_newer_writer_appended() {
        let bytes = postcard::to_allocvec(&Message {
            records: vec![after("a"), after("b")],
            first: after("c"),
            after: "end".into(),
        })
        .expect("encode");
        let read: Message<Before> = postcard::from_bytes(&bytes).expect("decode");
        assert_eq!(
            read,
            Message {
                records: vec![before("a"), before("b")],
                first: before("c"),
                after: "end".into(),
            }
        );
    }

    #[test]
    fn a_newer_reader_reads_what_an_older_writer_left_out_as_zero() {
        let bytes = postcard::to_allocvec(&Message {
            records: vec![before("a")],
            first: before("c"),
            after: "end".into(),
        })
        .expect("encode");
        let read: Message<After> = postcard::from_bytes(&bytes).expect("decode");
        let zero = |id: &str| After {
            id: id.into(),
            count: 3,
            note: None,
            shown: false,
            at_ms: 0,
            names: vec![],
            kind: Kind::Unknown,
        };
        assert_eq!(
            read,
            Message {
                records: vec![zero("a")],
                first: zero("c"),
                after: "end".into(),
            }
        );
    }

    /// A record with an enum an older reader knows fewer variants of.
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    enum Shape {
        Unknown,
        Big,
        Round,
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Shaped {
        shape: Shape,
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    enum OldShape {
        Unknown,
        Big,
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct OldShaped {
        shape: OldShape,
    }

    #[test]
    fn a_list_item_a_reader_cannot_read_is_left_out_not_the_message() {
        let bytes = postcard::to_allocvec(&Message {
            records: vec![
                Shaped { shape: Shape::Big },
                // A variant newer than the reader.
                Shaped {
                    shape: Shape::Round,
                },
                Shaped {
                    shape: Shape::Unknown,
                },
            ],
            first: Shaped { shape: Shape::Big },
            after: "end".into(),
        })
        .expect("encode");
        let read: Message<OldShaped> = postcard::from_bytes(&bytes).expect("decode");
        assert_eq!(
            read,
            Message {
                records: vec![
                    OldShaped {
                        shape: OldShape::Big
                    },
                    OldShaped {
                        shape: OldShape::Unknown
                    },
                ],
                first: OldShaped {
                    shape: OldShape::Big
                },
                after: "end".into(),
            }
        );
    }

    #[test]
    fn a_record_is_its_length_then_its_bytes() {
        let bytes = postcard::to_allocvec(&Message {
            records: vec![before("a")],
            first: before("b"),
            after: String::new(),
        })
        .expect("encode");
        // One record: 3 bytes ("a" and 3); then "b" and 3; then "".
        assert_eq!(bytes, [1, 3, 1, b'a', 3, 3, 1, b'b', 3, 0]);
    }

    #[test]
    fn a_single_record_that_is_no_record_is_refused() {
        // The single record's name isn't UTF-8.
        let bytes = [1, 3, 1, b'a', 3, 3, 1, 0xff, 3, 0];
        assert!(postcard::from_bytes::<Message<Before>>(&bytes).is_err());
    }
}
