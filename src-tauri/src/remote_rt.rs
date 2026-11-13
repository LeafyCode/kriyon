//! [Remote access] on the host: the switch, the host endpoint and its accept
//! loop, and the one pairing in progress. Off means no endpoint at all.
//!
//! Kept free of Tauri types so it is tested end to end with a real device
//! over loopback; `remote_cmd` wires it to the app's store and windows.

use std::net::SocketAddr;
use std::sync::Arc;

use kriyon_remote::link_policy::CodeCheck;
use kriyon_remote::message::{EndpointId, Role};
use kriyon_remote::pairing::PairingInvite;
use kriyon_remote_link::host::{Accepted, Host, PairAttempt, PairedDevices, RemoteLink};
use kriyon_remote_link::LinkConfig;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// Refused handshakes one source may cause a minute before it is ignored.
const UNPAIRED_PER_MINUTE: u32 = 10;

/// What the host needs to come up.
pub struct HostSetup {
    /// The [Device key]'s secret.
    pub secret_key: [u8; 32],
    /// Where to listen.
    pub bind: SocketAddr,
    pub paired: Arc<dyn PairedDevices>,
    /// Called with the device's name when a device has taken the pairing and
    /// the person should type the code it shows.
    pub on_code_wanted: Arc<dyn Fn(String) + Send + Sync>,
    /// Called with a paired device's id when its connection closes: it
    /// gives back typing control (spec section 5).
    pub on_device_gone: Arc<dyn Fn(EndpointId) + Send + Sync>,
}

/// The pairing state the UI shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairingStatus {
    /// No pairing pending.
    Idle,
    /// The QR code is up; no device has taken it yet.
    Waiting { role: Role },
    /// A device took it; the person should type its code.
    CodeWanted { role: Role, device_name: String },
}

/// The host side of [Remote access], one per app.
#[derive(Default)]
pub struct RemoteRuntime {
    running: Mutex<Option<Running>>,
}

struct Running {
    host: Arc<Host>,
    accept: JoinHandle<()>,
    pairing: Arc<Mutex<Pairing>>,
    /// Paired devices' connections, held until they are served (next step).
    links: Arc<Mutex<Vec<Arc<RemoteLink>>>>,
}

#[derive(Default)]
struct Pairing {
    role: Option<Role>,
    attempt: Option<PairAttempt>,
}

/// What typing a code did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodeOutcome {
    /// Paired and stored.
    Paired {
        device: EndpointId,
        name: String,
        role: Role,
    },
    /// Wrong; this many tries left.
    Wrong { tries_left: u32 },
    /// Burned: start again with a new QR code.
    Burned,
    /// No device is waiting for a code.
    NoAttempt,
}

