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
  id. Made once and never replaced, since every pairing depends on it. On the Mac it is kept in the
  login keychain, never synced or sent; the stronger device-only mode needs a provisioning profile.
  On Linux it is kept in the desktop's keyring (the Secret Service: GNOME Keyring, or KWallet
  with its Secret Service on); a keyring that is missing or locked is an error, never a file.
  _Avoid_: node id, identity.
- **Pairing** — adding a [Remote device] to a [Host] in person: an expiring QR code on the host,
  then the device's [Pairing code] typed into the host. The only way a device is ever trusted; an
  account can't do it. _Avoid_: linking, login.
- **Pairing code** — the 6-digit code the [Remote device] shows during [Pairing] and the person
  types into the [Host]. Derived from the encrypted connection, so a device that connected with
  a leaked QR code shows a code the person never sees on their own device.
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
- **Session run** — one start of a [Session]'s [PTY daemon] (and the shell inside it), named by a
  random id the daemon makes when it starts and sends on attach, so a run survives an app
  restart. [Screen update] numbers restart with each run, and input names the run it was meant
  for. Not the Companion bridge's `run`, which counts `claude` processes inside one session.
  _Avoid_: generation, incarnation.
- **Screen update** — a numbered, compressed chunk of a [Session]'s output sent to a [Remote
  device] after its first [Screen snapshot]. A gap in the numbers means "send the whole screen",
  never a guess. _Avoid_: delta, diff (taken by [File diff]).
- **Readable view** (`kriyon_core::readable`, `Entry`) — a [Remote device]'s view of a
  [Session] as entries (the prompt, Claude's reply, steps, reports, a question showing) instead
  of the terminal: what the [Structured view] shows, redacted and trimmed for a phone. Off with
  the companion off ("exact or off"). _Avoid_: chat view, transcript view.
- **Nested record** (`kriyon_remote::nested`) — a record inside a remote message (a session's
  entry, a [Readable view] entry) sent as its own bytes with their length first, so it can grow:
  an older reader skips fields it doesn't know, a newer one reads fields an older writer left out
  as zero ("none"). _Avoid_: envelope, blob.
- **Session fan-out** (`kriyon_remote::fanout::SessionFanout`) — the [Host]'s one copy of a
  [Session]'s screen stream for every [Remote device] that has it open: it numbers the output as
  [Screen update]s once, asks the [PTY daemon] for each device's [Screen snapshot], and keeps a
  bounded queue per device, so a slow device [Skip ahead]s alone. _Avoid_: broadcaster, mux.
- **Skip ahead** — what a sender does when one receiver's queue of a [Session]'s output fills:
  drop the queue and send a fresh [Screen snapshot] instead, so a slow receiver never slows the
  session or anyone else. The [PTY daemon] does it for the app (ADR-0059), and the [Host] for each
  [Remote device]. Both use `kriyon_core::skip_ahead`.
- **Relay pass** — a signed, short-lived pass from a BisBig subscription, bound to one [Device
  key], that our relay checks by itself. Opaque to the app: stored, sent, never parsed. Its format
  is the relay contract's (`docs/superpowers/specs/2026-11-13-relay-pass-contract.md`). _Avoid_:
  ticket (iroh uses that for addresses), token.
- **Relay account** — the BisBig subscriber a [Relay pass] names (16 random bytes, not the BisBig
  user id). Our relay only forwards between devices of the same relay account, so a [Host] and
  every [Remote device] that reaches it through our relay sign in with the same BisBig account.
  _Avoid_: relay user, subscription (that is what pays for it).
- **Device sign-in** — signing Kriyon in to BisBig with a device code (OAuth device grant, RFC
  8628): the app shows a short code and opens the BisBig sign-in page in the browser; the person
  approves there. The app never sees a password. Its access token is kept in the keychain (on
  Linux, the keyring).
  _Avoid_: login, account link.
- **Sealed push token** — a phone's push token locked to the push sender's public key, one copy
  per [Host], with an expiry. Only the push sender can open it, in memory, for one alert. No
  server keeps it. _Avoid_: encrypted token, push id.
- **Push sender** — the small open service that opens a [Sealed push token] and asks Apple or
  Google to show "A session needs you". Stores nothing.
- **Session gate** — a [Session]'s one holder of [Typing control], its [Session run], dialog state
  and sizes, kept by the host's per-session writer. Every write to the PTY, the desktop's and a
  device's, goes through it, and a device's write is rechecked inside it, atomically with the
  write. _Avoid_: lock, writer lock.
- **Serve** — the host's side of [Remote link]s: it answers each [Paired device]'s control stream
  and session streams, fans a session's screen out to every device that has it open, and passes
  input to the [Session gate]. _Avoid_: server (the relay and push sender are servers).
- **Link state** — what a [Remote device] shows about its [Remote link] to a [Host]: connecting,
  connected, lost (no heartbeat for 40 s; typing off, reconnecting) or removed (refused as not
  paired; it stops retrying). _Avoid_: online/offline.
- **Remote start** — a new [Session] started from a [Remote device] in one of the [Host]'s
  projects, answered once per request id, so a resend never starts two. It joins the desktop's
  sidebar without taking the window. _Avoid_: remote launch.
- **Project list** — the [Host]'s projects a [Remote start] would accept, sent to every [Paired
  device] after it connects and whenever it changes.

