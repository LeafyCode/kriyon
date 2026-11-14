//! [Remote access] on the host: the switch, the host endpoint and its accept
//! loop, and the one pairing in progress. Off means no endpoint at all.
//!
//! Kept free of Tauri types so it is tested end to end with a real device
//! over loopback; `remote_cmd` wires it to the app's store and windows.

use std::sync::Arc;

use crate::host::{Accepted, Host, PairAttempt, RemoteLink};
use kriyon_remote::link_policy::CodeCheck;
use kriyon_remote::message::{EndpointId, Role};
use kriyon_remote::pairing::PairingInvite;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

mod serve;
pub use serve::*;

/// What the host needs to come up.
pub struct HostSetup {
    /// The host on this computer's one endpoint ([`crate::remote_endpoint`]).
    pub host: Arc<Host>,
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
    /// The QR code is up until `expires_at_ms`; no device has taken it yet.
    Waiting { role: Role, expires_at_ms: i64 },
    /// A device took it; the person should type its code before
    /// `expires_at_ms`.
    CodeWanted {
        role: Role,
        device_name: String,
        expires_at_ms: i64,
    },
    /// Five minutes passed: start again with a new QR code.
    Expired,
    /// Three wrong codes: start again with a new QR code.
    Burned,
}

/// Now, in ms since the epoch.
#[must_use]
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The host side of [Remote access], one per app.
#[derive(Default)]
pub struct RemoteRuntime {
    running: Mutex<Option<Running>>,
    /// What serves paired devices' streams, set once at app start.
    serve: std::sync::Mutex<Option<Serve>>,
}

struct Running {
    host: Arc<Host>,
    accept: JoinHandle<()>,
    pairing: Arc<Mutex<Pairing>>,
    /// Paired devices' connections, while they last.
    links: Arc<Mutex<Vec<Arc<RemoteLink>>>>,
}

#[derive(Default)]
struct Pairing {
    role: Option<Role>,
    attempt: Option<PairAttempt>,
    /// Three wrong codes ended it; shown until the person starts again.
    burned: bool,
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
    /// Serve paired devices with `serve` from the next `turn_on` on. Without
    /// it, their connections are held but not served.
    pub fn serve_with(&self, serve: Serve) {
        if let Ok(mut slot) = self.serve.lock() {
            *slot = Some(serve);
        }
    }

