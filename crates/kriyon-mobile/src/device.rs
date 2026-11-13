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

/// The device runtime's news, as the phone's records.
struct Told {
    me: EndpointId,
    listener: Arc<dyn HostListener>,
}

impl DeviceEvents for Told {
    fn host_changed(&self, host: EndpointId, state: LinkState, view: &HostView) {
        self.listener
            .host_changed(host_state(&host, &self.me, state, view));
    }
}

/// What the device and its pairings share.
struct Shared {
    handle: tokio::runtime::Handle,
    device: Arc<DeviceRuntime>,
    store: Arc<dyn PhoneStore>,
    events: Arc<dyn DeviceEvents>,
    /// Held across each change to the kept list, so two never lose one.
    hosts_lock: std::sync::Mutex<()>,
}

impl Shared {
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
}

#[uniffi::export]
impl Pairing {
    /// The six-digit code to type into the computer.
    #[must_use]
    pub fn code(&self) -> String {
        self.code.clone()
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
        let shared = Arc::new(Shared {
            handle: runtime.handle().clone(),
            device,
            store,
            events: Arc::new(Told { me, listener }),
            hosts_lock: std::sync::Mutex::new(()),
        });
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
}
