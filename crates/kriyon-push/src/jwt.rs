//! The two signed tokens the sender needs, with `ring` (already in the
//! workspace through rustls): APNs's provider token (ES256, from the `.p8`
//! key) and Google's service-account assertion (RS256), traded for an FCM
//! access token.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ring::rand::SystemRandom;
use ring::signature::{
    EcdsaKeyPair, RsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING, RSA_PKCS1_SHA256,
};

/// Why a key couldn't be used.
#[derive(Debug, PartialEq, Eq)]
pub enum KeyError {
    /// Not a PEM block of PKCS#8.
    NotPem,
    /// PKCS#8, but not a key of the kind needed.
    WrongKey,
    /// Signing failed.
    Sign,
}

/// The DER inside a PEM `-----BEGIN PRIVATE KEY-----` block.
///
/// # Errors
/// [`KeyError::NotPem`].
pub fn pem_der(pem: &str) -> Result<Vec<u8>, KeyError> {
    let body: String = pem
        .lines()
        .map(str::trim)
        .skip_while(|line| *line != "-----BEGIN PRIVATE KEY-----")
        .skip(1)
        .take_while(|line| *line != "-----END PRIVATE KEY-----")
        .collect();
    if body.is_empty() {
        return Err(KeyError::NotPem);
    }
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|_| KeyError::NotPem)
}

/// `header.claims.signature`, each part base64url without padding.
fn jwt(
    header: &serde_json::Value,
    claims: &serde_json::Value,
    sign: impl FnOnce(&[u8]) -> Result<Vec<u8>, KeyError>,
) -> Result<String, KeyError> {
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let signature = sign(signing_input.as_bytes())?;
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

/// An ES256 key: APNs's `.p8`.
pub struct Es256Key(EcdsaKeyPair);

impl Es256Key {
    /// From the `.p8` file's text.
    ///
    /// # Errors
    /// [`KeyError`] when it isn't a P-256 PKCS#8 key.
    pub fn from_pem(pem: &str) -> Result<Self, KeyError> {
        let der = pem_der(pem)?;
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &der, &SystemRandom::new())
            .map(Self)
            .map_err(|_| KeyError::WrongKey)
    }

    /// APNs's provider token: `{alg, kid}`, `{iss: team, iat}`.
    ///
    /// # Errors
    /// [`KeyError::Sign`].
    pub fn apns_token(&self, key_id: &str, team_id: &str, iat: u64) -> Result<String, KeyError> {
        jwt(
            &serde_json::json!({ "alg": "ES256", "kid": key_id }),
            &serde_json::json!({ "iss": team_id, "iat": iat }),
            |input| {
                self.0
                    .sign(&SystemRandom::new(), input)
                    .map(|signature| signature.as_ref().to_vec())
                    .map_err(|_| KeyError::Sign)
            },
        )
    }
}

/// An RS256 key: a Google service account's `private_key`.
pub struct Rs256Key(RsaKeyPair);

impl Rs256Key {
    /// From the service account's `private_key` text.
    ///
    /// # Errors
    /// [`KeyError`] when it isn't an RSA PKCS#8 key.
    pub fn from_pem(pem: &str) -> Result<Self, KeyError> {
        let der = pem_der(pem)?;
        RsaKeyPair::from_pkcs8(&der)
            .map(Self)
            .map_err(|_| KeyError::WrongKey)
    }

    /// The assertion Google trades for an access token with `scope`.
    ///
    /// # Errors
    /// [`KeyError::Sign`].
    pub fn google_assertion(
        &self,
        client_email: &str,
        token_uri: &str,
        scope: &str,
        iat: u64,
    ) -> Result<String, KeyError> {
        jwt(
            &serde_json::json!({ "alg": "RS256", "typ": "JWT" }),
            &serde_json::json!({
                "iss": client_email,
                "scope": scope,
                "aud": token_uri,
                "iat": iat,
                "exp": iat + 3600,
            }),
            |input| self.sign(input),
        )
    }

    /// RSASSA-PKCS1-v1_5 with SHA-256 over `input` (deterministic).
    fn sign(&self, input: &[u8]) -> Result<Vec<u8>, KeyError> {
        let mut signature = vec![0; self.0.public().modulus_len()];
        self.0
            .sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                input,
                &mut signature,
            )
            .map_err(|_| KeyError::Sign)?;
        Ok(signature)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use ring::signature::{
        KeyPair as _, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED, RSA_PKCS1_2048_8192_SHA256,
    };

