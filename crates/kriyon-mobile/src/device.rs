//! The phone as a [Remote device]: one object the app holds, over the
//! shared device runtime. It keeps the device key and the paired computers
//! in the store the app provides (the phone's secure store), pairs from a
//! pairing code's text, keeps each paired computer connected, and passes a
//! session's screen to the app as frames.

use std::net::SocketAddr;
use std::sync::Arc;

use kriyon_remote::device_view::HostView;
use kriyon_remote::message::{hex, parse_id_hex, EndpointId};
use kriyon_remote::pairing::PairingInvite;
use kriyon_remote_link::device::DevicePairing;
use kriyon_remote_link::device_runtime::{
    screen_frame, DeviceError, DeviceEvents, DeviceRuntime, HostEntry, LinkState, ScreenSink,
};
use kriyon_remote_link::keys::{load_or_create, KeyVault};
use kriyon_remote_link::LinkConfig;

use crate::hosts::{hosts_bytes, read_hosts, with_host, without_host, PairedHost, HOSTS_KEY};
use crate::view::{host_state, HostState};

/// The store key of the device key.
pub const DEVICE_KEY: &str = "device-key";

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

/// Told whenever a paired computer's link or sessions change.
#[uniffi::export(with_foreign)]
pub trait HostListener: Send + Sync {
    fn host_changed(&self, state: HostState);
}

/// Where one open session's screen goes: frames as the desktop's terminal
/// view reads them (`kriyon_remote_link::device_runtime::screen_frame`).
#[uniffi::export(with_foreign)]
pub trait ScreenListener: Send + Sync {
    fn frame(&self, frame: Vec<u8>);
}

/// Why a phone action couldn't happen, in words the app can show.
#[derive(Debug, PartialEq, Eq, uniffi::Error)]
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
}

impl std::fmt::Display for MobileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store { reason } | Self::Invalid { reason } | Self::Link { reason } => {
                f.write_str(reason)
            }
            Self::NotConnected => f.write_str("not connected to that computer"),
            Self::NotOpen => f.write_str("that session isn't open"),
            Self::NoControl => f.write_str("this phone doesn't have control"),
            Self::NoScreen => f.write_str("the screen hasn't arrived yet"),
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

