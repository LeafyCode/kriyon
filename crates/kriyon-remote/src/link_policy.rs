//! The rules the network link follows, kept pure so they're tested without a
//! network (spec §2, §4, §5): close codes, the device's reconnect backoff, its
//! heartbeat watch, the host's limit on handshakes from unpaired devices, and
//! one pending [Pairing].

use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

use crate::message::{EndpointId, RefuseReason, Role};
use crate::pairing::{proof_matches, PairingSecret};

/// Why the host closed a connection, as the QUIC application close code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseCode {
    /// The device isn't paired, or was removed. The device stops retrying.
    NotPaired = 1,
    /// `kriyon/pair/1` while no pairing is pending.
    NoPairing = 2,
    /// A message the codec refused.
    ProtocolError = 3,
    /// The device stopped reading its control stream.
    TooSlow = 4,
    /// The device's protocol is older than the host accepts.
    TooOld = 5,
    /// The host is going away (remote access turned off, app quitting).
    HostClosing = 6,
}

impl CloseCode {
    /// The code a closed connection carries, if it is one of ours.
    #[must_use]
    pub fn from_code(code: u64) -> Option<Self> {
        [
            Self::NotPaired,
            Self::NoPairing,
            Self::ProtocolError,
            Self::TooSlow,
            Self::TooOld,
            Self::HostClosing,
        ]
        .into_iter()
        .find(|known| *known as u64 == code)
    }
}

/// How often the host sends `Heartbeat`.
pub const HEARTBEAT_EVERY: Duration = Duration::from_secs(15);

/// How long a device waits for a heartbeat before it shows "Disconnected,
/// reconnecting" and turns typing off.
pub const HEARTBEAT_LOST_AFTER: Duration = Duration::from_secs(40);

/// The longest wait between reconnects.
pub const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// A device's watch on the host's heartbeat.
#[derive(Clone, Copy, Debug)]
pub struct HeartbeatWatch {
    last: Instant,
    lost_after: Duration,
}

impl HeartbeatWatch {
    /// Start watching on connect.
    #[must_use]
    pub fn new(now: Instant) -> Self {
        Self::with_window(now, HEARTBEAT_LOST_AFTER)
    }

    /// Start watching, counting the host lost after `lost_after` of quiet
    /// instead of [`HEARTBEAT_LOST_AFTER`]: for tests that can't wait 40 s.
    #[must_use]
    pub fn with_window(now: Instant, lost_after: Duration) -> Self {
        Self {
            last: now,
            lost_after,
        }
    }

    /// A heartbeat arrived.
    pub fn beat(&mut self, now: Instant) {
        self.last = self.last.max(now);
    }

    /// No heartbeat for the window (normally [`HEARTBEAT_LOST_AFTER`]).
    #[must_use]
    pub fn lost(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.last) >= self.lost_after
    }
}

/// The device's wait between reconnects: 1 s, doubling to [`MAX_BACKOFF`].
/// A network change or the app coming to the front retries at once (the
/// caller skips the wait); a connection that worked starts it over.
#[derive(Clone, Copy, Debug, Default)]
pub struct Backoff {
    failures: u32,
}

impl Backoff {
    /// How long to wait before the next try, counting this failure.
    pub fn next_delay(&mut self) -> Duration {
        let delay = 1_u64
            .checked_shl(self.failures)
            .map_or(MAX_BACKOFF, Duration::from_secs)
            .min(MAX_BACKOFF);
        self.failures = self.failures.saturating_add(1);
        delay
    }

    /// A connection worked: the next failure waits 1 s again.
    pub fn reset(&mut self) {
        self.failures = 0;
    }
}

/// Counts events per key in a fixed window that starts at the key's first
/// event, and says when a key has had too many. The host feeds it the source address of each handshake it
/// refused as unpaired, and ignores new handshakes from an address over the
/// limit, so a stranger can't make it do handshakes nonstop.
/// How many keys a [`RateLimit`] holds before it drops expired ones.
const PRUNE_AT: usize = 1024;

#[derive(Debug)]
pub struct RateLimit<K> {
    per_window: u32,
    window: Duration,
    seen: HashMap<K, (Instant, u32)>,
}

impl<K: Hash + Eq> RateLimit<K> {
    #[must_use]
    pub fn new(per_window: u32, window: Duration) -> Self {
        Self {
            per_window,
            window,
            seen: HashMap::new(),
        }
    }

