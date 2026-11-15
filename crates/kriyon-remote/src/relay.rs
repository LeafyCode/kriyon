//! Our relay, as the app sees it (the [Relay pass] contract,
//! `docs/superpowers/specs/2026-11-13-relay-pass-contract.md`): what each
//! refusal from the `BisBig` API or the relay means for the app, when a pass is
//! due, and when the endpoint is rebuilt to use it. Pure: the HTTP calls and
//! the endpoint are the app's.

use std::time::Duration;

/// How long before a pass expires the endpoint is rebuilt with a new one even
/// while someone is watching a session.
pub const FORCE_REBUILD_UNDER: Duration = Duration::from_hours(7 * 24);

/// A refusal from the `BisBig` API, by its HTTP status and error `code`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiRefusal {
    /// Sign in again.
    SignedOut,
    /// No subscription: offer to subscribe.
    NoSubscription,
    /// The relay account is suspended.
    AccountBlocked,
    /// This device was removed from the relay account.
    DeviceRemoved,
    /// The device isn't registered: register it, then ask again.
    DeviceUnknown,
    /// The relay account already has 10 devices.
    DeviceLimit,
    /// The app sent something the API refused: a bug, logged.
    Invalid,
    /// Anything else: the API is down or changed. Keep the pass we have.
    Unavailable,
}

impl ApiRefusal {
    /// The refusal an HTTP `status` with error `code` means.
    #[must_use]
    pub fn from_reply(status: u16, code: Option<&str>) -> Self {
        match (status, code) {
            (401, _) => Self::SignedOut,
            (402, Some("RELAY_NO_SUBSCRIPTION")) => Self::NoSubscription,
            (403, Some("RELAY_ACCOUNT_BLOCKED")) => Self::AccountBlocked,
            (403, Some("RELAY_DEVICE_REMOVED")) => Self::DeviceRemoved,
            (404, Some("RELAY_DEVICE_UNKNOWN")) => Self::DeviceUnknown,
            (409, Some("RELAY_DEVICE_LIMIT")) => Self::DeviceLimit,
            (400, Some("VALIDATION_ERROR")) => Self::Invalid,
            _ => Self::Unavailable,
        }
    }

    /// What the app tells the person, or `None` when it acts instead.
    #[must_use]
    pub fn message(self) -> Option<&'static str> {
        match self {
            Self::SignedOut => Some("Sign in again"),
            Self::NoSubscription => Some("Our relay needs a subscription"),
            Self::AccountBlocked => Some("Relay access is suspended for this account"),
            Self::DeviceRemoved => Some("This device was removed from your relay account"),
            Self::DeviceLimit => Some("You already use 10 devices. Remove one first"),
            Self::DeviceUnknown | Self::Invalid | Self::Unavailable => None,
        }
    }
}

/// What the app does about a refusal from the relay itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelayAction {
    /// Fetch a new pass and rebuild the endpoint.
    Renew,
    /// Ask `/status` and show what it says.
    CheckStatus,
    /// Say this device was removed; offer to register it again.
    Removed,
    /// Say too many devices are connected; try again later.
    RetryLater,
    /// The relay turned the pass away before its handshake (HTTP 401): a
    /// bug at the pass issuer's end. Report it; a new pass wouldn't help, so no loop.
    Report,
}

impl RelayAction {
    /// The action for a relay's refusal `reason`
    /// (`RelayStatus::auth_denied_reason()`); `None` for a refusal before the
    /// handshake, which gives no reason.
    #[must_use]
    pub fn from_reason(reason: Option<&str>) -> Self {
        match reason {
            None => Self::Report,
            Some("pass-expired" | "pass-wrong-device") => Self::Renew,
            Some("device-removed") => Self::Removed,
            Some("device-limit") => Self::RetryLater,
            // `account-blocked`, and any reason added later.
            Some(_) => Self::CheckStatus,
        }
    }

    /// What the relay's connection status calls for: its refusal `reason`,
    /// else the text of its last `error`. A refusal before the handshake has
    /// no reason, only an HTTP 401 in the upgrade error; any other error is the
    /// network's, which iroh retries by itself, so it calls for nothing.
    #[must_use]
    pub fn from_status(reason: Option<&str>, error: Option<&str>) -> Option<Self> {
        match (reason, error) {
            (Some(reason), _) => Some(Self::from_reason(Some(reason))),
            // iroh's error text isn't stable; this only picks the message.
            // iroh-relay's own words for an HTTP status on the relay
            // connection's upgrade.
            (None, Some(error)) if error.contains("Unexpected status during upgrade: 401") => {
                Some(Self::Report)
            }
            _ => None,
        }
    }
}

/// What one poll of the device-code token endpoint said.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignInPoll {
    /// Signed in.
    Token(String),
    /// Not approved yet: ask again after the interval.
    Pending,
    /// Asked too often: wait longer.
    SlowDown,
    /// The person said no.
    Denied,
    /// The code ran out: start again.
    Expired,
}

