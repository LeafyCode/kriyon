//! Every check a wake-up must pass before an alert is sent (spec §10, step
//! 4), in memory only: the signature, the time, the request id not seen
//! lately, the token opening and naming the signer, its expiry, and the
//! limits per host and per token.

use std::collections::{HashMap, VecDeque};

use kriyon_push_seal::{open_push_token, verify_wake, Platform, WakeRequest, MAX_SEALED};
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

/// How much the sender takes on, for all hosts together: anyone can make a
/// host key and seal a token to the sender's public key, so the limits per
/// host and per token alone don't bound it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    /// Alerts sent a minute, by everyone.
    pub alerts_per_minute: usize,
    /// Request ids, hosts and tokens remembered, each. Full, the host or
    /// token heard from longest ago makes room for a new one.
    pub remembered: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Self {
            alerts_per_minute: 600,
            remembered: 100_000,
        }
    }
}

/// What the checks remember, behind one lock taken only after the crypto.
#[derive(Default)]
struct Memory {
    /// Request ids seen, with when each may be forgotten, in the order seen.
    seen: VecDeque<([u8; 16], u64)>,
    seen_ids: HashMap<[u8; 16], u64>,
    /// When alerts went out, per host id and per token hash.
    by_host: HashMap<[u8; 32], VecDeque<u64>>,
    by_token: HashMap<[u8; 32], VecDeque<u64>>,
    /// When alerts went out, by anyone, in the last minute.
    recent: VecDeque<u64>,
}

/// The checks, and the little they must remember.
pub struct Gate {
    key_id: u32,
    secret: [u8; 32],
    /// Retired keys by id: their secret and when they were retired.
    retired: HashMap<u32, ([u8; 32], u64)>,
    caps: Caps,
    memory: std::sync::Mutex<Memory>,
}

