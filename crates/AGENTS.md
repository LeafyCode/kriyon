# crates — agent rules

Read the root `AGENTS.md` first. These crates live here:

- **`kriyon-core`**: the pure logic the app is built on: parsing, status, diffs, sandbox rules,
  notifications. No Tauri. Most new behaviour belongs here, because here it can be unit-tested
  in milliseconds.
- **`kriyon-ptyd`**: the per-session PTY daemon. One process owns one PTY and its shell and
  serves the app over a Unix socket, so a session survives an app crash. It ships as a Tauri
  sidecar.
- **`kriyon-remote`**: the remote protocol as pure logic (ADR-0057): messages and codec, the
  host's one `authorize` check, typing control, screen fan-out, queues, compression, pairing,
  the readable view's entries, the device's view of a host, relay rules. No network, no tokio,
  no IO; shared by the desktop and the phone. It re-exports `kriyon-push-seal` as
  `kriyon_remote::push`.
- **`kriyon-push-seal`**: the push crypto alone (spec §10): sealing a push token to the push
  sender's key, signing and checking a host's wake-up, pinned by independent test vectors. Its
  own crate so the push sender builds without the rest of the protocol (and its zstd).
- **`kriyon-remote-link`**: the network side over iroh: the endpoint, the host's accept loop,
  the host runtime (`host_runtime`: serving paired devices, the app behind `ServeHost`), the
  device runtime, keys behind the `SecretVault` trait. The phone and the desktop both use it.
  Shared loopback fakes for tests are behind its `test-support` feature; its relay tests run a
  local iroh relay (a dev-dependency only).
- **`kriyon-relay-client`**: our relay as an app uses it (the relay pass contract): device
  sign-in, the relay API calls, this device's pass and when to renew it. The desktop and the
  phone share it; the pure rules are `kriyon_remote::relay`'s.
- **`kriyon-mobile`**: the phone's library, through UniFFI (Swift and Kotlin call it alike). The
  device runtime is `kriyon-remote-link`'s, the same as the desktop's; this adds what only the
  phone has: its store (the device key, the paired computers, the relay sign-in) behind a trait
  the app provides, pairing, giving each computer the sealed push token, keeping the relay
  pass, and the JSON its screens read. Its rules live in the crates it calls. Built for the
  phones by `scripts/mobile/build-ios.sh` and `build-android.sh`; tested in `pnpm check`.
- **`kriyon-push`**: the push sender, a small open server that opens a sealed push token in
  memory and sends one alert. Keeps nothing on disk and never logs addresses or tokens; a test
  fails if one appears. It depends on `kriyon-push-seal` only.

## Rules

- **Keep the remote crates' layers.** `kriyon-remote` stays pure; anything that needs the
  network goes in `kriyon-remote-link`; nothing BisBig-specific (hostnames, keys) goes anywhere
  in this repo, only build-time config.
- **Keep `kriyon-core` free of Tauri and app state.** Take inputs as arguments and return
  values. A function that needs the app to run can't be tested here.
- **Parse defensively.** Anything read from Claude Code (transcript lines, hook payloads, the
  screen) has a fallback: an unknown line becomes `StructuredEvent::Unknown`, a missing field
  a default. Claude Code changes formats without notice.
- **Return errors; don't panic.** Use `Result` (`thiserror` in `kriyon-core`). A panic in the
  daemon kills the user's session. (`expect` is fine in tests.)
- **Clippy `pedantic` is on** for both crates. Fix the lint rather than allowing it, and give a
  reason in a comment when an `#[allow]` is truly needed.
- **After changing `kriyon-ptyd`, rebuild the sidecar** with `node scripts/sidecar-ptyd.mjs`.
  The app runs the copy in `src-tauri/binaries/`, not `target/`, and a fresh worktree has none.

## Code that runs inside the user's Claude Code

`kriyon-core` embeds three files that run in the user's own `claude` process, not in Kriyon:

- `scripts/kriyon-hook.py` and `scripts/kriyon-usage.py`: the hook and status-line scripts.
- `companion/companion.js`: the Kriyon Companion mod.

These **observe and never steer**. Every path exits cleanly, passes the event on unchanged, and
never blocks, approves or rewrites anything, because a bug here breaks the user's Claude, not
just Kriyon. The one exception is nested sessions (ADR-0049): the companion registers one
deferred tool, `start_session`, and a nested session sends one report to its lead session,
allowing only that one SendMessage of its own in `tool.check`.
Kriyon, not the mod, decides whether a requested session starts. They do nothing outside a
Kriyon session: the hook scripts check `KRIYON_SESSION`, the companion `KRIYON_BRIDGE_SOCKET`.

- The hook scripts are tested from Rust (`hooks.rs`), and the redaction cases are shared with
  `redact.rs` through `scripts/redaction-cases.json`; change both sides together.
- The companion is tested with `node --test crates/kriyon-core/companion/*.test.mjs`.
