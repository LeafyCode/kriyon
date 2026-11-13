//! The messages of the remote protocol (spec §4–§9), one enum per direction
//! and ALPN.
//!
//! On the wire a message is its postcard encoding: the variant's position as
//! a varint (the tag), then its fields. So **variants are only ever appended**,
//! never reordered or removed, and fields are only appended at the end of a
//! variant (spec §3). The golden tests below pin every tag.

use kriyon_core::session::SessionStatus;
use serde::{Deserialize, Serialize};

/// A [Session]'s id, as the host names it.
pub type SessionId = String;

/// A [Remote device]'s or [Host]'s iroh endpoint id: its Ed25519 public key.
pub type EndpointId = [u8; 32];

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

/// One session as a device sees it in a list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: SessionId,
    pub title: String,
    pub project: String,
    pub status: SessionStatus,
    /// On the Needs-you list.
    pub needs_you: bool,
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
    SessionStatus {
        session_id: SessionId,
        status: SessionStatus,
        needs_you: bool,
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
    Paired { host_name: String },
    Refused { reason: RefuseReason },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag<T: Serialize>(message: &T) -> u8 {
        postcard::to_allocvec(message).expect("encodes")[0]
    }

    const EPOCH: Epoch = Epoch {
        host_boot_id: 1,
        counter: 2,
    };

    /// The tag of every message is part of the protocol: a reorder must fail
    /// here, not on a phone.
    #[test]
    fn device_to_host_tags_are_fixed() {
        let s = || "s".to_string();
        let cases: [(FromDevice, u8); 10] = [
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
        ];
        for (message, expected) in cases {
            assert_eq!(tag(&message), expected, "{message:?}");
        }
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
            (
                ToDevice::SessionStatus {
                    session_id: s(),
                    status: SessionStatus::Idle,
                    needs_you: false,
                },
                3,
            ),
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