impl RemoteRuntime {
    /// Bring the host endpoint up. Does nothing if it is already up.
    ///
    /// # Errors
    /// Why the endpoint couldn't be bound.
    pub async fn turn_on(&self, setup: HostSetup) -> Result<(), String> {
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Ok(());
        }
        let config = LinkConfig {
            bind: setup.bind,
            ..LinkConfig::new(setup.secret_key)
        };
        let host = Arc::new(
            Host::bind(&config, setup.paired, UNPAIRED_PER_MINUTE)
                .await
                .map_err(|e| e.to_string())?,
        );
        let pairing = Arc::new(Mutex::new(Pairing::default()));
        let links = Arc::new(Mutex::new(Vec::new()));
        let accept = tokio::spawn(accept_loop(
            Arc::clone(&host),
            Arc::clone(&pairing),
            Arc::clone(&links),
            setup.on_code_wanted,
            setup.on_device_gone,
        ));
        *running = Some(Running {
            host,
            accept,
            pairing,
            links,
        });
        Ok(())
    }

    /// Take the host endpoint down: every connection and any pairing go.
    pub async fn turn_off(&self) {
        let Some(running) = self.running.lock().await.take() else {
            return;
        };
        running.accept.abort();
        running.links.lock().await.clear();
        running.pairing.lock().await.attempt = None;
        running.host.close().await;
    }

    pub async fn is_on(&self) -> bool {
        self.running.lock().await.is_some()
    }

    /// Start a pairing for `role` and return what the QR code shows.
    ///
    /// # Errors
    /// When remote access is off.
    pub async fn start_pairing(&self, role: Role) -> Result<PairingInvite, String> {
        let running = self.running.lock().await;
        let running = running.as_ref().ok_or("remote access is off")?;
        // A fresh secret each time, kept in memory only.
        let secret = kriyon_remote_link::endpoint::generate_secret_key();
        running.host.start_pairing(secret, role);
        *running.pairing.lock().await = Pairing {
            role: Some(role),
            attempt: None,
        };
        Ok(kriyon_remote_link::invite::invite(&running.host, secret))
    }

    /// Stop the pairing in progress, if any.
    pub async fn stop_pairing(&self) {
        if let Some(running) = self.running.lock().await.as_ref() {
            running.host.stop_pairing();
            *running.pairing.lock().await = Pairing::default();
        }
    }

    pub async fn pairing_status(&self) -> PairingStatus {
        let running = self.running.lock().await;
        let Some(running) = running.as_ref() else {
            return PairingStatus::Idle;
        };
        let pairing = running.pairing.lock().await;
        match (pairing.role, &pairing.attempt) {
            (None, _) => PairingStatus::Idle,
            (Some(role), None) => PairingStatus::Waiting { role },
            (Some(role), Some(attempt)) => PairingStatus::CodeWanted {
                role,
                device_name: attempt.name().to_string(),
            },
        }
    }

    /// The person typed `code` for the device that took the pairing. On the
    /// right code `store` keeps the device (id, name, role) before the device
    /// is told it is paired; if it can't, the pairing ends as burned.
    ///
    /// # Errors
    /// When the device can't be told.
    pub async fn enter_code(
        &self,
        code: &str,
        host_name: &str,
        store: impl FnOnce(EndpointId, &str, Role) -> bool,
    ) -> Result<CodeOutcome, String> {
        let pairing = {
            let running = self.running.lock().await;
            match running.as_ref() {
                Some(running) => Arc::clone(&running.pairing),
                None => return Ok(CodeOutcome::NoAttempt),
            }
        };
        let mut pairing = pairing.lock().await;
        let Some(attempt) = pairing.attempt.as_mut() else {
            return Ok(CodeOutcome::NoAttempt);
        };
        let name = attempt.name().to_string();
        let check = attempt
            .confirm(code, host_name, |device, role| store(device, &name, role))
            .await
            .map_err(|e| e.to_string())?;
        Ok(match check {
            CodeCheck::Wrong { tries_left } => CodeOutcome::Wrong { tries_left },
            CodeCheck::Paired { device, role } => {
                *pairing = Pairing::default();
                CodeOutcome::Paired { device, name, role }
            }
            CodeCheck::Burned => {
                *pairing = Pairing::default();
                CodeOutcome::Burned
            }
        })
    }

    /// Close every connection of `device` (removed, or made a Viewer).
    pub async fn cut_off(&self, device: &EndpointId) {
        if let Some(running) = self.running.lock().await.as_ref() {
            running.host.cut_off(device);
            running
                .links
                .lock()
                .await
                .retain(|link| link.device() != *device);
        }
    }

    /// Close every connection of `device` so it comes back with its new role.
    pub async fn reconnect(&self, device: &EndpointId) {
        if let Some(running) = self.running.lock().await.as_ref() {
            running.host.reconnect(device);
            running
                .links
                .lock()
                .await
                .retain(|link| link.device() != *device);
        }
    }

    /// The host's endpoint id, while on.
    pub async fn host_id(&self) -> Option<EndpointId> {
        self.running.lock().await.as_ref().map(|r| r.host.id())
    }
}

