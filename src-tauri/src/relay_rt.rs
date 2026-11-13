//! Our relay on this computer: [Device sign-in], whether the relay is on,
//! this device's [Relay pass] and its renewal, and what went wrong. The
//! API's and website's addresses come from build-time configuration; a build
//! without them has no relay at all, and everything else works.
//!
//! Kept free of Tauri types so it is tested against a fake API; `relay_cmd`
//! wires it to the app, its endpoint and its windows.

use kriyon_remote::relay::{parse_utc, pass_due, ApiRefusal, RelayAction, SignInPoll};
use kriyon_remote_link::RelayAccess;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::relay_api::{ApiError, PassReply, RelayApi, RelayStatus};
use kriyon_remote_link::keys::SecretVault;

/// Where the API and the website are, from build-time configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelaySetup {
    /// The API base (`KRIYON_RELAY_API`).
    pub api: String,
    /// The website base (`KRIYON_RELAY_WEB`), where the person subscribes.
    pub web: String,
}

impl RelaySetup {
    /// This build's setup: `None` (no relay) unless both were set when it
    /// was built.
    #[must_use]
    pub fn from_build() -> Option<Self> {
        Self::from_values(
            option_env!("KRIYON_RELAY_API"),
            option_env!("KRIYON_RELAY_WEB"),
        )
    }

    /// The setup from `api` and `web`: both present and not blank.
    #[must_use]
    pub fn from_values(api: Option<&str>, web: Option<&str>) -> Option<Self> {
        let clean = |value: Option<&str>| {
            value
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.trim_end_matches('/').to_string())
        };
        Some(Self {
            api: clean(api)?,
            web: clean(web)?,
        })
    }

    /// Where the person subscribes, changes or cancels.
    #[must_use]
    pub fn subscriptions_url(&self) -> String {
        format!("{}/subscriptions", self.web)
    }
}

/// This computer as the relay account knows it.
#[derive(Clone, Debug)]
pub struct ThisDevice {
    /// Its endpoint id, hex.
    pub key_hex: String,
    pub name: String,
    pub platform: &'static str,
}

/// What is kept in the keychain.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
struct Saved {
    /// The [Device sign-in]'s access token.
    token: Option<String>,
    /// Whether the person turned the relay on.
    on: bool,
    /// The newest pass.
    pass: Option<PassReply>,
}

/// What went wrong last, as the person sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelayProblem {
    /// The API refused.
    Api(ApiRefusal),
    /// The relay refused.
    Relay(RelayAction),
    /// The person said no in the browser.
    SignInDenied,
    /// The code ran out before it was approved.
    SignInExpired,
}

impl RelayProblem {
    /// The message the person sees.
    #[must_use]
    pub fn message(self) -> String {
        let text = match self {
            Self::Api(refusal) => refusal.message().unwrap_or(match refusal {
                ApiRefusal::Unavailable => "Can't reach our relay's service. Try again later",
                _ => "Our relay's service turned down a request from Kriyon",
            }),
            Self::Relay(action) => match action {
                RelayAction::Renew => {
                    "Our relay turned down this computer's pass. Getting a new one"
                }
                RelayAction::CheckStatus => "Relay access is suspended for this account",
                RelayAction::Removed => "This device was removed from your relay account",
                RelayAction::RetryLater => {
                    "Too many devices are connected through our relay. Kriyon tries again later"
                }
                RelayAction::Report => {
                    "Our relay refused this computer's pass, and a new pass won't help. \
                     Please report this"
                }
            },
            Self::SignInDenied => "Sign-in was turned down in the browser",
            Self::SignInExpired => "The sign-in code ran out. Start again",
        };
        text.to_string()
    }
}

/// A [Device sign-in] in progress.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignInView {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    #[serde(skip)]
    device_code: String,
    #[serde(skip)]
    interval_s: u64,
    #[serde(skip)]
    expires_in_s: u64,
}

impl SignInView {
    /// The code this sign-in is polled with; never shown.
    #[must_use]
    pub fn device_code(&self) -> &str {
        &self.device_code
    }
}

