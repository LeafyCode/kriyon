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

Design decided at the end of Phase 1 (architecture review, `phase1-architecture-review.md` in the
plan folder):

- **Start without the webview.** Split `create_session` into a Rust `start_session(app, id, cwd,
  sinks)` that takes an output-sink trait; the desktop's webview Channels are one sink, a remote
  device's screen stream another. "Save the rows, then launch claude" moves from TypeScript into
  Rust, with the launch decision in kriyon-core. Needed for remote `StartSession` and for waking a
  sleeping session from a remote device while the window is hidden.
- **One writer per session.** A per-session writer in `AppState.sessions` owns [Typing control]
  and the engine write. Desktop typing goes through it as the host holder, which records "host
  last typed" for the takeover rule; remote input is a second caller, and `recheck_at_write`
  runs inside it, atomically with the write.
- **One reader hook.** The [Daemon client] hands every daemon frame (output, dialog, busy,
  history, snapshot) to one in-order `on_event` before any webview pacing; the remote fan-out
  hangs off it.
- **Snapshots per device** come from the daemon's `RequestSnapshot{id}`, which doesn't repaint
  the desktop.

1. Store: paired devices table, pairing secrets in memory only, `(device_id, request_id)` table.
2. Settings: [Remote access] switch (off by default) and the consent screen (ADR-0057 copy,
   including "a Viewer sees every session's screen"). Off = no endpoint.
3. Pairing UI: QR code, code entry with 3 tries, device list with role change and remove.
4. Fan-out: the [Daemon client]'s `on_read` feeds a per-device screen stream; snapshots from the
   daemon's emulator. The desktop stays the daemon's only client.
5. Input: device input goes through `authorize`, then the single PTY-writer task rechecks run,
   epoch, paired and dialog atomically with the write.
6. Needs: status, Needs-you and the dialog check in Rust (fix-first table) before 5 is finished.
7. A session a remote device opens counts as an Onlooker for auto-sleep, and wakes a sleeping
   session the same way desktop focus does (wake-on-focus and the focused-wake retry read
   desktop focus only today).
8. TODO: remote `StartSession`. The host refuses it `NotAllowed` for now (`remote_serve`); it
   waits for `create_session` to be split into a Rust `start_session` that runs without the
   webview (the first design point above), then goes through `kriyon_core::folder` checks and
   the `(device_id, request_id)` table.

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

## Built after Step E (14 Nov)

- Relay pass support: device sign-in, pass and renewal, endpoint rebuild at a quiet moment,
  refusal handling, the "Our relay (paid)" settings section. Contract:
  `specs/2026-11-13-relay-pass-contract.md`.
- Push: sealing and signing in `kriyon-remote::push`, the sender crate `kriyon-push`, host wakes,
  key rotation by `key_id`.
- Remote starts: session start moved into Rust (`session_start`), the device's start with the
  host's Project list, on the desktop and the phone.
- The phone: `kriyon-mobile` (UniFFI), the Expo app in `mobile/app` with its native module, Home,
  Pair (paste and QR), the terminal view, push registration, a dev host example, and a CI job.

## Built after the phase 2 review (14 Nov)

- The phase 2 architecture review's fixes, one host summary record shared by the desktop and
  the phone, and the relay on the phone.
- The readable view: entries built by `kriyon_core::readable`, sent and read again as they change,
  on a session stream that can be open for its entries only; the screen turns on and off on
  the same stream; the desktop and the phone both show it.
- One numbered view per remote session on the device (`set_view`, ADR 0062).
- Home data: each session's digest (question, tool running, since when, the last turn's end and
  its changes), the host's plan limits, the link's path and when it was last heard from.
- The wire format can grow: session and entry records are nested records (spec §3), entry
  enums are pinned, a report's outcome is a number.
- Pairing shows the role offered and the code's expiry; a phone gives back control and turns its
  alerts off and on; it writes to Claude from the readable view (`Compose`, with the run told on
  a screen-off stream); every write's answer names it (`write_id`).
- A shared JSON fixture tested by Rust and TypeScript, so the apps' types follow Rust's.
- The relay end to end, on a local iroh relay with the pass contract's check: pairing, a session,
  refused passes and a relay restart (the last §11 fault test).
- Push crypto in its own crate (`kriyon-push-seal`), so the push sender builds without zstd; key
  stores implement one trait; the phone app needs Android 9 (minSdk 28) so its keys open only
  while it is unlocked.

## Next

- The phase 3 review's items for the mobile session: the relay pass keeper built once
  (`kriyon-relay-client`, both apps' refusal watching with it).
- Windows key stores and the rest of item 9, with the Windows host (PR #48).
- Device tests by the person: Mac to Mac, iPhone, Android, the hidden-app freeze, session start.
- Windows as a host and a device (own plan).
- Before the first release: ADR 0057 and the spec's status, and the docs drift the release PR
  checks.

## Later steps (own plans)

Relay pass support (against the relay contract), the push sender crate, the Expo app shell,
Windows.
