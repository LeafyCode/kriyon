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

/// Called with each endpoint as it is bound.
pub type OnBind = Arc<dyn Fn(&Bound) + Send + Sync>;

/// The owner of this computer's one endpoint.
pub struct RemoteEndpoint {
    config_bind: std::net::SocketAddr,
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
            config_bind: bind,
            bound: Mutex::new(None),
            wanted_relay: std::sync::Mutex::new(None),
            on_bind: std::sync::Mutex::new(None),
        }
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
        let config = LinkConfig {
            bind: self.config_bind,
            relay: wanted.clone().map(|(access, _)| access),
            ..LinkConfig::new(secret_key)
        };
        let relay = config.relay.clone();
        let endpoint = kriyon_remote_link::endpoint::bind(&config, Vec::new())
            .await
            .map_err(|e| e.to_string())?;
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

    /// Whether it is bound now.
    pub async fn is_bound(&self) -> bool {
        self.bound.lock().await.is_some()
    }
}

#[cfg(test)]
mod tests {
    use kriyon_remote::message::{EndpointId, Role};

    use super::*;

    struct Nobody;
    impl PairedDevices for Nobody {
        fn role(&self, _device: &EndpointId) -> Option<Role> {
            None
        }
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn the_endpoint_is_bound_once_and_closed_only_when_unused() {
        run(async {
            let owner = RemoteEndpoint::new(std::net::SocketAddr::from(([127, 0, 0, 1], 0)));
            assert!(!owner.is_bound().await);
            let first = owner
                .get([3; 32], || Arc::new(Nobody) as Arc<dyn PairedDevices>)
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
    fn a_new_relay_takes_effect_at_the_next_bind() {
        let relay = |pass: &str| RelayAccess {
            // Nothing listens there: no real network.
            url: "http://127.0.0.1:1/".parse().expect("url"),
            pass: pass.into(),
        };
        run(async {
            let owner = RemoteEndpoint::new(std::net::SocketAddr::from(([127, 0, 0, 1], 0)));
            let nobody = || Arc::new(Nobody) as Arc<dyn PairedDevices>;
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
