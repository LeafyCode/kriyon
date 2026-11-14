//! Our relay in the app: the settings' commands, and this computer's one
//! endpoint as the [`PassKeeper`] rebuilds it with a new pass. When to renew
//! and rebuild is `kriyon_relay_client::keeper`'s, shared with the phone;
//! this is glue.

use std::sync::Arc;

use kriyon_relay_client::keeper::{now_s, InUse, PassKeeper, Rebind, CHECK_EVERY};
use kriyon_remote_link::RelayAccess;
use serde::Serialize;
use tauri::{Emitter as _, Manager as _};
use tauri_plugin_opener::OpenerExt as _;

use crate::remote_endpoint::{Bound, RemoteEndpoint};
use kriyon_relay_client::api::RelayStatus;
use kriyon_relay_client::runtime::{RelayRuntime, RelayView, SignInView, ThisDevice};

/// Sent when the relay's state changed, for the settings to read it again.
pub const RELAY_CHANGED_EVENT: &str = "relay-changed";

/// This computer as the relay account knows it.
fn this_device(app: &tauri::AppHandle) -> Result<ThisDevice, String> {
    let secret = crate::remote_cmd::device_key(app)?;
    let id = kriyon_remote_link::endpoint::public_id(&secret);
    Ok(ThisDevice {
        key_hex: kriyon_remote::message::hex(&id),
        name: kriyon_core::host::computer_name(),
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

/// This computer's endpoint as the keeper rebuilds it.
struct AppEndpoint(tauri::AppHandle);

impl Rebind for AppEndpoint {
    fn relay(&self) -> &RelayRuntime {
        self.0.state::<RelayRuntime>().inner()
    }

    fn this_device(&self) -> Option<ThisDevice> {
        this_device(&self.0).ok()
    }

    async fn want(&self, relay: Option<(RelayAccess, u64)>) -> InUse {
        let endpoint = self.0.state::<RemoteEndpoint>();
        let expires_s = endpoint.bound_relay_expires().await;
        InUse {
            stale: endpoint.want_relay(relay).await,
            expires_s,
        }
    }

    /// Nothing would notice the endpoint going: no remote device has a
    /// session open, and this computer has no other computer open.
    async fn quiet(&self) -> bool {
        let app = &self.0;
        let watched = app
            .try_state::<kriyon_remote_link::host_runtime::Serve>()
            .is_some_and(|serve| !serve.onlooked_sessions().is_empty());
        !watched
            && !app
                .state::<kriyon_remote_link::device_runtime::DeviceRuntime>()
                .in_use()
                .await
    }

    /// Close the endpoint and bring it back with the relay it wants (as
    /// [`Rebind::want`] gave it to the [`RemoteEndpoint`], which binds with
    /// it). Remote access comes back up if it was on; the device side binds
    /// again when it next dials.
    async fn rebind(&self, _relay: Option<(RelayAccess, u64)>) -> Result<(), String> {
        let app = &self.0;
        let remote = app.state::<kriyon_remote_link::host_runtime::RemoteRuntime>();
        let was_on = remote.is_on().await;
        remote.turn_off().await;
        app.state::<RemoteEndpoint>().close_if(true).await;
        if was_on {
            crate::remote_cmd::turn_on(app).await?;
        }
        Ok(())
    }

    fn changed(&self) {
        changed(&self.0);
    }
}

/// Rebuild the endpoint now (a new port), in turn with the relay's own
/// rebuilds.
pub(crate) async fn rebuild_in_turn(app: &tauri::AppHandle) {
    let keeper = app.state::<PassKeeper>();
    if let Err(why) = keeper.rebind_in_turn(&AppEndpoint(app.clone())).await {
        eprintln!("kriyon: remote access didn't come back up on the new port: {why}");
    }
}

/// Put the relay as it stands to use now: the person changed it.
async fn apply_now(app: &tauri::AppHandle) {
    let keeper = app.state::<PassKeeper>();
    if let Err(why) = keeper.apply(now_s(), &AppEndpoint(app.clone()), true).await {
        eprintln!("kriyon: remote access didn't come back up with the new relay pass: {why}");
        changed(app);
    }
}

/// Set the relay up at launch: watch each endpoint bound with it, and check
/// the pass every [`CHECK_EVERY`].
pub fn install(app: &tauri::AppHandle) {
    let watcher = app.clone();
    app.state::<RemoteEndpoint>()
        .on_bind(Arc::new(move |bound: &Bound| {
            if bound.relay.is_some() {
                let app = watcher.clone();
                let endpoint = bound.endpoint.clone();
                tauri::async_runtime::spawn(async move {
                    let rebind = AppEndpoint(app.clone());
                    app.state::<PassKeeper>().watch(&endpoint, &rebind).await;
                });
            }
        }));
    if app.state::<RelayRuntime>().subscriptions_url().is_none() {
        return;
    }
    let checker = app.clone();
    tauri::async_runtime::spawn(async move {
        let rebind = AppEndpoint(checker.clone());
        loop {
            checker.state::<PassKeeper>().check(now_s(), &rebind).await;
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
    let code = view.device_code().to_string();
    tauri::async_runtime::spawn(async move {
        if waiter
            .state::<RelayRuntime>()
            .wait_for_sign_in(&device, &code)
            .await
        {
            apply_now(&waiter).await;
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
    apply_now(&app).await;
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
    apply_now(&app).await;
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
