//! The messages of the remote protocol (spec §4–§9), one enum per direction
//! and ALPN.
//!
//! On the wire a message is its postcard encoding: the variant's position as
//! a varint (the tag), then its fields. So **variants are only ever appended**,
//! never reordered or removed, and fields are only appended at the end of a
//! variant (spec §3). The golden tests below pin every tag.

use kriyon_core::session::SessionStatus;
use kriyon_core::session_digest::SessionDigest;
pub use kriyon_core::session_digest::{Diff, Question};
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
    /// The rest is its [Session digest], for a device's Home: each `None`
    /// when it doesn't apply now or isn't known. Claude's question while
    /// the dialog shows.
    pub question: Option<Question>,
    /// "<Tool> · <target>", while running.
    pub activity: Option<String>,
    /// When the running turn began (Unix ms).
    pub running_since_ms: Option<i64>,
    /// How the last turn ended, in a line or two.
    pub turn_summary: Option<String>,
    /// What the last turn changed.
    pub diff: Option<Diff>,
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
            digest,
        } = entry;
        let SessionDigest {
            question,
            activity,
            running_since_ms,
            turn_summary,
            diff,
        } = digest;
        Self {
            id,
            title,
            project_id,
            status,
            standing,
            needs_you,
            dialog_open,
            last_change_ms,
            question,
            activity,
            running_since_ms,
            turn_summary,
            diff,
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
    /// `StartSession` was allowed, but the session couldn't be started (its
    /// shell didn't open).
    StartFailed,
}

/// The protocol minor this side speaks: the host sends it in `Welcome`,
/// a device in `Hello`.
pub const PROTOCOL_MINOR: u16 = 0;

/// The oldest protocol minor a host accepts in `Hello`.
pub const MIN_PROTOCOL_MINOR: u16 = 0;

/// The longest an `Input` or `Compose` message may be, tag included (the
/// codec's limit for them; spec §3).
pub const MAX_INPUT_MESSAGE: usize = 64 * 1024;

/// The most typing one `Input` carries: its message's limit less what its
/// other fields can take (five varints of at most 10 bytes, the tag, and the
/// bytes' length).
pub const MAX_INPUT_BYTES: usize = MAX_INPUT_MESSAGE - 64;

/// A project on the host, as a device's project picker shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    /// Every session in it is parked: put away on the host for now.
    pub parked: bool,
}

/// Device to host on `kriyon/remote/1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FromDevice {
    /// Control stream, first message.
    Hello {
        app_version: String,
        protocol_minor: u16,
    },
    /// First message on a new session stream. `screen: false` opens it for
    /// [Readable view] entries only: no snapshot or updates until `Screen {
    /// on: true }`; it still counts as an onlooker (spec §6).
    Open { session_id: SessionId, screen: bool },
    /// Session stream: send a fresh snapshot.
    Resync,
    /// Session stream: send [Readable view] entries, and keep sending them
    /// (spec §6). `since`, the highest `seq` the device has, is not trusted
    /// now: the host sends the window with a reset.
    RequestEntries { since: u64 },
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
    /// Control stream. `key_id` names the push sender's key `sealed` was
    /// sealed to (spec §10), so the sender can rotate keys.
    PushToken { key_id: u32, sealed: Vec<u8> },
    /// Session stream: stop sending [Readable view] entries; the screen
    /// goes on (spec §6).
    StopEntries,
    /// Session stream: send the screen (a snapshot, then updates) or stop
    /// sending it; the stream and its entries go on (spec §6).
    Screen { on: bool },
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
    StopEntries = 10,
    Screen = 11,
}

impl FromDeviceKind {
    const ALL: [Self; 12] = [
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
        Self::StopEntries,
        Self::Screen,
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
            Self::RequestEntries { .. } => FromDeviceKind::RequestEntries,
            Self::TakeControl { .. } => FromDeviceKind::TakeControl,
            Self::Input { .. } => FromDeviceKind::Input,
            Self::Compose { .. } => FromDeviceKind::Compose,
            Self::Resize { .. } => FromDeviceKind::Resize,
            Self::StartSession { .. } => FromDeviceKind::StartSession,
            Self::PushToken { .. } => FromDeviceKind::PushToken,
            Self::StopEntries => FromDeviceKind::StopEntries,
            Self::Screen { .. } => FromDeviceKind::Screen,
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
        #[serde(with = "crate::nested::list")]
        sessions: Vec<SessionInfo>,
    },
    /// `at` is Unix milliseconds.
    Heartbeat {
        seq: u64,
        at: u64,
    },
    SessionList {
        #[serde(with = "crate::nested::list")]
        sessions: Vec<SessionInfo>,
    },
    /// One session's entry changed.
    SessionStatus {
        #[serde(with = "crate::nested::one")]
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
    /// A `StartSession` refused, or that failed: named by its request, so a
    /// device with several starts, or other refusals, under way can tell.
    StartRefused {
        request_id: RequestId,
        reason: RefuseReason,
    },
    /// Control stream, after `Welcome` and whenever it changes: the host's
    /// projects, where a Controller may start a session.
    ProjectList {
        projects: Vec<ProjectInfo>,
    },
    /// Session stream, after `RequestEntries`: [Readable view] entries, new
    /// or changed. `reset`: drop every entry you have first (spec §6).
    Entries {
        #[serde(with = "crate::nested::list")]
        entries: Vec<Entry>,
        reset: bool,
        /// The lowest `seq` still in the host's window, past the "older in
        /// the terminal" note (seq 0): drop what you have below it.
        from: u64,
    },
    /// Session stream: no entries can be sent for this session; show the
    /// terminal.
    EntriesUnavailable {
        reason: EntriesUnavailable,
    },
    /// Control stream, after `Welcome` and whenever it changes: the host's
    /// [Plan limits], as its desktop shows them.
    Usage {
        #[serde(with = "crate::nested::one")]
        usage: PlanUsage,
    },
}

/// The host account's [Plan limits]: each window's use, `None` when Claude
/// hasn't reported it (or it reset since). A nested record (spec §3).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanUsage {
    pub five_hour: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
}

