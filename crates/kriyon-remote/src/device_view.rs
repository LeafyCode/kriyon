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
    Epoch, FromDevice, Holder, ProjectInfo, RefuseReason, ReportOutcome, Role, SessionId,
    SessionInfo, ToDevice,
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

/// How a link to a host runs now: straight to it, or through a relay.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkPath {
    Direct,
    Relay,
}

/// What this device knows of its own link to a host, beside what the host
/// says: never on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkFacts {
    pub state: LinkState,
    /// The path iroh uses now, while connected.
    pub path: Option<LinkPath>,
    /// When this device last heard from the host (Unix ms).
    pub last_seen_ms: Option<i64>,
}

impl LinkFacts {
    /// A link in `state` with nothing else known.
    #[must_use]
    pub fn new(state: LinkState) -> Self {
        Self {
            state,
            path: None,
            last_seen_ms: None,
        }
    }
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
    /// The host's [Plan limits], once it has said them.
    pub usage: Option<crate::message::PlanUsage>,
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
            ToDevice::Usage { usage } => self.usage = Some(*usage),
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
    /// The host's receipt for write `write_id`: `written` means it reached
    /// the PTY.
    InputAck {
        epoch: Epoch,
        written: bool,
        write_id: u32,
    },
    /// The host refused something on this stream.
    Refused(RefuseReason),
    /// The host refused write `write_id`.
    WriteRefused { write_id: u32, reason: RefuseReason },
}

/// One open session stream, on the device.
pub struct SessionScreen {
    /// Since when it has waited for its first snapshot (or last asked).
    waiting_since: Option<Instant>,
    follower: ScreenFollower,
    parts: SnapshotParts,
    unpacker: Unpacker,
    /// The newest [Session run] the host named: in a snapshot, or in `Run`
    /// while the screen is off.
    run: Option<u64>,
}

/// How long a screen waits for its first snapshot before asking again: the
/// host gives at most one a second, and may have said no to the first ask.
pub const FIRST_SCREEN_WAIT: std::time::Duration = std::time::Duration::from_secs(1);

impl SessionScreen {
    /// # Errors
    /// [`CompressError`] if zstd can't make a context.
    pub fn new() -> Result<Self, CompressError> {
        Self::new_at(Instant::now())
    }

