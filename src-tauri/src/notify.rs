//! Best-effort OS notifications for background (non-focused) sessions.
//!
//! The decision of *whether* to notify lives in `kriyon_core::status::should_notify`,
//! and the human-readable body is built by `kriyon_core::notification`; this
//! module only shows the OS notification and, on macOS, routes a click on it
//! back to focusing the session. Showing is fire-and-forget: a failed
//! notification must never crash or block the session runtime.

#[cfg(target_os = "macos")]
use std::sync::OnceLock;

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use kriyon_core::status::{NotifySound, NotifySoundKind};
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{Bool, NSObject, ProtocolObject};
#[cfg(target_os = "macos")]
use objc2::{define_class, msg_send, AnyThread};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSError, NSObjectProtocol, NSString};
#[cfg(target_os = "macos")]
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
#[cfg(target_os = "macos")]
use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::{Emitter as _, Manager as _};

/// Payload for the `focus-session` event: the session the user clicked a
/// notification for. Camel-cased to match the other session-* events.
#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusSessionPayload {
    session_id: String,
}

/// The running app handle, stashed here so `NotificationDelegate` below (a
/// plain Objective-C object, with no room for arbitrary Rust state) can reach
/// it from `userNotificationCenter:didReceiveNotificationResponse:...`.
#[cfg(target_os = "macos")]
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// `UNUserNotificationCenter`'s `delegate` property is documented as *weak*:
/// nothing else holds a strong reference to whatever we assign it, so we must
/// keep our delegate alive for the app's lifetime ourselves.
#[cfg(target_os = "macos")]
static DELEGATE: OnceLock<Retained<NotificationDelegate>> = OnceLock::new();

#[cfg(target_os = "macos")]
define_class!(
    // SAFETY: `NotificationDelegate` has no ivars and does not override
    // `dealloc`; `NSObject` has no subclassing requirements we need to uphold.
    #[unsafe(super = NSObject)]
    struct NotificationDelegate;

    // SAFETY: `NSObjectProtocol` has no safety requirements.
    unsafe impl NSObjectProtocol for NotificationDelegate {}

    // SAFETY: `UNUserNotificationCenterDelegate` has no safety requirements
    // beyond calling the completion handler, which both methods below do.
    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        /// Called when a notification would be shown while Kriyon is in the
        /// foreground. We only ever notify when the window isn't focused, so
        /// this rarely fires, but showing the banner anyway is harmless and
        /// keeps behavior predictable.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present_notification(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler.call((UNNotificationPresentationOptions::Banner,));
        }

        /// Called when the user interacts with a delivered notification. We
        /// only react to the plain click (the default action); a dismissal
        /// or any other action identifier is ignored.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_notification_response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            // SAFETY: `UNNotificationDefaultActionIdentifier` is a valid,
            // always-initialized extern static provided by the framework.
            let default_action = unsafe { UNNotificationDefaultActionIdentifier };
            if &*response.actionIdentifier() == default_action {
                let user_info = response.notification().request().content().userInfo();
                let session_id = user_info
                    .objectForKey(&NSString::from_str("sessionId"))
                    .and_then(|value| value.downcast::<NSString>().ok())
                    .map(|s| s.to_string());

                if let (Some(session_id), Some(app)) = (session_id, APP.get()) {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.unminimize();
                        let _ = win.set_focus();
                    }
                    let _ = app.emit("focus-session", FocusSessionPayload { session_id });
                }
            }
            completion_handler.call(());
        }
    }
);

#[cfg(target_os = "macos")]
impl NotificationDelegate {
    fn new() -> Retained<Self> {
        // SAFETY: `NSObject`'s `init` has no special requirements, and we
        // have no custom ivars to set up.
        unsafe { msg_send![Self::alloc(), init] }
    }
}

