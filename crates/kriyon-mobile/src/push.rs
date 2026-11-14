//! The phone's side of push (spec section 10): its push token, sealed for
//! each paired computer to the push sender's key, so only the sender can
//! open it, and only when that computer asks.

use kriyon_remote::message::{parse_id_hex, EndpointId};
use kriyon_remote::push::{seal_push_token, Platform, PushTokenPlain, SenderKey};

/// How long a sealed token stays good: about 60 days, renewed on every link.
pub const TOKEN_LIFETIME_SECS: u64 = 60 * 24 * 3600;

/// The push service a token is for, by the app's name for it.
///
/// # Errors
/// Any name but `apns` or `fcm`.
pub fn platform(name: &str) -> Result<Platform, String> {
    match name {
        "apns" => Ok(Platform::Apns),
        "fcm" => Ok(Platform::Fcm),
        _ => Err(format!("no push service is called {name:?}")),
    }
}

/// `token` sealed for computer `host` to the sender's `key`, good until
/// `now_s` plus [`TOKEN_LIFETIME_SECS`]: what goes in `PushToken`.
///
/// # Errors
/// A key that isn't one, or a token too long to seal.
pub fn seal_for(
    key: &SenderKey,
    token: &str,
    platform: Platform,
    host: &EndpointId,
    now_s: u64,
) -> Result<(u32, Vec<u8>), String> {
    // An X25519 public key is 32 bytes, 64 hex digits, as an id is.
    let public = parse_id_hex(&key.public_key).ok_or("the push sender's key isn't one")?;
    let plain = PushTokenPlain {
        token: token.to_string(),
        platform,
        host_id: *host,
        expires: now_s.saturating_add(TOKEN_LIFETIME_SECS),
    };
    let sealed = seal_push_token(&public, &plain).map_err(|e| format!("{e:?}"))?;
    Ok((key.key_id, sealed))
}

/// One HTTP client for the push sender, made on first use.
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // reqwest's rustls has no crypto provider of its own: ring, iroh's.
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The push sender's current key, from `GET {base}/v1/key`.
///
/// # Errors
/// The sender couldn't be reached, or answered something else.
pub async fn fetch_sender_key(base: &str) -> Result<SenderKey, String> {
    let reply = client()?
        .get(format!("{}/v1/key", base.trim_end_matches('/')))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !reply.status().is_success() {
        return Err(format!("the push sender answered {}", reply.status()));
    }
    reply.json().await.map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::{BufRead as _, BufReader, Write as _};
    use std::net::TcpListener;

    use kriyon_remote::push::{open_push_token, push_public_key, PushTokenPlain};

    use super::*;

    const SECRET: [u8; 32] = [9; 32];

    fn key() -> SenderKey {
        SenderKey {
            key_id: 3,
            public_key: kriyon_remote::message::hex(&push_public_key(&SECRET)),
        }
    }

    #[test]
    fn a_token_is_sealed_for_one_computer_and_only_the_sender_opens_it() {
        let (key_id, sealed) =
            seal_for(&key(), "apns-token", Platform::Apns, &[4; 32], 1_000).expect("sealed");
        assert_eq!(key_id, 3, "names the key it was sealed to");
        assert_eq!(
            open_push_token(&SECRET, &sealed).expect("opens"),
            PushTokenPlain {
                token: "apns-token".into(),
                platform: Platform::Apns,
                host_id: [4; 32],
                expires: 1_000 + TOKEN_LIFETIME_SECS,
            }
        );
        assert!(
            open_push_token(&[8; 32], &sealed).is_err(),
            "no other key opens it"
        );
    }

    #[test]
    fn a_key_that_isnt_one_is_refused() {
        let bad = SenderKey {
            key_id: 1,
            public_key: "not hex".into(),
        };
        assert!(seal_for(&bad, "t", Platform::Apns, &[4; 32], 0).is_err());
    }

    #[test]
    fn the_platform_names_are_the_apps() {
        assert_eq!(platform("apns"), Ok(Platform::Apns));
        assert_eq!(platform("fcm"), Ok(Platform::Fcm));
        assert!(platform("ios").is_err());
    }

    /// A push sender on localhost that answers `/v1/key` once.
    pub(crate) fn fake_sender(status: u16, body: &'static str) -> String {
        fake_sender_replies(vec![(status, body.to_string())])
    }

    /// A push sender on localhost that gives these replies, one a request.
    pub(crate) fn fake_sender_replies(replies: Vec<(u16, String)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        std::thread::spawn(move || {
            for (status, body) in replies {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 2 {
                    line.clear();
                }
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        base
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }

    #[test]
    fn the_senders_key_is_read_from_v1_key() {
        let base = fake_sender(200, r#"{"key_id":3,"public_key":"abcd"}"#);
        assert_eq!(
            run(fetch_sender_key(&base)),
            Ok(SenderKey {
                key_id: 3,
                public_key: "abcd".into()
            })
        );
        let down = fake_sender(503, "{}");
        assert!(run(fetch_sender_key(&down)).is_err());
        assert!(run(fetch_sender_key("http://127.0.0.1:1")).is_err());
    }
}
