//! Commands for [Remote access]: the switch, pairing and the paired devices.
//! Every argument comes from the webview and is checked here (trust boundary);
//! what the host does lives in [`kriyon_remote_link::host_runtime`].

use serde::{Deserialize, Serialize};

use kriyon_remote::message::{hex, Role};

/// The longest name the person may give a device, in bytes, as for the name
/// a device gives itself.
const MAX_DEVICE_NAME: usize = kriyon_remote::pairing::MAX_DEVICE_NAME;

/// A role as the webview names it. Anything else is refused by serde.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RoleArg {
    Viewer,
    Controller,
}

impl From<RoleArg> for Role {
    fn from(role: RoleArg) -> Self {
        match role {
            RoleArg::Viewer => Self::Viewer,
            RoleArg::Controller => Self::Controller,
        }
    }
}

impl From<Role> for RoleArg {
    fn from(role: Role) -> Self {
        match role {
            Role::Viewer => Self::Viewer,
            Role::Controller => Self::Controller,
        }
    }
}

/// A device id from the webview: exactly 64 lowercase hex digits.
///
/// # Errors
/// A message for any other text.
pub fn parse_device_id(text: &str) -> Result<[u8; 32], String> {
    kriyon_remote::message::parse_id_hex(text)
        .ok_or_else(|| "a device id is 64 lowercase hex digits".to_string())
}

/// A pairing code from the webview: exactly six ASCII digits.
///
/// # Errors
/// A message for any other text.
pub fn check_code_text(code: &str) -> Result<(), String> {
    if code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err("a pairing code is six digits".to_string())
    }
}

/// A name the person gives a device: short plain text.
///
/// # Errors
/// A message for an empty, long or disguised name.
pub fn check_device_name_text(name: &str) -> Result<(), String> {
    kriyon_remote::text::check_shown_text(name, MAX_DEVICE_NAME)
        .map_err(|_| format!("a device name is 1 to {MAX_DEVICE_NAME} bytes of plain text"))
}

/// A QR code as a grid of modules, for the UI to draw.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrGrid {
    /// Modules per side.
    pub size: usize,
    /// `size * size` characters, row by row: `1` dark, `0` light.
    pub dark: String,
}

/// The QR code for a pairing invite's text. Only invites are drawn, so the
/// command can't be used to make arbitrary codes.
///
/// # Errors
/// For text that isn't a pairing invite.
pub fn qr_grid(text: &str) -> Result<QrGrid, String> {
    kriyon_remote::pairing::PairingInvite::from_qr_text(text)
        .map_err(|_| "not a pairing invite".to_string())?;
    let code = qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::M)
        .map_err(|e| e.to_string())?;
    let dark = code
        .to_colors()
        .into_iter()
        .map(|color| {
            if color == qrcode::Color::Dark {
                '1'
            } else {
                '0'
            }
        })
        .collect();
    Ok(QrGrid {
        size: code.width(),
        dark,
    })
}

/// The QR code to show for a pairing invite's text.
///
/// # Errors
/// For text that isn't a pairing invite.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn remote_pairing_qr(text: String) -> Result<QrGrid, String> {
    qr_grid(&text)
}