impl SignInPoll {
    /// What a reply with this OAuth `error` (or the `access_token`) means.
    #[must_use]
    pub fn from_reply(access_token: Option<&str>, error: Option<&str>) -> Self {
        if let Some(token) = access_token {
            return Self::Token(token.to_string());
        }
        match error {
            Some("authorization_pending") => Self::Pending,
            Some("slow_down") => Self::SlowDown,
            Some("access_denied") => Self::Denied,
            // `expired_token`, or anything the spec doesn't name: start again.
            _ => Self::Expired,
        }
    }
}

/// An API time (`2026-12-14T00:00:00.000Z`: UTC, optional fraction) as Unix
/// seconds; `None` for anything else.
#[must_use]
pub fn parse_utc(text: &str) -> Option<u64> {
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let time = time.split_once('.').map_or(time, |(whole, _)| whole);
    let mut date = date.split('-').map(str::parse::<u64>);
    let mut time = time.split(':').map(str::parse::<u64>);
    let (year, month, day) = (date.next()?.ok()?, date.next()?.ok()?, date.next()?.ok()?);
    let (hour, minute, second) = (time.next()?.ok()?, time.next()?.ok()?, time.next()?.ok()?);
    if date.next().is_some()
        || time.next().is_some()
        || !(1970..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // Days from 1970-01-01 (Howard Hinnant's days-from-civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = (era * 146_097 + doe).checked_sub(719_468)?;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}

/// Whether to fetch a new pass: none yet, or `renew_after` has passed.
#[must_use]
pub fn pass_due(now_s: u64, renew_after_s: Option<u64>) -> bool {
    renew_after_s.is_none_or(|after| now_s >= after)
}

/// Whether to rebuild the endpoint so it uses the newest pass: a newer pass
/// than the one in use is waiting, and it is a quiet moment (no device stream
/// open, nothing watched) or the pass in use has under
/// [`FORCE_REBUILD_UNDER`] left.
#[must_use]
pub fn rebuild_due(
    now_s: u64,
    in_use_expires_s: Option<u64>,
    newer_waiting: bool,
    quiet: bool,
) -> bool {
    let running_low = in_use_expires_s
        .is_none_or(|expires| expires.saturating_sub(now_s) < FORCE_REBUILD_UNDER.as_secs());
    newer_waiting && (quiet || running_low)
}

/// Whether an address the app speaks to (the relay's API, the relay in a
/// pass, the push sender) may be used: `https` always; plain `http` only to
/// this machine (`localhost`, a loopback address: a local test server), or,
/// in a `debug` build, to a private address on the local network. Anything
/// else could be read or changed on the way.
#[must_use]
pub fn url_allowed(url: &str, debug: bool) -> bool {
    let host_of = |rest: &str| -> Option<String> {
        let authority = rest.split(['/', '?', '#']).next()?;
        let host = if let Some(bracketed) = authority.strip_prefix('[') {
            bracketed.split(']').next()?
        } else {
            authority.split(':').next()?
        };
        (!host.is_empty()).then(|| host.to_ascii_lowercase())
    };
    if let Some(rest) = url.strip_prefix("https://") {
        return host_of(rest).is_some();
    }
    let Some(host) = url.strip_prefix("http://").and_then(host_of) else {
        return false;
    };
    if host == "localhost" {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) if ip.is_loopback() => true,
        Ok(std::net::IpAddr::V4(ip)) => debug && ip.is_private(),
        Ok(std::net::IpAddr::V6(ip)) => debug && (ip.segments()[0] & 0xfe00) == 0xfc00,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_or_this_machine_is_spoken_to_and_the_lan_only_in_a_debug_build() {
        for ok in [
            "https://api.example.test",
            "https://relay.example.test/",
            "http://localhost:4001",
            "http://127.0.0.1:4001/api",
            "http://[::1]:4001",
        ] {
            assert!(url_allowed(ok, false), "{ok}");
        }
        for lan in [
            "http://192.168.1.12:4001",
            "http://10.0.2.2:4001",
            "http://172.16.0.5",
        ] {
            assert!(!url_allowed(lan, false), "{lan} in a release build");
            assert!(url_allowed(lan, true), "{lan} in a debug build");
        }
        for bad in [
            "http://api.example.test",
            "http://8.8.8.8",
            "ftp://api.example.test",
            "api.example.test",
            "https://",
            "http://localhost.example.test",
        ] {
            assert!(!url_allowed(bad, true), "{bad}");
        }
    }

    #[test]
    fn each_api_refusal_in_the_contract_maps_to_its_action() {
        let table = [
            (401, Some("UNAUTHORIZED"), ApiRefusal::SignedOut),
            (
                402,
                Some("RELAY_NO_SUBSCRIPTION"),
                ApiRefusal::NoSubscription,
            ),
            (
                403,
                Some("RELAY_ACCOUNT_BLOCKED"),
                ApiRefusal::AccountBlocked,
            ),
            (403, Some("RELAY_DEVICE_REMOVED"), ApiRefusal::DeviceRemoved),
            (404, Some("RELAY_DEVICE_UNKNOWN"), ApiRefusal::DeviceUnknown),
            (409, Some("RELAY_DEVICE_LIMIT"), ApiRefusal::DeviceLimit),
            (400, Some("VALIDATION_ERROR"), ApiRefusal::Invalid),
            // A 401 means signed out whatever its body says.
            (401, None, ApiRefusal::SignedOut),
            (500, Some("INTERNAL"), ApiRefusal::Unavailable),
            (503, None, ApiRefusal::Unavailable),
            (403, Some("SOMETHING_NEW"), ApiRefusal::Unavailable),
        ];
        for (status, code, want) in table {
            assert_eq!(
                ApiRefusal::from_reply(status, code),
                want,
                "{status} {code:?}"
            );
        }
    }

    #[test]
    fn the_contracts_words_are_what_the_person_sees() {
        assert_eq!(
            ApiRefusal::NoSubscription.message(),
            Some("Our relay needs a subscription")
        );
        assert_eq!(
            ApiRefusal::DeviceLimit.message(),
            Some("You already use 10 devices. Remove one first")
        );
        assert_eq!(
            ApiRefusal::DeviceRemoved.message(),
            Some("This device was removed from your relay account")
        );
        assert_eq!(
            ApiRefusal::AccountBlocked.message(),
            Some("Relay access is suspended for this account")
        );
        assert_eq!(ApiRefusal::SignedOut.message(), Some("Sign in again"));
        assert_eq!(
            ApiRefusal::DeviceUnknown.message(),
            None,
            "acted on, not shown"
        );
    }

    #[test]
    fn each_relay_reason_in_the_contract_maps_to_its_action() {
        let table = [
            (Some("pass-expired"), RelayAction::Renew),
            (Some("pass-wrong-device"), RelayAction::Renew),
            (Some("account-blocked"), RelayAction::CheckStatus),
            (Some("device-removed"), RelayAction::Removed),
            (Some("device-limit"), RelayAction::RetryLater),
            // An unknown reason is treated like account-blocked.
            (Some("a-reason-added-later"), RelayAction::CheckStatus),
            // No reason: refused before the handshake.
            (None, RelayAction::Report),
        ];
        for (reason, want) in table {
            assert_eq!(RelayAction::from_reason(reason), want, "{reason:?}");
        }
    }

    #[test]
    fn a_sign_in_poll_reads_the_oauth_reply() {
        assert_eq!(
            SignInPoll::from_reply(Some("tok"), None),
            SignInPoll::Token("tok".into())
        );
        let table = [
            ("authorization_pending", SignInPoll::Pending),
            ("slow_down", SignInPoll::SlowDown),
            ("access_denied", SignInPoll::Denied),
            ("expired_token", SignInPoll::Expired),
            ("unknown_error", SignInPoll::Expired),
        ];
        for (error, want) in table {
            assert_eq!(SignInPoll::from_reply(None, Some(error)), want, "{error}");
        }
    }

    #[test]
    fn a_pass_is_due_when_there_is_none_or_renew_after_has_passed() {
        assert!(pass_due(100, None));
        assert!(!pass_due(100, Some(200)));
        assert!(pass_due(200, Some(200)));
    }

    #[test]
    fn the_endpoint_is_rebuilt_at_a_quiet_moment_or_when_the_pass_runs_low() {
        let week = FORCE_REBUILD_UNDER.as_secs();
        let now = 1_000_000;
        let far = Some(now + 20 * 24 * 3600);
        assert!(!rebuild_due(now, far, false, true), "nothing newer");
        assert!(rebuild_due(now, far, true, true), "newer, and quiet");
        assert!(
            !rebuild_due(now, far, true, false),
            "newer, but someone watches"
        );
        assert!(
            rebuild_due(now, Some(now + week - 1), true, false),
            "under a week left"
        );
        assert!(rebuild_due(now, None, true, false), "no pass in use yet");
    }

    #[test]
    fn the_apis_times_read_as_unix_seconds() {
        assert_eq!(parse_utc("2026-12-14T00:00:00.000Z"), Some(1_797_206_400));
        assert_eq!(parse_utc("2026-11-15T00:00:00.000Z"), Some(1_794_700_800));
        assert_eq!(parse_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_utc("2000-02-29T12:34:56Z"), Some(951_827_696));
        assert_eq!(
            parse_utc("2026-12-14 00:00:00"),
            None,
            "not the API's format"
        );
        assert_eq!(parse_utc("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_utc(""), None);
    }

    #[test]
    fn a_relay_status_calls_for_action_only_when_the_relay_refused() {
        assert_eq!(
            RelayAction::from_status(Some("pass-expired"), Some("denied: pass-expired")),
            Some(RelayAction::Renew)
        );
        assert_eq!(
            RelayAction::from_status(
                None,
                Some("dial: Unexpected status during upgrade: 401 Unauthorized")
            ),
            Some(RelayAction::Report)
        );
        assert_eq!(
            RelayAction::from_status(None, Some("connect to 10.0.4.101:4010 timed out")),
            None,
            "a 401 in an address is not a refusal"
        );
        assert_eq!(
            RelayAction::from_status(None, Some("connection timed out")),
            None
        );
        assert_eq!(RelayAction::from_status(None, None), None, "connected");
    }
}
