# ADR 0025 — An AppKit exception must not abort Kriyon

**Status:** accepted · 2026-09-21

## Context

On 2026-09-21, hours after the macOS 27 upgrade, Kriyon 0.9.0 died with
`SIGABRT` and no panic message. The crash report shows only stripped frames:

```
0  libsystem_kernel.dylib  __pthread_kill
2  libsystem_c.dylib       abort
3-11 kriyon                (Rust panic/abort machinery)
12 kriyon                  (one frame)
13 AppKit                  -[NSApplication _handleEvent:]
14 AppKit                  -[NSApplication run]
```

The system log supplies what the report omits. Two milliseconds before the
abort:

```
[com.apple.AppKit:CampoLightweightUI] Tearing down remote view connection if it existed.
[com.apple.AppKit:CampoLightweightUI] Mouse entered.
[com.apple.Foundation:general] *** Assertion failure in <private>, NSCampoLightweightUIController.m:1429
```

`NSCampoLightweightUIController` is the macOS 26/27 "Campo" lightweight UI — the
Writing Tools affordance that appears when the pointer dwells over a text
selection. Kriyon's whole surface is a `WKWebView`, and a `WKWebView` selection
is one of its async clients. AppKit tore down the affordance's remote view and
then handled a `mouseEntered:` for the tracking area it had just dropped, which
failed an internal assertion and raised an `NSException`.

In any ordinary Cocoa app that is survivable: `-[NSApplication run]` wraps event
dispatch in `@try`/`@catch` and reports the exception. Kriyon does not get that,
because tao sits in between. `tao::platform_impl::macos::app` registers a
`TaoApp` subclass whose `sendEvent:` is a plain `extern "C"` Rust function (and
`TaoWindow` does the same), and a C-ABI function may not unwind. When the
Objective-C exception reaches that frame the Rust runtime aborts —
*"Rust cannot catch foreign exceptions"* — before AppKit's own handler is ever
reached. That is frame 12, and it is why there is no panic message to read.

The bug is Apple's. The fatality is ours: one AppKit assertion anywhere under
event dispatch takes the whole app, and whatever the user was doing, with it.

## Decision

Put the missing `@catch` back — but **not** around tao's method. Wrapping
`-[TaoApp sendEvent:]` from the outside does nothing, because rustc plants the
abort-on-unwind shim in the *callee's own body*: retyping the stored function
pointer `extern "C-unwind"` changes how we call tao, not what tao does when an
exception passes through it. The abort still happens inside the call we
wrapped, below the `catch`. We built that version first, and it was a no-op
plus one stack frame; the probe is in the session that produced this ADR.

The catch has to sit **under** tao's frame. So `appkit_guard::install()`
re-points `NSApplication`'s and `NSWindow`'s *own* `sendEvent:` — the
Objective-C methods tao's overrides call through to via `super`. Objective-C
methods are unwind-capable, so the exception reaches our `catch` while tao's
frame is still further up the stack and never sees it. For the reported crash
the innermost guard is the `NSWindow` one: the Campo affordance lives in its
own `NSCampoLightweightUIHostWindow`, and nothing Rust-shaped sits between that
window's dispatch and the assertion.

It runs first thing in the `setup` hook, before any event is dispatched.

Three constraints shape it:

- Both trampolines and the stored originals are typed `extern "C-unwind"`. A
  `C` anywhere in that chain re-creates the shim we are escaping.
- We guard only a class that declares `sendEvent:` itself. `class_getInstanceMethod`
  happily returns an inherited method, and re-pointing that one would swizzle a
  class we never named. `NSApplication` and `NSWindow` both declare it.
- A class we cannot guard is logged, not fatal. An `install()` that runs twice
  says "already guarded" rather than raising a false alarm.

Swizzling a framework class is not something to do lightly, and an earlier
draft of this module refused to on principle. That principle was backwards
here: AppKit's own method is the *only* place the catch does any good.

## Consequences

An AppKit bug now costs one dropped event instead of the app. That is the same
trade `-[NSApplication run]` makes, so the state AppKit is left in afterwards is
no worse than what every other Cocoa app lives with — but it is a real trade:
the exception is swallowed, the event is gone, and the UI gives no sign. We log
the first one and then every hundredth, because a wedged affordance re-raises on
every mouse move and this runs on the main thread inside event dispatch.

The guard's reach ends where the next `extern "C"` Rust frame begins. tao
registers well over a hundred of those — 82 on `TaoView`, 48 on
`TaoWindowDelegate`, more on its app delegate — and `TaoView`'s are squarely on
the dispatch path, so an exception raised under `-[TaoView mouseDown:]` still
aborts there. Nothing covers a timer, a main-queue block, or a delegate
callback either.

`sendEvent:` is nonetheless the right single place: it is the one chokepoint
every event passes through, and it is where the crash we have actually landed.
Guarding the rest would mean a trampoline per method signature across classes we
do not own — disproportionate to one AppKit bug. Widen it with evidence, not
pre-emptively.

The real fix belongs upstream: tao's ObjC callbacks should be declared
`extern "C-unwind"` so an Objective-C exception passes through them to AppKit's
own handler, and this module could then be deleted. Worth a patch to tao; until
one lands and ships, we carry the guard.