/// The relay as the settings show it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayView {
    /// Whether this build has a relay at all.
    pub available: bool,
    pub signed_in: bool,
    pub on: bool,
    pub sign_in: Option<SignInView>,
    pub problem: Option<String>,
    /// When the pass in hand expires (Unix seconds).
    pub pass_expires_at: Option<u64>,
}

#[derive(Default)]
struct State {
    saved: Option<Saved>,
    sign_in: Option<SignInView>,
    problem: Option<RelayProblem>,
}

/// The words for a call that didn't give its answer.
fn error_text(error: &ApiError) -> String {
    match error {
        ApiError::Refused(refusal) => RelayProblem::Api(*refusal).message(),
        ApiError::Unreachable(_) => RelayProblem::Api(ApiRefusal::Unavailable).message(),
    }
}

/// Our relay, one per app.
pub struct RelayRuntime {
    setup: Option<RelaySetup>,
    vault: Box<dyn SecretVault>,
    state: Mutex<State>,
}

impl RelayRuntime {
    /// The relay for `setup` (none: hidden), its secrets kept in `vault`.
    #[must_use]
    pub fn new(setup: Option<RelaySetup>, vault: Box<dyn SecretVault>) -> Self {
        Self {
            setup,
            vault,
            state: Mutex::new(State::default()),
        }
    }

    /// Where the person subscribes; `None` without a relay.
    #[must_use]
    pub fn subscriptions_url(&self) -> Option<String> {
        self.setup.as_ref().map(RelaySetup::subscriptions_url)
    }

    /// What the keychain holds; `None` when it can't be read now (locked,
    /// or access refused), which is never taken for "nothing kept".
    fn load(&self) -> Option<Saved> {
        match self.vault.read() {
            // An item that doesn't read as ours is left as if empty.
            Ok(Some(bytes)) => Some(serde_json::from_slice(&bytes).unwrap_or_default()),
            Ok(None) => Some(Saved::default()),
            Err(e) => {
                eprintln!("kriyon: can't read the relay sign-in from the keychain: {e}");
                None
            }
        }
    }

    /// Change what is kept, and keep it if it changed. While the keychain
    /// can't be read, the change is made to an empty copy and not kept, so
    /// an unreadable keychain never loses the sign-in.
    async fn with_saved<R>(&self, change: impl FnOnce(&mut Saved) -> R) -> R {
        let mut state = self.state.lock().await;
        if state.saved.is_none() {
            state.saved = self.load();
        }
        let Some(saved) = state.saved.as_mut() else {
            return change(&mut Saved::default());
        };
        let before = saved.clone();
        let result = change(saved);
        if *saved != before {
            let kept = if *saved == Saved::default() {
                self.vault.remove()
            } else {
                serde_json::to_vec(saved)
                    .map_err(|e| e.to_string())
                    .and_then(|bytes| self.vault.write(&bytes))
            };
            if let Err(e) = kept {
                eprintln!("kriyon: can't keep the relay sign-in in the keychain: {e}");
            }
        }
        result
    }

    async fn saved(&self) -> Saved {
        self.with_saved(|saved| saved.clone()).await
    }

    async fn set_problem(&self, problem: Option<RelayProblem>) {
        self.state.lock().await.problem = problem;
    }

    fn api(&self, token: Option<&str>) -> Result<RelayApi, String> {
        let setup = self.setup.as_ref().ok_or("This build has no relay")?;
        let api = RelayApi::new(&setup.api)?;
        Ok(match token {
            Some(token) => api.signed_in(token),
            None => api,
        })
    }

    /// The API, signed in.
    async fn signed_in_api(&self) -> Result<RelayApi, String> {
        let token = self.saved().await.token.ok_or("Sign in first")?;
        self.api(Some(&token))
    }

