//! The ways a device reaches a host (spec §2): this network, Tailscale, our
//! relay. Here, the rules for the direct ones: which address is a Tailscale
//! one, and which addresses a pairing invite lists.

use std::net::{IpAddr, SocketAddr};

/// The UDP port a host listens on unless the person picks another: fixed,
/// so an address a device stored at pairing still works after the host
/// restarts, and in the dynamic range (49152–65535).
pub const DEFAULT_PORT: u16 = 49_731;

/// The lowest port a person may choose: the ones below are the system's.
pub const LOWEST_PORT: u16 = 1024;

/// A port a person chose for remote access, or why it can't be one.
///
/// # Errors
/// A port below [`LOWEST_PORT`], in words.
pub fn check_port(port: u16) -> Result<u16, String> {
    if port < LOWEST_PORT {
        return Err(format!(
            "Choose a port from {LOWEST_PORT} to 65535: the lower ones are the system's."
        ));
    }
    Ok(port)
}

/// Whether `ip` is one Tailscale gives its devices: `100.64.0.0/10` (the
/// shared address space it takes its IPv4 addresses from) or
/// `fd7a:115c:a1e0::/48` (its IPv6 prefix). Read from the address alone: no
/// Tailscale API or command is asked.
#[must_use]
pub fn is_tailscale(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            a == 100 && (64..128).contains(&b)
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0
        }
    }
}

/// The addresses a pairing invite lists: those the endpoint reported, then
/// each of this computer's Tailscale addresses (`tailscale`, from its
/// interfaces) on the port the endpoint listens on for that family, each
/// once. A Tailscale address on a family the endpoint doesn't listen on is
/// left out: nothing would answer there.
#[must_use]
pub fn invite_addrs(reported: &[SocketAddr], tailscale: &[IpAddr], ports: Ports) -> Vec<String> {
    let mut addrs: Vec<SocketAddr> = Vec::new();
    let mut add = |addr: SocketAddr| {
        if !addrs.contains(&addr) {
            addrs.push(addr);
        }
    };
    for addr in reported {
        add(*addr);
    }
    for ip in tailscale.iter().copied().filter(|ip| is_tailscale(*ip)) {
        let port = if ip.is_ipv4() { ports.v4 } else { ports.v6 };
        if let Some(port) = port {
            add(SocketAddr::new(ip, port));
        }
    }
    addrs.iter().map(ToString::to_string).collect()
}

/// The ports an endpoint listens on, by family; `None` for one it doesn't.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Ports {
    pub v4: Option<u16>,
    pub v6: Option<u16>,
}

impl Ports {
    /// The ports of `bound`, an endpoint's sockets.
    #[must_use]
    pub fn of(bound: &[SocketAddr]) -> Self {
        Self {
            v4: bound
                .iter()
                .find(|addr| addr.is_ipv4())
                .map(SocketAddr::port),
            v6: bound
                .iter()
                .find(|addr| addr.is_ipv6())
                .map(SocketAddr::port),
        }
    }
}

/// How long devices may reach a host only through the relay before it looks
/// as if direct links are blocked: a direct path forms within seconds where
/// the network allows one.
pub const RELAY_ONLY_WAIT: std::time::Duration = std::time::Duration::from_secs(120);

/// Whether a host's links to its devices ever ran direct since remote access
/// came on: if devices have reached it only through the relay for
/// [`RELAY_ONLY_WAIT`], something (Windows Defender Firewall, a network that
/// keeps devices apart) may be blocking direct links. A device on another
/// network relays anyway, so this is a hint, never a fault.
#[derive(Clone, Copy, Debug, Default)]
pub struct DirectWatch {
    direct_seen: bool,
    relay_since: Option<std::time::Instant>,
}

impl DirectWatch {
    /// A link to a device runs over `path` at `now`.
    pub fn note(&mut self, path: crate::device_view::LinkPath, now: std::time::Instant) {
        match path {
            crate::device_view::LinkPath::Direct => self.direct_seen = true,
            crate::device_view::LinkPath::Relay => {
                self.relay_since.get_or_insert(now);
            }
        }
    }

