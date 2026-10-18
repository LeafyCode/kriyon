# ADR 0012 — The sidebar Needs-you and the command center may differ on the blocked set, on purpose

**Date:** 2026-07-12
**Status:** Accepted

## Context

Two surfaces answer "which sessions need the user right now," and they can
disagree:

- The **sidebar [Needs-you section]** (`needsYouSectionItems`) derives membership
  from the raw [Session status] — `waiting` (a plain wait, upgraded to a
  *question* when a [Pending ask] is open), `error`, and `done`-with-unseen
  output. It has **no watcher-liveness gate**.
- The **[Command center]** / **[Needs-you overlay]** (`needsYou(standings)`)
  derives its blocked set from `standingState === "awaiting_input"`, which **is**
  liveness-gated: a session whose watcher has been silent past `STALE_AFTER_MS`
  (~3× the backend heartbeat) degrades to `unknown` and drops out of the blocked
  set (though it stays visible in the standings list).

So a session that is `waiting` when its watcher goes quiet still shows in the
sidebar Needs-you but not in the command center's blocked set. An architecture
review flagged this as a divergence to reconcile by giving both surfaces one
liveness-aware "blocked set" primitive.

## Decision: keep the two derivations; do not liveness-gate the sidebar

We **rejected** converging them, because the two surfaces have different jobs and
converging trades away the property each one is built to protect:

- **The sidebar's job is to never let you miss a block.** It is the primary,
  always-mounted working view. For it, a *false negative* — hiding a session that
  genuinely needs you because its watcher missed a couple of heartbeats — is the
  worst outcome. Raw status errs toward showing, which is correct here. Gating it
  on liveness would make a real block silently vanish from the one place you look
  first.
- **The command center's job is a confident cross-project survey.** Across many
  sessions, some possibly dead, showing a stale `waiting` as a live block erodes
  trust. Degrading to `unknown` errs toward confidence, which is correct there.
  The session is not hidden — it remains in the standings, just not in the
  blocked highlight.

Adding a liveness gate (and the 1.5s staleness ticker it requires) to the
always-mounted sidebar would also re-introduce per-tick work to a component whose
render cost was deliberately kept minimal, and couple the sidebar to the
command-center liveness store — cost with no reliability gain on the surface that
matters most.

The two are **not** duplicating logic: the sidebar computes a richer set
(question / waiting / error / done-unseen with kind ordering); the command center
computes only the `awaiting_input` subset. They are different projections of the
session state, not two copies of one rule.

## Consequences

- `needsYouSectionItems` stays pure over the session store with no liveness input;
  the [Command center] keeps its liveness gate via `standingState`.
- A `waiting` session with a stale watcher appears in the sidebar Needs-you and
  as `unknown` (not blocked) in the command center. This is expected, not a bug.
- If a future change needs the two to agree on the blocked subset, revisit this
  ADR — the reconciliation must not introduce sidebar false negatives (prefer
  lifting the command center toward the sidebar's "show it" bias over pushing the
  sidebar toward the command center's "hide when unsure" bias).
