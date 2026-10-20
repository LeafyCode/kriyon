# ADR 0008 — Rich notifications: notify-only, native click-to-focus

**Date:** 2026-07-05
**Status:** Accepted

## Context

Kriyon already dispatches OS notifications on a Session's transition into an
attention [Status] (`waiting | done | error`), gated by focus, 5-second
coalescing, and the user's [Notify preference] (`should_notify` +
`preference_allows` in `kriyon-core::status`; dispatched from
`status_rt.rs`). The bodies were generic ("Needs your input") and titled by
the raw [Session] id.

This arc enriches them to the Warp / Claude-Desktop bar: name the [Project
(Workspace)] and [Session title], distinguish the event with a leading emoji
(❓ question, 🔑 permission, 📋 plan approval, ⏳ waiting, ✅ done, ⚠️ error —
mirroring the sidebar `kindIcon` meanings), and put the [Pending ask]'s one
line of text in the body. Two decisions in it are novel enough to record.

## Decision 1: notify-only — no inline reply from the notification

macOS can host a WhatsApp-style reply field on a notification
(`UNTextInputNotificationAction`), and it was the headline request. We
deliberately **do not** build it. Delivering a typed reply to a `waiting`
Session means Kriyon composing bytes and writing them into the live PTY —
which is **keystroke injection into a running TUI**, forbidden by the same
invariant ADR 0005 records and `CONTEXT.md` states three times ([Pending ask]
"the user answers in the Raw view", [Handoff prompt] "never keystroke-injected",
[Prompt picker] "never writes to PTY stdin"). This is distinct from
`writeStdin` on the terminal today, which is the user's own keystrokes flowing
through xterm byte-for-byte.

So the notification is **notify-only**: clicking it focuses the app and routes
to the offending Session's [Raw view], where the user answers themselves —
reusing the [Needs-you overlay]'s existing "Enter focuses the session" path.
The reply affordance is intentionally absent, not unbuilt-yet.

## Decision 2: native macOS notifications, not the Tauri plugin's actions

To focus the *right* Session on click, the notification must carry its
[Session] id and fire a callback that reads it back — a plain macOS
notification click yields no payload, only "app, come forward". The Tauri
notification plugin's `onAction` covers this, but its action/click callback is
mobile-oriented and unproven on macOS desktop (needs a signed build to even
test). Given a hard requirement that the click always land, we implement the
notification via native `UNUserNotificationCenter` in Rust (a small,
self-contained module — the method Warp and Claude Desktop use), tagging each
notification with the [Session] id and, on click, bringing the window forward
and emitting a `focus-session` event the frontend already knows how to handle.

The notify *decision* (`should_notify` + `preference_allows` + focus +
coalescing) stays exactly where it is in `kriyon-core` / `status_rt.rs`; only
the *content build* and *dispatch* change. The [Pending ask] is threaded into
`AppState` (reusing the existing `PendingAsk` type) so the Rust dispatch path
can read the event kind + text it previously only emitted to the frontend.

## Consequences

- The native module is contained to notifications; ripping it out touches
  nothing else. It is Mac-only, consistent with Kriyon's Mac-first stance.
- "No inline reply" will surprise a user expecting Warp/Claude-Desktop parity.
  That is the deliberate cost of keeping the terminal the trustworthy source of
  truth — if it is ever revisited, it must clear the ADR 0005 invariant, not
  route around it.
- The notification content is now a pure function of ([Status], [Pending ask],
  project name, session title), unit-testable in `kriyon-core` alongside the
  existing `notification_body`.