    /// A screen made at `now`, waiting for its first snapshot.
    ///
    /// # Errors
    /// [`CompressError`] if zstd can't make a context.
    pub fn new_at(now: Instant) -> Result<Self, CompressError> {
        Ok(Self {
            waiting_since: Some(now),
            follower: ScreenFollower::new(),
            parts: SnapshotParts::new(),
            run: None,
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
            ToDevice::InputAck {
                epoch,
                written,
                write_id,
            } => vec![ScreenEvent::InputAck {
                epoch,
                written,
                write_id,
            }],
            ToDevice::Refused { reason } => vec![ScreenEvent::Refused(reason)],
            ToDevice::WriteRefused { write_id, reason } => {
                vec![ScreenEvent::WriteRefused { write_id, reason }]
            }
            ToDevice::Run { run } => {
                self.run = Some(run);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn snapshot(&mut self, head: SnapshotHead, packed: &[u8], now: Instant) -> Vec<ScreenEvent> {
        match self.unpacker.unpack(Kind::Snapshot, packed) {
            Ok(bytes) => {
                self.waiting_since = None;
                self.follower.snapshot(head.run, head.seq);
                self.run = Some(head.run);
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
        if let Some(since) = self.waiting_since {
            if now.saturating_duration_since(since) < FIRST_SCREEN_WAIT {
                return false;
            }
            self.waiting_since = Some(now);
            return true;
        }
        self.follower.resync_due(now)
    }

    /// `Compose` for `text` under `epoch`, naming the newest run the host
    /// named: with the screen on or off, as a compose answers no dialog.
    /// `None` before the host named one.
    #[must_use]
    pub fn compose(&self, epoch: Epoch, text: String, write_id: u32) -> Option<FromDevice> {
        Some(FromDevice::Compose {
            run: self.run?,
            epoch,
            text,
            write_id,
        })
    }

    /// `Input` for `bytes` under `epoch`, naming the run and the last update
    /// drawn. `None` before the first snapshot: there is nothing to answer.
    #[must_use]
    pub fn input(&self, epoch: Epoch, bytes: Vec<u8>, write_id: u32) -> Option<FromDevice> {
        Some(FromDevice::Input {
            run: self.follower.run()?,
            epoch,
            seen_seq: self.follower.seen_seq()?,
            bytes,
            write_id,
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
#[allow(
    clippy::struct_excessive_bools,
    reason = "the JSON both apps read: each flag is a field there, mirrored in TypeScript"
)]
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
    /// This device may write to Claude now (`compose`): it may type and no
    /// question shows (one is answered in the terminal). The host checks
    /// again at the write.
    pub may_compose: bool,
    /// Its [Session digest], as the host sent it.
    pub question: Option<crate::message::Question>,
    pub activity: Option<String>,
    pub running_since_ms: Option<i64>,
    pub turn_summary: Option<String>,
    pub diff: Option<crate::message::Diff>,
}

/// A host's [Plan limits] as Home shows them: the window nearest its limit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// The window's name, as the desktop says it.
    pub window: &'static str,
    pub used_percent: u8,
    pub resets_at_ms: Option<i64>,
}

/// The window of `usage` nearest its limit, the 5-hour one on a tie, as
/// the desktop's limit alert picks it.
#[must_use]
pub fn shown_usage(usage: &crate::message::PlanUsage) -> Option<Usage> {
    let windows = [
        ("5-hour limit", usage.five_hour),
        ("Weekly limit", usage.weekly),
    ];
    windows
        .into_iter()
        .filter_map(|(window, used)| used.map(|used| (window, used)))
        .reduce(|most, next| {
            if next.1.used_percent > most.1.used_percent {
                next
            } else {
                most
            }
        })
        .map(|(window, used)| Usage {
            window,
            used_percent: used.used_percent,
            resets_at_ms: used.resets_at_ms,
        })
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
    /// How the link runs, while connected.
    pub path: Option<LinkPath>,
    /// When this device last heard from it (Unix ms), while not connected.
    pub last_seen_ms: Option<i64>,
    /// Its [Plan limits]: the window nearest its limit.
    pub usage: Option<Usage>,
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
    link: &LinkFacts,
    view: &HostView,
) -> HostSummary {
    let connected = link.state == LinkState::Connected;
    let controller = view.role == Some(Role::Controller);
    HostSummary {
        host_id: crate::message::hex(host),
        host_name: view.host_name.clone(),
        link: link.state,
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
                let may_type = connected && controller && typing == Some(Typing::You);
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
                    may_type,
                    may_compose: may_type && !session.dialog_open,
                    question: session.question.clone(),
                    activity: session.activity.clone(),
                    running_since_ms: session.running_since_ms,
                    turn_summary: session.turn_summary.clone(),
                    diff: session.diff,
                }
            })
            .collect(),
        projects: view.projects.clone(),
        may_start: connected && controller && !view.projects.is_empty(),
        path: link.path.filter(|_| connected),
        last_seen_ms: link.last_seen_ms.filter(|_| !connected),
        usage: view.usage.as_ref().and_then(shown_usage),
    }
}

/// A session's [Readable view] entries, on the device, as the host sends
/// them: in `seq` order, an entry that comes again replacing its own.
#[derive(Debug, Default)]
pub struct ReadableEntries {
    entries: std::collections::BTreeMap<u64, crate::message::EntryKind>,
}

/// What a readable view should show now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntriesEvent {
    /// Every entry, in order.
    Entries(Vec<crate::message::Entry>),
    /// The host can't send entries: show the terminal, with a note.
    Unavailable(crate::message::EntriesUnavailable),
    /// The host refused the session stream (the session went, say), with
    /// its screen off: said here, as nothing else would say it.
    Refused(RefuseReason),
}

impl ReadableEntries {
    /// Take in `message`: what to show now, or `None` for a message that
    /// isn't about entries.
    pub fn apply(&mut self, message: &ToDevice) -> Option<EntriesEvent> {
        match message {
            ToDevice::Entries {
                entries,
                reset,
                from,
            } => {
                if *reset {
                    self.entries.clear();
                }
                // Fallen off the host's window; the "older" note (0) stays.
                self.entries.retain(|seq, _| *seq == 0 || seq >= from);
                for entry in entries {
                    self.entries.insert(entry.seq, entry.kind.clone());
                }
                Some(EntriesEvent::Entries(self.all()))
            }
            ToDevice::EntriesUnavailable { reason } => Some(EntriesEvent::Unavailable(*reason)),
            _ => None,
        }
    }

    /// Every entry, in order.
    #[must_use]
    pub fn all(&self) -> Vec<crate::message::Entry> {
        self.entries
            .iter()
            .map(|(seq, kind)| crate::message::Entry {
                seq: *seq,
                kind: kind.clone(),
            })
            .collect()
    }

    /// The highest `seq` here, for `RequestEntries { since }`; 0 for none.
    #[must_use]
    pub fn highest(&self) -> u64 {
        self.entries.keys().next_back().copied().unwrap_or_default()
    }
}

/// A readable view as the apps show it: the desktop's webview and the
/// phone's screens read this JSON alike.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadableSummary {
    pub entries: Vec<ShownEntry>,
    /// Why there are no entries, in words to show over the terminal; `None`
    /// while the host sends them.
    pub unavailable: Option<String>,
}

/// One entry as the apps show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ShownEntry {
    pub seq: u64,
    #[serde(flatten)]
    pub kind: ShownKind,
}

