//! The pairing QR code's contents, to and from iroh's addresses.

use std::net::SocketAddr;

use iroh::{EndpointAddr, PublicKey, RelayUrl, TransportAddr};
use kriyon_remote::message::RefuseReason;
use kriyon_remote::pairing::{PairingInvite, PairingSecret};

use crate::endpoint::LinkError;
use crate::host::Host;

/// The invite for a pairing on `host` with `secret`: its id, every address
/// it listens on, and its relay if it has one.
#[must_use]
pub fn invite(host: &Host, secret: PairingSecret) -> PairingInvite {
    let addr = host.addr();
    let addrs = addr.ip_addrs().map(ToString::to_string).collect();
    let relay_url = addr.relay_urls().next().map(ToString::to_string);
    PairingInvite {
        host_id: host.id(),
        addrs,
        relay_url,
        secret,
    }
}

/// Where to reach the host an invite names.
///
/// # Errors
/// [`LinkError::Refused`] with `OutOfRange` for an invite whose id or
/// addresses don't read.
pub fn host_addr(invite: &PairingInvite) -> Result<EndpointAddr, LinkError> {
    let unreadable = || LinkError::Refused(RefuseReason::OutOfRange);
    let id = PublicKey::from_bytes(&invite.host_id).map_err(|_| unreadable())?;
    let mut addrs = invite
        .addrs
        .iter()
        .map(|addr| addr.parse::<SocketAddr>().map(TransportAddr::Ip))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| unreadable())?;
    if let Some(relay) = &invite.relay_url {
        addrs.push(TransportAddr::Relay(
            relay.parse::<RelayUrl>().map_err(|_| unreadable())?,
        ));
    }
    Ok(EndpointAddr::from_parts(id, addrs))
}
