//! The phone as a [Remote device]: one object the app holds, over the
//! shared device runtime. It keeps the device key and the paired computers
//! in the store the app provides (the phone's secure store), pairs from a
//! pairing code's text, keeps each paired computer connected, and passes a
//! session's screen to the app as frames.

use kriyon_remote::device_view::LinkState;
use std::net::SocketAddr;
use std::sync::Arc;

use kriyon_relay_client::keeper::{now_s, InUse, PassKeeper, Rebind, CHECK_EVERY};
use kriyon_relay_client::runtime::{RelayRuntime, RelaySetup, ThisDevice};
use kriyon_remote::device_view::{host_summary, name_of, HostView, LinkFacts};
use kriyon_remote::message::{hex, parse_id_hex, EndpointId, Role};
use kriyon_remote::pairing::PairingInvite;
use kriyon_remote_link::device::DevicePairing;
use kriyon_remote_link::device_runtime::{
    screen_frame, DeviceError, DeviceEvents, DeviceRuntime, EntriesSink, HostEntry, ScreenSink,
    ScreenView, SessionView, StartError,
};
use kriyon_remote_link::keys::{load_or_create, SecretVault};
use kriyon_remote_link::{LinkConfig, RelayAccess};

use crate::hosts::{hosts_bytes, read_hosts, with_host, without_host, PairedHost, HOSTS_KEY};

/// The store key of the device key.
pub const DEVICE_KEY: &str = "device-key";

/// Kept while the person has this phone's alerts off (absent: on).
pub const ALERTS_OFF_KEY: &str = "alerts-off";

/// Why the phone's store couldn't do something.
#[derive(Debug, PartialEq, Eq, uniffi::Error)]
pub enum StoreError {
    Failed { reason: String },
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed { reason } => f.write_str(reason),
        }
    }
}

impl From<uniffi::UnexpectedUniFFICallbackError> for StoreError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        Self::Failed {
            reason: error.reason,
        }
    }
}

/// The phone's secure store (the iPhone keychain, Android's keystore),
/// provided by the app. Values are bytes under short keys.
#[uniffi::export(with_foreign)]
pub trait PhoneStore: Send + Sync {
    /// The value under `key`, or `None`.
    ///
    /// # Errors
    /// Why the store couldn't be read (locked, say): never taken for "none".
    fn read(&self, key: String) -> Result<Option<Vec<u8>>, StoreError>;

    /// Keep `value` under `key`, replacing what was there.
    ///
    /// # Errors
    /// Why the store couldn't be written.
    fn write(&self, key: String, value: Vec<u8>) -> Result<(), StoreError>;

    /// Remove `key`; nothing there is fine.
    ///
    /// # Errors
    /// Why the store couldn't be written.
    fn remove(&self, key: String) -> Result<(), StoreError>;
}

/// Told whenever a paired computer's link or sessions change, with its
/// summary as JSON (`kriyon_remote::device_view::HostSummary`): the app
/// passes it on as it is.
#[uniffi::export(with_foreign)]
pub trait HostListener: Send + Sync {
    fn host_changed(&self, summary: String);
}

/// `value` as the JSON the app reads. Plain records always serialize.
pub(crate) fn json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// Where one open session's screen goes: frames as the desktop's terminal
/// view reads them (`kriyon_remote_link::device_runtime::screen_frame`).
#[uniffi::export(with_foreign)]
pub trait ScreenListener: Send + Sync {
    fn frame(&self, frame: Vec<u8>);
}

/// Where one open session's [Readable view] goes: the JSON of
/// `kriyon_remote::device_view::ReadableSummary`, whole, on every change.
#[uniffi::export(with_foreign)]
pub trait EntriesListener: Send + Sync {
    fn entries_changed(&self, summary: String);
}

/// A screen's events as the frames `listener` reads; `Resync` is Rust's own.
fn screen_sink(listener: Arc<dyn ScreenListener>) -> ScreenSink {
    Arc::new(move |event| {
        if let Some(frame) = screen_frame(&event) {
            listener.frame(frame);
        }
    })
}

/// Why a phone action couldn't happen, in words the app can show. Its
/// words (Display) cross to the app as they are.
#[derive(Debug, PartialEq, Eq, uniffi::Error)]
#[uniffi::export(Display)]
pub enum MobileError {
    /// The store failed.
    Store { reason: String },
    /// Text that isn't a pairing code, an id that isn't one.
    Invalid { reason: String },
    /// Not connected to that computer now.
    NotConnected,
    /// That session isn't open here.
    NotOpen,
    /// This phone doesn't have typing control of that session.
    NoControl,
    /// The screen hasn't arrived yet.
    NoScreen,
    /// The link failed, or the computer refused.
    Link { reason: String },
    /// The computer refused a start: its reason by name (`FolderNotAllowed`),
    /// and in words to show.
    Refused { reason: String, words: String },
}

impl std::fmt::Display for MobileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store { reason } | Self::Invalid { reason } | Self::Link { reason } => {
                f.write_str(reason)
            }
            Self::Refused { words, .. } => f.write_str(words),
            Self::NotConnected => f.write_str("not connected to that computer"),
            Self::NotOpen => f.write_str("that session isn't open"),
            Self::NoControl => f.write_str("this phone doesn't have control"),
            Self::NoScreen => f.write_str("the screen hasn't arrived yet"),
        }
    }
}

impl From<StartError> for MobileError {
    fn from(error: StartError) -> Self {
        match error {
            StartError::Refused(reason) => Self::Refused {
                reason: name_of(&reason),
                words: error.words().to_string(),
            },
            StartError::NotConnected => Self::NotConnected,
            StartError::Gone => Self::Link {
                reason: error.words().to_string(),
            },
        }
    }
}

impl From<DeviceError> for MobileError {
    fn from(error: DeviceError) -> Self {
        match error {
            DeviceError::NotConnected => Self::NotConnected,
            DeviceError::NotOpen => Self::NotOpen,
            DeviceError::NoControl => Self::NoControl,
            DeviceError::NoScreen => Self::NoScreen,
            DeviceError::Link(reason) => Self::Link { reason },
        }
    }
}

fn store_error(error: &StoreError) -> MobileError {
    MobileError::Store {
        reason: error.to_string(),
    }
}

/// The device key, kept in the phone's store.
struct StoreVault<'a>(&'a dyn PhoneStore);

impl SecretVault for StoreVault<'_> {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        self.0.read(DEVICE_KEY.into()).map_err(|e| e.to_string())
    }

    fn write(&self, secret: &[u8]) -> Result<(), String> {
        self.0
            .write(DEVICE_KEY.into(), secret.to_vec())
            .map_err(|e| e.to_string())
    }

    fn remove(&self) -> Result<(), String> {
        self.0.remove(DEVICE_KEY.into()).map_err(|e| e.to_string())
    }
}

/// The device runtime's news, as the phone's records; a computer whose
/// link just came up is given the push token.
struct Told {
    me: EndpointId,
    listener: Arc<dyn HostListener>,
    /// Set once the device is made.
    shared: std::sync::OnceLock<std::sync::Weak<Shared>>,
    /// Each computer's link as last told, to see one come up.
    last: std::sync::Mutex<std::collections::HashMap<EndpointId, LinkState>>,
}

