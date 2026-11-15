# Relay pass contract (public part)

Status: **draft 3, 13 Nov 2026.** Kriyon's review of draft 1 is applied (see the end). Draft 3: sign-in is now device sign-in (the person chose it over an emailed code), and buying happens on the BisBig website.
This file is the part the apps need. It may be copied into the public Kriyon repo as is.
It names no BisBig hostname, key or server. The private part (block list, usage reports)
is in `relay-ops.md` and never goes in the Kriyon repo.

## What a pass is

A short signed string that lets one device use our relay. BisBig issues it. The relay checks
it by itself, with no call to BisBig.

- It names one **relay account** (16 random bytes, one per subscriber; not the BisBig user id).
- It names one **device key**: the device's iroh endpoint id (its Ed25519 public key, 32 bytes).
  The relay only accepts the pass from the endpoint that proves it holds that key during the
  relay handshake. A copied pass is useless on another device.
- It has a start time and an expiry. Expiry is at most **30 days** after issue, and never later
  than the end of the paid period plus **3 days' grace**.

To the app the pass is **opaque**. The app stores it, sends it, and reads `expires_at` and
`renew_after` from the API reply. It never parses or checks the pass itself.

## Format

```
kp1.<base64url(payload)>.<base64url(signature)>
```

- base64url without padding (RFC 4648 §5).
- `payload` is 65 bytes, fixed layout, integers big-endian:

| Bytes | Field | Meaning |
|---|---|---|
| 0 | `key_id` u8 | Which BisBig signing key signed it (for key rotation) |
| 1–16 | `account` [16] | Relay account id |
| 17–48 | `device` [32] | iroh endpoint id (Ed25519 public key) |
| 49–56 | `not_before` u64 | Unix seconds |
| 57–64 | `expires_at` u64 | Unix seconds |

- `signature` is Ed25519 (RFC 8032, strict verification) over
  `"kriyon-relay-pass-v1" || payload` (the 20 ASCII bytes, then the 65 payload bytes).
- A pass is about 180 characters. The relay refuses anything over 512 characters before
  decoding it.
- A new layout gets a new prefix (`kp2`). The relay may accept both during a change-over.

Test vector: the valid pass from BisBig's `test-vectors.json` (fixed test keys; never used anywhere
real) is kept in the app's tests, which check that the app carries it untouched.

## How the app gets a pass

All calls go to the BisBig API with the user's BisBig sign-in. The API base address comes
from app configuration at build time and the relay address from the pass reply — never
written in the public source.

### Sign-in: device code (OAuth 2.0 device grant, RFC 8628)

The app never asks for a password or an emailed code. Paths are under the API's auth base,
`/api/v1/admin/auth`.

1. `POST /device/code` with `{ "client_id": "kriyon-desktop" }` (phone: `"kriyon-mobile"`).
   Reply: `device_code`, `user_code` (8 letters/digits), `verification_uri`,
   `verification_uri_complete`, `expires_in` (600 s), `interval` (5 s).
