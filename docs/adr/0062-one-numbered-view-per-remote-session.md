# ADR 0062 — A remote session is shown by one numbered view

**Date:** 2026-11-14
**Status:** Accepted
**Relates to:** [ADR-0057](0057-remote-access.md)

## Context

A device (the desktop as a [Remote device], or the phone) showed a host's session through
six calls: open, close, screen on, screen off, read entries, stop entries. Each changed one
part of the session's state in Rust, so their order mattered: a close that overtook the
open it followed ended the newer stream, and a screen turned on before the open failed.
Both apps queued the calls in TypeScript to keep the order, each with its own rules.

The queues did not cover Rust's side. When a link came back, Rust reopened the session
while the app could also be opening it. Two streams went to the host, which refuses a
second one from the same device, and the device could keep the refused one. The next
screen change then failed with "sending stopped by peer", which the phone showed as an
error at a cold start.

## Decision

- **One call, the whole view.** `DeviceRuntime::set_view(host, session, seq, view)` takes
  how the person wants the session: `Open { screen, entries }`, each part on (with its
  sink) or off, or `Closed`. The Tauri command `remote_host_set_view` and the phone's
  `setView` pass it through. The six calls and both TypeScript queues are gone.
- **Numbered in the order asked.** The app numbers each view (`seq`). Rust keeps the last
  number per session and ignores an older view, so calls may reach Rust in any order and
  nothing in the app waits on another.
- **Kept, then applied.** Rust records the view at once. On an open stream it tells the
  host only what changed, under the stream's writer lock and reading the view at that
  moment, so the host's last word is the view's. With no stream, it opens one if the link
  is up, and every new link opens what is wanted.
- **One open at a time.** Each session has at most one stream opening at a time. A
  reconnect's open and the app's open no longer race to two streams.
- **A link going down never fails a view.** A stream that fails a send is let go and opened
  again; a link that is down shows the view on the next one. `set_view` fails only for a
  host not paired here.

## Consequences

- Reading entries again (Readable after "no entries") is a view with entries off, then on:
  a new read from the start.
- A view keeps its parts across calls on the app's side (the phone's and the desktop's
  stores hold the last view asked), because each call sends the whole view.
- The race that made two streams could not be reproduced on loopback, where opening a
  stream is immediate. The one-open rule is held by reasoning and by the stream recovery
  above, not by a test that fails without it. `faults.rs` tests the cold-start pattern,
  stale views, and views changed while the link drops.