    use super::*;

    /// A fresh P-256 key as a `.p8` file's text.
    pub(crate) fn p8() -> String {
        let der =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
                .expect("a key");
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(der.as_ref())
        )
    }

    /// The RSA key published in RFC 7515, Appendix A.2: a public test
    /// vector, so a test can check our RS256 against the RFC's answer.
    pub(crate) const RSA_PEM: &str = include_str!("../tests/rfc7515-a2-rsa.pem");

    #[test]
    fn rs256_signs_the_rfc_7515_example_as_the_rfc_does() {
        // RFC 7515, Appendix A.2.1: the JWS Signing Input and its signature.
        let input = "eyJhbGciOiJSUzI1NiJ9\
            .eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFt\
            cGxlLmNvbS9pc19yb290Ijp0cnVlfQ";
        let signature = "cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7\
            AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4\
            BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K\
            0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqv\
            hJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrB\
            p0igcN_IoypGlUPQGe77Rw";
        let key = Rs256Key::from_pem(RSA_PEM).expect("the RFC's key");
        assert_eq!(
            URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).expect("signs")),
            signature
        );
    }

    fn parts(token: &str) -> (serde_json::Value, serde_json::Value, Vec<u8>, String) {
        let pieces: Vec<&str> = token.split('.').collect();
        assert_eq!(pieces.len(), 3);
        let json = |part: &str| {
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).expect("base64url")).expect("json")
        };
        (
            json(pieces[0]),
            json(pieces[1]),
            URL_SAFE_NO_PAD.decode(pieces[2]).expect("signature"),
            format!("{}.{}", pieces[0], pieces[1]),
        )
    }

    #[test]
    fn an_apns_token_names_the_key_and_team_and_verifies() {
        let pem = p8();
        let key = Es256Key::from_pem(&pem).expect("a .p8 key");
        let token = key
            .apns_token("ABC123DEFG", "DEF123GHIJ", 1_437_179_036)
            .expect("signs");
        let (header, claims, signature, input) = parts(&token);
        assert_eq!(
            header,
            serde_json::json!({ "alg": "ES256", "kid": "ABC123DEFG" })
        );
        assert_eq!(
            claims,
            serde_json::json!({ "iss": "DEF123GHIJ", "iat": 1_437_179_036 })
        );
        assert_eq!(signature.len(), 64, "raw r and s, as JWT wants");
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, key.0.public_key().as_ref())
            .verify(input.as_bytes(), &signature)
            .expect("verifies");
    }

    #[test]
    fn a_google_assertion_asks_for_the_scope_for_an_hour_and_verifies() {
        let key = Rs256Key::from_pem(RSA_PEM).expect("an RSA key");
        let token = key
            .google_assertion(
                "sender@example.iam.gserviceaccount.com",
                "https://oauth2.googleapis.com/token",
                "https://www.googleapis.com/auth/firebase.messaging",
                100,
            )
            .expect("signs");
        let (header, claims, signature, input) = parts(&token);
        assert_eq!(header["alg"], "RS256");
        assert_eq!(claims["iss"], "sender@example.iam.gserviceaccount.com");
        assert_eq!(claims["aud"], "https://oauth2.googleapis.com/token");
        assert_eq!(
            claims["scope"],
            "https://www.googleapis.com/auth/firebase.messaging"
        );
        assert_eq!(
            (claims["iat"].as_u64(), claims["exp"].as_u64()),
            (Some(100), Some(3700))
        );
        UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, key.0.public().as_ref())
            .verify(input.as_bytes(), &signature)
            .expect("verifies");
    }

    #[test]
    fn text_that_is_not_a_key_of_the_right_kind_is_refused() {
        assert!(matches!(
            Es256Key::from_pem("nothing"),
            Err(KeyError::NotPem)
        ));
        assert!(matches!(
            Es256Key::from_pem(RSA_PEM),
            Err(KeyError::WrongKey)
        ));
        assert!(matches!(Rs256Key::from_pem(&p8()), Err(KeyError::WrongKey)));
    }
}
