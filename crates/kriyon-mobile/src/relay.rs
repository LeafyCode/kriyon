//! Our relay on the phone (the [Relay pass] contract): [Device sign-in] in
//! the phone's browser, the relay on or off, this phone's pass in its store,
//! and the account's status. The phone has no buy button (Apple's rules): it
//! only shows the status. The logic is `kriyon_relay_client`'s, shared with
//! the desktop; this keeps its secrets in the phone's store and puts the pass
//! on the endpoint.

use std::sync::Arc;

use kriyon_relay_client::runtime::{RelayView, SignInView};
use kriyon_remote_link::keys::SecretVault;

use crate::device::{MobileDevice, MobileError, PhoneStore};

/// The store key of the relay's sign-in, switch and pass.
pub const RELAY_KEY: &str = "relay";

/// The relay's item in the phone's store, as the relay client keeps it.
pub(crate) struct StoreSecret(pub(crate) Arc<dyn PhoneStore>);

impl SecretVault for StoreSecret {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        self.0.read(RELAY_KEY.into()).map_err(|e| e.to_string())
    }

    fn write(&self, secret: &[u8]) -> Result<(), String> {
        self.0
            .write(RELAY_KEY.into(), secret.to_vec())
            .map_err(|e| e.to_string())
    }

    fn remove(&self) -> Result<(), String> {
        self.0.remove(RELAY_KEY.into()).map_err(|e| e.to_string())
    }
}

/// A device sign-in in progress: show the code; the page opens in the
/// phone's browser.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RelaySignIn {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
}

impl From<&SignInView> for RelaySignIn {
    fn from(view: &SignInView) -> Self {
        Self {
            user_code: view.user_code.clone(),
            verification_uri: view.verification_uri.clone(),
            verification_uri_complete: view.verification_uri_complete.clone(),
        }
    }
}

/// Our relay as the phone shows it.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct PhoneRelay {
    /// Whether this build has a relay at all; none: it is hidden.
    pub available: bool,
    pub signed_in: bool,
    pub on: bool,
    pub sign_in: Option<RelaySignIn>,
    /// What went wrong last, in the contract's words.
    pub problem: Option<String>,
    /// When the pass in hand expires, Unix seconds.
    pub pass_expires_at: Option<u64>,
}

impl From<RelayView> for PhoneRelay {
    fn from(view: RelayView) -> Self {
        Self {
            available: view.available,
            signed_in: view.signed_in,
            on: view.on,
            sign_in: view.sign_in.as_ref().map(RelaySignIn::from),
            problem: view.problem,
            pass_expires_at: view.pass_expires_at,
        }
    }
}

/// A device on the relay account.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RelayAccountDevice {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    /// This phone.
    pub this_phone: bool,
}

/// The relay account as the phone shows it: status only.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RelayAccount {
    /// `pending | active | past_due | canceled | expired`; none when the
    /// person never subscribed.
    pub state: Option<String>,
    pub paid_until: Option<String>,
    pub blocked: bool,
    pub devices: Vec<RelayAccountDevice>,
    pub device_limit: u32,
}

#[uniffi::export]
impl MobileDevice {
    /// Our relay as it stands.
    pub async fn relay(&self) -> PhoneRelay {
        match self.relay_runtime() {
            Some(relay) => {
                let relay = Arc::clone(relay);
                self.on_runtime(async move { relay.view().await })
                    .await
                    .map_or_else(|_| hidden(), PhoneRelay::from)
            }
            None => hidden(),
        }
    }

    /// Start a device sign-in: the code to show, and the page for the
    /// phone's browser. [`MobileDevice::relay_wait_sign_in`] waits for it.
    ///
    /// # Errors
    /// No relay in this build, or the API refused or can't be reached.
    pub async fn relay_sign_in(&self) -> Result<RelaySignIn, MobileError> {
        let relay = self.relay_or_refuse()?;
        let view = self
            .on_runtime(async move { relay.start_sign_in().await })
            .await?
            .map_err(|reason| MobileError::Link { reason })?;
        Ok(RelaySignIn::from(&view))
    }

    /// Wait until the sign-in started last ends; whether it signed in. A
    /// relay already on gets this phone's pass, and the endpoint uses it.
    pub async fn relay_wait_sign_in(&self) -> bool {
        let Ok(relay) = self.relay_or_refuse() else {
            return false;
        };
        let this = self.this_device();
        let signed_in = self
            .on_runtime(async move { relay.wait_for_current_sign_in(&this).await })
            .await
            .unwrap_or(false);
        if signed_in {
            let _ = self.apply_relay(true).await;
        }
        signed_in
    }