impl From<&kriyon_core::plan_limits::PlanLimits> for PlanUsage {
    /// As the desktop shows them: a whole percent, 0 to 100.
    fn from(limits: &kriyon_core::plan_limits::PlanLimits) -> Self {
        let window = |window: Option<kriyon_core::plan_limits::LimitWindow>| {
            window.map(|window| UsageWindow {
                // Rounded and clamped: always 0..=100, so the cast is exact.
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                used_percent: window.used_percentage.round().clamp(0.0, 100.0) as u8,
                resets_at_ms: window.resets_at.checked_mul(1000),
            })
        };
        Self {
            five_hour: window(limits.five_hour),
            weekly: window(limits.seven_day),
        }
    }
}

/// One window's use: a whole percent (0–100) and when it resets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageWindow {
    pub used_percent: u8,
    /// Unix milliseconds.
    pub resets_at_ms: Option<i64>,
}

/// One [Readable view] entry. One that comes again with a `seq` the device
/// has replaces it in place.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// The host's, per session, rising, never reused within a [Session run].
    pub seq: u64,
    #[serde(with = "crate::nested::one")]
    pub kind: EntryKind,
}

pub use kriyon_core::readable::{EntryKind, StepState};
pub use kriyon_core::work_report::ReportOutcome;

/// Why a session has no [Readable view] entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntriesUnavailable {
    /// The companion is off: the desktop shows no turns it can vouch for
    /// (ADR 0035, exact or off).
    CompanionOff,
    /// The session has no transcript yet.
    NoTranscript,
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
            question: None,
            activity: None,
            running_since_ms: None,
            turn_summary: None,
            diff: None,
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
            digest: SessionDigest {
                question: Some(Question {
                    text: "Which db?".into(),
                    options: vec!["Postgres".into()],
                }),
                activity: Some("Bash · pnpm test".into()),
                running_since_ms: Some(1_699_999_999_000),
                turn_summary: Some("Fixed it.".into()),
                diff: Some(Diff {
                    files: 2,
                    added: 10,
                    removed: 3,
                }),
            },
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
                question: Some(Question {
                    text: "Which db?".into(),
                    options: vec!["Postgres".into()],
                }),
                activity: Some("Bash · pnpm test".into()),
                running_since_ms: Some(1_699_999_999_000),
                turn_summary: Some("Fixed it.".into()),
                diff: Some(Diff {
                    files: 2,
                    added: 10,
                    removed: 3,
                }),
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

    fn device_samples() -> [(FromDevice, u8); 12] {
        let s = || "s".to_string();
        [
            (
                FromDevice::Hello {
                    app_version: s(),
                    protocol_minor: 0,
                },
                0,
            ),
            (
                FromDevice::Open {
                    session_id: s(),
                    screen: true,
                },
                1,
            ),
            (FromDevice::Resync, 2),
            (FromDevice::RequestEntries { since: 0 }, 3),
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
            (
                FromDevice::PushToken {
                    key_id: 1,
                    sealed: vec![],
                },
                9,
            ),
            (FromDevice::StopEntries, 10),
            (FromDevice::Screen { on: true }, 11),
        ]
    }

    #[test]
    fn host_to_device_tags_are_fixed() {
        let s = || "s".to_string();
        let cases: [(ToDevice, u8); 13] = [
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
            (
                ToDevice::StartRefused {
                    request_id: [0; 16],
                    reason: RefuseReason::StartFailed,
                },
                11,
            ),
            (
                ToDevice::ProjectList {
                    projects: vec![ProjectInfo {
                        id: "p".into(),
                        name: "app".into(),
                        parked: false,
                    }],
                },
                12,
            ),
        ];
        for (message, expected) in cases {
            assert_eq!(tag(&message), expected, "{message:?}");
        }
    }

    #[test]
    fn readable_view_tags_are_fixed() {
        let entries = ToDevice::Entries {
            entries: vec![Entry {
                seq: 1,
                kind: EntryKind::Note { text: "n".into() },
            }],
            reset: true,
            from: 1,
        };
        assert_eq!(tag(&entries), 13);
        let unavailable = ToDevice::EntriesUnavailable {
            reason: EntriesUnavailable::CompanionOff,
        };
        assert_eq!(tag(&unavailable), 14);
    }

    #[test]
    fn entry_numbers_are_fixed() {
        let s = String::new;
        let kinds = [
            (EntryKind::You { text: s() }, 0),
            (
                EntryKind::Claude {
                    text: s(),
                    done: false,
                },
                1,
            ),
            (
                EntryKind::Step {
                    name: s(),
                    target: s(),
                    state: StepState::Running,
                },
                2,
            ),
            (
                EntryKind::Report {
                    summary: s(),
                    outcome: ReportOutcome::Update,
                    event: s(),
                },
                3,
            ),
            (
                EntryKind::Asking {
                    header: s(),
                    question: s(),
                    options: vec![],
                },
                4,
            ),
            (EntryKind::Note { text: s() }, 5),
        ];
        for (kind, expected) in kinds {
            assert_eq!(tag(&kind), expected, "{kind:?}");
        }
        let states = [StepState::Running, StepState::Done, StepState::Failed];
        for (state, expected) in states.into_iter().zip(0..) {
            assert_eq!(tag(&state), expected, "{state:?}");
        }
        let reasons = [
            EntriesUnavailable::CompanionOff,
            EntriesUnavailable::NoTranscript,
        ];
        for (reason, expected) in reasons.into_iter().zip(0..) {
            assert_eq!(tag(&reason), expected, "{reason:?}");
        }
        let outcomes = [
            ReportOutcome::Update,
            ReportOutcome::Completed,
            ReportOutcome::Failed,
            ReportOutcome::Stopped,
            ReportOutcome::Event,
        ];
        for (outcome, expected) in outcomes.into_iter().zip(0..) {
            assert_eq!(tag(&outcome), expected, "{outcome:?}");
        }
    }

    /// Session entries and readable-view entries are nested records (spec
    /// §3): each one's bytes, length first, so they can grow.
    #[test]
    fn session_and_readable_entries_go_as_nested_records() {
        let record = postcard::to_allocvec(&info()).expect("encodes");
        let status =
            postcard::to_allocvec(&ToDevice::SessionStatus { session: info() }).expect("encodes");
        let mut expected = vec![3, u8::try_from(record.len()).expect("small")];
        expected.extend_from_slice(&record);
        assert_eq!(status, expected);

        let list = postcard::to_allocvec(&ToDevice::SessionList {
            sessions: vec![info()],
        })
        .expect("encodes");
        let mut expected = vec![2, 1, u8::try_from(record.len()).expect("small")];
        expected.extend_from_slice(&record);
        assert_eq!(list, expected);

        let entries = postcard::to_allocvec(&ToDevice::Entries {
            entries: vec![Entry {
                seq: 7,
                kind: EntryKind::Note { text: "n".into() },
            }],
            reset: true,
            from: 1,
        })
        .expect("encodes");
        // Tag, one entry of 5 bytes: seq 7, then its kind of 3 bytes (Note,
        // "n"); then reset and from.
        assert_eq!(entries, [13, 1, 5, 7, 3, 5, 1, b'n', 1, 1]);
    }

    #[test]
    fn plan_limits_go_as_whole_percents_and_milliseconds() {
        use kriyon_core::plan_limits::{LimitWindow, PlanLimits};
        let usage = PlanUsage::from(&PlanLimits {
            five_hour: Some(LimitWindow {
                used_percentage: 41.6,
                resets_at: 1_700_000_000,
            }),
            seven_day: Some(LimitWindow {
                used_percentage: 130.0,
                resets_at: 5,
            }),
        });
        assert_eq!(
            usage,
            PlanUsage {
                five_hour: Some(UsageWindow {
                    used_percent: 42,
                    resets_at_ms: Some(1_700_000_000_000),
                }),
                weekly: Some(UsageWindow {
                    used_percent: 100,
                    resets_at_ms: Some(5_000),
                }),
            }
        );
        assert_eq!(
            PlanUsage::from(&PlanLimits::default()),
            PlanUsage::default()
        );
    }

    #[test]
    fn the_usage_tag_is_fixed() {
        let usage = ToDevice::Usage {
            usage: PlanUsage::default(),
        };
        assert_eq!(tag(&usage), 15);
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
            RefuseReason::StartFailed,
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
    fn the_most_typing_a_device_sends_fits_one_input_whatever_its_fields() {
        let input = |len: usize| FromDevice::Input {
            run: u64::MAX,
            epoch: Epoch {
                host_boot_id: u64::MAX,
                counter: u64::MAX,
            },
            seen_seq: u64::MAX,
            bytes: vec![0; len],
        };
        assert!(crate::codec::encode(&input(MAX_INPUT_BYTES)).is_ok());
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
