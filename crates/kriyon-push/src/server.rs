//! The sender's two endpoints, over HTTP/1.1 behind a TLS proxy:
//!
//! - `GET /v1/key` → `{ key_id, public_key }`, the key phones seal to.
//! - `POST /v1/wake` → checks the wake-up ([`crate::gate`]), then sends one
//!   alert and forgets it.
//!
//! The connection's address is never read, and the log only ever gets
//! [`LogEvent`]s, which carry words and numbers, never a value from a
//! request.

use std::convert::Infallible;
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;
use std::time::Duration;

use http_body_util::{BodyExt as _, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use kriyon_push_seal::{Platform, SenderKey, WakeRequest};
use tokio::net::TcpListener;

use crate::deliver::{Deliver, DeliverError};
use crate::gate::{Gate, Refusal};

/// The most a wake-up's body may be: the sealed token is at most 1 KiB, so
/// 2 KiB of hex, plus the rest.
const MAX_BODY: usize = 8 * 1024;

/// How much one sender takes on at once, and for how long: a peer that
/// opens many connections, or trickles a request in (slowloris), never
/// holds it up.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Connections served at once; one more is closed at once.
    pub connections: usize,
    /// The most time a request's headers may take.
    pub header_time: Duration,
    /// The most time a wake-up's body may take.
    pub body_time: Duration,
    /// The most time one connection lives, keep-alive and all.
    pub connection_time: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            connections: 256,
            header_time: Duration::from_secs(10),
            body_time: Duration::from_secs(10),
            connection_time: Duration::from_secs(30),
        }
    }
}

/// Refusals logged a minute; past that they are counted, and said once.
pub const REFUSALS_LOGGED_A_MINUTE: usize = 60;

/// Where log lines go: stderr in the binary, a list in tests.
pub type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Everything the sender ever logs. No variant can hold an address, a
/// token, an id or any other value from a request.
#[derive(Clone, Copy, Debug)]
pub enum LogEvent {
    Listening {
        port: u16,
    },
    Sent {
        platform: Platform,
    },
    Refused {
        why: Refusal,
    },
    NotSent {
        platform: Platform,
        status: u16,
    },
    /// The listener couldn't take a connection (out of file handles, say);
    /// it goes on.
    AcceptFailed,
    /// More refusals this minute than are logged.
    RefusalsNotLogged,
}

impl LogEvent {
    fn line(self) -> String {
        let platform = |platform| match platform {
            Platform::Apns => "apns",
            Platform::Fcm => "fcm",
        };
        match self {
            Self::Listening { port } => format!("kriyon-push: listening on port {port}"),
            Self::Sent { platform: p } => format!("kriyon-push: wake sent ({})", platform(p)),
            Self::Refused { why } => format!("kriyon-push: wake refused ({})", why.word()),
            Self::NotSent {
                platform: p,
                status,
            } => format!(
                "kriyon-push: wake not sent ({}, status {status})",
                platform(p)
            ),
            Self::AcceptFailed => "kriyon-push: a connection couldn't be taken".to_string(),
            Self::RefusalsNotLogged => {
                "kriyon-push: more wakes refused this minute, not logged".to_string()
            }
        }
    }
}

/// The running sender.
pub struct App<D> {
    gate: Gate,
    key: SenderKey,
    deliver: D,
    log: LogSink,
    now: fn() -> u64,
    limits: Limits,
    /// The minute refusals are being counted in (Unix minutes), and how many.
    refusals: std::sync::Mutex<(u64, usize)>,
}

impl<D: Deliver> App<D> {
    /// A sender checking with `gate` (its keys), sending through
    /// `deliver`, logging to `log`, on clock `now` (Unix seconds).
    #[must_use]
    pub fn new(gate: Gate, deliver: D, log: LogSink, now: fn() -> u64) -> Self {
        let (key_id, public) = gate.current_key();
        Self {
            gate,
            key: SenderKey {
                key_id,
                public_key: hex(&public),
            },
            deliver,
            log,
            now,
            limits: Limits::default(),
            refusals: std::sync::Mutex::new((0, 0)),
        }
    }

    /// The same sender, taking on at most `limits`.
    #[must_use]
    pub fn with_limits(self, limits: Limits) -> Self {
        Self { limits, ..self }
    }

