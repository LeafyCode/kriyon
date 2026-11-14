//! This computer as a [Remote device] of another [Host] (plan Step D):
//! pairing from an invite's text, staying connected to each paired host, its
//! sessions, and the session streams shown in a terminal.
//!
//! The protocol's decisions are `kriyon_remote::device_view`'s; this does the
//! IO, the same on the desktop and the phone. It keeps nothing itself: the
//! app stores paired hosts and keys (`HostEntry` in, `DeviceEvents` out).
//! Tested against a host in-process.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::device::{stay_connected_waking, Device, DeviceLink};
use crate::framed::{MessageReader, MessageWriter};
use crate::LinkError;
use iroh::EndpointAddr;
use kriyon_remote::codec::Decoded;
use kriyon_remote::device_view::{
    EntriesEvent, HostView, LinkFacts, LinkPath, LinkState, ReadableEntries, ScreenEvent,
    SessionScreen,
};
use kriyon_remote::link_policy::{CloseCode, HeartbeatWatch};
use kriyon_remote::message::{
    EndpointId, FromDevice, Holder, RefuseReason, RequestId, SessionId, ToDevice,
};
use kriyon_remote::pairing::PairingInvite;
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;

/// How often a link checks its heartbeat and a lost screen asks again.
const TICK: Duration = Duration::from_secs(1);

/// How long a link that ended by itself waits for the host's close reason.
const HOST_CLOSE_WAIT: Duration = Duration::from_secs(2);

/// Told when a host's link or view changes.
pub trait DeviceEvents: Send + Sync + 'static {
    fn host_changed(&self, host: EndpointId, link: &LinkFacts, view: &HostView);
}

/// Where one session's screen events go.
pub type ScreenSink = Arc<dyn Fn(ScreenEvent) + Send + Sync>;

/// Where an open session's screen goes, if anywhere: swapped in place when
/// the person turns the screen on or off, so the stream stays open.
type ScreenSlot = Arc<std::sync::Mutex<Option<ScreenSink>>>;

/// Where one session's [Readable view] events go.
pub type EntriesSink = Arc<dyn Fn(EntriesEvent) + Send + Sync>;

/// A session read as entries here, kept across links: a new link asks
/// from the highest entry it has. Its sink is swapped in place when a view
/// asks for the entries again (a reloaded page brings a new one).
struct Reading {
    sink: std::sync::Mutex<EntriesSink>,
    entries: std::sync::Mutex<ReadableEntries>,
}

impl Reading {
    fn new(sink: EntriesSink) -> Self {
        Self {
            sink: std::sync::Mutex::new(sink),
            entries: std::sync::Mutex::default(),
        }
    }

    fn tell(&self, event: EntriesEvent) {
        let sink = Arc::clone(
            &self
                .sink
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        sink(event);
    }

    /// The highest entry read so far: a new link asks from here.
    fn highest(&self) -> u64 {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .highest()
    }
}

/// How the person wants one session shown here: the one call that opens,
/// switches and closes it ([`DeviceRuntime::set_view`]).
pub enum SessionView {
    /// Open, its screen as `screen` says and its [Readable view] entries
    /// going to `entries` (or not read).
    Open {
        screen: ScreenView,
        entries: Option<EntriesSink>,
    },
    /// Not open here; the session keeps running on the host.
    Closed,
}

/// A session's screen, as a view asks for it.
pub enum ScreenView {
    /// No screen crosses the link.
    Off,
    /// A screen to `sink`, starting from a fresh snapshot: a terminal shown
    /// (again), or a page that loaded again and needs the whole screen.
    Fresh(ScreenSink),
    /// The screen as it is now, on or off: the view changes something else.
    Kept,
}

/// A session the person has open here: where its screen goes, and its
/// entries if they read them. Kept across links.
struct Wanted {
    screen: ScreenSlot,
    /// Counts the fresh screens asked for: each starts from a snapshot.
    fresh: u64,
    reading: Option<Arc<Reading>>,
}

impl Wanted {
    /// The fresh screen showing, or `None` with the screen off.
    fn screen_now(&self) -> Option<u64> {
        shown(&self.screen).is_some().then_some(self.fresh)
    }
}

/// What an open stream's host has been told, changed only under the
/// stream's writer lock so the last word it hears is the view's.
#[derive(Default)]
struct Told {
    /// The fresh screen it was asked for, or `None` for off.
    screen: Option<u64>,
    reading: Option<Arc<Reading>>,
}

/// An open stream's [`Reading`], once the person reads it; and a refusal
/// that came, with the screen off, before anyone read it, to tell the
/// reader when one comes.
#[derive(Default)]
struct ReadingState {
    read: Option<Arc<Reading>>,
    refused: Option<RefuseReason>,
}

type ReadingSlot = Arc<std::sync::Mutex<ReadingState>>;

/// A paired host, as the device keeps it.
#[derive(Clone, Debug)]
pub struct HostEntry {
    pub id: EndpointId,
    pub addr: EndpointAddr,
}

/// Why a device action couldn't happen.
#[derive(Debug, PartialEq, Eq)]
pub enum DeviceError {
    /// Not connected to that host now.
    NotConnected,
    /// That session isn't open here.
    NotOpen,
    /// This device doesn't hold typing control of that session.
    NoControl,
    /// The screen hasn't arrived yet: nothing to answer.
    NoScreen,
    Link(String),
}

impl std::fmt::Display for DeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConnected => f.write_str("not connected to that computer"),
            Self::NotOpen => f.write_str("that session isn't open"),
            Self::NoControl => f.write_str("this device doesn't have control"),
            Self::NoScreen => f.write_str("the screen hasn't arrived yet"),
            Self::Link(why) => f.write_str(why),
        }
    }
}

/// One pairing in progress: show `code`, then await `finish` for the host's
/// name. Store the host only when it succeeds.
pub struct DevicePairingStart {
    pub code: String,
    pub invite: PairingInvite,
    pub finish: crate::device::DevicePairing,
}

/// How long the device waits on the host's heartbeat, and how often it
/// looks: the spec's timing, shortened only by tests.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// Quiet this long and the host counts as lost.
    pub lost_after: Duration,
    /// How often the heartbeat is checked.
    pub tick: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            lost_after: kriyon_remote::link_policy::HEARTBEAT_LOST_AFTER,
            tick: TICK,
        }
    }
}

/// The device side, one per app.
#[derive(Default)]
pub struct DeviceRuntime {
    timing: Timing,
    device: Mutex<Option<Arc<Device>>>,
    hosts: Mutex<HashMap<EndpointId, Arc<HostConn>>>,
    wake: Arc<Notify>,
}

struct HostConn {
    /// Where the host is, and who hears about it: kept to dial it again
    /// from a rebuilt endpoint.
    entry: HostEntry,
    events: Arc<dyn DeviceEvents>,
    conn: Mutex<Conn>,
    task: std::sync::Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
struct Conn {
    state: Option<LinkState>,
    /// The path the link uses, while it is up.
    path: Option<LinkPath>,
    /// When the host was last heard from (Unix ms).
    last_seen_ms: Option<i64>,
    view: HostView,
    link: Option<Arc<DeviceLink>>,
    control: Option<Arc<Mutex<MessageWriter<FromDevice>>>>,
    sessions: HashMap<SessionId, OpenSession>,
    /// The sessions the person has open here, as they want them shown:
    /// opened again on each new link, so a reconnect redraws them.
    wanted: HashMap<SessionId, Wanted>,
    /// Sessions whose stream is opening now, one at a time so two opens (a
    /// reconnect's and the person's) never race to two streams; `true` once
    /// another open was asked meanwhile, which the open under way then does.
    opening: HashMap<SessionId, bool>,
    /// The number of the last view taken for each session: an older one,
    /// arriving late, changes nothing.
    views: HashMap<SessionId, u64>,
    /// Starts asked for and not yet answered: sent again, with the same
    /// request id, on every new link until the host answers.
    starting: HashMap<RequestId, PendingStart>,
}

struct PendingStart {
    message: FromDevice,
    answer: tokio::sync::oneshot::Sender<Result<SessionId, RefuseReason>>,
}

/// A start someone is waiting on; dropped, it is no longer asked for.
struct Waiting {
    conn: Arc<HostConn>,
    request_id: RequestId,
}

impl Drop for Waiting {
    fn drop(&mut self) {
        let conn = Arc::clone(&self.conn);
        let request_id = self.request_id;
        // An answer already took it; otherwise it goes now. Off this drop,
        // which can't wait for the lock.
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                conn.conn.lock().await.starting.remove(&request_id);
            });
        }
    }
}

