//! Our relay in the app: the settings' commands, putting a pass to use on
//! this computer's one endpoint, and watching what the relay says. The
//! decisions are `kriyon_remote::relay`'s and `relay_rt`'s; this is glue.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use kriyon_remote::relay::{rebuild_due, RelayAction};
use serde::Serialize;
use tauri::{Emitter as _, Manager as _};
use tauri_plugin_opener::OpenerExt as _;

use crate::relay_api::RelayStatus;
use crate::relay_rt::{RelayRuntime, RelayView, SignInView, ThisDevice};
use crate::remote_endpoint::{Bound, RemoteEndpoint};

/// Sent when the relay's state changed, for the settings to read it again.
pub const RELAY_CHANGED_EVENT: &str = "relay-changed";

/// How often the pass is checked for renewal, and a waiting one put to use.
const CHECK_EVERY: Duration = Duration::from_secs(60);

/// At most one new pass this often because the relay refused the one in
/// hand, so a relay that refuses every pass isn't asked in a loop.
const FORCED_RENEW_GAP: Duration = Duration::from_secs(10 * 60);

/// The glue's own state.
#[derive(Default)]
pub struct RelayGlue {
    /// A check or a rebuild is running.
    busy: AtomicBool,
    last_forced: std::sync::Mutex<Option<std::time::Instant>>,
}

impl RelayGlue {
    /// Whether a forced renewal may run now; if so, it is counted.
    fn may_force(&self) -> bool {
        let Ok(mut last) = self.last_forced.lock() else {
            return false;
        };
        let now = std::time::Instant::now();
        if last.is_some_and(|at| now.duration_since(at) < FORCED_RENEW_GAP) {
            return false;
        }
        *last = Some(now);
        true
    }
}

fn now_s() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// This computer as the relay account knows it.
fn this_device(app: &tauri::AppHandle) -> Result<ThisDevice, String> {
    let secret = crate::remote_cmd::device_key(app)?;
    let id = kriyon_remote_link::endpoint::public_id(&secret);
    Ok(ThisDevice {
        key_hex: crate::remote_cmd::device_id_text(&id),
        name: crate::remote_cmd::host_name(),
        platform: if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            "linux"
        },
    })
}

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit(RELAY_CHANGED_EVENT, ());
}

/// Whether nothing would notice the endpoint going: no remote device has a
/// session open, and this computer has no other computer open.
async fn quiet(app: &tauri::AppHandle) -> bool {
    let watched = app
        .try_state::<crate::remote_serve::Serve>()
        .is_some_and(|serve| !serve.onlooked_sessions().is_empty());
    !watched
        && !app
            .state::<crate::remote_device_rt::DeviceRuntime>()
            .in_use()
            .await
}

/// Close the endpoint and bring it back with the relay it wants. Remote
/// access comes back up if it was on; the device side binds again when it
/// next dials.
async fn rebuild(app: &tauri::AppHandle) {
    let remote = app.state::<crate::remote_rt::RemoteRuntime>();
    let was_on = remote.is_on().await;
    remote.turn_off().await;
    app.state::<RemoteEndpoint>().close_if(true).await;
    if was_on {
        if let Err(e) = crate::remote_cmd::turn_on(app).await {
            eprintln!("kriyon: remote access didn't come back up with the new relay pass: {e}");
        }
    }
    changed(app);
}

/// Put the relay as it stands to use: the next bind takes it, and an
/// endpoint bound now is rebuilt when `now`, at a quiet moment, or when its
/// pass runs low.
async fn apply(app: &tauri::AppHandle, now: bool) {
    let access = app.state::<RelayRuntime>().access().await;
    let endpoint = app.state::<RemoteEndpoint>();
    let in_use_expires = endpoint.bound_relay_expires().await;
    if !endpoint.want_relay(access).await {
        return;
    }
    if now || rebuild_due(now_s(), in_use_expires, true, quiet(app).await) {
        rebuild(app).await;
    }
}

/// Renew the pass if it is due (`force`: the relay refused it), and put a
/// new one to use when it is time.
async fn check(app: &tauri::AppHandle, force: bool) {
    let glue = app.state::<RelayGlue>();
    if glue.busy.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Ok(device) = this_device(app) {
        let relay = app.state::<RelayRuntime>();
        if relay.renew(now_s(), &device, force).await {
            changed(app);
        }
    }
    apply(app, force).await;
    glue.busy.store(false, Ordering::Release);
}

