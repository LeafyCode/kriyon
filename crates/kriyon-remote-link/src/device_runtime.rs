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
use kriyon_remote::device_view::{HostView, ScreenEvent, SessionScreen};
use kriyon_remote::link_policy::{CloseCode, HeartbeatWatch};
use kriyon_remote::message::{EndpointId, FromDevice, Holder, RefuseReason, SessionId, ToDevice};
use kriyon_remote::pairing::PairingInvite;
use serde::Serialize;
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;

/// The protocol minor this build speaks.
pub const PROTOCOL_MINOR: u16 = 0;

/// How often a link checks its heartbeat and a lost screen asks again.
const TICK: Duration = Duration::from_secs(1);

/// How long a link that ended by itself waits for the host's close reason.
const HOST_CLOSE_WAIT: Duration = Duration::from_secs(2);

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

/// Told when a host's link or view changes.
pub trait DeviceEvents: Send + Sync + 'static {
    fn host_changed(&self, host: EndpointId, state: LinkState, view: &HostView);
}

/// Where one session's screen events go.
pub type ScreenSink = Arc<dyn Fn(ScreenEvent) + Send + Sync>;

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
    conn: Mutex<Conn>,
    task: std::sync::Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
struct Conn {
    state: Option<LinkState>,
    view: HostView,
    link: Option<Arc<DeviceLink>>,
    control: Option<Arc<Mutex<MessageWriter<FromDevice>>>>,
    sessions: HashMap<SessionId, OpenSession>,
    /// The sessions the person has open here, and where their screens go:
    /// opened again on each new link, so a reconnect redraws them.
    wanted: HashMap<SessionId, ScreenSink>,
}

struct OpenSession {
    writer: Arc<Mutex<MessageWriter<FromDevice>>>,
    screen: Arc<std::sync::Mutex<SessionScreen>>,
    reader: JoinHandle<()>,
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

    /// Dial from this device's one endpoint, which may also host. Replaces an endpoint that was closed.
    pub async fn attach(&self, endpoint: iroh::Endpoint) -> Arc<Device> {
        let mut device = self.device.lock().await;
        match device.as_ref() {
            Some(device) if device.id() == *endpoint.id().as_bytes() && !endpoint.is_closed() => {
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
            conn: Mutex::new(Conn::default()),
            task: std::sync::Mutex::new(None),
        });
        hosts.insert(host.id, Arc::clone(&conn));
        drop(hosts);
        let wake = Arc::clone(&self.wake);
        let timing = self.timing;
        let staying = Arc::clone(&conn);
        let task = tokio::spawn(async move {
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
            set_state(&staying, host.id, LinkState::Removed, events.as_ref()).await;
        });
        *conn
            .task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(task);
        Ok(())
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
    }

    /// Retry every waiting reconnect at once: the network changed, or the
    /// app came to the front.
    pub fn wake(&self) {
        self.wake.notify_waiters();
    }

    /// Open `session` on `host`; its screen events go to `sink`. While the
    /// link is down it opens once the host welcomes this device again, and
    /// on every link after, until closed.
    ///
    /// # Errors
    /// [`DeviceError::NotConnected`] for a host not paired here, or a link
    /// failure.
    pub async fn open_session(
        &self,
        host: &EndpointId,
        session: &str,
        sink: ScreenSink,
    ) -> Result<(), DeviceError> {
        let conn = self.host(host).await?;
        let link = {
            let mut c = conn.conn.lock().await;
            c.wanted.insert(session.to_string(), Arc::clone(&sink));
            c.link
                .clone()
                .filter(|_| c.state == Some(LinkState::Connected))
        };
        match link {
            Some(link) => open_wanted(&conn, &link, session, &sink).await,
            None => Ok(()),
        }
    }

    /// Close `session`'s stream; the session keeps running on the host.
    pub async fn close_session(&self, host: &EndpointId, session: &str) {
        let Ok(conn) = self.host(host).await else {
            return;
        };
        let open = {
            let mut c = conn.conn.lock().await;
            c.wanted.remove(session);
            c.sessions.remove(session)
        };
        if let Some(open) = open {
            let_go(open).await;
        }
    }

    /// Ask for typing control of `session`.
    ///
    /// # Errors
    /// [`DeviceError::NotConnected`] or a link failure.
    pub async fn take_control(&self, host: &EndpointId, session: &str) -> Result<(), DeviceError> {
        let conn = self.host(host).await?;
        let control = conn
            .conn
            .lock()
            .await
            .control
            .clone()
            .ok_or(DeviceError::NotConnected)?;
        let sent = control
            .lock()
            .await
            .send(&FromDevice::TakeControl {
                session_id: session.to_string(),
            })
            .await;
        sent.map_err(|e| DeviceError::Link(e.to_string()))
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
            let message = open
                .screen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .input(control.epoch, bytes)
                .ok_or(DeviceError::NoScreen)?;
            (Arc::clone(&open.writer), message)
        };
        let sent = writer.lock().await.send(&message).await;
        sent.map_err(|e| DeviceError::Link(e.to_string()))
    }
}

