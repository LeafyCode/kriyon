//! Serving paired [Remote device]s (plan Step C): their control stream
//! (`Hello` → `Welcome`, heartbeats, session status) and one stream per
//! session they open, fed by each session's [Session fan-out].
//!
//! Tauri-free: what it needs from the app comes through [`ServeHost`], and
//! the daemon's events come in through [`Serve::on_event`] from each
//! session's [Daemon client] reader, which must never wait here: everything
//! it touches is a short lock or a wake-up, and the network writes happen on
//! the streams' own tasks.
//!
//! Lock order, outermost first: a session's gate (the app's session writers) → the
//! control map (`Inner::controls`) → a device's `ControlOut` queue. The
//! writers call [`Serve::broadcast_control`] under a gate's lock, so it only
//! takes the two inner locks and never calls the app ([`ServeHost`]).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::framed::{MessageReader, MessageWriter};
use crate::host::RemoteLink;
use kriyon_core::cli_dialog::DialogState;
use kriyon_remote::authorize::{
    authorize, Dialog, HostFacts, PendingWrite, ProjectFolder, SessionView, Stream,
};
use kriyon_remote::codec::{encode, Decoded};
use kriyon_remote::compress::Packer;
use kriyon_remote::control::{Change, Control};
use kriyon_remote::entries::{EntryBook, EntryReader};
use kriyon_remote::fanout::{pack_snapshot, Pop, RequesterId, SessionFanout, SnapshotToPack};
use kriyon_remote::link_policy::CloseCode;
use kriyon_remote::message::{
    EndpointId, EntriesUnavailable, FromDevice, PlanUsage, ProjectInfo, RefuseReason, Role,
    SessionInfo, ToDevice,
};
use kriyon_remote::queue::{ControlQueue, CONTROL_QUEUE_LIMIT, SESSION_QUEUE_LIMIT};
use parking_lot::Mutex;
use tokio::sync::Notify;

use kriyon_core::daemon::DaemonEvent;

/// Whether `message` is a write (typing, compose, resize): its answer is
/// what the device waits on, as it would on an `InputAck`.
fn is_write(message: &Decoded<FromDevice>) -> bool {
    write_id(message).is_some()
}

/// `message` with an `Input`'s `seen_seq` held to `sent`, the newest update
/// the device was given (none: 0): a device can't have drawn more, so it
/// can't claim to have seen a dialog it never got.
fn held_to_sent(message: Decoded<FromDevice>, sent: Option<u64>) -> Decoded<FromDevice> {
    match message {
        Decoded::Message(FromDevice::Input {
            run,
            epoch,
            seen_seq,
            bytes,
            write_id,
        }) => Decoded::Message(FromDevice::Input {
            run,
            epoch,
            seen_seq: seen_seq.min(sent.unwrap_or(0)),
            bytes,
            write_id,
        }),
        other => other,
    }
}

/// The device's id for `message` if it is a write: its answer carries it.
fn write_id(message: &Decoded<FromDevice>) -> Option<u32> {
    match message {
        Decoded::Message(message) => write_id_of(message),
        Decoded::Unknown { .. } => None,
    }
}

fn write_id_of(message: &FromDevice) -> Option<u32> {
    match message {
        FromDevice::Input { write_id, .. }
        | FromDevice::Compose { write_id, .. }
        | FromDevice::Resize { write_id, .. } => Some(*write_id),
        _ => None,
    }
}

/// A refusal of `message`: a write's names it ([`ToDevice::WriteRefused`]).
fn refused(message: &Decoded<FromDevice>, reason: RefuseReason) -> ToDevice {
    match write_id(message) {
        Some(write_id) => ToDevice::WriteRefused { write_id, reason },
        None => ToDevice::Refused { reason },
    }
}

/// The first 8 hex digits of a device's id: enough to tell devices apart in
/// a log, and no more of it.
fn short_id(device: &EndpointId) -> String {
    kriyon_remote::message::hex(&device[..4])
}

/// The least time between two notices to the app of one device asking for
/// control of one session.
const CONTROL_ASK_EVERY: Duration = Duration::from_secs(5);

/// How often the main loop's tick looks at the project list.
const PROJECTS_EVERY: std::time::Duration = std::time::Duration::from_secs(10);

pub use kriyon_remote::message::{MIN_PROTOCOL_MINOR, PROTOCOL_MINOR};

/// One live session as the host's one check sees it.
#[derive(Clone, Debug)]
pub struct LiveSession {
    pub run: u64,
    pub control: Control,
    pub dialog: Dialog,
    pub size: (u16, u16),
}

/// What serving needs from the app.
pub trait ServeHost: Send + Sync + 'static {
    /// The name `Welcome` gives the host.
    fn host_name(&self) -> String;
    /// The host's [Session list].
    fn sessions(&self) -> Vec<SessionInfo>;
    /// A live session (its daemon named its run), for the check.
    fn session(&self, id: &str) -> Option<LiveSession>;
    /// Whether any remote device has session `id` open (an [Onlooker]).
    fn set_onlooked(&self, id: &str, onlooked: bool);
    /// Keep paired `device`'s push token, sealed to the sender's key
    /// `key_id` (spec §10), in place of any it gave before.
    fn set_push_token(&self, device: &EndpointId, key_id: u32, sealed: Vec<u8>);
    /// Delete `device`'s sealed push token: it turned its alerts off.
    fn forget_push_token(&self, device: &EndpointId);
    /// A Controller asked for control of session `id` and the host's
    /// ten-second rule refused it: the person can let it type. Called at
    /// most once per `CONTROL_ASK_EVERY` for a device and session.
    fn control_asked(&self, _id: &str, _device: &EndpointId) {}
    /// Session `id`'s [Readable view] entries (`kriyon_core::readable`), or
    /// `Unchanged` when nothing they come from changed since the build
    /// `stamp` names. Blocking: it may read the transcript. None by default.
    fn entries(&self, _id: &str, _stamp: Option<u64>) -> EntriesBuilt {
        EntriesBuilt::Unavailable(EntriesUnavailable::CompanionOff)
    }
    /// A line for the host's log (stderr unless told otherwise). Never given
    /// a message's payload.
    fn log(&self, line: &str) {
        eprintln!("{line}");
    }
    /// The projects a session can be started in, for devices' pickers.
    fn projects(&self) -> Vec<ProjectInfo>;
    /// The host account's [Plan limits], as the desktop shows them. Read on
    /// every tick: from memory, never a file. None known by default.
    fn usage(&self) -> PlanUsage {
        PlanUsage::default()
    }
    /// Saved project `project_id`'s folder, checked against the [Approved
    /// root]s, for a remote start's check.
    fn project_folder(&self, project_id: &str) -> ProjectFolder;
    /// The session `device`'s start `request_id` already made, if any (kept a
    /// day): a resend gets it back.
    fn started(
        &self,
        device: &EndpointId,
        request_id: &[u8; 16],
    ) -> Option<Result<String, RefuseReason>>;
    /// Start a session as `device` asked (its check already passed): the
    /// new session's id, or the one this request already started.
    fn start_session(
        &self,
        device: EndpointId,
        start: RemoteStart,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, RefuseReason>> + Send>>;
    /// A device's typing into session `id`, checked again atomically with
    /// the write: whether it reached the PTY.
    ///
    /// # Errors
    /// Why it was refused.
    fn device_input(
        &self,
        id: &str,
        device: &EndpointId,
        role: Role,
        write: &PendingWrite,
        bytes: &[u8],
    ) -> Result<bool, RefuseReason>;
    /// A device's resize of session `id`, checked again likewise: whether
    /// the PTY took it.
    ///
    /// # Errors
    /// Why it was refused.
    fn device_resize(
        &self,
        id: &str,
        device: &EndpointId,
        role: Role,
        write: &PendingWrite,
        size: (u16, u16),
    ) -> Result<bool, RefuseReason>;
    /// `device` takes [Typing control] of session `id`. Every change of
    /// control, this one included, is the host's to tell every device
    /// ([`Serve::broadcast_control`]), whatever made it.
    ///
    /// # Errors
    /// `NotInControl` while the host typed in the last 10 s; `NoSuchSession`
    /// for one that closed.
    fn take(&self, id: &str, device: EndpointId, role: Role) -> Result<(), RefuseReason>;
    /// `device`'s role now: the one its connection was made with, never
    /// more than the person has left it since (removed: `None`). Read by
    /// every check, so a removal or demotion counts at once, before its
    /// connection closes.
    fn role_now(&self, device: &EndpointId, connected: Role) -> Option<Role>;
    /// `device` went away: control of every session it held goes back to the
    /// host, which tells every device. May block.
    fn release(&self, device: &EndpointId);
    /// `device` gives back control of session `id`, if it holds it: as
    /// [`ServeHost::release`] for that one session. May block.
    fn give_back(&self, id: &str, device: &EndpointId);
}

/// What a daemon event changed that the session's gate must hear.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EventNote {
    /// The daemon named a [Session run].
    pub run: Option<u64>,
    /// A dialog appeared, changed or closed: its state now, and the `seq` of
    /// the update that drew it.
    pub dialog: Option<(DialogState, u64)>,
}

/// One served session: its fan-out, how to ask its daemon for a snapshot,
/// its size now, and the writer task of every device stream on it.
struct Served {
    fanout: Mutex<SessionFanout>,
    ask: Box<dyn Fn(RequesterId) + Send + Sync>,
    size: Box<dyn Fn() -> (u16, u16) + Send + Sync>,
    wakers: Mutex<HashMap<EndpointId, Arc<Notify>>>,
    /// The session closed: its device streams finish.
    ended: std::sync::atomic::AtomicBool,
    /// Snapshots to compress, on the session's own packing thread (one
    /// thread, one compressor, reused), never the daemon's reader.
    packs: Mutex<Option<std::sync::mpsc::SyncSender<SnapshotToPack>>>,
    /// The devices reading the session as [Readable view] entries, and the
    /// entries, numbered. Lock order: readers, then the book, then the
    /// fan-out.
    readers: Mutex<HashMap<EndpointId, EntryReader>>,
    book: Mutex<EntryBook>,
    /// The session's entries thread is running ([`reading`]).
    reading: std::sync::atomic::AtomicBool,
}

impl Served {
    /// Bring every reader up to the book: through each device's session
    /// queue, beside its screen. A queue dropped since starts its reader
    /// over; one that overflows asks for a fresh snapshot and starts over
    /// at the next round.
    fn send_entries(&self) {
        let mut readers = self.readers.lock();
        let book = self.book.lock();
        let mut asks = Vec::new();
        let mut sent = Vec::new();
        for (device, reader) in readers.iter_mut() {
            let mut fanout = self.fanout.lock();
            if fanout.dropped(device) {
                reader.start_over();
            }
            let messages = reader.next(&book);
            if messages.is_empty() {
                continue;
            }
            for frame in messages.iter().filter_map(|message| encode(message).ok()) {
                if let Err(ask) = fanout.send(device, frame) {
                    // Its queue was dropped: what is left goes next round,
                    // from a reset.
                    asks.extend(ask);
                    fanout.dropped(device);
                    reader.start_over();
                    break;
                }
            }
            sent.push(*device);
        }
        drop(book);
        drop(readers);
        self.ask_all(asks);
        self.wake(&sent);
    }

    /// Tell every reader there are no entries, and forget them: each asks
    /// again when it reopens the readable view.
    fn entries_unavailable(&self, reason: EntriesUnavailable) {
        let readers: Vec<EndpointId> = self
            .readers
            .lock()
            .drain()
            .map(|(device, _)| device)
            .collect();
        let Ok(frame) = encode(&ToDevice::EntriesUnavailable { reason }) else {
            return;
        };
        let mut asks = Vec::new();
        {
            let mut fanout = self.fanout.lock();
            for device in &readers {
                asks.extend(fanout.send(device, frame.clone()).err().flatten());
            }
        }
        self.ask_all(asks);
        self.wake(&readers);
    }