/// Take what the host admits: pairing devices get their request read and,
/// once one took the pairing, the person is asked for its code; paired
/// devices' connections are held for the session streams.
async fn accept_loop(
    host: Arc<Host>,
    pairing: Arc<Mutex<Pairing>>,
    links: Arc<Mutex<Vec<Arc<RemoteLink>>>>,
    on_code_wanted: Arc<dyn Fn(String) + Send + Sync>,
    on_device_gone: Arc<dyn Fn(EndpointId) + Send + Sync>,
) {
    while let Some(accepted) = host.accept().await {
        match accepted {
            Accepted::Remote(link) => {
                let link = Arc::new(link);
                links.lock().await.push(Arc::clone(&link));
                let links = Arc::clone(&links);
                let on_device_gone = Arc::clone(&on_device_gone);
                tokio::spawn(async move {
                    link.closed().await;
                    links.lock().await.retain(|held| !Arc::ptr_eq(held, &link));
                    on_device_gone(link.device());
                });
            }
            Accepted::Pair(link) => {
                let pairing = Arc::clone(&pairing);
                let on_code_wanted = Arc::clone(&on_code_wanted);
                tokio::spawn(async move {
                    // A wrong proof was already refused and counted.
                    let Ok(attempt) = link.request().await else {
                        return;
                    };
                    let name = attempt.name().to_string();
                    pairing.lock().await.attempt = Some(attempt);
                    on_code_wanted(name);
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;

    use kriyon_remote_link::device::Device;
    use kriyon_remote_link::invite::host_addr;

    use super::*;

    #[derive(Default)]
    struct Store(StdMutex<HashMap<EndpointId, (String, Role)>>);

    impl PairedDevices for Store {
        fn role(&self, device: &EndpointId) -> Option<Role> {
            self.0
                .lock()
                .expect("lock")
                .get(device)
                .map(|(_, role)| *role)
        }
    }

    fn loopback() -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], 0))
    }

    fn setup(store: &Arc<Store>, names: &Arc<StdMutex<Vec<String>>>) -> HostSetup {
        let names = Arc::clone(names);
        HostSetup {
            secret_key: [1; 32],
            bind: loopback(),
            paired: Arc::clone(store) as Arc<dyn PairedDevices>,
            on_code_wanted: Arc::new(move |name| names.lock().expect("lock").push(name)),
            on_device_gone: Arc::new(|_| {}),
        }
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn remote_access_is_off_until_turned_on_and_off_again_after() {
        run(async {
            let rt = RemoteRuntime::default();
            assert!(!rt.is_on().await);
            assert!(
                rt.start_pairing(Role::Viewer).await.is_err(),
                "off: no pairing"
            );
            let store = Arc::new(Store::default());
            let names = Arc::new(StdMutex::new(Vec::new()));
            rt.turn_on(setup(&store, &names)).await.expect("on");
            assert!(rt.is_on().await);
            assert_eq!(rt.host_id().await.map(|id| id.len()), Some(32));
            rt.turn_off().await;
            assert!(!rt.is_on().await);
            assert_eq!(rt.host_id().await, None);
        });
    }

    #[test]
    fn a_device_pairs_through_the_runtime_from_the_qr_code() {
        run(async {
            let rt = Arc::new(RemoteRuntime::default());
            let store = Arc::new(Store::default());
            let names = Arc::new(StdMutex::new(Vec::new()));
            rt.turn_on(setup(&store, &names)).await.expect("on");
            assert_eq!(rt.pairing_status().await, PairingStatus::Idle);

            let qr = rt
                .start_pairing(Role::Controller)
                .await
                .expect("pairing")
                .to_qr_text();
            assert_eq!(
                rt.pairing_status().await,
                PairingStatus::Waiting {
                    role: Role::Controller
                }
            );
            let scanned = PairingInvite::from_qr_text(&qr).expect("reads");
            let phone = Device::bind(&LinkConfig {
                bind: loopback(),
                ..LinkConfig::new([2; 32])
            })
            .await
            .expect("binds");
            let pairing = phone
                .pair(
                    host_addr(&scanned).expect("addr"),
                    &scanned.secret,
                    "Test phone",
                )
                .await
                .expect("proof accepted");

            // The person is asked for the code once the device took it.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while rt.pairing_status().await
                != (PairingStatus::CodeWanted {
                    role: Role::Controller,
                    device_name: "Test phone".into(),
                })
            {
                assert!(std::time::Instant::now() < deadline, "no code asked for");
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert_eq!(*names.lock().expect("lock"), ["Test phone"]);

            let code = pairing.code().to_string();
            let store_for = Arc::clone(&store);
            let rt_for = Arc::clone(&rt);
            let (outcome, answer) = tokio::join!(
                async move {
                    rt_for
                        .enter_code(&code, "Test Mac", |id, name, role| {
                            store_for
                                .0
                                .lock()
                                .expect("lock")
                                .insert(id, (name.to_string(), role));
                            true
                        })
                        .await
                },
                pairing.finish()
            );
            assert_eq!(
                outcome,
                Ok(CodeOutcome::Paired {
                    device: phone.id(),
                    name: "Test phone".into(),
                    role: Role::Controller
                })
            );
            assert_eq!(answer, Ok("Test Mac".to_string()));
            assert_eq!(store.role(&phone.id()), Some(Role::Controller));
            assert_eq!(rt.pairing_status().await, PairingStatus::Idle);
        });
    }

    #[test]
    fn a_paired_device_that_disconnects_is_reported_gone() {
        run(async {
            let rt = RemoteRuntime::default();
            let store = Arc::new(Store::default());
            let phone = Device::bind(&LinkConfig {
                bind: loopback(),
                ..LinkConfig::new([2; 32])
            })
            .await
            .expect("binds");
            store
                .0
                .lock()
                .expect("lock")
                .insert(phone.id(), ("Test phone".into(), Role::Controller));
            let names = Arc::new(StdMutex::new(Vec::new()));
            let gone = Arc::new(StdMutex::new(Vec::new()));
            let mut with_gone = setup(&store, &names);
            let noted = Arc::clone(&gone);
            with_gone.on_device_gone = Arc::new(move |id| noted.lock().expect("lock").push(id));
            rt.turn_on(with_gone).await.expect("on");
            let qr = rt
                .start_pairing(Role::Viewer)
                .await
                .expect("pairing")
                .to_qr_text();
            let host = host_addr(&PairingInvite::from_qr_text(&qr).expect("reads")).expect("addr");
            rt.stop_pairing().await;

            let link = phone.connect(host).await.expect("connects");
            let (mut out, incoming) = link.open_stream().await.expect("control");
            out.send(&kriyon_remote::message::FromDevice::Resync)
                .await
                .expect("sends");
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            assert!(gone.lock().expect("lock").is_empty(), "still connected");
            drop((out, incoming));
            phone.close().await;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while gone.lock().expect("lock").is_empty() {
                assert!(std::time::Instant::now() < deadline, "never reported gone");
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert_eq!(*gone.lock().expect("lock"), vec![phone.id()]);
        });
    }

    #[test]
    fn a_code_with_no_device_waiting_pairs_nothing() {
        run(async {
            let rt = RemoteRuntime::default();
            let store = Arc::new(Store::default());
            let names = Arc::new(StdMutex::new(Vec::new()));
            rt.turn_on(setup(&store, &names)).await.expect("on");
            rt.start_pairing(Role::Viewer).await.expect("pairing");
            assert_eq!(
                rt.enter_code("123456", "Test Mac", |_, _, _| -> bool {
                    panic!("nothing stored")
                })
                .await,
                Ok(CodeOutcome::NoAttempt)
            );
            rt.stop_pairing().await;
            assert_eq!(rt.pairing_status().await, PairingStatus::Idle);
        });
    }
}
