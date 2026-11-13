# ADR 0057 — Remote access: Kriyon's first network path, off by default, paired in person

**Date:** 2026-11-13
**Status:** Proposed
**Relates to:** [ADR-0004](0004-server-side-screen-snapshot-for-reattach.md), [ADR-0021](0021-file-entry-sandbox-and-delete-to-trash.md), [ADR-0022](0022-session-processes-end-on-intent-survive-accidents.md), [ADR-0034](0034-kriyon-companion-mod.md), [ADR-0040](0040-cli-dialogs-answered-in-the-terminal.md)

## Context

People want to watch and answer their Claude sessions from a phone or another
computer while the sessions keep running on their own machine. Until now
nothing Kriyon does leaves the Mac: ADR-0034 says so for the Companion, and
every socket is a local Unix socket. Remote access breaks that promise on
purpose, so it needs its own decision, its own switch and its own consent.

The design was researched and reviewed in November 2026 (iroh's relay and
hole punching, push without stored tokens, a traffic test, a hidden-window
freeze test). The full protocol is in
[`docs/superpowers/specs/2026-11-13-remote-protocol.md`](../superpowers/specs/2026-11-13-remote-protocol.md).

## Decision

- **Off by default.** A Settings switch, [Remote access], turns it on. Turning
  it on shows a consent screen that says in plain words what changes: other
  devices you pair can see and type into your sessions; a Controller can do
  anything you can do in a terminal; traffic is end-to-end encrypted; through
  our relay it passes a server that can't read it. With the switch off, the
  host opens no network listener and Kriyon behaves exactly as before.
- **The session lives on the [Host].** A [Remote link] is only a window into
  it. Losing a link never stops, pauses or slows a session.
- **Transport: iroh.** QUIC with each device's own Ed25519 [Device key];
  direct when it can, through a relay when it can't. We write no crypto.
  Three ways to connect: same network, the person's own Tailscale, or our paid
  relay (a [Relay pass] from a BisBig subscription). No "your own relay"
  option for now.
- **Pairing is in person.** The host shows an expiring QR code; the other
  device scans it and shows a short [Pairing code]; the person types that
  code into the host. Only then is the device stored, so a leaked QR used
  first fails safe. Only a [Paired device] may open a link. An account (BisBig) only pays
  for the relay: it can never add a device or reset access, so a stolen
  account or a breach on our side can't reach anyone's sessions.
- **Two roles: [Viewer] and [Controller].** Chosen at pairing, changed only on
  the host. We say plainly that a Controller has full shell access as you.
- **One device types at a time.** [Typing control] belongs to one device per
  session; the person at the host can always take it back with one click.
  Every input and resize names the [Session run] and the control it was sent
  under, so a late message can't land after someone else took over.
- **The host checks every message.** One shared check in Rust runs before any
  action: is the device paired, what is its role, does it hold typing control,
  does the session exist, is the folder inside an approved root (the same
  check the IPC boundary uses), are sizes and lengths sane. A refusal is
  answered and logged on the host. Hiding a button on the phone protects
  nothing, so no rule lives only in a UI.
- **The desktop app stays the PTY daemon's only client.** It fans the screen
  out to remote devices, each with its own bounded queue. A device that falls
  behind skips ahead to a fresh [Screen snapshot]; it never slows the session
  or another device.
- **Never drop silently.** A heartbeat every 15 seconds from the host's main
  loop; a dimmed "Disconnected, reconnecting" screen with typing off;
  numbered [Screen update]s where a gap means "send the whole screen"; old
  keystrokes are never resent after a reconnect.
- **Dialogs are answered in the terminal** (ADR-0040), remotely too. The host,
  not the remote device, refuses composer text while a CLI dialog is showing.
- **Push stores nothing.** The phone gives each host a [Sealed push token]
  only our push sender can open. The host signs each wake-up; the sender opens
  the token in memory, sends one plain "A session needs you" alert through
  Apple or Google, and forgets it. No server keeps a list of phones.
- **What leaves the host:** screen bytes, session list and status, and
  readable-view entries, only to paired devices over the encrypted link; the
  sealed token and a signed wake-up to the push sender. Never credentials,
  never the transcript file itself. Version 1 has no file messages: a remote
  device reaches files only by typing in a terminal it controls.
- **The consent screen says a Viewer sees every session's screen**, including
  anything secret printed there. Roles are per device, not per session.
- **Local typing always wins.** Typing at the host takes control back at
  once; a remote device takes it from the host only after the host has been
  idle a few seconds or the person lets it.

## Consequences

- ADR-0034's "nothing leaves the Mac" stays true for the Companion and for
  everything when Remote access is off. With it on, this ADR is the rule.
- Status, Needs-you and the dialog check move from the desktop UI into the
  Rust core, so the host can answer a remote device without the window open.
- The host must keep reading every session when the window is hidden (the
  hidden-app freeze is fixed first).
- Paths from a remote device go through the same approved-root check as paths
  from the webview; a second path that skips it is a bug.
- The protocol is versioned; a test fails if a change would break the last
  released phone app.
- A paid outside security review happens before public release.
- The host's Device key sits in the login keychain: never synced, readable
  while the person is logged in, by Kriyon only. Apple's stronger
  "this device only, when unlocked" mode needs the data-protection keychain,
  which a Developer ID app gets only with a provisioning profile; the code
  uses it as soon as the build is signed with one.