    fn wake(&self, devices: &[EndpointId]) {
        let wakers = self.wakers.lock();
        for device in devices {
            if let Some(wake) = wakers.get(device) {
                wake.notify_one();
            }
        }
    }
}

/// How often a session being read is looked at for new or changed entries:
/// at most two batches a second per device (spec §6).
pub const ENTRIES_EVERY: Duration = Duration::from_millis(500);

/// The entries thread of `served`, session `id`: while a device reads it,
/// build its entries when they changed and send each reader what it lacks.
/// It ends when nobody reads, or the session went.
fn reading(served: &std::sync::Weak<Served>, host: &Arc<dyn ServeHost>, id: &str) {
    let mut stamp = None;
    loop {
        let Some(served) = served.upgrade() else {
            return;
        };
        if served.ended.load(Ordering::Relaxed) || served.readers.lock().is_empty() {
            served.reading.store(false, Ordering::Relaxed);
            // A reader that came in meanwhile keeps this going, unless it
            // started a thread of its own.
            if served.ended.load(Ordering::Relaxed)
                || served.readers.lock().is_empty()
                || served.reading.swap(true, Ordering::Relaxed)
            {
                return;
            }
        }
        match host.entries(id, stamp) {
            EntriesBuilt::Unchanged | EntriesBuilt::Waiting => {}
            EntriesBuilt::Unavailable(reason) => {
                stamp = None;
                served.entries_unavailable(reason);
            }
            EntriesBuilt::Built {
                stamp: now,
                entries,
            } => {
                stamp = Some(now);
                served.book.lock().update(entries);
            }
        }
        served.send_entries();
        drop(served);
        std::thread::sleep(ENTRIES_EVERY);
    }
}

/// What building a session's [Readable view] entries came to.
#[derive(Debug)]
pub enum EntriesBuilt {
    /// Nothing changed since the build `stamp` names.
    Unchanged,
    /// Not yet: the companion is starting.
    Waiting,
    /// None can be built (exact or off).
    Unavailable(EntriesUnavailable),
    /// Built: `stamp` names this build, for the next call.
    Built {
        stamp: u64,
        entries: Vec<kriyon_core::readable::Keyed>,
    },
}

/// The packing thread of `served`: snapshots in, queued for their devices.
/// It ends when the session is detached or dropped (its sender goes).
fn packing(served: &std::sync::Weak<Served>, snapshots: std::sync::mpsc::Receiver<SnapshotToPack>) {
    let Ok(mut packer) = Packer::new() else {
        return;
    };
    for snapshot in snapshots {
        let Some(served) = served.upgrade() else {
            return;
        };
        let frames = pack_snapshot(&mut packer, &snapshot);
        let again = served.fanout.lock().snapshot_packed(&snapshot, frames);
        served.ask_all(again.into_iter().collect());
        served.wake_all();
    }
}

impl Served {
    fn ask_all(&self, asks: Vec<RequesterId>) {
        for id in asks {
            (self.ask)(id);
        }
    }

    fn wake_all(&self) {
        for wake in self.wakers.lock().values() {
            wake.notify_one();
        }
    }
}

/// Snapshots waiting to be packed, at most, for one session.
const PACKS_WAITING: usize = 4;

/// A device's control stream, as the host writes to it.
struct ControlOut {
    queue: Mutex<ControlQueue>,
    wake: Notify,
    link: Arc<RemoteLink>,
}

impl ControlOut {
    /// Queue `message`; a queue that is full closes the connection: the
    /// device is too slow to keep up even with status.
    fn send(&self, message: &ToDevice) {
        let Ok(frame) = encode(message) else {
            return;
        };
        if self.queue.lock().push(frame).is_err() {
            self.link.close(CloseCode::TooSlow);
        }
        self.wake.notify_one();
    }
}

struct Inner {
    host: Arc<dyn ServeHost>,
    sessions: Mutex<HashMap<String, Arc<Served>>>,
    controls: Mutex<HashMap<EndpointId, Arc<ControlOut>>>,
    heartbeat_seq: AtomicU64,
    /// The session list as devices last heard it, in the host's order;
    /// `None` while no device is connected.
    heard: Mutex<Option<Vec<SessionInfo>>>,
    /// The project list as devices last heard it.
    heard_projects: Mutex<Option<Vec<ProjectInfo>>>,
    /// The plan's use as devices last heard it.
    heard_usage: Mutex<Option<PlanUsage>>,
    /// When the tick last looked at the project list: it changes seldom, and
    /// looking checks every project's folder.
    projects_looked: Mutex<Option<Instant>>,
    /// When each (session, device) last had its ask for control told to the
    /// app: a device asking in a loop costs a notice now and then.
    control_asks: Mutex<HashMap<(String, EndpointId), Instant>>,
    /// Refusals answered per device, rate-limited (spec §8).
    refusals: Mutex<kriyon_remote::link_policy::RateLimit<EndpointId>>,
}

/// Serving every paired device's streams. Cheap to clone.
#[derive(Clone)]
pub struct Serve(Arc<Inner>);

/// A remote start a device asked for, past its check. Never a worktree:
/// worktree setup runs scripts, so a remote start doesn't ask for one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteStart {
    /// The device's id for this start, so a resend returns the same session.
    pub request_id: kriyon_remote::message::RequestId,
    pub project_id: String,
    pub title: Option<String>,
}

/// The facts one message is checked against, owned, so no lock is held
/// across the check.
struct Facts {
    device: EndpointId,
    role: Option<Role>,
    live: Option<(String, LiveSession)>,
    /// The folder of the project a `StartSession` names.
    folder: Option<(String, ProjectFolder)>,
}

impl HostFacts for Facts {
    fn role(&self, device: &EndpointId) -> Option<Role> {
        self.role.filter(|_| *device == self.device)
    }

    fn session(&self, id: &str) -> Option<SessionView<'_>> {
        let (live_id, live) = self.live.as_ref()?;
        (live_id == id).then_some(SessionView {
            run: live.run,
            control: &live.control,
            dialog: live.dialog,
            cols: live.size.0,
            rows: live.size.1,
        })
    }

    fn project_folder(&self, project_id: &str) -> ProjectFolder {
        self.folder
            .as_ref()
            .filter(|(id, _)| id == project_id)
            .map_or(ProjectFolder::NoSuchProject, |(_, folder)| *folder)
    }

    fn min_protocol_minor(&self) -> u16 {
        MIN_PROTOCOL_MINOR
    }
}

/// The session a message names, for the facts it is checked against.
fn named_session<'a>(stream: Option<&'a str>, message: &'a Decoded<FromDevice>) -> Option<&'a str> {
    match message {
        Decoded::Message(
            FromDevice::Open { session_id, .. } | FromDevice::TakeControl { session_id },
        ) => Some(session_id),
        _ => stream,
    }
}

impl Serve {
    #[must_use]
    pub fn new(host: Arc<dyn ServeHost>) -> Self {
        Self(Arc::new(Inner {
            host,
            sessions: Mutex::new(HashMap::new()),
            controls: Mutex::new(HashMap::new()),
            heartbeat_seq: AtomicU64::new(0),
            heard: Mutex::new(None),
            heard_projects: Mutex::new(None),
            heard_usage: Mutex::new(None),
            projects_looked: Mutex::new(None),
            control_asks: Mutex::default(),
            refusals: Mutex::new(kriyon_remote::link_policy::RateLimit::new(
                kriyon_remote::link_policy::REFUSALS_PER_WINDOW,
                kriyon_remote::link_policy::REFUSAL_WINDOW,
            )),
        }))
    }

    /// Serve session `id`: `ask` asks its daemon for a snapshot for a
    /// requester (and must not wait: it is called from the daemon reader),
    /// `size` is its screen size now. Once per session: again keeps what is
    /// served.
    pub fn attach(
        &self,
        id: &str,
        ask: impl Fn(RequesterId) + Send + Sync + 'static,
        size: impl Fn() -> (u16, u16) + Send + Sync + 'static,
    ) {
        let mut sessions = self.0.sessions.lock();
        // A session started again (a reattach) keeps its devices' streams.
        if sessions.contains_key(id) {
            return;
        }
        let Ok(fanout) = SessionFanout::new(SESSION_QUEUE_LIMIT) else {
            return;
        };
        let served = Arc::new(Served {
            fanout: Mutex::new(fanout),
            ask: Box::new(ask),
            size: Box::new(size),
            wakers: Mutex::new(HashMap::new()),
            ended: std::sync::atomic::AtomicBool::new(false),
            packs: Mutex::new(None),
            readers: Mutex::default(),
            book: Mutex::default(),
            reading: std::sync::atomic::AtomicBool::new(false),
        });
        // A few waiting at most: one that finds it full is dropped, and its
        // device asks again (its screen re-asks on a timer).
        let (packs, snapshots) = std::sync::mpsc::sync_channel(PACKS_WAITING);
        let weak = Arc::downgrade(&served);
        if std::thread::Builder::new()
            .name("kriyon-remote-pack".into())
            .spawn(move || packing(&weak, snapshots))
            .is_ok()
        {
            *served.packs.lock() = Some(packs);
        }
        sessions.insert(id.to_string(), served);
    }

    /// Stop serving session `id`: it closed. Its device streams end.
    pub fn detach(&self, id: &str) {
        let served = self.0.sessions.lock().remove(id);
        if let Some(served) = served {
            served.ended.store(true, Ordering::Relaxed);
            served.packs.lock().take();
            served.wake_all();
        }
    }

    /// Every session a remote device has open: [Onlooker]s for auto-sleep,
    /// and woken like the desktop's focused session.
    #[must_use]
    pub fn onlooked_sessions(&self) -> Vec<String> {
        let sessions: Vec<(String, Arc<Served>)> = self
            .0
            .sessions
            .lock()
            .iter()
            .map(|(id, served)| (id.clone(), Arc::clone(served)))
            .collect();
        sessions
            .into_iter()
            .filter(|(_, served)| served.fanout.lock().open_count() > 0)
            .map(|(id, _)| id)
            .collect()
    }

    /// Whether any device is connected now: it sees what needs you for
    /// itself, so no phone needs waking.
    #[must_use]
    pub fn has_devices(&self) -> bool {
        !self.0.controls.lock().is_empty()
    }

    /// Whether `device` has session `id` open now.
    #[must_use]
    pub fn has_open(&self, id: &str, device: &EndpointId) -> bool {
        self.served(id)
            .is_some_and(|served| served.fanout.lock().is_open(device))
    }

    /// Whether `device` has a connection served now.
    fn has_control(&self, device: &EndpointId) -> bool {
        self.0.controls.lock().contains_key(device)
    }

    /// Whether a remote device has session `id` open.
    #[must_use]
    pub fn is_onlooked(&self, id: &str) -> bool {
        self.served(id)
            .is_some_and(|served| served.fanout.lock().open_count() > 0)
    }

    fn served(&self, id: &str) -> Option<Arc<Served>> {
        self.0.sessions.lock().get(id).cloned()
    }

