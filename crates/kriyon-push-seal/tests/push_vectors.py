"""Make push_vectors.json (spec section 10) with Python's own `cryptography`
and `pyhpke`, independent of the Rust code that must match it. The phone
library checks against the same file.

    python3 -m venv venv && venv/bin/pip install cryptography pyhpke
    venv/bin/python push_vectors.py > push_vectors.json

Sealing is random (HPKE makes a fresh key each time), so `sealed` changes on
every run; the Rust side checks that it opens to `token_bytes`. Everything
else is fixed.
"""

import hashlib
import json

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from pyhpke import AEADId, CipherSuite, KDFId, KEMId

TOKEN_INFO = b"kriyon push token v1"
WAKE_CONTEXT = "kriyon push wake v1"
RAW = serialization.Encoding.Raw
RAW_PUB = serialization.PublicFormat.Raw
RAW_PRIV = serialization.PrivateFormat.Raw
NO_ENC = serialization.NoEncryption()


def varint(n: int) -> bytes:
    """postcard's unsigned varint (LEB128)."""
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        if n:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def postcard_str(s: str) -> bytes:
    data = s.encode()
    return varint(len(data)) + data


def token_bytes(token: str, platform: int, host_id: bytes, expires: int) -> bytes:
    """postcard of PushTokenPlain { token, platform, host_id, expires }."""
    return postcard_str(token) + varint(platform) + host_id + varint(expires)


def wake_bytes(key_id: int, sealed: bytes, at: int, request_id: bytes) -> bytes:
    """postcard of ("kriyon push wake v1", key_id, SHA-256(sealed), at, request_id)."""
    return (
        postcard_str(WAKE_CONTEXT)
        + varint(key_id)
        + hashlib.sha256(sealed).digest()
        + varint(at)
        + request_id
    )


def main() -> None:
    suite = CipherSuite.new(
        KEMId.DHKEM_X25519_HKDF_SHA256, KDFId.HKDF_SHA256, AEADId.CHACHA20_POLY1305
    )
    push_secret = bytes(range(0x40, 0x60))
    push_public = (
        X25519PrivateKey.from_private_bytes(push_secret).public_key().public_bytes(RAW, RAW_PUB)
    )
    host_secret = bytes(range(0x60, 0x80))
    host = Ed25519PrivateKey.from_private_bytes(host_secret)
    host_id = host.public_key().public_bytes(RAW, RAW_PUB)

    cases = []
    for token, platform, expires, key_id, at, request_id in [
        ("apns-device-token-0123456789abcdef", 0, 1_790_000_000, 1, 1_785_000_000, bytes(16)),
        ("fcm:registration-token_with-dashes", 1, 4_000_000_000, 300, 1_785_000_123, bytes(range(16))),
    ]:
        plain = token_bytes(token, platform, host_id, expires)
        pk = suite.kem.deserialize_public_key(push_public)
        enc, sender = suite.create_sender_context(pk, info=TOKEN_INFO)
        sealed = enc + sender.seal(plain)
        message = wake_bytes(key_id, sealed, at, request_id)
        cases.append(
            {
                "token": token,
                "platform": platform,
                "expires": expires,
                "token_bytes": plain.hex(),
                "sealed": sealed.hex(),
                "key_id": key_id,
                "at": at,
                "request_id": request_id.hex(),
                "wake_bytes": message.hex(),
                "signature": host.sign(message).hex(),
            }
        )

    print(
        json.dumps(
            {
                "about": "Push test vectors (spec section 10), made by push_vectors.py with Python's cryptography and pyhpke. The phone library checks against the same file.",
                "token_info": TOKEN_INFO.decode(),
                "wake_context": WAKE_CONTEXT,
                "push_secret": push_secret.hex(),
                "push_public": push_public.hex(),
                "host_secret": host_secret.hex(),
                "host_id": host_id.hex(),
                "cases": cases,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
