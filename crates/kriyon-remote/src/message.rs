//! The messages of the remote protocol (spec §4–§9), one enum per direction
//! and ALPN.
//!
//! On the wire a message is its postcard encoding: the variant's position as
//! a varint (the tag), then its fields. So **variants are only ever appended**,
//! never reordered or removed, and fields are only appended at the end of a
//! variant (spec §3). The golden tests below pin every tag.

use kriyon_core::session::SessionStatus;
use kriyon_core::standing::SessionListEntry;
pub use kriyon_core::standing::StandingState;
use serde::{Deserialize, Serialize};

/// A [Session]'s id, as the host names it.
pub type SessionId = String;

/// A [Remote device]'s or [Host]'s iroh endpoint id: its Ed25519 public key.
pub type EndpointId = [u8; 32];

/// Bytes as text, two lowercase hex digits a byte: an endpoint id as 64.
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut text, b| {
            let _ = write!(text, "{b:02x}");
            text
        })
}

/// The endpoint id `text` names: exactly 64 lowercase hex digits, nothing
/// else (it crossed from an app's screens).
#[must_use]
pub fn parse_id_hex(text: &str) -> Option<EndpointId> {
    let lower_hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    if text.len() != 64 || !text.bytes().all(lower_hex) {
        return None;
    }
    let mut id = [0_u8; 32];
    for (i, byte) in id.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(id)
}

/// A device's id for one `StartSession`, so a resend returns the same session.
pub type RequestId = [u8; 16];

/// What a [Paired device] may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    /// Sees screens and status; never sends input.
    Viewer,
    /// Can do anything the person can in a terminal.
    Controller,
}

/// The [Typing control] epoch of one session: random per app start, then a
/// counter, so a value never repeats across restarts (spec §7).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Epoch {
    pub host_boot_id: u64,
    pub counter: u64,
}

/// Who holds [Typing control] of a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Holder {
    /// The person at the host's own keyboard.
    Host,
    /// A remote device, by its endpoint id.
    Device(EndpointId),
}

/// One session as a device sees it: the host's [Session list] entry, field
/// for field, so a device shows the same standing as the desktop (never
/// "Idle" where the desktop says "Unknown").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: SessionId,
    pub title: String,
    pub project_id: String,
    pub status: SessionStatus,
    pub standing: StandingState,
    /// On the Needs-you list.
    pub needs_you: bool,
    /// A CLI dialog shows.
    pub dialog_open: bool,
    /// Unix milliseconds.
    pub last_change_ms: i64,
}

impl From<SessionListEntry> for SessionInfo {
    fn from(entry: SessionListEntry) -> Self {
        let SessionListEntry {
            id,
            title,
            project_id,
            status,
            standing,
            needs_you,
            dialog_open,
            last_change_ms,
        } = entry;
        Self {
            id,
            title,
            project_id,
            status,
            standing,
            needs_you,
            dialog_open,
            last_change_ms,
        }
    }
}

/// Why the host refused a message (spec §8).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RefuseReason {
    NotPaired,
    NoSuchSession,
    /// The device's role may not send this, or it came on the wrong stream.
    NotAllowed,
    /// The device doesn't hold, or can't take, [Typing control].
    NotInControl,
    /// Old run or epoch, or a dialog changed after `seen_seq`.
    Stale,
    /// A size or length outside its bounds.
    OutOfRange,
    /// `Compose` while a CLI dialog shows.
    DialogOpen,
    /// The project's folder isn't inside an approved root.
    FolderNotAllowed,
    UnknownMessage,
    /// The device speaks an older protocol minor than the host accepts.
    TooOld {
        min_minor: u16,
    },
    /// `StartSession` names a project the host doesn't have.
    NoSuchProject,
    /// `Open` of a session whose screen is too big to send.
    ScreenTooLarge,
}