/// Why a session couldn't be started on a host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartError {
    /// The host refused it, or it failed there.
    Refused(RefuseReason),
    /// That host isn't paired here.
    NotConnected,
    /// This device stopped following the host before it answered.
    Gone,
}

impl StartError {
    /// What it means, in words a person reads.
    #[must_use]
    pub fn words(self) -> &'static str {
        match self {
            Self::Refused(reason) => kriyon_remote::device_view::refusal_words(reason),
            Self::NotConnected => "That computer isn't paired with this device.",
            Self::Gone => "This device stopped connecting to that computer.",
        }
    }
}

impl Conn {
    /// What this device knows of its link now.
    fn link_facts(&self) -> LinkFacts {
        LinkFacts {
            state: self.state.unwrap_or(LinkState::Connecting),
            path: self.path,
            last_seen_ms: self.last_seen_ms,
        }
    }
}

/// The time now, in Unix milliseconds.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

/// A request id no other start from this device has had: the time, and a
/// count for starts asked in the same instant.
fn fresh_request_id() -> RequestId {
    static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let count = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(
        &u64::try_from(nanos & u128::from(u64::MAX))
            .unwrap_or(0)
            .to_be_bytes(),
    );
    id[8..].copy_from_slice(&count.to_be_bytes());
    id
}

struct OpenSession {
    writer: Arc<Mutex<MessageWriter<FromDevice>>>,
    screen: Arc<std::sync::Mutex<SessionScreen>>,
    reading: ReadingSlot,
    /// Who waits for the host's answer to a compose, if anyone.
    answer: AnswerSlot,
    told: Arc<std::sync::Mutex<Told>>,
    reader: JoinHandle<()>,
}

/// Where the host's answer to a write goes: whether it reached the PTY, or
/// why it was refused.
type AnswerSlot =
    Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<bool, RefuseReason>>>>>;

/// The answer slot, locked: poison is only another thread's panic, and the
/// slot is a plain value.
fn waiter(
    slot: &AnswerSlot,
) -> std::sync::MutexGuard<'_, Option<tokio::sync::oneshot::Sender<Result<bool, RefuseReason>>>> {
    slot.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// How long a compose waits for the host's answer: it types the text, then
/// Enter after a beat.
const COMPOSE_ANSWER_WAIT: Duration = Duration::from_secs(15);
/// An open stream's parts, to tell its host without holding the host's lock.
#[derive(Clone)]
struct Stream {
    writer: Arc<Mutex<MessageWriter<FromDevice>>>,
    screen: Arc<std::sync::Mutex<SessionScreen>>,
    reading: ReadingSlot,
    told: Arc<std::sync::Mutex<Told>>,
}

impl OpenSession {
    fn stream(&self) -> Stream {
        Stream {
            writer: Arc::clone(&self.writer),
            screen: Arc::clone(&self.screen),
            reading: Arc::clone(&self.reading),
            told: Arc::clone(&self.told),
        }
    }
}

impl DeviceRuntime {
    /// A device side that counts a host lost on other than the spec's
    /// timing: for tests that can't wait 40 s.
    #[must_use]
    pub fn with_timing(timing: Timing) -> Self {
        Self {
            timing,
            ..Self::default()
        }
    }

    /// Dial from this device's one endpoint, which may also host. An
    /// endpoint rebuilt with the same key (a new relay pass) replaces the
    /// closed one it follows.
    pub async fn attach(&self, endpoint: iroh::Endpoint) -> Arc<Device> {
        let mut device = self.device.lock().await;
        match device.as_ref() {
            Some(device) if device.id() == *endpoint.id().as_bytes() && !device.is_closed() => {
                Arc::clone(device)
            }
            _ => {
                let attached = Arc::new(Device::from_endpoint(endpoint));
                *device = Some(Arc::clone(&attached));
                attached
            }
        }
    }

    async fn attached(&self) -> Result<Arc<Device>, String> {
        self.device
            .lock()
            .await
            .clone()
            .ok_or_else(|| "remote access isn't ready".to_string())
    }

    /// Whether this computer is connected, or connecting, to any host.
    pub async fn in_use(&self) -> bool {
        !self.hosts.lock().await.is_empty()
    }

    async fn my_id(&self) -> Option<EndpointId> {
        self.device.lock().await.as_ref().map(|device| device.id())
    }

    async fn host(&self, host: &EndpointId) -> Result<Arc<HostConn>, DeviceError> {
        self.hosts
            .lock()
            .await
            .get(host)
            .cloned()
            .ok_or(DeviceError::NotConnected)
    }

    /// Pair with the host in an invite's text: once the host accepts the
    /// proof, the code to show comes back with the rest of the pairing.
    ///
    /// # Errors
    /// For text that isn't an invite, an unreachable host, or a refusal.
    pub async fn start_pairing(
        &self,
        invite_text: &str,
        device_name: &str,
    ) -> Result<DevicePairingStart, String> {
        let invite = PairingInvite::from_qr_text(invite_text.trim())
            .map_err(|_| "that isn't a Kriyon pairing code".to_string())?;
        let addr = crate::invite::host_addr(&invite).map_err(|e| e.to_string())?;
        let device = self.attached().await?;
        let finish = device
            .pair(addr, &invite.secret, device_name)
            .await
            .map_err(|e| e.to_string())?;
        Ok(DevicePairingStart {
            code: finish.code().to_string(),
            invite,
            finish,
        })
    }

    /// Stay connected to `host` until told to stop or the host removes this
    /// device. Does nothing if already connected or connecting.
    ///
    /// # Errors
    /// When no endpoint is attached.
    pub async fn connect(
        &self,
        host: HostEntry,
        events: Arc<dyn DeviceEvents>,
    ) -> Result<(), String> {
        let device = self.attached().await?;
        let mut hosts = self.hosts.lock().await;
        if hosts.contains_key(&host.id) {
            return Ok(());
        }
        let conn = Arc::new(HostConn {
            entry: host.clone(),
            events,
            conn: Mutex::new(Conn::default()),
            task: std::sync::Mutex::new(None),
        });
        hosts.insert(host.id, Arc::clone(&conn));
        drop(hosts);
        self.stay_linked(&conn, device);
        Ok(())
    }

    /// Keep `conn`'s host linked from `device`, in a task of its own.
    fn stay_linked(&self, conn: &Arc<HostConn>, device: Arc<Device>) {
        let wake = Arc::clone(&self.wake);
        let timing = self.timing;
        let staying = Arc::clone(conn);
        let task = tokio::spawn(async move {
            let host = staying.entry.clone();
            let events = Arc::clone(&staying.events);
            set_state(&staying, host.id, LinkState::Connecting, events.as_ref()).await;
            stay_connected_waking(&device, host.addr, &wake, |link| {
                run_link(
                    Arc::clone(&staying),
                    host.id,
                    Arc::clone(&events),
                    link,
                    timing,
                )
            })
            .await;
            // Only the host saying this device isn't paired ends it.
            staying.conn.lock().await.starting.clear();
            set_state(&staying, host.id, LinkState::Removed, events.as_ref()).await;
        });
        let old = conn
            .task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .replace(task);
        if let Some(old) = old {
            old.abort();
        }
    }

    /// Stop staying connected to `host`.
    pub async fn disconnect(&self, host: &EndpointId) {
        let Some(conn) = self.hosts.lock().await.remove(host) else {
            return;
        };
        if let Some(task) = conn
            .task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
        let mut c = conn.conn.lock().await;
        for (_, open) in c.sessions.drain() {
            open.reader.abort();
        }
        if let Some(link) = c.link.take() {
            link.close();
        }
        c.control = None;
        // Whoever waits on a start hears it's gone.
        c.starting.clear();
    }

    /// How many starts on `host` wait for an answer.
    pub async fn waiting_starts(&self, host: &EndpointId) -> usize {
        match self.host(host).await {
            Ok(conn) => conn.conn.lock().await.starting.len(),
            Err(_) => 0,
        }
    }