    /// Record one event for `key` at `now`.
    pub fn record(&mut self, key: K, now: Instant) {
        let window = self.window;
        // Forget sources whose window is over now and then, so the map stays
        // small without a scan on every event.
        if self.seen.len() >= PRUNE_AT {
            self.seen
                .retain(|_, (start, _)| now.saturating_duration_since(*start) < window);
        }
        let entry = self.seen.entry(key).or_insert((now, 0));
        if now.saturating_duration_since(entry.0) >= window {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(1);
    }

    /// Whether `key` is over the limit at `now`.
    #[must_use]
    pub fn over(&self, key: &K, now: Instant) -> bool {
        self.seen.get(key).is_some_and(|(start, count)| {
            now.saturating_duration_since(*start) < self.window && *count >= self.per_window
        })
    }
}

/// Refusals answered to one device per [`REFUSAL_WINDOW`] (spec §8): past
/// that, a device sending what it may not goes unanswered for a while, so a
/// broken or hostile one can't keep the host busy answering.
pub const REFUSALS_PER_WINDOW: u32 = 20;

/// The window [`REFUSALS_PER_WINDOW`] counts in.
pub const REFUSAL_WINDOW: Duration = Duration::from_secs(10);

/// How long a pairing QR code stays good.
pub const PAIRING_VALID_FOR: Duration = Duration::from_mins(5);

/// Wrong pairing codes before the secret is burned.
pub const CODE_TRIES: u32 = 3;

/// What happened to a code the person typed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodeCheck {
    /// Right: store the device with this role and send `Paired`.
    Paired { device: EndpointId, role: Role },
    /// Wrong; this many tries are left.
    Wrong { tries_left: u32 },
    /// Wrong too often, or the pairing is over: start again with a new QR.
    Burned,
}

/// The one pending [Pairing]: its secret, the role the person chose, and who
/// has taken it.
#[derive(Debug)]
pub struct PendingPairing {
    secret: PairingSecret,
    role: Role,
    expires_at: Instant,
    taken_by: Option<EndpointId>,
    tries_left: u32,
}

impl PendingPairing {
    #[must_use]
    pub fn new(secret: PairingSecret, role: Role, now: Instant) -> Self {
        Self {
            secret,
            role,
            expires_at: now + PAIRING_VALID_FOR,
            taken_by: None,
            tries_left: CODE_TRIES,
        }
    }

    #[must_use]
    pub fn secret(&self) -> &PairingSecret {
        &self.secret
    }

    /// How long the pairing has left at `now`: zero once it expired or was
    /// burned.
    #[must_use]
    pub fn time_left(&self, now: Instant) -> Duration {
        if self.tries_left == 0 {
            return Duration::ZERO;
        }
        self.expires_at.saturating_duration_since(now)
    }

    /// The device whose proof took this pairing, if one has.
    #[must_use]
    pub fn taken_by(&self) -> Option<EndpointId> {
        self.taken_by
    }

    /// Whether the pairing still takes connections.
    #[must_use]
    pub fn open(&self, now: Instant) -> bool {
        now < self.expires_at && self.tries_left > 0
    }

    /// A device sent its proof. The first right one takes the pairing; a
    /// wrong one doesn't use it up.
    ///
    /// # Errors
    /// [`RefuseReason::NotPaired`]: expired, burned, taken by another device,
    /// or a wrong proof.
    pub fn take(
        &mut self,
        device: &EndpointId,
        host: &EndpointId,
        proof: &[u8],
        now: Instant,
    ) -> Result<(), RefuseReason> {
        let free = self.taken_by.is_none_or(|taker| taker == *device);
        if self.open(now) && free && proof_matches(&self.secret, device, host, proof) {
            self.taken_by = Some(*device);
            Ok(())
        } else {
            Err(RefuseReason::NotPaired)
        }
    }

    /// The person typed `entered`; `expected` is the code derived from the
    /// connection of the device that took the pairing.
    pub fn check_code(&mut self, entered: &str, expected: &str, now: Instant) -> CodeCheck {
        let Some(device) = self.taken_by.filter(|_| self.open(now)) else {
            self.tries_left = 0;
            return CodeCheck::Burned;
        };
        if same_code(entered, expected) {
            // Used: nothing else pairs with this secret.
            self.tries_left = 0;
            return CodeCheck::Paired {
                device,
                role: self.role,
            };
        }
        self.tries_left -= 1;
        if self.tries_left == 0 {
            CodeCheck::Burned
        } else {
            CodeCheck::Wrong {
                tries_left: self.tries_left,
            }
        }
    }
}

