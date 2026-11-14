//! The one iroh endpoint this computer runs for remote access: it hosts
//! (when [Remote access] is on) and dials other computers as a device, with
//! one id, the [Device key]'s. Two endpoints with one id would clash at a
//! relay, which keys clients by id.
//!
//! Bound only when something needs it, with the host on it not accepting
//! until remote access is turned on; closed again once neither side uses it.

use std::sync::Arc;

use iroh::Endpoint;
use kriyon_remote_link::host::{Host, PairedDevices};
use kriyon_remote_link::{LinkConfig, RelayAccess};
use tokio::sync::Mutex;

/// Refused handshakes one source may cause a minute before it is ignored.
const UNPAIRED_PER_MINUTE: u32 = 10;

/// The endpoint and the host on it.
#[derive(Clone)]
pub struct Bound {
    pub endpoint: Endpoint,
    pub host: Arc<Host>,
    /// The relay it was bound with: iroh reads the pass only then.
    pub relay: Option<RelayAccess>,
    /// When that relay's pass expires (Unix seconds).
    pub relay_expires: Option<u64>,
}

/// How long a bind waits for its fixed port: a closed endpoint lets go of
/// it only once its last clone is dropped, a moment after a rebuild.
const PORT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// Bind `config`, trying its fixed port again for up to [`PORT_WAIT`]: the
/// endpoint before may still be letting go of it. The last error if it
/// stays taken.
async fn bind_waiting(config: &LinkConfig) -> Result<Endpoint, kriyon_remote_link::LinkError> {
    let deadline = std::time::Instant::now() + PORT_WAIT;
    loop {
        match kriyon_remote_link::endpoint::bind(config, Vec::new()).await {
            Ok(endpoint) => return Ok(endpoint),
            Err(why) if config.bind.port() == 0 || std::time::Instant::now() >= deadline => {
                return Err(why);
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
        }
    }
}

/// Called with each endpoint as it is bound.
pub type OnBind = Arc<dyn Fn(&Bound) + Send + Sync>;

/// The owner of this computer's one endpoint.
pub struct RemoteEndpoint {
    /// Where to listen: every interface, on the port the person chose.
    config_bind: std::sync::Mutex<std::net::SocketAddr>,
    /// Why the endpoint bound now isn't on that port, if it isn't.
    port_note: std::sync::Mutex<Option<String>>,
    bound: Mutex<Option<Bound>>,
    /// The relay the next bind uses, and when its pass expires.
    wanted_relay: std::sync::Mutex<Option<(RelayAccess, u64)>>,
    on_bind: std::sync::Mutex<Option<OnBind>>,
}

impl RemoteEndpoint {
    /// An owner that binds on `bind` (any port, every interface, in the app).
    #[must_use]
    pub fn new(bind: std::net::SocketAddr) -> Self {
        Self {
            config_bind: std::sync::Mutex::new(bind),
            port_note: std::sync::Mutex::new(None),
            bound: Mutex::new(None),
            wanted_relay: std::sync::Mutex::new(None),
            on_bind: std::sync::Mutex::new(None),
        }
    }

    /// Listen on `port` from the next bind on (the person's setting).
    pub fn set_port(&self, port: u16) {
        if let Ok(mut bind) = self.config_bind.lock() {
            bind.set_port(port);
        }
    }

    /// The port the person chose.
    #[must_use]
    pub fn port(&self) -> u16 {
        self.config_bind.lock().map_or(0, |bind| bind.port())
    }

    /// Why the endpoint bound now isn't on the chosen port: it was taken.
    #[must_use]
    pub fn port_note(&self) -> Option<String> {
        self.port_note.lock().ok().and_then(|note| note.clone())
    }

    /// Call `hook` with each endpoint as it is bound.
    pub fn on_bind(&self, hook: OnBind) {
        if let Ok(mut slot) = self.on_bind.lock() {
            *slot = Some(hook);
        }
    }

    /// Use `relay` (with when its pass expires) from the next bind on.
    /// Returns whether the endpoint bound now uses another: it has to be
    /// rebuilt to change.
    pub async fn want_relay(&self, relay: Option<(RelayAccess, u64)>) -> bool {
        let bound = self.bound.lock().await;
        let stale = bound
            .as_ref()
            .is_some_and(|bound| bound.relay.as_ref() != relay.as_ref().map(|(access, _)| access));
        if let Ok(mut wanted) = self.wanted_relay.lock() {
            *wanted = relay;
        }
        stale
    }

    /// The endpoint, bound now if it isn't, with a host on it that doesn't
    /// accept until told to.
    ///
    /// # Errors
    /// Why it couldn't be bound.
    pub async fn get(
        &self,
        secret_key: [u8; 32],
        paired: impl FnOnce() -> Arc<dyn PairedDevices>,
    ) -> Result<Bound, String> {
        let mut bound = self.bound.lock().await;
        if let Some(bound) = bound.as_ref() {
            return Ok(bound.clone());
        }
        let wanted = self
            .wanted_relay
            .lock()
            .ok()
            .and_then(|wanted| wanted.clone());
        let bind = self
            .config_bind
            .lock()
            .map_or(std::net::SocketAddr::from(([0, 0, 0, 0], 0)), |bind| *bind);
        let mut config = LinkConfig {
            bind,
            relay: wanted.clone().map(|(access, _)| access),
            ..LinkConfig::new(secret_key)
        };
        let relay = config.relay.clone();
        let (endpoint, note) = match bind_waiting(&config).await {
            Ok(endpoint) => (endpoint, None),
            // Taken by another program: any port, and the person is told,
            // since what devices stored at pairing names the fixed one.
            Err(_) if bind.port() != 0 => {
                config.bind.set_port(0);
                let endpoint = kriyon_remote_link::endpoint::bind(&config, Vec::new())
                    .await
                    .map_err(|e| e.to_string())?;
                (
                    endpoint,
                    Some(format!(
                        "Port {} is in use by another program, so remote access uses another \
                         port until it starts again (turn it off and on, or reopen Kriyon) \
                         with the port free. Devices paired over this network or Tailscale \
                         may not reach this computer until then.",
                        bind.port()
                    )),
                )
            }
            Err(e) => return Err(e.to_string()),
        };
        if let Ok(mut slot) = self.port_note.lock() {
            *slot = note;
        }
        let host = Arc::new(Host::on_endpoint(
            endpoint.clone(),
            paired(),
            UNPAIRED_PER_MINUTE,
        ));
        // Dialing out never opens this computer to others.
        host.stop_accepting();
        let made = Bound {
            endpoint,
            host,
            relay,
            relay_expires: wanted.map(|(_, expires)| expires),
        };
        *bound = Some(made.clone());
        let hook = self.on_bind.lock().ok().and_then(|hook| hook.clone());
        if let Some(hook) = hook {
            hook(&made);
        }
        Ok(made)
    }

    /// Close the endpoint if `unused`: remote access is off and no paired
    /// computer is connected to.
    pub async fn close_if(&self, unused: bool) {
        if !unused {
            return;
        }
        if let Some(bound) = self.bound.lock().await.take() {
            bound.host.stop_accepting();
            bound.endpoint.close().await;
        }
    }

    /// The relay the endpoint bound now uses, if any.
    pub async fn bound_relay(&self) -> Option<RelayAccess> {
        self.bound
            .lock()
            .await
            .as_ref()
            .and_then(|bound| bound.relay.clone())
    }

    /// When the pass of the relay the endpoint bound now uses expires.
    pub async fn bound_relay_expires(&self) -> Option<u64> {
        self.bound
            .lock()
            .await
            .as_ref()
            .and_then(|bound| bound.relay_expires)
    }

    /// Tell the endpoint the network may have changed (the computer woke):
    /// it looks for paths again now rather than on its own schedule. A
    /// no-op while unbound.
    pub async fn network_changed(&self) {
        let endpoint = self
            .bound
            .lock()
            .await
            .as_ref()
            .map(|bound| bound.endpoint.clone());
        if let Some(endpoint) = endpoint {
            endpoint.network_change().await;
        }
    }

    /// Whether it is bound now.
    pub async fn is_bound(&self) -> bool {
        self.bound.lock().await.is_some()
    }
}

#[cfg(test)]
mod tests {
    use kriyon_remote_link::test_support::MemoryPaired;

    use super::*;

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn the_endpoint_is_bound_once_and_closed_only_when_unused() {
        run(async {
            let owner = RemoteEndpoint::new(std::net::SocketAddr::from(([127, 0, 0, 1], 0)));
            assert!(!owner.is_bound().await);
            let first = owner
                .get([3; 32], || {
                    Arc::new(MemoryPaired::default()) as Arc<dyn PairedDevices>
                })
                .await
                .expect("binds");
            let again = owner
                .get([3; 32], || panic!("bound once"))
                .await
                .expect("the same");
            assert_eq!(first.endpoint.id(), again.endpoint.id());
            assert_eq!(first.host.id(), *first.endpoint.id().as_bytes());
            owner.close_if(false).await;
            assert!(owner.is_bound().await, "still in use");
            owner.close_if(true).await;
            assert!(!owner.is_bound().await);
        });
    }

    #[test]
    fn a_port_taken_falls_back_to_any_and_says_so() {
        run(async {
            // Another program holds the port.
            let holder = std::net::UdpSocket::bind("127.0.0.1:0").expect("a socket");
            let taken = holder.local_addr().expect("its address");
            let owner = RemoteEndpoint::new(taken);
            let nobody = || Arc::new(MemoryPaired::default()) as Arc<dyn PairedDevices>;
            let bound = owner.get([3; 32], nobody).await.expect("binds anyway");
            let port = bound.endpoint.bound_sockets()[0].port();
            assert_ne!(port, taken.port());
            let note = owner.port_note().expect("said");
            assert!(note.contains(&taken.port().to_string()), "{note}");
            owner.close_if(true).await;
            // Free again: the next bind takes it, and the note goes.
            drop(holder);
            let again = owner.get([3; 32], nobody).await.expect("binds");
            assert_eq!(again.endpoint.bound_sockets()[0].port(), taken.port());
            assert_eq!(owner.port_note(), None);
            owner.close_if(true).await;
        });
    }

    /// Closed, an endpoint lets go of its port only once its last clone
    /// (the device side keeps one) is dropped: a rebind waits a moment for
    /// it rather than taking another port.
    #[test]
    fn a_rebind_gets_its_fixed_port_back_once_the_old_endpoint_lets_go() {
        run(async {
            let free = std::net::UdpSocket::bind("127.0.0.1:0")
                .and_then(|socket| socket.local_addr())
                .expect("a free port");
            let owner = RemoteEndpoint::new(free);
            let nobody = || Arc::new(MemoryPaired::default()) as Arc<dyn PairedDevices>;
            let first = owner.get([3; 32], nobody).await.expect("binds");
            assert_eq!(first.endpoint.bound_sockets()[0].port(), free.port());
            let kept = first.endpoint.clone();
            drop(first);
            owner.close_if(true).await;
            // The device side lets go of its clone a little later.
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                drop(kept);
            });
            let again = owner.get([3; 32], nobody).await.expect("binds");
            assert_eq!(again.endpoint.bound_sockets()[0].port(), free.port());
            assert_eq!(owner.port_note(), None);
            owner.close_if(true).await;
        });
    }

    #[test]
    fn a_new_port_takes_effect_at_the_next_bind() {
        run(async {
            let owner = RemoteEndpoint::new(std::net::SocketAddr::from(([127, 0, 0, 1], 0)));
            let nobody = || Arc::new(MemoryPaired::default()) as Arc<dyn PairedDevices>;
            let free = std::net::UdpSocket::bind("127.0.0.1:0")
                .and_then(|socket| socket.local_addr())
                .expect("a free port")
                .port();
            owner.set_port(free);
            let bound = owner.get([3; 32], nobody).await.expect("binds");
            assert_eq!(bound.endpoint.bound_sockets()[0].port(), free);
            assert_eq!(owner.port(), free);
            owner.close_if(true).await;
        });
    }

    #[test]
    fn a_new_relay_takes_effect_at_the_next_bind() {
        let relay = |pass: &str| RelayAccess {
            // Nothing listens there: no real network.
            url: "http://127.0.0.1:1/".parse().expect("url"),
            pass: pass.into(),
        };
        run(async {
            let owner = RemoteEndpoint::new(std::net::SocketAddr::from(([127, 0, 0, 1], 0)));
            let nobody = || Arc::new(MemoryPaired::default()) as Arc<dyn PairedDevices>;
            let bound_now = Arc::new(std::sync::Mutex::new(Vec::new()));
            let seen = Arc::clone(&bound_now);
            owner.on_bind(Arc::new(move |bound: &Bound| {
                seen.lock().expect("seen").push(bound.relay_expires);
            }));
            assert!(
                !owner.want_relay(Some((relay("p1"), 100))).await,
                "nothing bound yet"
            );
            let first = owner.get([3; 32], nobody).await.expect("binds");
            assert_eq!(first.relay, Some(relay("p1")));
            assert_eq!(owner.bound_relay_expires().await, Some(100));
            assert!(
                !owner.want_relay(Some((relay("p1"), 100))).await,
                "the same"
            );
            assert!(
                owner.want_relay(Some((relay("p2"), 200))).await,
                "a newer pass"
            );
            owner.close_if(true).await;
            let second = owner.get([3; 32], nobody).await.expect("binds");
            assert_eq!(second.relay, Some(relay("p2")));
            assert_eq!(*bound_now.lock().expect("seen"), [Some(100), Some(200)]);
            assert!(owner.want_relay(None).await, "relay turned off");
            owner.close_if(true).await;
        });
    }
}