/// `invite` naming `relay`, the relay the host's endpoint was bound with,
/// when iroh hasn't reported it yet (it does once it has chosen its home
/// relay). A device reaches the host through it when no direct path works.
#[must_use]
pub fn invite_with_relay(
    invite: kriyon_remote::pairing::PairingInvite,
    relay: Option<&kriyon_remote_link::RelayAccess>,
) -> kriyon_remote::pairing::PairingInvite {
    let mut invite = invite;
    if invite.relay_url.is_none() {
        invite.relay_url = relay.map(|relay| relay.url.to_string());
    }
    invite
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_invite_names_the_relay_the_host_uses() {
        let invite = || kriyon_remote::pairing::PairingInvite {
            host_id: [2; 32],
            addrs: vec![],
            relay_url: None,
            secret: [7; 32],
        };
        let relay = kriyon_remote_link::RelayAccess {
            url: "https://relay.example.test/".parse().expect("url"),
            pass: "kp1.secret-to-the-relay".into(),
        };
        assert_eq!(invite_with_relay(invite(), None).relay_url, None);
        let named = invite_with_relay(invite(), Some(&relay));
        assert_eq!(
            named.relay_url.as_deref(),
            Some("https://relay.example.test/")
        );
        assert!(!named.to_qr_text().contains("kp1"), "never the pass");
        let reported = kriyon_remote::pairing::PairingInvite {
            relay_url: Some("https://other.example.test/".into()),
            ..invite()
        };
        assert_eq!(
            invite_with_relay(reported, Some(&relay))
                .relay_url
                .as_deref(),
            Some("https://other.example.test/"),
            "iroh's own report wins"
        );
    }

    fn invite_text() -> String {
        kriyon_remote::pairing::PairingInvite {
            host_id: [2; 32],
            addrs: vec!["192.168.1.20:41641".into()],
            relay_url: None,
            secret: [7; 32],
        }
        .to_qr_text()
    }

    #[test]
    fn an_invite_becomes_a_square_grid_of_modules() {
        let grid = qr_grid(&invite_text()).expect("a code");
        assert!(grid.size >= 21, "version 1 is 21 modules");
        assert_eq!(grid.dark.len(), grid.size * grid.size);
        assert!(grid.dark.bytes().all(|b| b == b'0' || b == b'1'));
        // The top-left finder pattern: its outer ring is dark.
        let at = |row: usize, col: usize| grid.dark.as_bytes()[row * grid.size + col];
        for i in 0..7 {
            assert_eq!(at(0, i), b'1');
            assert_eq!(at(i, 0), b'1');
            assert_eq!(at(6, i), b'1');
        }
        assert_eq!(at(1, 1), b'0');
    }

    #[test]
    fn only_a_pairing_invite_is_drawn() {
        assert!(qr_grid("https://example.com").is_err());
        assert!(qr_grid("").is_err());
    }

    #[test]
    fn a_device_id_that_isnt_one_is_refused_in_words() {
        assert_eq!(parse_device_id(&"ab".repeat(32)), Ok([0xab; 32]));
        assert_eq!(
            parse_device_id("AB"),
            Err("a device id is 64 lowercase hex digits".to_string())
        );
    }

    #[test]
    fn a_code_is_exactly_six_digits() {
        assert_eq!(check_code_text("012345"), Ok(()));
        for bad in ["", "12345", "1234567", "12345a", " 12345", "１２３４５６"] {
            assert!(check_code_text(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_device_name_is_short_plain_text() {
        assert_eq!(check_device_name_text("Work phone"), Ok(()));
        for bad in ["", "two\nlines", "a\u{202e}b", &"x".repeat(65)] {
            assert!(check_device_name_text(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_role_from_the_webview_is_one_of_two_words() {
        let parse = |json: &str| serde_json::from_str::<RoleArg>(json);
        assert_eq!(parse("\"viewer\"").ok(), Some(RoleArg::Viewer));
        assert_eq!(parse("\"controller\"").ok(), Some(RoleArg::Controller));
        assert!(parse("\"admin\"").is_err());
        assert!(parse("\"Controller\"").is_err());
    }
}

/// The switch's setting in the store; absent means off.
const SETTING: &str = "remoteAccess";

/// The event telling the UI a device took the pairing and its code is wanted.
pub const CODE_WANTED_EVENT: &str = "remote-pairing-code-wanted";

/// Paired devices as the host's accept loop asks for them: the store.
struct StoreDevices(tauri::AppHandle);

impl kriyon_remote_link::host::PairedDevices for StoreDevices {
    fn role(&self, device: &[u8; 32]) -> Option<Role> {
        use tauri::Manager as _;
        let store = self.0.state::<crate::StoreState>();
        let store = store.0.lock();
        // A store that can't answer admits nobody.
        store.paired_device_role(device).ok().flatten()
    }
}

/// This computer's name, as a paired device shows it.
pub(crate) fn host_name() -> String {
    let mut buf = [0_u8; 256];
    // SAFETY: `buf` is valid for `buf.len()` bytes of writes.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    let name = if rc == 0 {
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    } else {
        String::new()
    };
    let name = name.trim_end_matches(".local");
    if name.is_empty() {
        "Kriyon".to_string()
    } else {
        name.to_string()
    }
}

/// The host's [Device key], made on first use.
pub(crate) fn device_key(app: &tauri::AppHandle) -> Result<[u8; 32], String> {
    #[cfg(target_os = "macos")]
    {
        let vault = crate::device_key::Keychain::for_app(&app.config().identifier);
        kriyon_remote_link::keys::load_or_create(
            &vault,
            kriyon_remote_link::endpoint::generate_secret_key,
        )
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("remote access needs macOS for now".to_string())
    }
}

/// This computer's one endpoint, bound now if it isn't, with the device side
/// attached to it.
///
/// # Errors
/// Why the Device key or the endpoint couldn't be had.
pub(crate) async fn bound(app: &tauri::AppHandle) -> Result<crate::remote_endpoint::Bound, String> {
    use tauri::Manager as _;
    let secret_key = device_key(app)?;
    // The relay the person turned on, with this device's pass; used if the
    // endpoint binds now.
    let relay = app
        .state::<kriyon_relay_client::runtime::RelayRuntime>()
        .access()
        .await;
    app.state::<crate::remote_endpoint::RemoteEndpoint>()
        .want_relay(relay)
        .await;
    let devices = app.clone();
    let bound = app
        .state::<crate::remote_endpoint::RemoteEndpoint>()
        .get(secret_key, move || {
            std::sync::Arc::new(StoreDevices(devices))
        })
        .await?;
    app.state::<kriyon_remote_link::device_runtime::DeviceRuntime>()
        .attach(bound.endpoint.clone())
        .await;
    Ok(bound)
}

/// Close the endpoint if neither side uses it: remote access is off and no
/// paired computer is connected to.
pub(crate) async fn release_endpoint_if_unused(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let unused = !app
        .state::<kriyon_remote_link::host_runtime::RemoteRuntime>()
        .is_on()
        .await
        && !app
            .state::<kriyon_remote_link::device_runtime::DeviceRuntime>()
            .in_use()
            .await;
    app.state::<crate::remote_endpoint::RemoteEndpoint>()
        .close_if(unused)
        .await;
}

pub(crate) async fn turn_on(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter as _, Manager as _};
    let host = bound(app).await?.host;
    let emitter = app.clone();
    let releaser = app.clone();
    let setup = kriyon_remote_link::host_runtime::HostSetup {
        host,
        on_device_gone: std::sync::Arc::new(move |device| {
            let app = releaser.clone();
            tauri::async_runtime::spawn(async move { release_everywhere(&app, device).await });
        }),
        on_code_wanted: std::sync::Arc::new(move |device_name| {
            let _ = emitter.emit(
                CODE_WANTED_EVENT,
                serde_json::json!({ "deviceName": device_name }),
            );
        }),
    };
    app.state::<kriyon_remote_link::host_runtime::RemoteRuntime>()
        .turn_on(setup)
        .await
}

/// Bring remote access back up at launch if the person left it on.
pub fn restore(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let on = app
        .state::<crate::StoreState>()
        .0
        .lock()
        .load_layout(SETTING)
        .ok()
        .flatten()
        .is_some_and(|value| value == "true");
    if on {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = turn_on(&app).await {
                eprintln!("kriyon: remote access didn't come back up: {e}");
            }
        });
    }
}

/// [Remote access] as the settings show it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    /// The host's endpoint id while on.
    pub host_id: Option<String>,
    pub pairing: PairingView,
}

/// The pairing in progress.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum PairingView {
    Idle,
    Waiting {
        role: RoleArg,
        expires_at_ms: i64,
    },
    CodeWanted {
        role: RoleArg,
        device_name: String,
        expires_at_ms: i64,
    },
    Expired,
    Burned,
}

async fn status(rt: &kriyon_remote_link::host_runtime::RemoteRuntime) -> RemoteStatus {
    use kriyon_remote_link::host_runtime::PairingStatus;
    let pairing = match rt.pairing_status().await {
        PairingStatus::Idle => PairingView::Idle,
        PairingStatus::Waiting {
            role,
            expires_at_ms,
        } => PairingView::Waiting {
            role: role.into(),
            expires_at_ms,
        },
        PairingStatus::CodeWanted {
            role,
            device_name,
            expires_at_ms,
        } => PairingView::CodeWanted {
            role: role.into(),
            device_name,
            expires_at_ms,
        },
        PairingStatus::Expired => PairingView::Expired,
        PairingStatus::Burned => PairingView::Burned,
    };
    RemoteStatus {
        enabled: rt.is_on().await,
        host_id: rt.host_id().await.map(|id| hex(&id)),
        pairing,
    }
}

/// Where remote access stands.
///
/// # Errors
/// Never; `Result` for the command's async form.
#[tauri::command]
pub async fn remote_status(
    rt: tauri::State<'_, kriyon_remote_link::host_runtime::RemoteRuntime>,
) -> Result<RemoteStatus, String> {
    Ok(status(&rt).await)
}

/// Turn remote access on (the host endpoint comes up) or off (no endpoint at
/// all), and remember it across launches.
///
/// # Errors
/// Why the endpoint couldn't come up, or the setting couldn't be saved.
#[tauri::command]
pub async fn remote_set_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<RemoteStatus, String> {
    use tauri::Manager as _;
    if enabled {
        turn_on(&app).await?;
    } else {
        app.state::<kriyon_remote_link::host_runtime::RemoteRuntime>()
            .turn_off()
            .await;
        // Off means no endpoint, unless this computer is using another one.
        release_endpoint_if_unused(&app).await;
    }
    app.state::<crate::StoreState>()
        .0
        .lock()
        .save_layout(SETTING, if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())?;
    Ok(status(&app.state::<kriyon_remote_link::host_runtime::RemoteRuntime>()).await)
}

/// Start pairing a device as `role`; returns the QR code's text.
///
/// # Errors
/// When remote access is off.
#[tauri::command]
pub async fn remote_start_pairing(
    rt: tauri::State<'_, kriyon_remote_link::host_runtime::RemoteRuntime>,
    endpoint: tauri::State<'_, crate::remote_endpoint::RemoteEndpoint>,
    role: RoleArg,
) -> Result<String, String> {
    let invite = rt.start_pairing(role.into()).await?;
    let relay = endpoint.bound_relay().await;
    Ok(invite_with_relay(invite, relay.as_ref()).to_qr_text())
}

/// Stop the pairing in progress.
///
/// # Errors
/// Never; `Result` for the command's async form.
#[tauri::command]
pub async fn remote_stop_pairing(
    rt: tauri::State<'_, kriyon_remote_link::host_runtime::RemoteRuntime>,
) -> Result<(), String> {
    rt.stop_pairing().await;
    Ok(())
}

/// What typing a code did, for the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum CodeResult {
    Paired {
        device_id: String,
        name: String,
        role: RoleArg,
    },
    Wrong {
        tries_left: u32,
    },
    Burned,
    NoAttempt,
}

/// The person typed the code the device shows.
///
/// # Errors
/// For text that isn't six digits, or when the device can't be told.
#[tauri::command]
pub async fn remote_enter_code(app: tauri::AppHandle, code: String) -> Result<CodeResult, String> {
    use kriyon_remote_link::host_runtime::CodeOutcome;
    use tauri::Manager as _;
    check_code_text(&code)?;
    let store_app = app.clone();
    let now_ms = kriyon_remote_link::host_runtime::now_ms();
    let outcome = app
        .state::<kriyon_remote_link::host_runtime::RemoteRuntime>()
        .enter_code(&code, &host_name(), move |device, name, role| {
            let store = store_app.state::<crate::StoreState>();
            let row = crate::store::PairedDeviceRow {
                endpoint_id: device,
                name: name.to_string(),
                role,
                paired_at: now_ms,
            };
            let kept = store.0.lock().add_paired_device(&row);
            if let Err(e) = &kept {
                eprintln!("kriyon: couldn't keep the paired device: {e}");
            }
            // Paired again: an earlier removal no longer stands.
            if kept.is_ok() {
                store_app
                    .state::<crate::AppState>()
                    .writers
                    .unrevoke(&device);
            }
            kept.is_ok()
        })
        .await?;
    Ok(match outcome {
        CodeOutcome::Paired { device, name, role } => CodeResult::Paired {
            device_id: hex(&device),
            name,
            role: role.into(),
        },
        CodeOutcome::Wrong { tries_left } => CodeResult::Wrong { tries_left },
        CodeOutcome::Burned => CodeResult::Burned,
        CodeOutcome::NoAttempt => CodeResult::NoAttempt,
    })
}

/// A paired device, for the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub role: RoleArg,
    pub paired_at: i64,
}

