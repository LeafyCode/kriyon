//! The sender's settings, all from outside: environment variables naming
//! files the operator mounts (a Docker secret, say). Nothing is committed,
//! and nothing is written back.
//!
//! | Variable | What |
//! |---|---|
//! | `KRIYON_PUSH_LISTEN` | Address to listen on (default `127.0.0.1:8080`: only the TLS proxy in front reaches it) |
//! | `KRIYON_PUSH_KEY_ID` | The key's id, a number phones and hosts name it by |
//! | `KRIYON_PUSH_SECRET_FILE` | A file holding the X25519 secret, 64 hex digits (`kriyon-push new-key`) |
//! | `KRIYON_PUSH_RETIRED_KEYS_FILE` | Optional: keys replaced by a newer one, one a line, `<key id> <retired at, Unix seconds> <64 hex digits>`; each still opens tokens for 60 days |
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
    /// Retired keys: id, secret, when retired (Unix seconds).
    pub retired: Vec<(u32, [u8; 32], u64)>,
    pub apns: Option<ApnsConfig>,
    pub fcm: Option<FcmConfig>,
}

impl Config {
    /// Read the settings through `var` (an environment variable) and `read`
    /// (a file's text), at `now` (Unix seconds).
    ///
    /// # Errors
    /// What is missing or wrong, naming the variable, never its value.
    pub fn read(
        var: impl Fn(&str) -> Option<String>,
        read: impl Fn(&str) -> Option<String>,
        now: u64,
    ) -> Result<Self, String> {
        let required = |name: &str| var(name).ok_or_else(|| format!("{name} is not set"));
        let file = |name: &str| {
            let path = required(name)?;
            read(&path).ok_or_else(|| format!("the file {name} names can't be read"))
        };
        let listen = var("KRIYON_PUSH_LISTEN")
            .unwrap_or_else(|| "127.0.0.1:8080".into())
            .parse()
            .map_err(|_| "KRIYON_PUSH_LISTEN isn't an address".to_string())?;
        let key_id = required("KRIYON_PUSH_KEY_ID")?
            .trim()
            .parse()
            .map_err(|_| "KRIYON_PUSH_KEY_ID isn't a number".to_string())?;
        let secret = parse_secret(&file("KRIYON_PUSH_SECRET_FILE")?)
            .ok_or("KRIYON_PUSH_SECRET_FILE doesn't hold 64 hex digits")?;
        let retired = match var("KRIYON_PUSH_RETIRED_KEYS_FILE") {
            None => Vec::new(),
            Some(_) => parse_retired(&file("KRIYON_PUSH_RETIRED_KEYS_FILE")?).ok_or(
                "KRIYON_PUSH_RETIRED_KEYS_FILE has a line that isn't `<key id> <retired at> <64 hex digits>`",
            )?,
        };
        check_retired(&retired, key_id, now)?;
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
            retired,
            apns,
            fcm,
        })
    }
}

/// Retired keys, one a line: `<key id> <retired at> <secret>`. Blank lines
/// and `#` comments are skipped; any other line that doesn't read fails it.
fn parse_retired(text: &str) -> Option<Vec<(u32, [u8; 32], u64)>> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let mut fields = line.split_whitespace();
            let key_id = fields.next()?.parse().ok()?;
            let retired_at = fields.next()?.parse().ok()?;
            let secret = parse_secret(fields.next()?)?;
            fields
                .next()
                .is_none()
                .then_some((key_id, secret, retired_at))
        })
        .collect()
}

/// Refuse a retired key that would be used wrongly: one with the current
/// key's id, an id given twice, or a time still to come (a time in
/// milliseconds would keep a retired key working for ever).
fn check_retired(retired: &[(u32, [u8; 32], u64)], current: u32, now: u64) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for &(key_id, _, retired_at) in retired {
        if key_id == current {
            return Err(
                "KRIYON_PUSH_RETIRED_KEYS_FILE retires the current KRIYON_PUSH_KEY_ID".into(),
            );
        }
        if !ids.insert(key_id) {
            return Err("KRIYON_PUSH_RETIRED_KEYS_FILE names a key id twice".into());
        }
        if retired_at > now {
            return Err(
                "KRIYON_PUSH_RETIRED_KEYS_FILE has a retired time still to come (Unix seconds, not milliseconds)"
                    .into(),
            );
        }
    }
    Ok(())
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
            NOW,
        )
    }

    const NOW: u64 = 1_800_000_000;
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
        assert_eq!(config.listen, "127.0.0.1:8080".parse().expect("addr"));
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
    fn retired_keys_are_read_one_a_line_and_a_bad_line_is_named() {
        let vars = [
            ("KRIYON_PUSH_KEY_ID", "3"),
            ("KRIYON_PUSH_SECRET_FILE", "/s"),
            ("KRIYON_PUSH_RETIRED_KEYS_FILE", "/r"),
        ];
        let lines = format!(
            "# old keys\n2 1700000000 {}\n\n1 1600000000 {}",
            SECRET.trim(),
            "02".repeat(32)
        );
        let config = read_with(&vars, &[("/s", SECRET), ("/r", &lines)]).expect("reads");
        assert_eq!(
            config.retired,
            vec![(2, [1; 32], 1_700_000_000), (1, [2; 32], 1_600_000_000)]
        );
        let error = read_with(&vars, &[("/s", SECRET), ("/r", "2 soon secret-text")])
            .err()
            .expect("refused");
        assert!(error.contains("KRIYON_PUSH_RETIRED_KEYS_FILE"));
        assert!(!error.contains("secret-text"));
    }

    #[test]
    fn a_retired_key_that_would_be_used_wrongly_is_refused() {
        let vars = [
            ("KRIYON_PUSH_KEY_ID", "3"),
            ("KRIYON_PUSH_SECRET_FILE", "/s"),
            ("KRIYON_PUSH_RETIRED_KEYS_FILE", "/r"),
        ];
        let key = "02".repeat(32);
        for (lines, says) in [
            (format!("3 1700000000 {key}"), "current"),
            (format!("2 1700000000 {key}\n2 1600000000 {key}"), "twice"),
            (format!("2 1700000000000 {key}"), "still to come"),
        ] {
            let error = read_with(&vars, &[("/s", SECRET), ("/r", &lines)])
                .err()
                .expect("refused");
            assert!(error.contains(says), "{error}");
        }
    }

    #[test]
    fn a_missing_key_id_is_named() {
        assert_eq!(
            read_with(&[], &[]).err().as_deref(),
            Some("KRIYON_PUSH_KEY_ID is not set")
        );
    }
}
