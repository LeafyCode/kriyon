# Remote protocol

**Date:** 2026-11-13
**Status:** Draft for review. Decision record: [ADR-0057](../../adr/0057-remote-access.md).
**Code:** `crates/kriyon-remote` (shared by the desktop host and the phone library).

Terms in [brackets] are in the glossary, [`docs/context/remote.md`](../../context/remote.md).

## 1. Roles and pieces

- **[Host]** — the computer whose sessions run. Today a Mac; Windows later.
- **[Remote device]** — a phone or another computer paired with the host, as a
  [Viewer] or a [Controller].
- **Relay** — passes encrypted QUIC packets between devices that can't reach
  each other directly. Can't read them. Ours needs a [Relay pass]; the pass
  format is in the relay contract, kept outside this spec.
- **Push sender** — opens a [Sealed push token] and sends one alert. Keeps
  nothing on disk.

The desktop app is the [PTY daemon]'s only client. The host side of this
protocol lives in the app's Rust core and reads sessions through the same
[Daemon client] the window uses.

One iroh endpoint per app, shared by both roles: it accepts as a host only
while [Remote access] is on, and dials as a device when the person uses
another computer from here. With Remote access off and no paired computers
there is no endpoint at all; with Remote access off but a paired computer in
use, the endpoint offers no ALPN, so every incoming handshake fails. No push
calls while Remote access is off.

## 2. Transport

- iroh 1.x endpoint per device. The endpoint id is the device's Ed25519
  public key ([Device key]). The secret stays in the OS keychain, this device
  only (`ThisDeviceOnly` on iPhone), readable only while unlocked; never synced.
- ALPNs: `kriyon/remote/1` and `kriyon/pair/1`. The number is the major
  version. The host keeps a minimum major and minor it accepts and refuses
  older ones; every security check lives in `authorize` (§8), which doesn't
  depend on the version.
