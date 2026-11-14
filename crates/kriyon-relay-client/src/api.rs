//! The `BisBig` API calls our relay needs (the [Relay pass] contract,
//! `docs/superpowers/specs/2026-11-13-relay-pass-contract.md`): [Device
//! sign-in], registering this device, fetching its pass, the account's
//! status, removing a device. The API's address comes from build-time
//! configuration, never the source. The pass is opaque: carried, never read.

use kriyon_remote::relay::{ApiRefusal, SignInPoll};
use serde::{Deserialize, Serialize};

/// The desktop app's client id for device sign-in.
pub const DESKTOP_CLIENT_ID: &str = "kriyon-desktop";
/// The phone app's client id for device sign-in.
pub const MOBILE_CLIENT_ID: &str = "kriyon-mobile";
/// Where the device-code sign-in lives, under the API base.
const AUTH: &str = "/api/v1/admin/auth";
/// Where the relay's calls live, under the API base.
const RELAY: &str = "/api/v1/kriyon-relay";

/// Why a call didn't give its answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApiError {
    /// The API answered with a refusal the contract names.
    Refused(ApiRefusal),
    /// The API couldn't be reached, or answered something unreadable: keep
    /// the pass in hand.
    Unreachable(String),
}

/// The start of a [Device sign-in].
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// A pass and when to use and renew it.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PassReply {
    /// Opaque: stored and sent as it is.
    pub pass: String,
    pub expires_at: String,
    pub renew_after: String,
    pub relay_url: String,
}

/// The pass is a credential: a debug print shows the rest, never the pass.
impl std::fmt::Debug for PassReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PassReply")
            .field("pass", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("renew_after", &self.renew_after)
            .field("relay_url", &self.relay_url)
            .finish()
    }
}

/// A device registered on the relay account.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayDevice {
    pub device_id: String,
    pub device_key: String,
    pub name: String,
    pub platform: String,
    #[serde(default)]
    pub last_pass_at: Option<String>,
}

/// The relay account's subscription.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    /// `pending | active | past_due | canceled | expired`.
    pub state: String,
    pub plan: String,
    /// None while a subscription is pending (not paid yet).
    #[serde(default)]
    pub paid_until: Option<String>,
}

/// `GET /status`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub subscription: Option<Subscription>,
    pub devices: Vec<RelayDevice>,
    pub device_limit: u32,
    pub blocked: bool,
}

/// The `BisBig` API, signed in or not.
pub struct RelayApi {
    base: String,
    client_id: &'static str,
    token: Option<String>,
    http: reqwest::Client,
}

/// A success in the API's envelope.
#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

/// An error in the API's envelope.
#[derive(Deserialize)]
struct ErrorBody {
    error: ErrorCode,
}

#[derive(Deserialize)]
struct ErrorCode {
    code: String,
}

/// A device-code token reply: the token, or an OAuth error.
#[derive(Deserialize)]
struct TokenReply {
    access_token: Option<String>,
    error: Option<String>,
}

fn unreachable(e: impl std::fmt::Display) -> ApiError {
    ApiError::Unreachable(e.to_string())
}

