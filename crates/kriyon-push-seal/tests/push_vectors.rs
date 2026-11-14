//! The push numbers must match `push_vectors.json`, made by `push_vectors.py`
//! with Python's `cryptography` and `pyhpke`: the phone library checks
//! against the same file.

use kriyon_push_seal::{
    open_push_token, push_public_key, seal_push_token, sign_wake, verify_wake, wake_bytes,
    Platform, PushTokenPlain, TOKEN_INFO, WAKE_CONTEXT,
};

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn array<const N: usize>(s: &str) -> [u8; N] {
    hex(s).try_into().expect("length")
}

#[test]
fn every_vector_opens_encodes_and_signs_the_same() {
    let file: serde_json::Value =
        serde_json::from_str(include_str!("push_vectors.json")).expect("push_vectors.json parses");
    let field = |name: &str| file[name].as_str().expect(name).to_owned();
    assert_eq!(field("token_info").as_bytes(), TOKEN_INFO);
    assert_eq!(field("wake_context"), WAKE_CONTEXT);
    let push_secret = array::<32>(&field("push_secret"));
    assert_eq!(
        push_public_key(&push_secret),
        array::<32>(&field("push_public"))
    );
    let host_secret = array::<32>(&field("host_secret"));
    let host_id = array::<32>(&field("host_id"));

    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 2, "every vector in the file is checked");
    for case in cases {
        let text = |name: &str| case[name].as_str().expect(name).to_owned();
        let number = |name: &str| case[name].as_u64().expect(name);
        let plain = PushTokenPlain {
            token: text("token"),
            platform: if number("platform") == 0 {
                Platform::Apns
            } else {
                Platform::Fcm
            },
            host_id,
            expires: number("expires"),
        };
        assert_eq!(plain.to_bytes(), hex(&text("token_bytes")));

        // Python sealed it; the sender opens it.
        let sealed = hex(&text("sealed"));
        assert_eq!(open_push_token(&push_secret, &sealed), Ok(plain.clone()));

        let key_id = u32::try_from(number("key_id")).expect("key id");
        let request_id = array::<16>(&text("request_id"));
        let message = wake_bytes(key_id, &sealed, number("at"), &request_id);
        assert_eq!(message, hex(&text("wake_bytes")));
        let signature = array::<64>(&text("signature"));
        assert_eq!(
            sign_wake(&host_secret, key_id, &sealed, number("at"), &request_id),
            signature,
            "Ed25519 signatures are deterministic"
        );
        assert!(verify_wake(
            &host_id,
            key_id,
            &sealed,
            number("at"),
            &request_id,
            &signature
        ));

        // And what this side seals opens too.
        let resealed = seal_push_token(&push_public_key(&push_secret), &plain).expect("seals");
        assert_eq!(open_push_token(&push_secret, &resealed), Ok(plain));
    }
}