    /// Note a refusal: signed out forgets the token (the pass in hand still
    /// works until it expires); anything else is shown.
    async fn refused(&self, error: &ApiError) {
        match error {
            ApiError::Refused(ApiRefusal::SignedOut) => {
                self.with_saved(|saved| saved.token = None).await;
                self.set_problem(Some(RelayProblem::Api(ApiRefusal::SignedOut)))
                    .await;
            }
            ApiError::Refused(refusal) => {
                self.set_problem(Some(RelayProblem::Api(*refusal))).await;
            }
            // Keep the pass in hand: it has weeks left.
            ApiError::Unreachable(_) => {}
        }
    }

    /// Fetch this device's pass, registering it first when `register` or
    /// when the API doesn't know it, and keep it.
    async fn fetch_pass(&self, device: &ThisDevice, register: bool) -> Result<(), ApiError> {
        let api = self
            .signed_in_api()
            .await
            .map_err(|_| ApiError::Refused(ApiRefusal::SignedOut))?;
        let register_now = || api.register(&device.key_hex, &device.name, device.platform);
        let fetched = async {
            if register {
                register_now().await?;
            }
            match api.pass(&device.key_hex).await {
                Err(ApiError::Refused(ApiRefusal::DeviceUnknown)) if !register => {
                    register_now().await?;
                    api.pass(&device.key_hex).await
                }
                other => other,
            }
        }
        .await;
        match fetched {
            Ok(reply) => {
                self.with_saved(|saved| saved.pass = Some(reply)).await;
                self.set_problem(None).await;
                Ok(())
            }
            Err(error) => {
                self.refused(&error).await;
                Err(error)
            }
        }
    }

    /// Where things stand.
    pub async fn view(&self) -> RelayView {
        let saved = self.saved().await;
        let state = self.state.lock().await;
        RelayView {
            available: self.setup.is_some(),
            signed_in: saved.token.is_some(),
            on: saved.on,
            sign_in: state.sign_in.clone(),
            problem: state.problem.map(RelayProblem::message),
            pass_expires_at: saved.pass.and_then(|pass| parse_utc(&pass.expires_at)),
        }
    }

    /// Start a [Device sign-in]: the code to show and the page to open.
    ///
    /// # Errors
    /// Without a relay, or when the API refuses or can't be reached.
    pub async fn start_sign_in(&self) -> Result<SignInView, String> {
        let code = self
            .api(None)?
            .device_code()
            .await
            .map_err(|e| error_text(&e))?;
        let view = SignInView {
            user_code: code.user_code,
            verification_uri: code.verification_uri,
            verification_uri_complete: code.verification_uri_complete,
            device_code: code.device_code,
            interval_s: code.interval,
            expires_in_s: code.expires_in,
        };
        let mut state = self.state.lock().await;
        state.sign_in = Some(view.clone());
        state.problem = None;
        Ok(view)
    }

    /// Whether `device_code`'s sign-in is still the one in progress.
    async fn still_signing_in(&self, device_code: &str) -> bool {
        self.state
            .lock()
            .await
            .sign_in
            .as_ref()
            .is_some_and(|flow| flow.device_code == device_code)
    }

    /// End `device_code`'s sign-in, with `problem` when it failed.
    async fn end_sign_in(&self, device_code: &str, problem: Option<RelayProblem>) {
        let mut state = self.state.lock().await;
        if state
            .sign_in
            .as_ref()
            .is_some_and(|flow| flow.device_code == device_code)
        {
            state.sign_in = None;
            state.problem = problem;
        }
    }