    fn log(&self, event: LogEvent) {
        if let LogEvent::Refused { .. } = event {
            let minute = (self.now)() / 60;
            let mut refusals = self
                .refusals
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if refusals.0 != minute {
                *refusals = (minute, 0);
            }
            refusals.1 += 1;
            match refusals.1.cmp(&(REFUSALS_LOGGED_A_MINUTE + 1)) {
                std::cmp::Ordering::Less => {}
                std::cmp::Ordering::Equal => {
                    drop(refusals);
                    (self.log)(&LogEvent::RefusalsNotLogged.line());
                    return;
                }
                std::cmp::Ordering::Greater => return,
            }
        }
        (self.log)(&event.line());
    }
}

/// Serve `app` on `listener` until the task is dropped. A connection that
/// can't be taken is logged and the next one taken: nothing a peer does
/// stops the sender.
///
/// # Errors
/// When the listener has no address.
pub async fn serve<D: Deliver>(listener: TcpListener, app: Arc<App<D>>) -> std::io::Result<()> {
    app.log(LogEvent::Listening {
        port: listener.local_addr()?.port(),
    });
    let limits = app.limits;
    let places = Arc::new(tokio::sync::Semaphore::new(limits.connections));
    loop {
        // The peer's address is not kept, read or logged.
        let Ok((stream, _)) = listener.accept().await else {
            app.log(LogEvent::AcceptFailed);
            // Out of file handles, most likely: a moment for some to go.
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        // Full: closed at once, so the ones being served go on.
        let Ok(place) = Arc::clone(&places).try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let app = Arc::clone(&app);
        tokio::spawn(async move {
            let _place = place;
            let service = hyper::service::service_fn(move |request| {
                let app = Arc::clone(&app);
                async move { Ok::<_, Infallible>(handle(&app, request).await) }
            });
            // A connection that fails just ends; there is nothing to log
            // that wouldn't be about the peer. Its time is capped whole.
            let _ = tokio::time::timeout(
                limits.connection_time,
                hyper::server::conn::http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(limits.header_time)
                    .serve_connection(TokioIo::new(stream), service),
            )
            .await;
        });
    }
}

async fn handle<D: Deliver>(app: &App<D>, request: Request<Incoming>) -> Response<Full<Bytes>> {
    match (request.method(), request.uri().path()) {
        (&Method::GET, "/v1/key") => json(StatusCode::OK, &app.key),
        (&Method::POST, "/v1/wake") => wake(app, request).await,
        _ => error(StatusCode::NOT_FOUND, "not_found"),
    }
}

async fn wake<D: Deliver>(app: &App<D>, request: Request<Incoming>) -> Response<Full<Bytes>> {
    let body = tokio::time::timeout(
        app.limits.body_time,
        Limited::new(request.into_body(), MAX_BODY).collect(),
    )
    .await;
    let body = match body {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return error(StatusCode::PAYLOAD_TOO_LARGE, "too_large"),
        Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "too_slow"),
    };
    let Ok(wake) = serde_json::from_slice::<WakeRequest>(&body.to_bytes()) else {
        app.log(LogEvent::Refused {
            why: Refusal::Malformed,
        });
        return error(StatusCode::BAD_REQUEST, Refusal::Malformed.word());
    };
    let checked = app.gate.check(&wake, (app.now)());
    let alert = match checked {
        Ok(alert) => alert,
        Err(why) => {
            app.log(LogEvent::Refused { why });
            let status = StatusCode::from_u16(why.status()).unwrap_or(StatusCode::BAD_REQUEST);
            return error(status, why.word());
        }
    };
    let platform = alert.platform;
    match app.deliver.deliver(alert).await {
        Ok(()) => {
            app.log(LogEvent::Sent { platform });
            json(StatusCode::ACCEPTED, &serde_json::json!({ "sent": true }))
        }
        Err(failed) => {
            let (status, word, logged) = match failed {
                DeliverError::Gone => (StatusCode::NOT_FOUND, "token_gone", 404),
                DeliverError::NotConfigured => (StatusCode::NOT_IMPLEMENTED, "not_configured", 501),
                DeliverError::Failed(status) => (StatusCode::BAD_GATEWAY, "push_failed", status),
            };
            app.log(LogEvent::NotSent {
                platform,
                status: logged,
            });
            error(status, word)
        }
    }
}

fn json(status: StatusCode, body: &impl serde::Serialize) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(
        serde_json::to_vec(body).unwrap_or_default(),
    )));
    *response.status_mut() = status;
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    response
}