    /// Stop the sign-in in progress.
    pub async fn relay_cancel_sign_in(&self) {
        if let Ok(relay) = self.relay_or_refuse() {
            let _ = self
                .on_runtime(async move { relay.cancel_sign_in().await })
                .await;
        }
    }

    /// Sign out of the relay account on this phone; the relay goes off.
    ///
    /// # Errors
    /// No relay in this build, or the store couldn't be written.
    pub async fn relay_sign_out(&self) -> Result<PhoneRelay, MobileError> {
        let relay = self.relay_or_refuse()?;
        let out = Arc::clone(&relay);
        self.on_runtime(async move { out.sign_out().await })
            .await?
            .map_err(|reason| MobileError::Store { reason })?;
        self.apply_relay(true).await?;
        Ok(self.relay().await)
    }

    /// Turn our relay on (this phone is registered and its pass fetched) or
    /// off; the endpoint uses it at once.
    ///
    /// # Errors
    /// No relay in this build, not signed in, or the API refused, in the
    /// contract's words.
    pub async fn relay_set_on(&self, on: bool) -> Result<PhoneRelay, MobileError> {
        let relay = self.relay_or_refuse()?;
        let this = self.this_device();
        self.on_runtime(async move { relay.set_on(on, &this).await })
            .await?
            .map_err(|reason| MobileError::Link { reason })?;
        self.apply_relay(true).await?;
        Ok(self.relay().await)
    }

    /// The relay account's subscription and devices: status only.
    ///
    /// # Errors
    /// No relay in this build, not signed in, or the API refused or can't
    /// be reached.
    pub async fn relay_account(&self) -> Result<RelayAccount, MobileError> {
        let relay = self.relay_or_refuse()?;
        let status = self
            .on_runtime(async move { relay.account().await })
            .await?
            .map_err(|reason| MobileError::Link { reason })?;
        let me = self.id();
        Ok(RelayAccount {
            state: status.subscription.as_ref().map(|one| one.state.clone()),
            paid_until: status.subscription.map(|one| one.paid_until),
            blocked: status.blocked,
            devices: status
                .devices
                .into_iter()
                .map(|device| RelayAccountDevice {
                    this_phone: device.device_key == me,
                    device_id: device.device_id,
                    name: device.name,
                    platform: device.platform,
                })
                .collect(),
            device_limit: status.device_limit,
        })
    }
}

impl MobileDevice {
    /// Our relay, or why there is none.
    fn relay_or_refuse(
        &self,
    ) -> Result<Arc<kriyon_relay_client::runtime::RelayRuntime>, MobileError> {
        self.relay_runtime()
            .cloned()
            .ok_or_else(|| MobileError::Invalid {
                reason: "This build has no relay".into(),
            })
    }
}