    /// Ask until the sign-in `device_code` (from [`Self::start_sign_in`]) is
    /// approved, refused, runs out or is replaced; then, if the relay is on, fetch this device's pass.
    /// Returns whether it signed in.
    pub async fn wait_for_sign_in(&self, device: &ThisDevice, device_code: &str) -> bool {
        let flow = self.state.lock().await.sign_in.clone();
        let Some(flow) = flow.filter(|flow| flow.device_code == device_code) else {
            return false;
        };
        let Ok(api) = self.api(None) else {
            return false;
        };
        let code = flow.device_code.as_str();
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(flow.expires_in_s);
        let mut interval = flow.interval_s;
        loop {
            if std::time::Instant::now() >= deadline {
                self.end_sign_in(code, Some(RelayProblem::SignInExpired))
                    .await;
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
            if !self.still_signing_in(code).await {
                return false;
            }
            let problem = match api.poll(code).await {
                Ok(SignInPoll::Token(token)) => {
                    let on = self
                        .with_saved(|saved| {
                            saved.token = Some(token);
                            saved.on
                        })
                        .await;
                    self.end_sign_in(code, None).await;
                    if on {
                        // Its problem, if any, is shown; signed in either way.
                        let _ = self.fetch_pass(device, true).await;
                    }
                    return true;
                }
                Ok(SignInPoll::Pending) | Err(ApiError::Unreachable(_)) => continue,
                Ok(SignInPoll::SlowDown) => {
                    // RFC 8628 §3.5: five seconds more from now on.
                    interval += 5;
                    continue;
                }
                Ok(SignInPoll::Denied) => RelayProblem::SignInDenied,
                Ok(SignInPoll::Expired) => RelayProblem::SignInExpired,
                Err(ApiError::Refused(refusal)) => RelayProblem::Api(refusal),
            };
            self.end_sign_in(code, Some(problem)).await;
            return false;
        }
    }

    /// Stop the sign-in in progress.
    pub async fn cancel_sign_in(&self) {
        self.state.lock().await.sign_in = None;
    }

    /// Forget the sign-in and the pass; the relay goes off.
    ///
    /// # Errors
    /// Why the keychain couldn't be written.
    pub async fn sign_out(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;
        self.vault.remove()?;
        *state = State {
            saved: Some(Saved::default()),
            ..State::default()
        };
        Ok(())
    }

    /// Turn the relay on (register this device and fetch its pass) or off.
    /// Returns the relay to use now: `None` when off.
    ///
    /// # Errors
    /// Not signed in, or the API refused (in the contract's words).
    pub async fn set_on(
        &self,
        on: bool,
        device: &ThisDevice,
    ) -> Result<Option<RelayAccess>, String> {
        if !on {
            self.with_saved(|saved| saved.on = false).await;
            return Ok(None);
        }
        if self.saved().await.token.is_none() {
            return Err("Sign in first".into());
        }
        self.fetch_pass(device, true)
            .await
            .map_err(|e| error_text(&e))?;
        self.with_saved(|saved| saved.on = true).await;
        Ok(self.access().await.map(|(access, _)| access))
    }

    /// The relay to use and when its pass expires (Unix seconds): `None`
    /// while off or without a pass.
    pub async fn access(&self) -> Option<(RelayAccess, u64)> {
        let saved = self.saved().await;
        let pass = saved.pass.filter(|_| saved.on)?;
        let url = pass.relay_url.parse().ok()?;
        let expires = parse_utc(&pass.expires_at)?;
        Some((
            RelayAccess {
                url,
                pass: pass.pass,
            },
            expires,
        ))
    }

    /// Fetch a new pass when one is due (`force`: now, after the relay said
    /// the pass is out of date). Returns whether a new one came. Keeps the
    /// pass in hand when the API can't be reached.
    pub async fn renew(&self, now_s: u64, device: &ThisDevice, force: bool) -> bool {
        let saved = self.saved().await;
        if !saved.on || saved.token.is_none() {
            return false;
        }
        let renew_after = saved
            .pass
            .as_ref()
            .and_then(|pass| parse_utc(&pass.renew_after));
        if !force && !pass_due(now_s, renew_after) {
            return false;
        }
        self.fetch_pass(device, false).await.is_ok()
    }

    /// The relay account's subscription and devices.
    ///
    /// # Errors
    /// Not signed in, or the API refused or can't be reached.
    pub async fn account(&self) -> Result<RelayStatus, String> {
        let result = self.signed_in_api().await?.status().await;
        if let Err(error) = &result {
            self.refused(error).await;
        }
        result.map_err(|e| error_text(&e))
    }

    /// Remove a device from the relay account.
    ///
    /// # Errors
    /// Not signed in, or the API refused or can't be reached.
    pub async fn remove_device(&self, device_id: &str) -> Result<(), String> {
        let result = self.signed_in_api().await?.remove_device(device_id).await;
        if let Err(error) = &result {
            self.refused(error).await;
        }
        result.map_err(|e| error_text(&e))
    }

    /// The relay refused this device: remember why. Returns whether a new
    /// pass would help.
    pub async fn relay_refused(&self, action: RelayAction) -> bool {
        // Signed out, no new pass can come: say what would bring one.
        if self.saved().await.token.is_none() {
            self.set_problem(Some(RelayProblem::Api(ApiRefusal::SignedOut)))
                .await;
            return false;
        }
        self.set_problem(Some(RelayProblem::Relay(action))).await;
        action == RelayAction::Renew
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as StdMutex};

    use super::*;
    use crate::relay_api::test_api::{fake_api, run, TEST_PASS};

    /// A keychain item in memory, shared so a second runtime sees it. It
    /// counts writes and removals, and can be made unreadable (locked).
    #[derive(Clone, Default)]
    struct Memory {
        item: Arc<StdMutex<Option<Vec<u8>>>>,
        changes: Arc<StdMutex<usize>>,
        locked: Arc<std::sync::atomic::AtomicBool>,
    }

    impl Memory {
        fn changes(&self) -> usize {
            *self.changes.lock().expect("changes")
        }
    }

    impl SecretVault for Memory {
        fn read(&self) -> Result<Option<Vec<u8>>, String> {
            if self.locked.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("the keychain is locked".into());
            }
            Ok(self.item.lock().expect("vault").clone())
        }
        fn write(&self, secret: &[u8]) -> Result<(), String> {
            *self.changes.lock().expect("changes") += 1;
            *self.item.lock().expect("vault") = Some(secret.to_vec());
            Ok(())
        }
        fn remove(&self) -> Result<(), String> {
            *self.changes.lock().expect("changes") += 1;
            *self.item.lock().expect("vault") = None;
            Ok(())
        }
    }

