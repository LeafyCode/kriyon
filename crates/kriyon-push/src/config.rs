//! The sender's settings, all from outside: environment variables naming
//! files the operator mounts (a Docker secret, say). Nothing is committed,
//! and nothing is written back.
//!
//! | Variable | What |
//! |---|---|
//! | `KRIYON_PUSH_LISTEN` | Address to listen on (default `0.0.0.0:8080`), behind a TLS proxy |
//! | `KRIYON_PUSH_KEY_ID` | The key's id, a number phones and hosts name it by |
//! | `KRIYON_PUSH_SECRET_FILE` | A file holding the X25519 secret, 64 hex digits (`kriyon-push new-key`) |
//! | `APNS_KEY_FILE` | The APNs `.p8` key (optional: no iPhone alerts without it) |
//! | `APNS_KEY_ID`, `APNS_TEAM_ID` | Its key id and the team id |
//! | `APNS_TOPIC` | The app's bundle id |
//! | `APNS_ENDPOINT` | `https://api.push.apple.com` (default) or the sandbox |
//! | `FCM_SERVICE_ACCOUNT_FILE` | A Google service account's JSON key (optional: no Android alerts without it) |

use std::net::SocketAddr;

use crate::deliver::{ApnsConfig, FcmConfig};

/// The settings, read.
pub struct Config {
    pub listen: SocketAddr,
    pub key_id: u32,
    pub secret: [u8; 32],
    pub apns: Option<ApnsConfig>,
    pub fcm: Option<FcmConfig>,
}

impl Config {
    /// Read the settings through `var` (an environment variable) and `read`
    /// (a file's text).
    ///
    /// # Errors
    /// What is missing or wrong, naming the variable, never its value.
    pub fn read(
        var: impl Fn(&str) -> Option<String>,
        read: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let required = |name: &str| var(name).ok_or_else(|| format!("{name} is not set"));
        let file = |name: &str| {
            let path = required(name)?;
            read(&path).ok_or_else(|| format!("the file {name} names can't be read"))
        };
        let listen = var("KRIYON_PUSH_LISTEN")
            .unwrap_or_else(|| "0.0.0.0:8080".into())
            .parse()
            .map_err(|_| "KRIYON_PUSH_LISTEN isn't an address".to_string())?;
        let key_id = required("KRIYON_PUSH_KEY_ID")?
            .trim()
            .parse()
            .map_err(|_| "KRIYON_PUSH_KEY_ID isn't a number".to_string())?;
        let secret = parse_secret(&file("KRIYON_PUSH_SECRET_FILE")?)
            .ok_or("KRIYON_PUSH_SECRET_FILE doesn't hold 64 hex digits")?;
        let apns = match var("APNS_KEY_FILE") {
            None => None,
            Some(_) => Some(ApnsConfig {
                key_pem: file("APNS_KEY_FILE")?,
                key_id: required("APNS_KEY_ID")?,
                team_id: required("APNS_TEAM_ID")?,
                topic: required("APNS_TOPIC")?,
                endpoint: var("APNS_ENDPOINT")
                    .unwrap_or_else(|| "https://api.push.apple.com".into()),
            }),
        };
        let fcm = match var("FCM_SERVICE_ACCOUNT_FILE") {
            None => None,
            Some(_) => Some(FcmConfig::from_service_account(&file(
                "FCM_SERVICE_ACCOUNT_FILE",
            )?)?),
        };
        Ok(Self {
            listen,
            key_id,
            secret,
            apns,
            fcm,
        })
    }
}

/// 64 hex digits, surrounding space ignored.
fn parse_secret(text: &str) -> Option<[u8; 32]> {
    let text = text.trim();
    if text.len() != 64 || !text.is_ascii() {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect();
    bytes?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn read_with(vars: &[(&str, &str)], files: &[(&str, &str)]) -> Result<Config, String> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        let files: HashMap<String, String> = files
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        Config::read(
            |name| vars.get(name).cloned(),
            |path| files.get(path).cloned(),
        )
    }

    const SECRET: &str = "0101010101010101010101010101010101010101010101010101010101010101\n";

    #[test]
    fn the_key_alone_is_enough_to_start() {
        let config = read_with(
            &[
                ("KRIYON_PUSH_KEY_ID", "3"),
                ("KRIYON_PUSH_SECRET_FILE", "/s"),
            ],
            &[("/s", SECRET)],
        )
        .expect("reads");
        assert_eq!(config.key_id, 3);
        assert_eq!(config.secret, [1; 32]);
        assert_eq!(config.listen, "0.0.0.0:8080".parse().expect("addr"));
        assert!(config.apns.is_none() && config.fcm.is_none());
    }

    #[test]
    fn apns_needs_all_its_settings() {
        let error = read_with(
            &[
                ("KRIYON_PUSH_KEY_ID", "3"),
                ("KRIYON_PUSH_SECRET_FILE", "/s"),
                ("APNS_KEY_FILE", "/k"),
            ],
            &[("/s", SECRET), ("/k", "pem")],
        )
        .err();
        assert_eq!(error.as_deref(), Some("APNS_KEY_ID is not set"));
    }

    #[test]
    fn a_bad_secret_is_named_but_not_shown() {
        let error = read_with(
            &[
                ("KRIYON_PUSH_KEY_ID", "3"),
                ("KRIYON_PUSH_SECRET_FILE", "/s"),
            ],
            &[("/s", "not-a-secret-value")],
        )
        .err()
        .expect("refused");
        assert!(error.contains("KRIYON_PUSH_SECRET_FILE"));
        assert!(!error.contains("not-a-secret-value"));
    }

    #[test]
    fn a_missing_key_id_is_named() {
        assert_eq!(
            read_with(&[], &[]).err().as_deref(),
            Some("KRIYON_PUSH_KEY_ID is not set")
        );
    }
}