- **No 0-RTT** on either ALPN: 0-RTT data can be replayed.
- Address lookup: none by default (iroh's minimal preset). Each device stores
  the host's endpoint id plus the ways to reach it learned at pairing: LAN
  addresses, an optional Tailscale address with the host's fixed port, and the
  relay URL when the person subscribes.
- The host checks the peer's endpoint id at accept time, before it opens or
  accepts any stream. Handshakes from unpaired ids are rate-limited by source
  address (the id is only known after the handshake), so during an attack from
  a shared address a paired device behind it can be ignored for that minute.
- One QUIC connection per device per host. Inside it, at most 16 concurrent
  bidirectional streams:
  - **Control stream** (first bidirectional stream): hello, heartbeats,
    session list, status, control changes, refusals.
  - **One session stream per open session**, at most one per session per
    device: screen down, input and resize up. Closing it detaches; the
    session keeps running.

## 3. Encoding

- Each message is `[u32 length, big-endian][varint tag][postcard body]`.
- **Limits.** Host to device: 1 MiB per message. Device to host: `Input` and
  `Compose` 64 KiB, `PushToken` 2 KiB, device name 64 bytes, anything else
  4 KiB. A longer length is a protocol error and closes the stream; it is
  never buffered.
- **Unknown messages.** The tag is decoded first. An unknown tag is skipped
  and answered with `Refused { reason: UnknownMessage }`, never a crash.
  Trailing bytes after a known message are ignored.
- **Adding fields.** postcard doesn't describe itself, so fields are appended
  only at the end of a top-level message, never inside a nested struct or a
  list item; otherwise add a new message type. The host never depends on a
  new field for a security check unless it requires that minor version.
- **Compression.** Each [Screen update] and snapshot is one independent zstd
  frame, no dictionary, with the content size in the frame header. The stated
  content size bounds memory: decoders refuse a frame without it, and refuse more than 8 MiB decompressed for an
  update and 24 MiB for a snapshot; past that is a protocol error and the
  device sends `Resync`. A snapshot bigger than 1 MiB compressed is sent as
  numbered `SnapshotPart`s (each repeats the snapshot fields, at most
  1 MiB − 1 KiB of compressed bytes).
- **Screen size for remote viewing.** A host screen over 250,000 cells (for
  example 500 × 500) can't be viewed remotely: `Open` is refused
  `ScreenTooLarge`, and a remote `Resize` past 250,000 cells is `OutOfRange`,
  so a Controller can't grow the screen past what it may view. That keeps the worst snapshot (about 67 bytes a cell) under
  the 24 MiB cap.

## 4. Pairing

1. On the host the person picks a role and presses "Pair a device". Only now,
   and only while [Remote access] is on, does the host accept
   `kriyon/pair/1`. It makes a one-time pairing secret (32 random bytes),
   valid for 5 minutes, and stores the chosen role with it. It shows a QR
   code whose text is `kriyon-pair:1:<hex>`: the hex of a postcard
   `PairingInvite { host_id, addrs, relay_url, secret }` (relay URL only when
   the person subscribes). Each new pairing replaces a pending one.
2. The device scans it, connects with `kriyon/pair/1` (which proves the host's
   id, so a man in the middle is ruled out unless the QR leaked) and sends
   its device name and `HMAC-SHA256(secret, "kriyon pair v1" || device_id || host_id)`.
   The host compares in constant time. Wrong HMACs are rate-limited and don't
   use up the secret; the first right one takes it, atomically.
3. Both sides derive the 6-digit [Pairing code] from the connection's
   exported keying material: label `EXPERIMENTAL kriyon pairing v1`, context
   `host_id || device_id || SHA-256(secret)`, 8 bytes read as a big-endian
   u64, mod 10^6, zero-padded.
4. The host answers the proof with `ProofAccepted` or `Refused`. **Only after
   `ProofAccepted` does the device show the code; the person types it into the
   host.** Three
   wrong tries burn the secret. If someone with a leaked QR connected first,
   the real phone shows no code and pairing fails safe.
5. The host stores the device (endpoint id, name, role from step 1, paired at)
   and sends `Paired`. The device stores the host only after `Paired`. The
   device never sends a role. The host shows the name as "named by the device".

**Removing a device or changing it to Viewer**, in this order: drop it from
the `authorize` state; release its [Typing control] and bump the epoch on every
session it held; close its connection; delete its sealed push token and its
stored `request_id`s. A device refused with `NotPaired` stops retrying and
shows "Removed from this computer".

## 5. Connecting

1. Device opens `kriyon/remote/1`. iroh has already proved both endpoint ids,
   and the host refused unpaired ids at accept time.
2. Device sends `Hello { app_version, protocol_minor }`. Host answers
   `Welcome { host_name, protocol_minor, role, sessions }`.
3. Heartbeat: host sends `Heartbeat { seq, at }` every 15 s, scheduled from
   the app's main loop so it proves the app is alive, not just the socket. A
   device with no heartbeat for 40 s shows "Disconnected, reconnecting" and
   turns typing off.
4. Reconnect backs off from 1 s to at most 30 s. The app wakes it at once on a
   network change or when it comes to the front. It stops only on `NotPaired`.
5. **When a connection closes,** the host releases any typing control that
   device held and bumps the epoch. A reconnected device must send
   `TakeControl` again, so input buffered before the drop can never land.

**Back-pressure.** Every outgoing stream, the control stream included, has a
bounded per-device queue measured in bytes. The main loop only enqueues and
never waits on a network write. A full session queue means [Skip ahead]
(§6); a full control queue closes that connection.

## 6. Sessions and screens

- `SessionList` lists sessions as `SessionInfo { id, title, project_id, status,
  standing, needs_you, dialog_open, last_change_ms }`, the host's Session list
  computed in Rust (`kriyon_core::standing`). `standing` carries "unknown" when
  hooks are off or status is stale, so a device never shows a confident "idle"
  the desktop wouldn't. `SessionStatus { session }` sends one whole updated
  entry.
- `Open { session_id }` on a new session stream. Host checks the session
  exists, then sends `Snapshot { run, seq, cols, rows, bytes, skipped }`
  (the [Screen snapshot], ADR-0004) followed by `Update { run, seq, bytes }`
  for every chunk of output.
- **[Session run]** — a random u64 made each time the session's process
  starts. `seq` restarts with each run. A device that sees a gap in `seq` or a
  new `run` sends `Resync` (at most once a second) and gets a fresh
  `Snapshot`; it never guesses.
- When a device's session queue fills, the host drops it and sends a fresh
  `Snapshot` with `skipped: true`; the device shows "Skipped ahead". It never
  blocks the session or another device.
- Readable view entries (`Entry { … }`, trimmed, from the Structured view's
  data) come on the same stream when the device asks. Format in a later
  revision.

## 7. Input and control

- **Epoch** — `(host_boot_id, counter)` per session, where `host_boot_id` is
  random per app start, so a value never repeats across restarts. It changes
  with every control change.
- **Who holds control.** `TakeControl { session_id }` from a Controller
  takes it from another remote device at once. It takes it from the host only
  when nobody has typed at the host for 10 seconds, or the person clicks
  "Let <device> type" on the host. Typing at the host's own keyboard always
  takes control back and bumps the epoch. Every device hears
  `Control { holder, epoch }`.
- `Input { run, epoch, seen_seq, bytes }`, `Compose { run, epoch, seen_seq, text }`
  and `Resize { run, epoch, cols, rows }` must carry the current run and epoch.
  `seen_seq` is the last screen update the device had drawn. The host refuses
  with `Stale` when the run or epoch is old, or when a CLI dialog appeared or
  changed after `seen_seq`, so a lagging phone can't answer a dialog it never
  saw.
- `Compose` is refused while a CLI dialog is showing (ADR-0040). This is a
  guard against mistakes, not a security boundary: a Controller can send the
  same bytes as `Input`.
- While a remote device holds control it may resize to its own size, never
  under 80 columns. When control returns to the host, the host's size comes back.
- Receipts are honest: `InputAck { epoch, written: bool }` means the bytes
  reached the PTY, not that Claude acted on them.

## 8. The host's one check

Every message from a device passes `authorize(device, message, host_state)` in
`kriyon-remote` before anything acts on it. It returns `Allow` or
`Refuse(reason)`. The run, epoch, paired and dialog checks are then **repeated
inside the single PTY-writer task, atomically with the write**, so a takeover,
removal or new dialog between the check and the write still wins.

| Message | Roles | Stream | Checks (refusal) |
|---|---|---|---|
| `Hello`, `Resync`, `Open`, `RequestEntries` | Viewer, Controller | control / session | paired (`NotPaired`), session exists (`NoSuchSession`) |
| `TakeControl` | Controller | control | role (`NotAllowed`), control rules §7 (`NotInControl`) |
| `Input`, `Resize` | Controller | session | role, holds control, run + epoch + `seen_seq` (`Stale`), size bounds shared with the local resize command (`OutOfRange`) |
| `Compose` | Controller | session | as `Input`, plus no dialog showing (`DialogOpen`) |
| `StartSession` | Controller | control | role; project exists and its folder is inside an approved root (`FolderNotAllowed`) |
| `PushToken` | Viewer, Controller | control | size (`OutOfRange`) |
| anything else | — | — | `UnknownMessage` |

Refusals are answered with `Refused { reason }`, rate-limited, and logged on
the host without the payload.

**Rules the table implies:**

- Session-stream messages (`Input`, `Compose`, `Resize`, `Resync`,
  `RequestEntries`) carry no session id: the stream names it. `Open
  { session_id }` is the first message on a new session stream. `authorize`
  takes the stream (`Control` or `Session(id)`) as input.
- A message on the wrong stream is refused `NotAllowed`.
- A Viewer sending a Controller-only message gets `NotAllowed`; a Controller
  that doesn't hold control gets `NotInControl`. A `TakeControl` that can't
  take from the host yet (host typed less than 10 s ago) is `NotInControl` too.
- A remote `Resize` must be 80..=1000 columns and 1..=1000 rows, else
  `OutOfRange`. Never clamped.
- `authorize` is pure. The host resolves the facts that need IO or other
  modules first and passes them in: the project's folder status (Approved /
  NotAllowed / NoSuchProject, from `kriyon_core::folder::check_folder`) and the
  dialog state (open, generation).
