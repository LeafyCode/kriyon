//! Push without stored tokens (spec §10): the phone seals its push token to
//! the push sender's key, once per host; the host signs each wake-up it asks
//! the sender for; the sender checks the signature, opens the token in
//! memory, sends one alert and forgets it.
//!
//! The wire shapes here are pinned by `tests/push_vectors.json`, made by an
//! independent Python implementation the phone library also checks against.

use hpke::aead::ChaCha20Poly1305;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, Kem as _, OpModeR, OpModeS, Serializable};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// HPKE `info` for sealing a push token.
pub const TOKEN_INFO: &[u8] = b"kriyon push token v1";

/// The first field of a signed wake-up, so the signature means nothing else.
pub const WAKE_CONTEXT: &str = "kriyon push wake v1";

/// The most sealed bytes a wake-up may carry: a push token is at most a few
/// hundred bytes, and HPKE adds 48.
pub const MAX_SEALED: usize = 1024;

/// The X25519 encapsulated key at the front of a sealed token.
const ENC_LEN: usize = 32;

/// Which push service delivers to the phone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Platform {
    /// Apple's push service (iPhone).
    Apns,
    /// Firebase Cloud Messaging (Android).
    Fcm,
}

/// What the phone seals: its push token, for one host, until `expires`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushTokenPlain {
    pub token: String,
    pub platform: Platform,
    /// The host this copy is for: the sender sends only when this host signs.
    pub host_id: [u8; 32],
    /// Unix seconds; about 60 days on, renewed on every connect.
    pub expires: u64,
}

impl PushTokenPlain {
    /// Its postcard bytes: what is sealed.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        // Plain data with no maps or floats: postcard can't fail on it.
        postcard::to_allocvec(self).unwrap_or_default()
    }
}

/// Why a sealed token couldn't be sealed or opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushError {
    /// Not a key the sender could have published.
    BadKey,
    /// Too short, too long, tampered, or sealed to another key.
    Unopenable,
    /// Opened, but not a token.
    Malformed,
}

/// The public key of the sender's `secret`, as it publishes it.
#[must_use]
pub fn push_public_key(secret: &[u8; 32]) -> [u8; 32] {
    let Ok(secret) = <X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(secret) else {
        // Any 32 bytes are an X25519 secret.
        return [0; 32];
    };
    X25519HkdfSha256::sk_to_pk(&secret).to_bytes().into()
}

/// Seal `plain` to the sender's `public` key (HPKE base mode): the
/// encapsulated key, then the ciphertext.
///
/// # Errors
/// [`PushError::BadKey`] for a key that isn't a usable X25519 key.
pub fn seal_push_token(public: &[u8; 32], plain: &PushTokenPlain) -> Result<Vec<u8>, PushError> {
    let public = <X25519HkdfSha256 as hpke::Kem>::PublicKey::from_bytes(public)
        .map_err(|_| PushError::BadKey)?;
    let (enc, ciphertext) =
        hpke::single_shot_seal::<ChaCha20Poly1305, HkdfSha256, X25519HkdfSha256>(
            &OpModeS::Base,
            &public,
            TOKEN_INFO,
            &plain.to_bytes(),
            b"",
        )
        .map_err(|_| PushError::BadKey)?;
    let mut sealed = enc.to_bytes().to_vec();
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

/// Open a sealed token with the sender's `secret`, in memory.
///
/// # Errors
/// [`PushError::Unopenable`] or [`PushError::Malformed`].
pub fn open_push_token(secret: &[u8; 32], sealed: &[u8]) -> Result<PushTokenPlain, PushError> {
    if sealed.len() <= ENC_LEN || sealed.len() > MAX_SEALED {
        return Err(PushError::Unopenable);
    }
    let (enc, ciphertext) = sealed.split_at(ENC_LEN);
    let secret = <X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(secret)
        .map_err(|_| PushError::BadKey)?;
    let enc = <X25519HkdfSha256 as hpke::Kem>::EncappedKey::from_bytes(enc)
        .map_err(|_| PushError::Unopenable)?;
    let plain = hpke::single_shot_open::<ChaCha20Poly1305, HkdfSha256, X25519HkdfSha256>(
        &OpModeR::Base,
        &secret,
        &enc,
        TOKEN_INFO,
        ciphertext,
        b"",
    )
    .map_err(|_| PushError::Unopenable)?;
    match postcard::take_from_bytes::<PushTokenPlain>(&plain) {
        Ok((token, [])) => Ok(token),
        _ => Err(PushError::Malformed),
    }
}

/// What a host signs to ask for a wake-up: the postcard bytes of
/// `(WAKE_CONTEXT, key_id, SHA-256(sealed), at, request_id)`.
#[must_use]
pub fn wake_bytes(key_id: u32, sealed: &[u8], at: u64, request_id: &[u8; 16]) -> Vec<u8> {
    let hash: [u8; 32] = Sha256::digest(sealed).into();
    // A tuple of plain fields: postcard can't fail on it.
    postcard::to_allocvec(&(WAKE_CONTEXT, key_id, hash, at, request_id)).unwrap_or_default()
}

/// Sign a wake-up with the host's [Device key] secret (its endpoint id is
/// the public half).
#[must_use]
pub fn sign_wake(
    host_secret: &[u8; 32],
    key_id: u32,
    sealed: &[u8],
    at: u64,
    request_id: &[u8; 16],
) -> [u8; 64] {
    use ed25519_dalek::Signer as _;
    ed25519_dalek::SigningKey::from_bytes(host_secret)
        .sign(&wake_bytes(key_id, sealed, at, request_id))
        .to_bytes()
}

/// Whether `signature` is `host_id`'s over this wake-up.
#[must_use]
pub fn verify_wake(
    host_id: &[u8; 32],
    key_id: u32,
    sealed: &[u8],
    at: u64,
    request_id: &[u8; 16],
    signature: &[u8; 64],
) -> bool {
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(host_id) else {
        return false;
    };
    key.verify_strict(
        &wake_bytes(key_id, sealed, at, request_id),
        &ed25519_dalek::Signature::from_bytes(signature),
    )
    .is_ok()
}

/// A host's request to the sender, `POST /v1/wake`, as JSON with hex bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WakeRequest {
    pub key_id: u32,
    /// Hex of the sealed token.
    pub sealed: String,
    /// Unix seconds.
    pub at: u64,
    /// Hex of 16 random bytes.
    pub request_id: String,
    /// Hex of the host's endpoint id.
    pub host_id: String,
    /// Hex of the Ed25519 signature over [`wake_bytes`].
    pub signature: String,
}