    /// Start a session on `host` in project `project_id`, titled `title` or
    /// after the project: the new session's id, which the caller can open.
    /// Asked once; while the link is down it waits, and on every new link it
    /// is sent again with the same request id, so the host makes one
    /// session however often it is sent (spec §4).
    ///
    /// # Errors
    /// [`StartError`]: refused (with the host's reason), a host not paired
    /// here, or one this device stopped following before it answered.
    pub async fn start_session(
        &self,
        host: &EndpointId,
        project_id: &str,
        title: Option<String>,
    ) -> Result<SessionId, StartError> {
        let conn = self
            .host(host)
            .await
            .map_err(|_| StartError::NotConnected)?;
        let request_id = fresh_request_id();
        let message = FromDevice::StartSession {
            request_id,
            project_id: project_id.to_string(),
            title,
            worktree: false,
        };
        let (answer, answered) = tokio::sync::oneshot::channel();
        let control = {
            let mut c = conn.conn.lock().await;
            c.starting.insert(
                request_id,
                PendingStart {
                    message: message.clone(),
                    answer,
                },
            );
            c.control
                .clone()
                .filter(|_| c.state == Some(LinkState::Connected))
        };
        // If whoever asked stops waiting, the start goes with it: it is never
        // sent again on a later link.
        let _waiting = Waiting {
            conn: Arc::clone(&conn),
            request_id,
        };
        // Not connected now, or the send fails: the next link sends it.
        if let Some(control) = control {
            let _ = control.lock().await.send(&message).await;
        }
        match answered.await {
            Ok(Ok(session_id)) => Ok(session_id),
            Ok(Err(reason)) => Err(StartError::Refused(reason)),
            Err(_) => Err(StartError::Gone),
        }
    }

    /// Retry every waiting reconnect at once: the network changed, or the
    /// app came to the front.
    pub fn wake(&self) {
        self.wake.notify_waiters();
    }

    /// Show `session` on `host` as `view`: open it (its screen and its
    /// [Readable view] entries each on or off) or close it. Views are
    /// numbered by whoever asks, in the order asked: one older than the
    /// last taken (a call that arrived late) changes nothing.
    ///
    /// The view is kept and applied now if the link is up, and again on
    /// every link after, until closed. A link going down never fails it:
    /// the next link shows it.
    ///
    /// # Errors
    /// [`DeviceError::NotConnected`] for a host not paired here (closing a
    /// session there is no failure: nothing is open).
    pub async fn set_view(
        &self,
        host: &EndpointId,
        session: &str,
        seq: u64,
        view: SessionView,
    ) -> Result<(), DeviceError> {
        let conn = match self.host(host).await {
            Ok(conn) => conn,
            Err(_) if matches!(view, SessionView::Closed) => return Ok(()),
            Err(why) => return Err(why),
        };
        let gone = {
            let mut c = conn.conn.lock().await;
            if c.views.get(session).is_some_and(|last| *last >= seq) {
                return Ok(());
            }
            c.views.insert(session.to_string(), seq);
            match view {
                SessionView::Closed => {
                    c.wanted.remove(session);
                    c.sessions.remove(session)
                }
                SessionView::Open { screen, entries } => {
                    let wanted = c
                        .wanted
                        .entry(session.to_string())
                        .or_insert_with(|| Wanted {
                            screen: Arc::default(),
                            fresh: 0,
                            reading: None,
                        });
                    match screen {
                        ScreenView::Off => *shown(&wanted.screen) = None,
                        ScreenView::Fresh(sink) => {
                            *shown(&wanted.screen) = Some(sink);
                            wanted.fresh += 1;
                        }
                        ScreenView::Kept => {}
                    }
                    wanted.reading = match (entries, wanted.reading.take()) {
                        (Some(sink), Some(read)) => {
                            *read
                                .sink
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) = sink;
                            Some(read)
                        }
                        (Some(sink), None) => Some(Arc::new(Reading::new(sink))),
                        (None, _) => None,
                    };
                    None
                }
            }
        };
        match gone {
            Some(open) => let_go(open).await,
            None => show_wanted(&conn, session).await,
        }
        Ok(())
    }

    /// Ask for typing control of `session`.
    ///
    /// # Errors
    /// [`DeviceError::NotConnected`] or a link failure.
    pub async fn take_control(&self, host: &EndpointId, session: &str) -> Result<(), DeviceError> {
        self.send_control(
            host,
            &FromDevice::TakeControl {
                session_id: session.to_string(),
            },
        )
        .await
    }

    /// Give back typing control of `session`: the host holds it again.
    ///
    /// # Errors
    /// [`DeviceError::NotConnected`] or a link failure.
    pub async fn give_back(&self, host: &EndpointId, session: &str) -> Result<(), DeviceError> {
        self.send_control(
            host,
            &FromDevice::ReleaseControl {
                session_id: session.to_string(),
            },
        )
        .await
    }

    /// Send `message` on `host`'s control stream.
    async fn send_control(
        &self,
        host: &EndpointId,
        message: &FromDevice,
    ) -> Result<(), DeviceError> {
        let conn = self.host(host).await?;
        let control = conn
            .conn
            .lock()
            .await
            .control
            .clone()
            .ok_or(DeviceError::NotConnected)?;
        let sent = control.lock().await.send(message).await;
        sent.map_err(|e| DeviceError::Link(e.to_string()))
    }

    /// Whether any session is open here, on any host.
    pub async fn has_open_sessions(&self) -> bool {
        let conns: Vec<Arc<HostConn>> = self.hosts.lock().await.values().cloned().collect();
        for conn in conns {
            if !conn.conn.lock().await.wanted.is_empty() {
                return true;
            }
        }
        false
    }

    /// Dial from `endpoint` from now on (rebuilt with the same key, for a new
    /// relay pass): every host's link moves to it, and the sessions open here
    /// and the starts waiting are taken up again on the new link.
    pub async fn rebind(&self, endpoint: iroh::Endpoint) {
        let device = Arc::new(Device::from_endpoint(endpoint));
        *self.device.lock().await = Some(Arc::clone(&device));
        let conns: Vec<Arc<HostConn>> = self.hosts.lock().await.values().cloned().collect();
        for conn in conns {
            {
                // The old link goes; what is wanted and waiting stays, and
                // the new link takes it up.
                let mut c = conn.conn.lock().await;
                for (_, open) in c.sessions.drain() {
                    open.reader.abort();
                }
                if let Some(link) = c.link.take() {
                    link.close();
                }
                c.control = None;
            }
            self.stay_linked(&conn, Arc::clone(&device));
        }
    }

    /// The hosts connected now (welcomed, heartbeat coming).
    pub async fn connected_hosts(&self) -> Vec<EndpointId> {
        let hosts: Vec<(EndpointId, Arc<HostConn>)> = self
            .hosts
            .lock()
            .await
            .iter()
            .map(|(id, conn)| (*id, Arc::clone(conn)))
            .collect();
        let mut connected = Vec::new();
        for (id, conn) in hosts {
            if conn.conn.lock().await.state == Some(LinkState::Connected) {
                connected.push(id);
            }
        }
        connected
    }

    /// Give `host` this device's push token, sealed to the push sender's key
    /// `key_id` (spec section 10). It is sent again on every link.
    ///
    /// # Errors
    /// [`DeviceError::NotConnected`], or the link failed.
    pub async fn send_push_token(
        &self,
        host: &EndpointId,
        key_id: u32,
        sealed: Vec<u8>,
    ) -> Result<(), DeviceError> {
        self.send_control(host, &FromDevice::PushToken { key_id, sealed })
            .await
    }

    /// Have `host` forget this device's push token: its alerts are off.
    ///
    /// # Errors
    /// [`DeviceError::NotConnected`], or the link failed.
    pub async fn forget_push_token(&self, host: &EndpointId) -> Result<(), DeviceError> {
        self.send_control(host, &FromDevice::ForgetPushToken).await
    }

    /// Type `bytes` into `session`, which this device must control.
    ///
    /// # Errors
    /// [`DeviceError`]: not connected, not open, no control, no screen yet.
    pub async fn input(
        &self,
        host: &EndpointId,
        session: &str,
        bytes: Vec<u8>,
    ) -> Result<(), DeviceError> {
        self.write(host, session, |screen, epoch| screen.input(epoch, bytes))
            .await
    }

    /// Send `text` to Claude in `session` as the desktop's composer does
    /// (the host types it, then Enter), whether its screen is on or not:
    /// this device must control it. Refused while a dialog shows.
    ///
    /// # Errors
    /// [`DeviceError`]: not connected, not open, no control, or the host
    /// hasn't named the session's run yet (`NoScreen`).
    pub async fn compose(
        &self,
        host: &EndpointId,
        session: &str,
        text: String,
    ) -> Result<(), DeviceError> {
        let (told, answer) = tokio::sync::oneshot::channel();
        let slot = {
            let conn = self.host(host).await?;
            let c = conn.conn.lock().await;
            let open = c.sessions.get(session).ok_or(DeviceError::NotOpen)?;
            Arc::clone(&open.answer)
        };
        // One waits at a time: a newer compose takes the answer.
        *waiter(&slot) = Some(told);
        self.write(host, session, |screen, epoch| screen.compose(epoch, text))
            .await?;
        match tokio::time::timeout(COMPOSE_ANSWER_WAIT, answer).await {
            Ok(Ok(Ok(true))) => Ok(()),
            Ok(Ok(Ok(false))) => Err(DeviceError::Link(
                "It didn't reach that computer's terminal.".into(),
            )),
            Ok(Ok(Err(reason))) => Err(DeviceError::Link(
                kriyon_remote::device_view::refusal_words(reason).into(),
            )),
            // The link went, or no answer in time.
            Ok(Err(_)) | Err(_) => Err(DeviceError::Link(
                "That computer didn't say whether it arrived.".into(),
            )),
        }
    }

    /// Send the write `make` makes from `session`'s screen state and this
    /// device's epoch; this device must control the session.
    async fn write(
        &self,
        host: &EndpointId,
        session: &str,
        make: impl FnOnce(&SessionScreen, kriyon_remote::message::Epoch) -> Option<FromDevice>,
    ) -> Result<(), DeviceError> {
        let me = self.my_id().await.ok_or(DeviceError::NotConnected)?;
        let conn = self.host(host).await?;
        let (writer, message) = {
            let c = conn.conn.lock().await;
            let control = c
                .view
                .control
                .get(session)
                .filter(|control| control.holder == Holder::Device(me))
                .ok_or(DeviceError::NoControl)?;
            let open = c.sessions.get(session).ok_or(DeviceError::NotOpen)?;
            let message = make(
                &open
                    .screen
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
                control.epoch,
            )
            .ok_or(DeviceError::NoScreen)?;
            (Arc::clone(&open.writer), message)
        };
        let sent = writer.lock().await.send(&message).await;
        sent.map_err(|e| DeviceError::Link(e.to_string()))
    }
}

