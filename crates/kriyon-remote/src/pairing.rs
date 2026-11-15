//! [Pairing] crypto (spec §4), with fixed test vectors in `tests/vectors.json`
//! so the phone library can check its numbers against the same file.
//!
//! - The device proves it scanned the QR code:
//!   `HMAC-SHA256(secret, "kriyon pair v1" || device_id || host_id)`, which the
//!   host checks in constant time.
//! - Both ends derive the 6-digit [Pairing code] from the connection's
//!   exported keying material: label [`EXPORTER_LABEL`], context
//!   `host_id || device_id || SHA-256(secret)`, [`EXPORTED_LEN`] bytes read as
//!   a big-endian u64, mod 10^6, zero-padded. The export itself is the
//!   connection's (Step B); this is what goes in and what comes out.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::message::{EndpointId, RefuseReason};

/// The pairing secret in the QR code.
pub type PairingSecret = [u8; 32];

/// What the proof's HMAC covers first.
pub const PROOF_MESSAGE: &[u8] = b"kriyon pair v1";

/// The keying-material exporter's label.
pub const EXPORTER_LABEL: &[u8] = b"EXPERIMENTAL kriyon pairing v1";

/// How many exported bytes make the pairing code.
pub const EXPORTED_LEN: usize = 8;

/// The longest device name a host keeps, in bytes.
pub const MAX_DEVICE_NAME: usize = 64;

/// The proof a device sends in `PairRequest`.
#[must_use]
pub fn pair_proof(
    secret: &PairingSecret,
    device_id: &EndpointId,
    host_id: &EndpointId,
) -> [u8; 32] {
    proof_mac(secret, device_id, host_id)
        .finalize()
        .into_bytes()
        .into()
}

fn proof_mac(secret: &PairingSecret, device_id: &EndpointId, host_id: &EndpointId) -> Hmac<Sha256> {
    // HMAC pads a key shorter than its 64-byte block with zeros (RFC 2104),
    // so padding it here gives the same MAC through the constructor that
    // can't fail.
    let mut key = [0_u8; 64];
    key[..secret.len()].copy_from_slice(secret);
    let mut mac = <Hmac<Sha256> as hmac::digest::KeyInit>::new(&key.into());
    mac.update(PROOF_MESSAGE);
    mac.update(device_id);
    mac.update(host_id);
    mac
}

/// Whether `proof` is right, compared in constant time.
#[must_use]
pub fn proof_matches(
    secret: &PairingSecret,
    device_id: &EndpointId,
    host_id: &EndpointId,
    proof: &[u8],
) -> bool {
    proof_mac(secret, device_id, host_id)
        .verify_slice(proof)
        .is_ok()
}

/// The exporter context for the pairing code.
#[must_use]
pub fn exporter_context(
    host_id: &EndpointId,
    device_id: &EndpointId,
    secret: &PairingSecret,
) -> Vec<u8> {
    let mut context = Vec::with_capacity(96);
    context.extend_from_slice(host_id);
    context.extend_from_slice(device_id);
    context.extend_from_slice(&Sha256::digest(secret));
    context
}

/// The 6-digit pairing code from the exported bytes.
#[must_use]
pub fn pairing_code(exported: &[u8; EXPORTED_LEN]) -> String {
    format!("{:06}", u64::from_be_bytes(*exported) % 1_000_000)
}

/// Check the name a device gives itself: not empty, at most
/// [`MAX_DEVICE_NAME`] bytes, nothing that fakes or hides text (it is shown on
/// the host as "named by the device"). See [`crate::text::check_shown_text`].
///
/// # Errors
/// [`RefuseReason::OutOfRange`].
pub fn check_device_name(name: &str) -> Result<(), RefuseReason> {
    crate::text::check_shown_text(name, MAX_DEVICE_NAME)
}

/// What the pairing QR code carries: how to reach the host, and the secret.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PairingInvite {
    pub host_id: EndpointId,
    /// Socket addresses the host listens on (`ip:port`), LAN and Tailscale.
    pub addrs: Vec<String>,
    /// The relay to use, when the person subscribes.
    pub relay_url: Option<String>,
    pub secret: PairingSecret,
}

/// What a pairing QR code's text starts with; the number is the format's
/// version.
pub const INVITE_PREFIX: &str = "kriyon-pair:1:";