/// What an entry shows, tagged `kind`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShownKind {
    You {
        text: String,
    },
    Claude {
        text: String,
        done: bool,
    },
    Step {
        name: String,
        target: String,
        /// `running`, `done` or `failed`.
        state: &'static str,
    },
    Report {
        summary: String,
        outcome: String,
    },
    /// Only ever answered in the terminal.
    Asking {
        header: String,
        question: String,
        options: Vec<String>,
    },
    Note {
        text: String,
    },
}

/// A report's outcome in the desktop's words; what a monitor saw stands as
/// its own.
fn outcome_words(outcome: ReportOutcome, event: &str) -> String {
    match outcome {
        ReportOutcome::Completed => "Finished".into(),
        ReportOutcome::Failed => "Failed".into(),
        ReportOutcome::Stopped => "Stopped".into(),
        ReportOutcome::Event if !event.is_empty() => event.into(),
        ReportOutcome::Event => "Event".into(),
        ReportOutcome::Update => "Update".into(),
    }
}

/// What the apps show for `event`.
#[must_use]
pub fn readable_summary(event: &EntriesEvent) -> ReadableSummary {
    use crate::message::{EntriesUnavailable, EntryKind, StepState};
    match event {
        EntriesEvent::Refused(reason) => ReadableSummary {
            entries: Vec::new(),
            unavailable: Some(refusal_words(*reason).to_string()),
        },
        EntriesEvent::Unavailable(reason) => ReadableSummary {
            entries: Vec::new(),
            unavailable: Some(
                match reason {
                    EntriesUnavailable::CompanionOff => {
                        "The Kriyon Companion is off for this session on the computer, so it shows as its terminal."
                    }
                    EntriesUnavailable::NoTranscript => {
                        "Nothing to read yet, so this session shows as its terminal."
                    }
                }
                .to_string(),
            ),
        },
        EntriesEvent::Entries(entries) => ReadableSummary {
            entries: entries
                .iter()
                .map(|entry| ShownEntry {
                    seq: entry.seq,
                    kind: match &entry.kind {
                        EntryKind::You { text } => ShownKind::You { text: text.clone() },
                        EntryKind::Claude { text, done } => ShownKind::Claude {
                            text: text.clone(),
                            done: *done,
                        },
                        EntryKind::Step {
                            name,
                            target,
                            state,
                        } => ShownKind::Step {
                            name: name.clone(),
                            target: target.clone(),
                            state: match state {
                                StepState::Running => "running",
                                StepState::Done => "done",
                                StepState::Failed => "failed",
                            },
                        },
                        EntryKind::Report {
                            summary,
                            outcome,
                            event,
                        } => ShownKind::Report {
                            summary: summary.clone(),
                            outcome: outcome_words(*outcome, event),
                        },
                        EntryKind::Asking {
                            header,
                            question,
                            options,
                        } => ShownKind::Asking {
                            header: header.clone(),
                            question: question.clone(),
                            options: options.clone(),
                        },
                        EntryKind::Note { text } => ShownKind::Note { text: text.clone() },
                    },
                })
                .collect(),
            unavailable: None,
        },
    }
}

