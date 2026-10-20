# ADR 0010 — Two `MainSessionLock` instances, agreement enforced by test

**Date:** 2026-07-11
**Status:** Accepted
**Refines:** [ADR-0009](0009-converging-main-session-lock.md)

> **Superseded in part by [ADR-0019](0019-remove-the-structured-pane.md)
> (2026-08-05).** The two instances and the agreement test both stand, but the
> second one no longer backs a rendered structured view — that pane is gone.
> `HookActivity`'s lock now serves [Session activity] in the Inspector. Read
> "the [Structured view]" and "a status badge and structured view that silently
> disagree" below as "the live activity projection"; the invariant and
> `status_and_activity_locks_agree_on_the_same_stream` are unaffected.
>
> **Extended (2026-09-27).** Agreement now also holds at seeding. Both seeds
> replay the recorded tail through one `replay_history`, filtered to the same
> status-line anchor. A status-line id that arrives before the first hook
> creates the runtime that holds it. Covered by
> `a_replay_anchors_status_and_activity_to_the_same_session` (core) and by the
> watcher and `status_rt` seed tests.

## Context

ADR-0009 extracted one [Main session lock] type (`kriyon-core::main_session`)
shared by both `StatusTracker` (the [Status] badge) and `HookActivity` (the
[Structured view]), replacing two hand-duplicated copies of the "which id is
main" rule. Its headline claim was that the two surfaces "can never disagree."

An architecture review surfaced the fine print: the **type** is shared, but the
two owners hold **separate instances**. `StatusTracker.main_lock` lives in the
status runtime's `Mutex<HashMap<SessionId, StatusTracker>>`; `HookActivity`'s
lock lives inside the watcher's per-watch `ActivitySource`. They are never the
same object. "Cannot disagree" is therefore not a structural guarantee — it is a
runtime invariant that holds **only because both instances are fed the same
hook stream and the same authoritative id**, through two disjoint code paths
(the watcher pump for activity; the `commands` signal consumer for status). The
authoritative id was also extracted from the usage snapshot in two places, and
no test exercised the two surfaces agreeing.

## Decision: keep two instances; do not share one

We considered replacing the two instances with a single
`Arc<Mutex<MainSessionLock>>` shared across both subsystems for a structural
guarantee. We **rejected** it:

- The two subsystems run on different threads and take their own locks (the
  status `Mutex<HashMap>` and the watcher's per-watch state) on the hot output
  path. Introducing a lock shared across both adds cross-subsystem lock ordering
  — a deadlock risk — to the path a fast `claude` already stresses.
- Their lifetimes differ: the status lock lives for the whole app run in a
  global map; the activity lock is created per session-watch and dropped when
  the watch ends. Making one instance outlive and be shared by both is fiddly
  and error-prone for no behavioural gain.

The pure `MainSessionLock` already guarantees that identical inputs produce an
identical `current()`. So the cheaper, safer way to get the guarantee we
actually want is to (a) make the two live paths derive the anchor id from **one
accessor**, and (b) **prove** the two owners agree with a test.

## Consequences

- `UsageSnapshot::authoritative_main_id()` is the single accessor for "which id
  anchors the main session"; both the watcher pump and the `commands` usage-signal
  consumer call it, so they cannot derive the anchor differently (e.g. on empty
  ids).
- `StatusTracker::main_session_id()` mirrors `HookActivity::main_session_id()`,
  exposing the locked id so agreement is observable.
- A `kriyon-core` test (`status_and_activity_locks_agree_on_the_same_stream`)
  feeds the same hook stream and the same authoritative id to a real
  `StatusTracker` and a real `SessionActivityProjection` and asserts their locked
  ids match at every step. A future change that feeds one path differently fails
  the test instead of shipping a status badge and structured view that silently
  disagree.
- The invariant is now enforced by a test rather than a code comment; the
  "shared, so they cannot disagree" wording in ADR-0009 should be read as
  "shared type, agreement enforced by test," per this ADR.
