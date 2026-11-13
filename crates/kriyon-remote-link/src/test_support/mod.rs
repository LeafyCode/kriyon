//! Fakes and helpers for tests of the link over loopback, shared by this
//! crate's tests and the app's (the `test-support` feature). Never in a
//! release build.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use kriyon_remote::device_view::{HostView, LinkState};
use kriyon_remote::message::{EndpointId, Role};

use crate::device_runtime::{DeviceEvents, DeviceRuntime};
use crate::host::PairedDevices;
use crate::LinkConfig;

pub mod host_world;

/// The [Paired device]s a host knows, in memory.
#[derive(Debug, Default)]
pub struct MemoryPaired(Mutex<HashMap<EndpointId, Role>>);

impl MemoryPaired {
    /// Paired with these devices, in these roles.
    #[must_use]
    pub fn of(devices: impl IntoIterator<Item = (EndpointId, Role)>) -> Self {
        Self(Mutex::new(devices.into_iter().collect()))
    }

    pub fn add(&self, device: EndpointId, role: Role) {
        lock(&self.0).insert(device, role);
    }

    pub fn remove(&self, device: &EndpointId) {
        lock(&self.0).remove(device);
    }
}

impl PairedDevices for MemoryPaired {
    fn role(&self, device: &EndpointId) -> Option<Role> {
        lock(&self.0).get(device).copied()
    }
}

/// A lock, whether or not a test panicked holding it.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Any free port on the loopback address.
#[must_use]
pub fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 0))
}

/// A link config on [`loopback`] with a key of `seed` repeated.
#[must_use]
pub fn loopback_config(seed: u8) -> LinkConfig {
    LinkConfig {
        bind: loopback(),
        ..LinkConfig::new([seed; 32])
    }
}

/// What a device side told the app: each link state with the host view.
#[derive(Debug, Default)]
pub struct RecordingEvents(Mutex<Vec<(LinkState, HostView)>>);

impl DeviceEvents for RecordingEvents {
    fn host_changed(&self, _host: EndpointId, state: LinkState, view: &HostView) {
        lock(&self.0).push((state, view.clone()));
    }
}

impl RecordingEvents {
    /// The latest state and view.
    #[must_use]
    pub fn last(&self) -> Option<(LinkState, HostView)> {
        lock(&self.0).last().cloned()
    }

    /// The latest state.
    #[must_use]
    pub fn state(&self) -> Option<LinkState> {
        self.last().map(|(state, _)| state)
    }
}

/// Put `rt` on its own loopback endpoint with key `key`; returns its id.
///
/// # Panics
/// When the endpoint can't bind.
pub async fn on_loopback(rt: &DeviceRuntime, key: [u8; 32]) -> EndpointId {
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

/// Wait until `check` holds.
///
/// # Panics
/// Naming `what`, after ten seconds.
pub async fn wait_until(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !check() {
        assert!(Instant::now() < deadline, "never saw {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Run `f` to its end on a multi-threaded runtime of its own.
///
/// # Panics
/// When the runtime can't be built.
pub fn run<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(f)
}