- Until the first release, the protocol stays at major 1, minor 0, and
  messages may still change shape; from the first release on, only appends.
- An app below the host's minimum version gets `Refused { TooOld { min_minor } }`
  and the connection closes.

- The stream has three states: `Control`, `Unopened` (a session stream
  before its `Open`) and `Session(id)`.
- `StartSession` for a missing project is `NoSuchProject`; one that was
  allowed but whose shell didn't open is `StartFailed`.
- `seq` numbers a run's output updates, the same numbers for every device. A
  `Snapshot` carries the seq of the last update it includes, so one device's
  resync never makes a gap for another. The dialog fact passed to `authorize`
  is `Dialog { showing, changed_at_seq }`: the screen seq at which a dialog
  last appeared or changed (the host maps the daemon's dialog generation onto it).
- The host accepts one `Resync` a second per device per session; a device
  re-asks on a timer, so a quiet session never leaves it stale.
- Queues: 2 MiB per session stream, 256 KiB for the control stream. A start
  title is at most 200 bytes. Names and titles refuse control characters,
  line and paragraph separators, bidi and zero-width characters.
- Message tags are the variant positions (postcard), append-only, pinned by
  golden tests; so are the numbers of `RefuseReason`, `SessionStatus`, `Role`
  and `Holder`.

**Projects.** Right after `Welcome`, and again whenever it changes, the host
sends `ProjectList { projects: [ProjectInfo { id, name, parked }] }`, Viewers
included: the store's projects whose folder passes the same check a remote
start uses, in store order. `parked` follows the desktop's rule (every open
session in it is parked).