    fn device() -> ThisDevice {
        ThisDevice {
            key_hex: "a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0".into(),
            name: "Mac".into(),
            platform: "macos",
        }
    }

    fn setup(api: &str) -> RelaySetup {
        RelaySetup {
            api: api.into(),
            web: "https://web.example.test/".into(),
        }
    }

    fn pass_reply(renew_after: &str) -> String {
        format!(
            r#"{{"data":{{"pass":"{TEST_PASS}","expiresAt":"2026-12-14T00:00:00.000Z","renewAfter":"{renew_after}","relayUrl":"https://relay.example.test/"}},"meta":{{}}}}"#
        )
    }

    const DEVICE_REPLY: &str =
        r#"{"data":{"deviceId":"d1","deviceKey":"k","name":"Mac","platform":"macos"},"meta":{}}"#;

    /// Unix seconds of 2026-11-15T00:00:00Z.
    const NOV_15: u64 = 1_794_700_800;

    /// A runtime already signed in (token `tok`), on or off.
    fn signed_in(api: &str, vault: &Memory, on: bool) -> RelayRuntime {
        let saved = Saved {
            token: Some("tok".into()),
            on,
            pass: None,
        };
        vault
            .write(&serde_json::to_vec(&saved).expect("json"))
            .expect("write");
        RelayRuntime::new(Some(setup(api)), Box::new(vault.clone()))
    }

    #[test]
    fn the_relay_exists_only_when_both_addresses_were_built_in() {
        assert_eq!(RelaySetup::from_values(None, None), None);
        assert_eq!(
            RelaySetup::from_values(Some("https://api.test"), None),
            None
        );
        assert_eq!(
            RelaySetup::from_values(Some(" "), Some("https://web.test")),
            None
        );
        let setup = RelaySetup::from_values(Some("https://api.test"), Some("https://web.test/"))
            .expect("both");
        assert_eq!(setup.subscriptions_url(), "https://web.test/subscriptions");
        run(async {
            let none = RelayRuntime::new(None, Box::new(Memory::default()));
            assert!(!none.view().await.available);
            assert!(none.start_sign_in().await.is_err());
        });
    }