impl RelayApi {
    /// The API at `base` (from build-time configuration), signing in as
    /// `client_id` ([`DESKTOP_CLIENT_ID`] or [`MOBILE_CLIENT_ID`]).
    ///
    /// # Errors
    /// When the HTTP client can't be made.
    pub fn new(base: &str, client_id: &'static str) -> Result<Self, String> {
        // reqwest's rustls has no crypto provider of its own; ring is the
        // one already in the app (iroh's). Installed once; a second install
        // is refused, which is fine.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            client_id,
            token: None,
            http,
        })
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let request = self.http.request(method, format!("{}{path}", self.base));
        match &self.token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }

    /// Send `request` and read its data from the API's envelope; a refusal
    /// reads as the contract's.
    async fn call<T: for<'de> Deserialize<'de>>(
        request: reqwest::RequestBuilder,
    ) -> Result<T, ApiError> {
        let reply = request.send().await.map_err(unreachable)?;
        let status = reply.status();
        let bytes = reply.bytes().await.map_err(unreachable)?;
        if status.is_success() {
            // A success with no body (204): there is no data to read.
            if bytes.is_empty() {
                return serde_json::from_slice::<T>(b"null").map_err(unreachable);
            }
            return serde_json::from_slice::<Envelope<T>>(&bytes)
                .map(|envelope| envelope.data)
                .map_err(unreachable);
        }
        let code = serde_json::from_slice::<ErrorBody>(&bytes)
            .ok()
            .map(|body| body.error.code);
        Err(ApiError::Refused(ApiRefusal::from_reply(
            status.as_u16(),
            code.as_deref(),
        )))
    }

    /// Calls made with the [Device sign-in]'s access token.
    #[must_use]
    pub fn signed_in(mut self, token: &str) -> Self {
        self.token = Some(token.to_string());
        self
    }

    /// Start a [Device sign-in].
    ///
    /// # Errors
    /// [`ApiError`].
    pub async fn device_code(&self) -> Result<DeviceCode, ApiError> {
        // OAuth's own replies, not the API's envelope.
        let reply = self
            .request(reqwest::Method::POST, &format!("{AUTH}/device/code"))
            .json(&serde_json::json!({ "client_id": self.client_id }))
            .send()
            .await
            .map_err(unreachable)?;
        if !reply.status().is_success() {
            return Err(ApiError::Refused(ApiRefusal::from_reply(
                reply.status().as_u16(),
                None,
            )));
        }
        reply.json().await.map_err(unreachable)
    }

    /// Ask once whether the sign-in for `device_code` was approved.
    ///
    /// # Errors
    /// [`ApiError`].
    pub async fn poll(&self, device_code: &str) -> Result<SignInPoll, ApiError> {
        let reply = self
            .request(reqwest::Method::POST, &format!("{AUTH}/device/token"))
            .json(&serde_json::json!({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": self.client_id,
            }))
            .send()
            .await
            .map_err(unreachable)?;
        // Waiting, slowing down and refusals come as OAuth errors (400).
        let token: TokenReply = reply.json().await.map_err(unreachable)?;
        Ok(SignInPoll::from_reply(
            token.access_token.as_deref(),
            token.error.as_deref(),
        ))
    }

    /// Register this device (`device_key`: its endpoint id, hex). Safe to
    /// repeat.
    ///
    /// # Errors
    /// [`ApiError`].
    pub async fn register(
        &self,
        device_key: &str,
        name: &str,
        platform: &str,
    ) -> Result<RelayDevice, ApiError> {
        Self::call(
            self.request(reqwest::Method::POST, &format!("{RELAY}/devices"))
                .json(&serde_json::json!({
                    "deviceKey": device_key,
                    "name": name,
                    "platform": platform,
                })),
        )
        .await
    }

    /// This device's pass.
    ///
    /// # Errors
    /// [`ApiError`].
    pub async fn pass(&self, device_key: &str) -> Result<PassReply, ApiError> {
        Self::call(
            self.request(reqwest::Method::POST, &format!("{RELAY}/passes"))
                .json(&serde_json::json!({ "deviceKey": device_key })),
        )
        .await
    }

    /// The relay account's status.
    ///
    /// # Errors
    /// [`ApiError`].
    pub async fn status(&self) -> Result<RelayStatus, ApiError> {
        Self::call(self.request(reqwest::Method::GET, &format!("{RELAY}/status"))).await
    }

    /// Remove a device from the relay account.
    ///
    /// # Errors
    /// [`ApiError`].
    pub async fn remove_device(&self, device_id: &str) -> Result<(), ApiError> {
        // It goes into the path: only an id's letters (a uuid's), never
        // anything that could make it another path.
        let is_id = !device_id.is_empty()
            && device_id.len() <= 64
            && device_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !is_id {
            return Err(ApiError::Refused(ApiRefusal::Invalid));
        }
        Self::call::<serde_json::Value>(self.request(
            reqwest::Method::DELETE,
            &format!("{RELAY}/devices/{device_id}"),
        ))
        .await
        .map(|_| ())
    }
}