#[cfg(test)]
mod entries_tests {
    use super::*;
    use crate::message::{EntriesUnavailable, Entry, EntryKind};

    fn note(seq: u64, text: &str) -> Entry {
        Entry {
            seq,
            kind: EntryKind::Note { text: text.into() },
        }
    }

    fn texts(event: Option<EntriesEvent>) -> Vec<(u64, String)> {
        let Some(EntriesEvent::Entries(entries)) = event else {
            panic!("entries: {event:?}");
        };
        entries
            .into_iter()
            .map(|entry| match entry.kind {
                EntryKind::Note { text } => (entry.seq, text),
                other => panic!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn entries_are_kept_in_seq_order_and_replaced_by_seq() {
        let mut readable = ReadableEntries::default();
        let event = readable.apply(&ToDevice::Entries {
            entries: vec![note(2, "B"), note(1, "A")],
            reset: true,
            from: 0,
        });
        assert_eq!(texts(event), vec![(1, "A".into()), (2, "B".into())]);
        let event = readable.apply(&ToDevice::Entries {
            entries: vec![note(2, "B2"), note(3, "C")],
            reset: false,
            from: 0,
        });
        assert_eq!(
            texts(event),
            vec![(1, "A".into()), (2, "B2".into()), (3, "C".into())]
        );
        assert_eq!(readable.highest(), 3);
        // A reset drops what was there.
        let event = readable.apply(&ToDevice::Entries {
            entries: vec![note(9, "Z")],
            reset: true,
            from: 0,
        });
        assert_eq!(texts(event), vec![(9, "Z".into())]);
    }

    #[test]
    fn what_fell_off_the_hosts_window_is_dropped_but_the_older_note_stays() {
        let mut readable = ReadableEntries::default();
        readable.apply(&ToDevice::Entries {
            entries: vec![note(1, "A"), note(2, "B"), note(3, "C")],
            reset: true,
            from: 1,
        });
        let event = readable.apply(&ToDevice::Entries {
            entries: vec![note(0, "Older"), note(4, "D")],
            reset: false,
            from: 3,
        });
        assert_eq!(
            texts(event),
            vec![(0, "Older".into()), (3, "C".into()), (4, "D".into())]
        );
    }

    #[test]
    fn the_summary_apps_read_names_each_kind_and_says_why_entries_are_off() {
        let event = EntriesEvent::Entries(vec![
            Entry {
                seq: 1,
                kind: EntryKind::Step {
                    name: "Bash".into(),
                    target: "cargo test".into(),
                    state: crate::message::StepState::Running,
                },
            },
            Entry {
                seq: 2,
                kind: EntryKind::Claude {
                    text: "Done.".into(),
                    done: true,
                },
            },
        ]);
        assert_eq!(
            serde_json::to_value(readable_summary(&event)).expect("json"),
            serde_json::json!({
                "entries": [
                    {"seq": 1, "kind": "step", "name": "Bash", "target": "cargo test", "state": "running"},
                    {"seq": 2, "kind": "claude", "text": "Done.", "done": true},
                ],
                "unavailable": null,
            })
        );
        let gone = readable_summary(&EntriesEvent::Refused(
            crate::message::RefuseReason::NoSuchSession,
        ));
        assert_eq!(
            gone.unavailable.as_deref(),
            Some(crate::device_view::refusal_words(
                crate::message::RefuseReason::NoSuchSession
            ))
        );
        let off = readable_summary(&EntriesEvent::Unavailable(EntriesUnavailable::CompanionOff));
        assert_eq!(off.entries, Vec::new());
        assert!(off.unavailable.expect("words").contains("Companion"));
    }

    #[test]
    fn a_reports_outcome_is_put_in_the_desktops_words_on_the_device() {
        let report = |seq, outcome, event: &str| Entry {
            seq,
            kind: EntryKind::Report {
                summary: "s".into(),
                outcome,
                event: event.into(),
            },
        };
        let summary = readable_summary(&EntriesEvent::Entries(vec![
            report(1, ReportOutcome::Completed, ""),
            report(2, ReportOutcome::Failed, ""),
            report(3, ReportOutcome::Stopped, ""),
            report(4, ReportOutcome::Event, "Port 3000 is up"),
            report(5, ReportOutcome::Event, ""),
            report(6, ReportOutcome::Update, ""),
        ]));
        let words: Vec<_> = summary
            .entries
            .iter()
            .map(|entry| match &entry.kind {
                ShownKind::Report { outcome, .. } => outcome.as_str(),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            words,
            [
                "Finished",
                "Failed",
                "Stopped",
                "Port 3000 is up",
                "Event",
                "Update"
            ]
        );
    }

    #[test]
    fn unavailable_is_told_and_other_messages_are_not_entries() {
        let mut readable = ReadableEntries::default();
        assert_eq!(
            readable.apply(&ToDevice::EntriesUnavailable {
                reason: EntriesUnavailable::CompanionOff
            }),
            Some(EntriesEvent::Unavailable(EntriesUnavailable::CompanionOff))
        );
        assert_eq!(readable.apply(&ToDevice::Heartbeat { seq: 1, at: 1 }), None);
        assert_eq!(readable.highest(), 0);
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
            question: None,
            activity: None,
            running_since_ms: None,
            turn_summary: None,
            diff: None,
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
                    written: true,
                    write_id: 3,
                },
                t
            ),
            [ScreenEvent::InputAck {
                epoch: EPOCH,
                written: true,
                write_id: 3,
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
        assert_eq!(
            screen.input(EPOCH, b"y".to_vec(), 3),
            None,
            "nothing seen yet"
        );
        screen.on_message(snapshot(9, 4, b"a", false), t);
        screen.on_message(update(9, 5, b"b"), t);
        assert_eq!(
            screen.input(EPOCH, b"y".to_vec(), 3),
            Some(FromDevice::Input {
                run: 9,
                epoch: EPOCH,
                seen_seq: 5,
                bytes: b"y".to_vec(),
                write_id: 3,
            })
        );
    }

    /// The host asks for a snapshot at most once a second: a screen still
    /// without its first one asks again, every second, until it comes.
    #[test]
    fn a_screen_still_without_its_first_snapshot_asks_again() {
        let t = Instant::now();
        let mut screen = SessionScreen::new_at(t).expect("screen");
        assert!(
            !screen.resync_due(t + std::time::Duration::from_millis(500)),
            "not yet"
        );
        assert!(screen.resync_due(t + FIRST_SCREEN_WAIT), "asks");
        assert!(
            !screen.resync_due(t + FIRST_SCREEN_WAIT + std::time::Duration::from_millis(500)),
            "once a wait"
        );
        screen.on_message(snapshot(9, 4, b"a", false), t + FIRST_SCREEN_WAIT * 2);
        assert!(!screen.resync_due(t + FIRST_SCREEN_WAIT * 5), "it came");
    }

    #[test]
    fn compose_names_the_newest_run_told_with_the_screen_on_or_off() {
        let t = Instant::now();
        let mut screen = SessionScreen::new().expect("screen");
        assert_eq!(screen.compose(EPOCH, "hi".into(), 3), None, "no run yet");
        // Reading entries, the screen off: the host names the run.
        screen.on_message(ToDevice::Run { run: 7 }, t);
        let composed = |run| FromDevice::Compose {
            run,
            epoch: EPOCH,
            text: "hi".into(),
            write_id: 3,
        };
        assert_eq!(screen.compose(EPOCH, "hi".into(), 3), Some(composed(7)));
        // The screen on: a snapshot names it.
        screen.on_message(snapshot(9, 4, b"a", false), t);
        assert_eq!(screen.compose(EPOCH, "hi".into(), 3), Some(composed(9)));
        // Off again, and a new run.
        screen.on_message(ToDevice::Run { run: 10 }, t);
        assert_eq!(screen.compose(EPOCH, "hi".into(), 3), Some(composed(10)));
    }

    #[test]
    fn writing_to_claude_needs_typing_and_no_question_showing() {
        let me = [2; 32];
        let view = home_view(me);
        let link = LinkFacts::new(LinkState::Connected);
        let summary = host_summary(&[0xab; 32], &me, &link, &view);
        // s1 holds control but asks a question: answered in the terminal.
        assert!(summary.sessions[0].may_type);
        assert!(!summary.sessions[0].may_compose);
        let mut answered = view.clone();
        answered.sessions[0].dialog_open = false;
        let summary = host_summary(&[0xab; 32], &me, &link, &answered);
        assert!(summary.sessions[0].may_compose);
        // Not held: neither.
        assert!(!summary.sessions[1].may_compose);
    }

    #[test]
    fn a_hosts_path_shows_while_connected_and_when_it_was_heard_while_not() {
        let me = [2; 32];
        let view = home_view(me);
        let link = LinkFacts {
            state: LinkState::Connected,
            path: Some(LinkPath::Relay),
            last_seen_ms: Some(1_000),
        };
        let up = host_summary(&[0xab; 32], &me, &link, &view);
        assert_eq!(up.path, Some(LinkPath::Relay));
        assert_eq!(up.last_seen_ms, None, "only while the link isn't up");
        let lost = LinkFacts {
            state: LinkState::Lost,
            ..link
        };
        let down = host_summary(&[0xab; 32], &me, &lost, &view);
        assert_eq!(down.last_seen_ms, Some(1_000));
        assert_eq!(down.path, None, "no path while the link is down");
    }

    /// A host as the fixture has it: a question asked, a session running.
    fn home_view(me: crate::message::EndpointId) -> HostView {
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
        let session = |id: &str| SessionInfo {
            id: id.into(),
            title: "Fix the build".into(),
            project_id: "p1".into(),
            status: kriyon_core::session::SessionStatus::Running,
            standing: kriyon_core::standing::StandingState::Running,
            needs_you: false,
            dialog_open: false,
            last_change_ms: 5,
            question: None,
            activity: Some("Bash · pnpm test".into()),
            running_since_ms: Some(4),
            turn_summary: None,
            diff: None,
        };
        HostView {
            host_name: Some("Mac".into()),
            role: Some(Role::Controller),
            sessions: vec![
                SessionInfo {
                    status: kriyon_core::session::SessionStatus::Waiting,
                    standing: kriyon_core::standing::StandingState::AwaitingInput,
                    needs_you: true,
                    dialog_open: true,
                    question: Some(crate::message::Question {
                        text: "Which db?".into(),
                        options: vec!["Postgres".into(), "SQLite".into()],
                    }),
                    activity: None,
                    running_since_ms: None,
                    turn_summary: Some("Fixed it.".into()),
                    diff: Some(crate::message::Diff {
                        files: 2,
                        added: 10,
                        removed: 3,
                    }),
                    ..session("s1")
                },
                session("s2"),
            ],
            control,
            refused: None,
            projects: vec![ProjectInfo {
                id: "p1".into(),
                name: "app".into(),
                parked: false,
            }],
            usage: Some(crate::message::PlanUsage {
                five_hour: Some(crate::message::UsageWindow {
                    used_percent: 40,
                    resets_at_ms: Some(9_000),
                }),
                weekly: None,
            }),
        }
    }

    /// One entry of each kind, as the fixture has them.
    fn home_entries() -> EntriesEvent {
        use crate::message::{Entry, EntryKind};
        EntriesEvent::Entries(vec![
            Entry {
                seq: 1,
                kind: EntryKind::You {
                    text: "Fix the login bug".into(),
                },
            },
            Entry {
                seq: 2,
                kind: EntryKind::Claude {
                    text: "The form sends too early".into(),
                    done: false,
                },
            },
            Entry {
                seq: 3,
                kind: EntryKind::Step {
                    name: "Read".into(),
                    target: "src/login.ts".into(),
                    state: crate::message::StepState::Done,
                },
            },
            Entry {
                seq: 4,
                kind: EntryKind::Report {
                    summary: "Waited for the token".into(),
                    outcome: ReportOutcome::Completed,
                    event: String::new(),
                },
            },
            Entry {
                seq: 5,
                kind: EntryKind::Asking {
                    header: "Tests".into(),
                    question: "Fix the failing test too?".into(),
                    options: vec!["Yes".into(), "No".into()],
                },
            },
            Entry {
                seq: 6,
                kind: EntryKind::Note {
                    text: "Context compacted".into(),
                },
            },
        ])
    }

    /// The JSON both apps read, checked in at `src/remote/fixtures/`: the
    /// TypeScript tests load the same file as `HostSummary` and
    /// `ReadableSummary`, so a field renamed on one side fails on the
    /// other. `KRIYON_WRITE_FIXTURES=1` writes it afresh.
    #[test]
    fn the_summaries_match_the_fixture_the_apps_test_against() {
        let me = [2; 32];
        let view = home_view(me);
        let link = LinkFacts {
            state: LinkState::Connected,
            path: Some(LinkPath::Direct),
            last_seen_ms: None,
        };
        let readable = readable_summary(&home_entries());
        let fixture = serde_json::json!({
            "hostSummary": host_summary(&[0xab; 32], &me, &link, &view),
            "readableSummary": readable,
        });
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&fixture).expect("json")
        );
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/remote/fixtures/summaries.json");
        if std::env::var_os("KRIYON_WRITE_FIXTURES").is_some() {
            std::fs::write(&path, &text).expect("written");
        }
        let kept = std::fs::read_to_string(&path).expect("the fixture is checked in");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&kept).expect("json"),
            fixture,
            "src/remote/fixtures/summaries.json is out of date: run this test \
             with KRIYON_WRITE_FIXTURES=1 and update the TypeScript types"
        );
    }

