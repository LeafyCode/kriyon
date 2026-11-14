//! The pairing QR code's contents, to and from iroh's addresses.

use std::net::{IpAddr, SocketAddr};

use iroh::{EndpointAddr, PublicKey, RelayUrl, TransportAddr};
use kriyon_remote::message::RefuseReason;
use kriyon_remote::pairing::{PairingInvite, PairingSecret};
use kriyon_remote::routes::{self, Ports};

use crate::endpoint::LinkError;
use crate::host::Host;

/// The invite for a pairing on `host` with `secret`: its id, every address
/// it listens on, and its relay if it has one.
#[must_use]
pub fn invite(host: &Host, secret: PairingSecret) -> PairingInvite {
    invite_on(host, secret, &[])
}

/// [`invite`], with this computer's Tailscale addresses (`tailscale`, from
/// [`tailscale_ips`]) on the port the host listens on: a device on the same
/// tailnet dials them directly, from any network.
#[must_use]
pub fn invite_on(host: &Host, secret: PairingSecret, tailscale: &[IpAddr]) -> PairingInvite {
    let addr = host.addr();
    let reported: Vec<SocketAddr> = addr.ip_addrs().copied().collect();
    let addrs = routes::invite_addrs(&reported, tailscale, Ports::of(&host.bound_sockets()));
    let relay_url = addr.relay_urls().next().map(ToString::to_string);
    PairingInvite {
        host_id: host.id(),
        addrs,
        relay_url,
        secret,
    }
}

/// This computer's Tailscale addresses, read from its network interfaces
/// that are up (`routes::is_tailscale`): no Tailscale API or command.
pub async fn tailscale_ips() -> Vec<IpAddr> {
    let state = netwatch::interfaces::State::new().await;
    let mut ips: Vec<IpAddr> = state
        .interfaces
        .values()
        .filter(|interface| interface.is_up())
        .flat_map(|interface| interface.addrs().map(|net| net.addr()).collect::<Vec<_>>())
        .filter(|ip| routes::is_tailscale(*ip))
        .collect();
    ips.sort();
    ips.dedup();
    ips
}

/// Where to reach the host an invite names.
///
/// # Errors
/// [`LinkError::Refused`] with `OutOfRange` for an invite whose id or
/// addresses don't read.
pub fn host_addr(invite: &PairingInvite) -> Result<EndpointAddr, LinkError> {
    endpoint_addr(&invite.host_id, &invite.addrs, invite.relay_url.as_deref())
}

/// A host's address from what a device keeps of it: its id, the addresses
/// (`ip:port`) and the relay it gave at pairing.
///
/// # Errors
/// [`LinkError::Refused`] with `OutOfRange` for parts that don't read.
pub fn endpoint_addr(
    host_id: &[u8; 32],
    addrs: &[String],
    relay_url: Option<&str>,
) -> Result<EndpointAddr, LinkError> {
    let unreadable = || LinkError::Refused(RefuseReason::OutOfRange);
    let id = PublicKey::from_bytes(host_id).map_err(|_| unreadable())?;
    let mut addrs = addrs
        .iter()
        .map(|addr| addr.parse::<SocketAddr>().map(TransportAddr::Ip))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| unreadable())?;
    if let Some(relay) = relay_url {
        addrs.push(TransportAddr::Relay(
            relay.parse::<RelayUrl>().map_err(|_| unreadable())?,
        ));
    }
    Ok(EndpointAddr::from_parts(id, addrs))
}