/// Open `session` on `link` for the person, who asked for it with `sink`.
/// Kept only if they still want it with that sink and `link` is still the
/// host's link once the stream is open; otherwise let go at once.
async fn open_wanted(
    conn: &HostConn,
    link: &Arc<DeviceLink>,
    session: &str,
    sink: &ScreenSink,
) -> Result<(), DeviceError> {
    let link_err = |e: LinkError| DeviceError::Link(e.to_string());
    let (mut writer, reader) = link.open_stream().await.map_err(link_err)?;
    writer
        .send(&FromDevice::Open {
            session_id: session.to_string(),
        })
        .await
        .map_err(link_err)?;
    let screen = SessionScreen::new().map_err(|e| DeviceError::Link(format!("{e:?}")))?;
    let writer = Arc::new(Mutex::new(writer));
    let screen = Arc::new(std::sync::Mutex::new(screen));
    let reader = tokio::spawn(read_session(
        reader,
        Arc::clone(&writer),
        Arc::clone(&screen),
        Arc::clone(sink),
    ));
    let open = OpenSession {
        writer,
        screen,
        reader,
    };
    let mut c = conn.conn.lock().await;
    let still_wanted = c
        .wanted
        .get(session)
        .is_some_and(|wanted| Arc::ptr_eq(wanted, sink));
    let same_link = c.link.as_ref().is_some_and(|now| Arc::ptr_eq(now, link));
    let gone = if still_wanted && same_link {
        c.sessions.insert(session.to_string(), open)
    } else {
        Some(open)
    };
    drop(c);
    if let Some(gone) = gone {
        let_go(gone).await;
    }
    Ok(())
}

/// End a session stream here: the host stops sending it.
async fn let_go(open: OpenSession) {
    open.reader.abort();
    open.writer.lock().await.finish();
}

/// Open again, on a new link, every session the person has open here.
async fn reopen(conn: Arc<HostConn>, link: Arc<DeviceLink>) {
    let wanted: Vec<(SessionId, ScreenSink)> = conn
        .conn
        .lock()
        .await
        .wanted
        .iter()
        .map(|(id, sink)| (id.clone(), Arc::clone(sink)))
        .collect();
    for (session, sink) in wanted {
        if conn.conn.lock().await.sessions.contains_key(&session) {
            continue;
        }
        // A session gone from the host is refused on its own stream, and the
        // screen says so; a failed link is dialed again and reopens it.
        if let Err(why) = open_wanted(&conn, &link, &session, &sink).await {
            eprintln!("kriyon: couldn't reopen remote session {session}: {why}");
        }
    }
}

/// Record `state` and tell the app.
async fn set_state(conn: &HostConn, host: EndpointId, state: LinkState, events: &dyn DeviceEvents) {
    let mut c = conn.conn.lock().await;
    c.state = Some(state);
    events.host_changed(host, state, &c.view);
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
        let state = c.state.unwrap_or(LinkState::Connecting);
        events.host_changed(host, state, &c.view);
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
        protocol_minor: PROTOCOL_MINOR,
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
                let changed = c.view.apply(&message);
                // This link's own Welcome: the view keeps the last link's.
                let now_connected = matches!(message, ToDevice::Welcome { .. })
                    && c.state != Some(LinkState::Connected);
                if now_connected {
                    c.state = Some(LinkState::Connected);
                    welcomed = true;
                    // Redraw what the person had open before the link dropped.
                    tokio::spawn(reopen(Arc::clone(conn), Arc::clone(link)));
                }
                if changed || now_connected {
                    let state = c.state.unwrap_or(LinkState::Connecting);
                    events.host_changed(host, state, &c.view);
                }
            }
            _ = tick.tick() => {
                if watch.lost(Instant::now()) {
                    // Typing goes off; the link is dropped and dialed again.
                    set_state(conn, host, LinkState::Lost, events).await;
                    return (welcomed, true);
                }
            }
        }
    }
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
    screen: Arc<std::sync::Mutex<SessionScreen>>,
    sink: ScreenSink,
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
                let events = lock(&screen).on_message(message, Instant::now());
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
            _ = tick.tick() => lock(&screen).resync_due(Instant::now()),
        };
        if resync && writer.lock().await.send(&FromDevice::Resync).await.is_err() {
            return;
        }
    }
}