    /// One event from session `id`'s daemon, in order. Called from its
    /// reader thread: never waits.
    #[must_use]
    pub fn on_event(&self, id: &str, event: DaemonEvent<'_>) -> EventNote {
        let Some(served) = self.served(id) else {
            return EventNote::default();
        };
        let mut note = EventNote::default();
        // Asked before the fan-out lock: it takes the session's gate lock.
        let size = matches!(event, DaemonEvent::SnapshotEnd { .. }).then(|| (served.size)());
        let asks = {
            let mut fanout = served.fanout.lock();
            match event {
                DaemonEvent::Hello { run } => {
                    note.run = Some(run);
                    fanout.hello(run)
                }
                DaemonEvent::Output(bytes) => fanout.output(bytes),
                DaemonEvent::Screen(_) => fanout.screen(),
                DaemonEvent::Dialog(state) => {
                    note.dialog = fanout.dialog(state.generation).map(|at| (state, at));
                    Vec::new()
                }
                DaemonEvent::Snapshot { id, bytes } => {
                    fanout.snapshot_part(id, bytes);
                    Vec::new()
                }
                DaemonEvent::SnapshotEnd { id } => {
                    // Compressing a big screen takes a while: never on the
                    // daemon's reader, never under this lock.
                    let snapshot = fanout
                        .snapshot_end(id, size.unwrap_or(kriyon_remote::writer::DEFAULT_SCREEN));
                    let unsent = snapshot.and_then(|snapshot| match served.packs.lock().as_ref() {
                        // Too many waiting, or no packing thread: it counts
                        // as not packed, its held updates go, and it is asked
                        // for again (through the device's gate).
                        Some(packs) => match packs.try_send(snapshot) {
                            Ok(()) => None,
                            Err(
                                std::sync::mpsc::TrySendError::Full(snapshot)
                                | std::sync::mpsc::TrySendError::Disconnected(snapshot),
                            ) => Some(snapshot),
                        },
                        None => Some(snapshot),
                    });
                    // Not packed: asked for again, through the gate.
                    unsent
                        .and_then(|snapshot| fanout.snapshot_packed(&snapshot, None))
                        .into_iter()
                        .collect()
                }
                DaemonEvent::Busy(_)
                | DaemonEvent::History { .. }
                | DaemonEvent::HistoryEnd { .. } => Vec::new(),
            }
        };
        served.ask_all(asks);
        served.wake_all();
        note
    }

    /// Send every device a heartbeat: called from the app's main loop, so it
    /// proves the app is alive, not just the socket.
    pub fn heartbeat(&self, at_ms: u64) {
        let seq = self.0.heartbeat_seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.broadcast(&ToDevice::Heartbeat { seq, at: at_ms });
    }

    /// Tell every device about sessions whose entry changed since they last
    /// heard; a session that went away sends the whole list.
    pub fn sessions_changed(&self) {
        // Nobody to tell: no list built. The next device starts from Welcome.
        if self.0.controls.lock().is_empty() {
            *self.0.heard.lock() = None;
            *self.0.heard_projects.lock() = None;
            *self.0.heard_usage.lock() = None;
            return;
        }
        let due = {
            let mut looked = self.0.projects_looked.lock();
            let due = looked.is_none_or(|at| at.elapsed() >= PROJECTS_EVERY);
            if due {
                *looked = Some(Instant::now());
            }
            due
        };
        if due {
            self.projects_changed();
        }
        let usage = self.0.host.usage();
        let usage_changed = self.0.heard_usage.lock().replace(usage) != Some(usage);
        if usage_changed {
            self.broadcast(&ToDevice::Usage { usage });
        }
        let now = self.0.host.sessions();
        let mut guard = self.0.heard.lock();
        let heard = guard.get_or_insert_with(Vec::new);
        // Devices keep the host's order: a status changes a session in
        // place or adds it at the end, so anything else is the whole list.
        let in_place =
            heard.len() <= now.len() && heard.iter().zip(&now).all(|(was, is)| was.id == is.id);
        let changed: Vec<SessionInfo> = now
            .iter()
            .enumerate()
            .filter(|(at, info)| heard.get(*at) != Some(*info))
            .map(|(_, info)| info.clone())
            .collect();
        *heard = now;
        let list = (!in_place).then(|| heard.clone());
        drop(guard);
        if let Some(sessions) = list {
            self.broadcast(&ToDevice::SessionList { sessions });
        } else {
            for session in changed {
                self.broadcast(&ToDevice::SessionStatus { session });
            }
        }
    }

    /// Tell every device the project list if it changed since they heard it.
    /// The tick looks every [`PROJECTS_EVERY`]; call it at once when a
    /// project, or the approved roots, changed. Blocking: not on the runtime.
    pub fn projects_changed(&self) {
        let now = self.0.host.projects();
        let mut heard = self.0.heard_projects.lock();
        if heard.as_ref() == Some(&now) {
            return;
        }
        *heard = Some(now.clone());
        drop(heard);
        self.broadcast(&ToDevice::ProjectList { projects: now });
    }

    /// Every device hears who holds [Typing control] of session `id` now.
    pub fn broadcast_control(&self, id: &str, change: Change) {
        self.broadcast(&ToDevice::Control {
            session_id: id.to_string(),
            holder: change.holder,
            epoch: change.epoch,
        });
    }

    fn broadcast(&self, message: &ToDevice) {
        let controls: Vec<Arc<ControlOut>> = self.0.controls.lock().values().cloned().collect();
        for control in controls {
            control.send(message);
        }
    }

    /// Whether to answer refusing `device` for `reason` on `stream`: logged
    /// (the reason, the stream and the device's short id, never the
    /// payload), and at most `REFUSALS_PER_WINDOW` logged and answered per
    /// `REFUSAL_WINDOW` (spec §8). The log says once when a device goes
    /// over, not for every refusal after. Always answered past the limit:
    /// a refused write (`answers_write`: the device waits on its answer as
    /// it would on an `InputAck`) and `NotPaired`, which a removed device
    /// must hear.
    fn refusal(
        &self,
        device: &EndpointId,
        reason: RefuseReason,
        stream: &str,
        answers_write: bool,
    ) -> bool {
        let always = answers_write || reason == RefuseReason::NotPaired;
        let now = Instant::now();
        let mut limit = self.0.refusals.lock();
        if limit.over(device, now) {
            return always;
        }
        limit.record(*device, now);
        let now_over = limit.over(device, now);
        drop(limit);
        let who = short_id(device);
        self.0.host.log(&format!(
            "kriyon: remote: refused {reason:?} on the {stream} stream, device {who}"
        ));
        if now_over {
            self.0.host.log(&format!(
                "kriyon: remote: device {who} is refused too often; more refusals go unanswered for a while"
            ));
        }
        true
    }

    /// Tell the app `device` asked for control of session `id`, at most once
    /// per `CONTROL_ASK_EVERY` for the pair.
    async fn control_asked(&self, id: String, device: EndpointId) {
        let now = Instant::now();
        {
            let mut asks = self.0.control_asks.lock();
            asks.retain(|_, at| now.saturating_duration_since(*at) < CONTROL_ASK_EVERY);
            let key = (id.clone(), device);
            if asks.contains_key(&key) {
                return;
            }
            asks.insert(key, now);
        }
        self.blocking(move |host| host.control_asked(&id, &device))
            .await;
    }