/// Every paired device.
///
/// # Errors
/// When the store can't be read.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn remote_devices(
    store: tauri::State<'_, crate::StoreState>,
) -> Result<Vec<DeviceView>, String> {
    let rows = store.0.lock().paired_devices().map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| DeviceView {
            id: hex(&row.endpoint_id),
            name: row.name,
            role: row.role.into(),
            paired_at: row.paired_at,
        })
        .collect())
}

/// Rename a paired device.
///
/// # Errors
/// For a bad id or name, an unknown device, or a store failure.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn remote_rename_device(
    store: tauri::State<'_, crate::StoreState>,
    id: String,
    name: String,
) -> Result<(), String> {
    let id = parse_device_id(&id)?;
    check_device_name_text(&name)?;
    if store
        .0
        .lock()
        .rename_paired_device(&id, &name)
        .map_err(|e| e.to_string())?
    {
        Ok(())
    } else {
        Err("no such device".to_string())
    }
}

/// Remove a paired device, in the spec's order (§4): every check refuses
/// it from now on (even on a connection still open), it is forgotten, its
/// connection closes, and control it held goes back to the host.
///
/// # Errors
/// For a bad id, an unknown device, or a store failure.
#[tauri::command]
pub async fn remote_remove_device(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager as _;
    let id = parse_device_id(&id)?;
    let writers = &app.state::<crate::AppState>().writers;
    writers.revoke(id, crate::session_writer::Revoked::Removed);
    let removed = app
        .state::<crate::StoreState>()
        .0
        .lock()
        .remove_paired_device(&id);
    match removed {
        Ok(true) => {}
        // Nothing removed: the device stands as it was.
        Ok(false) => {
            writers.unrevoke(&id);
            return Err("no such device".to_string());
        }
        Err(e) => {
            writers.unrevoke(&id);
            return Err(e.to_string());
        }
    }
    app.state::<kriyon_remote_link::host_runtime::RemoteRuntime>()
        .cut_off(&id)
        .await;
    release_everywhere(&app, id).await;
    Ok(())
}