impl KeyVault for StoreVault<'_> {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        self.0.read(DEVICE_KEY.into()).map_err(|e| e.to_string())
    }

    fn write(&self, secret: &[u8; 32]) -> Result<(), String> {
        self.0
            .write(DEVICE_KEY.into(), secret.to_vec())
            .map_err(|e| e.to_string())
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
    fn host_changed(&self, host: EndpointId, state: LinkState, view: &HostView) {
        let came_up = locked(&self.last).insert(host, state) != Some(LinkState::Connected)
            && state == LinkState::Connected;
        if came_up {
            if let Some(shared) = self.shared.get().and_then(std::sync::Weak::upgrade) {
                shared.give_push(host);
            }
        }
        self.listener
            .host_changed(host_state(&host, &self.me, state, view));
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
struct Shared {
    handle: tokio::runtime::Handle,
    device: Arc<DeviceRuntime>,
    store: Arc<dyn PhoneStore>,
    events: Arc<dyn DeviceEvents>,
    /// Held across each change to the kept list, so two never lose one.
    hosts_lock: std::sync::Mutex<()>,
    /// The push sender (`KRIYON_PUSH_URL` at build time); none: no push.
    push_url: Option<String>,
    push: std::sync::Mutex<Option<PushToken>>,
}

fn locked<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now_s() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl Shared {
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
        let (Some(push), Some(url)) = (locked(&self.push).clone(), self.push_url.clone()) else {
            return Ok(());
        };
        let key = crate::push::fetch_sender_key(&url)
            .await
            .map_err(|reason| MobileError::Link { reason })?;
        let (key_id, sealed) =
            crate::push::seal_for(&key, &push.token, push.platform, &host, now_s())
                .map_err(|reason| MobileError::Invalid { reason })?;
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

    /// Stop this pairing: if the computer still accepts the code, the phone
    /// keeps nothing of it.
    pub fn cancel(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

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
        )
    }

    /// [`MobileDevice::start_on`] with the push sender at `push_url` (none:
    /// no push).
    ///
    /// # Errors
    /// The store failed, or the endpoint couldn't be bound.
    pub fn start_with(
        store: Arc<dyn PhoneStore>,
        listener: Arc<dyn HostListener>,
        device_name: String,
        bind: SocketAddr,
        push_url: Option<String>,
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
        // The phone only dials out. Its relay comes with relay support.
        let config = LinkConfig {
            bind,
            ..LinkConfig::new(secret)
        };
        runtime.block_on(async {
            let endpoint = kriyon_remote_link::endpoint::bind(&config, Vec::new())
                .await
                .map_err(|e| MobileError::Link {
                    reason: e.to_string(),
                })?;
            device.attach(endpoint).await;
            Ok::<(), MobileError>(())
        })?;
        let told = Arc::new(Told {
            me,
            listener,
            shared: std::sync::OnceLock::new(),
            last: std::sync::Mutex::new(std::collections::HashMap::new()),
        });
        let shared = Arc::new(Shared {
            handle: runtime.handle().clone(),
            device,
            store,
            events: Arc::clone(&told) as Arc<dyn DeviceEvents>,
            hosts_lock: std::sync::Mutex::new(()),
            push_url,
            push: std::sync::Mutex::new(None),
        });
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

    /// The paired computers.
    ///
    /// # Errors
    /// The store failed.
    pub fn hosts(&self) -> Result<Vec<PairedHost>, MobileError> {
        self.shared.hosts()
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
        Ok(Arc::new(Pairing {
            code: start.code,
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

    /// The app came to the front, or the network changed: dial now.
    pub fn wake(&self) {
        self.shared.device.wake();
    }

    /// Open a session; its screen goes to `listener`, again on every link.
    ///
    /// # Errors
    /// An id that isn't one, or not connected to that computer.
    pub async fn open_session(
        &self,
        host_id: String,
        session_id: String,
        listener: Arc<dyn ScreenListener>,
    ) -> Result<(), MobileError> {
        let host = parse_host_id(&host_id)?;
        let sink: ScreenSink = Arc::new(move |event| {
            // `Resync` is Rust's own; the rest goes to the screen.
            if let Some(frame) = screen_frame(&event) {
                listener.frame(frame);
            }
        });
        let device = Arc::clone(&self.shared.device);
        Ok(self
            .shared
            .on_runtime(async move { device.open_session(&host, &session_id, sink).await })
            .await??)
    }

    /// Close a session opened here.
    ///
    /// # Errors
    /// An id that isn't one.
    pub async fn close_session(
        &self,
        host_id: String,
        session_id: String,
    ) -> Result<(), MobileError> {
        let host = parse_host_id(&host_id)?;
        let device = Arc::clone(&self.shared.device);
        self.shared
            .on_runtime(async move { device.close_session(&host, &session_id).await })
            .await
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
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;

    use kriyon_remote::link_policy::CodeCheck;
    use kriyon_remote::message::Role;
    use kriyon_remote_link::host::{Accepted, Host, PairedDevices};
    use kriyon_remote_link::LinkConfig;

    use super::*;

    const WAIT: Duration = Duration::from_secs(10);
    const SECRET: [u8; 32] = [7; 32];

    /// The phone's secure store, in memory.
    #[derive(Default)]
    struct Memory(Mutex<HashMap<String, Vec<u8>>>);

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
    struct Seen(Mutex<Vec<HostState>>);

    impl HostListener for Seen {
        fn host_changed(&self, state: HostState) {
            self.0.lock().expect("seen").push(state);
        }
    }

    #[derive(Default)]
    struct Roles(Mutex<HashMap<EndpointId, Role>>);

    impl PairedDevices for Roles {
        fn role(&self, device: &EndpointId) -> Option<Role> {
            self.0.lock().expect("roles").get(device).copied()
        }
    }

    fn loopback() -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], 0))
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
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
    fn without_a_push_sender_a_token_is_kept_and_nothing_is_sent() {
        let store = Arc::new(Memory::default());
        let device = MobileDevice::start_with(
            Arc::clone(&store) as Arc<dyn PhoneStore>,
            Arc::new(Seen::default()),
            "Test phone".into(),
            loopback(),
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
}