/// Bring `session`'s stream to what the person wants: tell an open stream
/// what changed, or open one if the link is up. A stream that fails to
/// take it is let go and opened again; a link that is down shows it on the
/// next one.
async fn show_wanted(conn: &HostConn, session: &str) {
    let stream = conn
        .conn
        .lock()
        .await
        .sessions
        .get(session)
        .map(OpenSession::stream);
    let Some(stream) = stream else {
        open_once(conn, session).await;
        return;
    };
    if tell(conn, session, &stream).await.is_err() {
        // This stream is done (the host stopped it, or its link is going):
        // a fresh one, if the link is still up.
        let gone = {
            let mut c = conn.conn.lock().await;
            let same = c
                .sessions
                .get(session)
                .is_some_and(|open| Arc::ptr_eq(&open.writer, &stream.writer));
            if same {
                c.sessions.remove(session)
            } else {
                None
            }
        };
        if let Some(gone) = gone {
            let_go(gone).await;
        }
        open_once(conn, session).await;
    }
}

/// Tell an open stream's host what the person wants that it hasn't heard:
/// the screen on or off, the entries read or not. Under the stream's writer
/// lock, read from the view then, so the last word the host hears is the
/// view's, whatever order calls came in.
async fn tell(conn: &HostConn, session: &str, stream: &Stream) -> Result<(), LinkError> {
    let mut writer = stream.writer.lock().await;
    let (screen, read) = {
        let c = conn.conn.lock().await;
        match c.wanted.get(session) {
            Some(wanted) => (wanted.screen_now(), wanted.reading.clone()),
            // Closed meanwhile: the close lets the stream go.
            None => return Ok(()),
        }
    };
    let (told_screen, told_read) = {
        let told = told(&stream.told);
        (told.screen, told.reading.clone())
    };
    // A fresh screen not yet asked for (even with one on: the host answers
    // `Screen { on }` with a snapshot), or the screen turned off.
    if screen != told_screen {
        if screen.is_some() {
            // A new screen follows from the snapshot coming; what was queued
            // before it is not drawn.
            if let Ok(fresh) = SessionScreen::new() {
                *lock(&stream.screen) = fresh;
            }
        }
        let on = screen.is_some();
        writer.send(&FromDevice::Screen { on }).await?;
        told(&stream.told).screen = screen;
    }
    match (read, told_read) {
        (Some(read), Some(told)) if Arc::ptr_eq(&read, &told) => {}
        (Some(read), _) => {
            let refused = {
                let mut state = slot(&stream.reading);
                state.read = Some(Arc::clone(&read));
                state.refused.take()
            };
            if let Some(reason) = refused {
                read.tell(EntriesEvent::Refused(reason));
            }
            // Read before this stream: ask from what it has.
            let since = read.highest();
            writer.send(&FromDevice::RequestEntries { since }).await?;
            told(&stream.told).reading = Some(read);
        }
        (None, Some(_)) => {
            slot(&stream.reading).read = None;
            writer.send(&FromDevice::StopEntries).await?;
            told(&stream.told).reading = None;
        }
        (None, None) => {}
    }
    Ok(())
}

/// How many times one open tries before it leaves the session to the next
/// link or view: enough for a view that changes while it opens.
const OPEN_TRIES: u32 = 8;

/// Open `session`'s stream on the host's link, if the link is up, the
/// person still wants it and it has none; then tell it the view as it is by
/// then. One open at a time: one asked meanwhile is done by the open under
/// way, which goes round again for it.
async fn open_once(conn: &HostConn, session: &str) {
    {
        let mut c = conn.conn.lock().await;
        if let Some(again) = c.opening.get_mut(session) {
            *again = true;
            return;
        }
        c.opening.insert(session.to_string(), false);
    }
    let mut tries = 0;
    loop {
        let done = if tries < OPEN_TRIES {
            tries += 1;
            open_try(conn, session).await
        } else {
            true
        };
        let mut c = conn.conn.lock().await;
        if !done || c.opening.get(session) == Some(&true) && tries < OPEN_TRIES {
            c.opening.insert(session.to_string(), false);
            continue;
        }
        c.opening.remove(session);
        return;
    }
}

/// One go at opening `session`'s stream: whether it is done (open and told,
/// nothing to open, or a link that failed and is dialed again), or should
/// go again (the view or the link changed meanwhile, or the new stream
/// failed the view).
async fn open_try(conn: &HostConn, session: &str) -> bool {
    let target = {
        let c = conn.conn.lock().await;
        let link = c
            .link
            .clone()
            .filter(|_| c.state == Some(LinkState::Connected));
        let wanted = c
            .wanted
            .get(session)
            .map(|wanted| (Arc::clone(&wanted.screen), wanted.screen_now()));
        match (link, wanted) {
            (Some(link), Some(wanted)) if !c.sessions.contains_key(session) => Some((link, wanted)),
            _ => None,
        }
    };
    let Some((link, (screen, fresh))) = target else {
        return true;
    };
    match open_stream(conn, &link, session, &screen, fresh).await {
        Ok(Some(stream)) => {
            let Err(why) = tell(conn, session, &stream).await else {
                return true;
            };
            // Stopped at once (or its link is going): this stream is done.
            eprintln!("kriyon: remote session {session} stream ended: {why}");
            let gone = {
                let mut c = conn.conn.lock().await;
                let same = c
                    .sessions
                    .get(session)
                    .is_some_and(|open| Arc::ptr_eq(&open.writer, &stream.writer));
                if same {
                    c.sessions.remove(session)
                } else {
                    None
                }
            };
            if let Some(gone) = gone {
                let_go(gone).await;
            }
            false
        }
        // Not kept: the view or the link changed while it opened.
        Ok(None) => false,
        Err(why) => {
            // A session gone from the host is refused on its own stream; a
            // failed link is dialed again and opens it then. A link replaced
            // meanwhile is tried at once.
            eprintln!("kriyon: couldn't open remote session {session}: {why}");
            let replaced = conn
                .conn
                .lock()
                .await
                .link
                .as_ref()
                .is_some_and(|now| !Arc::ptr_eq(now, &link));
            !replaced
        }
    }
}