/// Whether the process is running from a real `.app` bundle. `UNUserNotificationCenter`
/// requires one — outside a bundle (e.g. the bare binary `tauri dev` launches from
/// `target/debug/`), `currentNotificationCenter` throws an uncatchable Obj-C exception
/// that terminates the app. A bundleless process has no bundle identifier, so we gate
/// every notification-center call on this and quietly no-op in dev.
#[cfg(target_os = "macos")]
fn has_app_bundle() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Request notification authorization and install the click-routing delegate.
/// Must run on the main thread — the Tauri `setup` hook that calls this
/// already does.
#[cfg(target_os = "macos")]
pub fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());

    if !has_app_bundle() {
        eprintln!("kriyon: no app bundle — skipping notification setup (dev mode)");
        return;
    }

    let center = UNUserNotificationCenter::currentNotificationCenter();

    let delegate = NotificationDelegate::new();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    let _ = DELEGATE.set(delegate);

    let handler = RcBlock::new(|granted: Bool, error: *mut NSError| {
        eprintln!(
            "kriyon: notification authorization granted={}",
            granted.as_bool()
        );
        if !error.is_null() {
            // SAFETY: the completion-handler contract guarantees `error` is a
            // valid pointer to an `NSError` whenever it is non-null.
            let error = unsafe { &*error };
            eprintln!("kriyon: notification authorization request failed: {error:?}");
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &handler,
    );
}

/// Off-macOS the Tauri plugin needs no application registration.
#[cfg(not(target_os = "macos"))]
pub fn init(_app: &tauri::AppHandle) {}

/// Show an OS notification for `session_id` via `UNUserNotificationCenter`.
/// Delivery is asynchronous and non-blocking (unlike the old thread-per-
/// notification model); a click is routed back to focusing the session by
/// `NotificationDelegate` above, using the `sessionId` stashed in the
/// notification's `userInfo`.
#[cfg(target_os = "macos")]
pub fn show<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    session_id: &str,
    title: &str,
    subtitle: &str,
    body: &str,
    sound: NotifySound,
) {
    if !has_app_bundle() {
        return;
    }

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    if !subtitle.is_empty() {
        content.setSubtitle(&NSString::from_str(subtitle));
    }
    content.setBody(&NSString::from_str(body));
    // Silent → no sound; Default → the system alert; a bundled sound → the
    // `.wav` at the app's Resources root, resolved by name by macOS (which
    // then governs playback under Do Not Disturb / Focus).
    match sound.kind() {
        NotifySoundKind::Silent => {}
        NotifySoundKind::System => {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        NotifySoundKind::Bundled(name) => {
            content.setSound(Some(&UNNotificationSound::soundNamed(&NSString::from_str(
                name,
            ))));
        }
    }

    let user_info = NSDictionary::from_slices(
        &[&*NSString::from_str("sessionId")],
        &[&*NSString::from_str(session_id)],
    );
    // SAFETY: `user_info`'s key and value are plain `NSString`s, which are
    // valid property-list types for `setUserInfo:`.
    unsafe { content.setUserInfo(user_info.cast_unchecked()) };

    // A stable per-session identifier: a fresh notification for the same session
    // replaces its predecessor in place (macOS coalesces by identifier) instead
    // of stacking, and — the point of it — lets `withdraw` pull exactly this
    // session's banner when the "needs you" state it announced has passed.
    let identifier = NSString::from_str(&notification_id(session_id));
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);

    eprintln!("kriyon: notify::show session={session_id} title={title:?}");
    // Pass a completion handler so a rejected post (e.g. unauthorized, invalid
    // content) surfaces an error instead of silently vanishing.
    let handler = RcBlock::new(|error: *mut NSError| {
        if error.is_null() {
            eprintln!("kriyon: notification posted OK");
        } else {
            // SAFETY: the completion-handler contract guarantees `error` is a
            // valid pointer to an `NSError` whenever it is non-null.
            let error = unsafe { &*error };
            eprintln!("kriyon: notification post failed: {error:?}");
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&handler));
}

/// The stable notification identifier for a session — one banner slot per
/// session, so a new post replaces the old and [`withdraw`] can target it.
#[cfg(target_os = "macos")]
fn notification_id(session_id: &str) -> String {
    format!("kriyon.session.{session_id}")
}

/// Pull any banner previously shown for `session_id` from Notification Center
/// (and cancel a not-yet-delivered one). Called when the session leaves the
/// attention state that justified the banner — the user answered the prompt, or
/// Claude resumed on its own — so a stale "needs you" alert never outlives the
/// state it announced. Fire-and-forget: a no-op when nothing is showing, and
/// when the process has no `.app` bundle (dev mode, where the center is absent).
#[cfg(target_os = "macos")]
pub fn withdraw<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, session_id: &str) {
    if !has_app_bundle() {
        return;
    }
    let identifier = NSString::from_str(&notification_id(session_id));
    let identifiers = NSArray::from_slice(&[&*identifier]);
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.removeDeliveredNotificationsWithIdentifiers(&identifiers);
    center.removePendingNotificationRequestsWithIdentifiers(&identifiers);
    eprintln!("kriyon: notify::withdraw session={session_id}");
}

/// Off-macOS: nothing is delivered by [`show`]'s native path, so there is
/// nothing to withdraw.
#[cfg(not(target_os = "macos"))]
pub fn withdraw<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _session_id: &str) {}

/// Off-macOS: the existing Tauri-plugin path (no click routing).
#[cfg(not(target_os = "macos"))]
pub fn show<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    _session_id: &str,
    title: &str,
    _subtitle: &str,
    body: &str,
    _sound: kriyon_core::status::NotifySound,
) {
    use tauri_plugin_notification::NotificationExt as _;
    let _ = app.notification().builder().title(title).body(body).show();
}