/// The relay as a build without one shows it.
fn hidden() -> PhoneRelay {
    PhoneRelay {
        available: false,
        signed_in: false,
        on: false,
        sign_in: None,
        problem: None,
        pass_expires_at: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use kriyon_relay_client::api::test_api::{fake_api, TEST_PASS};
    use kriyon_remote_link::RelayAccess;

    use super::*;
    use crate::device::tests::{loopback, run, Memory, Seen};

    fn phone(store: &Arc<Memory>, api: Option<&str>) -> Arc<MobileDevice> {
        MobileDevice::start_with(
            Arc::clone(store) as Arc<dyn PhoneStore>,
            Arc::new(Seen::default()),
            "Test phone".into(),
            loopback(),
            None,
            api,
        )
        .expect("starts")
    }

    /// Nothing listens there: no real network.
    const RELAY_URL: &str = "http://127.0.0.1:1/";

    fn pass_reply() -> String {
        format!(
            r#"{{"data":{{"pass":"{TEST_PASS}","expiresAt":"2026-12-14T00:00:00.000Z","renewAfter":"2099-01-01T00:00:00.000Z","relayUrl":"{RELAY_URL}"}},"meta":{{}}}}"#
        )
    }

    #[test]
    fn a_build_without_the_relays_api_has_no_relay() {
        let store = Arc::new(Memory::default());
        let device = phone(&store, None);
        run(async {
            assert!(!device.relay().await.available);
            assert!(device.relay_sign_in().await.is_err());
            assert!(device.relay_set_on(true).await.is_err());
        });
    }

    #[test]
    fn signing_in_and_turning_the_relay_on_puts_this_phones_pass_on_the_endpoint() {
        let reply = pass_reply();
        let (base, seen) = fake_api(move |line, _| {
            match line {
            "POST /api/v1/admin/auth/device/code" => (
                200,
                r#"{"device_code":"dc","user_code":"ABCD1234","verification_uri":"https://web.test/device","verification_uri_complete":"https://web.test/device?code=ABCD1234","expires_in":600,"interval":0}"#.into(),
            ),
            "POST /api/v1/admin/auth/device/token" => (200, r#"{"access_token":"tok"}"#.into()),
            "POST /api/v1/kriyon-relay/devices" => (
                200,
                r#"{"data":{"deviceId":"d1","deviceKey":"k","name":"Test phone","platform":"ios"},"meta":{}}"#.into(),
            ),
            "POST /api/v1/kriyon-relay/passes" => (200, reply.clone()),
            _ => (404, "{}".into()),
        }
        });
        let store = Arc::new(Memory::default());
        let device = phone(&store, Some(&base));
        let wanted = RelayAccess {
            url: RELAY_URL.parse().expect("url"),
            pass: TEST_PASS.into(),
        };
        run({
            let device = Arc::clone(&device);
            let wanted = wanted.clone();
            async move {
                assert!(device.relay().await.available);
                let code = device.relay_sign_in().await.expect("started");
                assert_eq!(code.user_code, "ABCD1234");
                assert_eq!(
                    code.verification_uri_complete,
                    "https://web.test/device?code=ABCD1234"
                );
                assert!(device.relay_wait_sign_in().await, "signed in");
                let view = device.relay_set_on(true).await.expect("on");
                assert!(view.on && view.signed_in);
                assert_eq!(device.shared_for_tests().bound_relay().await, Some(wanted));
                let view = device.relay_set_on(false).await.expect("off");
                assert!(!view.on);
                assert_eq!(device.shared_for_tests().bound_relay().await, None);
                device.relay_set_on(true).await.expect("on again");
            }
        });
        let seen = seen.lock().expect("seen").clone();
        assert!(seen[0].body.contains(r#""client_id":"kriyon-mobile""#));
        let register = seen
            .iter()
            .find(|one| one.line == "POST /api/v1/kriyon-relay/devices")
            .expect("registered");
        assert!(register
            .body
            .contains(&format!(r#""deviceKey":"{}""#, device.id())));
        drop(device);
        // Started again: the pass in the store is on the endpoint at once.
        let again = phone(&store, Some(&base));
        run(async move {
            assert_eq!(again.shared_for_tests().bound_relay().await, Some(wanted));
        });
    }

    #[test]
    fn the_account_is_status_only_with_this_phone_marked() {
        let store = Arc::new(Memory::default());
        let (base, _) = fake_api(|_, _| (404, "{}".into()));
        let device = phone(&store, Some(&base));
        let me = device.id();
        let status = format!(
            r#"{{"data":{{"subscription":null,"devices":[{{"deviceId":"d1","deviceKey":"{me}","name":"Test phone","platform":"ios"}},{{"deviceId":"d2","deviceKey":"other","name":"Mac","platform":"macos"}}],"deviceLimit":10,"blocked":false}},"meta":{{}}}}"#
        );
        let (base, _) = fake_api(move |line, _| match line {
            "GET /api/v1/kriyon-relay/status" => (200, status.clone()),
            _ => (404, "{}".into()),
        });
        drop(device);
        store
            .write(
                RELAY_KEY.into(),
                br#"{"token":"tok","on":false,"pass":null}"#.to_vec(),
            )
            .expect("signed in");
        let device = phone(&store, Some(&base));
        let account = run({
            let device = Arc::clone(&device);
            async move { device.relay_account().await.expect("status") }
        });
        assert_eq!(account.state, None, "never subscribed");
        assert_eq!(account.device_limit, 10);
        assert_eq!(
            account
                .devices
                .iter()
                .map(|one| (one.name.as_str(), one.this_phone))
                .collect::<Vec<_>>(),
            [("Test phone", true), ("Mac", false)]
        );
    }
}
