//! Test support for the remote tests: the app faked behind [`ServeHost`]
//! with one live session "s" whose daemon is the test, a real host endpoint
//! serving it, and paired devices that dial it.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use kriyon_core::session::SessionStatus;
use kriyon_core::standing::StandingState;
use kriyon_remote::authorize::PendingWrite;
use kriyon_remote::codec::Decoded;
use kriyon_remote::control::{Change, HostIsTyping};
use kriyon_remote::fanout::RequesterId;
use kriyon_remote::message::{EndpointId, FromDevice, RefuseReason, Role, SessionInfo, ToDevice};
use kriyon_remote_link::device::{Device, DeviceLink};
use kriyon_remote_link::endpoint::LinkConfig;
use kriyon_remote_link::framed::{MessageReader, MessageWriter};
use kriyon_remote_link::host::{Accepted, Host, PairedDevices};
use parking_lot::Mutex;

use kriyon_remote::device_view::HostView;

use crate::daemon_client::DaemonEvent;
use crate::remote_serve::{LiveSession, Serve, ServeHost};
use kriyon_remote_link::device_runtime::{DeviceEvents, DeviceRuntime, LinkState};

/// The app, faked: one session "s", paired devices in a map.
pub(crate) struct FakeHost {
    pub(crate) paired: Mutex<HashMap<EndpointId, Role>>,
    pub(crate) gate: Mutex<kriyon_remote::writer::SessionGate>,
    pub(crate) typed: Mutex<Vec<u8>>,
    pub(crate) onlooked: Mutex<HashSet<String>>,
    pub(crate) title: Mutex<String>,
    /// The push tokens devices gave, in order.
    pub(crate) push_tokens: Mutex<Vec<(EndpointId, Vec<u8>)>>,
    /// Told every change of control, as the app's writers tell it.
    pub(crate) serve: Mutex<Option<Serve>>,
}

impl FakeHost {
    pub(crate) fn tell(&self, change: Option<Change>) {
        let serve = self.serve.lock().clone();
        if let (Some(serve), Some(change)) = (serve, change) {
            serve.broadcast_control("s", change);
        }
    }
}

impl Default for FakeHost {
    fn default() -> Self {
        let mut gate = kriyon_remote::writer::SessionGate::new(5, (80, 24));
        gate.set_run(1);
        Self {
            paired: Mutex::default(),
            gate: Mutex::new(gate),
            typed: Mutex::default(),
            onlooked: Mutex::default(),
            title: Mutex::default(),
            push_tokens: Mutex::default(),
            serve: Mutex::default(),
        }
    }
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
        if id != "s" {
            return None;
        }
        let gate = self.gate.lock();
        Some(LiveSession {
            run: gate.run()?,
            control: gate.control().clone(),
            dialog: gate.dialog(),
            size: gate.screen(),
        })
    }
    fn device_input(
        &self,
        _id: &str,
        device: &EndpointId,
        role: Role,
        write: &PendingWrite,
        bytes: &[u8],
    ) -> Result<bool, RefuseReason> {
        self.gate
            .lock()
            .device_write(device, Some(role), write, None)?;
        self.typed.lock().extend_from_slice(bytes);
        Ok(true)
    }
    fn device_resize(
        &self,
        _id: &str,
        device: &EndpointId,
        role: Role,
        write: &PendingWrite,
        size: (u16, u16),
    ) -> Result<bool, RefuseReason> {
        self.gate
            .lock()
            .device_write(device, Some(role), write, Some(size))?;
        Ok(true)
    }
    fn take(&self, _id: &str, device: EndpointId) -> Result<(), RefuseReason> {
        let change = self
            .gate
            .lock()
            .take(device, Instant::now())
            .map_err(|HostIsTyping| RefuseReason::NotInControl)?;
        self.tell(change);
        Ok(())
    }
    fn release(&self, device: &EndpointId) {
        let change = self.gate.lock().release(*device).change;
        self.tell(change);
    }
    fn set_push_token(&self, device: &EndpointId, sealed: Vec<u8>) {
        self.push_tokens.lock().push((*device, sealed));
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

pub(crate) fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 0))
}

pub(crate) struct World {
    pub(crate) host: Arc<Host>,
    pub(crate) fake: Arc<FakeHost>,
    pub(crate) serve: Serve,
    pub(crate) asks: Arc<Mutex<Vec<RequesterId>>>,
}

/// A host serving one live session "s", whose daemon is the test.
pub(crate) async fn world() -> World {
    world_on(loopback()).await
}

/// [`world`], listening on `bind`: a fixed port lets a restarted host be
/// dialed at the address its devices stored.
pub(crate) async fn world_on(bind: SocketAddr) -> World {
    let fake = Arc::new(FakeHost::default());
    *fake.title.lock() = "first".into();
    let host = Arc::new(
        Host::bind(
            &LinkConfig {
                bind,
                ..LinkConfig::new([9; 32])
            },
            Arc::clone(&fake) as Arc<dyn PairedDevices>,
            60,
        )
        .await
        .expect("host"),
    );
    let serve = Serve::new(Arc::clone(&fake) as Arc<dyn ServeHost>);
    *fake.serve.lock() = Some(serve.clone());
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
pub(crate) async fn device(
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

pub(crate) async fn next(reader: &mut MessageReader<ToDevice>) -> ToDevice {
    match tokio::time::timeout(Duration::from_secs(10), reader.next()).await {
        Ok(Ok(Some(Decoded::Message(message)))) => message,
        other => panic!("no message: {other:?}"),
    }
}

/// The next requester id the daemon (the test) is asked a snapshot for.
pub(crate) async fn asked(world: &World) -> RequesterId {
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
pub(crate) fn answer(world: &World, id: RequesterId, screen: &[u8]) {
    let _ = world
        .serve
        .on_event("s", DaemonEvent::Snapshot { id, bytes: screen });
    let _ = world.serve.on_event("s", DaemonEvent::SnapshotEnd { id });
}

pub(crate) async fn open(
    link: &DeviceLink,
) -> (MessageWriter<FromDevice>, MessageReader<ToDevice>) {
    let (mut writer, reader) = link.open_stream().await.expect("session stream");
    writer
        .send(&FromDevice::Open {
            session_id: "s".into(),
        })
        .await
        .expect("open");
    (writer, reader)
}

pub(crate) fn run<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

/// What a device side told the app: each link state with the host view then.
#[derive(Default)]
pub(crate) struct DeviceSeen(Mutex<Vec<(LinkState, HostView)>>);

impl DeviceEvents for DeviceSeen {
    fn host_changed(&self, _host: EndpointId, state: LinkState, view: &HostView) {
        self.0.lock().push((state, view.clone()));
    }
}

impl DeviceSeen {
    /// The latest state and view.
    pub(crate) fn last(&self) -> Option<(LinkState, HostView)> {
        self.0.lock().last().cloned()
    }

    /// The latest state.
    pub(crate) fn state(&self) -> Option<LinkState> {
        self.0.lock().last().map(|(state, _)| *state)
    }
}

/// Put `rt` on its own loopback endpoint with key `key`; returns its id.
pub(crate) async fn on_loopback(rt: &DeviceRuntime, key: [u8; 32]) -> EndpointId {
    let endpoint = kriyon_remote_link::endpoint::bind(
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
pub(crate) async fn wait_until(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !check() {
        assert!(Instant::now() < deadline, "never saw {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