    #[test]
    fn usage_shows_the_window_nearest_its_limit() {
        let window = |used_percent, resets_at_ms| crate::message::UsageWindow {
            used_percent,
            resets_at_ms,
        };
        let shown = |usage| shown_usage(&usage);
        assert_eq!(
            shown(crate::message::PlanUsage {
                five_hour: Some(window(50, Some(1))),
                weekly: Some(window(50, Some(2))),
            }),
            Some(Usage {
                window: "5-hour limit",
                used_percent: 50,
                resets_at_ms: Some(1),
            }),
            "a tie is the 5-hour window"
        );
        assert_eq!(
            shown(crate::message::PlanUsage {
                five_hour: None,
                weekly: Some(window(3, None)),
            })
            .map(|usage| usage.window),
            Some("Weekly limit")
        );
        assert_eq!(shown(crate::message::PlanUsage::default()), None);
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
        let summary = host_summary(&[1; 32], &me, &LinkFacts::new(LinkState::Connected), &view);
        assert!(!summary.may_start, "a Viewer");
        let controller = HostView {
            role: Some(Role::Controller),
            ..view.clone()
        };
        assert!(
            host_summary(
                &[1; 32],
                &me,
                &LinkFacts::new(LinkState::Connected),
                &controller
            )
            .may_start
        );
        assert!(
            !host_summary(&[1; 32], &me, &LinkFacts::new(LinkState::Lost), &controller).may_start
        );
        let no_projects = HostView {
            projects: vec![],
            ..controller
        };
        assert!(
            !host_summary(
                &[1; 32],
                &me,
                &LinkFacts::new(LinkState::Connected),
                &no_projects
            )
            .may_start
        );
        assert_eq!(typing(&Holder::Host, &me), Typing::Host);
        assert_eq!(typing(&Holder::Device(me), &me), Typing::You);
        assert_eq!(typing(&Holder::Device([9; 32]), &me), Typing::Other);
    }
}