/// Device to host on `kriyon/remote/1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FromDevice {
    /// Control stream, first message.
    Hello {
        app_version: String,
        protocol_minor: u16,
    },
    /// First message on a new session stream.
    Open { session_id: SessionId },
    /// Session stream: send a fresh snapshot.
    Resync,
    /// Session stream: send readable-view entries (format to come).
    RequestEntries,
    /// Control stream.
    TakeControl { session_id: SessionId },
    /// Session stream.
    Input {
        run: u64,
        epoch: Epoch,
        seen_seq: u64,
        bytes: Vec<u8>,
    },
    /// Session stream.
    Compose {
        run: u64,
        epoch: Epoch,
        seen_seq: u64,
        text: String,
    },
    /// Session stream.
    Resize {
        run: u64,
        epoch: Epoch,
        cols: u16,
        rows: u16,
    },
    /// Control stream.
    StartSession {
        request_id: RequestId,
        project_id: String,
        title: Option<String>,
        worktree: bool,
    },
    /// Control stream.
    PushToken { sealed: Vec<u8> },
}

/// The kind of a [`FromDevice`] message; its number is the message's tag on
/// the wire (pinned by test), so limits can name kinds, not numbers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FromDeviceKind {
    Hello = 0,
    Open = 1,
    Resync = 2,
    RequestEntries = 3,
    TakeControl = 4,
    Input = 5,
    Compose = 6,
    Resize = 7,
    StartSession = 8,
    PushToken = 9,
}

impl FromDeviceKind {
    const ALL: [Self; 10] = [
        Self::Hello,
        Self::Open,
        Self::Resync,
        Self::RequestEntries,
        Self::TakeControl,
        Self::Input,
        Self::Compose,
        Self::Resize,
        Self::StartSession,
        Self::PushToken,
    ];

    /// The kind with wire tag `tag`, if this side knows it.
    #[must_use]
    pub fn from_tag(tag: u32) -> Option<Self> {
        usize::try_from(tag)
            .ok()
            .and_then(|i| Self::ALL.get(i).copied())
    }
}

impl FromDevice {
    /// This message's kind.
    #[must_use]
    pub fn kind(&self) -> FromDeviceKind {
        match self {
            Self::Hello { .. } => FromDeviceKind::Hello,
            Self::Open { .. } => FromDeviceKind::Open,
            Self::Resync => FromDeviceKind::Resync,
            Self::RequestEntries => FromDeviceKind::RequestEntries,
            Self::TakeControl { .. } => FromDeviceKind::TakeControl,
            Self::Input { .. } => FromDeviceKind::Input,
            Self::Compose { .. } => FromDeviceKind::Compose,
            Self::Resize { .. } => FromDeviceKind::Resize,
            Self::StartSession { .. } => FromDeviceKind::StartSession,
            Self::PushToken { .. } => FromDeviceKind::PushToken,
        }
    }
}

/// Host to device on `kriyon/remote/1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToDevice {
    Welcome {
        host_name: String,
        protocol_minor: u16,
        role: Role,
        sessions: Vec<SessionInfo>,
    },
    /// `at` is Unix milliseconds.
    Heartbeat {
        seq: u64,
        at: u64,
    },
    SessionList {
        sessions: Vec<SessionInfo>,
    },
    /// One session's entry changed.
    SessionStatus {
        session: SessionInfo,
    },
    Control {
        session_id: SessionId,
        holder: Holder,
        epoch: Epoch,
    },
    /// `bytes` is one zstd frame of the [Screen snapshot].
    Snapshot {
        run: u64,
        seq: u64,
        cols: u16,
        rows: u16,
        bytes: Vec<u8>,
        skipped: bool,
    },
    /// One numbered part of a snapshot over 1 MiB compressed. Every part
    /// carries the snapshot's fields; `bytes` joined in `index` order is the
    /// zstd frame.
    SnapshotPart {
        run: u64,
        seq: u64,
        cols: u16,
        rows: u16,
        skipped: bool,
        index: u32,
        count: u32,
        bytes: Vec<u8>,
    },
    /// `bytes` is one zstd frame of output.
    Update {
        run: u64,
        seq: u64,
        bytes: Vec<u8>,
    },
    /// The bytes reached the PTY (`written`), not that Claude acted on them.
    InputAck {
        epoch: Epoch,
        written: bool,
    },
    StartResult {
        request_id: RequestId,
        session_id: SessionId,
    },
    Refused {
        reason: RefuseReason,
    },
}

/// Device to host on `kriyon/pair/1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairFromDevice {
    /// `proof` is `HMAC-SHA256(secret, "kriyon pair v1" || device_id || host_id)`.
    PairRequest {
        device_name: String,
        proof: [u8; 32],
    },
}