fn error(status: StatusCode, word: &str) -> Response<Full<Bytes>> {
    json(status, &serde_json::json!({ "error": word }))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

#[cfg(test)]
mod tests {
    use crate::gate::tests::{host_id, sealed_for, to_hex, wake, HOST_SECRET, KEY_ID, NOW, SECRET};
    use crate::gate::Alert;

    use kriyon_push_seal::push_public_key;

    use super::*;

    /// Records alerts instead of sending them.
    #[derive(Default)]
    struct Fake {
        sent: Mutex<Vec<Alert>>,
    }

    impl Deliver for Arc<Fake> {
        fn deliver(
            &self,
            alert: Alert,
        ) -> impl std::future::Future<Output = Result<(), DeliverError>> + Send {
            let gone = alert.token == GONE;
            self.sent.lock().expect("lock").push(alert);
            std::future::ready(if gone {
                Err(DeliverError::Gone)
            } else {
                Ok(())
            })
        }
    }

    fn now() -> u64 {
        NOW
    }

    /// APNs device tokens (hex): one the push service dropped.
    const PHONE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const GONE: &str = "dead0000dead0000dead0000dead0000dead0000dead0000dead0000dead0000";

    struct Running {
        url: String,
        fake: Arc<Fake>,
        logged: Arc<Mutex<Vec<String>>>,
        http: reqwest::Client,
    }

    async fn running() -> Running {
        running_with(Limits::default()).await
    }

    async fn running_with(limits: Limits) -> Running {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let fake = Arc::new(Fake::default());
        let logged = Arc::new(Mutex::new(Vec::new()));
        let lines = Arc::clone(&logged);
        let app = Arc::new(
            App::new(
                Gate::new(KEY_ID, SECRET),
                Arc::clone(&fake),
                Arc::new(move |line: &str| lines.lock().expect("lock").push(line.to_string())),
                now,
            )
            .with_limits(limits),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("binds");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        tokio::spawn(serve(listener, app));
        Running {
            url,
            fake,
            logged,
            http: reqwest::Client::new(),
        }
    }

    async fn post(running: &Running, body: &str) -> (u16, serde_json::Value) {
        let response = running
            .http
            .post(format!("{}/v1/wake", running.url))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("answered");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or_default())
    }

    /// Whether the server closes `stream` (or answers and closes) within
    /// `within`.
    async fn closed_within(stream: &mut tokio::net::TcpStream, within: Duration) -> bool {
        use tokio::io::AsyncReadExt as _;
        let mut buf = vec![0; 4096];
        tokio::time::timeout(within, async {
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        })
        .await
        .is_ok()
    }

    fn short() -> Limits {
        Limits {
            connections: 2,
            header_time: Duration::from_millis(300),
            body_time: Duration::from_millis(300),
            connection_time: Duration::from_secs(2),
        }
    }

    /// Slowloris: a body that trickles in never holds the sender up.
    #[tokio::test]
    async fn a_body_sent_slowly_is_cut_off() {
        use tokio::io::AsyncWriteExt as _;
        let running = running_with(short()).await;
        let addr = running.url.trim_start_matches("http://").to_string();
        let mut stream = tokio::net::TcpStream::connect(&addr)
            .await
            .expect("connects");
        stream
            .write_all(b"POST /v1/wake HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\n{")
            .await
            .expect("sent");
        assert!(
            closed_within(&mut stream, Duration::from_secs(2)).await,
            "a stalled body holds the connection"
        );
    }

    /// Connections past the cap are closed at once, and the sender still
    /// answers once they go.
    #[tokio::test]
    async fn connections_past_the_cap_are_closed_at_once() {
        let running = running_with(Limits {
            header_time: Duration::from_secs(30),
            ..short()
        })
        .await;
        let addr = running.url.trim_start_matches("http://").to_string();
        // Two that say nothing hold both places.
        let first = tokio::net::TcpStream::connect(&addr)
            .await
            .expect("connects");
        let second = tokio::net::TcpStream::connect(&addr)
            .await
            .expect("connects");
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut third = tokio::net::TcpStream::connect(&addr)
            .await
            .expect("connects");
        assert!(
            closed_within(&mut third, Duration::from_millis(500)).await,
            "a connection past the cap is kept"
        );
        // A connection lives at most its time: the places free up.
        drop((first, second));
        tokio::time::sleep(Duration::from_millis(100)).await;
        let key = running
            .http
            .get(format!("{}/v1/key", running.url))
            .send()
            .await
            .expect("answered");
        assert_eq!(key.status().as_u16(), 200);
    }

    /// A flood of junk can't flood the log: refusals past a minute's share
    /// are counted, not written.
    #[tokio::test]
    async fn refusals_are_logged_at_most_a_minutes_share() {
        let running = running().await;
        for _ in 0..(REFUSALS_LOGGED_A_MINUTE + 20) {
            let _ = post(&running, "not json").await;
        }
        let logged = running.logged.lock().expect("lock").clone();
        let refused = logged
            .iter()
            .filter(|line| line.contains("wake refused"))
            .count();
        assert_eq!(refused, REFUSALS_LOGGED_A_MINUTE);
        assert_eq!(
            logged
                .iter()
                .filter(|line| line.contains("not logged"))
                .count(),
            1,
            "{logged:?}"
        );
    }

    #[tokio::test]
    async fn the_key_is_published_with_its_id() {
        let running = running().await;
        let key: SenderKey = running
            .http
            .get(format!("{}/v1/key", running.url))
            .send()
            .await
            .expect("answered")
            .json()
            .await
            .expect("json");
        assert_eq!(key.key_id, KEY_ID);
        assert_eq!(key.public_key, to_hex(&push_public_key(&SECRET)));
    }

    #[tokio::test]
    async fn a_good_wake_sends_one_alert_and_a_replay_sends_none() {
        let running = running().await;
        let sealed = sealed_for(PHONE, host_id(&HOST_SECRET), NOW + 3600);
        let body = serde_json::to_string(&wake(&HOST_SECRET, &sealed, NOW, 1)).expect("json");
        assert_eq!(post(&running, &body).await.0, 202);
        assert_eq!(
            post(&running, &body).await,
            (409, serde_json::json!({ "error": "replayed" }))
        );
        let sent = running.fake.sent.lock().expect("lock");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].token, PHONE);
    }

    #[tokio::test]
    async fn junk_a_big_body_and_unknown_paths_are_refused() {
        let running = running().await;
        assert_eq!(post(&running, "not json").await.0, 400);
        assert_eq!(post(&running, &"x".repeat(MAX_BODY + 1)).await.0, 413);
        let missing = running
            .http
            .get(format!("{}/v1/other", running.url))
            .send()
            .await
            .expect("answered");
        assert_eq!(missing.status().as_u16(), 404);
        assert!(running.fake.sent.lock().expect("lock").is_empty());
    }

    #[tokio::test]
    async fn a_token_the_push_service_dropped_is_reported_gone() {
        let running = running().await;
        let sealed = sealed_for(GONE, host_id(&HOST_SECRET), NOW + 3600);
        let body = serde_json::to_string(&wake(&HOST_SECRET, &sealed, NOW, 2)).expect("json");
        assert_eq!(
            post(&running, &body).await,
            (404, serde_json::json!({ "error": "token_gone" }))
        );
    }

    #[tokio::test]
    async fn nothing_from_a_request_or_its_connection_reaches_the_log() {
        let running = running().await;
        let token = "7365637265747365637265747365637265747365637265747365637265740000";
        let sealed = sealed_for(token, host_id(&HOST_SECRET), NOW + 3600);
        let request = wake(&HOST_SECRET, &sealed, NOW, 3);
        let body = serde_json::to_string(&request).expect("json");
        let _ = post(&running, &body).await;
        let _ = post(&running, &body).await;
        let mut stale = wake(&HOST_SECRET, &sealed, NOW - 3600, 4);
        let _ = post(&running, &serde_json::to_string(&stale).expect("json")).await;
        stale.signature = "00".repeat(64);
        let _ = post(&running, &serde_json::to_string(&stale).expect("json")).await;
        let _ = post(&running, "{\"from\": \"203.0.113.9\"}").await;

        let logged = running.logged.lock().expect("lock").join("\n");
        assert!(logged.contains("wake sent (apns)"), "{logged}");
        assert!(logged.contains("wake refused (replayed)"), "{logged}");
        for secret in [
            token,
            "127.0.0.1",
            "203.0.113.9",
            "::1",
            &request.sealed,
            &request.request_id,
            &request.host_id,
            &request.signature,
            &request.sealed[..16],
            &request.host_id[..16],
        ] {
            assert!(!logged.contains(secret), "the log holds {secret}: {logged}");
        }
    }
}
