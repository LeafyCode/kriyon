//! The update command family: the webview's only way to the in-app updater.
//! Each command is glue over `update_rt`; the rules are in
//! `kriyon_core::update`.

use kriyon_core::update::{CheckKind, UpdateChannel};

use crate::update_rt::{self, DownloadProgress, UpdateSnapshot};

/// What the updater knows right now: the prefs, the build, any offer.
#[must_use]
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn update_status(app: tauri::AppHandle) -> UpdateSnapshot {
    update_rt::snapshot(&app)
}

/// "Check now": an asked check, which also shows a [Skipped version].
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> UpdateSnapshot {
    update_rt::check(&app, CheckKind::Asked).await
}

/// Save the [Update channel] and auto-check choice. The channel is an enum,
/// so the webview can only pick one of the fixed feeds.
///
/// # Errors
/// When the prefs can't be saved.
#[tauri::command]
pub async fn set_update_prefs(
    app: tauri::AppHandle,
    channel: UpdateChannel,
    auto_check: bool,
) -> Result<UpdateSnapshot, String> {
    update_rt::set_prefs(&app, channel, auto_check).await
}

/// "Skip this version" for the version on offer.
///
/// # Errors
/// When `version` is not the one on offer, or the prefs can't be saved.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn skip_update(app: tauri::AppHandle, version: String) -> Result<UpdateSnapshot, String> {
    update_rt::skip(&app, &version)
}

/// "Install & restart" for the version on offer. Reports download progress
/// over `on_progress`, then restarts the app, so it only returns on failure.
///
/// # Errors
/// When nothing installable is on offer, or the download, backup or install
/// fails.
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<(), String> {
    update_rt::install(&app, on_progress).await
}