impl DeviceEvents for Told {
    fn host_changed(&self, host: EndpointId, link: &LinkFacts, view: &HostView) {
        let state = link.state;
        let came_up = locked(&self.last).insert(host, state) != Some(LinkState::Connected)
            && state == LinkState::Connected;
        if came_up {
            if let Some(shared) = self.shared.get().and_then(std::sync::Weak::upgrade) {
                shared.give_push(host);
            }
        }
        self.listener
            .host_changed(json(&host_summary(&host, &self.me, link, view)));
    }
}

/// The push token this phone gave.
#[derive(Clone)]
struct PushToken {
    token: String,
    platform: kriyon_remote::push::Platform,
}

/// How long one computer may take to be given the push token.
const PUSH_SEND_WAIT: std::time::Duration = std::time::Duration::from_secs(20);

/// What the device and its pairings share.
pub(crate) struct Shared {
    handle: tokio::runtime::Handle,
    device: Arc<DeviceRuntime>,
    store: Arc<dyn PhoneStore>,
    events: Arc<dyn DeviceEvents>,
    /// Held across each change to the kept list, so two never lose one.
    hosts_lock: std::sync::Mutex<()>,
    /// The push sender (`KRIYON_PUSH_URL` at build time); none: no push.
    push_url: Option<String>,
    push: std::sync::Mutex<Option<PushToken>>,
    /// The person turned this phone's alerts off: no computer is given the
    /// push token.
    alerts_off: std::sync::atomic::AtomicBool,
    /// Our relay (`KRIYON_RELAY_API` at build time); none: no relay.
    pub(crate) relay: Option<Arc<RelayRuntime>>,
    /// The endpoint, and the relay it was bound with and when that pass
    /// expires: iroh reads the pass only then, so a new one needs a new
    /// endpoint.
    link: tokio::sync::Mutex<(iroh::Endpoint, Option<(RelayAccess, u64)>)>,
    secret: [u8; 32],
    bind: SocketAddr,
    /// This phone as the relay account knows it.
    pub(crate) this: ThisDevice,
    /// When to renew the pass and rebuild the endpoint: the desktop's
    /// rules, shared.
    keeper: PassKeeper,
}

/// The relay this phone's endpoint should use now, with when its pass
/// expires: none without a relay, while off, or without a pass.
async fn wanted_relay(relay: Option<&Arc<RelayRuntime>>) -> Option<(RelayAccess, u64)> {
    match relay {
        Some(relay) => relay.access().await,
        None => None,
    }
}

/// This phone's endpoint as the [`PassKeeper`] rebuilds it.
struct PhoneEndpoint {
    shared: Arc<Shared>,
    relay: Arc<RelayRuntime>,
}

impl Rebind for PhoneEndpoint {
    fn relay(&self) -> &RelayRuntime {
        &self.relay
    }

    fn this_device(&self) -> Option<ThisDevice> {
        Some(self.shared.this.clone())
    }

    async fn want(&self, relay: Option<(RelayAccess, u64)>) -> InUse {
        let link = self.shared.link.lock().await;
        InUse {
            stale: link.1.as_ref().map(|(access, _)| access)
                != relay.as_ref().map(|(access, _)| access),
            expires_s: link.1.as_ref().map(|(_, expires)| *expires),
        }
    }

    async fn quiet(&self) -> bool {
        !self.shared.device.has_open_sessions().await
    }

    async fn rebind(&self, relay: Option<(RelayAccess, u64)>) -> Result<(), String> {
        Arc::clone(&self.shared).rebind_endpoint(relay).await
    }

    /// The app reads the relay when it shows it: nothing to tell.
    fn changed(&self) {}
}

/// The platform the relay account lists this phone as.
fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else {
        "ios"
    }
}

fn locked<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Shared {
    /// This phone's endpoint for the keeper; none without a relay.
    fn pass_endpoint(self: &Arc<Self>) -> Option<PhoneEndpoint> {
        self.relay.as_ref().map(|relay| PhoneEndpoint {
            shared: Arc::clone(self),
            relay: Arc::clone(relay),
        })
    }

    /// Put the relay as it stands to use: if the endpoint uses another relay
    /// or pass, rebuild it at once when `now` (the person asked), else at a
    /// quiet moment or before the pass in use runs out. Returns whether it
    /// was rebuilt.
    pub(crate) async fn apply_relay(self: &Arc<Self>, now: bool) -> Result<bool, MobileError> {
        let Some(endpoint) = self.pass_endpoint() else {
            return Ok(false);
        };
        let shared = Arc::clone(self);
        self.on_runtime(async move {
            // A pass that is due is fetched first, so the new endpoint
            // doesn't take one about to be replaced.
            endpoint.relay.renew(now_s(), &shared.this, false).await;
            shared
                .keeper
                .apply(now_s(), &endpoint, now)
                .await
                .map_err(|reason| MobileError::Link { reason })
        })
        .await?
    }

    /// Renew the pass if it is due (or the relay refused it), and put a new
    /// one to use when it is time: on every wake, and every
    /// [`CHECK_EVERY`] while the app runs.
    async fn check_relay(self: Arc<Self>) {
        if let Some(endpoint) = self.pass_endpoint() {
            self.keeper.check(now_s(), &endpoint).await;
        }
    }

    /// Bind a new endpoint with `wanted`, and move every computer and the
    /// sessions open here to it.
    async fn rebind_endpoint(
        self: Arc<Self>,
        wanted: Option<(RelayAccess, u64)>,
    ) -> Result<(), String> {
        let mut link = self.link.lock().await;
        // The new endpoint first: if it can't be bound, nothing changes.
        let config = LinkConfig {
            bind: self.bind,
            relay: wanted.as_ref().map(|(access, _)| access.clone()),
            ..LinkConfig::new(self.secret)
        };
        let endpoint = kriyon_remote_link::endpoint::bind(&config, Vec::new())
            .await
            .map_err(|e| e.to_string())?;
        self.device.rebind(endpoint.clone()).await;
        let old = std::mem::replace(&mut *link, (endpoint.clone(), wanted.clone()));
        drop(link);
        old.0.close().await;
        if wanted.is_some() {
            Arc::clone(&self).watch_relay(endpoint);
        }
        Ok(())
    }

    /// Watch what the relay says about `endpoint` until it closes, and act
    /// on a refusal (the contract's table), as the keeper says.
    fn watch_relay(self: Arc<Self>, endpoint: iroh::Endpoint) {
        let handle = self.handle.clone();
        handle.spawn(async move {
            if let Some(pass_endpoint) = self.pass_endpoint() {
                self.keeper.watch(&endpoint, &pass_endpoint).await;
            }
        });
    }

    /// The relay the endpoint uses now.
    #[cfg(test)]
    pub(crate) async fn bound_relay(&self) -> Option<RelayAccess> {
        self.link.lock().await.1.clone().map(|(access, _)| access)
    }

    /// Give `host` the push token in the background; one computer that
    /// can't take it never holds up another.
    fn give_push(self: &Arc<Self>, host: EndpointId) {
        let shared = Arc::clone(self);
        self.handle.spawn(async move {
            // It is given again on the next link if this one fails.
            let _ = tokio::time::timeout(PUSH_SEND_WAIT, shared.send_push(host)).await;
        });
    }

    /// Give `host` the push token, sealed for it to the push sender's
    /// newest key (fetched each time, so a rotated key is taken up on the
    /// next link). Nothing to give, or no sender: done.
    async fn send_push(&self, host: EndpointId) -> Result<(), MobileError> {
        if self.alerts_off.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        let (Some(push), Some(url)) = (locked(&self.push).clone(), self.push_url.clone()) else {
            return Ok(());
        };
        let key = crate::push::fetch_sender_key(&url)
            .await
            .map_err(|reason| MobileError::Link { reason })?;
        let (key_id, sealed) =
            crate::push::seal_for(&key, &push.token, push.platform, &host, now_s())
                .map_err(|reason| MobileError::Invalid { reason })?;
        // Alerts turned off while the key was fetched: not given after all.
        if self.alerts_off.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        Ok(self.device.send_push_token(&host, key_id, sealed).await?)
    }

    /// Run `work` on the library's own runtime, whatever thread the app
    /// calls from.
    async fn on_runtime<T: Send + 'static>(
        &self,
        work: impl std::future::Future<Output = T> + Send + 'static,
    ) -> Result<T, MobileError> {
        self.handle
            .spawn(work)
            .await
            .map_err(|e| MobileError::Link {
                reason: e.to_string(),
            })
    }

    fn hosts(&self) -> Result<Vec<PairedHost>, MobileError> {
        let kept = self
            .store
            .read(HOSTS_KEY.into())
            .map_err(|e| store_error(&e))?;
        read_hosts(kept.as_deref()).map_err(|reason| MobileError::Store { reason })
    }

    /// Change the kept list with `change`; one change at a time. A list
    /// that can't be read is never written over.
    fn update_hosts(
        &self,
        change: impl FnOnce(Vec<PairedHost>) -> Vec<PairedHost>,
    ) -> Result<(), MobileError> {
        let _held = self
            .hosts_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let hosts = change(self.hosts()?);
        self.store
            .write(HOSTS_KEY.into(), hosts_bytes(&hosts))
            .map_err(|e| store_error(&e))
    }

    /// Keep a link to `host`. A link left from before (one the computer
    /// ended by removing this phone) is replaced, so pairing again connects.
    async fn connect(&self, host: &PairedHost) -> Result<(), MobileError> {
        let entry = host_entry(host)?;
        let device = Arc::clone(&self.device);
        let events = Arc::clone(&self.events);
        self.on_runtime(async move {
            device.disconnect(&entry.id).await;
            device.connect(entry, events).await
        })
        .await?
        .map_err(|reason| MobileError::Link { reason })
    }
}

