//! A [Remote device]'s view of a [Host] (spec §5–§7), as pure state: what
//! the control stream says (the host, its sessions, who holds control), and
//! what one session stream draws.
//!
//! The device never guesses: a screen update that doesn't follow on asks for
//! a fresh snapshot, and input names the run, the control epoch and the last
//! update drawn, so the host can refuse what was meant for an older screen.

use serde::Serialize;
use std::collections::HashMap;
use std::time::Instant;

use crate::compress::{CompressError, Kind, SnapshotHead, SnapshotParts, Unpacker};
use crate::message::{
    Epoch, FromDevice, Holder, ProjectInfo, RefuseReason, Role, SessionId, SessionInfo, ToDevice,
};
use crate::screen::{Follow, ScreenFollower};

/// Where a paired host's link stands, as the UI shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkState {
    /// Dialing, or waiting to dial again.
    Connecting,
    /// Welcomed, and the heartbeat is coming.
    Connected,
    /// No heartbeat for 40 s: "Disconnected, reconnecting. Typing is off."
    Lost,
    /// The host says this device isn't paired any more.
    Removed,
}

/// Who holds [Typing control] of a session, as the host last said.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlState {
    pub holder: Holder,
    pub epoch: Epoch,
}

/// What the control stream has said about the host.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HostView {
    /// From `Welcome`; `None` until it comes.
    pub host_name: Option<String>,
    pub role: Option<Role>,
    pub sessions: Vec<SessionInfo>,
    pub control: HashMap<SessionId, ControlState>,
    /// The last refusal the host sent on the control stream.
    pub refused: Option<RefuseReason>,
    /// Where a Controller may start a session, as the host last said.
    pub projects: Vec<ProjectInfo>,
}

impl HostView {
    /// Take in one control-stream message. Returns whether the view changed.
    pub fn apply(&mut self, message: &ToDevice) -> bool {
        match message {
            ToDevice::Welcome {
                host_name,
                role,
                sessions,
                ..
            } => {
                self.host_name = Some(host_name.clone());
                self.role = Some(*role);
                self.sessions.clone_from(sessions);
            }
            ToDevice::SessionList { sessions } => self.sessions.clone_from(sessions),
            ToDevice::SessionStatus { session } => {
                match self
                    .sessions
                    .iter_mut()
                    .find(|known| known.id == session.id)
                {
                    Some(known) => known.clone_from(session),
                    None => self.sessions.push(session.clone()),
                }
            }
            ToDevice::Control {
                session_id,
                holder,
                epoch,
            } => {
                self.control.insert(
                    session_id.clone(),
                    ControlState {
                        holder: *holder,
                        epoch: *epoch,
                    },
                );
            }
            ToDevice::Refused { reason } => self.refused = Some(*reason),
            ToDevice::ProjectList { projects } => self.projects.clone_from(projects),
            // Heartbeats are the link's; screens belong on session streams.
            _ => return false,
        }
        true
    }

    /// Whether `Welcome` has come: the link works.
    #[must_use]
    pub fn welcomed(&self) -> bool {
        self.host_name.is_some()
    }
}

/// What a session stream asks of the terminal showing it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScreenEvent {
    /// Replace the screen: clear, size it, then draw `bytes`.
    Screen {
        cols: u16,
        rows: u16,
        bytes: Vec<u8>,
        /// The host skipped ahead: say "Skipped ahead".
        skipped: bool,
    },
    /// Draw these bytes after what is there.
    Output(Vec<u8>),
    /// Send `Resync` to the host.
    Resync,
    /// The host's receipt for input: `written` means it reached the PTY.
    InputAck { epoch: Epoch, written: bool },
    /// The host refused something on this stream.
    Refused(RefuseReason),
}

/// One open session stream, on the device.
pub struct SessionScreen {
    follower: ScreenFollower,
    parts: SnapshotParts,
    unpacker: Unpacker,
}