impl PairingInvite {
    /// The QR code's text: [`INVITE_PREFIX`] then the invite's postcard bytes
    /// in hex.
    #[must_use]
    pub fn to_qr_text(&self) -> String {
        use std::fmt::Write as _;
        // A struct of byte arrays, strings and an option always encodes.
        let bytes = postcard::to_allocvec(self).unwrap_or_default();
        bytes.iter().fold(INVITE_PREFIX.to_string(), |mut text, b| {
            let _ = write!(text, "{b:02x}");
            text
        })
    }

    /// Read a QR code's text back.
    ///
    /// # Errors
    /// [`RefuseReason::OutOfRange`] for text that isn't a pairing invite.
    pub fn from_qr_text(text: &str) -> Result<Self, RefuseReason> {
        let hex = text
            .strip_prefix(INVITE_PREFIX)
            .filter(|hex| hex.len() % 2 == 0 && hex.is_ascii())
            .ok_or(RefuseReason::OutOfRange)?;
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
            .map_err(|_| RefuseReason::OutOfRange)?;
        postcard::from_bytes(&bytes).map_err(|_| RefuseReason::OutOfRange)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: PairingSecret = [7; 32];
    const DEVICE: EndpointId = [1; 32];
    const HOST: EndpointId = [2; 32];

    #[test]
    fn an_invite_reads_back_from_its_qr_text() {
        let invite = PairingInvite {
            host_id: HOST,
            addrs: vec!["192.168.1.20:41641".into(), "100.64.0.7:41641".into()],
            relay_url: None,
            secret: SECRET,
        };
        let text = invite.to_qr_text();
        assert!(text.starts_with(INVITE_PREFIX));
        assert!(text[INVITE_PREFIX.len()..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit()));
        assert_eq!(PairingInvite::from_qr_text(&text), Ok(invite));
    }

    #[test]
    fn text_that_is_not_an_invite_is_refused() {
        for bad in [
            "",
            "https://example.com",
            "kriyon-pair:2:00",
            "kriyon-pair:1:zz",
            "kriyon-pair:1:0",
            "kriyon-pair:1:00",
        ] {
            assert_eq!(
                PairingInvite::from_qr_text(bad),
                Err(RefuseReason::OutOfRange),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_right_proof_matches() {
        let proof = pair_proof(&SECRET, &DEVICE, &HOST);
        assert!(proof_matches(&SECRET, &DEVICE, &HOST, &proof));
    }

    #[test]
    fn a_proof_for_another_secret_device_or_host_does_not() {
        let proof = pair_proof(&SECRET, &DEVICE, &HOST);
        assert!(!proof_matches(&[8; 32], &DEVICE, &HOST, &proof));
        assert!(!proof_matches(&SECRET, &HOST, &HOST, &proof));
        assert!(!proof_matches(&SECRET, &DEVICE, &DEVICE, &proof));
        assert!(!proof_matches(&SECRET, &DEVICE, &HOST, &proof[..31]));
        assert!(!proof_matches(&SECRET, &DEVICE, &HOST, &[]));
    }

    #[test]
    fn the_code_is_six_digits_with_leading_zeros() {
        assert_eq!(pairing_code(&[0; 8]), "000000");
        assert_eq!(pairing_code(&1_000_007_u64.to_be_bytes()), "000007");
        assert_eq!(pairing_code(&999_999_u64.to_be_bytes()), "999999");
    }

    #[test]
    fn the_exporter_context_is_host_then_device_then_the_secret_hash() {
        let ctx = exporter_context(&HOST, &DEVICE, &SECRET);
        assert_eq!(ctx.len(), 96);
        assert_eq!(&ctx[..32], &HOST);
        assert_eq!(&ctx[32..64], &DEVICE);
        assert_ne!(&ctx[64..], &SECRET, "the secret itself never goes in");
    }

    #[test]
    fn a_device_name_must_be_short_plain_text() {
        assert_eq!(check_device_name("Pubudu's iPhone"), Ok(()));
        assert_eq!(check_device_name(&"é".repeat(32)), Ok(()), "64 bytes");
        for bad in [
            "",
            &"a".repeat(65),
            "phone\nAllow everything",
            "a\u{1b}[2J",
            "iPhone\u{2028}Verified by Kriyon",
            "iPhone\u{202e}gnorw",
            "i\u{200b}Phone",
            "\u{feff}iPhone",
            "iPhone\u{2066}x",
        ] {
            assert_eq!(
                check_device_name(bad),
                Err(RefuseReason::OutOfRange),
                "{bad:?}"
            );
        }
    }
}