/// A fake API on localhost for tests (no real network); other crates' tests
/// reach it through the `test-support` feature.
#[cfg(any(test, feature = "test-support"))]
pub mod test_api {
    use std::io::{BufRead as _, BufReader, Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// The valid pass of the contract's test vectors (fixed test keys).
    pub const TEST_PASS: &str = "kp1.AQ8eLTxLWml4h5altMPS4fCgmqX0emdZgC_5VfjcLSoUpcmdI76X-GQSf_k4NFWk8AAAAABq96SAAAAAAGsfMYA.vg7dZ8vaIGxbWpMVoOvTHz28Lbk9B9LnD9v15n4spiy5_rxih0c_gDHWoz9M5OnDnn3vuuPcF_qIBrPzSEvMDA";

    /// One request the fake API saw.
    #[derive(Clone, Debug)]
    pub struct Seen {
        pub line: String,
        pub authorization: Option<String>,
        pub body: String,
    }

    /// A fake API on localhost: `answer` gives the status and body for each
    /// request line (`POST /path`). Returns its base address and what it saw.
    ///
    /// # Panics
    /// When the fake can't bind localhost: a broken test machine.
    pub fn fake_api(
        answer: impl Fn(&str, &str) -> (u16, String) + Send + 'static,
    ) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let line = line
                    .trim()
                    .rsplit_once(' ')
                    .map_or(String::new(), |(l, _)| l.to_string());
                let (mut length, mut authorization) = (0, None);
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                        break;
                    }
                    let (name, value) = header.split_once(':').unwrap_or(("", ""));
                    match name.to_ascii_lowercase().as_str() {
                        "content-length" => length = value.trim().parse().unwrap_or(0),
                        "authorization" => authorization = Some(value.trim().to_string()),
                        _ => {}
                    }
                }
                let mut body = vec![0; length];
                let _ = reader.read_exact(&mut body);
                let body = String::from_utf8_lossy(&body).into_owned();
                let (status, reply) = answer(&line, &body);
                log.lock().expect("log").push(Seen {
                    line,
                    authorization,
                    body,
                });
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
            }
        });
        (base, seen)
    }

    /// Run `f` to its end on a runtime of its own.
    ///
    /// # Panics
    /// When the runtime can't be made.
    pub fn run<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::test_api::{fake_api, run, TEST_PASS};
    use super::*;

    const KEY: &str = "a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0";

    #[test]
    fn device_sign_in_starts_and_polls_until_approved() {
        let polls = Arc::new(Mutex::new(0));
        let counted = Arc::clone(&polls);
        let (base, seen) = fake_api(move |line, _| {
            match line {
            "POST /api/v1/admin/auth/device/code" => (
                200,
                r#"{"device_code":"dc","user_code":"ABCD1234","verification_uri":"https://example.test/device","verification_uri_complete":"https://example.test/device?code=ABCD1234","expires_in":600,"interval":5}"#.into(),
            ),
            "POST /api/v1/admin/auth/device/token" => {
                let mut n = counted.lock().expect("n");
                *n += 1;
                match *n {
                    1 => (400, r#"{"error":"authorization_pending"}"#.into()),
                    2 => (400, r#"{"error":"slow_down"}"#.into()),
                    _ => (200, r#"{"access_token":"tok","token_type":"Bearer"}"#.into()),
                }
            }
            _ => (404, "{}".into()),
        }
        });
        run(async {
            let api = RelayApi::new(&base, DESKTOP_CLIENT_ID).expect("api");
            let code = api.device_code().await.expect("code");
            assert_eq!(code.user_code, "ABCD1234");
            assert_eq!(code.interval, 5);
            assert_eq!(api.poll("dc").await, Ok(SignInPoll::Pending));
            assert_eq!(api.poll("dc").await, Ok(SignInPoll::SlowDown));
            assert_eq!(api.poll("dc").await, Ok(SignInPoll::Token("tok".into())));
        });
        let seen = seen.lock().expect("seen").clone();
        assert!(
            seen[0].body.contains(r#""client_id":"kriyon-desktop""#),
            "{:?}",
            seen[0]
        );
        assert!(seen[1]
            .body
            .contains("urn:ietf:params:oauth:grant-type:device_code"));
        assert!(seen[1].body.contains(r#""device_code":"dc""#));
    }

    #[test]
    fn the_pass_comes_back_exactly_as_the_api_sent_it() {
        let reply = format!(
            r#"{{"data":{{"pass":"{TEST_PASS}","expiresAt":"2026-12-14T00:00:00.000Z","renewAfter":"2026-11-15T00:00:00.000Z","relayUrl":"https://relay.example.test/"}},"meta":{{}}}}"#
        );
        let (base, seen) = fake_api(move |line, _| match line {
            "POST /api/v1/kriyon-relay/passes" => (200, reply.clone()),
            _ => (404, "{}".into()),
        });
        let got = run(async {
            RelayApi::new(&base, DESKTOP_CLIENT_ID)
                .expect("api")
                .signed_in("tok")
                .pass(KEY)
                .await
        })
        .expect("pass");
        assert_eq!(got.pass, TEST_PASS, "carried untouched");
        assert_eq!(got.renew_after, "2026-11-15T00:00:00.000Z");
        let seen = seen.lock().expect("seen").clone();
        assert_eq!(seen[0].authorization.as_deref(), Some("Bearer tok"));
        assert!(seen[0].body.contains(&format!(r#""deviceKey":"{KEY}""#)));
    }

    #[test]
    fn a_refusal_reads_as_the_contracts_refusal() {
        let (base, _) = fake_api(|line, _| match line {
            "POST /api/v1/kriyon-relay/passes" => (
                402,
                r#"{"error":{"code":"RELAY_NO_SUBSCRIPTION","message":"x","details":null}}"#.into(),
            ),
            "GET /api/v1/kriyon-relay/status" => (401, "{}".into()),
            _ => (404, "{}".into()),
        });
        run(async {
            let api = RelayApi::new(&base, DESKTOP_CLIENT_ID)
                .expect("api")
                .signed_in("tok");
            assert_eq!(
                api.pass(KEY).await,
                Err(ApiError::Refused(ApiRefusal::NoSubscription))
            );
            assert_eq!(
                api.status().await,
                Err(ApiError::Refused(ApiRefusal::SignedOut))
            );
        });
    }

    #[test]
    fn status_registration_and_removal_speak_the_envelope() {
        let (base, seen) = fake_api(|line, _| {
            match line {
            "GET /api/v1/kriyon-relay/status" => (
                200,
                r#"{"data":{"subscription":{"state":"active","plan":"monthly","paidUntil":"2026-12-13T00:00:00.000Z"},"devices":[{"deviceId":"d1","deviceKey":"k","name":"Mac","platform":"macos","lastPassAt":null}],"deviceLimit":10,"blocked":false},"meta":{}}"#.into(),
            ),
            "POST /api/v1/kriyon-relay/devices" => (
                200,
                r#"{"data":{"deviceId":"d1","deviceKey":"k","name":"Mac","platform":"macos"},"meta":{}}"#.into(),
            ),
            "DELETE /api/v1/kriyon-relay/devices/d1" => (200, r#"{"data":null,"meta":{}}"#.into()),
            _ => (404, "{}".into()),
        }
        });
        run(async {
            let api = RelayApi::new(&base, DESKTOP_CLIENT_ID)
                .expect("api")
                .signed_in("tok");
            let status = api.status().await.expect("status");
            assert_eq!(status.subscription.expect("subscribed").state, "active");
            assert_eq!(status.devices[0].device_id, "d1");
            assert_eq!(
                api.register(KEY, "Mac", "macos")
                    .await
                    .expect("registered")
                    .device_id,
                "d1"
            );
            api.remove_device("d1").await.expect("removed");
        });
        let seen = seen.lock().expect("seen").clone();
        assert!(seen[1].body.contains(r#""platform":"macos""#));
        assert_eq!(seen[2].line, "DELETE /api/v1/kriyon-relay/devices/d1");
    }

    #[test]
    fn a_device_id_that_is_not_an_id_never_reaches_the_api() {
        let (base, seen) = fake_api(|_, _| (200, r#"{"data":null,"meta":{}}"#.into()));
        let api = RelayApi::new(&base, DESKTOP_CLIENT_ID)
            .expect("api")
            .signed_in("tok");
        for bad in ["", "../status", "d1/x", "d1?x=1", "d 1", "%2e%2e"] {
            assert_eq!(
                run(api.remove_device(bad)),
                Err(ApiError::Refused(ApiRefusal::Invalid)),
                "{bad:?}"
            );
        }
        assert!(seen.lock().expect("seen").is_empty());
    }

    #[test]
    fn an_api_that_is_not_there_is_unreachable_not_a_refusal() {
        let api = RelayApi::new("http://127.0.0.1:1", DESKTOP_CLIENT_ID).expect("api");
        assert!(matches!(run(api.status()), Err(ApiError::Unreachable(_))));
    }

    /// Found against `BisBig`'s real API: removing a device answers 204 with
    /// no body, which read as "unreachable".
    #[test]
    fn removing_a_device_accepts_an_empty_204() {
        let (base, _) = fake_api(|_, _| (204, String::new()));
        run(async {
            let api = RelayApi::new(&base, DESKTOP_CLIENT_ID)
                .expect("api")
                .signed_in("tok");
            assert_eq!(
                api.remove_device("2b1c7a4e-0000-4000-8000-000000000001")
                    .await,
                Ok(())
            );
        });
    }

    /// Found against `BisBig`'s real API: a pending subscription has no
    /// paid-until date yet, which made the whole status unreadable.
    #[test]
    fn a_pending_subscription_without_a_paid_until_date_reads() {
        let (base, _) = fake_api(|_, _| {
            (
                200,
                r#"{"data":{"subscription":{"state":"pending","plan":"monthly","paidUntil":null},"devices":[],"deviceLimit":10,"blocked":false},"meta":{}}"#.into(),
            )
        });
        run(async {
            let api = RelayApi::new(&base, DESKTOP_CLIENT_ID)
                .expect("api")
                .signed_in("tok");
            let status = api.status().await.expect("status reads");
            let sub = status.subscription.expect("a subscription");
            assert_eq!(sub.state, "pending");
            assert_eq!(sub.paid_until, None);
        });
    }
}
