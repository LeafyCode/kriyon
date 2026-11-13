//! Every check a wake-up must pass before an alert is sent (spec §10, step
//! 4), in memory only: the signature, the time, the request id not seen
//! lately, the token opening and naming the signer, its expiry, and the
//! limits per host and per token.

use std::collections::{HashMap, VecDeque};

use kriyon_remote::push::{open_push_token, verify_wake, Platform, WakeRequest, MAX_SEALED};
use sha2::{Digest, Sha256};

/// How far a wake-up's time may be from ours, either way.
pub const CLOCK_SKEW_SECS: u64 = 5 * 60;

/// How long a request id is remembered, to refuse it again.
pub const REPLAY_WINDOW_SECS: u64 = 10 * 60;

/// Alerts a host, or a token, may cause a minute.
pub const PER_MINUTE: usize = 1;

/// Alerts a host, or a token, may cause a day.
pub const PER_DAY: usize = 30;

/// How long a retired key still opens tokens sealed to it: the longest a
/// token lasts. Phones reseal to the new key on their next connect.
pub const RETIRED_KEY_DAYS: u64 = 60;

const MINUTE: u64 = 60;
const DAY: u64 = 24 * 60 * 60;

/// The one alert to send, with the opened token. Dropped once sent.
#[derive(Debug, PartialEq, Eq)]
pub struct Alert {
    pub platform: Platform,
    pub token: String,
}

/// Why a wake-up was refused. Each has its own HTTP status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Not hex, the wrong lengths, or sealed bytes over the cap.
    Malformed,
    /// Sealed to a key this sender doesn't hold.
    UnknownKey,
    /// The signature isn't the named host's.
    BadSignature,
    /// More than five minutes from our clock.
    BadTime,
    /// A request id seen in the last ten minutes.
    Replayed,
    /// The token doesn't open, or names another host.
    BadToken,
    /// The token's time is up: the phone renews it when it connects.
    Expired,
    /// Over a limit for this host or this token.
    TooMany,
}

impl Refusal {
    /// Its HTTP status.
    #[must_use]
    pub fn status(self) -> u16 {
        match self {
            Self::Malformed => 400,
            Self::UnknownKey | Self::BadToken => 422,
            Self::BadSignature | Self::BadTime => 401,
            Self::Replayed => 409,
            Self::Expired => 410,
            Self::TooMany => 429,
        }
    }

    /// A short word for the response and the log: never a value.
    #[must_use]
    pub fn word(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::UnknownKey => "unknown_key",
            Self::BadSignature => "bad_signature",
            Self::BadTime => "bad_time",
            Self::Replayed => "replayed",
            Self::BadToken => "bad_token",
            Self::Expired => "expired",
            Self::TooMany => "too_many",
        }
    }
}

/// The checks, and the little they must remember.
pub struct Gate {
    key_id: u32,
    secret: [u8; 32],
    /// Retired keys by id: their secret and when they were retired.
    retired: HashMap<u32, ([u8; 32], u64)>,
    /// Request ids seen, with when, oldest first.
    seen: VecDeque<([u8; 16], u64)>,
    seen_ids: HashMap<[u8; 16], u64>,
    /// When alerts went out, per host id and per token hash.
    by_host: HashMap<[u8; 32], VecDeque<u64>>,
    by_token: HashMap<[u8; 32], VecDeque<u64>>,
}

impl Gate {
    /// A gate for the sender key `key_id` with its X25519 `secret`.
    #[must_use]
    pub fn new(key_id: u32, secret: [u8; 32]) -> Self {
        Self {
            key_id,
            secret,
            retired: HashMap::new(),
            seen: VecDeque::new(),
            seen_ids: HashMap::new(),
            by_host: HashMap::new(),
            by_token: HashMap::new(),
        }
    }

    /// Also open tokens sealed to retired key `key_id`, retired at
    /// `retired_at` (Unix seconds), for [`RETIRED_KEY_DAYS`] after.
    #[must_use]
    pub fn with_retired(mut self, key_id: u32, secret: [u8; 32], retired_at: u64) -> Self {
        if key_id != self.key_id {
            self.retired.insert(key_id, (secret, retired_at));
        }
        self
    }

    /// The current key: its id and public key, as `GET /v1/key` gives it.
    #[must_use]
    pub fn current_key(&self) -> (u32, [u8; 32]) {
        (
            self.key_id,
            kriyon_remote::push::push_public_key(&self.secret),
        )
    }

    /// The secret for key `key_id` at `now`, if this sender still holds it.
    fn secret_for(&self, key_id: u32, now: u64) -> Option<[u8; 32]> {
        if key_id == self.key_id {
            return Some(self.secret);
        }
        let (secret, retired_at) = self.retired.get(&key_id)?;
        (now < retired_at.saturating_add(RETIRED_KEY_DAYS * DAY)).then_some(*secret)
    }