impl SessionScreen {
    /// # Errors
    /// [`CompressError`] if zstd can't make a context.
    pub fn new() -> Result<Self, CompressError> {
        Ok(Self {
            follower: ScreenFollower::new(),
            parts: SnapshotParts::new(),
            unpacker: Unpacker::new()?,
        })
    }

    /// Take in one session-stream message at `now`.
    pub fn on_message(&mut self, message: ToDevice, now: Instant) -> Vec<ScreenEvent> {
        match message {
            ToDevice::Snapshot {
                run,
                seq,
                cols,
                rows,
                bytes,
                skipped,
            } => self.snapshot(
                SnapshotHead {
                    run,
                    seq,
                    cols,
                    rows,
                    skipped,
                },
                &bytes,
                now,
            ),
            ToDevice::SnapshotPart {
                run,
                seq,
                cols,
                rows,
                skipped,
                index,
                count,
                bytes,
            } => {
                let head = SnapshotHead {
                    run,
                    seq,
                    cols,
                    rows,
                    skipped,
                };
                match self.parts.add(head, index, count, &bytes) {
                    Ok(Some((head, whole))) => self.snapshot(head, &whole, now),
                    Ok(None) => Vec::new(),
                    Err(_) => self.lost(now),
                }
            }
            ToDevice::Update { run, seq, bytes } => match self.follower.update(run, seq, now) {
                Follow::Draw => match self.unpacker.unpack(Kind::Update, &bytes) {
                    Ok(output) => vec![ScreenEvent::Output(output)],
                    Err(_) => self.lost(now),
                },
                Follow::Ignore => Vec::new(),
                Follow::Resync => vec![ScreenEvent::Resync],
            },
            ToDevice::InputAck { epoch, written } => {
                vec![ScreenEvent::InputAck { epoch, written }]
            }
            ToDevice::Refused { reason } => vec![ScreenEvent::Refused(reason)],
            _ => Vec::new(),
        }
    }

    fn snapshot(&mut self, head: SnapshotHead, packed: &[u8], now: Instant) -> Vec<ScreenEvent> {
        match self.unpacker.unpack(Kind::Snapshot, packed) {
            Ok(bytes) => {
                self.follower.snapshot(head.run, head.seq);
                vec![ScreenEvent::Screen {
                    cols: head.cols,
                    rows: head.rows,
                    bytes,
                    skipped: head.skipped,
                }]
            }
            Err(_) => self.lost(now),
        }
    }

    /// Something didn't decode: the screen is unknown, ask for a new one.
    fn lost(&mut self, now: Instant) -> Vec<ScreenEvent> {
        // An update from a run that can't be the current one marks the
        // follower lost, through the one rate-limited path.
        match self.follower.update(u64::MAX, u64::MAX, now) {
            Follow::Resync => vec![ScreenEvent::Resync],
            _ => Vec::new(),
        }
    }

    /// Whether to send `Resync` now with no message to prompt it (call on a
    /// timer): lost, and the last ask was a second ago.
    pub fn resync_due(&mut self, now: Instant) -> bool {
        self.follower.resync_due(now)
    }

    /// `Input` for `bytes` under `epoch`, naming the run and the last update
    /// drawn. `None` before the first snapshot: there is nothing to answer.
    #[must_use]
    pub fn input(&self, epoch: Epoch, bytes: Vec<u8>) -> Option<FromDevice> {
        Some(FromDevice::Input {
            run: self.follower.run()?,
            epoch,
            seen_seq: self.follower.seen_seq()?,
            bytes,
        })
    }
}

