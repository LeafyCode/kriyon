# ADR 0013 — Keep the `SessionEngine` trait as the documented engine contract, not polymorphic yet

**Date:** 2026-07-12
**Status:** Accepted

## Context

`SessionEngine` (`kriyon-core::session`) is a trait — `write_stdin` / `resize` /
`close` / `id` — with exactly one production implementation, `DaemonClient` (the
[Daemon client] that talks to the [PTY daemon]). Notably `AppState` stores
`engine: DaemonClient` **concretely**, not `Box<dyn SessionEngine>`, so there is
no polymorphic dispatch at the storage boundary; the `commands` layer imports the
trait only to call those methods on the concrete type. The only other impl,
`StubEngine`, exists solely inside a test to assert the trait is object-safe.

An architecture review applied the deletion test and observed: remove the trait
and `DaemonClient`'s inherent methods remain, the commands call them directly,
and nothing concentrates elsewhere — the signature of a shallow abstraction. It
flagged the state as "worst of both": a one-impl trait that `AppState` bypasses.
It correctly framed the resolution as a maintainer judgment call, not a
prescription.

## Decision: keep the trait; do not force `Box<dyn>` and do not inline it

CONTEXT.md's [Engine] glossary entry reserves a second engine —
`ApiEngine` (future, API-key, headless) — as a designed-for-not-built seam.
`SessionEngine` is the written contract that future engine must satisfy. We keep
it, and reject both alternatives:

- **Reject `AppState.engine: Box<dyn SessionEngine>`** (make the seam
  polymorphic now). It adds virtual dispatch to the terminal write/resize/close
  hot path for zero present benefit — there is only one engine — and a boxed
  trait object where a concrete type works today is speculative indirection. When
  `ApiEngine` is actually built, storing `Box<dyn SessionEngine>` is a small,
  local change made *then*, against a real second implementation.
- **Reject inlining** (delete the trait, use `DaemonClient` directly). That
  removes the one written specification of what any engine must do, drops the
  object-safety guard, and is churn to *remove* an abstraction that costs almost
  nothing to keep — a poor trade for an app that values not moving load-bearing
  code without cause.

The trait is not earning polymorphism yet; it is earning **documentation** — the
single, type-checked statement of the engine contract. That is a legitimate job
for a designed-for seam.

## Consequences

- `SessionEngine` stays; `AppState.engine` stays concrete (`DaemonClient`). The
  hot path keeps static dispatch.
- The `StubEngine` object-safety test stays as the guard that the contract
  remains implementable by a second, non-PTY engine.
- When `ApiEngine` lands, revisit: introduce the second impl, switch
  `AppState.engine` to `Box<dyn SessionEngine>` (or an enum), and this ADR's
  premise (one production impl) no longer holds — that is the trigger to make the
  seam polymorphic, not before.