    /// Run `call` on the app, off the async runtime: any [`ServeHost`] call
    /// may wait (the store, a session's gate, its daemon's socket), and a
    /// connection's tasks must never hold a runtime thread while it does.
    /// `None` only if the blocking pool failed.
    async fn blocking<T: Send + 'static>(
        &self,
        call: impl FnOnce(&dyn ServeHost) -> T + Send + 'static,
    ) -> Option<T> {
        let host = Arc::clone(&self.0.host);
        tokio::task::spawn_blocking(move || call(host.as_ref()))
            .await
            .ok()
    }

    /// The facts a message from `device` is checked against. Its role is the
    /// one it connected with, never more than the person has left it since;
    /// it counts as paired while its control stream is served, which ends
    /// when removal closes its connection (`hello`: the stream that is being
    /// opened).
    async fn facts(
        &self,
        device: EndpointId,
        role: Role,
        session: Option<&str>,
        hello: bool,
    ) -> Facts {
        let paired = hello || self.0.controls.lock().contains_key(&device);
        let session = session.map(str::to_string);
        let (role, live) = self
            .blocking(move |host| {
                let role = paired
                    .then_some(role)
                    .and_then(|role| host.role_now(&device, role));
                let live = session.and_then(|id| {
                    let live = host.session(&id)?;
                    Some((id, live))
                });
                (role, live)
            })
            .await
            .unwrap_or((None, None));
        Facts {
            device,
            role,
            live,
            folder: None,
        }
    }

    /// Serve one paired device's connection until it closes. Its role is the
    /// one it connected with: a role change or removal closes the connection.
    pub async fn serve(self, link: Arc<RemoteLink>) {
        let device = link.device();
        let role = link.role();
        let Ok((writer, reader)) = link.accept_stream().await else {
            return;
        };
        let Some((out, tasks)) = self.welcome(&link, device, role, writer, reader).await else {
            return;
        };
        loop {
            tokio::select! {
                stream = link.accept_stream() => match stream {
                    Ok((writer, reader)) => {
                        tokio::spawn(self.clone().serve_session(device, role, writer, reader));
                    }
                    Err(_) => break,
                },
                () = link.closed() => break,
            }
        }
        for task in tasks {
            task.abort();
        }
        // Only this connection's entry: the device may have reconnected.
        let ours = {
            let mut controls = self.0.controls.lock();
            let ours = controls
                .get(&device)
                .is_some_and(|held| Arc::ptr_eq(held, &out));
            if ours {
                controls.remove(&device);
            }
            ours
        };
        // Whatever it held goes back to the host (spec §5): input it buffered
        // before the drop can never land. Not if it is already back on a new
        // connection.
        if ours {
            let serve = self.clone();
            let _ = tokio::task::spawn_blocking(move || {
                // Not if it is back already: a release now would take away
                // control its new connection took.
                if !serve.has_control(&device) {
                    serve.0.host.release(&device);
                }
            })
            .await;
        }
    }

    /// Read the control stream's `Hello` and answer it: `Welcome`, or a
    /// refusal (and, for an app too old, a close). Then serve the stream.
    async fn welcome(
        &self,
        link: &Arc<RemoteLink>,
        device: EndpointId,
        role: Role,
        mut writer: MessageWriter<ToDevice>,
        mut reader: MessageReader<FromDevice>,
    ) -> Option<(Arc<ControlOut>, [tokio::task::JoinHandle<()>; 2])> {
        let first = reader.next().await.ok()??;
        let verdict = authorize(
            &device,
            Stream::Control,
            &first,
            &self.facts(device, role, None, true).await,
            Instant::now(),
        )
        .and(match first {
            Decoded::Message(FromDevice::Hello { .. }) => Ok(()),
            _ => Err(RefuseReason::NotAllowed),
        });
        if let Err(reason) = verdict {
            let _ = writer.send(&ToDevice::Refused { reason }).await;
            writer.finish();
            if matches!(reason, RefuseReason::TooOld { .. }) {
                link.close(CloseCode::TooOld);
            }
            return None;
        }
        let (sessions, host_name, projects, usage) = self
            .blocking(|host| {
                (
                    host.sessions(),
                    host.host_name(),
                    host.projects(),
                    host.usage(),
                )
            })
            .await?;
        writer
            .send(&ToDevice::Welcome {
                host_name,
                protocol_minor: PROTOCOL_MINOR,
                role,
                sessions: sessions.clone(),
            })
            .await
            .ok()?;
        // Then where a session can be started, and the plan's use: Viewers
        // hear them too.
        writer
            .send(&ToDevice::ProjectList {
                projects: projects.clone(),
            })
            .await
            .ok()?;
        writer.send(&ToDevice::Usage { usage }).await.ok()?;
        let out = Arc::new(ControlOut {
            queue: Mutex::new(ControlQueue::new(CONTROL_QUEUE_LIMIT)),
            wake: Notify::new(),
            link: Arc::clone(link),
        });
        let replaced = self.0.controls.lock().insert(device, Arc::clone(&out));
        // A device that dialed again before the host saw its old connection
        // end gives back what it held now (spec §5): the old connection's
        // end won't, since it is no longer the device's entry.
        if replaced.is_some() {
            let host = Arc::clone(&self.0.host);
            let _ = tokio::task::spawn_blocking(move || host.release(&device)).await;
        }
        self.catch_up(&out, sessions, projects, usage);
        let writing = tokio::spawn(write_control(writer, Arc::clone(&out)));
        let serve = self.clone();
        let reading_out = Arc::clone(&out);
        let reading = tokio::spawn(async move {
            serve.read_control(device, role, reader, reading_out).await;
        });
        Some((out, [writing, reading]))
    }

    /// A device just welcomed with `sessions`, `projects` and `usage`, as
    /// read then, hears what the other devices heard since (a tick while it
    /// was being welcomed), so the changes after reach it as they reach the
    /// others. A first device's lists become what devices heard.
    fn catch_up(
        &self,
        out: &ControlOut,
        sessions: Vec<SessionInfo>,
        projects: Vec<ProjectInfo>,
        usage: PlanUsage,
    ) {
        if let Some(sessions) = heard_since(&self.0.heard, sessions) {
            out.send(&ToDevice::SessionList { sessions });
        }
        if let Some(projects) = heard_since(&self.0.heard_projects, projects) {
            out.send(&ToDevice::ProjectList { projects });
        }
        if let Some(usage) = heard_since(&self.0.heard_usage, usage) {
            out.send(&ToDevice::Usage { usage });
        }
    }

    /// Answer what a device sends on its control stream.
    async fn read_control(
        &self,
        device: EndpointId,
        role: Role,
        mut reader: MessageReader<FromDevice>,
        out: Arc<ControlOut>,
    ) {
        while let Ok(Some(message)) = reader.next().await {
            if let Decoded::Message(FromDevice::StartSession { request_id, .. }) = &message {
                let request_id = *request_id;
                // On its own task: it reads the store, and a shell takes a
                // moment to open; the control stream keeps being read.
                tokio::spawn(self.clone().start(
                    device,
                    role,
                    message,
                    request_id,
                    Arc::clone(&out),
                ));
                continue;
            }
            let facts = self
                .facts(device, role, named_session(None, &message), false)
                .await;
            let checked = authorize(&device, Stream::Control, &message, &facts, Instant::now());
            let asked = match &message {
                Decoded::Message(FromDevice::TakeControl { session_id }) => {
                    Some(session_id.clone())
                }
                _ => None,
            };
            let verdict = match (checked, message) {
                (Err(reason), _) => Err(reason),
                (Ok(()), Decoded::Message(FromDevice::TakeControl { session_id })) => self
                    .blocking(move |host| host.take(&session_id, device, role))
                    .await
                    .unwrap_or(Err(RefuseReason::NotAllowed)),
                (Ok(()), Decoded::Message(FromDevice::PushToken { key_id, sealed })) => {
                    self.blocking(move |host| host.set_push_token(&device, key_id, sealed))
                        .await;
                    Ok(())
                }
                (Ok(()), Decoded::Message(FromDevice::ForgetPushToken)) => {
                    self.blocking(move |host| host.forget_push_token(&device))
                        .await;
                    Ok(())
                }
                (Ok(()), Decoded::Message(FromDevice::ReleaseControl { session_id })) => {
                    self.blocking(move |host| host.give_back(&session_id, &device))
                        .await;
                    Ok(())
                }
                (Ok(()), _) => Ok(()),
            };
            if let (Some(asked), Err(RefuseReason::NotInControl)) = (asked, verdict) {
                // The host's ten-second rule: the person can let it type.
                self.control_asked(asked, device).await;
            }
            if let Err(reason) = verdict {
                if self.refusal(&device, reason, "control", false) {
                    out.send(&ToDevice::Refused { reason });
                }
            }
        }
    }

    /// Answer one `StartSession`: the session this request already made (a
    /// resend), else the check, then the start. Every answer names the
    /// request: `StartResult`, or `StartRefused`.
    async fn start(
        self,
        device: EndpointId,
        role: Role,
        message: Decoded<FromDevice>,
        request_id: kriyon_remote::message::RequestId,
        out: Arc<ControlOut>,
    ) {
        let Decoded::Message(FromDevice::StartSession {
            project_id,
            title,
            worktree,
            ..
        }) = &message
        else {
            return;
        };
        let asked = (project_id.clone(), *worktree);
        let looked = self
            .blocking(move |host| {
                let (project_id, worktree) = asked;
                // Asked only of a Controller: what it already started is its own.
                let made = (role == Role::Controller)
                    .then(|| host.started(&device, &request_id))
                    .flatten();
                // Looked up only where the check gets that far.
                let folder = (made.is_none() && role == Role::Controller && !worktree)
                    .then(|| (project_id.clone(), host.project_folder(&project_id)));
                (made, folder)
            })
            .await;
        let Some((made, folder)) = looked else {
            return;
        };
        let refused = |reason| ToDevice::StartRefused { request_id, reason };
        if let Some(made) = made {
            // A resend: the same answer the first one got.
            out.send(&match made {
                Ok(session_id) => ToDevice::StartResult {
                    request_id,
                    session_id,
                },
                Err(reason) => refused(reason),
            });
            return;
        }
        let mut facts = self.facts(device, role, None, false).await;
        facts.folder = folder;
        if let Err(reason) = authorize(&device, Stream::Control, &message, &facts, Instant::now()) {
            out.send(&refused(reason));
            return;
        }
        let started = self
            .0
            .host
            .start_session(
                device,
                RemoteStart {
                    request_id,
                    project_id: project_id.clone(),
                    title: title.clone(),
                },
            )
            .await;
        out.send(&match started {
            Ok(session_id) => ToDevice::StartResult {
                request_id,
                session_id,
            },
            Err(reason) => refused(reason),
        });
    }

    /// The first message on a session stream, `Open`, checked: the session
    /// served, its id, and the device's waker; `None` once refused (the
    /// refusal sent, the stream finished).
    async fn open_stream(
        &self,
        device: EndpointId,
        role: Role,
        first: &Decoded<FromDevice>,
        writer: &mut MessageWriter<ToDevice>,
    ) -> Option<(Arc<Served>, String, Arc<Notify>)> {
        let opened = authorize(
            &device,
            Stream::Unopened,
            first,
            &self
                .facts(device, role, named_session(None, first), false)
                .await,
            Instant::now(),
        )
        .and_then(|()| match first {
            Decoded::Message(FromDevice::Open { session_id, screen }) => {
                Ok((session_id.clone(), *screen))
            }
            _ => Err(RefuseReason::NotAllowed),
        })
        .and_then(|(id, screen)| {
            Ok((
                self.served(&id).ok_or(RefuseReason::NoSuchSession)?,
                id,
                screen,
            ))
        });
        let (served, id, screen) = match opened {
            Ok(opened) => opened,
            Err(reason) => {
                let _ = writer.send(&ToDevice::Refused { reason }).await;
                writer.finish();
                return None;
            }
        };
        let wake = Arc::new(Notify::new());
        let opened = {
            let mut fanout = served.fanout.lock();
            // Once per device: two streams would share, and split, one queue.
            (!fanout.is_open(&device)).then(|| {
                let ask = if screen {
                    fanout.open(device)
                } else {
                    // Its entries only: no screen until it turns it on.
                    fanout.open_without_screen(device);
                    None
                };
                (ask, fanout.open_count())
            })
        };
        let Some((ask, open)) = opened else {
            let _ = writer
                .send(&ToDevice::Refused {
                    reason: RefuseReason::NotAllowed,
                })
                .await;
            writer.finish();
            return None;
        };
        served.wakers.lock().insert(device, Arc::clone(&wake));
        if open == 1 {
            let looked_at = id.clone();
            self.blocking(move |host| host.set_onlooked(&looked_at, true))
                .await;
        }
        // An older daemon can't make a snapshot for one device: nothing to
        // show it but a refusal.
        match ask {
            Some(ask) => (served.ask)(ask),
            None if screen => {
                self.close_session(&served, &id, &device);
                let _ = writer
                    .send(&ToDevice::Refused {
                        reason: RefuseReason::NotAllowed,
                    })
                    .await;
                writer.finish();
                return None;
            }
            None => {}
        }
        Some((served, id, wake))
    }

    /// Serve one session stream: its `Open`, then the session's screen, until
    /// the device closes it or the session ends.
    async fn serve_session(
        self,
        device: EndpointId,
        role: Role,
        mut writer: MessageWriter<ToDevice>,
        mut reader: MessageReader<FromDevice>,
    ) {
        let Ok(Some(first)) = reader.next().await else {
            return;
        };
        let Some((served, id, wake)) = self.open_stream(device, role, &first, &mut writer).await
        else {
            return;
        };
        let (answers, answered) = tokio::sync::mpsc::channel::<ToDevice>(8);
        let writing = tokio::spawn(write_session(
            writer,
            Arc::clone(&served),
            device,
            Arc::clone(&wake),
            answered,
        ));
        while let Ok(Some(message)) = reader.next().await {
            // What it says it drew, held to what it was sent.
            let message = held_to_sent(message, served.fanout.lock().sent_seq(&device));
            let facts = self.facts(device, role, Some(&id), false).await;
            let checked = authorize(
                &device,
                Stream::Session(&id),
                &message,
                &facts,
                Instant::now(),
            );
            let answers_write = is_write(&message);
            let answer = match (checked, message) {
                (Err(reason), message) => Some(refused(&message, reason)),
                (Ok(()), Decoded::Message(message)) => {
                    if self.stream_request(&served, &id, device, &message) {
                        None
                    } else {
                        self.write(&id, device, role, &message).await
                    }
                }
                (Ok(()), Decoded::Unknown { .. }) => Some(ToDevice::Refused {
                    reason: RefuseReason::UnknownMessage,
                }),
            };
            if let Some(answer) = answer {
                self.answer_on_session(&device, answer, answers_write, &answers, &wake)
                    .await;
            }
        }
        writing.abort();
        self.close_session(&served, &id, &device);
    }

    /// Send `answer` on a session stream: a refusal only within its rate
    /// ([`Self::refusal`]). The answer to a write always goes, waiting for
    /// room (the device waits on it); other answers past a handful waiting
    /// are dropped, not queued.
    async fn answer_on_session(
        &self,
        device: &EndpointId,
        answer: ToDevice,
        answers_write: bool,
        answers: &tokio::sync::mpsc::Sender<ToDevice>,
        wake: &Notify,
    ) {
        if let ToDevice::Refused { reason } | ToDevice::WriteRefused { reason, .. } = &answer {
            if !self.refusal(device, *reason, "session", answers_write) {
                return;
            }
        }
        if answers_write {
            wake.notify_one();
            let _ = answers.send(answer).await;
        } else {
            let _ = answers.try_send(answer);
        }
        wake.notify_one();
    }

    /// A device's typing, compose or resize, past `authorize`: through the
    /// session's writer, which checks again atomically with the write. The
    /// answer: an `InputAck` (the bytes reached the PTY, or not) or a refusal.
    async fn write(
        &self,
        id: &str,
        device: EndpointId,
        role: Role,
        message: &FromDevice,
    ) -> Option<ToDevice> {
        let (Some(write), Some(write_id)) = (PendingWrite::of(message), write_id_of(message))
        else {
            return Some(ToDevice::Refused {
                reason: RefuseReason::NotAllowed,
            });
        };
        // The writer's lock and the PTY write can wait: off the async runtime.
        let call = |bytes: Vec<u8>, size: Option<(u16, u16)>| {
            let id = id.to_string();
            async move {
                self.blocking(move |host| match size {
                    Some(size) => host.device_resize(&id, &device, role, &write, size),
                    None => host.device_input(&id, &device, role, &write, &bytes),
                })
                .await
                .unwrap_or(Err(RefuseReason::NotAllowed))
            }
        };
        let outcome = match message {
            FromDevice::Input { bytes, .. } => call(bytes.clone(), None).await,
            FromDevice::Compose { text, .. } => {
                // The same keys the desktop's composer sends, with its waits.
                // A key that didn't reach the PTY ends it: what follows (the
                // Enter) must not go in without it. A compose cut off partway
                // leaves the keys before the cut typed.
                let mut written = true;
                for key in kriyon_core::attachment::keystrokes(text, &[]) {
                    match call(key.text.into_bytes(), None).await {
                        Ok(true) => {}
                        Ok(false) => {
                            written = false;
                            break;
                        }
                        Err(reason) => return Some(ToDevice::WriteRefused { write_id, reason }),
                    }
                    if key.wait_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(key.wait_ms)).await;
                    }
                }
                Ok(written)
            }
            // Acked like typing: whether the PTY took the size.
            FromDevice::Resize { cols, rows, .. } => call(Vec::new(), Some((*cols, *rows))).await,
            _ => Err(RefuseReason::NotAllowed),
        };
        Some(match outcome {
            Ok(written) => ToDevice::InputAck {
                epoch: write.epoch,
                written,
                write_id,
            },
            Err(reason) => ToDevice::WriteRefused { write_id, reason },
        })
    }

    /// A device's `Resync` (a fresh snapshot), `Screen` (turn its screen on
    /// or off), `RequestEntries` (start reading entries) or `StopEntries` on
    /// session `id`'s stream, done; `false` for any other message (a write).
    fn stream_request(
        &self,
        served: &Arc<Served>,
        id: &str,
        device: EndpointId,
        request: &FromDevice,
    ) -> bool {
        match request {
            FromDevice::RequestEntries { .. } => {
                served.readers.lock().insert(device, EntryReader::new());
                self.start_reading(served, id);
            }
            FromDevice::StopEntries => {
                // Its entries thread ends once nobody reads.
                served.readers.lock().remove(&device);
            }
            FromDevice::Resync => {
                let ask = served.fanout.lock().resync(&device, Instant::now());
                if let Some(ask) = ask {
                    (served.ask)(ask);
                }
            }
            FromDevice::Screen { on } => {
                // Before the daemon names its run, its hello asks for the
                // snapshot: nothing to answer now.
                let ask = served.fanout.lock().set_screen(&device, *on);
                if let Some(ask) = ask {
                    (served.ask)(ask);
                }
                // Turned off, it is told the run: sent now.
                served.wake(&[device]);
            }
            _ => return false,
        }
        true
    }

    /// Start session `id`'s entries thread, unless it runs.
    fn start_reading(&self, served: &Arc<Served>, id: &str) {
        if served.reading.swap(true, Ordering::Relaxed) {
            return;
        }
        let weak = Arc::downgrade(served);
        let host = Arc::clone(&self.0.host);
        let id = id.to_string();
        let started = std::thread::Builder::new()
            .name("kriyon-remote-entries".into())
            .spawn(move || reading(&weak, &host, &id));
        if started.is_err() {
            served.reading.store(false, Ordering::Relaxed);
        }
    }

    fn close_session(&self, served: &Served, id: &str, device: &EndpointId) {
        served.readers.lock().remove(device);
        let open = {
            let mut fanout = served.fanout.lock();
            fanout.close(device);
            fanout.open_count()
        };
        served.wakers.lock().remove(device);
        // Not if the session is served afresh and a device opened it there
        // (a stream of the old one ending late).
        if open == 0 && !self.is_onlooked(id) {
            // Off the runtime (it tells the session's daemon); not awaited,
            // as this ends a stream's task.
            let host = Arc::clone(&self.0.host);
            let id = id.to_string();
            tokio::task::spawn_blocking(move || host.set_onlooked(&id, false));
        }
    }
}

