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
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body_util::{BodyExt as _, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use kriyon_remote::push::{push_public_key, Platform, SenderKey, WakeRequest};
use tokio::net::TcpListener;

use crate::deliver::{Deliver, DeliverError};
use crate::gate::{Gate, Refusal};

/// The most a wake-up's body may be: the sealed token is at most 1 KiB, so
/// 2 KiB of hex, plus the rest.
const MAX_BODY: usize = 8 * 1024;

/// Where log lines go: stderr in the binary, a list in tests.
pub type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Everything the sender ever logs. No variant can hold an address, a
/// token, an id or any other value from a request.
#[derive(Clone, Copy, Debug)]
pub enum LogEvent {
    Listening { port: u16 },
    Sent { platform: Platform },
    Refused { why: Refusal },
    NotSent { platform: Platform, status: u16 },
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
        }
    }
}

/// The running sender.
pub struct App<D> {
    gate: Mutex<Gate>,
    key: SenderKey,
    deliver: D,
    log: LogSink,
    now: fn() -> u64,
}

impl<D: Deliver> App<D> {
    /// A sender with key `key_id` and X25519 `secret`, sending through
    /// `deliver`, logging to `log`, on clock `now` (Unix seconds).
    #[must_use]
    pub fn new(key_id: u32, secret: [u8; 32], deliver: D, log: LogSink, now: fn() -> u64) -> Self {
        Self {
            gate: Mutex::new(Gate::new(key_id, secret)),
            key: SenderKey {
                key_id,
                public_key: hex(&push_public_key(&secret)),
            },
            deliver,
            log,
            now,
        }
    }

    fn log(&self, event: LogEvent) {
        (self.log)(&event.line());
    }
}

/// Serve `app` on `listener` until the task is dropped.
///
/// # Errors
/// When the listener fails.
pub async fn serve<D: Deliver>(listener: TcpListener, app: Arc<App<D>>) -> std::io::Result<()> {
    app.log(LogEvent::Listening {
        port: listener.local_addr()?.port(),
    });
    loop {
        // The peer's address is not kept, read or logged.
        let (stream, _) = listener.accept().await?;
        let app = Arc::clone(&app);
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                let app = Arc::clone(&app);
                async move { Ok::<_, Infallible>(handle(&app, request).await) }
            });
            // A connection that fails just ends; there is nothing to log
            // that wouldn't be about the peer.
            let _ = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(10))
                .serve_connection(TokioIo::new(stream), service)
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
    let Ok(body) = Limited::new(request.into_body(), MAX_BODY).collect().await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "too_large");
    };
    let Ok(wake) = serde_json::from_slice::<WakeRequest>(&body.to_bytes()) else {
        app.log(LogEvent::Refused {
            why: Refusal::Malformed,
        });
        return error(StatusCode::BAD_REQUEST, Refusal::Malformed.word());
    };
    let checked = app
        .gate
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .check(&wake, (app.now)());
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
            let gone = alert.token == "gone";
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

    struct Running {
        url: String,
        fake: Arc<Fake>,
        logged: Arc<Mutex<Vec<String>>>,
        http: reqwest::Client,
    }

    async fn running() -> Running {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let fake = Arc::new(Fake::default());
        let logged = Arc::new(Mutex::new(Vec::new()));
        let lines = Arc::clone(&logged);
        let app = Arc::new(App::new(
            KEY_ID,
            SECRET,
            Arc::clone(&fake),
            Arc::new(move |line: &str| lines.lock().expect("lock").push(line.to_string())),
            now,
        ));
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
        let sealed = sealed_for("phone-token", host_id(&HOST_SECRET), NOW + 3600);
        let body = serde_json::to_string(&wake(&HOST_SECRET, &sealed, NOW, 1)).expect("json");
        assert_eq!(post(&running, &body).await.0, 202);
        assert_eq!(
            post(&running, &body).await,
            (409, serde_json::json!({ "error": "replayed" }))
        );
        let sent = running.fake.sent.lock().expect("lock");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].token, "phone-token");
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
        let sealed = sealed_for("gone", host_id(&HOST_SECRET), NOW + 3600);
        let body = serde_json::to_string(&wake(&HOST_SECRET, &sealed, NOW, 2)).expect("json");
        assert_eq!(
            post(&running, &body).await,
            (404, serde_json::json!({ "error": "token_gone" }))
        );
    }

    #[tokio::test]
    async fn nothing_from_a_request_or_its_connection_reaches_the_log() {
        let running = running().await;
        let token = "phone-token-that-must-never-be-logged";
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
