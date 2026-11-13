//! Serving paired [Remote device]s (plan Step C): their control stream
//! (`Hello` → `Welcome`, heartbeats, session status) and one stream per
//! session they open, fed by each session's [Session fan-out].
//!
//! Tauri-free: what it needs from the app comes through [`ServeHost`], and
//! the daemon's events come in through [`Serve::on_event`] from each
//! session's [Daemon client] reader, which must never wait here: everything
//! it touches is a short lock or a wake-up, and the network writes happen on
//! the streams' own tasks.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use kriyon_core::cli_dialog::DialogState;
use kriyon_remote::authorize::{
    authorize, Dialog, HostState, PendingWrite, ProjectFolder, SessionView, Stream,
};
use kriyon_remote::codec::{encode, Decoded};
use kriyon_remote::control::{Change, Control};
use kriyon_remote::fanout::{Pop, RequesterId, SessionFanout};
use kriyon_remote::link_policy::CloseCode;
use kriyon_remote::message::{
    EndpointId, FromDevice, ProjectInfo, RefuseReason, Role, SessionInfo, ToDevice,
};
use kriyon_remote::queue::{ControlQueue, CONTROL_QUEUE_LIMIT, SESSION_QUEUE_LIMIT};
use kriyon_remote_link::framed::{MessageReader, MessageWriter};
use kriyon_remote_link::host::RemoteLink;
use parking_lot::Mutex;
use tokio::sync::Notify;

use crate::daemon_client::DaemonEvent;

/// The protocol minor this host speaks, sent in `Welcome`.
pub const PROTOCOL_MINOR: u16 = 0;
/// The oldest protocol minor this host accepts in `Hello`.
pub const MIN_PROTOCOL_MINOR: u16 = 0;

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
    /// The projects a session can be started in, for devices' pickers.
    fn projects(&self) -> Vec<ProjectInfo>;
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
    /// The session list as devices last heard it.
    heard: Mutex<HashMap<String, SessionInfo>>,
    /// The project list as devices last heard it.
    heard_projects: Mutex<Option<Vec<ProjectInfo>>>,
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