impl Gate {
    /// A gate for the sender key `key_id` with its X25519 `secret`.
    #[must_use]
    pub fn new(key_id: u32, secret: [u8; 32]) -> Self {
        Self {
            key_id,
            secret,
            retired: HashMap::new(),
            caps: Caps::default(),
            memory: std::sync::Mutex::default(),
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

    /// The same gate, taking on at most `caps`.
    #[must_use]
    pub fn with_caps(self, caps: Caps) -> Self {
        Self { caps, ..self }
    }

    /// The current key: its id and public key, as `GET /v1/key` gives it.
    #[must_use]
    pub fn current_key(&self) -> (u32, [u8; 32]) {
        (self.key_id, kriyon_push_seal::push_public_key(&self.secret))
    }

    /// The secret for key `key_id` at `now`, if this sender still holds it.
    fn secret_for(&self, key_id: u32, now: u64) -> Option<[u8; 32]> {
        if key_id == self.key_id {
            return Some(self.secret);
        }
        let (secret, retired_at) = self.retired.get(&key_id)?;
        (now < retired_at.saturating_add(RETIRED_KEY_DAYS * DAY)).then_some(*secret)
    }

    fn memory(&self) -> std::sync::MutexGuard<'_, Memory> {
        self.memory
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Check `request` at `now` (Unix seconds). An alert to send, counted
    /// against the limits, or why not. The crypto runs first, with nothing
    /// held; only a token that opened and named its signer is counted.
    ///
    /// # Errors
    /// The [`Refusal`].
    pub fn check(&self, request: &WakeRequest, now: u64) -> Result<Alert, Refusal> {
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
        let plain = open_push_token(&secret, &sealed).map_err(|_| Refusal::BadToken)?;
        if plain.host_id != host_id || !token_shape_ok(plain.platform, &plain.token) {
            return Err(Refusal::BadToken);
        }
        if plain.expires <= now {
            return Err(Refusal::Expired);
        }
        let token_hash: [u8; 32] = Sha256::digest(plain.token.as_bytes()).into();
        // Kept until its own time is past the clock skew too, so it can't be
        // replayed at the window's end.
        let forget_at = now
            .saturating_add(REPLAY_WINDOW_SECS)
            .max(request.at.saturating_add(CLOCK_SKEW_SECS + 1));
        self.count(request_id, forget_at, host_id, token_hash, now)?;
        Ok(Alert {
            platform: plain.platform,
            token: plain.token,
        })
    }

    /// Count an alert from `host_id` for `token_hash` with `request_id`, at
    /// `now`, or why it can't go.
    fn count(
        &self,
        request_id: [u8; 16],
        forget_at: u64,
        host_id: [u8; 32],
        token_hash: [u8; 32],
        now: u64,
    ) -> Result<(), Refusal> {
        let mut memory = self.memory();
        memory.forget_before(now);
        if memory.seen_ids.contains_key(&request_id) {
            return Err(Refusal::Replayed);
        }
        let caps = self.caps;
        // Ids are kept minutes only, at most the alerts of that time: full
        // only under the caps' own misuse, refused then.
        let full = memory.seen_ids.len() >= caps.remembered;
        if full
            || memory.recent.len() >= caps.alerts_per_minute
            || over_limit(memory.by_host.get(&host_id), now)
            || over_limit(memory.by_token.get(&token_hash), now)
        {
            return Err(Refusal::TooMany);
        }
        // Hosts and tokens are kept a day: full, the one heard from longest
        // ago makes room, so made-up hosts can't lock real ones out.
        make_room(&mut memory.by_host, &host_id, caps.remembered);
        make_room(&mut memory.by_token, &token_hash, caps.remembered);
        memory.seen_ids.insert(request_id, forget_at);
        memory.seen.push_back((request_id, forget_at));
        memory.by_host.entry(host_id).or_default().push_back(now);
        memory
            .by_token
            .entry(token_hash)
            .or_default()
            .push_back(now);
        memory.recent.push_back(now);
        Ok(())
    }

    /// How many request ids, hosts and tokens it remembers: for tests that
    /// it forgets.
    #[must_use]
    pub fn remembered(&self) -> (usize, usize, usize) {
        let memory = self.memory();
        (
            memory.seen_ids.len(),
            memory.by_host.len(),
            memory.by_token.len(),
        )
    }
}

impl Memory {
    /// Drop request ids past their time, sends older than a day and the
    /// sender's sends older than a minute.
    fn forget_before(&mut self, now: u64) {
        // In the order seen; one kept longer (its own time was ahead) holds
        // the ones behind it a little longer, which only refuses more.
        while let Some(&(id, forget_at)) = self.seen.front() {
            if now < forget_at {
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
        while self
            .recent
            .front()
            .is_some_and(|&at| now.saturating_sub(at) >= MINUTE)
        {
            self.recent.pop_front();
        }
    }
}

/// Whether `token` is shaped as `platform`'s tokens are: an APNs device
/// token is hex; an FCM registration token is letters, digits and `_-:`.
#[must_use]
pub fn token_shape_ok(platform: Platform, token: &str) -> bool {
    match platform {
        Platform::Apns => {
            (64..=200).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit())
        }
        Platform::Fcm => {
            (1..=4096).contains(&token.len())
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':'))
        }
    }
}

/// Make room in `sends` for `key` if it is new and `sends` holds `cap`:
/// the one sent to longest ago goes.
fn make_room(sends: &mut HashMap<[u8; 32], VecDeque<u64>>, key: &[u8; 32], cap: usize) {
    if sends.contains_key(key) || sends.len() < cap {
        return;
    }
    let stalest = sends
        .iter()
        .min_by_key(|(_, times)| times.back().copied().unwrap_or(0))
        .map(|(key, _)| *key);
    if let Some(stalest) = stalest {
        sends.remove(&stalest);
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
    use kriyon_push_seal::{push_public_key, seal_push_token, sign_wake, PushTokenPlain};

    use super::*;

    pub(crate) const SECRET: [u8; 32] = [5; 32];
    pub(crate) const KEY_ID: u32 = 7;
    pub(crate) const HOST_SECRET: [u8; 32] = [6; 32];
    pub(crate) const NOW: u64 = 1_800_000_000;
    /// An APNs device token: hex.
    pub(crate) const TOK: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";

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
        let sealed = sealed_for(TOK, host_id(&HOST_SECRET), NOW + DAY);
        wake(&HOST_SECRET, &sealed, NOW, id)
    }

    #[test]
    fn a_good_wake_up_gives_one_alert_with_the_opened_token() {
        let gate = Gate::new(KEY_ID, SECRET);
        assert_eq!(
            gate.check(&good(1), NOW),
            Ok(Alert {
                platform: Platform::Apns,
                token: TOK.into()
            })
        );
    }

    #[test]
    fn a_wake_up_signed_by_another_host_is_refused() {
        let gate = Gate::new(KEY_ID, SECRET);
        let mut request = good(1);
        request.host_id = to_hex(&host_id(&[9; 32]));
        assert_eq!(gate.check(&request, NOW), Err(Refusal::BadSignature));
    }

    #[test]
    fn a_token_sealed_for_another_host_is_refused_even_signed() {
        let gate = Gate::new(KEY_ID, SECRET);
        // Host B signs a token the phone sealed for host A.
        let sealed = sealed_for(TOK, host_id(&HOST_SECRET), NOW + DAY);
        let request = wake(&[9; 32], &sealed, NOW, 1);
        assert_eq!(gate.check(&request, NOW), Err(Refusal::BadToken));
    }

    #[test]
    fn a_wake_up_more_than_five_minutes_off_is_refused() {
        let gate = Gate::new(KEY_ID, SECRET);
        let sealed = sealed_for(TOK, host_id(&HOST_SECRET), NOW + DAY);
        let late = wake(&HOST_SECRET, &sealed, NOW - CLOCK_SKEW_SECS - 1, 1);
        let early = wake(&HOST_SECRET, &sealed, NOW + CLOCK_SKEW_SECS + 1, 2);
        assert_eq!(gate.check(&late, NOW), Err(Refusal::BadTime));
        assert_eq!(gate.check(&early, NOW), Err(Refusal::BadTime));
        let edge = wake(&HOST_SECRET, &sealed, NOW - CLOCK_SKEW_SECS, 3);
        assert!(gate.check(&edge, NOW).is_ok());
    }

    #[test]
    fn a_request_id_is_refused_again_for_ten_minutes_then_forgotten() {
        let gate = Gate::new(KEY_ID, SECRET);
        let sealed = sealed_for(TOK, host_id(&HOST_SECRET), NOW + 2 * DAY);
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
        let gate = Gate::new(KEY_ID, SECRET);
        let sealed = sealed_for(TOK, host_id(&HOST_SECRET), NOW);
        assert_eq!(
            gate.check(&wake(&HOST_SECRET, &sealed, NOW, 1), NOW),
            Err(Refusal::Expired)
        );
    }

    #[test]
    fn a_host_gets_one_alert_a_minute_and_thirty_a_day() {
        let gate = Gate::new(KEY_ID, SECRET);
        let sealed = sealed_for(TOK, host_id(&HOST_SECRET), NOW + 2 * DAY);
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
        let gate = Gate::new(KEY_ID, SECRET);
        let other = [8; 32];
        let a = sealed_for(TOK, host_id(&HOST_SECRET), NOW + DAY);
        let b = sealed_for(TOK, host_id(&other), NOW + DAY);
        assert!(gate.check(&wake(&HOST_SECRET, &a, NOW, 1), NOW).is_ok());
        assert_eq!(
            gate.check(&wake(&other, &b, NOW + 1, 2), NOW + 1),
            Err(Refusal::TooMany)
        );
    }

    #[test]
    fn junk_and_oversize_sealed_bytes_are_malformed() {
        let gate = Gate::new(KEY_ID, SECRET);
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
        use kriyon_push_seal::{push_public_key, seal_push_token, sign_wake, PushTokenPlain};
        const OLD: [u8; 32] = [3; 32];
        let retired_at = NOW - 10 * DAY;
        let gate = Gate::new(KEY_ID + 1, SECRET).with_retired(KEY_ID, OLD, retired_at);
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
        let gate = Gate::new(KEY_ID, [9; 32]).with_retired(KEY_ID + 5, SECRET, NOW);
        // Sealed to SECRET, but named as the current key: it doesn't open.
        assert_eq!(gate.check(&good(1), NOW), Err(Refusal::BadToken));
    }

    #[test]
    fn a_wake_up_for_another_sender_key_is_refused() {
        let gate = Gate::new(KEY_ID + 1, SECRET);
        assert_eq!(gate.check(&good(1), NOW), Err(Refusal::UnknownKey));
    }

    #[test]
    fn it_forgets_ids_and_sends_once_they_are_old() {
        let gate = Gate::new(KEY_ID, SECRET);
        assert!(gate.check(&good(1), NOW).is_ok());
        assert_eq!(gate.remembered(), (1, 1, 1));
        let other = [4; 32];
        let token = "cd12cd12cd12cd12cd12cd12cd12cd12cd12cd12cd12cd12cd12cd12cd12cd12";
        let sealed = sealed_for(token, host_id(&other), NOW + 3 * DAY);
        let later = NOW + DAY + 1;
        assert!(gate.check(&wake(&other, &sealed, later, 2), later).is_ok());
        assert_eq!(gate.remembered(), (1, 1, 1), "only the new one kept");
    }

    /// A request id is remembered only once its token opened and named its
    /// signer: junk can't fill the memory, or take a real id first.
    #[test]
    fn a_request_id_counts_only_once_its_token_is_good() {
        let gate = Gate::new(KEY_ID, SECRET);
        // Signed by another host, with this host's token: refused, not kept.
        let sealed = sealed_for(TOK, host_id(&HOST_SECRET), NOW + DAY);
        assert_eq!(
            gate.check(&wake(&[9; 32], &sealed, NOW, 1), NOW),
            Err(Refusal::BadToken)
        );
        assert_eq!(gate.remembered(), (0, 0, 0));
        // The same id, good: sent.
        assert!(gate.check(&good(1), NOW).is_ok());
    }

    /// Replayed at the window's end with a time still within the clock skew:
    /// the id is remembered until that time is past too.
    #[test]
    fn a_request_id_is_kept_until_its_own_time_is_past() {
        let gate = Gate::new(KEY_ID, SECRET);
        let sealed = sealed_for(TOK, host_id(&HOST_SECRET), NOW + 2 * DAY);
        let ahead = wake(&HOST_SECRET, &sealed, NOW + CLOCK_SKEW_SECS, 1);
        assert!(gate.check(&ahead, NOW).is_ok());
        let end = NOW + REPLAY_WINDOW_SECS;
        assert_eq!(gate.check(&ahead, end), Err(Refusal::Replayed));
    }

    /// Anyone can make a host key and seal a token to the sender's public
    /// key, so the limits per host and token aren't enough: alerts a minute
    /// are capped for the whole sender, and so is what it remembers.
    #[test]
    fn alerts_a_minute_and_what_is_remembered_are_capped_overall() {
        let gate = Gate::new(KEY_ID, SECRET).with_caps(Caps {
            alerts_per_minute: 2,
            remembered: 3,
        });
        let host_wake = |n: u8, at: u64| {
            let secret = [n; 32];
            let token = format!("{n:02x}").repeat(32);
            let sealed = sealed_for(&token, host_id(&secret), NOW + 2 * DAY);
            wake(&secret, &sealed, at, n)
        };
        assert!(gate.check(&host_wake(1, NOW), NOW).is_ok());
        assert!(gate.check(&host_wake(2, NOW), NOW).is_ok());
        assert_eq!(gate.check(&host_wake(3, NOW), NOW), Err(Refusal::TooMany));
        let next = NOW + MINUTE;
        assert!(gate.check(&host_wake(4, next), next).is_ok());
        // Three hosts remembered (the cap): a new one makes room, the one
        // heard from longest ago going, so made-up hosts lock nobody out.
        // (Past the ids' window: hosts, kept a day, are what is full.)
        let soon = next + REPLAY_WINDOW_SECS + CLOCK_SKEW_SECS + 1;
        assert!(gate.check(&host_wake(5, soon), soon).is_ok());
        assert_eq!(gate.remembered().1, 3);
    }

    #[test]
    fn a_token_not_shaped_as_its_platform_says_is_refused() {
        let gate = Gate::new(KEY_ID, SECRET);
        let sealed = sealed_for("not hex at all", host_id(&HOST_SECRET), NOW + DAY);
        assert_eq!(
            gate.check(&wake(&HOST_SECRET, &sealed, NOW, 1), NOW),
            Err(Refusal::BadToken)
        );
        assert!(token_shape_ok(Platform::Apns, TOK));
        assert!(!token_shape_ok(Platform::Apns, "ab"));
        assert!(token_shape_ok(Platform::Fcm, "dGVzdA:APA91b-x_y"));
        assert!(!token_shape_ok(Platform::Fcm, "has space"));
        assert!(!token_shape_ok(Platform::Fcm, ""));
    }
}
