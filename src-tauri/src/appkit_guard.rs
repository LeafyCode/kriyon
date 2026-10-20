//! The [AppKit exception guard].
//!
//! Every Cocoa app gets one thing for free: `-[NSApplication run]` wraps event
//! dispatch in `@try`/`@catch`, so an `NSException` raised deep inside AppKit
//! is reported and the app keeps running. Kriyon loses that, because tao sits
//! in between. `TaoApp` and `TaoWindow` override `sendEvent:` with plain
//! `extern "C"` Rust functions, and rustc plants an abort-on-unwind shim in the
//! body of every such function: when an Objective-C exception reaches one, the
//! process dies — `SIGABRT`, no panic message — before AppKit's own handler is
//! ever consulted.
//!
//! That is how macOS 26's Campo affordance (the Writing Tools bubble that
//! appears when you dwell over a text selection) takes Kriyon down: AppKit
//! tears down its remote view, then handles a `mouseEntered:` for the tracking
//! area it just dropped, fails an internal assertion, and the `NSException`
//! unwinds into tao's frame and aborts there.
//!
//! **Where the catch goes is the whole design.** The shim lives inside the
//! callee's own body, so wrapping tao's `sendEvent:` from the outside changes
//! nothing — the abort happens inside the call we wrapped, below our `catch`.
//! The catch has to sit *under* tao's frame instead. So this module guards
//! `NSApplication`'s and `NSWindow`'s **own** `sendEvent:` — the Objective-C
//! methods tao's overrides call through to via `super`. Objective-C methods
//! are unwind-capable, so the exception reaches our `catch` while tao's frame
//! is still further up the stack, untouched.
//!
//! Its reach ends where the next `extern "C"` Rust frame begins: an exception
//! raised under one of `TaoView`'s 82 callbacks still aborts there. See
//! ADR-0025.

#[cfg(not(target_os = "macos"))]
pub fn install() {}