    /// Check `request` at `now` (Unix seconds). An alert to send, counted
    /// against the limits, or why not.
    ///
    /// # Errors
    /// The [`Refusal`].
    pub fn check(&mut self, request: &WakeRequest, now: u64) -> Result<Alert, Refusal> {
        let sealed = hex(&request.sealed).ok_or(Refusal::Malformed)?;
        let request_id: [u8; 16] = array(&request.request_id)?;
        let host_id: [u8; 32] = array(&request.host_id)?;
        let signature: [u8; 64] = array(&request.signature)?;
        if sealed.is_empty() || sealed.len() > MAX_SEALED {
            return Err(Refusal::Malformed);
        }
        let secret = self
            .secret_for(request.key_id, now)
            .ok_or(Refusal::UnknownKey)?;
        if !verify_wake(
            &host_id,
            request.key_id,
            &sealed,
            request.at,
            &request_id,
            &signature,
        ) {
            return Err(Refusal::BadSignature);
        }
        if request.at.abs_diff(now) > CLOCK_SKEW_SECS {
            return Err(Refusal::BadTime);
        }
        self.forget_before(now);
        if self.seen_ids.contains_key(&request_id) {
            return Err(Refusal::Replayed);
        }
        self.seen_ids.insert(request_id, now);
        self.seen.push_back((request_id, now));

        let plain = open_push_token(&secret, &sealed).map_err(|_| Refusal::BadToken)?;
        if plain.host_id != host_id {
            return Err(Refusal::BadToken);
        }
        if plain.expires <= now {
            return Err(Refusal::Expired);
        }
        let token_hash: [u8; 32] = Sha256::digest(plain.token.as_bytes()).into();
        if over_limit(self.by_host.get(&host_id), now)
            || over_limit(self.by_token.get(&token_hash), now)
        {
            return Err(Refusal::TooMany);
        }
        self.by_host.entry(host_id).or_default().push_back(now);
        self.by_token.entry(token_hash).or_default().push_back(now);
        Ok(Alert {
            platform: plain.platform,
            token: plain.token,
        })
    }

    /// Drop request ids past the window and sends older than a day.
    fn forget_before(&mut self, now: u64) {
        while let Some(&(id, at)) = self.seen.front() {
            if now.saturating_sub(at) < REPLAY_WINDOW_SECS {
                break;
            }
            self.seen.pop_front();
            self.seen_ids.remove(&id);
        }
        for sends in [&mut self.by_host, &mut self.by_token] {
            sends.retain(|_, times| {
                while times
                    .front()
                    .is_some_and(|&at| now.saturating_sub(at) >= DAY)
                {
                    times.pop_front();
                }
                !times.is_empty()
            });
        }
    }

    /// How many request ids, hosts and tokens it remembers: for tests that
    /// it forgets.
    #[must_use]
    pub fn remembered(&self) -> (usize, usize, usize) {
        (self.seen_ids.len(), self.by_host.len(), self.by_token.len())
    }
}

/// Whether one more send at `now` would pass a limit.
fn over_limit(sends: Option<&VecDeque<u64>>, now: u64) -> bool {
    let Some(sends) = sends else {
        return false;
    };
    let last_minute = sends
        .iter()
        .filter(|&&at| now.saturating_sub(at) < MINUTE)
        .count();
    last_minute >= PER_MINUTE || sends.len() >= PER_DAY
}

fn hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

fn array<const N: usize>(text: &str) -> Result<[u8; N], Refusal> {
    hex(text)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(Refusal::Malformed)
}

#[cfg(test)]
pub(crate) mod tests {
    use kriyon_remote::push::{push_public_key, seal_push_token, sign_wake, PushTokenPlain};

    use super::*;

    pub(crate) const SECRET: [u8; 32] = [5; 32];
    pub(crate) const KEY_ID: u32 = 7;
    pub(crate) const HOST_SECRET: [u8; 32] = [6; 32];
    pub(crate) const NOW: u64 = 1_800_000_000;

    pub(crate) fn host_id(secret: &[u8; 32]) -> [u8; 32] {
        ed25519_dalek::SigningKey::from_bytes(secret)
            .verifying_key()
            .to_bytes()
    }