/// The sender's key, `GET /v1/key`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SenderKey {
    pub key_id: u32,
    /// Hex of the X25519 public key.
    pub public_key: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [7; 32];
    const HOST: [u8; 32] = [9; 32];

    fn plain() -> PushTokenPlain {
        PushTokenPlain {
            token: "abc".into(),
            platform: Platform::Fcm,
            host_id: [1; 32],
            expires: 5,
        }
    }

    #[test]
    fn a_token_opens_only_with_the_senders_secret_and_untouched() {
        let sealed = seal_push_token(&push_public_key(&SECRET), &plain()).expect("seals");
        assert_eq!(open_push_token(&SECRET, &sealed), Ok(plain()));
        assert_eq!(
            open_push_token(&[8; 32], &sealed),
            Err(PushError::Unopenable)
        );
        let mut tampered = sealed.clone();
        *tampered.last_mut().expect("bytes") ^= 1;
        assert_eq!(
            open_push_token(&SECRET, &tampered),
            Err(PushError::Unopenable)
        );
    }

    #[test]
    fn a_sealed_token_too_short_or_too_long_is_not_opened() {
        assert_eq!(
            open_push_token(&SECRET, &[0; 32]),
            Err(PushError::Unopenable)
        );
        assert_eq!(
            open_push_token(&SECRET, &vec![0; MAX_SEALED + 1]),
            Err(PushError::Unopenable)
        );
    }

    #[test]
    fn two_seals_of_one_token_differ() {
        let public = push_public_key(&SECRET);
        assert_ne!(
            seal_push_token(&public, &plain()),
            seal_push_token(&public, &plain())
        );
    }

    #[test]
    fn a_wake_verifies_only_for_its_signer_and_its_fields() {
        let host_id = ed25519_dalek::SigningKey::from_bytes(&HOST)
            .verifying_key()
            .to_bytes();
        let id = [3; 16];
        let signature = sign_wake(&HOST, 1, b"sealed", 100, &id);
        assert!(verify_wake(&host_id, 1, b"sealed", 100, &id, &signature));
        assert!(!verify_wake(&[1; 32], 1, b"sealed", 100, &id, &signature));
        assert!(!verify_wake(&host_id, 2, b"sealed", 100, &id, &signature));
        assert!(!verify_wake(&host_id, 1, b"other", 100, &id, &signature));
        assert!(!verify_wake(&host_id, 1, b"sealed", 101, &id, &signature));
        assert!(!verify_wake(
            &host_id, 1, b"sealed", 100, &[4; 16], &signature
        ));
    }
}