#[cfg(target_os = "macos")]
pub use macos::install;

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CStr;
    use std::panic::AssertUnwindSafe;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::sel;

    /// The shape every `sendEvent:` implementation has. `C-unwind`, not `C`:
    /// what we displace is an Objective-C method, which may unwind, and typing
    /// it otherwise would plant the very abort shim this module exists to get
    /// out from under.
    type SendEvent = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

    /// After the first, only every `LOG_EVERY`th caught exception is logged.
    /// A wedged affordance re-raises on every mouse move, and this runs on the
    /// main thread inside event dispatch — the log must not become the problem.
    const LOG_EVERY: u64 = 100;

    /// What [`Guard::install`] did, so the caller can tell a guard that is
    /// already in place from one that never went in.
    #[derive(Debug, PartialEq, Eq)]
    enum Installed {
        /// The guard is now in place.
        Yes,
        /// This guard already holds a displaced implementation.
        Already,
        /// The class inherits `sendEvent:` instead of declaring it, so
        /// swizzling would have re-pointed some *other* class's method.
        NotDeclared,
    }

    /// One guarded `sendEvent:`: the implementation we displaced, plus a count
    /// of the exceptions we have swallowed on its behalf.
    struct Guard {
        original: OnceLock<SendEvent>,
        caught: AtomicU64,
    }

    impl Guard {
        const fn new() -> Self {
            Self {
                original: OnceLock::new(),
                caught: AtomicU64::new(0),
            }
        }

        /// Routes `class`'s own `sendEvent:` through `trampoline`, keeping the
        /// displaced implementation for [`Guard::forward`].
        ///
        /// # Safety
        ///
        /// `trampoline` must have the calling convention and signature the
        /// Objective-C runtime invokes `sendEvent:` with, and must forward to
        /// this same guard.
        unsafe fn install(&self, class: &AnyClass, trampoline: SendEvent) -> Installed {
            let sel = sel!(sendEvent:);
            let Some(method) = class.instance_method(sel) else {
                return Installed::NotDeclared;
            };
            // `class_getInstanceMethod` happily walks up the hierarchy, and the
            // `Method` it hands back for an inherited selector belongs to the
            // superclass — re-pointing that one would swizzle a class we never
            // named.
            let inherited = class
                .superclass()
                .and_then(|superclass| superclass.instance_method(sel));
            if inherited.is_some_and(|inherited| std::ptr::eq(inherited, method)) {
                return Installed::NotDeclared;
            }

            // Claim the slot before swizzling: once the trampoline is live it
            // may be called from another thread, and it needs the original.
            let previous = method.implementation();
            // SAFETY: `previous` came from this method, so it has the
            // `sendEvent:` signature `SendEvent` describes.
            if self
                .original
                .set(unsafe { std::mem::transmute::<Imp, SendEvent>(previous) })
                .is_err()
            {
                return Installed::Already;
            }
            // SAFETY: the caller guarantees `trampoline`'s signature, and it
            // forwards to the implementation we just saved.
            unsafe { method.set_implementation(std::mem::transmute::<SendEvent, Imp>(trampoline)) };
            Installed::Yes
        }

        /// Runs the displaced implementation, catching any `NSException` it
        /// raises so nothing unwinds past this frame — and, crucially, so
        /// nothing reaches the abort shim in tao's frame above us.
        fn forward(&self, this: *mut AnyObject, sel: Sel, event: *mut AnyObject) {
            // Unreachable by construction: `install` stores the original before
            // it makes the trampoline live. Dropping the event is still the
            // right thing if that ever stops being true — better a lost event
            // than a wild jump through an uninitialized function pointer.
            let Some(original) = self.original.get().copied() else {
                return;
            };
            // SAFETY: we were called as `sendEvent:` on an object of the class
            // we swizzled, so the arguments are the ones `original` expects.
            let call = AssertUnwindSafe(move || unsafe { original(this, sel, event) });
            if let Err(exception) = objc2::exception::catch(call) {
                let count = self.caught.fetch_add(1, Ordering::Relaxed) + 1;
                if count == 1 || count.is_multiple_of(LOG_EVERY) {
                    eprintln!(
                        "kriyon: caught an AppKit exception during event dispatch, dropping the event (#{count}): {exception:?}"
                    );
                }
            }
        }

        #[cfg(test)]
        fn caught(&self) -> u64 {
            self.caught.load(Ordering::Relaxed)
        }
    }

    static APP: Guard = Guard::new();
    static WINDOW: Guard = Guard::new();

    unsafe extern "C-unwind" fn app_send_event(
        this: *mut AnyObject,
        sel: Sel,
        event: *mut AnyObject,
    ) {
        APP.forward(this, sel, event);
    }

    unsafe extern "C-unwind" fn window_send_event(
        this: *mut AnyObject,
        sel: Sel,
        event: *mut AnyObject,
    ) {
        WINDOW.forward(this, sel, event);
    }

    /// Guards AppKit's own event dispatch. Call once, on the main thread,
    /// before the event loop runs.
    ///
    /// These are deliberately `NSApplication` and `NSWindow` themselves, not
    /// tao's subclasses: the catch only helps from *below* tao's `extern "C"`
    /// frames. Best-effort — a class we cannot guard costs us the guard, not
    /// the launch, and says so on stderr.
    pub fn install() {
        guard_class(c"NSApplication", &APP, app_send_event);
        guard_class(c"NSWindow", &WINDOW, window_send_event);
    }

    fn guard_class(name: &CStr, guard: &'static Guard, trampoline: SendEvent) {
        let Some(class) = AnyClass::get(name) else {
            eprintln!("kriyon: no {name:?} class to guard; AppKit exceptions stay fatal");
            return;
        };
        // SAFETY: `trampoline` is declared with the `sendEvent:` signature and
        // forwards to `guard`, the same guard we hand the original to.
        match unsafe { guard.install(class, trampoline) } {
            Installed::Yes | Installed::Already => {}
            Installed::NotDeclared => eprintln!(
                "kriyon: {name:?} does not declare sendEvent:; AppKit exceptions stay fatal"
            ),
        }
    }

    #[cfg(test)]
    mod tests {
        use objc2::rc::Retained;
        use objc2::runtime::{ClassBuilder, NSObject};
        use objc2::{class, msg_send};

        use super::*;

        /// A `sendEvent:` that raises, standing in for the AppKit assertion.
        ///
        /// `extern "C-unwind"` on purpose, and it must stay that way: it stands
        /// in for an *Objective-C* method, which is what the guard displaces.
        /// An `extern "C"` stand-in would model tao's override instead — the
        /// thing we must never guard — and would abort the whole test binary.
        unsafe extern "C-unwind" fn raises(
            _this: *mut AnyObject,
            _sel: Sel,
            _event: *mut AnyObject,
        ) {
            let name = objc2_foundation::NSString::from_str("KriyonProbeException");
            let reason = objc2_foundation::NSString::from_str("probe");
            let class = AnyClass::get(c"NSException").expect("NSException exists");
            let exception: Retained<AnyObject> = unsafe {
                msg_send![class, exceptionWithName: &*name, reason: &*reason, userInfo: std::ptr::null::<AnyObject>()]
            };
            let _: () = unsafe { msg_send![&*exception, raise] };
        }

        static CALLS: AtomicU64 = AtomicU64::new(0);

        /// A `sendEvent:` that merely records that it ran.
        unsafe extern "C-unwind" fn counts(
            _this: *mut AnyObject,
            _sel: Sel,
            _event: *mut AnyObject,
        ) {
            CALLS.fetch_add(1, Ordering::Relaxed);
        }

        /// Declares a guard and the trampoline that forwards to it — the pair
        /// `install` wires up for real, one per test so they stay independent.
        macro_rules! guarded {
            () => {{
                static GUARD: Guard = Guard::new();
                unsafe extern "C-unwind" fn trampoline(
                    this: *mut AnyObject,
                    sel: Sel,
                    event: *mut AnyObject,
                ) {
                    GUARD.forward(this, sel, event);
                }
                (&GUARD, trampoline as SendEvent)
            }};
        }

        /// A throwaway class with its own `sendEvent:`. Names are Kriyon's own,
        /// never tao's or AppKit's — registering a class under a name someone
        /// else will later claim is a process-wide landmine.
        fn probe_class(name: &CStr, imp: SendEvent) -> &'static AnyClass {
            let mut builder = ClassBuilder::new(name, class!(NSObject)).expect("fresh name");
            // SAFETY: `imp` has the `sendEvent:` signature.
            unsafe {
                builder.add_method(sel!(sendEvent:), imp);
            }
            builder.register()
        }

        fn send_event(class: &AnyClass) {
            let object: Retained<NSObject> = unsafe { msg_send![class, new] };
            let _: () =
                unsafe { msg_send![&*object, sendEvent: std::ptr::null_mut::<AnyObject>()] };
        }

        fn implementation_of(class: &AnyClass) -> Imp {
            class
                .instance_method(sel!(sendEvent:))
                .expect("declares sendEvent:")
                .implementation()
        }

        #[test]
        fn a_raising_send_event_is_caught_instead_of_aborting() {
            let (guard, trampoline) = guarded!();
            let class = probe_class(c"KriyonRaisingProbe", raises);

            // SAFETY: `trampoline` has the `sendEvent:` signature and forwards
            // to `guard`.
            assert_eq!(unsafe { guard.install(class, trampoline) }, Installed::Yes);

            send_event(class);

            assert_eq!(guard.caught(), 1, "the exception should have been caught");
        }

        #[test]
        fn an_ordinary_send_event_still_reaches_the_original() {
            let (guard, trampoline) = guarded!();
            let class = probe_class(c"KriyonCountingProbe", counts);

            // SAFETY: as above.
            assert_eq!(unsafe { guard.install(class, trampoline) }, Installed::Yes);

            let before = CALLS.load(Ordering::Relaxed);
            send_event(class);

            assert_eq!(CALLS.load(Ordering::Relaxed), before + 1);
            assert_eq!(guard.caught(), 0, "nothing raised, nothing to catch");
        }

        #[test]
        fn a_class_that_only_inherits_send_event_is_left_alone() {
            let (guard, trampoline) = guarded!();
            let base = probe_class(c"KriyonInheritingBase", counts);
            let derived = ClassBuilder::new(c"KriyonInheritingProbe", base)
                .expect("fresh name")
                .register();

            // SAFETY: as above.
            assert_eq!(
                unsafe { guard.install(derived, trampoline) },
                Installed::NotDeclared
            );
        }

        #[test]
        fn guarding_the_same_guard_twice_says_so_rather_than_crying_wolf() {
            let (guard, trampoline) = guarded!();
            let class = probe_class(c"KriyonTwiceProbe", counts);
            let other = probe_class(c"KriyonTwiceOtherProbe", counts);

            // SAFETY: as above.
            assert_eq!(unsafe { guard.install(class, trampoline) }, Installed::Yes);
            // SAFETY: as above.
            assert_eq!(
                unsafe { guard.install(other, trampoline) },
                Installed::Already
            );
        }

        /// The invariant the whole fix rests on: the guard must land on
        /// AppKit's own classes, never on tao's `extern "C"` subclasses, where
        /// the catch would sit above the abort shim and do nothing.
        #[test]
        fn install_guards_appkits_own_send_event() {
            let app = AnyClass::get(c"NSApplication").expect("AppKit is loaded");
            let window = AnyClass::get(c"NSWindow").expect("AppKit is loaded");

            super::install();

            let app_trampoline: SendEvent = app_send_event;
            let window_trampoline: SendEvent = window_send_event;
            assert_eq!(implementation_of(app) as usize, app_trampoline as usize);
            assert_eq!(
                implementation_of(window) as usize,
                window_trampoline as usize
            );
        }
    }
}