/// What devices heard, if it isn't `told` (what a joining device was just
/// told); when nothing was heard yet, `told` becomes it.
fn heard_since<T: Clone + PartialEq>(heard: &Mutex<Option<T>>, told: T) -> Option<T> {
    let mut heard = heard.lock();
    match heard.as_ref() {
        None => {
            *heard = Some(told);
            None
        }
        Some(heard) => (*heard != told).then(|| heard.clone()),
    }
}

/// Write a device's control queue out as it fills.
async fn write_control(mut writer: MessageWriter<ToDevice>, out: Arc<ControlOut>) {
    loop {
        let next = out.queue.lock().pop();
        match next {
            Some(frame) => {
                if writer.send_encoded(&frame).await.is_err() {
                    return;
                }
            }
            None => out.wake.notified().await,
        }
    }
}

/// Write one device's session stream out: its queue in the fan-out, and the
/// answers to what it sent (acks, refusals).
async fn write_session(
    mut writer: MessageWriter<ToDevice>,
    served: Arc<Served>,
    device: EndpointId,
    wake: Arc<Notify>,
    mut answered: tokio::sync::mpsc::Receiver<ToDevice>,
) {
    loop {
        while let Ok(answer) = answered.try_recv() {
            if writer.send(&answer).await.is_err() {
                return;
            }
        }
        let next = served.fanout.lock().pop(&device);
        match next {
            Pop::Frame(frame) => {
                if writer.send_encoded(&frame).await.is_err() {
                    return;
                }
            }
            Pop::Ask(ask) => (served.ask)(ask),
            Pop::Empty => {
                if served.ended.load(Ordering::Relaxed) {
                    writer.finish();
                    return;
                }
                wake.notified().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::device::DeviceLink;
    use kriyon_remote::compress::{decompress, Kind};
    use kriyon_remote::message::{Epoch, Holder};

    use super::*;
    use kriyon_core::session::SessionStatus;
    use kriyon_core::standing::StandingState;
    use kriyon_remote::message::{Entry, EntryKind};

    use crate::test_support::host_world::*;

    #[test]
    fn an_opened_session_shows_its_snapshot_then_its_updates() {
        run(async {
            let world = world().await;
            let (_phone, link, _cw, _cr) = device(&world, 3, Role::Viewer).await;
            let (_sw, mut sr) = open(&link).await;
            let id = asked(&world).await;
            assert!(
                world.fake.onlooked.lock().contains("s"),
                "a device looks on"
            );
            answer(&world, id, b"the screen");
            let ToDevice::Snapshot {
                run,
                bytes,
                skipped,
                ..
            } = next(&mut sr).await
            else {
                panic!("a snapshot first")
            };
            assert_eq!((run, skipped), (1, false));
            assert_eq!(
                decompress(Kind::Snapshot, &bytes).expect("snapshot"),
                b"the screen"
            );
            let _ = world.serve.on_event("s", DaemonEvent::Output(b"typed"));
            let ToDevice::Update { seq, bytes, .. } = next(&mut sr).await else {
                panic!("an update")
            };
            assert_eq!(seq, 1);
            assert_eq!(decompress(Kind::Update, &bytes).expect("update"), b"typed");
        });
    }

    #[test]
    fn a_slow_device_skips_ahead_while_a_fast_one_follows() {
        run(async {
            let world = world().await;
            let (_a, fast_link, _acw, _acr) = device(&world, 3, Role::Viewer).await;
            let (_b, slow_link, _bcw, _bcr) = device(&world, 4, Role::Viewer).await;
            let (_fw, mut fast) = open(&fast_link).await;
            let first = asked(&world).await;
            answer(&world, first, b"a");
            let (_sw, mut slow) = open(&slow_link).await;
            let second = asked(&world).await;
            answer(&world, second, b"b");
            assert!(matches!(next(&mut fast).await, ToDevice::Snapshot { .. }));
            assert!(matches!(next(&mut slow).await, ToDevice::Snapshot { .. }));
            // Incompressible output, far past the per-device queue, while the
            // slow device reads nothing and the fast one reads everything.
            let mut noise = 1_u64;
            let total = 3 * SESSION_QUEUE_LIMIT / 4096;
            for _ in 0..total {
                let chunk: Vec<u8> = (0..4096)
                    .map(|_| {
                        noise = noise
                            .wrapping_mul(6_364_136_223_846_793_005)
                            .wrapping_add(1);
                        noise.to_le_bytes()[7]
                    })
                    .collect();
                let _ = world.serve.on_event("s", DaemonEvent::Output(&chunk));
                let ToDevice::Update { .. } = next(&mut fast).await else {
                    panic!("the fast device follows every update")
                };
            }
            // The slow one starts over from a fresh snapshot, marked skipped.
            let resnap = asked(&world).await;
            answer(&world, resnap, b"now");
            let mut skipped = false;
            for _ in 0..(total + 2) {
                if let ToDevice::Snapshot { skipped: true, .. } = next(&mut slow).await {
                    skipped = true;
                    break;
                }
            }
            assert!(skipped, "the slow device was told it skipped ahead");
        });
    }

    #[test]
    fn a_session_that_does_not_exist_is_refused() {
        run(async {
            let world = world().await;
            let (_phone, link, _cw, _cr) = device(&world, 3, Role::Controller).await;
            let (mut writer, mut reader) = link.open_stream().await.expect("stream");
            writer
                .send(&FromDevice::Open {
                    session_id: "nope".into(),
                    screen: true,
                })
                .await
                .expect("open");
            assert_eq!(
                next(&mut reader).await,
                ToDevice::Refused {
                    reason: RefuseReason::NoSuchSession
                }
            );
        });
    }

    #[test]
    fn every_device_hears_the_project_list_when_it_changes() {
        run(async {
            let world = world().await;
            let (_v, _vl, _vw, mut viewer) = device(&world, 3, Role::Viewer).await;
            let renamed = vec![kriyon_remote::message::ProjectInfo {
                id: "p".into(),
                name: "renamed".into(),
                parked: true,
            }];
            *world.fake.projects.lock() = renamed.clone();
            world.serve.sessions_changed();
            let mut heard = None;
            for _ in 0..3 {
                if let ToDevice::ProjectList { projects } = next(&mut viewer).await {
                    heard = Some(projects);
                    break;
                }
            }
            assert_eq!(heard, Some(renamed), "a Viewer hears it too");
            // Looked at again only every so often by the tick, or at once
            // when told a project changed.
            let again = vec![kriyon_remote::message::ProjectInfo {
                id: "p".into(),
                name: "again".into(),
                parked: false,
            }];
            *world.fake.projects.lock() = again.clone();
            world.serve.sessions_changed();
            world.serve.heartbeat(8);
            assert!(matches!(
                next(&mut viewer).await,
                ToDevice::Heartbeat { at: 8, .. }
            ));
            world.serve.projects_changed();
            assert_eq!(
                next(&mut viewer).await,
                ToDevice::ProjectList { projects: again }
            );
            // Unchanged: not sent again.
            world.serve.sessions_changed();
            world.serve.heartbeat(9);
            assert!(matches!(
                next(&mut viewer).await,
                ToDevice::Heartbeat { at: 9, .. }
            ));
        });
    }

    #[test]
    fn the_plans_use_is_told_after_welcome_and_when_it_changes() {
        run(async {
            let world = world().await;
            let (_phone, _link, _cw, mut cr) = device(&world, 3, Role::Viewer).await;
            let used = kriyon_remote::message::PlanUsage {
                five_hour: Some(kriyon_remote::message::UsageWindow {
                    used_percent: 40,
                    resets_at_ms: Some(9_000),
                }),
                weekly: None,
            };
            *world.fake.usage.lock() = used;
            world.serve.sessions_changed();
            loop {
                match next(&mut cr).await {
                    ToDevice::Usage { usage } => {
                        assert_eq!(usage, used);
                        break;
                    }
                    ToDevice::SessionStatus { .. } | ToDevice::ProjectList { .. } => {}
                    other => panic!("{other:?}"),
                }
            }
            // Unchanged: not sent again.
            world.serve.sessions_changed();
            world.serve.heartbeat(9);
            assert!(matches!(
                next(&mut cr).await,
                ToDevice::Heartbeat { at: 9, .. }
            ));
        });
    }

    #[test]
    fn heartbeats_and_session_changes_reach_every_device() {
        run(async {
            let world = world().await;
            let (_phone, _link, _cw, mut cr) = device(&world, 3, Role::Viewer).await;
            world.serve.sessions_changed();
            world.serve.heartbeat(1234);
            // The first status change since Welcome is the whole entry of
            // every session the device hasn't heard through this path.
            let mut saw_heartbeat = false;
            for _ in 0..3 {
                match next(&mut cr).await {
                    ToDevice::Heartbeat { seq: 1, at: 1234 } => {
                        saw_heartbeat = true;
                        break;
                    }
                    ToDevice::SessionStatus { .. } => {}
                    other => panic!("{other:?}"),
                }
            }
            assert!(saw_heartbeat);
            *world.fake.title.lock() = "renamed".into();
            world.serve.sessions_changed();
            assert!(matches!(
                next(&mut cr).await,
                ToDevice::SessionStatus { session } if session.title == "renamed"
            ));
        });
    }

    #[test]
    fn a_device_joining_never_hides_a_change_from_the_others() {
        run(async {
            let world = world().await;
            let session = |id: &str| SessionInfo {
                id: id.into(),
                title: id.into(),
                project_id: "p".into(),
                status: SessionStatus::Idle,
                standing: StandingState::Idle,
                needs_you: false,
                dialog_open: false,
                last_change_ms: 0,
                question: None,
                activity: None,
                running_since_ms: None,
                turn_summary: None,
                diff: None,
            };
            // The first device hears no sessions; one starts before the
            // next tick, and a second device joins in between.
            *world.fake.sessions.lock() = Some(vec![]);
            let (_one, _l1, _w1, mut first) = device(&world, 3, Role::Viewer).await;
            *world.fake.sessions.lock() = Some(vec![session("t")]);
            let (_two, _l2, _w2, _second) = device(&world, 4, Role::Viewer).await;
            world.serve.sessions_changed();
            world.serve.heartbeat(7);
            let mut heard = Vec::new();
            loop {
                match next(&mut first).await {
                    ToDevice::SessionList { sessions } => heard = sessions,
                    ToDevice::SessionStatus { session } => heard.push(session),
                    ToDevice::Heartbeat { at: 7, .. } => break,
                    _ => {}
                }
            }
            assert_eq!(heard, vec![session("t")]);
        });
    }

    #[test]
    fn devices_hear_the_sessions_in_the_hosts_order() {
        run(async {
            let world = world().await;
            let session = |id: &str| SessionInfo {
                id: id.into(),
                title: id.into(),
                project_id: "p".into(),
                status: SessionStatus::Idle,
                standing: StandingState::Idle,
                needs_you: false,
                dialog_open: false,
                last_change_ms: 0,
                question: None,
                activity: None,
                running_since_ms: None,
                turn_summary: None,
                diff: None,
            };
            let ids = |list: &[SessionInfo]| -> Vec<String> {
                list.iter().map(|info| info.id.clone()).collect()
            };
            let order: Vec<SessionInfo> = ["m", "z", "a", "q", "b"].map(session).into();
            *world.fake.sessions.lock() = Some(order.clone());
            let (_phone, _link, _cw, mut cr) = device(&world, 3, Role::Viewer).await;
            // Its list as the host keeps it (longest-waiting first, as the
            // desktop shows it), however it changes.
            let mut reordered = order.clone();
            reordered.reverse();
            *world.fake.sessions.lock() = Some(reordered.clone());
            world.serve.sessions_changed();
            loop {
                match next(&mut cr).await {
                    ToDevice::SessionList { sessions } => {
                        assert_eq!(ids(&sessions), ids(&reordered));
                        break;
                    }
                    ToDevice::ProjectList { .. } | ToDevice::SessionStatus { .. } => {}
                    other => panic!("{other:?}"),
                }
            }
            // One gone: the rest, still in order.
            reordered.remove(1);
            *world.fake.sessions.lock() = Some(reordered.clone());
            world.serve.sessions_changed();
            loop {
                match next(&mut cr).await {
                    ToDevice::SessionList { sessions } => {
                        assert_eq!(ids(&sessions), ids(&reordered));
                        break;
                    }
                    ToDevice::ProjectList { .. } | ToDevice::SessionStatus { .. } => {}
                    other => panic!("{other:?}"),
                }
            }
        });
    }

    #[test]
    fn a_removed_device_is_cut_off_mid_stream_and_stops_looking_on() {
        run(async {
            let world = world().await;
            let (phone, link, _cw, _cr) = device(&world, 3, Role::Viewer).await;
            let (_sw, mut sr) = open(&link).await;
            let id = asked(&world).await;
            answer(&world, id, b"x");
            assert!(matches!(next(&mut sr).await, ToDevice::Snapshot { .. }));
            world.fake.paired.lock().remove(&phone.id());
            world.host.cut_off(&phone.id());
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(10), link.closed())
                    .await
                    .expect("closed"),
                Some(CloseCode::NotPaired)
            );
            let deadline = Instant::now() + Duration::from_secs(10);
            while world.fake.onlooked.lock().contains("s") {
                assert!(Instant::now() < deadline, "still counted as looking on");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
    }

    #[test]
    fn a_viewers_typing_is_refused() {
        run(async {
            let world = world().await;
            let (_phone, link, _cw, _cr) = device(&world, 3, Role::Viewer).await;
            let (mut sw, mut sr) = open(&link).await;
            let id = asked(&world).await;
            answer(&world, id, b"x");
            assert!(matches!(next(&mut sr).await, ToDevice::Snapshot { .. }));
            sw.send(&FromDevice::Input {
                run: 1,
                epoch: Epoch {
                    host_boot_id: 5,
                    counter: 0,
                },
                seen_seq: 0,
                bytes: b"rm -rf".to_vec(),
                write_id: 1,
            })
            .await
            .expect("input");
            assert_eq!(
                next(&mut sr).await,
                ToDevice::WriteRefused {
                    write_id: 1,
                    reason: RefuseReason::NotAllowed
                }
            );
        });
    }

    #[test]
    fn a_device_asking_for_control_while_the_host_types_is_told_to_the_person_once_a_while() {
        run(async {
            let world = world().await;
            let (_phone, _link, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            world.fake.gate.lock().host_input(Instant::now());
            for _ in 0..10 {
                cw.send(&FromDevice::TakeControl {
                    session_id: "s".into(),
                })
                .await
                .expect("take");
            }
            for _ in 0..10 {
                assert_eq!(
                    next(&mut cr).await,
                    ToDevice::Refused {
                        reason: RefuseReason::NotInControl
                    }
                );
            }
            let asks = world.fake.control_asks.lock().clone();
            assert_eq!(asks.len(), 1, "{asks:?}");
            assert_eq!(asks[0].0, "s");
        });
    }

    fn note(key: &str, text: &str) -> kriyon_core::readable::Keyed {
        kriyon_core::readable::Keyed {
            key: key.into(),
            kind: EntryKind::Note { text: text.into() },
        }
    }

    /// The next `Entries` or `EntriesUnavailable` on a session stream,
    /// past screen frames.
    async fn next_entries(sr: &mut MessageReader<ToDevice>) -> ToDevice {
        loop {
            let message = next(sr).await;
            if matches!(
                message,
                ToDevice::Entries { .. } | ToDevice::EntriesUnavailable { .. }
            ) {
                return message;
            }
        }
    }

    #[test]
    fn a_viewer_reading_a_session_gets_its_entries_then_only_what_changed() {
        run(async {
            let world = world().await;
            *world.fake.entries.lock() = Ok(vec![note("a", "A")]);
            let (_phone, link, _cw, _cr) = device(&world, 3, Role::Viewer).await;
            let (mut sw, mut sr) = open(&link).await;
            let id = asked(&world).await;
            answer(&world, id, b"x");
            sw.send(&FromDevice::RequestEntries { since: 0 })
                .await
                .expect("asked");
            let ToDevice::Entries { entries, reset, .. } = next_entries(&mut sr).await else {
                panic!("entries");
            };
            assert!(reset);
            assert_eq!(entries.len(), 1);
            *world.fake.entries.lock() = Ok(vec![note("a", "A"), note("b", "B")]);
            let ToDevice::Entries { entries, reset, .. } = next_entries(&mut sr).await else {
                panic!("entries");
            };
            assert!(!reset);
            assert_eq!(
                entries,
                vec![Entry {
                    seq: 2,
                    kind: EntryKind::Note { text: "B".into() }
                }]
            );
            // Unchanged: not built again.
            let builds = world.fake.builds.load(std::sync::atomic::Ordering::Relaxed);
            tokio::time::sleep(ENTRIES_EVERY * 3).await;
            assert_eq!(
                world.fake.builds.load(std::sync::atomic::Ordering::Relaxed),
                builds
            );
        });
    }

    /// A Viewer flipping its screen on and off, or on and on, can't make
    /// the host take many snapshots: at most one a second.
    #[test]
    fn a_screen_flipped_on_and_off_in_a_loop_asks_for_one_snapshot_a_second() {
        run(async {
            let world = world().await;
            let (_phone, link, _cw, _cr) = device(&world, 3, Role::Viewer).await;
            let (mut sw, _sr) = open_with(&link, false).await;
            for _ in 0..30 {
                sw.send(&FromDevice::Screen { on: true }).await.expect("on");
                sw.send(&FromDevice::Screen { on: true }).await.expect("on");
                sw.send(&FromDevice::Screen { on: false })
                    .await
                    .expect("off");
            }
            sw.send(&FromDevice::Screen { on: true }).await.expect("on");
            tokio::time::sleep(Duration::from_millis(300)).await;
            let asks = world.asks.lock().len();
            assert_eq!(asks, 1, "{asks} snapshots asked for");
        });
    }

    #[test]
    fn a_session_opened_for_its_entries_sends_no_screen_until_turned_on() {
        run(async {
            let world = world().await;
            *world.fake.entries.lock() = Ok(vec![note("a", "A")]);
            let (_phone, link, _cw, _cr) = device(&world, 3, Role::Viewer).await;
            let (mut sw, mut sr) = open_with(&link, false).await;
            // No screen, but its run, to write to Claude from its entries.
            assert_eq!(next(&mut sr).await, ToDevice::Run { run: 1 });
            sw.send(&FromDevice::RequestEntries { since: 0 })
                .await
                .expect("asked");
            assert!(matches!(next(&mut sr).await, ToDevice::Entries { .. }));
            assert!(world.fake.onlooked.lock().contains("s"), "an onlooker");
            assert!(world.asks.lock().is_empty(), "no snapshot asked for");
            let _ = world.serve.on_event("s", DaemonEvent::Output(b"unseen"));
            // On: a snapshot, then output.
            sw.send(&FromDevice::Screen { on: true }).await.expect("on");
            let id = asked(&world).await;
            answer(&world, id, b"screen");
            assert!(matches!(next(&mut sr).await, ToDevice::Snapshot { .. }));
            let _ = world.serve.on_event("s", DaemonEvent::Output(b"seen"));
            assert!(matches!(next(&mut sr).await, ToDevice::Update { .. }));
            // Off: no more output, but the run again; the entries go on.
            sw.send(&FromDevice::Screen { on: false })
                .await
                .expect("off");
            assert_eq!(next(&mut sr).await, ToDevice::Run { run: 1 });
            let _ = world.serve.on_event("s", DaemonEvent::Output(b"unseen"));
            *world.fake.entries.lock() = Ok(vec![note("a", "A"), note("b", "B")]);
            assert!(
                matches!(next(&mut sr).await, ToDevice::Entries { .. }),
                "not an update"
            );
        });
    }

    #[test]
    fn a_device_that_stops_reading_gets_no_more_entries_and_nothing_is_built_for_it() {
        run(async {
            let world = world().await;
            *world.fake.entries.lock() = Ok(vec![note("a", "A")]);
            let (_phone, link, _cw, _cr) = device(&world, 3, Role::Viewer).await;
            let (mut sw, mut sr) = open(&link).await;
            let id = asked(&world).await;
            answer(&world, id, b"x");
            sw.send(&FromDevice::RequestEntries { since: 0 })
                .await
                .expect("asked");
            assert!(matches!(
                next_entries(&mut sr).await,
                ToDevice::Entries { .. }
            ));
            sw.send(&FromDevice::StopEntries).await.expect("stopped");
            tokio::time::sleep(ENTRIES_EVERY * 2).await;
            let builds = world.fake.builds.load(std::sync::atomic::Ordering::Relaxed);
            *world.fake.entries.lock() = Ok(vec![note("a", "A"), note("b", "B")]);
            tokio::time::sleep(ENTRIES_EVERY * 3).await;
            assert_eq!(
                world.fake.builds.load(std::sync::atomic::Ordering::Relaxed),
                builds,
                "nobody reads: nothing built"
            );
            // The stream is still served: a resync still gets a screen, and
            // no entries came before it.
            sw.send(&FromDevice::Resync).await.expect("resync");
            let id = asked(&world).await;
            answer(&world, id, b"y");
            loop {
                match next(&mut sr).await {
                    ToDevice::Snapshot { .. } => break,
                    ToDevice::Entries { .. } => panic!("entries after stopping"),
                    _ => {}
                }
            }
        });
    }

    #[test]
    fn with_the_companion_off_a_device_is_told_entries_are_unavailable() {
        run(async {
            let world = world().await;
            *world.fake.entries.lock() = Err(EntriesUnavailable::CompanionOff);
            let (_phone, link, _cw, _cr) = device(&world, 3, Role::Controller).await;
            let (mut sw, mut sr) = open(&link).await;
            let id = asked(&world).await;
            answer(&world, id, b"x");
            sw.send(&FromDevice::RequestEntries { since: 0 })
                .await
                .expect("asked");
            assert_eq!(
                next_entries(&mut sr).await,
                ToDevice::EntriesUnavailable {
                    reason: EntriesUnavailable::CompanionOff
                }
            );
        });
    }

    #[test]
    fn every_refused_write_is_answered_however_many_there_are() {
        // The answer to a write is what the device waits on, instead of
        // an InputAck: the refusal limit never drops one.
        run(async {
            let world = world().await;
            let (_phone, link, _cw, _cr) = device(&world, 3, Role::Viewer).await;
            let (mut sw, mut sr) = open(&link).await;
            let id = asked(&world).await;
            answer(&world, id, b"x");
            assert!(matches!(next(&mut sr).await, ToDevice::Snapshot { .. }));
            let writes = kriyon_remote::link_policy::REFUSALS_PER_WINDOW + 10;
            let epoch = Epoch {
                host_boot_id: 5,
                counter: 0,
            };
            for _ in 0..writes {
                sw.send(&typing(epoch, 0, b"x")).await.expect("input");
            }
            for _ in 0..writes {
                assert_eq!(
                    next(&mut sr).await,
                    ToDevice::WriteRefused {
                        write_id: 1,
                        reason: RefuseReason::NotAllowed
                    }
                );
            }
        });
    }

    #[test]
    fn closing_a_session_ends_its_device_streams() {
        run(async {
            let world = world().await;
            let (_phone, link, _cw, _cr) = device(&world, 3, Role::Viewer).await;
            let (_sw, mut sr) = open(&link).await;
            let id = asked(&world).await;
            answer(&world, id, b"x");
            assert!(matches!(next(&mut sr).await, ToDevice::Snapshot { .. }));
            world.serve.detach("s");
            let ended = tokio::time::timeout(Duration::from_secs(10), sr.next())
                .await
                .expect("the stream ends");
            assert!(matches!(ended, Ok(None) | Err(_)), "{ended:?}");
        });
    }

    #[test]
    fn a_device_opens_a_session_once() {
        run(async {
            let world = world().await;
            let (_phone, link, _cw, _cr) = device(&world, 3, Role::Viewer).await;
            let (_first_w, _first_r) = open(&link).await;
            let _ = asked(&world).await;
            let (_second_w, mut second) = open(&link).await;
            assert_eq!(
                next(&mut second).await,
                ToDevice::Refused {
                    reason: RefuseReason::NotAllowed
                }
            );
        });
    }

    #[test]
    fn a_device_that_reconnects_is_served_after_its_old_connection_goes() {
        run(async {
            let world = world().await;
            let (phone, old, _ocw, _ocr) = device(&world, 3, Role::Viewer).await;
            let new = phone.connect(world.host.addr()).await.expect("reconnect");
            let (mut cw, mut cr) = new.open_stream().await.expect("control");
            cw.send(&FromDevice::Hello {
                app_version: "test".into(),
                protocol_minor: 0,
            })
            .await
            .expect("hello");
            assert!(matches!(next(&mut cr).await, ToDevice::Welcome { .. }));
            assert!(matches!(next(&mut cr).await, ToDevice::ProjectList { .. }));
            assert!(matches!(next(&mut cr).await, ToDevice::Usage { .. }));
            drop(old);
            // Let the old connection's end be noticed and cleaned up.
            tokio::time::sleep(Duration::from_millis(500)).await;
            world.serve.heartbeat(42);
            assert!(matches!(
                next(&mut cr).await,
                ToDevice::Heartbeat { at: 42, .. }
            ));
        });
    }

    fn start(project_id: &str, worktree: bool) -> FromDevice {
        FromDevice::StartSession {
            request_id: [7; 16],
            project_id: project_id.into(),
            title: Some("From the phone".into()),
            worktree,
        }
    }

    #[test]
    fn a_controller_starts_a_session_and_hears_its_id() {
        run(async {
            let world = world().await;
            world
                .fake
                .folders
                .lock()
                .insert("p".into(), ProjectFolder::Approved);
            let (phone, _link, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            cw.send(&start("p", false)).await.expect("sent");
            assert_eq!(
                next(&mut cr).await,
                ToDevice::StartResult {
                    request_id: [7; 16],
                    session_id: "started".into(),
                }
            );
            assert_eq!(
                world.fake.starts.lock().clone(),
                vec![(
                    phone.id(),
                    RemoteStart {
                        request_id: [7; 16],
                        project_id: "p".into(),
                        title: Some("From the phone".into()),
                    }
                )]
            );
        });
    }

    #[test]
    fn a_start_the_host_may_not_make_is_refused_and_nothing_starts() {
        run(async {
            let world = world().await;
            world
                .fake
                .folders
                .lock()
                .insert("outside".into(), ProjectFolder::NotAllowed);
            world
                .fake
                .folders
                .lock()
                .insert("p".into(), ProjectFolder::Approved);
            let (_c, _cl, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            let (_v, _vl, mut vw, mut vr) = device(&world, 4, Role::Viewer).await;
            for (message, reason) in [
                (start("outside", false), RefuseReason::FolderNotAllowed),
                (start("gone", false), RefuseReason::NoSuchProject),
                (start("p", true), RefuseReason::NotAllowed),
            ] {
                cw.send(&message).await.expect("sent");
                assert_eq!(
                    next(&mut cr).await,
                    ToDevice::StartRefused {
                        request_id: [7; 16],
                        reason
                    },
                    "{message:?}"
                );
            }
            vw.send(&start("p", false)).await.expect("sent");
            assert_eq!(
                next(&mut vr).await,
                ToDevice::StartRefused {
                    request_id: [7; 16],
                    reason: RefuseReason::NotAllowed
                },
                "a viewer may not start"
            );
            assert!(world.fake.starts.lock().is_empty(), "nothing started");
        });
    }

    #[test]
    fn a_resent_start_that_failed_is_refused_again_and_starts_nothing() {
        run(async {
            let world = world().await;
            world
                .fake
                .folders
                .lock()
                .insert("p".into(), ProjectFolder::Approved);
            world
                .fake
                .started
                .lock()
                .insert([7; 16], Err(RefuseReason::StartFailed));
            let (_c, _cl, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            cw.send(&start("p", false)).await.expect("sent");
            assert_eq!(
                next(&mut cr).await,
                ToDevice::StartRefused {
                    request_id: [7; 16],
                    reason: RefuseReason::StartFailed
                }
            );
            assert!(world.fake.starts.lock().is_empty(), "nothing started again");
        });
    }

    #[test]
    fn a_start_that_fails_says_so() {
        run(async {
            let world = world().await;
            world
                .fake
                .folders
                .lock()
                .insert("p".into(), ProjectFolder::Approved);
            *world.fake.start_result.lock() = Err(RefuseReason::StartFailed);
            let (_c, _cl, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            cw.send(&start("p", false)).await.expect("sent");
            assert_eq!(
                next(&mut cr).await,
                ToDevice::StartRefused {
                    request_id: [7; 16],
                    reason: RefuseReason::StartFailed
                }
            );
        });
    }

    #[test]
    fn a_resent_start_gets_the_session_it_made_even_if_the_project_changed_since() {
        run(async {
            let world = world().await;
            // The project went (no folder now), but this request made a session.
            world
                .fake
                .started
                .lock()
                .insert([7; 16], Ok("made-before".into()));
            let (_c, _cl, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            cw.send(&start("p", false)).await.expect("sent");
            assert_eq!(
                next(&mut cr).await,
                ToDevice::StartResult {
                    request_id: [7; 16],
                    session_id: "made-before".into(),
                }
            );
            assert!(world.fake.starts.lock().is_empty(), "nothing started again");
        });
    }

    #[test]
    fn a_devices_push_token_is_kept_for_it_and_nothing_is_said_back() {
        run(async {
            let world = world().await;
            let (phone, _link, mut cw, mut cr) = device(&world, 3, Role::Viewer).await;
            assert!(world.serve.has_devices());
            cw.send(&FromDevice::PushToken {
                key_id: 4,
                sealed: b"sealed".to_vec(),
            })
            .await
            .expect("sent");
            let deadline = Instant::now() + Duration::from_secs(10);
            while world.fake.push_tokens.lock().is_empty() {
                assert!(Instant::now() < deadline, "the token never arrived");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert_eq!(
                world.fake.push_tokens.lock().clone(),
                vec![(phone.id(), 4, b"sealed".to_vec())]
            );
            world.serve.heartbeat(5);
            assert!(
                matches!(next(&mut cr).await, ToDevice::Heartbeat { at: 5, .. }),
                "no refusal came first"
            );
        });
    }

    #[test]
    fn a_device_gives_back_control_and_every_device_hears_the_host_holds_it() {
        run(async {
            let world = world().await;
            let (phone, _link, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            cw.send(&FromDevice::TakeControl {
                session_id: "s".into(),
            })
            .await
            .expect("take");
            let took = loop {
                if let ToDevice::Control { holder, epoch, .. } = next(&mut cr).await {
                    assert_eq!(holder, Holder::Device(phone.id()));
                    break epoch;
                }
            };
            cw.send(&FromDevice::ReleaseControl {
                session_id: "s".into(),
            })
            .await
            .expect("give back");
            loop {
                if let ToDevice::Control { holder, epoch, .. } = next(&mut cr).await {
                    assert_eq!(holder, Holder::Host);
                    assert!(epoch.counter > took.counter, "a new epoch");
                    break;
                }
            }
        });
    }

    #[test]
    fn a_device_turning_alerts_off_has_its_push_token_forgotten() {
        run(async {
            let world = world().await;
            let (phone, _link, mut cw, mut cr) = device(&world, 3, Role::Viewer).await;
            cw.send(&FromDevice::PushToken {
                key_id: 4,
                sealed: b"sealed".to_vec(),
            })
            .await
            .expect("sent");
            cw.send(&FromDevice::ForgetPushToken).await.expect("sent");
            world.serve.heartbeat(5);
            assert!(
                matches!(next(&mut cr).await, ToDevice::Heartbeat { at: 5, .. }),
                "no refusal came first"
            );
            let deadline = Instant::now() + Duration::from_secs(10);
            while world
                .fake
                .push_tokens
                .lock()
                .iter()
                .any(|(device, ..)| *device == phone.id())
            {
                assert!(Instant::now() < deadline, "the token was kept");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
    }

    #[test]
    fn a_device_that_reconnects_before_its_old_connection_goes_must_take_control_again() {
        run(async {
            let world = world().await;
            let (phone, old, mut ocw, mut ocr) = device(&world, 3, Role::Controller).await;
            let (_sw, _sr, _epoch) = in_control(&world, &old, &mut ocw, &mut ocr).await;
            // The device gave up on the old link and dialed again; the host
            // hasn't noticed the old one end yet.
            let new = phone.connect(world.host.addr()).await.expect("reconnect");
            let (mut cw, mut cr) = new.open_stream().await.expect("control");
            cw.send(&FromDevice::Hello {
                app_version: "test".into(),
                protocol_minor: 0,
            })
            .await
            .expect("hello");
            assert!(matches!(next(&mut cr).await, ToDevice::Welcome { .. }));
            assert!(matches!(next(&mut cr).await, ToDevice::ProjectList { .. }));
            let deadline = Instant::now() + Duration::from_secs(10);
            while world.fake.gate.lock().control().holder() != Holder::Host {
                assert!(
                    Instant::now() < deadline,
                    "control never went back to the host"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            drop(old);
        });
    }

    /// A controller that took control of "s" and has its screen open: the
    /// epoch it holds.
    async fn in_control(
        world: &World,
        link: &DeviceLink,
        cw: &mut MessageWriter<FromDevice>,
        cr: &mut MessageReader<ToDevice>,
    ) -> (MessageWriter<FromDevice>, MessageReader<ToDevice>, Epoch) {
        let (sw, mut sr) = open(link).await;
        let id = asked(world).await;
        answer(world, id, b"x");
        assert!(matches!(next(&mut sr).await, ToDevice::Snapshot { .. }));
        cw.send(&FromDevice::TakeControl {
            session_id: "s".into(),
        })
        .await
        .expect("take");
        let ToDevice::Control { holder, epoch, .. } = next(cr).await else {
            panic!("everyone hears who holds control")
        };
        assert!(matches!(holder, kriyon_remote::message::Holder::Device(_)));
        (sw, sr, epoch)
    }

    fn typing(epoch: Epoch, seen_seq: u64, bytes: &[u8]) -> FromDevice {
        FromDevice::Input {
            run: 1,
            epoch,
            seen_seq,
            bytes: bytes.to_vec(),
            write_id: 1,
        }
    }

    #[test]
    fn a_controller_in_control_types_and_every_device_hears_who_holds_it() {
        run(async {
            let world = world().await;
            let (_a, link, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            let (_b, _blink, _bcw, mut bcr) = device(&world, 4, Role::Viewer).await;
            let (mut sw, mut sr, epoch) = in_control(&world, &link, &mut cw, &mut cr).await;
            assert!(
                matches!(next(&mut bcr).await, ToDevice::Control { .. }),
                "the viewer hears too"
            );
            sw.send(&typing(epoch, 0, b"ls\r")).await.expect("input");
            assert_eq!(
                next(&mut sr).await,
                ToDevice::InputAck {
                    epoch,
                    written: true,
                    write_id: 1,
                }
            );
            assert_eq!(world.fake.typed.lock().as_slice(), b"ls\r");
        });
    }

    #[test]
    fn typing_after_the_host_took_control_back_is_refused() {
        run(async {
            let world = world().await;
            let (_a, link, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            let (mut sw, mut sr, epoch) = in_control(&world, &link, &mut cw, &mut cr).await;
            // The person types at the host: the app's writer tells everyone.
            let took = world.fake.gate.lock().host_input(Instant::now());
            world.fake.tell(took.change);
            assert!(matches!(
                next(&mut cr).await,
                ToDevice::Control {
                    holder: kriyon_remote::message::Holder::Host,
                    ..
                }
            ));
            sw.send(&typing(epoch, 0, b"late")).await.expect("input");
            assert!(matches!(next(&mut sr).await, ToDevice::WriteRefused { .. }));
            assert_eq!(world.fake.typed.lock().as_slice(), b"", "nothing written");
        });
    }

    #[test]
    fn typing_from_before_another_device_took_over_is_refused() {
        run(async {
            let world = world().await;
            let (_a, link, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            let (_b, _blink, mut bcw, mut bcr) = device(&world, 4, Role::Controller).await;
            let (mut sw, mut sr, epoch) = in_control(&world, &link, &mut cw, &mut cr).await;
            assert!(matches!(next(&mut bcr).await, ToDevice::Control { .. }));
            // The other phone takes over before this one's typing arrives.
            bcw.send(&FromDevice::TakeControl {
                session_id: "s".into(),
            })
            .await
            .expect("take");
            let ToDevice::Control {
                epoch: newer,
                holder,
                ..
            } = next(&mut cr).await
            else {
                panic!("the takeover is heard")
            };
            assert_ne!(newer, epoch, "a takeover bumps the epoch");
            assert!(matches!(holder, kriyon_remote::message::Holder::Device(_)));
            sw.send(&typing(epoch, 0, b"late")).await.expect("input");
            assert!(matches!(next(&mut sr).await, ToDevice::WriteRefused { .. }));
            assert_eq!(world.fake.typed.lock().as_slice(), b"", "nothing written");
        });
    }

    #[test]
    fn refusals_are_answered_at_a_limited_rate_and_logged_without_their_payload() {
        run(async {
            let world = world().await;
            let (_phone, _link, mut cw, mut cr) = device(&world, 3, Role::Viewer).await;
            // Unknown messages, each carrying something that must not be logged.
            let secret = b"do-not-log-me";
            let mut frame = vec![0, 0, 0, u8::try_from(secret.len() + 1).expect("short"), 120];
            frame.extend_from_slice(secret);
            for _ in 0..60 {
                cw.send_encoded(&frame).await.expect("sent");
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            while !world
                .fake
                .logged
                .lock()
                .iter()
                .any(|line| line.contains("too often"))
            {
                assert!(Instant::now() < deadline, "never over the limit");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            // The flood read through: then a heartbeat, behind every answer.
            tokio::time::sleep(Duration::from_millis(200)).await;
            world.serve.heartbeat(77);
            let mut refused = 0;
            loop {
                match next(&mut cr).await {
                    ToDevice::Refused { .. } => refused += 1,
                    ToDevice::Heartbeat { at: 77, .. } => break,
                    _ => {}
                }
            }
            assert_eq!(
                refused,
                kriyon_remote::link_policy::REFUSALS_PER_WINDOW,
                "the rest went unanswered"
            );
            let logged = world.fake.logged.lock().join("\n");
            assert!(logged.contains("UnknownMessage"), "{logged}");
            assert!(!logged.contains("do-not-log-me"), "{logged}");
            assert!(logged.contains("too often"), "{logged}");
        });
    }

    #[test]
    fn telling_devices_of_a_change_of_control_never_calls_the_app() {
        // The writers tell this under a session's gate lock (in epoch
        // order): a call back into the app could take that lock again.
        run(async {
            let world = world().await;
            let (_a, _link, _cw, mut cr) = device(&world, 3, Role::Viewer).await;
            let change = world
                .fake
                .gate
                .lock()
                .take([9; 32], Instant::now())
                .expect("taken")
                .expect("a change");
            let before = world.fake.calls.load(std::sync::atomic::Ordering::Relaxed);
            world.serve.broadcast_control("s", change);
            assert_eq!(
                world.fake.calls.load(std::sync::atomic::Ordering::Relaxed),
                before,
                "no call back into the app"
            );
            assert!(matches!(next(&mut cr).await, ToDevice::Control { .. }));
        });
    }

    #[test]
    fn a_device_removed_while_typing_is_refused_at_once_before_its_link_closes() {
        run(async {
            let world = world().await;
            let (phone, link, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            let (mut sw, mut sr, epoch) = in_control(&world, &link, &mut cw, &mut cr).await;
            sw.send(&typing(epoch, 0, b"a")).await.expect("input");
            assert!(matches!(
                next(&mut sr).await,
                ToDevice::InputAck { written: true, .. }
            ));
            // Removed: its connection is still open, and says Controller.
            world.fake.paired.lock().remove(&phone.id());
            sw.send(&typing(epoch, 0, b"b")).await.expect("input");
            assert_eq!(
                next(&mut sr).await,
                ToDevice::WriteRefused {
                    write_id: 1,
                    reason: RefuseReason::NotPaired
                }
            );
            cw.send(&FromDevice::TakeControl {
                session_id: "s".into(),
            })
            .await
            .expect("take");
            assert!(matches!(
                next(&mut cr).await,
                ToDevice::Refused {
                    reason: RefuseReason::NotPaired
                }
            ));
            assert_eq!(world.fake.typed.lock().as_slice(), b"a", "nothing after");
        });
    }

    #[test]
    fn a_device_made_a_viewer_while_typing_is_refused_at_once() {
        run(async {
            let world = world().await;
            let (phone, link, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            let (mut sw, mut sr, epoch) = in_control(&world, &link, &mut cw, &mut cr).await;
            world.fake.paired.lock().insert(phone.id(), Role::Viewer);
            sw.send(&typing(epoch, 0, b"b")).await.expect("input");
            assert!(matches!(next(&mut sr).await, ToDevice::WriteRefused { .. }));
            assert_eq!(world.fake.typed.lock().as_slice(), b"", "nothing written");
        });
    }

    #[test]
    fn typing_from_before_a_dialog_appeared_is_refused() {
        run(async {
            let world = world().await;
            let (_a, link, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            let (mut sw, mut sr, epoch) = in_control(&world, &link, &mut cw, &mut cr).await;
            world.fake.gate.lock().set_dialog(Dialog {
                showing: true,
                changed_at_seq: Some(5),
            });
            sw.send(&typing(epoch, 3, b"1")).await.expect("input");
            assert_eq!(
                next(&mut sr).await,
                ToDevice::WriteRefused {
                    write_id: 1,
                    reason: RefuseReason::Stale
                }
            );
            assert_eq!(world.fake.typed.lock().as_slice(), b"");
        });
    }

    /// A device claiming it drew more than it was ever sent can't answer a
    /// dialog it never saw: its `seen_seq` counts only up to what it got.
    #[test]
    fn a_seen_seq_past_what_was_sent_is_held_to_what_was() {
        run(async {
            let world = world().await;
            let (_a, link, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            let (mut sw, mut sr, epoch) = in_control(&world, &link, &mut cw, &mut cr).await;
            world.fake.gate.lock().set_dialog(Dialog {
                showing: true,
                changed_at_seq: Some(5),
            });
            sw.send(&typing(epoch, u64::MAX, b"1"))
                .await
                .expect("input");
            assert_eq!(
                next(&mut sr).await,
                ToDevice::WriteRefused {
                    write_id: 1,
                    reason: RefuseReason::Stale
                }
            );
            assert_eq!(world.fake.typed.lock().as_slice(), b"");
        });
    }

    #[test]
    fn a_device_that_drops_gives_control_back_to_the_host() {
        run(async {
            let world = world().await;
            let (phone, link, mut cw, mut cr) = device(&world, 3, Role::Controller).await;
            let (_b, _blink, _bcw, mut bcr) = device(&world, 4, Role::Viewer).await;
            let _held = in_control(&world, &link, &mut cw, &mut cr).await;
            assert!(matches!(next(&mut bcr).await, ToDevice::Control { .. }));
            world.host.cut_off(&phone.id());
            assert!(matches!(
                next(&mut bcr).await,
                ToDevice::Control {
                    holder: kriyon_remote::message::Holder::Host,
                    ..
                }
            ));
        });
    }
}
