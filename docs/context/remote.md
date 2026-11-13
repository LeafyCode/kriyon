# Remote access

Watching and typing into a host's sessions from a phone or another computer (ADR-0057).

Part of the Kriyon glossary. The index and the naming rule are in [`CONTEXT.md`](../../CONTEXT.md).

- **Remote access** — the Settings switch, off by default, that lets [Paired device]s reach this
  computer's [Session]s. With it off the [Host] opens no network listener. _Avoid_: remote mode,
  sharing.
- **Host** — the computer whose [Session]s run and whose Rust core answers [Remote device]s. Any
  Mac (Windows later) can be one. _Avoid_: server, desktop (a desktop can also be a remote device).
- **Remote device** — a phone or another computer that reaches a [Host]'s sessions over a
  [Remote link]. It holds no session; it shows the host's. _Avoid_: client (taken by [Daemon
  client]), peer.
- **Device key** — a device's own Ed25519 key pair; its public half is the device's iroh endpoint
  id. Kept in the OS keychain, never synced or sent. _Avoid_: node id, identity.
- **Pairing** — adding a [Remote device] to a [Host] in person: an expiring QR code on the host,
  a matching [Pairing code] confirmed on both screens. The only way a device is ever trusted; an
  account can't do it. _Avoid_: linking, login.
- **Pairing code** — the 6-digit code both screens show during [Pairing], derived from the
  encrypted connection so a device in the middle can't make them match.
- **Paired device** — a [Remote device] the [Host] has stored after [Pairing], with its name,
  [Device key] and role ([Viewer] or [Controller]). Removing it on the host cuts it off at once.
- **Viewer** — a [Paired device] role that sees screens and status but can never send input,
  resize, take control or start a session. _Avoid_: read-only device; not the local idea of
  "someone is looking" at a session.
- **Controller** — a [Paired device] role that can do anything the person can in a terminal,
  including typing, which is full shell access as them. _Avoid_: admin, editor.
- **Remote link** — one encrypted iroh connection between a [Remote device] and a [Host]
  (direct, or through a relay). Losing it never stops a session. _Avoid_: tunnel, session (a
  [Session] is Claude's).
- **Typing control** — which one device may send input and resize to a [Session] right now. The
  person at the host can always take it back. Each change bumps a **control epoch** that every
  input carries, so a late keystroke from the old holder is refused. _Avoid_: lock, focus.
- **Session run** — one start of a [Session]'s process. [Screen update] numbers restart with
  each run, and input names the run it was meant for. _Avoid_: generation, incarnation.
- **Screen update** — a numbered, compressed chunk of a [Session]'s output sent to a [Remote
  device] after its first [Screen snapshot]. A gap in the numbers means "send the whole screen",
  never a guess. _Avoid_: delta, diff (taken by [File diff]).
- **Skip ahead** — what the [Host] does when a [Remote device]'s queue fills: drop it and send a
  fresh [Screen snapshot], so a slow device never slows the session or another device.
- **Relay pass** — a signed, short-lived pass from a BisBig subscription, bound to one [Device
  key], that our relay checks by itself. Its format is the relay contract's. _Avoid_: ticket
  (iroh uses that for addresses), token.
- **Sealed push token** — a phone's push token locked to the push sender's public key, one copy
  per [Host], with an expiry. Only the push sender can open it, in memory, for one alert. No
  server keeps it. _Avoid_: encrypted token, push id.
- **Push sender** — the small open service that opens a [Sealed push token] and asks Apple or
  Google to show "A session needs you". Stores nothing.