/// Give back typing control, and the host's size, on every session `device`
/// held (spec sections 4 and 5: it left, was removed or became a Viewer). On
/// the blocking pool: it may resize several sessions.
async fn release_everywhere(app: &tauri::AppHandle, device: [u8; 32]) {
    let app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager as _;
        let state = app.state::<crate::AppState>();
        let engines: Vec<_> = state
            .sessions
            .lock()
            .iter()
            .map(|(id, session)| (id.clone(), std::sync::Arc::clone(&session.engine)))
            .collect();
        state.writers.release_device(&device, &engines);
    })
    .await;
}

/// The person clicked "Let <device> type" on a session: control goes to
/// that device even though they typed here just now. It must still be a
/// Controller with that session open.
///
/// # Errors
/// For a bad id, a device not paired as a Controller or without the
/// session open now, or a session that closed.
#[tauri::command]
pub async fn remote_let_device_type(
    app: tauri::AppHandle,
    session_id: String,
    device_id: String,
) -> Result<(), String> {
    use tauri::Manager as _;
    let device = parse_device_id(&device_id)?;
    crate::remote_device_cmd::check_session_id(&session_id)?;
    let connected = app
        .try_state::<kriyon_remote_link::host_runtime::Serve>()
        .is_some_and(|serve| serve.has_open(&session_id, &device));
    if !connected {
        return Err("That device isn't watching this session now.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let role = app
            .state::<crate::StoreState>()
            .0
            .lock()
            .paired_device_role(&device)
            .map_err(|e| e.to_string())?;
        let given = app.state::<crate::AppState>().writers.let_device_type(
            &kriyon_core::session::SessionId(session_id),
            device,
            role,
        );
        match given {
            None => Err("That session closed.".to_string()),
            Some(Err(reason)) => Err(kriyon_remote::device_view::refusal_words(reason).to_string()),
            Some(Ok(_)) => Ok(()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Change a paired device's role. Its connections close so it comes back
/// with the new role.
///
/// # Errors
/// For a bad id, an unknown device, or a store failure.
#[tauri::command]
pub async fn remote_set_device_role(
    app: tauri::AppHandle,
    id: String,
    role: RoleArg,
) -> Result<(), String> {
    use tauri::Manager as _;
    let id = parse_device_id(&id)?;
    let writers = &app.state::<crate::AppState>().writers;
    // Made a Viewer: every check sees it at once, before its connection
    // closes (spec §4). Made a Controller: its next connection is.
    let viewer = role == RoleArg::Viewer;
    if viewer {
        writers.revoke(
            id,
            crate::session_writer::Revoked::Demoted(kriyon_remote::message::Role::Viewer),
        );
    }
    let changed = app
        .state::<crate::StoreState>()
        .0
        .lock()
        .set_paired_device_role(&id, role.into());
    // Nothing changed: a demotion that didn't happen doesn't stand.
    if viewer && !matches!(changed, Ok(true)) {
        writers.unrevoke(&id);
    }
    match changed {
        Ok(true) => {}
        Ok(false) => return Err("no such device".to_string()),
        Err(e) => return Err(e.to_string()),
    }
    if !viewer {
        writers.unrevoke(&id);
    }
    app.state::<kriyon_remote_link::host_runtime::RemoteRuntime>()
        .reconnect(&id)
        .await;
    if viewer {
        release_everywhere(&app, id).await;
    }
    Ok(())
}