/// What a refusal means, in words a person reads: the same on the desktop
/// and the phone.
#[must_use]
pub fn refusal_words(reason: RefuseReason) -> &'static str {
    match reason {
        RefuseReason::NotPaired => "This device isn't paired with that computer any more.",
        RefuseReason::NoSuchSession => "That session isn't there any more.",
        RefuseReason::NotAllowed => "This device isn't allowed to do that.",
        RefuseReason::NotInControl => "You don't have control of this session.",
        RefuseReason::Stale => {
            "The screen changed before that arrived. Look again, then try again."
        }
        RefuseReason::OutOfRange => "That is too big to send.",
        RefuseReason::DialogOpen => "A question is showing there. Answer it first.",
        RefuseReason::FolderNotAllowed => {
            "That project's folder isn't one sessions can start in on that computer."
        }
        RefuseReason::UnknownMessage => "That computer's Kriyon doesn't know that request.",
        RefuseReason::TooOld { .. } => "Update Kriyon on this device to use that computer.",
        RefuseReason::NoSuchProject => "That project isn't on that computer any more.",
        RefuseReason::ScreenTooLarge => "That screen is too big to show here.",
        RefuseReason::StartFailed => "The session couldn't be started on that computer.",
    }
}

/// Who types into a session now, seen from one device.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Typing {
    /// The person at the host's keyboard.
    Host,
    /// This device.
    You,
    /// Another device.
    Other,
}

/// One session, as a device's screens show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: SessionId,
    pub title: String,
    pub project_id: String,
    pub status: kriyon_core::session::SessionStatus,
    pub standing: kriyon_core::standing::StandingState,
    pub needs_you: bool,
    pub dialog_open: bool,
    pub last_change_ms: i64,
    /// `None` until the host says who holds control.
    pub typing: Option<Typing>,
    /// This device may type now: connected, a Controller, holding control.
    /// The host checks again at the write.
    pub may_type: bool,
}

/// A paired host as a device's screens show it: one record, made here,
/// read by the desktop's webview and the phone's screens alike.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSummary {
    pub host_id: String,
    /// From the host's welcome; `None` until it comes.
    pub host_name: Option<String>,
    pub link: LinkState,
    /// `viewer` or `controller`, from the welcome.
    pub role: Option<&'static str>,
    /// The last refusal the host sent, by its name (`NotInControl`).
    pub refused: Option<String>,
    pub sessions: Vec<SessionSummary>,
    /// Where a session can be started there.
    pub projects: Vec<ProjectInfo>,
    /// This device may start a session there now: connected, a Controller,
    /// with a project. The host checks again.
    pub may_start: bool,
}

/// Who `holder` is, seen from device `me`.
#[must_use]
pub fn typing(holder: &Holder, me: &crate::message::EndpointId) -> Typing {
    match holder {
        Holder::Host => Typing::Host,
        Holder::Device(device) if device == me => Typing::You,
        Holder::Device(_) => Typing::Other,
    }
}

/// The name serde gives `value`: a unit variant's name, or a variant with
/// fields by its name alone (`TooOld`).
#[must_use]
pub fn name_of(value: &impl Serialize) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(name)) => name,
        Ok(serde_json::Value::Object(fields)) => fields.keys().next().cloned().unwrap_or_default(),
        _ => String::new(),
    }
}

