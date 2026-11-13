//! Building an iroh endpoint the way the spec asks (§2).

use std::net::SocketAddr;

use iroh::endpoint::{presets, QuicTransportConfig, VarInt};
use iroh::{Endpoint, RelayConfig, RelayMode, RelayUrl, SecretKey};
use kriyon_remote::codec::CodecError;
use kriyon_remote::link_policy::CloseCode;
use kriyon_remote::message::{EndpointId, RefuseReason};

/// The remote protocol, major version 1.
pub const ALPN_REMOTE: &[u8] = b"kriyon/remote/1";

/// Pairing, major version 1.
pub const ALPN_PAIR: &[u8] = b"kriyon/pair/1";

/// The most bidirectional streams on one connection: the control stream and
/// up to 15 session streams.
pub const MAX_STREAMS: u32 = 16;

/// How an endpoint is set up.
#[derive(Clone, Debug)]
pub struct LinkConfig {
    /// The [Device key]'s secret half. Kept by the caller (the OS keychain).
    pub secret_key: [u8; 32],
    /// Where to listen: `0.0.0.0:0` by default, a fixed port for Tailscale,
    /// `127.0.0.1:0` in tests.
    pub bind: SocketAddr,
    /// Our relay and this device's [Relay pass], when the person subscribes;
    /// none otherwise.
    pub relay: Option<RelayAccess>,
}

/// A relay and the pass that lets this device use it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayAccess {
    pub url: RelayUrl,
    /// Opaque: sent to the relay as it is, never read.
    pub pass: String,
}

/// The relay setup for `config`: none, or our relay with the pass as its
/// auth token.
#[must_use]
pub fn relay_mode(config: &LinkConfig) -> RelayMode {
    config.relay.as_ref().map_or(RelayMode::Disabled, |relay| {
        // iroh sends the token as `Authorization: Bearer <pass>`, and reads
        // it once, when the endpoint starts: a new pass needs a new endpoint.
        RelayMode::Custom(
            RelayConfig::from(relay.url.clone())
                .with_auth_token(relay.pass.clone())
                .into(),
        )
    })
}

impl LinkConfig {
    /// Any port on every interface, no relay.
    #[must_use]
    pub fn new(secret_key: [u8; 32]) -> Self {
        Self {
            secret_key,
            bind: SocketAddr::from(([0, 0, 0, 0], 0)),
            relay: None,
        }
    }
}

/// Why a link operation failed.
#[derive(Debug, PartialEq, Eq)]
pub enum LinkError {
    /// The endpoint couldn't be set up.
    Bind(String),
    /// The peer couldn't be reached, or the connection broke.
    Connect(String),
    /// The other side closed the connection, with our code if it sent one.
    Closed(Option<CloseCode>),
    /// The peer sent something the codec refused.
    Protocol(CodecError),
    /// The host refused the request.
    Refused(RefuseReason),
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bind(why) => write!(f, "can't set up the endpoint: {why}"),
            Self::Connect(why) => write!(f, "can't reach the peer: {why}"),
            Self::Closed(code) => write!(f, "connection closed ({code:?})"),
            Self::Protocol(err) => write!(f, "protocol error: {err:?}"),
            Self::Refused(reason) => write!(f, "refused: {reason:?}"),
        }
    }
}

impl std::error::Error for LinkError {}

/// Bind an endpoint for `alpns` (none for a device, which only dials out).
///
/// # Errors
/// [`LinkError::Bind`].
pub async fn bind(config: &LinkConfig, alpns: Vec<Vec<u8>>) -> Result<Endpoint, LinkError> {
    let bind_err = |e: &dyn std::fmt::Display| LinkError::Bind(e.to_string());
    let transport = QuicTransportConfig::builder()
        .max_concurrent_bidi_streams(VarInt::from_u32(MAX_STREAMS))
        .max_concurrent_uni_streams(VarInt::from_u32(0))
        .build();
    let relay = relay_mode(config);
    // The minimal preset: no address lookup of any kind. Devices learn the
    // host's addresses at pairing.
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(&config.secret_key))
        .alpns(alpns)
        .relay_mode(relay)
        // No session tickets, so this endpoint never sends 0-RTT data, which
        // could be replayed. A host never reads a stream before the handshake
        // completes either, so replayed early data from elsewhere is never
        // acted on.
        .max_tls_tickets(0)
        .transport_config(transport)
        .clear_ip_transports()
        .bind_addr(config.bind)
        .map_err(|e| bind_err(&e))?
        .bind()
        .await
        .map_err(|e| bind_err(&e))?;
    Ok(endpoint)
}

