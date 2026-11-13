//! The pairing numbers must match `vectors.json`, made with Python's own
//! `hmac` and `hashlib`: the phone library checks against the same file.

use kriyon_remote::pairing::{exporter_context, pair_proof, pairing_code, proof_matches};

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
fn every_vector_gives_the_same_proof_context_and_code() {
    let file: serde_json::Value =
        serde_json::from_str(include_str!("vectors.json")).expect("vectors.json parses");
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 4, "every vector in the file is checked");
    for case in cases {
        let field = |name: &str| case[name].as_str().expect(name).to_owned();
        let secret = array::<32>(&field("secret"));
        let device = array::<32>(&field("device_id"));
        let host = array::<32>(&field("host_id"));
        assert_eq!(hex(&field("proof")), pair_proof(&secret, &device, &host));
        assert!(proof_matches(
            &secret,
            &device,
            &host,
            &hex(&field("proof"))
        ));
        assert_eq!(
            hex(&field("exporter_context")),
            exporter_context(&host, &device, &secret)
        );
        assert_eq!(field("code"), pairing_code(&array::<8>(&field("exported"))));
    }
}