/// The summary of `view` for host `host`, seen from device `me`.
#[must_use]
pub fn host_summary(
    host: &crate::message::EndpointId,
    me: &crate::message::EndpointId,
    link: LinkState,
    view: &HostView,
) -> HostSummary {
    let connected = link == LinkState::Connected;
    let controller = view.role == Some(Role::Controller);
    HostSummary {
        host_id: crate::message::hex(host),
        host_name: view.host_name.clone(),
        link,
        role: view.role.map(|role| match role {
            Role::Viewer => "viewer",
            Role::Controller => "controller",
        }),
        refused: view.refused.as_ref().map(name_of),
        sessions: view
            .sessions
            .iter()
            .map(|session| {
                let typing = view
                    .control
                    .get(&session.id)
                    .map(|control| typing(&control.holder, me));
                SessionSummary {
                    id: session.id.clone(),
                    title: session.title.clone(),
                    project_id: session.project_id.clone(),
                    status: session.status,
                    standing: session.standing,
                    needs_you: session.needs_you,
                    dialog_open: session.dialog_open,
                    last_change_ms: session.last_change_ms,
                    typing,
                    may_type: connected && controller && typing == Some(Typing::You),
                }
            })
            .collect(),
        projects: view.projects.clone(),
        may_start: connected && controller && !view.projects.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_project_list_replaces_the_last_one() {
        let mut view = HostView::default();
        let first = vec![ProjectInfo {
            id: "a".into(),
            name: "app".into(),
            parked: false,
        }];
        assert!(view.apply(&ToDevice::ProjectList {
            projects: first.clone()
        }));
        assert_eq!(view.projects, first);
        assert!(view.apply(&ToDevice::ProjectList { projects: vec![] }));
        assert_eq!(view.projects, Vec::<ProjectInfo>::new());
    }

    #[test]
    fn every_refusal_has_its_own_words() {
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
            RefuseReason::TooOld { min_minor: 1 },
            RefuseReason::NoSuchProject,
            RefuseReason::ScreenTooLarge,
            RefuseReason::StartFailed,
        ];
        let words: std::collections::HashSet<&str> = reasons
            .iter()
            .map(|reason| refusal_words(*reason))
            .collect();
        assert_eq!(words.len(), reasons.len());
        assert_eq!(
            refusal_words(RefuseReason::FolderNotAllowed),
            "That project's folder isn't one sessions can start in on that computer."
        );
    }

    use kriyon_core::session::SessionStatus;
    use kriyon_core::standing::StandingState;

    use super::*;
    use crate::compress::{compress, snapshot_messages, SNAPSHOT_PART_LEN};

    const EPOCH: Epoch = Epoch {
        host_boot_id: 4,
        counter: 2,
    };

    fn info(id: &str, status: SessionStatus) -> SessionInfo {
        SessionInfo {
            id: id.into(),
            title: format!("Session {id}"),
            project_id: "p".into(),
            status,
            standing: StandingState::Idle,
            needs_you: false,
            dialog_open: false,
            last_change_ms: 0,
        }
    }

    fn snapshot(run: u64, seq: u64, screen: &[u8], skipped: bool) -> ToDevice {
        ToDevice::Snapshot {
            run,
            seq,
            cols: 100,
            rows: 30,
            bytes: compress(Kind::Snapshot, screen).expect("packs"),
            skipped,
        }
    }

    fn update(run: u64, seq: u64, bytes: &[u8]) -> ToDevice {
        ToDevice::Update {
            run,
            seq,
            bytes: compress(Kind::Update, bytes).expect("packs"),
        }
    }

    #[test]
    fn welcome_names_the_host_and_lists_its_sessions() {
        let mut view = HostView::default();
        assert!(!view.welcomed());
        assert!(view.apply(&ToDevice::Welcome {
            host_name: "Studio".into(),
            protocol_minor: 0,
            role: Role::Controller,
            sessions: vec![info("s1", SessionStatus::Idle)],
        }));
        assert!(view.welcomed());
        assert_eq!(view.host_name.as_deref(), Some("Studio"));
        assert_eq!(view.role, Some(Role::Controller));
        assert_eq!(view.sessions.len(), 1);
    }

    #[test]
    fn a_status_update_replaces_that_session_and_a_list_replaces_all() {
        let mut view = HostView::default();
        view.apply(&ToDevice::SessionList {
            sessions: vec![
                info("s1", SessionStatus::Idle),
                info("s2", SessionStatus::Idle),
            ],
        });
        view.apply(&ToDevice::SessionStatus {
            session: info("s2", SessionStatus::Running),
        });
        assert_eq!(view.sessions[1].status, SessionStatus::Running);
        assert_eq!(view.sessions[0].status, SessionStatus::Idle);
        // A status for a session the list doesn't have yet adds it.
        view.apply(&ToDevice::SessionStatus {
            session: info("s3", SessionStatus::Waiting),
        });
        assert_eq!(view.sessions.len(), 3);
        view.apply(&ToDevice::SessionList {
            sessions: vec![info("s9", SessionStatus::Done)],
        });
        assert_eq!(view.sessions.len(), 1);
    }

    #[test]
    fn control_changes_are_kept_per_session() {
        let mut view = HostView::default();
        view.apply(&ToDevice::Control {
            session_id: "s1".into(),
            holder: Holder::Device([1; 32]),
            epoch: EPOCH,
        });
        assert_eq!(
            view.control.get("s1"),
            Some(&ControlState {
                holder: Holder::Device([1; 32]),
                epoch: EPOCH
            })
        );
    }

    #[test]
    fn a_refusal_on_the_control_stream_is_kept() {
        let mut view = HostView::default();
        view.apply(&ToDevice::Refused {
            reason: RefuseReason::NotInControl,
        });
        assert_eq!(view.refused, Some(RefuseReason::NotInControl));
        assert!(!view.apply(&ToDevice::Heartbeat { seq: 1, at: 0 }));
    }

    #[test]
    fn a_snapshot_then_updates_draw_in_order() {
        let t = Instant::now();
        let mut screen = SessionScreen::new().expect("screen");
        assert_eq!(
            screen.on_message(snapshot(9, 4, b"hello", false), t),
            [ScreenEvent::Screen {
                cols: 100,
                rows: 30,
                bytes: b"hello".to_vec(),
                skipped: false
            }]
        );
        assert_eq!(
            screen.on_message(update(9, 5, b" world"), t),
            [ScreenEvent::Output(b" world".to_vec())]
        );
    }

    #[test]
    fn a_gap_asks_for_a_snapshot_and_draws_nothing_until_it_comes() {
        let t = Instant::now();
        let mut screen = SessionScreen::new().expect("screen");
        screen.on_message(snapshot(9, 4, b"a", false), t);
        assert_eq!(
            screen.on_message(update(9, 6, b"x"), t),
            [ScreenEvent::Resync]
        );
        assert_eq!(screen.on_message(update(9, 7, b"y"), t), []);
        let after = screen.on_message(snapshot(9, 7, b"fresh", true), t);
        assert!(matches!(
            after[..],
            [ScreenEvent::Screen { skipped: true, .. }]
        ));
    }

    #[test]
    fn a_big_snapshot_in_parts_draws_once_whole() {
        let t = Instant::now();
        let mut screen = SessionScreen::new().expect("screen");
        // Bytes that don't compress, so the snapshot needs parts.
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let big: Vec<u8> = (0..SNAPSHOT_PART_LEN + 5000)
            .map(|_| {
                // xorshift: noise zstd can't shrink.
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state.to_le_bytes()[0]
            })
            .collect();
        let packed = compress(Kind::Snapshot, &big).expect("packs");
        let head = SnapshotHead {
            run: 1,
            seq: 0,
            cols: 80,
            rows: 24,
            skipped: false,
        };
        let messages = snapshot_messages(head, &packed);
        assert!(messages.len() > 1, "in parts");
        let mut events = Vec::new();
        for message in messages {
            events.extend(screen.on_message(message, t));
        }
        assert_eq!(
            events,
            [ScreenEvent::Screen {
                cols: 80,
                rows: 24,
                bytes: big,
                skipped: false
            }]
        );
    }

    #[test]
    fn a_frame_that_does_not_unpack_asks_for_a_snapshot() {
        let t = Instant::now();
        let mut screen = SessionScreen::new().expect("screen");
        screen.on_message(snapshot(9, 4, b"a", false), t);
        let bad = ToDevice::Update {
            run: 9,
            seq: 5,
            bytes: b"not zstd".to_vec(),
        };
        assert_eq!(screen.on_message(bad, t), [ScreenEvent::Resync]);
    }

    #[test]
    fn receipts_and_refusals_pass_through() {
        let t = Instant::now();
        let mut screen = SessionScreen::new().expect("screen");
        assert_eq!(
            screen.on_message(
                ToDevice::InputAck {
                    epoch: EPOCH,
                    written: true
                },
                t
            ),
            [ScreenEvent::InputAck {
                epoch: EPOCH,
                written: true
            }]
        );
        assert_eq!(
            screen.on_message(
                ToDevice::Refused {
                    reason: RefuseReason::Stale
                },
                t
            ),
            [ScreenEvent::Refused(RefuseReason::Stale)]
        );
    }

    #[test]
    fn input_names_the_run_the_epoch_and_the_last_update_drawn() {
        let t = Instant::now();
        let mut screen = SessionScreen::new().expect("screen");
        assert_eq!(screen.input(EPOCH, b"y".to_vec()), None, "nothing seen yet");
        screen.on_message(snapshot(9, 4, b"a", false), t);
        screen.on_message(update(9, 5, b"b"), t);
        assert_eq!(
            screen.input(EPOCH, b"y".to_vec()),
            Some(FromDevice::Input {
                run: 9,
                epoch: EPOCH,
                seen_seq: 5,
                bytes: b"y".to_vec()
            })
        );
    }

    #[test]
    fn a_hosts_summary_is_one_record_both_apps_read() {
        let me = [2; 32];
        let mut control = HashMap::new();
        control.insert(
            "s1".to_string(),
            ControlState {
                holder: Holder::Device(me),
                epoch: Epoch {
                    host_boot_id: 1,
                    counter: 2,
                },
            },
        );
        let view = HostView {
            host_name: Some("Mac".into()),
            role: Some(Role::Controller),
            sessions: vec![SessionInfo {
                id: "s1".into(),
                title: "Fix the build".into(),
                project_id: "p1".into(),
                status: kriyon_core::session::SessionStatus::Waiting,
                standing: kriyon_core::standing::StandingState::AwaitingInput,
                needs_you: true,
                dialog_open: false,
                last_change_ms: 5,
            }],
            control,
            refused: Some(RefuseReason::NotInControl),
            projects: vec![ProjectInfo {
                id: "p1".into(),
                name: "app".into(),
                parked: false,
            }],
        };
        let summary = host_summary(&[0xab; 32], &me, LinkState::Connected, &view);
        let json = serde_json::to_value(&summary).expect("json");
        assert_eq!(
            json,
            serde_json::json!({
                "hostId": "ab".repeat(32),
                "hostName": "Mac",
                "link": "connected",
                "role": "controller",
                "refused": "NotInControl",
                "sessions": [{
                    "id": "s1",
                    "title": "Fix the build",
                    "projectId": "p1",
                    "status": "waiting",
                    "standing": "awaiting_input",
                    "needsYou": true,
                    "dialogOpen": false,
                    "lastChangeMs": 5,
                    "typing": "you",
                    "mayType": true,
                }],
                "projects": [{ "id": "p1", "name": "app", "parked": false }],
                "mayStart": true,
            })
        );
    }

    #[test]
    fn typing_and_starting_need_a_connected_controller() {
        let me = [2; 32];
        let view = HostView {
            role: Some(Role::Viewer),
            projects: vec![ProjectInfo {
                id: "p1".into(),
                name: "app".into(),
                parked: false,
            }],
            ..HostView::default()
        };
        let summary = host_summary(&[1; 32], &me, LinkState::Connected, &view);
        assert!(!summary.may_start, "a Viewer");
        let controller = HostView {
            role: Some(Role::Controller),
            ..view.clone()
        };
        assert!(host_summary(&[1; 32], &me, LinkState::Connected, &controller).may_start);
        assert!(!host_summary(&[1; 32], &me, LinkState::Lost, &controller).may_start);
        let no_projects = HostView {
            projects: vec![],
            ..controller
        };
        assert!(!host_summary(&[1; 32], &me, LinkState::Connected, &no_projects).may_start);
        assert_eq!(typing(&Holder::Host, &me), Typing::Host);
        assert_eq!(typing(&Holder::Device(me), &me), Typing::You);
        assert_eq!(typing(&Holder::Device([9; 32]), &me), Typing::Other);
    }
}