/// One session's screen event as one frame on the webview's raw channel, so
/// a new screen and the output after it arrive in order: a kind byte, then
/// its fields. `None` for what the webview doesn't see (`Resync` is Rust's).
///
/// - `0` output: the bytes.
/// - `1` screen: cols (u16 BE), rows (u16 BE), skipped (0/1), the bytes.
/// - `2` receipt: written (0/1).
/// - `3` refused: the reason's number.
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
        ScreenEvent::Refused(reason) => Some(vec![3, reason_number(*reason)]),
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

    use crate::host::{Accepted, Host, PairedDevices};
    use crate::LinkConfig;
    use kriyon_core::session::SessionStatus;
    use kriyon_core::standing::StandingState;
    use kriyon_remote::compress::{compress, Kind};
    use kriyon_remote::message::{Epoch, Role, SessionInfo};

    use super::*;

    fn loopback() -> std::net::SocketAddr {
        std::net::SocketAddr::from(([127, 0, 0, 1], 0))
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }

    /// What a device side told the app: each link state with the host view.
    #[derive(Default)]
    struct DeviceSeen(StdMutex<Vec<(LinkState, HostView)>>);

    impl DeviceEvents for DeviceSeen {
        fn host_changed(&self, _host: EndpointId, state: LinkState, view: &HostView) {
            self.0.lock().expect("seen").push((state, view.clone()));
        }
    }

    impl DeviceSeen {
        fn last(&self) -> Option<(LinkState, HostView)> {
            self.0.lock().expect("seen").last().cloned()
        }
    }

    /// Attach `rt` to a new loopback endpoint with `key`; returns its id.
    async fn on_loopback(rt: &DeviceRuntime, key: [u8; 32]) -> EndpointId {
        let endpoint = crate::endpoint::bind(
            &LinkConfig {
                bind: loopback(),
                ..LinkConfig::new(key)
            },
            Vec::new(),
        )
        .await
        .expect("binds");
        rt.attach(endpoint).await.id()
    }

    /// Wait until `check` holds, failing with `what` after ten seconds.
    async fn wait_until(what: &str, mut check: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !check() {
            assert!(Instant::now() < deadline, "never saw {what}");
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

    struct Paired(StdMutex<HashMap<EndpointId, Role>>);
    impl PairedDevices for Paired {
        fn role(&self, device: &EndpointId) -> Option<Role> {
            self.0.lock().expect("lock").get(device).copied()
        }
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
        }
    }

    /// A host in-process that answers the way the host side will: Welcome
    /// and a heartbeat on the control stream; a snapshot and two updates on
    /// a session stream; `InputAck` for input; `Control` for `TakeControl`.
    async fn fake_host(
        device_id: EndpointId,
        heartbeats: bool,
    ) -> (Arc<Host>, JoinHandle<Vec<FromDevice>>) {
        let paired = Arc::new(Paired(StdMutex::new(HashMap::from([(
            device_id,
            Role::Controller,
        )]))));
        let host = Arc::new(
            Host::bind(
                &LinkConfig {
                    bind: loopback(),
                    ..LinkConfig::new([1; 32])
                },
                paired,
                10,
            )
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
            let seen = Arc::new(DeviceSeen::default());
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
            rt.disconnect(&host.id()).await;
        });
    }

    #[test]
    fn a_session_streams_its_screen_then_takes_control_and_types() {
        run(async {
            let (rt, me) = device_runtime().await;
            let (host, serving) = fake_host(me, true).await;
            let seen = Arc::new(DeviceSeen::default());
            rt.connect(entry(&host), seen.clone())
                .await
                .expect("connects");
            wait_until("welcomed", || {
                seen.last().is_some_and(|(_, view)| view.welcomed())
            })
            .await;

            let events = Arc::new(StdMutex::new(Vec::new()));
            let sink_events = Arc::clone(&events);
            rt.open_session(
                &host.id(),
                "s1",
                Arc::new(move |event| sink_events.lock().expect("lock").push(event)),
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
                session_id: "s1".into()
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
    fn opening_a_session_with_no_link_is_refused() {
        run(async {
            let rt = DeviceRuntime::default();
            let sink: ScreenSink = Arc::new(|_| {});
            assert_eq!(
                rt.open_session(&[9; 32], "s1", sink).await,
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
            let seen = Arc::new(DeviceSeen::default());
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
            Some(vec![3, 4])
        );
        assert_eq!(screen_frame(&ScreenEvent::Resync), None);
    }
}