impl HostState for Facts {
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
            FromDevice::Open { session_id } | FromDevice::TakeControl { session_id },
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
            heard: Mutex::new(HashMap::new()),
            heard_projects: Mutex::new(None),
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
        sessions.insert(
            id.to_string(),
            Arc::new(Served {
                fanout: Mutex::new(fanout),
                ask: Box::new(ask),
                size: Box::new(size),
                wakers: Mutex::new(HashMap::new()),
                ended: std::sync::atomic::AtomicBool::new(false),
            }),
        );
    }

    /// Stop serving session `id`: it closed. Its device streams end.
    pub fn detach(&self, id: &str) {
        let served = self.0.sessions.lock().remove(id);
        if let Some(served) = served {
            served.ended.store(true, Ordering::Relaxed);
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
                DaemonEvent::SnapshotEnd { id } => fanout
                    .snapshot_end(id, size.unwrap_or(crate::session_writer::DEFAULT_SCREEN))
                    .into_iter()
                    .collect(),
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
            self.0.heard.lock().clear();
            *self.0.heard_projects.lock() = None;
            return;
        }
        self.projects_changed();
        let now = sessions_heard(self.0.host.sessions());
        let mut heard = self.0.heard.lock();
        let gone = heard.keys().any(|id| !now.contains_key(id));
        let changed: Vec<SessionInfo> = now
            .values()
            .filter(|info| heard.get(&info.id) != Some(*info))
            .cloned()
            .collect();
        *heard = now;
        let list: Vec<SessionInfo> = heard.values().cloned().collect();
        drop(heard);
        if gone {
            self.broadcast(&ToDevice::SessionList { sessions: list });
        } else {
            for session in changed {
                self.broadcast(&ToDevice::SessionStatus { session });
            }
        }
    }

    /// Tell every device the project list if it changed since they heard it.
    fn projects_changed(&self) {
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

    /// The facts a message from `device` is checked against. Its role is the
    /// one it connected with; it counts as paired while its control stream
    /// is served, which ends when removal closes its connection (`hello`: the
    /// stream that is being opened).
    fn facts(&self, device: EndpointId, role: Role, session: Option<&str>, hello: bool) -> Facts {
        let paired = hello || self.0.controls.lock().contains_key(&device);
        let role = paired
            .then_some(role)
            .and_then(|role| self.0.host.role_now(&device, role));
        let live = session.and_then(|id| Some((id.to_string(), self.0.host.session(id)?)));
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
            &self.facts(device, role, None, true),
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
        let sessions = self.0.host.sessions();
        writer
            .send(&ToDevice::Welcome {
                host_name: self.0.host.host_name(),
                protocol_minor: PROTOCOL_MINOR,
                role,
                sessions,
            })
            .await
            .ok()?;
        // Then where a session can be started: Viewers hear it too.
        let projects = self.0.host.projects();
        writer
            .send(&ToDevice::ProjectList {
                projects: projects.clone(),
            })
            .await
            .ok()?;
        self.0.heard_projects.lock().get_or_insert(projects);
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
        // A first device hears changes from the list it was just given.
        {
            let mut heard = self.0.heard.lock();
            if heard.is_empty() {
                *heard = sessions_heard(self.0.host.sessions());
            }
        }
        let writing = tokio::spawn(write_control(writer, Arc::clone(&out)));
        let serve = self.clone();
        let reading_out = Arc::clone(&out);
        let reading = tokio::spawn(async move {
            serve.read_control(device, role, reader, reading_out).await;
        });
        Some((out, [writing, reading]))
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
            let facts = self.facts(device, role, named_session(None, &message), false);
            let verdict = authorize(&device, Stream::Control, &message, &facts, Instant::now())
                .and_then(|()| match &message {
                    Decoded::Message(FromDevice::TakeControl { session_id }) => {
                        self.0.host.take(session_id, device, role)
                    }
                    Decoded::Message(FromDevice::PushToken { key_id, sealed }) => {
                        self.0.host.set_push_token(&device, *key_id, sealed.clone());
                        Ok(())
                    }
                    _ => Ok(()),
                });
            if let Err(reason) = verdict {
                out.send(&ToDevice::Refused { reason });
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
        let host = Arc::clone(&self.0.host);
        let asked = (project_id.clone(), *worktree);
        // The store and the folder check touch the disk: off the runtime.
        let looked = tokio::task::spawn_blocking(move || {
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
        let Ok((made, folder)) = looked else {
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
        let mut facts = self.facts(device, role, None, false);
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
        let opened = authorize(
            &device,
            Stream::Unopened,
            &first,
            &self.facts(device, role, named_session(None, &first), false),
            Instant::now(),
        )
        .and_then(|()| match &first {
            Decoded::Message(FromDevice::Open { session_id }) => Ok(session_id.clone()),
            _ => Err(RefuseReason::NotAllowed),
        })
        .and_then(|id| Ok((self.served(&id).ok_or(RefuseReason::NoSuchSession)?, id)));
        let (served, id) = match opened {
            Ok(opened) => opened,
            Err(reason) => {
                let _ = writer.send(&ToDevice::Refused { reason }).await;
                writer.finish();
                return;
            }
        };
        let wake = Arc::new(Notify::new());
        let opened = {
            let mut fanout = served.fanout.lock();
            // Once per device: two streams would share, and split, one queue.
            (!fanout.is_open(&device)).then(|| (fanout.open(device), fanout.open_count()))
        };
        let Some((ask, open)) = opened else {
            let _ = writer
                .send(&ToDevice::Refused {
                    reason: RefuseReason::NotAllowed,
                })
                .await;
            writer.finish();
            return;
        };
        served.wakers.lock().insert(device, Arc::clone(&wake));
        if open == 1 {
            self.0.host.set_onlooked(&id, true);
        }
        // An older daemon can't make a snapshot for one device: nothing to
        // show it but a refusal.
        let Some(ask) = ask else {
            self.close_session(&served, &id, &device);
            let _ = writer
                .send(&ToDevice::Refused {
                    reason: RefuseReason::NotAllowed,
                })
                .await;
            writer.finish();
            return;
        };
        (served.ask)(ask);
        let (answers, answered) = tokio::sync::mpsc::channel::<ToDevice>(8);
        let writing = tokio::spawn(write_session(
            writer,
            Arc::clone(&served),
            device,
            Arc::clone(&wake),
            answered,
        ));
        while let Ok(Some(message)) = reader.next().await {
            let facts = self.facts(device, role, Some(&id), false);
            let checked = authorize(
                &device,
                Stream::Session(&id),
                &message,
                &facts,
                Instant::now(),
            );
            let answer = match (checked, message) {
                (Err(reason), _) => Some(ToDevice::Refused { reason }),
                (Ok(()), Decoded::Message(FromDevice::Resync)) => {
                    let ask = served.fanout.lock().resync(&device, Instant::now());
                    if let Some(ask) = ask {
                        (served.ask)(ask);
                    }
                    None
                }
                (Ok(()), Decoded::Message(message)) => {
                    self.write(&id, device, role, &message).await
                }
                (Ok(()), Decoded::Unknown { .. }) => Some(ToDevice::Refused {
                    reason: RefuseReason::UnknownMessage,
                }),
            };
            if let Some(answer) = answer {
                // Answers past a handful waiting are dropped, not queued.
                let _ = answers.try_send(answer);
                wake.notify_one();
            }
        }
        writing.abort();
        self.close_session(&served, &id, &device);
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
        let Some(write) = PendingWrite::of(message) else {
            // Readable entries are a later revision's.
            return Some(ToDevice::Refused {
                reason: RefuseReason::NotAllowed,
            });
        };
        // The writer's lock and the PTY write can wait: off the async runtime.
        let call = |bytes: Vec<u8>, size: Option<(u16, u16)>| {
            let host = Arc::clone(&self.0.host);
            let id = id.to_string();
            async move {
                tokio::task::spawn_blocking(move || match size {
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
                        Err(reason) => return Some(ToDevice::Refused { reason }),
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
            },
            Err(reason) => ToDevice::Refused { reason },
        })
    }

    fn close_session(&self, served: &Served, id: &str, device: &EndpointId) {
        let open = {
            let mut fanout = served.fanout.lock();
            fanout.close(device);
            fanout.open_count()
        };
        served.wakers.lock().remove(device);
        // Not if the session is served afresh and a device opened it there
        // (a stream of the old one ending late).
        if open == 0 && !self.is_onlooked(id) {
            self.0.host.set_onlooked(id, false);
        }
    }
}

/// A session list by id.
fn sessions_heard(sessions: Vec<SessionInfo>) -> HashMap<String, SessionInfo> {
    sessions
        .into_iter()
        .map(|info| (info.id.clone(), info))
        .collect()
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

    use kriyon_remote::compress::{decompress, Kind};
    use kriyon_remote::message::{Epoch, Holder};
    use kriyon_remote_link::device::DeviceLink;

    use super::*;

    use crate::remote_test_support::*;

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
            })
            .await
            .expect("input");
            assert_eq!(
                next(&mut sr).await,
                ToDevice::Refused {
                    reason: RefuseReason::NotAllowed
                }
            );
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
                    written: true
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
            assert!(matches!(next(&mut sr).await, ToDevice::Refused { .. }));
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
            assert!(matches!(next(&mut sr).await, ToDevice::Refused { .. }));
            assert_eq!(world.fake.typed.lock().as_slice(), b"", "nothing written");
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
                ToDevice::Refused {
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
            assert!(matches!(next(&mut sr).await, ToDevice::Refused { .. }));
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
                ToDevice::Refused {
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
