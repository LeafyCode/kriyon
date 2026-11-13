//! Waking paired phones (spec §10): when a session newly needs you and no
//! device is connected to see it, the host asks the push sender to show "A
//! session needs you" on each paired phone that gave it a sealed token,
//! signing each request with this computer's [Device key].
//!
//! Push is on only when the app was built with `KRIYON_PUSH_URL`, and only
//! while [Remote access] is on. The rule for when to wake is
//! [`WakePlanner`]; this is the glue and the HTTP call.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use kriyon_remote::message::hex;
use kriyon_remote::push::{sign_wake, WakePlanner, WakeRequest};
use parking_lot::Mutex;
use tauri::Manager as _;

/// The push sender's address, from the build (`KRIYON_PUSH_URL`); push is
/// off without it.
#[must_use]
pub fn push_url() -> Option<&'static str> {
    option_env!("KRIYON_PUSH_URL").filter(|url| !url.trim().is_empty())
}

/// How long one request to the sender may take: wakes go out together, and
/// the next look waits for them.
const SENDER_TIMEOUT: Duration = Duration::from_secs(5);

/// Talks to one push sender.
pub struct PushSender {
    base: String,
    http: reqwest::Client,
}

impl PushSender {
    /// The sender at `base`.
    ///
    /// # Errors
    /// When the HTTP client can't be made.
    pub fn new(base: &str) -> Result<Self, String> {
        // reqwest's rustls has no crypto provider of its own; ring is the
        // one already in the app. A second install is refused, which is fine.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .timeout(SENDER_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            http,
        })
    }

    /// Ask the sender to wake the phone whose token is `sealed` to the
    /// sender's key `key_id` (the phone said which), signed with
    /// `host_secret` at `now` (Unix seconds). Returns the sender's HTTP
    /// status (202: sent).
    ///
    /// # Errors
    /// When the sender can't be reached.
    pub async fn wake(
        &self,
        host_secret: &[u8; 32],
        key_id: u32,
        sealed: &[u8],
        now: u64,
    ) -> Result<u16, String> {
        let request_id = uuid::Uuid::new_v4().into_bytes();
        let host_id = iroh::SecretKey::from_bytes(host_secret).public();
        let request = WakeRequest {
            key_id,
            sealed: hex(sealed),
            at: now,
            request_id: hex(&request_id),
            host_id: hex(host_id.as_bytes()),
            signature: hex(&sign_wake(host_secret, key_id, sealed, now, &request_id)),
        };
        self.http
            .post(format!("{}/v1/wake", self.base))
            .json(&request)
            .send()
            .await
            .map(|response| response.status().as_u16())
            .map_err(|_| "the push sender didn't answer".to_string())
    }
}

/// The app's push state: the planner, the sender if push is built in, and
/// the [Device key] once read.
pub struct PushRt {
    planner: Mutex<WakePlanner>,
    sender: Option<Arc<PushSender>>,
    host_secret: Mutex<Option<[u8; 32]>>,
    busy: Arc<AtomicBool>,
}

