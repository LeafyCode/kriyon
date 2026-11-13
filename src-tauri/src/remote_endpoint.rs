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
use kriyon_remote_link::LinkConfig;
use tokio::sync::Mutex;

/// Refused handshakes one source may cause a minute before it is ignored.
const UNPAIRED_PER_MINUTE: u32 = 10;

/// The endpoint and the host on it.
#[derive(Clone)]
pub struct Bound {
    pub endpoint: Endpoint,
    pub host: Arc<Host>,
}

/// The owner of this computer's one endpoint.
pub struct RemoteEndpoint {
    config_bind: std::net::SocketAddr,
    bound: Mutex<Option<Bound>>,
}

impl RemoteEndpoint {
    /// An owner that binds on `bind` (any port, every interface, in the app).
    #[must_use]
    pub fn new(bind: std::net::SocketAddr) -> Self {
        Self {
            config_bind: bind,
            bound: Mutex::new(None),
        }
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
        let config = LinkConfig {
            bind: self.config_bind,
            ..LinkConfig::new(secret_key)
        };
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
        let made = Bound { endpoint, host };
        *bound = Some(made.clone());
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
}