/// Open a stream for `session` on `link`, with the screen `fresh` (on, or
/// `None`: off). Kept only if the person still wants it with that screen
/// slot and `link` is still the host's link once it is open; otherwise let
/// go at once.
async fn open_stream(
    conn: &HostConn,
    link: &Arc<DeviceLink>,
    session: &str,
    shown_in: &ScreenSlot,
    fresh: Option<u64>,
) -> Result<Option<Stream>, DeviceError> {
    let link_err = |e: LinkError| DeviceError::Link(e.to_string());
    let (mut writer, reader) = link.open_stream().await.map_err(link_err)?;
    let screen_on = fresh.is_some();
    writer
        .send(&FromDevice::Open {
            session_id: session.to_string(),
            screen: screen_on,
        })
        .await
        .map_err(link_err)?;
    let screen = SessionScreen::new().map_err(|e| DeviceError::Link(format!("{e:?}")))?;
    let writer = Arc::new(Mutex::new(writer));
    let screen = Arc::new(std::sync::Mutex::new(screen));
    let reading: ReadingSlot = Arc::default();
    let answer: AnswerSlot = Arc::default();
    let reader = tokio::spawn(read_session(
        reader,
        Arc::clone(&writer),
        Arc::clone(&reading),
        Arc::clone(&screen),
        Arc::clone(shown_in),
        Arc::clone(&answer),
    ));
    let open = OpenSession {
        writer,
        screen,
        reading,
        answer,
        told: Arc::new(std::sync::Mutex::new(Told {
            screen: fresh,
            reading: None,
        })),
        reader,
    };
    let stream = open.stream();
    let mut c = conn.conn.lock().await;
    let still_wanted = c
        .wanted
        .get(session)
        .is_some_and(|wanted| Arc::ptr_eq(&wanted.screen, shown_in));
    let same_link = c.link.as_ref().is_some_and(|now| Arc::ptr_eq(now, link));
    if !(still_wanted && same_link) {
        drop(c);
        let_go(open).await;
        return Ok(None);
    }
    let gone = c.sessions.insert(session.to_string(), open);
    drop(c);
    if let Some(gone) = gone {
        let_go(gone).await;
    }
    Ok(Some(stream))
}

/// End a session stream here: the host stops sending it.
async fn let_go(open: OpenSession) {
    open.reader.abort();
    open.writer.lock().await.finish();
}

/// Open again, on a new link, every session the person has open here.
async fn reopen(conn: Arc<HostConn>) {
    let wanted: Vec<SessionId> = conn.conn.lock().await.wanted.keys().cloned().collect();
    for session in wanted {
        open_once(&conn, &session).await;
    }
}

/// Record `state` and tell the app.
async fn set_state(conn: &HostConn, host: EndpointId, state: LinkState, events: &dyn DeviceEvents) {
    let mut c = conn.conn.lock().await;
    c.state = Some(state);
    events.host_changed(host, &c.link_facts(), &c.view);
}

/// One link: say hello, follow the control stream and the heartbeat, and
/// tidy up when it ends. Returns whether it worked (welcomed) and the host's
/// close code.
async fn run_link(
    conn: Arc<HostConn>,
    host: EndpointId,
    events: Arc<dyn DeviceEvents>,
    link: DeviceLink,
    timing: Timing,
) -> (bool, Option<CloseCode>) {
    let link = Arc::new(link);
    let (welcomed, lost) = follow_control(&conn, host, events.as_ref(), &link, timing).await;
    {
        let mut c = conn.conn.lock().await;
        c.link = None;
        c.control = None;
        for (_, open) in c.sessions.drain() {
            open.reader.abort();
        }
        // The host gives back whatever this device held when the link
        // closes (spec §5): it must ask again on the next one.
        c.view.control.clear();
        if c.state != Some(LinkState::Lost) {
            c.state = Some(LinkState::Connecting);
        }
        c.path = None;
        events.host_changed(host, &c.link_facts(), &c.view);
    }
    // A link that ended by itself was most likely closed by the host: wait
    // for its reason (NotPaired stops this device for good) before hanging up.
    let code = if lost {
        link.close();
        link.closed().await
    } else if let Ok(code) = tokio::time::timeout(HOST_CLOSE_WAIT, link.closed()).await {
        code
    } else {
        link.close();
        link.closed().await
    };
    (welcomed, code)
}

/// Hello, then the control stream until it ends or the heartbeat is lost.
/// Returns whether the host welcomed this device, and whether the heartbeat
/// was lost.
async fn follow_control(
    conn: &Arc<HostConn>,
    host: EndpointId,
    events: &dyn DeviceEvents,
    link: &Arc<DeviceLink>,
    timing: Timing,
) -> (bool, bool) {
    let Ok((mut writer, mut reader)) = link.open_stream().await else {
        return (false, false);
    };
    let hello = FromDevice::Hello {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_minor: kriyon_remote::message::PROTOCOL_MINOR,
    };
    if writer.send(&hello).await.is_err() {
        return (false, false);
    }
    {
        let mut c = conn.conn.lock().await;
        c.link = Some(Arc::clone(link));
        c.control = Some(Arc::new(Mutex::new(writer)));
    }
    let mut watch = HeartbeatWatch::with_window(Instant::now(), timing.lost_after);
    let mut welcomed = false;
    let mut tick = tokio::time::interval(timing.tick);
    loop {
        tokio::select! {
            message = reader.next() => {
                let Ok(Some(Decoded::Message(message))) = message else {
                    match message {
                        Ok(Some(Decoded::Unknown { .. })) => continue,
                        _ => return (welcomed, false),
                    }
                };
                if matches!(message, ToDevice::Heartbeat { .. }) {
                    watch.beat(Instant::now());
                }
                let mut c = conn.conn.lock().await;
                c.last_seen_ms = Some(now_ms());
                // A start's answer goes to whoever asked for it.
                let answer = match &message {
                    ToDevice::StartResult { request_id, session_id } => {
                        Some((*request_id, Ok(session_id.clone())))
                    }
                    ToDevice::StartRefused { request_id, reason } => {
                        Some((*request_id, Err(*reason)))
                    }
                    _ => None,
                };
                if let Some((request_id, answer)) = answer {
                    if let Some(pending) = c.starting.remove(&request_id) {
                        let _ = pending.answer.send(answer);
                    }
                    continue;
                }
                let changed = c.view.apply(&message);
                // This link's own Welcome: the view keeps the last link's.
                let now_connected = matches!(message, ToDevice::Welcome { .. })
                    && c.state != Some(LinkState::Connected);
                if now_connected {
                    c.state = Some(LinkState::Connected);
                    c.path = link.path();
                    welcomed = true;
                    // Redraw what the person had open before the link dropped.
                    tokio::spawn(reopen(Arc::clone(conn)));
                    // Starts not yet answered go again, as they were.
                    let unanswered: Vec<FromDevice> =
                        c.starting.values().map(|pending| pending.message.clone()).collect();
                    if let Some(control) = c.control.clone() {
                        tokio::spawn(async move {
                            let mut control = control.lock().await;
                            for message in unanswered {
                                if control.send(&message).await.is_err() {
                                    return;
                                }
                            }
                        });
                    }
                }
                if changed || now_connected {
                    events.host_changed(host, &c.link_facts(), &c.view);
                }
            }
            _ = tick.tick() => {
                if watch.lost(Instant::now()) {
                    // Typing goes off; the link is dropped and dialed again.
                    set_state(conn, host, LinkState::Lost, events).await;
                    return (welcomed, true);
                }
                // A path that changed (a relay gave way to a direct one,
                // say) is told; it is looked at each tick, cheaply.
                let path = link.path();
                let mut c = conn.conn.lock().await;
                if c.state == Some(LinkState::Connected) && c.path != path {
                    c.path = path;
                    events.host_changed(host, &c.link_facts(), &c.view);
                }
            }
        }
    }
}