/// How to reach a kept host.
fn host_entry(host: &PairedHost) -> Result<HostEntry, MobileError> {
    let id = parse_host_id(&host.host_id)?;
    let addr =
        kriyon_remote_link::invite::endpoint_addr(&id, &host.addrs, host.relay_url.as_deref())
            .map_err(|e| MobileError::Invalid {
                reason: e.to_string(),
            })?;
    Ok(HostEntry { id, addr })
}

fn parse_host_id(text: &str) -> Result<EndpointId, MobileError> {
    parse_id_hex(text).ok_or_else(|| MobileError::Invalid {
        reason: "a computer's id is 64 lowercase hex digits".into(),
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A pairing in progress: show [`Pairing::code`], then await
/// [`Pairing::finish`] while the person types it into the computer.
#[derive(uniffi::Object)]
pub struct Pairing {
    code: String,
    /// The role the computer offers, and until when (Unix ms) it waits
    /// for the code.
    role: Role,
    expires_at_ms: i64,
    invite: PairingInvite,
    finish: tokio::sync::Mutex<Option<DevicePairing>>,
    shared: Arc<Shared>,
    cancelled: std::sync::atomic::AtomicBool,
}

#[uniffi::export]
impl Pairing {
    /// The six-digit code to type into the computer.
    #[must_use]
    pub fn code(&self) -> String {
        self.code.clone()
    }

    /// The code step, as JSON: `{code, role, expiresAtMs}`, the role the
    /// computer offers (`viewer` or `controller`) and until when (Unix ms)
    /// it waits for the code.
    #[must_use]
    pub fn offer(&self) -> String {
        json(&serde_json::json!({
            "code": self.code,
            "role": match self.role {
                Role::Viewer => "viewer",
                Role::Controller => "controller",
            },
            "expiresAtMs": self.expires_at_ms,
        }))
    }

    /// Stop this pairing: if the computer still accepts the code, the phone
    /// keeps nothing of it.
    pub fn cancel(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Wait for the computer to accept the code; the computer kept, as
    /// JSON (a `PairedHost`). It is kept and connected before this returns.
    ///
    /// # Errors
    /// The computer refused, the code wasn't typed in time, or the store
    /// failed.
    #[uniffi::method(name = "finish")]
    pub async fn finish_json(&self) -> Result<String, MobileError> {
        self.finish().await.map(|host| json(&host))
    }
}

impl Pairing {
    /// Wait for the computer to accept the code. The computer is kept and
    /// connected before this returns.
    ///
    /// # Errors
    /// The computer refused, the code wasn't typed in time, or the store
    /// failed.
    pub async fn finish(&self) -> Result<PairedHost, MobileError> {
        let finish = self
            .finish
            .lock()
            .await
            .take()
            .ok_or(MobileError::Invalid {
                reason: "this pairing already ended".into(),
            })?;
        let name = self
            .shared
            .on_runtime(finish.finish())
            .await?
            .map_err(|e| MobileError::Link {
                reason: e.to_string(),
            })?;
        if self.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(MobileError::Invalid {
                reason: "the pairing was cancelled".into(),
            });
        }
        let host = PairedHost {
            host_id: hex(&self.invite.host_id),
            name,
            addrs: self.invite.addrs.clone(),
            relay_url: self.invite.relay_url.clone(),
            paired_at_ms: now_ms(),
        };
        // An unreadable list is never written over: the error says so.
        let kept = host.clone();
        self.shared.update_hosts(|hosts| with_host(hosts, kept))?;
        self.shared.connect(&host).await?;
        Ok(host)
    }
}

/// The phone's device side, one per app.
#[derive(uniffi::Object)]
pub struct MobileDevice {
    me: EndpointId,
    name: String,
    shared: Arc<Shared>,
    /// The library's own runtime; shut down without waiting when dropped.
    runtime: Option<tokio::runtime::Runtime>,
}

impl Drop for MobileDevice {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

impl MobileDevice {
    /// The paired computers.
    ///
    /// # Errors
    /// The store failed.
    pub fn hosts(&self) -> Result<Vec<PairedHost>, MobileError> {
        self.shared.hosts()
    }

    /// Our relay, when this build has one.
    pub(crate) fn relay_runtime(&self) -> Option<&Arc<RelayRuntime>> {
        self.shared.relay.as_ref()
    }

    /// Run `work` on the library's own runtime.
    pub(crate) async fn on_runtime<T: Send + 'static>(
        &self,
        work: impl std::future::Future<Output = T> + Send + 'static,
    ) -> Result<T, MobileError> {
        self.shared.on_runtime(work).await
    }

    /// Put the relay as it stands to use (see [`Shared::apply_relay`]).
    pub(crate) async fn apply_relay(&self, now: bool) -> Result<bool, MobileError> {
        self.shared.apply_relay(now).await
    }

    /// The shared state, for tests.
    #[cfg(test)]
    pub(crate) fn shared_for_tests(&self) -> &Arc<Shared> {
        &self.shared
    }

    /// This phone as the relay account knows it.
    pub(crate) fn this_device(&self) -> ThisDevice {
        self.shared.this.clone()
    }

    /// [`MobileDevice::start`] on `bind` (loopback in tests).
    ///
    /// # Errors
    /// The store failed, or the endpoint couldn't be bound.
    pub fn start_on(
        store: Arc<dyn PhoneStore>,
        listener: Arc<dyn HostListener>,
        device_name: String,
        bind: SocketAddr,
    ) -> Result<Arc<Self>, MobileError> {
        Self::start_with(
            store,
            listener,
            device_name,
            bind,
            option_env!("KRIYON_PUSH_URL").map(str::to_string),
            option_env!("KRIYON_RELAY_API"),
        )
    }

    /// [`MobileDevice::start_on`] with the push sender at `push_url` (none:
    /// no push) and our relay's API at `relay_api` (none: no relay, hidden).
    ///
    /// # Errors
    /// The store failed, or the endpoint couldn't be bound.
    pub fn start_with(
        store: Arc<dyn PhoneStore>,
        listener: Arc<dyn HostListener>,
        device_name: String,
        bind: SocketAddr,
        push_url: Option<String>,
        relay_api: Option<&str>,
    ) -> Result<Arc<Self>, MobileError> {
        let secret = load_or_create(
            &StoreVault(store.as_ref()),
            kriyon_remote_link::endpoint::generate_secret_key,
        )
        .map_err(|e| MobileError::Store {
            reason: e.to_string(),
        })?;
        let me = kriyon_remote_link::endpoint::public_id(&secret);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| MobileError::Link {
                reason: e.to_string(),
            })?;
        let device = Arc::new(DeviceRuntime::default());
        let relay = RelaySetup::mobile(relay_api).map(|setup| {
            Arc::new(RelayRuntime::new(
                Some(setup),
                Box::new(crate::relay::StoreSecret(Arc::clone(&store))),
            ))
        });
        let this = ThisDevice {
            key_hex: hex(&me),
            name: device_name.clone(),
            platform: platform(),
        };
        // The phone only dials out, through our relay with its pass when the
        // person turned it on. A pass that is due is fetched first, as the
        // contract has the phone do at launch.
        let link = runtime.block_on(async {
            if let Some(relay) = &relay {
                relay.renew(now_s(), &this, false).await;
            }
            let wanted = wanted_relay(relay.as_ref()).await;
            let config = LinkConfig {
                bind,
                relay: wanted.as_ref().map(|(access, _)| access.clone()),
                ..LinkConfig::new(secret)
            };
            let endpoint = kriyon_remote_link::endpoint::bind(&config, Vec::new())
                .await
                .map_err(|e| MobileError::Link {
                    reason: e.to_string(),
                })?;
            device.attach(endpoint.clone()).await;
            Ok::<_, MobileError>((endpoint, wanted))
        })?;
        let link_relay = link.1.is_some();
        let told = Arc::new(Told {
            me,
            listener,
            shared: std::sync::OnceLock::new(),
            last: std::sync::Mutex::new(std::collections::HashMap::new()),
        });
        // As the person left them; a store that can't say leaves them on.
        let alerts_off = matches!(store.read(ALERTS_OFF_KEY.into()), Ok(Some(_)));
        let shared = Arc::new(Shared {
            handle: runtime.handle().clone(),
            device,
            store,
            events: Arc::clone(&told) as Arc<dyn DeviceEvents>,
            hosts_lock: std::sync::Mutex::new(()),
            push_url,
            push: std::sync::Mutex::new(None),
            alerts_off: std::sync::atomic::AtomicBool::new(alerts_off),
            relay,
            link: tokio::sync::Mutex::new(link),
            secret,
            bind,
            this,
            keeper: PassKeeper::default(),
        });
        // The pass is checked every minute while the app runs, as on the
        // desktop. Other tasks hold the device too, so the loop really ends
        // when the device's runtime shuts down (its drop); the weak handle
        // only keeps this loop from holding it as well.
        if shared.relay.is_some() {
            let weak = Arc::downgrade(&shared);
            runtime.spawn(async move {
                loop {
                    tokio::time::sleep(CHECK_EVERY).await;
                    let Some(shared) = weak.upgrade() else {
                        return;
                    };
                    shared.check_relay().await;
                }
            });
        }
        // The pass bound at start is watched like any later one.
        if link_relay {
            let endpoint = runtime.block_on(async { shared.link.lock().await.0.clone() });
            Arc::clone(&shared).watch_relay(endpoint);
        }
        let _ = told.shared.set(Arc::downgrade(&shared));
        let hosts = shared.hosts()?;
        // Every paired computer, connected in the background.
        for host in hosts {
            let shared = Arc::clone(&shared);
            runtime.spawn(async move {
                let _ = shared.connect(&host).await;
            });
        }
        Ok(Arc::new(Self {
            me,
            name: device_name,
            shared,
            runtime: Some(runtime),
        }))
    }
}

#[uniffi::export]
impl MobileDevice {
    /// Start the device side: the device key from `store` (made on first
    /// start), an endpoint, and a link to every paired computer.
    /// `device_name` is what computers show for this phone.
    ///
    /// # Errors
    /// The store failed, or the endpoint couldn't be bound.
    #[uniffi::constructor]
    pub fn start(
        store: Arc<dyn PhoneStore>,
        listener: Arc<dyn HostListener>,
        device_name: String,
    ) -> Result<Arc<Self>, MobileError> {
        Self::start_on(
            store,
            listener,
            device_name,
            SocketAddr::from(([0, 0, 0, 0], 0)),
        )
    }

    /// This phone's id (its endpoint id), hex.
    #[must_use]
    pub fn id(&self) -> String {
        hex(&self.me)
    }

    /// The paired computers, as JSON (`PairedHost`s).
    ///
    /// # Errors
    /// The store failed.
    #[uniffi::method(name = "hosts")]
    pub fn hosts_json(&self) -> Result<String, MobileError> {
        self.hosts().map(|hosts| json(&hosts))
    }

    /// Start pairing with the computer whose pairing code (the QR code's
    /// text) is `invite_text`.
    ///
    /// # Errors
    /// Text that isn't a pairing code, or a computer that can't be reached
    /// or refused the proof.
    pub async fn pair(&self, invite_text: String) -> Result<Arc<Pairing>, MobileError> {
        PairingInvite::from_qr_text(invite_text.trim()).map_err(|_| MobileError::Invalid {
            reason: "that isn't a Kriyon pairing code".into(),
        })?;
        let device = Arc::clone(&self.shared.device);
        let name = self.name.clone();
        let start = self
            .shared
            .on_runtime(async move { device.start_pairing(&invite_text, &name).await })
            .await?
            .map_err(|reason| MobileError::Link { reason })?;
        let left = i64::try_from(start.finish.time_left().as_millis()).unwrap_or(i64::MAX);
        Ok(Arc::new(Pairing {
            code: start.code,
            role: start.finish.role(),
            expires_at_ms: now_ms().saturating_add(left),
            invite: start.invite,
            finish: tokio::sync::Mutex::new(Some(start.finish)),
            shared: Arc::clone(&self.shared),
            cancelled: std::sync::atomic::AtomicBool::new(false),
        }))
    }

    /// Forget a paired computer: its link ends and it is removed from the
    /// store. It stays paired on the computer until removed there.
    ///
    /// # Errors
    /// An id that isn't one, or the store failed.
    pub async fn forget(&self, host_id: String) -> Result<(), MobileError> {
        let id = parse_host_id(&host_id)?;
        // The store first: if it fails, the link stays, matching the list.
        self.shared
            .update_hosts(|hosts| without_host(hosts, &host_id))?;
        let device = Arc::clone(&self.shared.device);
        self.shared
            .on_runtime(async move { device.disconnect(&id).await })
            .await
    }

    /// This phone's push token (`apns` or `fcm`), from the phone's push
    /// service. Each paired computer gets it sealed for itself to the push
    /// sender's key, now and on every link, in the background. Returns
    /// whether push is on: a build without a push sender keeps nothing.
    ///
    /// # Errors
    /// A platform that isn't one.
    pub async fn set_push_token(
        &self,
        token: String,
        platform: String,
    ) -> Result<bool, MobileError> {
        let platform =
            crate::push::platform(&platform).map_err(|reason| MobileError::Invalid { reason })?;
        if self.shared.push_url.is_none() {
            return Ok(false);
        }
        // Kept first: a computer that connects later, or the next link of
        // one the sender couldn't be reached for, is given it then.
        *locked(&self.shared.push) = Some(PushToken { token, platform });
        let device = Arc::clone(&self.shared.device);
        let hosts = self
            .shared
            .on_runtime(async move { device.connected_hosts().await })
            .await?;
        for host in hosts {
            self.shared.give_push(host);
        }
        Ok(true)
    }

    /// Whether this phone's alerts are on, as the person left them.
    #[must_use]
    pub fn alerts_on(&self) -> bool {
        !self
            .shared
            .alerts_off
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Turn this phone's alerts on or off, kept in the phone's store for the
    /// next start. Off: each connected computer forgets its sealed push
    /// token, and none is given it again until they are on, when each
    /// connected computer is given it again.
    ///
    /// # Errors
    /// The store couldn't keep it, or the library's runtime is gone.
    pub async fn set_alerts(&self, on: bool) -> Result<(), MobileError> {
        let kept = if on {
            self.shared.store.remove(ALERTS_OFF_KEY.into())
        } else {
            self.shared.store.write(ALERTS_OFF_KEY.into(), vec![1])
        };
        kept.map_err(|e| store_error(&e))?;
        self.shared
            .alerts_off
            .store(!on, std::sync::atomic::Ordering::SeqCst);
        let device = Arc::clone(&self.shared.device);
        let hosts = self
            .shared
            .on_runtime(async move { device.connected_hosts().await })
            .await?;
        for host in hosts {
            if on {
                self.shared.give_push(host);
            } else {
                let device = Arc::clone(&self.shared.device);
                // One computer that can't hear it now forgets the token when
                // the phone is removed there; the next token replaces it.
                self.shared.handle.spawn(async move {
                    let _ = device.forget_push_token(&host).await;
                });
            }
        }
        Ok(())
    }

    /// Give back typing control of a session: the computer holds it again.
    ///
    /// # Errors
    /// An id that isn't one, not connected, or the link failed.
    pub async fn give_back(&self, host_id: String, session_id: String) -> Result<(), MobileError> {
        let host = parse_host_id(&host_id)?;
        let device = Arc::clone(&self.shared.device);
        Ok(self
            .shared
            .on_runtime(async move { device.give_back(&host, &session_id).await })
            .await??)
    }

    /// The app came to the front, or the network changed: dial now.
    pub fn wake(&self) {
        self.shared.device.wake();
        // A due pass is fetched, and used when it is time.
        if self.shared.relay.is_some() {
            let shared = Arc::clone(&self.shared);
            self.shared.handle.spawn(shared.check_relay());
        }
    }

    /// Show a session as the person wants it: `open`, its screen as
    /// `screen` says (`"off"`; `"fresh"`: to `listener`, from a fresh
    /// snapshot, for a terminal shown or a page loaded again; `"kept"`: as it
    /// is, when the view changes something else) and its [Readable view]
    /// entries going to `entries` (or not read); or closed. The app numbers
    /// views in the order it asks (`seq`): one older than the last taken (a
    /// call that arrived late) changes nothing. The view is kept and shown
    /// again on every link; a link that is down never fails it.
    ///
    /// An entries summary with `unavailable` words means show the terminal;
    /// ask for the entries again when the person opens the readable view.
    ///
    /// # Errors
    /// An id or screen word that isn't one, or a computer not paired here.
    #[allow(clippy::too_many_arguments)] // UniFFI takes them one by one.
    pub async fn set_view(
        &self,
        host_id: String,
        session_id: String,
        seq: u64,
        open: bool,
        screen: String,
        listener: Option<Arc<dyn ScreenListener>>,
        entries: Option<Arc<dyn EntriesListener>>,
    ) -> Result<(), MobileError> {
        let host = parse_host_id(&host_id)?;
        let screen = match (screen.as_str(), listener) {
            ("off", _) => ScreenView::Off,
            ("kept", _) => ScreenView::Kept,
            ("fresh", Some(listener)) => ScreenView::Fresh(screen_sink(listener)),
            _ => {
                return Err(MobileError::Invalid {
                    reason: format!("not a screen: {screen}"),
                })
            }
        };
        let view = if open {
            SessionView::Open {
                screen,
                entries: entries.map(|listener| -> EntriesSink {
                    Arc::new(move |event| {
                        listener.entries_changed(json(
                            &kriyon_remote::device_view::readable_summary(&event),
                        ));
                    })
                }),
            }
        } else {
            SessionView::Closed
        };
        let device = Arc::clone(&self.shared.device);
        self.shared
            .on_runtime(async move { device.set_view(&host, &session_id, seq, view).await })
            .await??;
        Ok(())
    }

    /// Ask for typing control of a session.
    ///
    /// # Errors
    /// An id that isn't one, not connected, or the link failed.
    pub async fn take_control(
        &self,
        host_id: String,
        session_id: String,
    ) -> Result<(), MobileError> {
        let host = parse_host_id(&host_id)?;
        let device = Arc::clone(&self.shared.device);
        Ok(self
            .shared
            .on_runtime(async move { device.take_control(&host, &session_id).await })
            .await??)
    }

    /// Start a session on a paired computer in its project `project_id`,
    /// titled `title` or after the project: the new session's id, once the
    /// computer answers (it is asked again across reconnects, as one start).
    /// Show it with [`Self::set_view`].
    ///
    /// # Errors
    /// An id that isn't one, a computer not paired here, or its refusal
    /// ([`MobileError::Refused`], with words to show).
    pub async fn start_session(
        &self,
        host_id: String,
        project_id: String,
        title: Option<String>,
    ) -> Result<String, MobileError> {
        let host = parse_host_id(&host_id)?;
        let title = title.filter(|title| !title.trim().is_empty());
        if let Some(words) =
            kriyon_remote::authorize::start_request_words(&project_id, title.as_deref())
        {
            return Err(MobileError::Invalid {
                reason: words.to_string(),
            });
        }
        let device = Arc::clone(&self.shared.device);
        Ok(self
            .shared
            .on_runtime(async move { device.start_session(&host, &project_id, title).await })
            .await??)
    }

    /// Type `bytes` into a session this phone has control of.
    ///
    /// # Errors
    /// An id that isn't one, not connected, not open, no control, or no
    /// screen yet.
    pub async fn input(
        &self,
        host_id: String,
        session_id: String,
        bytes: Vec<u8>,
    ) -> Result<(), MobileError> {
        let host = parse_host_id(&host_id)?;
        let device = Arc::clone(&self.shared.device);
        Ok(self
            .shared
            .on_runtime(async move { device.input(&host, &session_id, bytes).await })
            .await??)
    }

    /// Send `text` to Claude in a session this phone has control of, as the
    /// desktop's composer sends a prompt: the computer types it, then Enter.
    /// Works from the readable view, the screen off. Refused while a
    /// question shows (answered in the terminal).
    ///
    /// Returns once the computer says it reached the terminal.
    ///
    /// # Errors
    /// An id that isn't one, not connected, not open, no control, the
    /// computer hasn't named the session's run yet, or it refused (in words
    /// a person reads) or didn't answer.
    pub async fn compose(
        &self,
        host_id: String,
        session_id: String,
        text: String,
    ) -> Result<(), MobileError> {
        let host = parse_host_id(&host_id)?;
        let device = Arc::clone(&self.shared.device);
        Ok(self
            .shared
            .on_runtime(async move { device.compose(&host, &session_id, text).await })
            .await??)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;

    use kriyon_remote::link_policy::CodeCheck;
    use kriyon_remote_link::host::{Accepted, Host, PairedDevices};
    use kriyon_remote_link::LinkConfig;

    use super::*;

    const WAIT: Duration = Duration::from_secs(10);
    const SECRET: [u8; 32] = [7; 32];

    /// The phone's secure store, in memory.
    #[derive(Default)]
    pub(crate) struct Memory(Mutex<HashMap<String, Vec<u8>>>);

    impl PhoneStore for Memory {
        fn read(&self, key: String) -> Result<Option<Vec<u8>>, StoreError> {
            Ok(self.0.lock().expect("store").get(&key).cloned())
        }
        fn write(&self, key: String, value: Vec<u8>) -> Result<(), StoreError> {
            self.0.lock().expect("store").insert(key, value);
            Ok(())
        }
        fn remove(&self, key: String) -> Result<(), StoreError> {
            self.0.lock().expect("store").remove(&key);
            Ok(())
        }
    }

    /// A store that can't be read: locked.
    struct Locked;

    impl PhoneStore for Locked {
        fn read(&self, _key: String) -> Result<Option<Vec<u8>>, StoreError> {
            Err(StoreError::Failed {
                reason: "locked".into(),
            })
        }
        fn write(&self, _key: String, _value: Vec<u8>) -> Result<(), StoreError> {
            panic!("never written while unreadable")
        }
        fn remove(&self, _key: String) -> Result<(), StoreError> {
            panic!("never removed while unreadable")
        }
    }

    #[derive(Default)]
    pub(crate) struct Seen(Mutex<Vec<String>>);

    impl HostListener for Seen {
        fn host_changed(&self, summary: String) {
            self.0.lock().expect("seen").push(summary);
        }
    }

    #[derive(Default)]
    struct Roles(Mutex<HashMap<EndpointId, Role>>);

    impl PairedDevices for Roles {
        fn role(&self, device: &EndpointId) -> Option<Role> {
            self.0.lock().expect("roles").get(device).copied()
        }
    }

    pub(crate) fn loopback() -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], 0))
    }

    pub(crate) fn run<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }

    fn phone(store: &Arc<Memory>) -> Arc<MobileDevice> {
        MobileDevice::start_on(
            Arc::clone(store) as Arc<dyn PhoneStore>,
            Arc::new(Seen::default()),
            "Test phone".into(),
            loopback(),
        )
        .expect("starts")
    }

    #[test]
    fn alerts_turned_off_stay_off_after_a_restart() {
        let store = Arc::new(Memory::default());
        let first = phone(&store);
        assert!(first.alerts_on(), "on by default");
        run(async move { first.set_alerts(false).await }).expect("off");
        let again = phone(&store);
        assert!(!again.alerts_on(), "off, as left");
        run(async move { again.set_alerts(true).await }).expect("on");
        assert!(phone(&store).alerts_on(), "on again");
    }

    #[test]
    fn the_device_key_is_made_once_and_kept() {
        let store = Arc::new(Memory::default());
        let first = phone(&store).id();
        assert_eq!(first.len(), 64);
        assert!(store.read(DEVICE_KEY.into()).expect("read").is_some());
        assert_eq!(phone(&store).id(), first, "the same key next start");
    }

    #[test]
    fn a_locked_store_is_an_error_not_a_new_key() {
        let started = MobileDevice::start_on(
            Arc::new(Locked),
            Arc::new(Seen::default()),
            "Test phone".into(),
            loopback(),
        );
        assert!(matches!(started, Err(MobileError::Store { .. })));
    }

    struct Entries;
    impl EntriesListener for Entries {
        fn entries_changed(&self, _summary: String) {}
    }

    #[test]
    fn a_view_is_taken_only_for_a_computer_paired_here() {
        let store = Arc::new(Memory::default());
        let device = phone(&store);
        let reader = Arc::clone(&device);
        let refused = run(async move {
            reader
                .set_view(
                    "ab".repeat(32),
                    "s".into(),
                    1,
                    true,
                    "kept".into(),
                    None,
                    Some(Arc::new(Entries)),
                )
                .await
        });
        assert!(refused.is_err(), "{refused:?}");
        let odd = Arc::clone(&device);
        let unknown = run(async move {
            odd.set_view(
                "ab".repeat(32),
                "s".into(),
                2,
                true,
                "dim".into(),
                None,
                None,
            )
            .await
        });
        assert!(
            matches!(unknown, Err(MobileError::Invalid { .. })),
            "{unknown:?}"
        );
        let bad = run(async move {
            device
                .set_view(
                    "not an id".into(),
                    "s".into(),
                    3,
                    false,
                    "off".into(),
                    None,
                    None,
                )
                .await
        });
        assert!(matches!(bad, Err(MobileError::Invalid { .. })), "{bad:?}");
    }

    #[test]
    fn text_that_isnt_a_pairing_code_is_refused() {
        let store = Arc::new(Memory::default());
        let device = phone(&store);
        let refused = run(async move { device.pair("hello".into()).await });
        assert!(matches!(refused, Err(MobileError::Invalid { .. })));
    }

    #[test]
    fn a_phone_pairs_keeps_the_computer_and_can_forget_it() {
        let store = Arc::new(Memory::default());
        let device = phone(&store);
        let roles = Arc::new(Roles::default());
        let paired = run({
            let device = Arc::clone(&device);
            let roles = Arc::clone(&roles);
            async move {
                let host = Arc::new(
                    Host::bind(
                        &LinkConfig {
                            bind: loopback(),
                            ..LinkConfig::new([1; 32])
                        },
                        Arc::clone(&roles) as Arc<dyn PairedDevices>,
                        10,
                    )
                    .await
                    .expect("host binds"),
                );
                host.start_pairing(SECRET, Role::Controller);
                let invite = kriyon_remote_link::invite::invite(&host, SECRET).to_qr_text();
                let host_side = {
                    let host = Arc::clone(&host);
                    tokio::spawn(async move {
                        let Accepted::Pair(link) = tokio::time::timeout(WAIT, host.accept())
                            .await
                            .expect("in time")
                            .expect("open")
                        else {
                            panic!("a pairing connection");
                        };
                        link.request().await.expect("the right proof")
                    })
                };
                let pairing = device.pair(invite).await.expect("pairs");
                let mut attempt = host_side.await.expect("host task");
                assert_eq!(attempt.name(), "Test phone");
                let code = pairing.code();
                // What the code step shows: the code, the role offered and
                // until when the computer waits for it.
                let offer: serde_json::Value =
                    serde_json::from_str(&pairing.offer()).expect("json");
                assert_eq!(offer["code"], code.as_str());
                assert_eq!(offer["role"], "controller");
                let left = offer["expiresAtMs"].as_i64().expect("a time") - now_ms();
                assert!((4 * 60_000..=5 * 60_000).contains(&left), "{left}");
                let (check, finished) = tokio::join!(
                    attempt.confirm(&code, "Test Mac", |id, role| {
                        roles.0.lock().expect("roles").insert(id, role);
                        true
                    }),
                    pairing.finish()
                );
                assert!(matches!(check, Ok(CodeCheck::Paired { .. })));
                let paired = finished.expect("paired");
                (paired, host.id())
            }
        });
        let (paired, host_id) = paired;
        assert_eq!(paired.name, "Test Mac");
        assert_eq!(paired.host_id, kriyon_remote::message::hex(&host_id));
        assert_eq!(device.hosts().expect("hosts"), vec![paired.clone()]);
        run({
            let device = Arc::clone(&device);
            async move { device.forget(paired.host_id).await.expect("forgot") }
        });
        assert_eq!(device.hosts().expect("hosts"), Vec::<PairedHost>::new());
        assert!(run({
            let device = Arc::clone(&device);
            async move { device.forget("not-an-id".into()).await }
        })
        .is_err());
    }

    #[test]
    fn a_cancelled_pairing_keeps_no_computer() {
        let store = Arc::new(Memory::default());
        let device = phone(&store);
        let roles = Arc::new(Roles::default());
        let finished = run({
            let device = Arc::clone(&device);
            let roles = Arc::clone(&roles);
            async move {
                let host = Arc::new(
                    Host::bind(
                        &LinkConfig {
                            bind: loopback(),
                            ..LinkConfig::new([1; 32])
                        },
                        Arc::clone(&roles) as Arc<dyn PairedDevices>,
                        10,
                    )
                    .await
                    .expect("host binds"),
                );
                host.start_pairing(SECRET, Role::Controller);
                let invite = kriyon_remote_link::invite::invite(&host, SECRET).to_qr_text();
                let host_side = {
                    let host = Arc::clone(&host);
                    tokio::spawn(async move {
                        let Accepted::Pair(link) = tokio::time::timeout(WAIT, host.accept())
                            .await
                            .expect("in time")
                            .expect("open")
                        else {
                            panic!("a pairing connection");
                        };
                        link.request().await.expect("the right proof")
                    })
                };
                let pairing = device.pair(invite).await.expect("pairs");
                let mut attempt = host_side.await.expect("host task");
                let code = pairing.code();
                // The person backs out while the computer is still asking.
                let finish = {
                    let pairing = Arc::clone(&pairing);
                    tokio::spawn(async move { pairing.finish().await })
                };
                pairing.cancel();
                let _ = attempt
                    .confirm(&code, "Test Mac", |id, role| {
                        roles.0.lock().expect("roles").insert(id, role);
                        true
                    })
                    .await;
                finish.await.expect("finish task")
            }
        });
        assert!(
            finished.is_err(),
            "a cancelled pairing ends without a computer"
        );
        assert_eq!(device.hosts().expect("hosts"), Vec::<PairedHost>::new());
    }

    #[test]
    fn a_refused_start_says_why_by_name_and_in_words() {
        use kriyon_remote::message::RefuseReason;
        assert_eq!(
            MobileError::from(StartError::Refused(RefuseReason::FolderNotAllowed)),
            MobileError::Refused {
                reason: "FolderNotAllowed".into(),
                words: "That project's folder isn't one sessions can start in on that computer."
                    .into(),
            }
        );
        assert_eq!(
            MobileError::from(StartError::NotConnected),
            MobileError::NotConnected
        );
        assert!(matches!(
            MobileError::from(StartError::Gone),
            MobileError::Link { .. }
        ));
    }

    #[test]
    fn a_start_on_a_computer_not_paired_here_is_not_connected() {
        let store = Arc::new(Memory::default());
        let device = phone(&store);
        let started = run({
            let device = Arc::clone(&device);
            async move {
                device
                    .start_session("ab".repeat(32), "/work/app".into(), None)
                    .await
            }
        });
        assert_eq!(started, Err(MobileError::NotConnected));
        let bad = run({
            let device = Arc::clone(&device);
            async move {
                device
                    .start_session("nope".into(), "/work/app".into(), None)
                    .await
            }
        });
        assert!(matches!(bad, Err(MobileError::Invalid { .. })));
    }

    #[test]
    fn a_damaged_list_of_computers_is_an_error_and_is_kept() {
        let store = Arc::new(Memory::default());
        store
            .write(crate::hosts::HOSTS_KEY.into(), b"damaged".to_vec())
            .expect("write");
        let started = MobileDevice::start_on(
            Arc::clone(&store) as Arc<dyn PhoneStore>,
            Arc::new(Seen::default()),
            "Test phone".into(),
            loopback(),
        );
        assert!(matches!(started, Err(MobileError::Store { .. })));
        assert_eq!(
            store.read(crate::hosts::HOSTS_KEY.into()).expect("read"),
            Some(b"damaged".to_vec())
        );
    }

    #[test]
    fn changes_to_the_list_of_computers_never_lose_one_another() {
        let store = Arc::new(Memory::default());
        let device = phone(&store);
        let host = |n: u8| PairedHost {
            host_id: kriyon_remote::message::hex(&[n; 32]),
            name: format!("Mac {n}"),
            addrs: vec![],
            relay_url: None,
            paired_at_ms: 0,
        };
        std::thread::scope(|scope| {
            for n in 1..=8 {
                let shared = Arc::clone(&device.shared);
                scope.spawn(move || {
                    shared
                        .update_hosts(|hosts| crate::hosts::with_host(hosts, host(n)))
                        .expect("kept");
                });
            }
        });
        assert_eq!(device.hosts().expect("hosts").len(), 8);
    }

    /// Pair `device` with a new host on loopback; the host and its id.
    async fn paired_host(device: &Arc<MobileDevice>, roles: &Arc<Roles>) -> Arc<Host> {
        let host = Arc::new(
            Host::bind(
                &LinkConfig {
                    bind: loopback(),
                    ..LinkConfig::new([1; 32])
                },
                Arc::clone(roles) as Arc<dyn PairedDevices>,
                10,
            )
            .await
            .expect("host binds"),
        );
        host.start_pairing(SECRET, Role::Controller);
        let invite = kriyon_remote_link::invite::invite(&host, SECRET).to_qr_text();
        let host_side = {
            let host = Arc::clone(&host);
            tokio::spawn(async move {
                let Accepted::Pair(link) = tokio::time::timeout(WAIT, host.accept())
                    .await
                    .expect("in time")
                    .expect("open")
                else {
                    panic!("a pairing connection");
                };
                link.request().await.expect("the right proof")
            })
        };
        let pairing = device.pair(invite).await.expect("pairs");
        let mut attempt = host_side.await.expect("host task");
        let code = pairing.code();
        let (check, finished) = tokio::join!(
            attempt.confirm(&code, "Test Mac", |id, role| {
                roles.0.lock().expect("roles").insert(id, role);
                true
            }),
            pairing.finish()
        );
        assert!(matches!(check, Ok(CodeCheck::Paired { .. })));
        finished.expect("paired");
        host
    }

    #[test]
    fn the_push_token_reaches_each_computer_on_every_link_sealed_to_the_newest_key() {
        use kriyon_remote::codec::Decoded;
        use kriyon_remote::message::{FromDevice, ToDevice};
        use kriyon_remote::push::{open_push_token, push_public_key, Platform};

        let key = |id: u32, secret: u8| {
            (
                200,
                format!(
                    r#"{{"key_id":{id},"public_key":"{}"}}"#,
                    kriyon_remote::message::hex(&push_public_key(&[secret; 32]))
                ),
            )
        };
        // Down for the first link, then key 3, then key 4 (rotated).
        let sender =
            crate::push::tests::fake_sender_replies(vec![(503, "{}".into()), key(3, 9), key(4, 8)]);
        let store = Arc::new(Memory::default());
        let device = MobileDevice::start_with(
            Arc::clone(&store) as Arc<dyn PhoneStore>,
            Arc::new(Seen::default()),
            "Test phone".into(),
            loopback(),
            Some(sender),
            None,
        )
        .expect("starts");
        let roles = Arc::new(Roles::default());
        let (host_id, tokens) = run({
            let device = Arc::clone(&device);
            async move {
                // Given while no computer is connected: kept for later.
                assert_eq!(
                    device
                        .set_push_token("apns-token".into(), "apns".into())
                        .await,
                    Ok(true)
                );
                let host = paired_host(&device, &roles).await;
                let mut tokens = Vec::new();
                // Three links in turn, each dropped by the computer.
                for link_number in 0..3 {
                    let Accepted::Remote(link) = tokio::time::timeout(WAIT, host.accept())
                        .await
                        .expect("in time")
                        .expect("open")
                    else {
                        panic!("the paired phone");
                    };
                    let (mut out, mut control) = link.accept_stream().await.expect("control");
                    let _hello = control.next().await;
                    out.send(&ToDevice::Welcome {
                        host_name: "Test Mac".into(),
                        protocol_minor: 0,
                        role: Role::Controller,
                        sessions: vec![],
                    })
                    .await
                    .expect("welcome");
                    // The sender was down for the first link: nothing yet.
                    let wait = if link_number == 0 {
                        std::time::Duration::from_secs(2)
                    } else {
                        WAIT
                    };
                    let token = tokio::time::timeout(wait, async {
                        loop {
                            match control.next().await {
                                Ok(Some(Decoded::Message(FromDevice::PushToken {
                                    key_id,
                                    sealed,
                                }))) => return (key_id, sealed),
                                Ok(Some(_)) => {}
                                other => panic!("the link ended: {other:?}"),
                            }
                        }
                    })
                    .await;
                    match (link_number, token) {
                        (0, Err(_)) => {}
                        (0, Ok(_)) => panic!("no key while the sender was down"),
                        (_, token) => tokens.push(token.expect("a push token in time")),
                    }
                    link.close(kriyon_remote::link_policy::CloseCode::HostClosing);
                }
                (host.id(), tokens)
            }
        });
        let [(first_key, first), (second_key, second)] = tokens.as_slice() else {
            panic!("two tokens");
        };
        assert_eq!(
            (*first_key, *second_key),
            (3, 4),
            "the newest key each link"
        );
        for (secret, sealed) in [(9, first), (8, second)] {
            let plain = open_push_token(&[secret; 32], sealed).expect("the sender opens it");
            assert_eq!(plain.token, "apns-token");
            assert_eq!(plain.platform, Platform::Apns);
            assert_eq!(plain.host_id, host_id, "sealed for this computer only");
        }
    }

    #[test]
    fn alerts_off_has_each_computer_forget_the_token_and_on_gives_it_again() {
        use kriyon_remote::codec::Decoded;
        use kriyon_remote::message::{FromDevice, ToDevice};
        use kriyon_remote::push::push_public_key;
        use kriyon_remote_link::framed::MessageReader;

        /// The phone's next word on its push token.
        async fn next_push(control: &mut MessageReader<FromDevice>) -> FromDevice {
            loop {
                match tokio::time::timeout(WAIT, control.next())
                    .await
                    .expect("in time")
                {
                    Ok(Some(Decoded::Message(
                        message @ (FromDevice::PushToken { .. } | FromDevice::ForgetPushToken),
                    ))) => return message,
                    Ok(Some(_)) => {}
                    other => panic!("the link ended: {other:?}"),
                }
            }
        }

        let key = (
            200,
            format!(
                r#"{{"key_id":3,"public_key":"{}"}}"#,
                kriyon_remote::message::hex(&push_public_key(&[9; 32]))
            ),
        );
        let sender = crate::push::tests::fake_sender_replies(vec![key.clone(), key]);
        let store = Arc::new(Memory::default());
        let device = MobileDevice::start_with(
            Arc::clone(&store) as Arc<dyn PhoneStore>,
            Arc::new(Seen::default()),
            "Test phone".into(),
            loopback(),
            Some(sender),
            None,
        )
        .expect("starts");
        let roles = Arc::new(Roles::default());
        let heard = run({
            let device = Arc::clone(&device);
            async move {
                device
                    .set_push_token("apns-token".into(), "apns".into())
                    .await
                    .expect("kept");
                let host = paired_host(&device, &roles).await;
                let Accepted::Remote(link) = tokio::time::timeout(WAIT, host.accept())
                    .await
                    .expect("in time")
                    .expect("open")
                else {
                    panic!("the paired phone");
                };
                let (mut out, mut control) = link.accept_stream().await.expect("control");
                let _hello = control.next().await;
                out.send(&ToDevice::Welcome {
                    host_name: "Test Mac".into(),
                    protocol_minor: 0,
                    role: Role::Controller,
                    sessions: vec![],
                })
                .await
                .expect("welcome");
                let mut heard = Vec::new();
                heard.push(next_push(&mut control).await);
                device.set_alerts(false).await.expect("off");
                heard.push(next_push(&mut control).await);
                device.set_alerts(true).await.expect("on");
                heard.push(next_push(&mut control).await);
                heard
            }
        });
        let kinds: Vec<&str> = heard
            .iter()
            .map(|message| match message {
                FromDevice::PushToken { .. } => "token",
                FromDevice::ForgetPushToken => "forget",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, ["token", "forget", "token"]);
    }

    #[test]
    fn without_a_push_sender_a_token_is_kept_and_nothing_is_sent() {
        let store = Arc::new(Memory::default());
        let device = MobileDevice::start_with(
            Arc::clone(&store) as Arc<dyn PhoneStore>,
            Arc::new(Seen::default()),
            "Test phone".into(),
            loopback(),
            None,
            None,
        )
        .expect("starts");
        run({
            let device = Arc::clone(&device);
            async move {
                assert_eq!(
                    device.set_push_token("t".into(), "apns".into()).await,
                    Ok(false)
                );
                assert!(matches!(
                    device.set_push_token("t".into(), "ios".into()).await,
                    Err(MobileError::Invalid { .. })
                ));
            }
        });
    }

    #[test]
    fn a_computers_news_reaches_the_app_as_its_summary_in_json() {
        let seen = Arc::new(Seen::default());
        let told = Told {
            me: [2; 32],
            listener: Arc::clone(&seen) as Arc<dyn HostListener>,
            shared: std::sync::OnceLock::new(),
            last: std::sync::Mutex::new(std::collections::HashMap::new()),
        };
        let view = HostView {
            host_name: Some("Mac".into()),
            ..HostView::default()
        };
        told.host_changed([0xab; 32], &LinkFacts::new(LinkState::Connected), &view);
        let summary: serde_json::Value =
            serde_json::from_str(&seen.0.lock().expect("seen")[0]).expect("json");
        assert_eq!(summary["hostId"], "ab".repeat(32));
        assert_eq!(summary["hostName"], "Mac");
        assert_eq!(summary["link"], "connected");
        assert_eq!(summary["mayStart"], false);
    }
}