/// Watch what the relay says about this endpoint until it closes, and act
/// on a refusal (the contract's table).
async fn watch(app: tauri::AppHandle, endpoint: iroh::Endpoint) {
    use iroh::Watcher as _;
    let mut status = endpoint.home_relay_status();
    let mut last: Option<RelayAction> = None;
    loop {
        let relays = tokio::select! {
            () = endpoint.closed() => return,
            next = status.updated() => match next {
                Ok(relays) => relays,
                Err(_) => return,
            },
        };
        let action = relays.iter().find_map(|relay| {
            let error = relay.last_error().map(|e| format!("{e:#}"));
            RelayAction::from_status(relay.auth_denied_reason(), error.as_deref())
        });
        if action == last {
            continue;
        }
        last = action;
        let Some(action) = action else {
            continue;
        };
        let renew = app.state::<RelayRuntime>().relay_refused(action).await;
        changed(&app);
        if renew && app.state::<RelayGlue>().may_force() {
            check(&app, true).await;
        }
    }
}

/// Set the relay up at launch: watch each endpoint bound with it, and check
/// the pass every minute.
pub fn install(app: &tauri::AppHandle) {
    let watcher = app.clone();
    app.state::<RemoteEndpoint>()
        .on_bind(Arc::new(move |bound: &Bound| {
            if bound.relay.is_some() {
                tauri::async_runtime::spawn(watch(watcher.clone(), bound.endpoint.clone()));
            }
        }));
    if app.state::<RelayRuntime>().subscriptions_url().is_none() {
        return;
    }
    let checker = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            check(&checker, false).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Where our relay stands.
///
/// # Errors
/// Never; `Result` for the command's async form.
#[tauri::command]
pub async fn relay_view(relay: tauri::State<'_, RelayRuntime>) -> Result<RelayView, String> {
    Ok(relay.view().await)
}

/// Start a [Device sign-in]: shows the code, opens the sign-in page, and
/// waits for approval in the background (`relay-changed` when it ends).
///
/// # Errors
/// Without a relay, or when the API refuses or can't be reached.
#[tauri::command]
pub async fn relay_sign_in(app: tauri::AppHandle) -> Result<SignInView, String> {
    let device = this_device(&app)?;
    let view = app.state::<RelayRuntime>().start_sign_in().await?;
    // Only a web page: the address came from the API.
    let page = &view.verification_uri_complete;
    if page.starts_with("https://") {
        if let Err(e) = app.opener().open_url(page, None::<&str>) {
            eprintln!("kriyon: can't open the sign-in page: {e}");
        }
    }
    let waiter = app.clone();
    tauri::async_runtime::spawn(async move {
        if waiter
            .state::<RelayRuntime>()
            .wait_for_sign_in(&device)
            .await
        {
            apply(&waiter, true).await;
        }
        changed(&waiter);
    });
    Ok(view)
}

/// Stop the sign-in in progress.
///
/// # Errors
/// Never; `Result` for the command's async form.
#[tauri::command]
pub async fn relay_cancel_sign_in(relay: tauri::State<'_, RelayRuntime>) -> Result<(), String> {
    relay.cancel_sign_in().await;
    Ok(())
}

/// Sign out of the relay account on this computer; the relay goes off.
///
/// # Errors
/// Why the keychain couldn't be written.
#[tauri::command]
pub async fn relay_sign_out(app: tauri::AppHandle) -> Result<RelayView, String> {
    let relay = app.state::<RelayRuntime>();
    relay.sign_out().await?;
    apply(&app, true).await;
    Ok(relay.view().await)
}

/// Turn our relay on (this device's pass is fetched) or off; the endpoint
/// is rebuilt to use it at once.
///
/// # Errors
/// Not signed in, or the API refused (in the contract's words).
#[tauri::command]
pub async fn relay_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<RelayView, String> {
    let device = this_device(&app)?;
    let relay = app.state::<RelayRuntime>();
    relay.set_on(enabled, &device).await?;
    apply(&app, true).await;
    Ok(relay.view().await)
}

/// The relay account's subscription and devices.
///
/// # Errors
/// Not signed in, or the API refused or can't be reached.
#[tauri::command]
pub async fn relay_account(relay: tauri::State<'_, RelayRuntime>) -> Result<RelayStatus, String> {
    relay.account().await
}

/// Remove a device from the relay account. It stops using our relay; it
/// stays paired.
///
/// # Errors
/// Not signed in, the id isn't one, or the API refused.
#[tauri::command]
pub async fn relay_remove_device(
    relay: tauri::State<'_, RelayRuntime>,
    device_id: String,
) -> Result<(), String> {
    relay.remove_device(&device_id).await
}

/// This computer's device key, as the relay account's device list shows
/// it, so the settings can mark "this computer".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThisDeviceView {
    pub device_key: String,
}

/// This computer's device key.
///
/// # Errors
/// Why the device key couldn't be had.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn relay_this_device(app: tauri::AppHandle) -> Result<ThisDeviceView, String> {
    Ok(ThisDeviceView {
        device_key: this_device(&app)?.key_hex,
    })
}

/// Open the website's subscriptions page.
///
/// # Errors
/// Without a relay, or when the browser can't be opened.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn relay_open_subscriptions(
    app: tauri::AppHandle,
    relay: tauri::State<'_, RelayRuntime>,
) -> Result<(), String> {
    let url = relay.subscriptions_url().ok_or("This build has no relay")?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
