//! The network link of Kriyon's remote access (ADR-0057, spec §2, §4, §5),
//! over iroh. What a message means and whether it's allowed is the pure
//! `kriyon-remote` crate's; this crate moves its messages between a [Host]
//! and its [Remote device]s.
//!
//! - [`endpoint`]: an iroh endpoint from a [Device key], with no address
//!   lookup, no relay unless one is given, an optional fixed UDP port, and no
//!   0-RTT.
//! - [`host`]: the accept loop. A peer's id is checked against the [Paired
//!   device]s before any stream is accepted; unpaired handshakes are rate
//!   limited; `kriyon/pair/1` is served only while a pairing is pending.
//! - [`device`]: pairing from the device's side, connecting, and staying
//!   connected with backoff until the host says it is no longer paired.
//! - [`framed`]: messages over a QUIC stream, with the `kriyon-remote` codec.

pub mod device;
pub mod endpoint;
pub mod framed;
pub mod host;

pub use endpoint::{LinkConfig, LinkError, ALPN_PAIR, ALPN_REMOTE};