2. Show `user_code` and open `verification_uri_complete` in the browser (on the phone: the
   phone's browser). The person signs in to BisBig there if needed and approves.
3. Poll `POST /device/token` every `interval` seconds with
   `{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": "…",
   "client_id": "kriyon-desktop" }`. Errors while waiting: `authorization_pending`,
   `slow_down` (wait longer), then `access_denied` or `expired_token` (start again).
4. Success gives `access_token`. Store it in the keychain and send it as
   `Authorization: Bearer <access_token>` on every API call below. A 401 means sign in again.

These replies follow the OAuth spec, not BisBig's envelope.

### Buying

The apps don't take payments. The desktop app opens `<BisBig website>/subscriptions` in the
browser to subscribe, change or cancel, and reads the result from `/status`. The phone app
has no buy button (Apple's rules); it only shows the status.

Replies use BisBig's envelope: success is `{ "data": …, "meta": { … } }` (the examples below
show `data` only); errors are `{ "error": { "code", "message", "details" } }`.

### `POST /api/v1/kriyon-relay/devices`

Registers this device for the signed-in user. Safe to repeat (same key, same result).

```json
{ "deviceKey": "<64 hex chars, the iroh endpoint id>", "name": "My MacBook", "platform": "macos" }
```

`platform`: `macos | windows | linux | ios | android`. `name`: 1–64 characters, shown to the
user and in admin.

Reply `200`: `{ "deviceId": "<uuid>", "deviceKey": "…", "name": "…", "platform": "…" }`.

### `POST /api/v1/kriyon-relay/passes`

```json
{ "deviceKey": "<64 hex chars>" }
```

Reply `200`:

```json
{
  "pass": "kp1.…",
  "expiresAt": "2026-12-14T00:00:00.000Z",
  "renewAfter": "2026-11-15T00:00:00.000Z",
  "relayUrl": "https://<relay host>/"
}
```

### `GET /api/v1/kriyon-relay/status`

Reply `200`:

```json
{
  "subscription": { "state": "active", "plan": "monthly", "paidUntil": "2026-12-13T00:00:00.000Z" },
  "devices": [{ "deviceId": "…", "deviceKey": "…", "name": "…", "platform": "macos", "lastPassAt": "…" }],
  "deviceLimit": 10,
  "blocked": false
}
```

`subscription` is `null` when the person never subscribed. Otherwise `state` is one of:

| `state` | Meaning |
|---|---|
| `pending` | A first payment was started but not confirmed |
| `active` | Paid; renews automatically |
| `past_due` | A renewal was declined; we retry for a few days |
| `canceled` | Renewal stopped; paid time still counts |
| `expired` | Renewal failed for good |

Whatever the state, a pass is issued only while `paidUntil` + 3 days is in the future.

### `DELETE /api/v1/kriyon-relay/devices/{deviceId}`

Removes a device. Its passes stop working at the relay within about a minute.

This only stops that device using **our relay**. It does not unpair it from any host; unpairing
is done on the host. Same Wi-Fi and Tailscale links keep working until then.

### Errors

Errors use BisBig's usual error body. The app branches on `code`:

| HTTP | `code` | What the app shows |
|---|---|---|
| 401 | `UNAUTHORIZED` | Sign in again |
| 402 | `RELAY_NO_SUBSCRIPTION` | "Our relay needs a subscription" + link to subscribe |
| 403 | `RELAY_ACCOUNT_BLOCKED` | "Relay access is suspended for this account" |
| 403 | `RELAY_DEVICE_REMOVED` | "This device was removed from your relay account" |
| 404 | `RELAY_DEVICE_UNKNOWN` | Register the device (`POST /devices`), then ask again |
| 409 | `RELAY_DEVICE_LIMIT` | "You already use 10 devices. Remove one first" |
| 400 | `VALIDATION_ERROR` | Bug in the app; log it |

## When the app renews

- Fetch a pass when the device turns relay on, and again once `renewAfter` has passed
  (about daily), whenever the API is reachable.
- iroh reads the pass once, when the endpoint starts (`RelayConfig::with_auth_token`, iroh-relay
  1.4.1 `src/relay_map.rs:266`). A new pass only takes effect when the endpoint is rebuilt:
  in iroh 1.4.1 `Endpoint::insert_relay` with a new token updates the map but not the running
  relay connection (upstream issue n0-computer/iroh#4642, draft PR #4643, both open on 12 Nov).
  If that lands, a relay reconnect will be enough. So: phone — fetch at launch; desktop
  host — rebuild the endpoint at a quiet moment (no session being watched), and force it when
  under 7 days remain.
- If the API is down, keep using the pass you have. It has weeks left.

## How the app presents it to the relay

- Set it as the relay auth token: `RelayConfig { url, .. }.with_auth_token(pass)`. iroh sends
  it as `Authorization: Bearer <pass>` on the relay connection.
- The relay checks: signature, `not_before - 60 s ≤ now ≤ expires_at + 60 s`, lifetime not
  over 33 days, `device` equals the endpoint id proved in the handshake, not on the block
  list, and the device limit.

### What the relay says when it refuses

A pass that isn't a signed pass, or whose time window runs backwards or is over 33 days long,
gets **HTTP 401** before the relay handshake (no reason text). A new pass would not help: it
is a bug at BisBig's end, so the app reports it and does not loop. Any other refusal comes
after the handshake, readable in the app through
`RelayStatus::auth_denied_reason()` (iroh 1.4.1, `src/endpoint.rs:1990`; seen working in the
relay prototype on 12 Nov):

| Reason string | Meaning | What the app does |
|---|---|---|
| `pass-expired` | Pass is out of date | Fetch a new pass, rebuild the endpoint |
| `pass-wrong-device` | Pass belongs to another device key | Fetch a pass for this device |
| `account-blocked` | Account banned (also used for a refund or an early end) | Call `/status`, show its message |
| `device-removed` | This device was removed | Show "removed"; offer to register again |
| `device-limit` | 10 devices of this account are already connected, or this device already has too many open links | Say so; retry later |

Reason strings are stable; new ones may be added. Treat an unknown one like `account-blocked`.

## Limits

- **Device limit: 10** per relay account. Checked when a device registers (API) and when a
  device connects (relay: at most 10 different endpoint ids connected at once).
- **Speed cap: about 200 KB a second per connection** (204,800 bytes a second, burst
  256 KiB). It slows the connection; it never cuts it. A terminal needs far less.
- **No monthly quota.**
- The relay only forwards between devices of the **same relay account**. A device of another
  account can't be reached through it (iroh shows a connect timeout). So the host and every
  device that reaches it through our relay must hold passes from **the same BisBig account**.
  The app should say "sign in with the same account on both".

## Decided in Kriyon's review (13 Nov)

1. Grace after the paid period ends: **3 days.**
2. `deviceKey` is the iroh endpoint id on every platform, one key per install, kept in the
   keychain of that device only (Kriyon ADR 0057).
3. Apps sign in with a device code (above), then a Bearer token. (Changed from the emailed code
   in Kriyon's review: the person chose device sign-in as more secure.)
