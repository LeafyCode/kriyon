//! A [Remote device]'s view of a [Host] (spec §5–§7), as pure state: what
//! the control stream says (the host, its sessions, who holds control), and
//! what one session stream draws.
//!
//! The device never guesses: a screen update that doesn't follow on asks for
//! a fresh snapshot, and input names the run, the control epoch and the last
//! update drawn, so the host can refuse what was meant for an older screen.

use std::collections::HashMap;
use std::time::Instant;

use crate::compress::{CompressError, Kind, SnapshotHead, SnapshotParts, Unpacker};
use crate::message::{
    Epoch, FromDevice, Holder, RefuseReason, Role, SessionId, SessionInfo, ToDevice,
};
use crate::screen::{Follow, ScreenFollower};

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

#[cfg(test)]
mod tests {
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
}