/// Compare two codes without stopping at the first differing byte.
fn same_code(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0_u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing::pair_proof;

    const HOST: EndpointId = [2; 32];
    const PHONE: EndpointId = [1; 32];
    const THIEF: EndpointId = [9; 32];
    const SECRET: PairingSecret = [7; 32];

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn close_codes_read_back() {
        for code in [
            CloseCode::NotPaired,
            CloseCode::NoPairing,
            CloseCode::ProtocolError,
            CloseCode::TooSlow,
            CloseCode::TooOld,
            CloseCode::HostClosing,
        ] {
            assert_eq!(CloseCode::from_code(code as u64), Some(code));
        }
        assert_eq!(CloseCode::from_code(0), None);
        assert_eq!(CloseCode::from_code(99), None);
    }

    #[test]
    fn a_device_counts_the_host_lost_after_forty_quiet_seconds() {
        let t = Instant::now();
        let mut watch = HeartbeatWatch::new(t);
        assert!(!watch.lost(t + secs(39)));
        watch.beat(t + secs(30));
        assert!(!watch.lost(t + secs(69)));
        assert!(watch.lost(t + secs(70)));
    }

    #[test]
    fn reconnects_back_off_to_thirty_seconds_and_start_over_after_success() {
        let mut backoff = Backoff::default();
        let delays: Vec<u64> = (0..8).map(|_| backoff.next_delay().as_secs()).collect();
        assert_eq!(delays, [1, 2, 4, 8, 16, 30, 30, 30]);
        backoff.reset();
        assert_eq!(backoff.next_delay(), secs(1));
    }

    #[test]
    fn a_source_over_the_limit_is_refused_until_its_minute_passes() {
        let t = Instant::now();
        let mut limit = RateLimit::new(3, secs(60));
        for _ in 0..3 {
            assert!(!limit.over(&"10.0.0.9", t));
            limit.record("10.0.0.9", t);
        }
        assert!(limit.over(&"10.0.0.9", t + secs(59)));
        assert!(!limit.over(&"10.0.0.8", t), "another source is not limited");
        assert!(!limit.over(&"10.0.0.9", t + secs(60)));
        // A new window counts from zero, and the limit applies in it again.
        let later = t + secs(61);
        limit.record("10.0.0.9", later);
        assert!(!limit.over(&"10.0.0.9", later));
        limit.record("10.0.0.9", later);
        limit.record("10.0.0.9", later);
        assert!(limit.over(&"10.0.0.9", later));
    }

    fn proof(device: &EndpointId) -> [u8; 32] {
        pair_proof(&SECRET, device, &HOST)
    }

    #[test]
    fn the_first_right_proof_takes_the_pairing() {
        let t = Instant::now();
        let mut p = PendingPairing::new(SECRET, Role::Controller, t);
        assert!(p.open(t));
        assert_eq!(p.taken_by(), None);
        assert_eq!(p.take(&PHONE, &HOST, &proof(&PHONE), t), Ok(()));
        assert_eq!(p.taken_by(), Some(PHONE));
        // A leaked QR used second gets nothing.
        assert_eq!(
            p.take(&THIEF, &HOST, &proof(&THIEF), t),
            Err(RefuseReason::NotPaired)
        );
    }

    #[test]
    fn a_wrong_proof_does_not_use_up_the_pairing() {
        let t = Instant::now();
        let mut p = PendingPairing::new(SECRET, Role::Viewer, t);
        assert_eq!(
            p.take(&THIEF, &HOST, &[0; 32], t),
            Err(RefuseReason::NotPaired)
        );
        assert_eq!(p.take(&PHONE, &HOST, &proof(&PHONE), t), Ok(()));
    }

    #[test]
    fn a_pairing_expires_after_five_minutes() {
        let t = Instant::now();
        let mut p = PendingPairing::new(SECRET, Role::Viewer, t);
        let late = t + PAIRING_VALID_FOR;
        assert!(!p.open(late));
        assert_eq!(p.time_left(t), PAIRING_VALID_FOR);
        assert_eq!(p.time_left(late), Duration::ZERO);
        assert_eq!(
            p.take(&PHONE, &HOST, &proof(&PHONE), late),
            Err(RefuseReason::NotPaired)
        );
    }

    #[test]
    fn the_right_code_pairs_the_device_with_the_chosen_role() {
        let t = Instant::now();
        let mut p = PendingPairing::new(SECRET, Role::Controller, t);
        p.take(&PHONE, &HOST, &proof(&PHONE), t).expect("taken");
        assert_eq!(
            p.check_code("123456", "123456", t),
            CodeCheck::Paired {
                device: PHONE,
                role: Role::Controller
            }
        );
        assert!(!p.open(t), "used");
    }

    #[test]
    fn three_wrong_codes_burn_the_secret() {
        let t = Instant::now();
        let mut p = PendingPairing::new(SECRET, Role::Controller, t);
        p.take(&PHONE, &HOST, &proof(&PHONE), t).expect("taken");
        assert_eq!(
            p.check_code("000000", "123456", t),
            CodeCheck::Wrong { tries_left: 2 }
        );
        assert_eq!(
            p.check_code("000001", "123456", t),
            CodeCheck::Wrong { tries_left: 1 }
        );
        assert_eq!(p.check_code("000002", "123456", t), CodeCheck::Burned);
        assert_eq!(p.check_code("123456", "123456", t), CodeCheck::Burned);
        assert!(!p.open(t));
    }

    #[test]
    fn a_code_before_any_device_took_the_pairing_pairs_nothing() {
        let t = Instant::now();
        let mut p = PendingPairing::new(SECRET, Role::Controller, t);
        assert_eq!(p.check_code("123456", "123456", t), CodeCheck::Burned);
    }

    #[test]
    fn a_code_after_expiry_pairs_nothing() {
        let t = Instant::now();
        let mut p = PendingPairing::new(SECRET, Role::Controller, t);
        p.take(&PHONE, &HOST, &proof(&PHONE), t).expect("taken");
        assert_eq!(
            p.check_code("123456", "123456", t + PAIRING_VALID_FOR),
            CodeCheck::Burned
        );
    }
}