**Other messages:** `Control { session_id, holder, epoch }` on the control stream. host to device `StartResult { request_id, session_id }`
and `SessionStatus { session: SessionInfo }`. On `kriyon/pair/1`:
`PairRequest { device_name, proof }` (proof = the 32-byte HMAC of §4),
`Paired { host_name }` and `Refused`; a device name over 64 bytes is refused
`OutOfRange`. Message tags are fixed numbers, numbered separately for each
direction.

There are no file messages in version 1: a remote device can't read or
write files except by typing in a terminal it controls.

## 9. Starting sessions

`StartSession { request_id, project_id, title?, worktree: false }`. No args,
env or flags from the device. Existing projects only at first. The host keeps
`(device_id, request_id)` with the result for 24 hours, on disk, so a resend
returns the same session instead of starting two; a resend is answered from
that record before any folder re-check. Every answer names the request:
`StartResult { request_id, session_id }` or
`StartRefused { request_id, reason }` (not the plain `Refused`). The new
session joins the desktop's sidebar without taking its window, with claude
already running. Worktree setup stays off
for remote starts, because it runs scripts.

## 10. Push

1. The push sender publishes one X25519 public key with a key id.
2. The phone seals `{ token, platform, host_id, expires }` (expires about 60
   days, renewed on every connect) once per host with HPKE (RFC 9180, base
   mode, DHKEM X25519-HKDF-SHA256, HKDF-SHA256, ChaCha20-Poly1305, info
   `"kriyon push token v1"`), and sends it to the host as `PushToken { key_id, sealed }`, naming the sender
   key it sealed to.
3. To wake the phone, the host makes an HTTPS POST to the sender with
   `{ sealed, at, request_id }` and an Ed25519 signature by its device key over
   the postcard bytes of `("kriyon push wake v1", sender_key_id, SHA-256(sealed), at, request_id)`.
4. The sender checks the signature, the time (±5 minutes), the expiry and that
   `host_id` matches the signer, refuses a `request_id` it saw in the last
   10 minutes (kept in memory only), applies in-memory limits per host and per
   token hash (1 a minute, 30 a day) and a cap on the sealed size, opens the
   token in memory, sends one visible alert "A session needs you" through APNs
   or FCM, and forgets it.
5. **Key rotation.** The sender keeps retired secrets by `key_id` and opens
   tokens sealed to them until the longest token expiry (60 days); the host
   sends the token's own `key_id` in the wake. Phones reseal to the newest key
   on their next connect. Unknown ids are refused.
6. Field types: `key_id` u32; `request_id` 16 random bytes; `at` and
   `expires` Unix seconds; `platform` APNs = 0, FCM = 1. `sealed` is
   `enc (32 bytes) ‖ ciphertext`, at most 1 KiB. Test vectors made
   independently of our code are in `crates/kriyon-remote/tests/push_vectors.json`.
7. The sender could notice one phone's token arriving from several hosts. Not
   linking them is a policy promise; the crypto doesn't prevent it.
8. Alerts are a hint. The app re-checks the host each time it opens.

## 11. Fault tests (CI)

Cut the network mid-stream; sleep and wake the host; kill and restart the
relay; crash the host mid-write; a slow device beside a fast one; a device
that never reads its control stream; a stale epoch after a takeover; input
buffered across a reconnect; a dialog that appears after `seen_seq`; a resend
of `StartSession`; an oversize length prefix; a zstd bomb; an unknown message;
a device removed while connected; a leaked pairing QR used first. Each must
end in the behaviour above, with no lost session and no replayed input.

## Open

- Readable-view entry format (follows the Structured view work).
- Exact Tailscale port and how the host learns its Tailscale address (spike).
- Whether `kriyon-remote` reuses the [Daemon frame] codec or keeps its own.
- An app lock on the phone, since a stolen Controller phone has shell access
  until the person removes it on the host.