    /// Bring the host endpoint up. Does nothing if it is already up.
    ///
    /// # Errors
    /// Why the endpoint couldn't be bound.
    pub async fn turn_on(&self, setup: HostSetup) -> Result<(), String> {
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Ok(());
        }
        let host = setup.host;
        host.start_accepting();
        let pairing = Arc::new(Mutex::new(Pairing::default()));
        let links = Arc::new(Mutex::new(Vec::new()));
        let serve = self.serve.lock().ok().and_then(|slot| slot.clone());
        let accept = tokio::spawn(accept_loop(
            Arc::clone(&host),
            Arc::clone(&pairing),
            Arc::clone(&links),
            serve,
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

    /// Stop accepting: every device's connection and any pairing go. The
    /// endpoint itself is its owner's to close.
    pub async fn turn_off(&self) {
        let Some(running) = self.running.lock().await.take() else {
            return;
        };
        running.accept.abort();
        running.links.lock().await.clear();
        running.pairing.lock().await.attempt = None;
        running.host.stop_accepting();
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
        let secret = crate::endpoint::generate_secret_key();
        running.host.start_pairing(secret, role);
        *running.pairing.lock().await = Pairing {
            role: Some(role),
            attempt: None,
            burned: false,
        };
        // A device on the same tailnet reaches this computer from anywhere.
        let tailscale = crate::invite::tailscale_ips().await;
        Ok(crate::invite::invite_on(&running.host, secret, &tailscale))
    }

    /// Stop the pairing in progress, if any.
    pub async fn stop_pairing(&self) {
        if let Some(running) = self.running.lock().await.as_ref() {
            running.host.stop_pairing();
            *running.pairing.lock().await = Pairing::default();
        }
    }

    pub async fn pairing_status(&self) -> PairingStatus {
        self.pairing_status_after(std::time::Duration::ZERO).await
    }

    /// The pairing state as it will stand `elapsed` from now. The deadline is
    /// the host's own (its pending pairing's), so the two never disagree.
    pub async fn pairing_status_after(&self, elapsed: std::time::Duration) -> PairingStatus {
        let running = self.running.lock().await;
        let Some(running) = running.as_ref() else {
            return PairingStatus::Idle;
        };
        let pairing = running.pairing.lock().await;
        if pairing.burned {
            return PairingStatus::Burned;
        }
        let (Some(role), Some(left)) = (pairing.role, running.host.pairing_time_left()) else {
            return PairingStatus::Idle;
        };
        let left = left.saturating_sub(elapsed);
        if left.is_zero() {
            return PairingStatus::Expired;
        }
        let expires_at_ms = now_ms() + i64::try_from(left.as_millis()).unwrap_or(i64::MAX);
        match &pairing.attempt {
            None => PairingStatus::Waiting {
                role,
                expires_at_ms,
            },
            Some(attempt) => PairingStatus::CodeWanted {
                role,
                device_name: attempt.name().to_string(),
                expires_at_ms,
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
                *pairing = Pairing {
                    burned: true,
                    ..Pairing::default()
                };
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
/// devices' connections are served by `serve`.
async fn accept_loop(
    host: Arc<Host>,
    pairing: Arc<Mutex<Pairing>>,
    links: Arc<Mutex<Vec<Arc<RemoteLink>>>>,
    serve: Option<Serve>,
    on_code_wanted: Arc<dyn Fn(String) + Send + Sync>,
    on_device_gone: Arc<dyn Fn(EndpointId) + Send + Sync>,
) {
    while let Some(accepted) = host.accept().await {
        match accepted {
            Accepted::Remote(link) => {
                let link = Arc::new(link);
                links.lock().await.push(Arc::clone(&link));
                if let Some(serve) = &serve {
                    tokio::spawn(serve.clone().serve(Arc::clone(&link)));
                }
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

    use crate::device::Device;
    use crate::host::PairedDevices;
    use crate::invite::host_addr;
    use crate::LinkConfig;
    use std::net::SocketAddr;

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

    async fn setup(store: &Arc<Store>, names: &Arc<StdMutex<Vec<String>>>) -> HostSetup {
        let names = Arc::clone(names);
        let host = Host::bind(
            &LinkConfig {
                bind: loopback(),
                ..LinkConfig::new([1; 32])
            },
            Arc::clone(store) as Arc<dyn PairedDevices>,
            10,
        )
        .await
        .expect("binds");
        HostSetup {
            host: Arc::new(host),
            on_code_wanted: Arc::new(move |name| names.lock().expect("lock").push(name)),
            on_device_gone: Arc::new(|_| {}),
        }
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        crate::test_support::run(f)
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
            rt.turn_on(setup(&store, &names).await).await.expect("on");
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
            rt.turn_on(setup(&store, &names).await).await.expect("on");
            assert_eq!(rt.pairing_status().await, PairingStatus::Idle);

            let qr = rt
                .start_pairing(Role::Controller)
                .await
                .expect("pairing")
                .to_qr_text();
            assert!(matches!(
                rt.pairing_status().await,
                PairingStatus::Waiting {
                    role: Role::Controller,
                    ..
                }
            ));
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
            while !matches!(
                rt.pairing_status().await,
                PairingStatus::CodeWanted {
                    role: Role::Controller,
                    ref device_name,
                    ..
                } if device_name == "Test phone"
            ) {
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
            let mut with_gone = setup(&store, &names).await;
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
    fn a_pairing_shows_its_deadline_and_expires_after_five_minutes() {
        run(async {
            let rt = RemoteRuntime::default();
            let store = Arc::new(Store::default());
            let names = Arc::new(StdMutex::new(Vec::new()));
            rt.turn_on(setup(&store, &names).await).await.expect("on");
            let before = now_ms();
            rt.start_pairing(Role::Viewer).await.expect("pairing");
            let PairingStatus::Waiting { expires_at_ms, .. } = rt.pairing_status().await else {
                panic!("waiting");
            };
            let five_min = 5 * 60 * 1000;
            // The host's own deadline, read back through its time left: within
            // a second of five minutes from when the pairing started.
            assert!((before + five_min - 1000..=now_ms() + five_min).contains(&expires_at_ms));
            let valid = kriyon_remote::link_policy::PAIRING_VALID_FOR;
            assert!(matches!(
                rt.pairing_status_after(valid.saturating_sub(std::time::Duration::from_secs(1)))
                    .await,
                PairingStatus::Waiting { .. }
            ));
            assert_eq!(rt.pairing_status_after(valid).await, PairingStatus::Expired);
            rt.stop_pairing().await;
            assert_eq!(rt.pairing_status().await, PairingStatus::Idle);
        });
    }

    #[test]
    fn three_wrong_codes_leave_the_pairing_burned_until_the_person_starts_again() {
        run(async {
            let rt = Arc::new(RemoteRuntime::default());
            let store = Arc::new(Store::default());
            let names = Arc::new(StdMutex::new(Vec::new()));
            rt.turn_on(setup(&store, &names).await).await.expect("on");
            let qr = rt
                .start_pairing(Role::Viewer)
                .await
                .expect("pairing")
                .to_qr_text();
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
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !matches!(rt.pairing_status().await, PairingStatus::CodeWanted { .. }) {
                assert!(std::time::Instant::now() < deadline, "no code asked for");
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            let rt_for = Arc::clone(&rt);
            let (outcomes, _answer) = tokio::join!(
                async move {
                    let mut outcomes = Vec::new();
                    for wrong in ["000000", "000001", "000002"] {
                        outcomes.push(
                            rt_for
                                .enter_code(wrong, "Test Mac", |_, _, _| -> bool {
                                    panic!("nothing stored")
                                })
                                .await,
                        );
                    }
                    outcomes
                },
                pairing.finish()
            );
            assert_eq!(
                outcomes,
                [
                    Ok(CodeOutcome::Wrong { tries_left: 2 }),
                    Ok(CodeOutcome::Wrong { tries_left: 1 }),
                    Ok(CodeOutcome::Burned),
                ]
            );
            assert_eq!(rt.pairing_status().await, PairingStatus::Burned);
            rt.start_pairing(Role::Viewer).await.expect("again");
            assert!(matches!(
                rt.pairing_status().await,
                PairingStatus::Waiting { .. }
            ));
        });
    }

    #[test]
    fn a_code_with_no_device_waiting_pairs_nothing() {
        run(async {
            let rt = RemoteRuntime::default();
            let store = Arc::new(Store::default());
            let names = Arc::new(StdMutex::new(Vec::new()));
            rt.turn_on(setup(&store, &names).await).await.expect("on");
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