    pub(crate) fn to_hex(bytes: &[u8]) -> String {
        use std::fmt::Write as _;
        bytes.iter().fold(String::new(), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
    }

    pub(crate) fn sealed_for(token: &str, host: [u8; 32], expires: u64) -> Vec<u8> {
        seal_push_token(
            &push_public_key(&SECRET),
            &PushTokenPlain {
                token: token.into(),
                platform: Platform::Apns,
                host_id: host,
                expires,
            },
        )
        .expect("seals")
    }

    /// A wake-up signed by `host_secret` for `sealed`.
    pub(crate) fn wake(host_secret: &[u8; 32], sealed: &[u8], at: u64, id: u8) -> WakeRequest {
        let request_id = [id; 16];
        WakeRequest {
            key_id: KEY_ID,
            sealed: to_hex(sealed),
            at,
            request_id: to_hex(&request_id),
            host_id: to_hex(&host_id(host_secret)),
            signature: to_hex(&sign_wake(host_secret, KEY_ID, sealed, at, &request_id)),
        }
    }

    fn good(id: u8) -> WakeRequest {
        let sealed = sealed_for("tok", host_id(&HOST_SECRET), NOW + DAY);
        wake(&HOST_SECRET, &sealed, NOW, id)
    }

    #[test]
    fn a_good_wake_up_gives_one_alert_with_the_opened_token() {
        let mut gate = Gate::new(KEY_ID, SECRET);
        assert_eq!(
            gate.check(&good(1), NOW),
            Ok(Alert {
                platform: Platform::Apns,
                token: "tok".into()
            })
        );
    }

    #[test]
    fn a_wake_up_signed_by_another_host_is_refused() {
        let mut gate = Gate::new(KEY_ID, SECRET);
        let mut request = good(1);
        request.host_id = to_hex(&host_id(&[9; 32]));
        assert_eq!(gate.check(&request, NOW), Err(Refusal::BadSignature));
    }

    #[test]
    fn a_token_sealed_for_another_host_is_refused_even_signed() {
        let mut gate = Gate::new(KEY_ID, SECRET);
        // Host B signs a token the phone sealed for host A.
        let sealed = sealed_for("tok", host_id(&HOST_SECRET), NOW + DAY);
        let request = wake(&[9; 32], &sealed, NOW, 1);
        assert_eq!(gate.check(&request, NOW), Err(Refusal::BadToken));
    }

    #[test]
    fn a_wake_up_more_than_five_minutes_off_is_refused() {
        let mut gate = Gate::new(KEY_ID, SECRET);
        let sealed = sealed_for("tok", host_id(&HOST_SECRET), NOW + DAY);
        let late = wake(&HOST_SECRET, &sealed, NOW - CLOCK_SKEW_SECS - 1, 1);
        let early = wake(&HOST_SECRET, &sealed, NOW + CLOCK_SKEW_SECS + 1, 2);
        assert_eq!(gate.check(&late, NOW), Err(Refusal::BadTime));
        assert_eq!(gate.check(&early, NOW), Err(Refusal::BadTime));
        let edge = wake(&HOST_SECRET, &sealed, NOW - CLOCK_SKEW_SECS, 3);
        assert!(gate.check(&edge, NOW).is_ok());
    }

    #[test]
    fn a_request_id_is_refused_again_for_ten_minutes_then_forgotten() {
        let mut gate = Gate::new(KEY_ID, SECRET);
        let sealed = sealed_for("tok", host_id(&HOST_SECRET), NOW + 2 * DAY);
        assert!(gate
            .check(&wake(&HOST_SECRET, &sealed, NOW, 1), NOW)
            .is_ok());
        assert_eq!(
            gate.check(&wake(&HOST_SECRET, &sealed, NOW + 60, 1), NOW + 60),
            Err(Refusal::Replayed)
        );
        let later = NOW + REPLAY_WINDOW_SECS;
        assert!(gate
            .check(&wake(&HOST_SECRET, &sealed, later, 1), later)
            .is_ok());
    }

    #[test]
    fn an_expired_token_is_refused() {
        let mut gate = Gate::new(KEY_ID, SECRET);
        let sealed = sealed_for("tok", host_id(&HOST_SECRET), NOW);
        assert_eq!(
            gate.check(&wake(&HOST_SECRET, &sealed, NOW, 1), NOW),
            Err(Refusal::Expired)
        );
    }

    #[test]
    fn a_host_gets_one_alert_a_minute_and_thirty_a_day() {
        let mut gate = Gate::new(KEY_ID, SECRET);
        let sealed = sealed_for("tok", host_id(&HOST_SECRET), NOW + 2 * DAY);
        let mut at = NOW;
        assert!(gate.check(&wake(&HOST_SECRET, &sealed, at, 0), at).is_ok());
        assert_eq!(
            gate.check(&wake(&HOST_SECRET, &sealed, at + 30, 1), at + 30),
            Err(Refusal::TooMany),
            "a second in the same minute"
        );
        for id in 2..31 {
            at += MINUTE;
            assert!(gate.check(&wake(&HOST_SECRET, &sealed, at, id), at).is_ok());
        }
        at += MINUTE;
        assert_eq!(
            gate.check(&wake(&HOST_SECRET, &sealed, at, 31), at),
            Err(Refusal::TooMany),
            "the thirty-first in a day"
        );
        at = NOW + DAY;
        assert!(gate.check(&wake(&HOST_SECRET, &sealed, at, 32), at).is_ok());
    }

    #[test]
    fn one_phones_token_is_limited_across_hosts() {
        let mut gate = Gate::new(KEY_ID, SECRET);
        let other = [8; 32];
        let a = sealed_for("tok", host_id(&HOST_SECRET), NOW + DAY);
        let b = sealed_for("tok", host_id(&other), NOW + DAY);
        assert!(gate.check(&wake(&HOST_SECRET, &a, NOW, 1), NOW).is_ok());
        assert_eq!(
            gate.check(&wake(&other, &b, NOW + 1, 2), NOW + 1),
            Err(Refusal::TooMany)
        );
    }

    #[test]
    fn junk_and_oversize_sealed_bytes_are_malformed() {
        let mut gate = Gate::new(KEY_ID, SECRET);
        let mut request = good(1);
        request.sealed = "zz".into();
        assert_eq!(gate.check(&request, NOW), Err(Refusal::Malformed));
        let big = vec![0; MAX_SEALED + 1];
        assert_eq!(
            gate.check(&wake(&HOST_SECRET, &big, NOW, 2), NOW),
            Err(Refusal::Malformed)
        );
        let mut short = good(3);
        short.request_id = "00".into();
        assert_eq!(gate.check(&short, NOW), Err(Refusal::Malformed));
    }

    #[test]
    fn a_token_sealed_to_a_retired_key_opens_for_sixty_days_after() {
        use kriyon_remote::push::{push_public_key, seal_push_token, sign_wake, PushTokenPlain};
        const OLD: [u8; 32] = [3; 32];
        let retired_at = NOW - 10 * DAY;
        let mut gate = Gate::new(KEY_ID + 1, SECRET).with_retired(KEY_ID, OLD, retired_at);
        let sealed = seal_push_token(
            &push_public_key(&OLD),
            &PushTokenPlain {
                token: "old".into(),
                platform: Platform::Fcm,
                host_id: host_id(&HOST_SECRET),
                expires: NOW + 100 * DAY,
            },
        )
        .expect("seals");
        let signed = |at: u64, id: u8| {
            let request_id = [id; 16];
            WakeRequest {
                key_id: KEY_ID,
                sealed: to_hex(&sealed),
                at,
                request_id: to_hex(&request_id),
                host_id: to_hex(&host_id(&HOST_SECRET)),
                signature: to_hex(&sign_wake(&HOST_SECRET, KEY_ID, &sealed, at, &request_id)),
            }
        };
        assert_eq!(
            gate.check(&signed(NOW, 1), NOW).map(|alert| alert.token),
            Ok("old".to_string())
        );
        let gone = retired_at + RETIRED_KEY_DAYS * DAY;
        assert_eq!(gate.check(&signed(gone, 2), gone), Err(Refusal::UnknownKey));
    }

    #[test]
    fn a_token_opens_only_with_the_key_it_names() {
        // SECRET is retired as key KEY_ID + 5; the current key is another.
        let mut gate = Gate::new(KEY_ID, [9; 32]).with_retired(KEY_ID + 5, SECRET, NOW);
        // Sealed to SECRET, but named as the current key: it doesn't open.
        assert_eq!(gate.check(&good(1), NOW), Err(Refusal::BadToken));
    }

    #[test]
    fn a_wake_up_for_another_sender_key_is_refused() {
        let mut gate = Gate::new(KEY_ID + 1, SECRET);
        assert_eq!(gate.check(&good(1), NOW), Err(Refusal::UnknownKey));
    }

    #[test]
    fn it_forgets_ids_and_sends_once_they_are_old() {
        let mut gate = Gate::new(KEY_ID, SECRET);
        assert!(gate.check(&good(1), NOW).is_ok());
        assert_eq!(gate.remembered(), (1, 1, 1));
        let sealed = sealed_for("tok", host_id(&HOST_SECRET), NOW + 3 * DAY);
        let later = NOW + DAY + 1;
        let _ = gate.check(&wake(&[4; 32], &sealed, later, 2), later);
        assert_eq!(gate.remembered().1, 0, "no host kept past a day");
        assert_eq!(gate.remembered().2, 0, "no token kept past a day");
    }
}