fn shown(screen: &ScreenSlot) -> std::sync::MutexGuard<'_, Option<ScreenSink>> {
    screen
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn slot(reading: &ReadingSlot) -> std::sync::MutexGuard<'_, ReadingState> {
    reading
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn told(told: &std::sync::Mutex<Told>) -> std::sync::MutexGuard<'_, Told> {
    told.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn lock(screen: &std::sync::Mutex<SessionScreen>) -> std::sync::MutexGuard<'_, SessionScreen> {
    screen
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// One session stream: draw what comes, ask again on a gap.
async fn read_session(
    mut reader: MessageReader<ToDevice>,
    writer: Arc<Mutex<MessageWriter<FromDevice>>>,
    reading: ReadingSlot,
    screen: Arc<std::sync::Mutex<SessionScreen>>,
    shown_in: ScreenSlot,
    answer: AnswerSlot,
) {
    let mut tick = tokio::time::interval(TICK);
    loop {
        let resync = tokio::select! {
            message = reader.next() => {
                let message = match message {
                    Ok(Some(Decoded::Message(message))) => message,
                    Ok(Some(Decoded::Unknown { .. })) => continue,
                    _ => return,
                };
                let read = slot(&reading).read.clone();
                if let Some(read) = read {
                    let event = read
                        .entries
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .apply(&message);
                    if let Some(event) = event {
                        read.tell(event);
                        continue;
                    }
                }
                let events = lock(&screen).on_message(message, Instant::now());
                // A compose waiting hears how its write went.
                for event in &events {
                    let told = match event {
                        ScreenEvent::InputAck { written, .. } => Some(Ok(*written)),
                        ScreenEvent::Refused(reason) if refuses_a_write(*reason) => {
                            Some(Err(*reason))
                        }
                        _ => None,
                    };
                    if let Some(told) = told {
                        if let Some(waiting) = waiter(&answer).take() {
                            let _ = waiting.send(told);
                        }
                    }
                }
                // Screen off: nothing to show, nothing to ask for again; a
                // refusal of the stream (the session went) is told to the
                // readable view, if it is read. A write's refusal (a compose
                // while a dialog shows, say) isn't: the entries go on.
                let Some(sink) = shown(&shown_in).clone() else {
                    for event in &events {
                        if let ScreenEvent::Refused(reason) = event {
                            if refuses_a_write(*reason) {
                                continue;
                            }
                            let read = {
                                let mut state = slot(&reading);
                                if state.read.is_none() {
                                    // Kept for the reader to come.
                                    state.refused = Some(*reason);
                                }
                                state.read.clone()
                            };
                            if let Some(read) = read {
                                read.tell(EntriesEvent::Refused(*reason));
                            }
                        }
                    }
                    continue;
                };
                let mut resync = false;
                for event in events {
                    if event == ScreenEvent::Resync {
                        resync = true;
                    } else {
                        sink(event);
                    }
                }
                resync
            }
            _ = tick.tick() => {
                shown(&shown_in).is_some() && lock(&screen).resync_due(Instant::now())
            }
        };
        if resync && writer.lock().await.send(&FromDevice::Resync).await.is_err() {
            return;
        }
    }
}

/// Whether `reason` refuses a write on a stream that goes on, rather than
/// the stream itself.
fn refuses_a_write(reason: RefuseReason) -> bool {
    matches!(
        reason,
        RefuseReason::NotInControl
            | RefuseReason::Stale
            | RefuseReason::DialogOpen
            | RefuseReason::OutOfRange
    )
}

/// One session's screen event as one frame on the webview's raw channel, so
/// a new screen and the output after it arrive in order: a kind byte, then
/// its fields. `None` for what the webview doesn't see (`Resync` is Rust's).
///
/// - `0` output: the bytes.
/// - `1` screen: cols (u16 BE), rows (u16 BE), skipped (0/1), the bytes.
/// - `2` receipt: written (0/1).
/// - `3` refused: the reason's number, then its words (UTF-8).
#[must_use]
pub fn screen_frame(event: &ScreenEvent) -> Option<Vec<u8>> {
    match event {
        ScreenEvent::Output(bytes) => Some([&[0][..], bytes].concat()),
        ScreenEvent::Screen {
            cols,
            rows,
            bytes,
            skipped,
        } => {
            let mut frame = vec![1];
            frame.extend_from_slice(&cols.to_be_bytes());
            frame.extend_from_slice(&rows.to_be_bytes());
            frame.push(u8::from(*skipped));
            frame.extend_from_slice(bytes);
            Some(frame)
        }
        ScreenEvent::InputAck { written, .. } => Some(vec![2, u8::from(*written)]),
        // Its words go with it, so the desktop and the phone say one thing.
        ScreenEvent::Refused(reason) => Some(
            [
                &[3, reason_number(*reason)][..],
                kriyon_remote::device_view::refusal_words(*reason).as_bytes(),
            ]
            .concat(),
        ),
        ScreenEvent::Resync => None,
    }
}

