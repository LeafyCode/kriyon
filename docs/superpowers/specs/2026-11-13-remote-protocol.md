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
- **Push sender** — opens a [Sealed push token] and sends one alert. Stores nothing.

The desktop app is the [PTY daemon]'s only client. The host side of this
protocol lives in the app's Rust core and reads sessions through the same
[Daemon client] the window uses.

## 2. Transport

- iroh 1.x endpoint per device. The endpoint id is the device's Ed25519
  public key ([Device key]); the secret stays in the OS keychain, never synced.
- ALPN `kriyon/remote/1`. The number is the major protocol version; a new
  major gets a new ALPN, and the host serves the last released one beside it.
- Address lookup: none by default (iroh's minimal preset). Each device stores
  the host's endpoint id plus the ways to reach it it learned at pairing:
  LAN addresses, an optional Tailscale address with the host's fixed port, and
  the relay URL when the person subscribes.
- One QUIC connection per device per host. Inside it:
  - **Control stream** (first bidirectional stream): hello, heartbeats,
    session list, status, control changes, refusals.
  - **One session stream per open session** (bidirectional): screen down,
    input and resize up. Closing it detaches; the session keeps running.

## 3. Encoding

- Each message is `[u32 length, big-endian][postcard-encoded enum]`, the same
  length-prefixed shape as the [Daemon frame]. Maximum length 1 MiB; a longer
  length is a protocol error and closes the stream (never buffered).
- Enums carry an `Unknown` arm on decode: an unknown message is skipped and
  answered with `Refused { reason: UnknownMessage }`, never a crash. Fields are
  only ever appended; removing or reordering one is a new major version.
- Screen bytes are zstd-compressed per [Screen update].

## 4. Pairing

1. On the host the person picks a role and presses "Pair a device". The host
   makes a one-time pairing secret (32 random bytes) valid for 5 minutes and
   shows a QR code: host endpoint id, host addresses, the secret, the role.
2. The device scans it and connects with ALPN `kriyon/pair/1`, sending its
   endpoint id, a device name and an HMAC of its id under the secret.
3. Both sides derive a 6-digit [Pairing code] from the QUIC connection's
   exported keying material (RFC 5705 exporter, label `kriyon pairing`).
   Both screens show it; the person confirms on both. A mismatch or a timeout
   ends it.
4. The host stores the device (endpoint id, name, role, paired at) in its
   store. The secret is burnt after one use, success or not.

Removing a device on the host closes its links at once and forgets it. The
device learns only that it was refused.

## 5. Connecting

1. Device opens `kriyon/remote/1`. iroh already proved both endpoint ids.
2. Host looks up the remote endpoint id among [Paired device]s. Not found:
   close with `NotPaired`.
3. Device sends `Hello { app_version, protocol_minor, last_seen_runs }`. Host
   answers `Welcome { host_name, protocol_minor, role, sessions }`.
4. Heartbeat: host sends `Heartbeat { seq, at }` every 15 s from the app's main
   loop, so it proves the app is alive, not just the socket. A device with no
   heartbeat for 40 s shows "Disconnected, reconnecting" and turns typing off.
5. Reconnect backs off to at most 30 s and retries at once on a network change
   or when the app comes to the front. It never gives up.

## 6. Sessions and screens

- `SessionList` lists sessions with id, title, project, [Status] and whether
  each needs the person (the Needs-you list), computed in Rust.
- `Open { session_id }` on a new session stream. Host checks the session
  exists, then sends `Snapshot { run, seq, cols, rows, bytes }` (the
  [Screen snapshot], ADR-0004) followed by `Update { run, seq, bytes }`
  for every chunk of output.
- **[Session run]** — a number that changes each time the session's process
  starts. `seq` restarts with each run. A device that sees a gap in `seq` or a
  new `run` asks `Resync` and gets a fresh `Snapshot`; it never guesses.
- Each device has its own bounded queue on the host. When it fills, the host
  drops the queue and sends a fresh `Snapshot` with `skipped: true`; the device
  shows "Skipped ahead". It never blocks the session or another device.
- Readable view entries (`Entry { … }`, trimmed, from the Structured view's
  data) come on the same stream when the device asks for them. Details in a
  later revision.

## 7. Input and control

- `TakeControl { session_id }` → host grants [Typing control] if the device is
  a Controller, and tells every device who holds it (`Control { holder, epoch }`).
  `epoch` goes up with every change. The person at the host can always take it
  back; that bumps the epoch.
- `Input { run, epoch, bytes }` and `Resize { run, epoch, cols, rows }` must
  carry the current run and epoch. A stale one is refused, not applied.
- Composer text (`Compose { run, epoch, text }`) is refused while a CLI dialog
  is showing (ADR-0040); keys sent to the terminal view are not.
- While a remote device holds control it may resize to its own size, never
  under 80 columns. When control returns to the host, the host's size comes back.
- Receipts are honest: `InputAck { epoch, written: bool }` means the bytes
  reached the PTY, not that Claude acted on them. Keystrokes are never
  resent after a reconnect.

## 8. The host's one check

Every message from a device passes `authorize(device, message, host_state)` in
`kriyon-remote` before anything acts on it. It returns `Allow` or
`Refuse(reason)`, and every refusal has a test:

| Check | Refusal |
|---|---|
| Device is paired | `NotPaired` |
| Role allows it (Viewer: no input, resize, control, start) | `NotAllowed` |
| Holds typing control, current run and epoch | `NotInControl`, `Stale` |
| Session exists | `NoSuchSession` |
| Folder inside an approved root (same check as the IPC boundary) | `FolderNotAllowed` |
| Sizes and lengths in range (shared bounds with the local resize command) | `OutOfRange` |
| No composer text while a dialog shows | `DialogOpen` |

Refusals are answered with `Refused { reason }` and logged on the host.

## 9. Starting sessions

`StartSession { request_id, project_id, … }`. Existing projects only at first.
The host stores `request_id`, so a resend never starts two sessions. Worktree
setup stays off for remote starts by default, because it runs scripts.

## 10. Push

1. The push sender publishes one X25519 public key.
2. The phone seals `{ token, platform, host_id, expires }` (expires about 60
   days, renewed on every connect) to that key, once per host, and sends it to
   the host as `PushToken { sealed }`.
3. To wake the phone the host sends the sender `{ sealed, at, request_id }`
   signed with its device key. The sender checks the signature, the time
   (±5 min), the expiry and that `host_id` matches the signer, refuses a
   repeated `request_id`, opens the token in memory, sends one visible alert
   "A session needs you" via APNs or FCM, and forgets it.
4. Alerts are a hint. The app re-checks the host each time it opens.

## 11. Fault tests (CI)

Cut the network mid-stream; sleep and wake the host; kill and restart the
relay; crash the host mid-write; a slow device beside a fast one; a stale
epoch after a takeover; a resend of `StartSession`; an oversize length prefix;
an unknown message; a device removed while connected. Each must end in the
behaviour above, with no lost session and no replayed input.

## Open

- Readable-view entry format (follows the Structured view work).
- Exact Tailscale port and how the host learns its Tailscale address (spike).
- Whether `kriyon-remote` reuses the [Daemon frame] codec or keeps its own.
