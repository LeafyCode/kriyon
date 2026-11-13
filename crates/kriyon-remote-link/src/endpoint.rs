//! Building an iroh endpoint the way the spec asks (§2).

use std::net::SocketAddr;

use iroh::endpoint::{presets, QuicTransportConfig, VarInt};
use iroh::{Endpoint, RelayMode, RelayUrl, SecretKey};
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
    /// A relay to use, when the person subscribes; none otherwise.
    pub relay_url: Option<RelayUrl>,
}

impl LinkConfig {
    /// Any port on every interface, no relay.
    #[must_use]
    pub fn new(secret_key: [u8; 32]) -> Self {
        Self {
            secret_key,
            bind: SocketAddr::from(([0, 0, 0, 0], 0)),
            relay_url: None,
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
    let relay = config.relay_url.clone().map_or(RelayMode::Disabled, |url| {
        RelayMode::Custom(iroh::RelayMap::from(url))
    });
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