/// A refusal's number, as on the wire.
fn reason_number(reason: RefuseReason) -> u8 {
    match reason {
        RefuseReason::NotPaired => 0,
        RefuseReason::NoSuchSession => 1,
        RefuseReason::NotAllowed => 2,
        RefuseReason::NotInControl => 3,
        RefuseReason::Stale => 4,
        RefuseReason::OutOfRange => 5,
        RefuseReason::DialogOpen => 6,
        RefuseReason::FolderNotAllowed => 7,
        RefuseReason::UnknownMessage => 8,
        RefuseReason::TooOld { .. } => 9,
        RefuseReason::NoSuchProject => 10,
        RefuseReason::ScreenTooLarge => 11,
        RefuseReason::StartFailed => 12,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use crate::host::{Accepted, Host};
    use crate::LinkConfig;
    use kriyon_core::session::SessionStatus;
    use kriyon_core::standing::StandingState;
    use kriyon_remote::compress::{compress, Kind};
    use kriyon_remote::message::{Epoch, Role, SessionInfo};

    use super::*;
    use crate::test_support::{
        loopback, loopback_config, on_loopback, run, wait_until, MemoryPaired, RecordingEvents,
    };

    /// Wait until `rt` has `n` starts waiting on `host`.
    async fn until_waiting(rt: &DeviceRuntime, host: &EndpointId, n: usize) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while rt.waiting_starts(host).await != n {
            assert!(Instant::now() < deadline, "never {n} starts waiting");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    const EPOCH: Epoch = Epoch {
        host_boot_id: 8,
        counter: 1,
    };
    const DEVICE_KEY: [u8; 32] = [2; 32];

    /// A device runtime on its own loopback endpoint; returns its id.
    async fn device_runtime() -> (DeviceRuntime, EndpointId) {
        let rt = DeviceRuntime::default();
        let me = on_loopback(&rt, DEVICE_KEY).await;
        (rt, me)
    }

    fn session() -> SessionInfo {
        SessionInfo {
            id: "s1".into(),
            title: "Fix login".into(),
            project_id: "p".into(),
            status: SessionStatus::Waiting,
            standing: StandingState::AwaitingInput,
            needs_you: true,
            dialog_open: false,
            last_change_ms: 0,
            question: None,
            activity: None,
            running_since_ms: None,
            turn_summary: None,
            diff: None,
        }
    }

    /// A host in-process that answers the way the host side will: Welcome
    /// and a heartbeat on the control stream; a snapshot and two updates on
    /// a session stream; `InputAck` for input; `Control` for `TakeControl`.
    async fn fake_host(
        device_id: EndpointId,
        heartbeats: bool,
    ) -> (Arc<Host>, JoinHandle<Vec<FromDevice>>) {
        let paired = Arc::new(MemoryPaired::of([(device_id, Role::Controller)]));
        let host = Arc::new(
            Host::bind(&loopback_config(1), paired, 10)
                .await
                .expect("host binds"),
        );
        let serving = Arc::clone(&host);
        let task = tokio::spawn(async move {
            let Some(Accepted::Remote(link)) = serving.accept().await else {
                return Vec::new();
            };
            let mut heard = Vec::new();
            let (control_out, mut control_in) = link.accept_stream().await.expect("control");
            let control_out = Arc::new(Mutex::new(control_out));
            if let Ok(Some(Decoded::Message(hello))) = control_in.next().await {
                heard.push(hello);
            }
            control_out
                .lock()
                .await
                .send(&ToDevice::Welcome {
                    host_name: "Studio".into(),
                    protocol_minor: 0,
                    role: Role::Controller,
                    sessions: vec![session()],
                })
                .await
                .expect("welcome");
            if heartbeats {
                control_out
                    .lock()
                    .await
                    .send(&ToDevice::Heartbeat { seq: 1, at: 0 })
                    .await
                    .expect("beat");
            }
            let (mut out, mut incoming) = link.accept_stream().await.expect("session");
            if let Ok(Some(Decoded::Message(open))) = incoming.next().await {
                heard.push(open);
            }
            out.send(&ToDevice::Snapshot {
                run: 9,
                seq: 0,
                cols: 100,
                rows: 30,
                bytes: compress(Kind::Snapshot, b"screen").expect("packs"),
                skipped: false,
            })
            .await
            .expect("snapshot");
            for seq in 1..=2 {
                out.send(&ToDevice::Update {
                    run: 9,
                    seq,
                    bytes: compress(Kind::Update, format!("+{seq}").as_bytes()).expect("packs"),
                })
                .await
                .expect("update");
            }
            answer_control_and_input(
                &mut control_in,
                &control_out,
                &mut incoming,
                &mut out,
                device_id,
                &mut heard,
            )
            .await;
            heard
        });
        (host, task)
    }

    /// The fake host's answers to control and input, in whichever order they
    /// come, until the device has typed once.
    async fn answer_control_and_input(
        control_in: &mut MessageReader<FromDevice>,
        control_out: &Arc<Mutex<MessageWriter<ToDevice>>>,
        incoming: &mut MessageReader<FromDevice>,
        out: &mut MessageWriter<ToDevice>,
        device_id: EndpointId,
        heard: &mut Vec<FromDevice>,
    ) {
        loop {
            tokio::select! {
                message = control_in.next() => match message {
                    Ok(Some(Decoded::Message(take @ FromDevice::TakeControl { .. }))) => {
                        heard.push(take);
                        control_out.lock().await.send(&ToDevice::Control {
                            session_id: "s1".into(),
                            holder: Holder::Device(device_id),
                            epoch: EPOCH,
                        }).await.expect("control");
                    }
                    Ok(Some(_)) => {}
                    _ => break,
                },
                message = incoming.next() => match message {
                    Ok(Some(Decoded::Message(input @ FromDevice::Input { .. }))) => {
                        heard.push(input);
                        out.send(&ToDevice::InputAck { epoch: EPOCH, written: true })
                            .await
                            .expect("ack");
                        // Stay up so the receipt arrives before the link goes.
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        return;
                    }
                    Ok(Some(_)) => {}
                    _ => break,
                },
            }
        }
    }

    fn entry(host: &Host) -> HostEntry {
        HostEntry {
            id: host.id(),
            addr: host.addr(),
        }
    }

    #[test]
    fn a_device_connects_says_hello_and_sees_the_hosts_sessions() {
        run(async {
            let (rt, me) = device_runtime().await;
            let (host, _serving) = fake_host(me, true).await;
            let seen = Arc::new(RecordingEvents::default());
            rt.connect(entry(&host), seen.clone())
                .await
                .expect("connects");
            wait_until("welcomed", || {
                seen.last()
                    .is_some_and(|(state, view)| state == LinkState::Connected && view.welcomed())
            })
            .await;
            let (_, view) = seen.last().expect("a view");
            assert_eq!(view.host_name.as_deref(), Some("Studio"));
            assert_eq!(view.sessions, vec![session()]);
            // Over loopback the link runs straight to the host.
            wait_until("its path", || {
                seen.facts()
                    .is_some_and(|facts| facts.path == Some(LinkPath::Direct))
            })
            .await;
            rt.disconnect(&host.id()).await;
        });
    }

    #[test]
    fn a_start_waiting_on_a_computer_that_is_forgotten_ends_gone() {
        run(async {
            let (rt, me) = device_runtime().await;
            // This fake host never answers a start.
            let (host, _serving) = fake_host(me, true).await;
            let rt = Arc::new(rt);
            rt.connect(entry(&host), Arc::new(RecordingEvents::default()))
                .await
                .expect("connects");
            let starting = {
                let rt = Arc::clone(&rt);
                let host = host.id();
                tokio::spawn(async move { rt.start_session(&host, "p", None).await })
            };
            until_waiting(&rt, &host.id(), 1).await;
            rt.disconnect(&host.id()).await;
            let ended = tokio::time::timeout(Duration::from_secs(5), starting)
                .await
                .expect("it ends")
                .expect("task");
            assert_eq!(ended, Err(StartError::Gone));
        });
    }

    #[test]
    fn a_start_its_asker_gave_up_on_is_never_sent_again() {
        run(async {
            let (rt, me) = device_runtime().await;
            let (host, _serving) = fake_host(me, true).await;
            let rt = Arc::new(rt);
            rt.connect(entry(&host), Arc::new(RecordingEvents::default()))
                .await
                .expect("connects");
            let starting = {
                let rt = Arc::clone(&rt);
                let host = host.id();
                tokio::spawn(async move { rt.start_session(&host, "p", None).await })
            };
            until_waiting(&rt, &host.id(), 1).await;
            starting.abort();
            until_waiting(&rt, &host.id(), 0).await;
            rt.disconnect(&host.id()).await;
        });
    }

    #[test]
    fn a_session_streams_its_screen_then_takes_control_and_types() {
        run(async {
            let (rt, me) = device_runtime().await;
            let (host, serving) = fake_host(me, true).await;
            let seen = Arc::new(RecordingEvents::default());
            rt.connect(entry(&host), seen.clone())
                .await
                .expect("connects");
            wait_until("welcomed", || {
                seen.last().is_some_and(|(_, view)| view.welcomed())
            })
            .await;

            let events = Arc::new(StdMutex::new(Vec::new()));
            let sink_events = Arc::clone(&events);
            rt.set_view(
                &host.id(),
                "s1",
                1,
                SessionView::Open {
                    screen: ScreenView::Fresh(Arc::new(move |event| {
                        sink_events.lock().expect("lock").push(event);
                    })),
                    entries: None,
                },
            )
            .await
            .expect("opens");
            wait_until("screen and updates", || {
                events.lock().expect("lock").len() >= 3
            })
            .await;
            assert_eq!(
                events.lock().expect("lock")[..3],
                [
                    ScreenEvent::Screen {
                        cols: 100,
                        rows: 30,
                        bytes: b"screen".to_vec(),
                        skipped: false
                    },
                    ScreenEvent::Output(b"+1".to_vec()),
                    ScreenEvent::Output(b"+2".to_vec()),
                ]
            );

            // Typing without control is refused here, before the host.
            assert_eq!(
                rt.input(&host.id(), "s1", b"y".to_vec()).await,
                Err(DeviceError::NoControl)
            );
            rt.take_control(&host.id(), "s1").await.expect("asks");
            wait_until("control", || {
                seen.last().is_some_and(|(_, view)| {
                    view.control.get("s1").map(|c| c.holder) == Some(Holder::Device(me))
                })
            })
            .await;
            rt.input(&host.id(), "s1", b"y".to_vec())
                .await
                .expect("types");
            wait_until("receipt", || {
                events
                    .lock()
                    .expect("lock")
                    .iter()
                    .any(|event| matches!(event, ScreenEvent::InputAck { written: true, .. }))
            })
            .await;

            let heard = serving.await.expect("host task");
            assert!(heard.contains(&FromDevice::Open {
                session_id: "s1".into(),
                screen: true,
            }));
            assert!(heard.contains(&FromDevice::Input {
                run: 9,
                epoch: EPOCH,
                seen_seq: 2,
                bytes: b"y".to_vec()
            }));
            rt.disconnect(&host.id()).await;
        });
    }

    #[test]
    fn closing_a_session_of_a_host_not_paired_here_is_no_failure() {
        run(async {
            let rt = DeviceRuntime::default();
            assert_eq!(
                rt.set_view(&[9; 32], "s1", 1, SessionView::Closed).await,
                Ok(())
            );
        });
    }

    #[test]
    fn a_view_of_a_host_not_paired_here_is_refused() {
        run(async {
            let rt = DeviceRuntime::default();
            let sink: ScreenSink = Arc::new(|_| {});
            let view = SessionView::Open {
                screen: ScreenView::Fresh(sink),
                entries: None,
            };
            assert_eq!(
                rt.set_view(&[9; 32], "s1", 1, view).await,
                Err(DeviceError::NotConnected)
            );
        });
    }

    #[test]
    fn a_removed_device_hears_it_and_stops() {
        run(async {
            let (rt, _me) = device_runtime().await;
            // A host that never paired this device.
            let (host, _serving) = fake_host([7; 32], true).await;
            let seen = Arc::new(RecordingEvents::default());
            rt.connect(entry(&host), seen.clone())
                .await
                .expect("connects");
            wait_until("removed", || {
                seen.last()
                    .is_some_and(|(state, _)| state == LinkState::Removed)
            })
            .await;
        });
    }

    #[test]
    fn screen_frames_carry_their_kind_first() {
        assert_eq!(
            screen_frame(&ScreenEvent::Output(b"ab".to_vec())),
            Some(vec![0, b'a', b'b'])
        );
        assert_eq!(
            screen_frame(&ScreenEvent::Screen {
                cols: 300,
                rows: 2,
                bytes: b"x".to_vec(),
                skipped: true
            }),
            Some(vec![1, 1, 44, 0, 2, 1, b'x'])
        );
        assert_eq!(
            screen_frame(&ScreenEvent::InputAck {
                epoch: EPOCH,
                written: false
            }),
            Some(vec![2, 0])
        );
        assert_eq!(
            screen_frame(&ScreenEvent::Refused(RefuseReason::Stale)),
            Some(
                [
                    &[3, 4][..],
                    b"The screen changed before that arrived. Look again, then try again."
                ]
                .concat()
            )
        );
        assert_eq!(screen_frame(&ScreenEvent::Resync), None);
    }

    #[test]
    fn a_push_token_reaches_the_host_on_its_control_stream() {
        run(async {
            let (rt, me) = device_runtime().await;
            let paired = Arc::new(MemoryPaired::of([(me, Role::Viewer)]));
            let host = Arc::new(
                Host::bind(&loopback_config(1), paired, 10)
                    .await
                    .expect("host binds"),
            );
            let serving = Arc::clone(&host);
            let heard = tokio::spawn(async move {
                let Some(Accepted::Remote(link)) = serving.accept().await else {
                    panic!("a paired device");
                };
                let (mut out, mut control) = link.accept_stream().await.expect("control");
                let _hello = control.next().await;
                out.send(&ToDevice::Welcome {
                    host_name: "Studio".into(),
                    protocol_minor: 0,
                    role: Role::Viewer,
                    sessions: vec![],
                })
                .await
                .expect("welcome");
                control.next().await
            });
            let seen = Arc::new(RecordingEvents::default());
            rt.connect(
                HostEntry {
                    id: host.id(),
                    addr: host.addr(),
                },
                Arc::clone(&seen) as Arc<dyn DeviceEvents>,
            )
            .await
            .expect("connects");
            wait_until("welcome", || {
                seen.last()
                    .is_some_and(|(state, _)| state == LinkState::Connected)
            })
            .await;
            assert_eq!(rt.connected_hosts().await, vec![host.id()]);
            rt.send_push_token(&host.id(), 7, vec![1, 2, 3])
                .await
                .expect("sent");
            let heard = tokio::time::timeout(Duration::from_secs(10), heard)
                .await
                .expect("in time")
                .expect("host task");
            assert!(matches!(
                heard,
                Ok(Some(Decoded::Message(FromDevice::PushToken { key_id: 7, ref sealed }))) if sealed == &[1, 2, 3]
            ));
            rt.disconnect(&host.id()).await;
            assert_eq!(rt.connected_hosts().await, Vec::<EndpointId>::new());
        });
    }

    #[test]
    fn an_endpoint_bound_again_with_the_same_key_replaces_the_closed_one() {
        run(async {
            let rt = DeviceRuntime::default();
            let bind = || async {
                crate::endpoint::bind(
                    &LinkConfig {
                        bind: loopback(),
                        ..LinkConfig::new(DEVICE_KEY)
                    },
                    Vec::new(),
                )
                .await
                .expect("binds")
            };
            let first = bind().await;
            let attached = rt.attach(first.clone()).await;
            assert!(
                Arc::ptr_eq(&attached, &rt.attach(first.clone()).await),
                "the same one"
            );
            // Rebuilt (a new relay pass): the old endpoint closes, a new one
            // with the same key comes.
            first.close().await;
            let second = bind().await;
            let replaced = rt.attach(second.clone()).await;
            assert!(
                !Arc::ptr_eq(&attached, &replaced),
                "the new endpoint is used"
            );
            assert!(!replaced.is_closed());
        });
    }

    #[test]
    fn rebinding_keeps_each_hosts_open_sessions_on_the_new_endpoint() {
        run(async {
            let (rt, me) = device_runtime().await;
            let paired = Arc::new(MemoryPaired::of([(me, Role::Controller)]));
            let host = Arc::new(
                Host::bind(&loopback_config(1), paired, 10)
                    .await
                    .expect("host binds"),
            );
            // Each link: welcome, then hear which session is opened.
            let (opened_in, mut opened) = tokio::sync::mpsc::unbounded_channel();
            let serving = Arc::clone(&host);
            tokio::spawn(async move {
                while let Some(accepted) = serving.accept().await {
                    let Accepted::Remote(link) = accepted else {
                        continue;
                    };
                    let opened_in = opened_in.clone();
                    tokio::spawn(async move {
                        let (mut out, mut control) = link.accept_stream().await.expect("control");
                        let _hello = control.next().await;
                        out.send(&ToDevice::Welcome {
                            host_name: "Studio".into(),
                            protocol_minor: 0,
                            role: Role::Controller,
                            sessions: vec![session()],
                        })
                        .await
                        .expect("welcome");
                        let (_out, mut incoming) = link.accept_stream().await.expect("session");
                        if let Ok(Some(Decoded::Message(FromDevice::Open { session_id, .. }))) =
                            incoming.next().await
                        {
                            let _ = opened_in.send(session_id);
                        }
                        link.closed().await;
                    });
                }
            });
            let seen = Arc::new(RecordingEvents::default());
            rt.connect(
                HostEntry {
                    id: host.id(),
                    addr: host.addr(),
                },
                Arc::clone(&seen) as Arc<dyn DeviceEvents>,
            )
            .await
            .expect("connects");
            wait_until("welcome", || {
                seen.last()
                    .is_some_and(|(state, _)| state == LinkState::Connected)
            })
            .await;
            assert!(!rt.has_open_sessions().await);
            let sink: ScreenSink = Arc::new(|_| {});
            let view = SessionView::Open {
                screen: ScreenView::Fresh(sink),
                entries: None,
            };
            rt.set_view(&host.id(), "s", 1, view).await.expect("opens");
            assert!(rt.has_open_sessions().await);
            let first = tokio::time::timeout(Duration::from_secs(10), opened.recv())
                .await
                .expect("in time");
            assert_eq!(first.as_deref(), Some("s"));
            // A new endpoint with the same key (a new relay pass).
            let fresh = crate::endpoint::bind(
                &LinkConfig {
                    bind: loopback(),
                    ..LinkConfig::new(DEVICE_KEY)
                },
                Vec::new(),
            )
            .await
            .expect("binds");
            rt.rebind(fresh).await;
            let again = tokio::time::timeout(Duration::from_secs(10), opened.recv())
                .await
                .expect("opened again in time");
            assert_eq!(again.as_deref(), Some("s"), "the session comes back");
            assert!(rt.has_open_sessions().await);
            rt.set_view(&host.id(), "s", 2, SessionView::Closed)
                .await
                .expect("closes");
            assert!(!rt.has_open_sessions().await);
        });
    }
}