/// Host to device on `kriyon/pair/1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairToDevice {
    Paired {
        host_name: String,
    },
    Refused {
        reason: RefuseReason,
    },
    /// The proof is right and this device took the pairing: show the code.
    /// A device shows no code before this, so one that lost the race to a
    /// leaked QR code says pairing failed instead.
    ProofAccepted,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_endpoint_id_is_sixty_four_lowercase_hex_digits() {
        let id = [0xab; 32];
        let text = hex(&id);
        assert_eq!(text, "ab".repeat(32));
        assert_eq!(parse_id_hex(&text), Some(id));
        for bad in [
            String::new(),
            "ab".repeat(31),
            "ab".repeat(33),
            "AB".repeat(32),
            "zz".repeat(32),
            format!("{}é", "a".repeat(62)),
            "../".repeat(21) + "a",
        ] {
            assert!(parse_id_hex(&bad).is_none(), "{bad:?}");
        }
    }

    fn tag<T: Serialize>(message: &T) -> u8 {
        postcard::to_allocvec(message).expect("encodes")[0]
    }

    const EPOCH: Epoch = Epoch {
        host_boot_id: 1,
        counter: 2,
    };

    fn info() -> SessionInfo {
        SessionInfo {
            id: "s".into(),
            title: "t".into(),
            project_id: "p".into(),
            status: SessionStatus::Idle,
            standing: StandingState::Unknown,
            needs_you: false,
            dialog_open: false,
            last_change_ms: 0,
        }
    }

    /// A device shows what the desktop's list shows, field for field.
    #[test]
    fn a_session_entry_reaches_the_device_whole() {
        let entry = SessionListEntry {
            id: "s1".into(),
            title: "Fix login".into(),
            project_id: "p1".into(),
            status: SessionStatus::Waiting,
            standing: StandingState::AwaitingInput,
            needs_you: true,
            dialog_open: true,
            last_change_ms: 1_700_000_000_000,
        };
        let sent = SessionInfo::from(entry);
        assert_eq!(
            sent,
            SessionInfo {
                id: "s1".into(),
                title: "Fix login".into(),
                project_id: "p1".into(),
                status: SessionStatus::Waiting,
                standing: StandingState::AwaitingInput,
                needs_you: true,
                dialog_open: true,
                last_change_ms: 1_700_000_000_000,
            }
        );
    }

    /// The codec's limits name message kinds; each kind is the tag on the wire.
    #[test]
    fn every_device_message_kind_is_its_tag() {
        for (message, _) in device_samples() {
            assert_eq!(
                u32::from(tag(&message)),
                message.kind() as u32,
                "{message:?}"
            );
            assert_eq!(
                FromDeviceKind::from_tag(message.kind() as u32),
                Some(message.kind())
            );
        }
        assert_eq!(FromDeviceKind::from_tag(99), None);
    }

    /// The tag of every message is part of the protocol: a reorder must fail
    /// here, not on a phone.
    #[test]
    fn device_to_host_tags_are_fixed() {
        for (message, expected) in device_samples() {
            assert_eq!(tag(&message), expected, "{message:?}");
        }
    }

    fn device_samples() -> [(FromDevice, u8); 10] {
        let s = || "s".to_string();
        [
            (
                FromDevice::Hello {
                    app_version: s(),
                    protocol_minor: 0,
                },
                0,
            ),
            (FromDevice::Open { session_id: s() }, 1),
            (FromDevice::Resync, 2),
            (FromDevice::RequestEntries, 3),
            (FromDevice::TakeControl { session_id: s() }, 4),
            (
                FromDevice::Input {
                    run: 0,
                    epoch: EPOCH,
                    seen_seq: 0,
                    bytes: vec![],
                },
                5,
            ),
            (
                FromDevice::Compose {
                    run: 0,
                    epoch: EPOCH,
                    seen_seq: 0,
                    text: s(),
                },
                6,
            ),
            (
                FromDevice::Resize {
                    run: 0,
                    epoch: EPOCH,
                    cols: 80,
                    rows: 24,
                },
                7,
            ),
            (
                FromDevice::StartSession {
                    request_id: [0; 16],
                    project_id: s(),
                    title: None,
                    worktree: false,
                },
                8,
            ),
            (FromDevice::PushToken { sealed: vec![] }, 9),
        ]
    }

    #[test]
    fn host_to_device_tags_are_fixed() {
        let s = || "s".to_string();
        let cases: [(ToDevice, u8); 11] = [
            (
                ToDevice::Welcome {
                    host_name: s(),
                    protocol_minor: 0,
                    role: Role::Viewer,
                    sessions: vec![],
                },
                0,
            ),
            (ToDevice::Heartbeat { seq: 0, at: 0 }, 1),
            (ToDevice::SessionList { sessions: vec![] }, 2),
            (ToDevice::SessionStatus { session: info() }, 3),
            (
                ToDevice::Control {
                    session_id: s(),
                    holder: Holder::Host,
                    epoch: EPOCH,
                },
                4,
            ),
            (
                ToDevice::Snapshot {
                    run: 0,
                    seq: 0,
                    cols: 80,
                    rows: 24,
                    bytes: vec![],
                    skipped: false,
                },
                5,
            ),
            (
                ToDevice::SnapshotPart {
                    run: 0,
                    seq: 0,
                    cols: 80,
                    rows: 24,
                    skipped: false,
                    index: 0,
                    count: 1,
                    bytes: vec![],
                },
                6,
            ),
            (
                ToDevice::Update {
                    run: 0,
                    seq: 0,
                    bytes: vec![],
                },
                7,
            ),
            (
                ToDevice::InputAck {
                    epoch: EPOCH,
                    written: true,
                },
                8,
            ),
            (
                ToDevice::StartResult {
                    request_id: [0; 16],
                    session_id: s(),
                },
                9,
            ),
            (
                ToDevice::Refused {
                    reason: RefuseReason::Stale,
                },
                10,
            ),
        ];
        for (message, expected) in cases {
            assert_eq!(tag(&message), expected, "{message:?}");
        }
    }

    #[test]
    fn pairing_tags_are_fixed() {
        let request = PairFromDevice::PairRequest {
            device_name: "phone".into(),
            proof: [0; 32],
        };
        assert_eq!(tag(&request), 0);
        let paired = PairToDevice::Paired {
            host_name: "mac".into(),
        };
        assert_eq!(tag(&paired), 0);
        let refused = PairToDevice::Refused {
            reason: RefuseReason::NotPaired,
        };
        assert_eq!(tag(&refused), 1);
        assert_eq!(tag(&PairToDevice::ProofAccepted), 2);
    }

    /// Reasons and statuses are fields, so their order is on the wire too.
    #[test]
    fn reason_status_role_and_holder_numbers_are_fixed() {
        let reasons = [
            RefuseReason::NotPaired,
            RefuseReason::NoSuchSession,
            RefuseReason::NotAllowed,
            RefuseReason::NotInControl,
            RefuseReason::Stale,
            RefuseReason::OutOfRange,
            RefuseReason::DialogOpen,
            RefuseReason::FolderNotAllowed,
            RefuseReason::UnknownMessage,
            RefuseReason::TooOld { min_minor: 0 },
            RefuseReason::NoSuchProject,
            RefuseReason::ScreenTooLarge,
        ];
        for (n, reason) in reasons.iter().enumerate() {
            assert_eq!(usize::from(tag(reason)), n, "{reason:?}");
        }
        let statuses = [
            SessionStatus::Idle,
            SessionStatus::Running,
            SessionStatus::Waiting,
            SessionStatus::Done,
            SessionStatus::Error,
        ];
        for (n, status) in statuses.iter().enumerate() {
            assert_eq!(usize::from(tag(status)), n, "{status:?}");
        }
        let standings = [
            StandingState::Running,
            StandingState::AwaitingInput,
            StandingState::Changed,
            StandingState::Idle,
            StandingState::Unknown,
        ];
        for (n, standing) in standings.iter().enumerate() {
            assert_eq!(usize::from(tag(standing)), n, "{standing:?}");
        }
        assert_eq!(tag(&Role::Viewer), 0);
        assert_eq!(tag(&Role::Controller), 1);
        assert_eq!(tag(&Holder::Host), 0);
        assert_eq!(tag(&Holder::Device([0; 32])), 1);
    }

    #[test]
    fn every_message_comes_back_as_it_went() {
        let message = FromDevice::Input {
            run: u64::MAX,
            epoch: EPOCH,
            seen_seq: 300,
            bytes: b"y\r".to_vec(),
        };
        let bytes = postcard::to_allocvec(&message).expect("encodes");
        assert_eq!(postcard::from_bytes::<FromDevice>(&bytes), Ok(message));
    }
}