impl PushRt {
    /// Push to the build's sender, or off.
    #[must_use]
    pub fn from_build() -> Self {
        Self {
            planner: Mutex::new(WakePlanner::default()),
            sender: push_url()
                .and_then(|url| PushSender::new(url).ok())
                .map(Arc::new),
            host_secret: Mutex::new(None),
            busy: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Clears `busy` however the look ends, a panic included.
struct Busy(Arc<AtomicBool>);

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// One look, from the main loop's tick: wake the phones a session that
/// newly needs you calls for. Never waits; the sending happens on its own
/// task, one look at a time.
pub fn tick(app: &tauri::AppHandle) {
    let Some(rt) = app.try_state::<PushRt>() else {
        return;
    };
    let Some(sender) = rt.sender.clone() else {
        return;
    };
    if rt.busy.swap(true, Ordering::AcqRel) {
        return;
    }
    let busy = Busy(Arc::clone(&rt.busy));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _busy = busy;
        look(&app, &sender).await;
    });
}

async fn look(app: &tauri::AppHandle, sender: &Arc<PushSender>) {
    let rt = app.state::<PushRt>();
    // Never while Remote access is off: start over when it comes back.
    if !app
        .state::<kriyon_remote_link::host_runtime::RemoteRuntime>()
        .is_on()
        .await
    {
        rt.planner.lock().reset();
        return;
    }
    // Nothing to do, and nothing to read, without a phone to wake. A read
    // that fails is skipped, not taken as "no phones".
    let Ok(tokens) = app.state::<crate::StoreState>().0.lock().push_tokens() else {
        return;
    };
    if tokens.is_empty() {
        return;
    }
    // Before the planner marks anything sent: a key that can't be read now
    // leaves the wake for a later look.
    let Some(host_secret) = host_secret(app, &rt) else {
        return;
    };
    let Ok(sessions) = crate::session_list_rt::current(
        &app.state::<crate::AppState>(),
        &app.state::<crate::StoreState>(),
    ) else {
        return;
    };
    let needing = sessions
        .into_iter()
        .filter(|session| session.needs_you)
        .map(|session| session.id);
    let connected = app
        .try_state::<kriyon_remote_link::host_runtime::Serve>()
        .is_some_and(|serve| serve.has_devices());
    let phones: Vec<[u8; 32]> = tokens.iter().map(|token| token.device).collect();
    let due = rt
        .planner
        .lock()
        .observe(needing, connected, &phones, now_secs());
    // Each phone at once. An alert is a hint (spec §10): one that fails
    // isn't retried.
    let mut sending = tokio::task::JoinSet::new();
    for token in tokens
        .into_iter()
        .filter(|token| due.contains(&token.device))
    {
        let sender = Arc::clone(sender);
        sending.spawn(async move {
            sender
                .wake(&host_secret, token.key_id, &token.sealed, now_secs())
                .await
        });
    }
    while let Some(sent) = sending.join_next().await {
        // Said, so a key that's gone or a token gone bad shows up; only the
        // status, never the token. The phone gives a new token on its next
        // connect.
        match sent {
            Ok(Ok(202)) | Err(_) => {}
            Ok(Ok(status)) => eprintln!("kriyon: the push sender refused a wake ({status})"),
            Ok(Err(why)) => eprintln!("kriyon: no push sent: {why}"),
        }
    }
}

/// The [Device key], read once: remote access is on, so it exists.
fn host_secret(app: &tauri::AppHandle, rt: &PushRt) -> Option<[u8; 32]> {
    let mut kept = rt.host_secret.lock();
    if kept.is_none() {
        *kept = crate::remote_cmd::device_key(app).ok();
    }
    *kept
}

#[cfg(test)]
mod tests {
    use kriyon_push::deliver::{Deliver, DeliverError};
    use kriyon_push::gate::Alert;
    use kriyon_push::server::{serve, App};
    use kriyon_remote::push::{push_public_key, seal_push_token, Platform, PushTokenPlain};

    use super::*;

    const SENDER_SECRET: [u8; 32] = [5; 32];
    const HOST_SECRET: [u8; 32] = [6; 32];

    /// Keeps the tokens it was asked to alert, in a list the test shares.
    struct Fake(Arc<parking_lot::Mutex<Vec<String>>>);

    impl Deliver for Fake {
        fn deliver(
            &self,
            alert: Alert,
        ) -> impl std::future::Future<Output = Result<(), DeliverError>> + Send {
            self.0.lock().push(alert.token);
            std::future::ready(Ok(()))
        }
    }

    /// A real push sender on loopback, sending through a fake.
    async fn sender() -> (String, Arc<parking_lot::Mutex<Vec<String>>>) {
        let sent = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let app = Arc::new(App::new(
            kriyon_push::gate::Gate::new(9, SENDER_SECRET),
            Fake(Arc::clone(&sent)),
            Arc::new(|_: &str| {}),
            now_secs,
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("binds");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        tokio::spawn(serve(listener, app));
        (url, sent)
    }

    /// What a phone gives this host: its token sealed for this host.
    fn sealed_for_this_host(token: &str) -> Vec<u8> {
        let host_id = *iroh::SecretKey::from_bytes(&HOST_SECRET)
            .public()
            .as_bytes();
        seal_push_token(
            &push_public_key(&SENDER_SECRET),
            &PushTokenPlain {
                token: token.into(),
                platform: Platform::Fcm,
                host_id,
                expires: now_secs() + 3600,
            },
        )
        .expect("seals")
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn a_wake_signed_with_the_device_key_gets_the_phone_its_alert() {
        run(async {
            let (url, fake) = sender().await;
            let push = PushSender::new(&url).expect("client");
            let sealed = sealed_for_this_host("phone");
            let status = push
                .wake(&HOST_SECRET, 9, &sealed, now_secs())
                .await
                .expect("answered");
            assert_eq!(status, 202);
            assert_eq!(fake.lock().clone(), vec!["phone".to_string()]);
        });
    }

    #[test]
    fn a_token_sealed_for_another_computer_is_refused() {
        run(async {
            let (url, fake) = sender().await;
            let push = PushSender::new(&url).expect("client");
            let sealed = sealed_for_this_host("phone");
            let status = push
                .wake(&[7; 32], 9, &sealed, now_secs())
                .await
                .expect("answered");
            assert_eq!(status, 422);
            assert!(fake.lock().is_empty());
        });
    }

    #[test]
    fn a_sender_that_is_not_there_is_an_error_not_a_hang() {
        run(async {
            let push = PushSender::new("http://127.0.0.1:1").expect("client");
            assert!(push
                .wake(&HOST_SECRET, 9, b"sealed", now_secs())
                .await
                .is_err());
        });
    }
}