    #[test]
    fn signing_in_keeps_the_token_and_fetches_a_pass_when_the_relay_is_on() {
        let polls = Arc::new(StdMutex::new(0));
        let counted = Arc::clone(&polls);
        let (base, seen) = fake_api(move |line, _| {
            match line {
            "POST /api/v1/admin/auth/device/code" => (
                200,
                r#"{"device_code":"dc","user_code":"ABCD1234","verification_uri":"https://web.example.test/device","verification_uri_complete":"https://web.example.test/device?code=ABCD1234","expires_in":600,"interval":0}"#.into(),
            ),
            "POST /api/v1/admin/auth/device/token" => {
                let mut n = counted.lock().expect("n");
                *n += 1;
                if *n < 3 {
                    (400, r#"{"error":"authorization_pending"}"#.into())
                } else {
                    (200, r#"{"access_token":"tok"}"#.into())
                }
            }
            "POST /api/v1/kriyon-relay/devices" => (200, DEVICE_REPLY.into()),
            "POST /api/v1/kriyon-relay/passes" => (200, pass_reply("2026-11-15T00:00:00.000Z")),
            _ => (404, "{}".into()),
        }
        });
        let vault = Memory::default();
        // The relay was turned on before, then the sign-in lapsed.
        vault
            .write(br#"{"token":null,"on":true,"pass":null}"#)
            .expect("write");
        let relay = RelayRuntime::new(Some(setup(&base)), Box::new(vault.clone()));
        run(async {
            let view = relay.start_sign_in().await.expect("started");
            assert_eq!(view.user_code, "ABCD1234");
            assert_eq!(
                relay.view().await.sign_in.expect("shown").user_code,
                "ABCD1234"
            );
            assert!(relay.wait_for_sign_in(&device(), view.device_code()).await);
            let view = relay.view().await;
            assert!(view.signed_in && view.on && view.sign_in.is_none());
            let (access, expires) = relay.access().await.expect("a pass");
            assert_eq!(access.pass, TEST_PASS);
            assert_eq!(access.url.to_string(), "https://relay.example.test/");
            assert_eq!(expires, 1_797_206_400);
        });
        // Kept: a new runtime on the same keychain item has it all.
        let again = RelayRuntime::new(Some(setup(&base)), Box::new(vault));
        run(async {
            assert_eq!(again.access().await.expect("kept").0.pass, TEST_PASS);
        });
        let seen = seen.lock().expect("seen").clone();
        let register = seen
            .iter()
            .find(|s| s.line == "POST /api/v1/kriyon-relay/devices")
            .expect("registered");
        assert_eq!(register.authorization.as_deref(), Some("Bearer tok"));
    }

    #[test]
    fn a_refused_sign_in_says_so() {
        let (base, _) = fake_api(|line, _| {
            match line {
            "POST /api/v1/admin/auth/device/code" => (
                200,
                r#"{"device_code":"dc","user_code":"X","verification_uri":"u","verification_uri_complete":"u","expires_in":600,"interval":0}"#.into(),
            ),
            _ => (400, r#"{"error":"access_denied"}"#.into()),
        }
        });
        let relay = RelayRuntime::new(Some(setup(&base)), Box::new(Memory::default()));
        run(async {
            let view = relay.start_sign_in().await.expect("started");
            assert!(!relay.wait_for_sign_in(&device(), view.device_code()).await);
            let view = relay.view().await;
            assert!(!view.signed_in);
            assert_eq!(
                view.problem.as_deref(),
                Some(RelayProblem::SignInDenied.message().as_str())
            );
        });
    }

    #[test]
    fn turning_the_relay_on_needs_a_sign_in_and_a_subscription() {
        let (base, _) = fake_api(|line, _| match line {
            "POST /api/v1/kriyon-relay/devices" => (200, DEVICE_REPLY.into()),
            "POST /api/v1/kriyon-relay/passes" => (
                402,
                r#"{"error":{"code":"RELAY_NO_SUBSCRIPTION","message":"x","details":null}}"#.into(),
            ),
            _ => (404, "{}".into()),
        });
        run(async {
            let signed_out = RelayRuntime::new(Some(setup(&base)), Box::new(Memory::default()));
            assert_eq!(
                signed_out.set_on(true, &device()).await,
                Err("Sign in first".to_string())
            );
            let relay = signed_in(&base, &Memory::default(), false);
            assert_eq!(
                relay.set_on(true, &device()).await,
                Err("Our relay needs a subscription".to_string())
            );
            assert!(!relay.view().await.on, "stays off");
            assert_eq!(relay.set_on(false, &device()).await, Ok(None));
        });
    }

    #[test]
    fn a_pass_is_renewed_once_due_and_kept_when_the_api_is_down() {
        let (base, seen) = fake_api(|line, _| match line {
            "POST /api/v1/kriyon-relay/devices" => (200, DEVICE_REPLY.into()),
            "POST /api/v1/kriyon-relay/passes" => (200, pass_reply("2026-11-15T00:00:00.000Z")),
            _ => (404, "{}".into()),
        });
        let relay = signed_in(&base, &Memory::default(), false);
        run(async {
            relay.set_on(true, &device()).await.expect("on");
            let calls = seen.lock().expect("seen").len();
            assert!(!relay.renew(NOV_15 - 1, &device(), false).await, "not due");
            assert_eq!(seen.lock().expect("seen").len(), calls);
            assert!(relay.renew(NOV_15, &device(), false).await, "due");
            assert!(relay.renew(NOV_15 - 1, &device(), true).await, "forced");
        });
        // The API goes away: the pass in hand stays.
        let gone = signed_in("http://127.0.0.1:1", &Memory::default(), true);
        run(async {
            assert!(!gone.renew(NOV_15, &device(), false).await);
            assert!(
                gone.view().await.problem.is_none(),
                "not the person's problem"
            );
        });
    }

    #[test]
    fn an_unknown_device_is_registered_and_asked_again() {
        let passes = Arc::new(StdMutex::new(0));
        let counted = Arc::clone(&passes);
        let (base, seen) = fake_api(move |line, _| match line {
            "POST /api/v1/kriyon-relay/devices" => (200, DEVICE_REPLY.into()),
            "POST /api/v1/kriyon-relay/passes" => {
                let mut n = counted.lock().expect("n");
                *n += 1;
                if *n == 1 {
                    (
                        404,
                        r#"{"error":{"code":"RELAY_DEVICE_UNKNOWN","message":"x","details":null}}"#
                            .into(),
                    )
                } else {
                    (200, pass_reply("2026-11-15T00:00:00.000Z"))
                }
            }
            _ => (404, "{}".into()),
        });
        let vault = Memory::default();
        vault
            .write(
                &serde_json::to_vec(&Saved {
                    token: Some("tok".into()),
                    on: true,
                    pass: None,
                })
                .expect("json"),
            )
            .expect("write");
        let relay = RelayRuntime::new(Some(setup(&base)), Box::new(vault));
        run(async {
            assert!(relay.renew(NOV_15, &device(), false).await);
        });
        let lines: Vec<String> = seen
            .lock()
            .expect("seen")
            .iter()
            .map(|s| s.line.clone())
            .collect();
        assert_eq!(
            lines,
            [
                "POST /api/v1/kriyon-relay/passes",
                "POST /api/v1/kriyon-relay/devices",
                "POST /api/v1/kriyon-relay/passes"
            ]
        );
    }

    #[test]
    fn a_signed_out_renewal_asks_to_sign_in_and_keeps_the_pass() {
        let (base, _) = fake_api(|line, _| match line {
            "POST /api/v1/kriyon-relay/devices" => (200, DEVICE_REPLY.into()),
            "POST /api/v1/kriyon-relay/passes" => (401, "{}".into()),
            _ => (404, "{}".into()),
        });
        let vault = Memory::default();
        let saved = Saved {
            token: Some("tok".into()),
            on: true,
            pass: Some(PassReply {
                pass: TEST_PASS.into(),
                expires_at: "2026-12-14T00:00:00.000Z".into(),
                renew_after: "2026-11-15T00:00:00.000Z".into(),
                relay_url: "https://relay.example.test/".into(),
            }),
        };
        vault
            .write(&serde_json::to_vec(&saved).expect("json"))
            .expect("write");
        let relay = RelayRuntime::new(Some(setup(&base)), Box::new(vault));
        run(async {
            assert!(!relay.renew(NOV_15, &device(), false).await);
            let view = relay.view().await;
            assert!(!view.signed_in);
            assert_eq!(view.problem.as_deref(), Some("Sign in again"));
            assert!(relay.access().await.is_some(), "the pass still works");
        });
    }

    #[test]
    fn the_relays_refusals_are_remembered_and_say_whether_to_renew() {
        let relay = signed_in("http://127.0.0.1:1", &Memory::default(), true);
        run(async {
            assert!(relay.relay_refused(RelayAction::Renew).await);
            assert!(!relay.relay_refused(RelayAction::Removed).await);
            assert_eq!(
                relay.view().await.problem.as_deref(),
                Some("This device was removed from your relay account")
            );
            assert!(!relay.relay_refused(RelayAction::Report).await);
        });
    }

    #[test]
    fn signing_out_forgets_everything() {
        let vault = Memory::default();
        let relay = signed_in("http://127.0.0.1:1", &vault, true);
        run(async {
            relay.sign_out().await.expect("out");
            let view = relay.view().await;
            assert!(!view.signed_in && !view.on);
        });
        assert_eq!(vault.read().expect("read"), None);
    }

    #[test]
    fn a_locked_keychain_never_loses_the_sign_in() {
        let vault = Memory::default();
        let relay = signed_in("http://127.0.0.1:1", &vault, true);
        vault
            .locked
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let before = vault.changes();
        run(async {
            assert!(!relay.view().await.signed_in, "unread: looks signed out");
            assert!(relay.access().await.is_none());
            assert!(!relay.renew(NOV_15, &device(), false).await);
        });
        assert_eq!(vault.changes(), before, "nothing written or removed");
        vault
            .locked
            .store(false, std::sync::atomic::Ordering::Relaxed);
        run(async {
            assert!(relay.view().await.signed_in, "read again once unlocked");
        });
    }

    #[test]
    fn reading_the_relay_writes_nothing() {
        let vault = Memory::default();
        let relay = signed_in("http://127.0.0.1:1", &vault, true);
        let before = vault.changes();
        run(async {
            relay.view().await;
            relay.access().await;
            relay.renew(NOV_15 - 1, &device(), false).await;
        });
        assert_eq!(vault.changes(), before);
    }

    #[test]
    fn signed_out_the_relays_refusal_asks_to_sign_in_again() {
        let relay = RelayRuntime::new(
            Some(setup("http://127.0.0.1:1")),
            Box::new(Memory::default()),
        );
        run(async {
            assert!(
                !relay.relay_refused(RelayAction::Renew).await,
                "no token to renew with"
            );
            assert_eq!(relay.view().await.problem.as_deref(), Some("Sign in again"));
        });
    }

    #[test]
    fn a_waiter_only_follows_its_own_sign_in() {
        let (base, _) = fake_api(|line, _| {
            match line {
            "POST /api/v1/admin/auth/device/code" => (
                200,
                r#"{"device_code":"dc","user_code":"X","verification_uri":"u","verification_uri_complete":"u","expires_in":600,"interval":0}"#.into(),
            ),
            _ => (200, r#"{"access_token":"tok"}"#.into()),
        }
        });
        let relay = RelayRuntime::new(Some(setup(&base)), Box::new(Memory::default()));
        run(async {
            relay.start_sign_in().await.expect("started");
            assert!(!relay.wait_for_sign_in(&device(), "an-older-code").await);
            assert!(!relay.view().await.signed_in);
        });
    }
}
