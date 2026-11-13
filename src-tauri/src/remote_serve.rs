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
use kriyon_remote::authorize::{authorize, Dialog, HostState, ProjectFolder, SessionView, Stream};
use kriyon_remote::codec::{encode, Decoded};
use kriyon_remote::control::Control;
use kriyon_remote::fanout::{Pop, RequesterId, SessionFanout};
use kriyon_remote::link_policy::CloseCode;
use kriyon_remote::message::{EndpointId, FromDevice, RefuseReason, Role, SessionInfo, ToDevice};
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
}

/// Serving every paired device's streams. Cheap to clone.
#[derive(Clone)]
pub struct Serve(Arc<Inner>);

/// The facts one message is checked against, owned, so no lock is held
/// across the check.
struct Facts {
    device: EndpointId,
    role: Option<Role>,
    live: Option<(String, LiveSession)>,
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

    fn project_folder(&self, _project_id: &str) -> ProjectFolder {
        // Remote starts are not served yet (see `serve_control`).
        ProjectFolder::NoSuchProject
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
            return;
        }
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
        let role = paired.then_some(role);
        let live = session.and_then(|id| Some((id.to_string(), self.0.host.session(id)?)));
        Facts { device, role, live }
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
        let mut controls = self.0.controls.lock();
        if controls
            .get(&device)
            .is_some_and(|held| Arc::ptr_eq(held, &out))
        {
            controls.remove(&device);
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
        let out = Arc::new(ControlOut {
            queue: Mutex::new(ControlQueue::new(CONTROL_QUEUE_LIMIT)),
            wake: Notify::new(),
            link: Arc::clone(link),
        });
        self.0.controls.lock().insert(device, Arc::clone(&out));
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
            serve.read_control(device, role, reader, &reading_out).await;
        });
        Some((out, [writing, reading]))
    }

    /// Answer what a device sends on its control stream.
    async fn read_control(
        &self,
        device: EndpointId,
        role: Role,
        mut reader: MessageReader<FromDevice>,
        out: &ControlOut,
    ) {
        while let Ok(Some(message)) = reader.next().await {
            let facts = self.facts(device, role, named_session(None, &message), false);
            let verdict = authorize(&device, Stream::Control, &message, &facts, Instant::now())
                .and(match message {
                    // Typing control is the next step's; remote starts wait
                    // for `create_session` to run without the webview.
                    Decoded::Message(
                        FromDevice::TakeControl { .. } | FromDevice::StartSession { .. },
                    ) => Err(RefuseReason::NotAllowed),
                    _ => Ok(()),
                });
            if let Err(reason) = verdict {
                out.send(&ToDevice::Refused { reason });
            }
        }
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
        let (refusals, refused) = tokio::sync::mpsc::channel::<RefuseReason>(8);
        let writing = tokio::spawn(write_session(
            writer,
            Arc::clone(&served),
            device,
            Arc::clone(&wake),
            refused,
        ));
        while let Ok(Some(message)) = reader.next().await {
            let facts = self.facts(device, role, Some(&id), false);
            let verdict = authorize(
                &device,
                Stream::Session(&id),
                &message,
                &facts,
                Instant::now(),
            )
            .and_then(|()| match message {
                Decoded::Message(FromDevice::Resync) => {
                    let ask = served.fanout.lock().resync(&device, Instant::now());
                    if let Some(ask) = ask {
                        (served.ask)(ask);
                    }
                    Ok(())
                }
                // Typing and resizing are the next step's; readable
                // entries are a later revision's.
                _ => Err(RefuseReason::NotAllowed),
            });
            if let Err(reason) = verdict {
                // Refusals past a handful waiting are dropped, not queued.
                let _ = refusals.try_send(reason);
                wake.notify_one();
            }
        }
        writing.abort();
        self.close_session(&served, &id, &device);
    }

    fn close_session(&self, served: &Served, id: &str, device: &EndpointId) {
        let open = {
            let mut fanout = served.fanout.lock();
            fanout.close(device);
            fanout.open_count()
        };
        served.wakers.lock().remove(device);
        if open == 0 {
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

/// Write one device's session stream out: its queue in the fan-out, and
/// refusals of what it sent.
async fn write_session(
    mut writer: MessageWriter<ToDevice>,
    served: Arc<Served>,
    device: EndpointId,
    wake: Arc<Notify>,
    mut refused: tokio::sync::mpsc::Receiver<RefuseReason>,
) {
    loop {
        while let Ok(reason) = refused.try_recv() {
            if writer.send(&ToDevice::Refused { reason }).await.is_err() {
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
    use std::collections::HashSet;
    use std::net::SocketAddr;
    use std::time::Duration;

    use kriyon_core::session::SessionStatus;
    use kriyon_core::standing::StandingState;
    use kriyon_remote::compress::{decompress, Kind};
    use kriyon_remote::message::Epoch;
    use kriyon_remote_link::device::{Device, DeviceLink};
    use kriyon_remote_link::endpoint::LinkConfig;
    use kriyon_remote_link::host::{Accepted, Host, PairedDevices};

    use super::*;

    /// The app, faked: one session "s", paired devices in a map.
    #[derive(Default)]
    struct FakeHost {
        paired: Mutex<HashMap<EndpointId, Role>>,
        live: Mutex<Option<LiveSession>>,
        onlooked: Mutex<HashSet<String>>,
        title: Mutex<String>,
    }

    impl PairedDevices for FakeHost {
        fn role(&self, device: &EndpointId) -> Option<Role> {
            self.paired.lock().get(device).copied()
        }
    }

    impl ServeHost for FakeHost {
        fn host_name(&self) -> String {
            "Test Mac".into()
        }
        fn sessions(&self) -> Vec<SessionInfo> {
            vec![SessionInfo {
                id: "s".into(),
                title: self.title.lock().clone(),
                project_id: "p".into(),
                status: SessionStatus::Idle,
                standing: StandingState::Idle,
                needs_you: false,
                dialog_open: false,
                last_change_ms: 0,
            }]
        }
        fn session(&self, id: &str) -> Option<LiveSession> {
            (id == "s").then(|| self.live.lock().clone()).flatten()
        }
        fn set_onlooked(&self, id: &str, onlooked: bool) {
            let mut set = self.onlooked.lock();
            if onlooked {
                set.insert(id.to_string());
            } else {
                set.remove(id);
            }
        }
    }

    fn loopback() -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], 0))
    }

    struct World {
        host: Arc<Host>,
        fake: Arc<FakeHost>,
        serve: Serve,
        asks: Arc<Mutex<Vec<RequesterId>>>,
    }

    /// A host serving one live session "s", whose daemon is the test.
    async fn world() -> World {
        let fake = Arc::new(FakeHost::default());
        *fake.title.lock() = "first".into();
        *fake.live.lock() = Some(LiveSession {
            run: 1,
            control: Control::new(5),
            dialog: Dialog::default(),
            size: (80, 24),
        });
        let host = Arc::new(
            Host::bind(
                &LinkConfig {
                    bind: loopback(),
                    ..LinkConfig::new([9; 32])
                },
                Arc::clone(&fake) as Arc<dyn PairedDevices>,
                60,
            )
            .await
            .expect("host"),
        );
        let serve = Serve::new(Arc::clone(&fake) as Arc<dyn ServeHost>);
        let asks = Arc::new(Mutex::new(Vec::new()));
        let asked = Arc::clone(&asks);
        serve.attach("s", move |id| asked.lock().push(id), || (80, 24));
        let _ = serve.on_event("s", DaemonEvent::Hello { run: 1 });
        let accepting = Arc::clone(&host);
        let serving = serve.clone();
        tokio::spawn(async move {
            while let Some(accepted) = accepting.accept().await {
                if let Accepted::Remote(link) = accepted {
                    tokio::spawn(serving.clone().serve(Arc::new(link)));
                }
            }
        });
        World {
            host,
            fake,
            serve,
            asks,
        }
    }

    /// A paired device of `role`, connected, past `Welcome`.
    async fn device(
        world: &World,
        key: u8,
        role: Role,
    ) -> (
        Device,
        DeviceLink,
        MessageWriter<FromDevice>,
        MessageReader<ToDevice>,
    ) {
        let phone = Device::bind(&LinkConfig {
            bind: loopback(),
            ..LinkConfig::new([key; 32])
        })
        .await
        .expect("device");
        world.fake.paired.lock().insert(phone.id(), role);
        let link = phone.connect(world.host.addr()).await.expect("connect");
        let (mut writer, mut reader) = link.open_stream().await.expect("control");
        writer
            .send(&FromDevice::Hello {
                app_version: "test".into(),
                protocol_minor: 0,
            })
            .await
            .expect("hello");
        let welcome = next(&mut reader).await;
        assert!(
            matches!(&welcome, ToDevice::Welcome { role: r, sessions, .. } if *r == role && sessions.len() == 1),
            "{welcome:?}"
        );
        (phone, link, writer, reader)
    }

    async fn next(reader: &mut MessageReader<ToDevice>) -> ToDevice {
        match tokio::time::timeout(Duration::from_secs(10), reader.next()).await {
            Ok(Ok(Some(Decoded::Message(message)))) => message,
            other => panic!("no message: {other:?}"),
        }
    }

    /// The next requester id the daemon (the test) is asked a snapshot for.
    async fn asked(world: &World) -> RequesterId {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(id) = world.asks.lock().pop() {
                return id;
            }
            assert!(Instant::now() < deadline, "no snapshot asked for");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// The daemon (the test) answers snapshot `id` with `screen`.
    fn answer(world: &World, id: RequesterId, screen: &[u8]) {
        let _ = world
            .serve
            .on_event("s", DaemonEvent::Snapshot { id, bytes: screen });
        let _ = world.serve.on_event("s", DaemonEvent::SnapshotEnd { id });
    }

    async fn open(link: &DeviceLink) -> (MessageWriter<FromDevice>, MessageReader<ToDevice>) {
        let (mut writer, reader) = link.open_stream().await.expect("session stream");
        writer
            .send(&FromDevice::Open {
                session_id: "s".into(),
            })
            .await
            .expect("open");
        (writer, reader)
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

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
}