    /// Whether direct links look blocked at `now`.
    #[must_use]
    pub fn blocked(&self, now: std::time::Instant) -> bool {
        !self.direct_seen
            && self
                .relay_since
                .is_some_and(|since| now.saturating_duration_since(since) >= RELAY_ONLY_WAIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Links that have only ever run through the relay, for long enough,
    /// look blocked; one direct path since says nothing is.
    #[test]
    fn links_only_ever_through_the_relay_look_blocked_after_a_while() {
        use crate::device_view::LinkPath;
        use std::time::{Duration, Instant};
        let t = Instant::now();
        let mut watch = DirectWatch::default();
        assert!(!watch.blocked(t), "no link yet");
        watch.note(LinkPath::Relay, t);
        assert!(
            !watch.blocked(t + RELAY_ONLY_WAIT.saturating_sub(Duration::from_secs(1))),
            "not yet"
        );
        assert!(
            watch.blocked(t + RELAY_ONLY_WAIT),
            "only the relay, for long enough"
        );
        // A direct path since: the network lets links through.
        watch.note(LinkPath::Direct, t + RELAY_ONLY_WAIT);
        assert!(!watch.blocked(t + RELAY_ONLY_WAIT * 10));
        watch.note(LinkPath::Relay, t + RELAY_ONLY_WAIT * 10);
        assert!(
            !watch.blocked(t + RELAY_ONLY_WAIT * 20),
            "it went direct once"
        );
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().expect("an address")
    }

    #[test]
    fn a_chosen_port_is_one_the_system_leaves_to_programs() {
        assert_eq!(check_port(DEFAULT_PORT), Ok(DEFAULT_PORT));
        assert_eq!(check_port(1024), Ok(1024));
        assert_eq!(check_port(65535), Ok(65535));
        for low in [0, 22, 1023] {
            assert!(check_port(low).is_err(), "{low}");
        }
    }

    #[test]
    fn tailscale_addresses_are_its_two_ranges_and_nothing_else() {
        for yes in [
            "100.64.0.1",
            "100.101.102.103",
            "100.127.255.254",
            "fd7a:115c:a1e0::1",
        ] {
            assert!(is_tailscale(ip(yes)), "{yes}");
        }
        for no in [
            "100.63.255.255",
            "100.128.0.1",
            "192.168.1.20",
            "10.0.0.2",
            "fd7a:115c:a1e1::1",
            "fe80::1",
            "::1",
        ] {
            assert!(!is_tailscale(ip(no)), "{no}");
        }
    }

    #[test]
    fn an_invite_lists_the_endpoints_addresses_then_tailscales_on_its_port() {
        let reported: Vec<SocketAddr> = vec!["192.168.1.20:49731".parse().expect("addr")];
        let ports = Ports::of(&["0.0.0.0:49731".parse().expect("addr")]);
        let addrs = invite_addrs(
            &reported,
            &[
                ip("100.101.102.103"),
                // Not Tailscale's: left to what the endpoint reported.
                ip("10.0.0.2"),
                // No IPv6 socket: nothing would answer.
                ip("fd7a:115c:a1e0::5"),
            ],
            ports,
        );
        assert_eq!(addrs, ["192.168.1.20:49731", "100.101.102.103:49731"]);
        // An address the endpoint reported already is listed once.
        let again = invite_addrs(
            &["100.101.102.103:49731".parse().expect("addr")],
            &[ip("100.101.102.103")],
            ports,
        );
        assert_eq!(again, ["100.101.102.103:49731"]);
        // With IPv6 too.
        let both = Ports::of(&[
            "0.0.0.0:49731".parse().expect("addr"),
            "[::]:49732".parse().expect("addr"),
        ]);
        assert_eq!(
            invite_addrs(&[], &[ip("fd7a:115c:a1e0::5")], both),
            ["[fd7a:115c:a1e0::5]:49732"]
        );
    }
}
