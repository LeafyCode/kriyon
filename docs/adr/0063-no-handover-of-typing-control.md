# ADR 0063 — Whoever types reaches the session: no handover of typing control

**Date:** 2026-11-15
**Status:** Accepted
**Supersedes:** the typing-control rules of the remote protocol spec, §7 (`TakeControl`, the
ten-second takeover wait, "Let <device> type", the epoch check), and the parts of
[ADR-0057](0057-remote-access.md) that describe them.
**Relates to:** [ADR-0040](0040-cli-dialogs-answered-in-the-terminal.md)

## Context

Remote access made a device take [Typing control] before it could type: "Take control" on
the device, refused while the host had typed in the last ten seconds unless the person
clicked "Let <device> type" on the host, and lost to the host at its next key. Testing on a
real Windows PC with a phone showed what that costs. Control dropped back to the host on its
own (the host's terminal answering Claude Code counted as typing, fixed in `dacc790`), the
phone said "You're typing" or "Watching" when the person just wanted to send a message, and
the host showed asks nobody expected. The person's decision: no explicit control. Whatever
machine sends input, the host or a paired Controller, it reaches the session, as Claude Code
and its own remote do.

## Decision

- **No handover, no lock.** Input from the host and from any paired Controller goes straight
  to the session's PTY. `recheck_at_write` no longer checks who holds control or the epoch.
  `NotInControl` is never sent for a write any more.
- **Viewers still can't type.** The role check stays the trust boundary: a Viewer's
  `Input`, `Compose` or `Resize` is refused `NotAllowed`, at the check and again at the write.
- **The session's size follows whoever typed last.** A device's `Resize` records its size;
  the PTY takes that size when the device types (at once if it typed last). The host's next
  key puts the host window's size back. Each change of size gives every device a fresh
  snapshot at the new size (`0216eaa`). So a phone typing gets a phone-sized terminal, and
  the computer typing gets its window's size.
- **Who typed last is information, not permission.** The host still tracks it and sends
  `Control { holder, epoch }` when it changes, so each screen can show "typing from <device>".
  The epoch still counts changes; nothing is refused for an old one.
- **Dialogs keep their guard.** A write from a device whose screen hadn't drawn the dialog
  showing now is still refused `Stale` (`seen_seq`), and `Compose` is still refused while a
  dialog shows (ADR-0040). A device answers a dialog by picking one of its choices, which
  sends that choice's key; it no longer has to type in the terminal.
- **Wire shape kept.** The protocol is pre-release, but the phone and desktop builds share
  it, so the messages keep their tags: `TakeControl` and `ReleaseControl` are accepted and
  change nothing a write depends on; `epoch` stays in `Input`, `Compose` and `Resize` and is
  ignored.

## Consequences

- Two people typing at once interleave their keys, as two keyboards on one computer would.
  That is the person's choice; the "typing from" hint shows it is happening.
- A Controller can type while the person at the host is typing; as before, a Controller can
  already do anything the person can in a terminal, so this adds no new power, only removes
  the wait.
- The desktop's "Take control" button, its "Let <device> type" asks and the phone's take /
  give-back buttons go.