/// A new [Device key] secret, from the OS's random source.
#[must_use]
pub fn generate_secret_key() -> [u8; 32] {
    SecretKey::generate().to_bytes()
}

/// The endpoint id (public half) of the [Device key] secret `secret_key`.
#[must_use]
pub fn public_id(secret_key: &[u8; 32]) -> EndpointId {
    *SecretKey::from_bytes(secret_key).public().as_bytes()
}

/// The 32 bytes of an endpoint's id.
#[must_use]
pub fn id_bytes(endpoint: &Endpoint) -> EndpointId {
    *endpoint.id().as_bytes()
}

/// The close code a closed connection carries, if it is one of ours.
#[must_use]
pub fn close_code(error: &iroh::endpoint::ConnectionError) -> Option<CloseCode> {
    match error {
        iroh::endpoint::ConnectionError::ApplicationClosed(close) => {
            CloseCode::from_code(close.error_code.into_inner())
        }
        _ => None,
    }
}

/// Close `connection` with `code`.
pub fn close(connection: &iroh::endpoint::Connection, code: CloseCode) {
    connection.close(VarInt::from_u32(code as u32), b"");
}

/// The [`LinkError`] for a connection that went away.
pub(crate) fn gone(error: &iroh::endpoint::ConnectionError) -> LinkError {
    match close_code(error) {
        Some(code) => LinkError::Closed(Some(code)),
        None => LinkError::Connect(error.to_string()),
    }
}

#[cfg(test)]
mod relay_tests {
    use super::*;

    #[test]
    fn no_relay_unless_one_is_set() {
        assert_eq!(relay_mode(&LinkConfig::new([1; 32])), RelayMode::Disabled);
    }

    #[test]
    fn our_relay_carries_the_pass_untouched_as_its_auth_token() {
        let url: RelayUrl = "https://relay.example.test/".parse().expect("url");
        let pass = "kp1.AQ8eLTxLWml4h5altMPS4fCgmqX0emdZgC_5VfjcLSoUpcmdI76X-GQSf_k4NFWk8AAAAABq96SAAAAAAGsfMYA.vg7dZ8vaIGxbWpMVoOvTHz28Lbk9B9LnD9v15n4spiy5_rxih0c_gDHWoz9M5OnDnn3vuuPcF_qIBrPzSEvMDA";
        let config = LinkConfig {
            relay: Some(RelayAccess {
                url: url.clone(),
                pass: pass.into(),
            }),
            ..LinkConfig::new([1; 32])
        };
        let RelayMode::Custom(map) = relay_mode(&config) else {
            panic!("a custom relay");
        };
        assert_eq!(map.len(), 1);
        let relay = map.get(&url).expect("our relay");
        assert_eq!(relay.auth_token.as_deref(), Some(pass));
    }

    #[test]
    fn a_secret_keys_endpoint_id_is_its_ed25519_public_key() {
        // The device key of the relay contract's test vector.
        let id = public_id(&[0x22; 32]);
        assert_eq!(
            id,
            [
                0xa0, 0x9a, 0xa5, 0xf4, 0x7a, 0x67, 0x59, 0x80, 0x2f, 0xf9, 0x55, 0xf8, 0xdc, 0x2d,
                0x2a, 0x14, 0xa5, 0xc9, 0x9d, 0x23, 0xbe, 0x97, 0xf8, 0x64, 0x12, 0x7f, 0xf9, 0x38,
                0x34, 0x55, 0xa4, 0xf0
            ]
        );
    }
}
