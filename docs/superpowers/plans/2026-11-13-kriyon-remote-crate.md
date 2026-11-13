# Plan: `crates/kriyon-remote` and Mac to Mac with no account

**Date:** 2026-11-13
**Spec:** [`specs/2026-11-13-remote-protocol.md`](../specs/2026-11-13-remote-protocol.md), [ADR-0057](../../adr/0057-remote-access.md)
**Branch:** work lands on `feat/remote-access`; one PR at the end.

Each step is TDD, ends green (`pnpm check`), gets one code review, and is merged into
`feat/remote-access` by the lead. Check every library API with Context7 first (iroh, postcard,
zstd, hmac, sha2, ed25519-dalek, hpke): they move fast.

## Step A — the pure core (no network)

New crate `crates/kriyon-remote`, joined to the Cargo workspace, clippy `pedantic` like the others.
No iroh, no Tauri, no IO. Everything here is unit-tested in milliseconds.

1. **Messages** (`message.rs`): the device→host and host→device enums from the spec (§5–§9), with
   `Refused { reason }` and the reason enum.
2. **Codec** (`codec.rs`): `[u32 len BE][varint tag][postcard body]`; per-direction size limits
   (§3); unknown tag → `Unknown`; trailing bytes ignored; a too-long length is an error, never
   buffered. Reuse the shape and tests of `kriyon_core::wire::FrameDecoder`, not its code.
3. **Compression** (`compress.rs`): one zstd frame per update, content size required,
   `window_log_max = 23`, 8 MiB decompressed cap; snapshot split into `SnapshotPart`s over 1 MiB.
4. **Control** (`control.rs`): per-session [Typing control] state: holder, epoch
   `(host_boot_id, counter)`, the takeover rules in §7 (host typing wins; remote takes from host
   only after 10 s idle or a click), release on disconnect, removal, role change.
5. **Authorize** (`authorize.rs`): `authorize(device, message, state) -> Allow | Refuse(reason)`,
   one row of the §8 table per test, plus `recheck_at_write(...)` for the PTY-writer task. The
   folder check calls `kriyon_core::folder::check_folder` (from the folder path check work); the
   size bounds reuse the resize bounds in `kriyon_core::session`.
6. **Screen stream** (`screen.rs`): `run` (random u64) and `seq` bookkeeping on both ends; gap or new
   run → `Resync`; `seen_seq` vs the last dialog change → `Stale`.
7. **Device queue** (`queue.rs`): byte-bounded per-device queue; full → drop and mark
   [Skip ahead]; control queue full → close.
8. **Pairing crypto** (`pairing.rs`): HMAC of `"kriyon pair v1" || device_id || host_id`
   (constant-time compare), pairing code from exporter bytes (§4 step 3), with fixed test
   vectors in `tests/vectors.json` so the phone library can check against the same numbers.

## Step B — the link (iroh)

1. `endpoint.rs`: iroh endpoint from the [Device key]; minimal preset (no address lookup); relay
   off unless a relay URL is set; optional fixed UDP port (for Tailscale, from the spike); no 0-RTT.
2. Accept loop: check the peer id against [Paired device]s before any stream; rate-limit unpaired
   handshakes; ALPN `kriyon/pair/1` only while a pairing is pending.
3. Streams: control stream + one stream per open session, ≤ 16; heartbeat every 15 s; device
   reconnect with backoff ≤ 30 s, stop on `NotPaired`.
4. In-process tests: two endpoints over loopback, pairing end to end, then a session stream.

## Step C — the host in the app

1. Store: paired devices table, pairing secrets in memory only, `(device_id, request_id)` table.
2. Settings: [Remote access] switch (off by default) and the consent screen (ADR-0057 copy,
   including "a Viewer sees every session's screen"). Off = no endpoint.
3. Pairing UI: QR code, code entry with 3 tries, device list with role change and remove.
4. Fan-out: the [Daemon client]'s `on_read` feeds a per-device screen stream; snapshots from the
   daemon's emulator. The desktop stays the daemon's only client.
5. Input: device input goes through `authorize`, then the single PTY-writer task rechecks run,
   epoch, paired and dialog atomically with the write.
6. Needs: status, Needs-you and the dialog check in Rust (fix-first table) before 5 is finished.

## Step D — the desktop as a remote device

A "Connect to another computer" view in the desktop app: scan or paste the pairing payload, the
session list from the host, the terminal view fed by the screen stream, typing with control.
Mac to Mac is the first end-to-end test.

## Step E — fault tests (CI)

The list in spec §11, run against two in-process endpoints with a fake PTY: cut the network
mid-stream, sleep/wake (pause the host task), kill the relay (when relay support lands), crash
mid-write, slow device beside a fast one, a device that never reads its control stream, stale
epoch after takeover, input buffered across a reconnect, dialog after `seen_seq`, resend of
`StartSession`, oversize length, zstd bomb, unknown message, device removed while connected,
leaked pairing QR used first.

## Later steps (own plans)

Relay pass support (against the relay contract), the push sender crate, the Expo app shell,
Windows.
