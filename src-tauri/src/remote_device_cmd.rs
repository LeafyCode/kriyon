//! Commands for this computer as a [Remote device] of another computer:
//! pairing from an invite's text, the paired hosts, and their sessions.
//! Every argument comes from the webview and is checked here (trust
//! boundary); the work is [`kriyon_remote_link::device_runtime`]'s.

use std::sync::Arc;

use kriyon_remote::device_view::{host_summary, HostView, LinkState, ScreenEvent};
use kriyon_remote::message::{hex, EndpointId};
use serde::Serialize;
use tauri::{Emitter as _, Manager as _};

use crate::remote_cmd::parse_device_id;
use kriyon_remote_link::device_runtime::{screen_frame, DeviceEvents, DeviceRuntime, HostEntry};

/// The longest invite text taken: a QR code's worth, with room.
const MAX_INVITE_TEXT: usize = 8 * 1024;

/// The most typed at once, as the protocol allows for one `Input`.
use kriyon_remote::message::MAX_INPUT_BYTES as MAX_INPUT;

/// Told when a host's link or view changes.
pub const HOST_CHANGED_EVENT: &str = "remote-host-changed";
/// Told when a pairing started from here ends.
pub const PAIRED_EVENT: &str = "remote-host-pairing-ended";

/// An invite's text from the webview: one line, not too long, with the
/// invite's prefix. The runtime reads the rest.
///
/// # Errors
/// A message for anything else.
pub fn check_invite_text(text: &str) -> Result<(), String> {
    let text = text.trim();
    let one_line = !text.contains(['\n', '\r']);
    if text.len() <= MAX_INVITE_TEXT
        && one_line
        && text.starts_with(kriyon_remote::pairing::INVITE_PREFIX)
    {
        Ok(())
    } else {
        Err("that isn't a Kriyon pairing code".to_string())
    }
}

/// A session id from the webview, as the daemon's ids are.
///
/// # Errors
/// A message for any other text.
pub fn check_session_id(id: &str) -> Result<(), String> {
    if id.len() <= 128 && kriyon_core::daemon::is_valid_session_id(id) {
        Ok(())
    } else {
        Err("invalid session id".to_string())
    }
}

/// Typing from the webview: not empty, not more than one `Input` holds.
///
/// # Errors
/// A message for an empty or too long input.
pub fn check_input(text: &str) -> Result<(), String> {
    if text.is_empty() || text.len() > MAX_INPUT {
        Err(format!("typing is 1 to {MAX_INPUT} bytes at a time"))
    } else {
        Ok(())
    }
}

/// Tells the webview about each host's link.
struct Emitter {
    app: tauri::AppHandle,
    me: EndpointId,
}

impl DeviceEvents for Emitter {
    fn host_changed(&self, host: EndpointId, state: LinkState, view: &HostView) {
        // The summary the phone reads too (kriyon_remote::device_view).
        let _ = self.app.emit(
            HOST_CHANGED_EVENT,
            host_summary(&host, &self.me, state, view),
        );
    }
}

fn runtime(app: &tauri::AppHandle) -> tauri::State<'_, DeviceRuntime> {
    app.state::<DeviceRuntime>()
}

fn entry(row: &crate::store::PairedHostRow) -> Result<HostEntry, String> {
    let addr = kriyon_remote_link::invite::endpoint_addr(
        &row.host_id,
        &row.addrs,
        row.relay_url.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    Ok(HostEntry {
        id: row.host_id,
        addr,
    })
}

async fn connect(app: &tauri::AppHandle, row: &crate::store::PairedHostRow) -> Result<(), String> {
    let me = crate::remote_cmd::bound(app).await?.host.id();
    let events = Arc::new(Emitter {
        app: app.clone(),
        me,
    });
    runtime(app).connect(entry(row)?, events).await
}

/// Connect to every host this computer paired with, at launch.
pub fn restore(app: &tauri::AppHandle) {
    let rows = app
        .state::<crate::StoreState>()
        .0
        .lock()
        .paired_hosts()
        .unwrap_or_default();
    if rows.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for row in rows {
            if let Err(e) = connect(&app, &row).await {
                eprintln!("kriyon: couldn't reconnect to {}: {e}", row.name);
            }
        }
    });
}

/// How a pairing started here ended, for the UI.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum PairingEnded {
    Paired { host_id: String, name: String },
    Failed { reason: String },
}

/// Pair with the computer whose pairing code (QR text) was pasted. Returns
/// the six-digit code to show; the person types it into that computer. How
/// it ends comes as `remote-host-pairing-ended`.
///
/// # Errors
/// For text that isn't a pairing code, or a computer that refused the proof
/// or can't be reached.
#[tauri::command]
pub async fn remote_host_pair(app: tauri::AppHandle, invite: String) -> Result<String, String> {
    check_invite_text(&invite)?;
    crate::remote_cmd::bound(&app).await?;
    let start = runtime(&app)
        .start_pairing(&invite, &crate::remote_cmd::host_name())
        .await?;
    let code = start.code.clone();
    let invite = start.invite;
    let finish = start.finish;
    tauri::async_runtime::spawn(async move {
        let ended = match finish.finish().await {
            Ok(name) => {
                let row = crate::store::PairedHostRow {
                    host_id: invite.host_id,
                    name: name.clone(),
                    addrs: invite.addrs,
                    relay_url: invite.relay_url,
                    paired_at: kriyon_remote_link::host_runtime::now_ms(),
                };
                let kept = app
                    .state::<crate::StoreState>()
                    .0
                    .lock()
                    .add_paired_host(&row);
                match kept {
                    Ok(()) => {
                        if let Err(e) = connect(&app, &row).await {
                            eprintln!("kriyon: paired, but couldn't connect yet: {e}");
                        }
                        PairingEnded::Paired {
                            host_id: hex(&row.host_id),
                            name,
                        }
                    }
                    Err(e) => PairingEnded::Failed {
                        reason: e.to_string(),
                    },
                }
            }
            Err(e) => PairingEnded::Failed {
                reason: e.to_string(),
            },
        };
        let _ = app.emit(PAIRED_EVENT, ended);
    });
    Ok(code)
}

/// A host this computer paired with, as stored.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedHostView {
    pub host_id: String,
    pub name: String,
    pub paired_at: i64,
}

/// Every host this computer paired with.
///
/// # Errors
/// When the store can't be read.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn remote_hosts(
    store: tauri::State<'_, crate::StoreState>,
) -> Result<Vec<PairedHostView>, String> {
    let rows = store.0.lock().paired_hosts().map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| PairedHostView {
            host_id: hex(&row.host_id),
            name: row.name,
            paired_at: row.paired_at,
        })
        .collect())
}

/// Forget a host: stop connecting to it and drop it from the store.
///
/// # Errors
/// For a bad id or a store failure.
#[tauri::command]
pub async fn remote_host_forget(app: tauri::AppHandle, host_id: String) -> Result<(), String> {
    let id = parse_device_id(&host_id)?;
    runtime(&app).disconnect(&id).await;
    app.state::<crate::StoreState>()
        .0
        .lock()
        .forget_paired_host(&id)
        .map_err(|e| e.to_string())?;
    crate::remote_cmd::release_endpoint_if_unused(&app).await;
    Ok(())
}

/// Open a host's session; its screen comes on `on_screen` as raw frames
/// (see [`screen_frame`]).
///
/// # Errors
/// For a bad id, or a host not connected now.
#[tauri::command]
pub async fn remote_host_open_session(
    app: tauri::AppHandle,
    host_id: String,
    session_id: String,
    on_screen: tauri::ipc::Channel<Vec<u8>>,
) -> Result<(), String> {
    let id = parse_device_id(&host_id)?;
    check_session_id(&session_id)?;
    let sink = Arc::new(move |event: ScreenEvent| {
        if let Some(frame) = screen_frame(&event) {
            let _ = on_screen.send(frame);
        }
    });
    runtime(&app)
        .open_session(&id, &session_id, sink)
        .await
        .map_err(|e| e.to_string())
}

/// Read an open host session as [Readable view] entries too; what to show
/// comes on `on_entries`, whole, on every change, until stopped or closed.
///
/// # Errors
/// For a bad id, a session not open here, or a link failure.
#[tauri::command]
pub async fn remote_host_read_entries(
    app: tauri::AppHandle,
    host_id: String,
    session_id: String,
    on_entries: tauri::ipc::Channel<kriyon_remote::device_view::ReadableSummary>,
) -> Result<(), String> {
    let id = parse_device_id(&host_id)?;
    check_session_id(&session_id)?;
    let sink = Arc::new(move |event: kriyon_remote::device_view::EntriesEvent| {
        let _ = on_entries.send(kriyon_remote::device_view::readable_summary(&event));
    });
    runtime(&app)
        .read_entries(&id, &session_id, sink)
        .await
        .map_err(|e| e.to_string())
}

/// Stop reading a host session as entries: back to its terminal.
///
/// # Errors
/// For a bad id.
#[tauri::command]
pub async fn remote_host_stop_entries(
    app: tauri::AppHandle,
    host_id: String,
    session_id: String,
) -> Result<(), String> {
    let id = parse_device_id(&host_id)?;
    check_session_id(&session_id)?;
    runtime(&app).stop_entries(&id, &session_id).await;
    Ok(())
}

/// Close a host's session stream; the session keeps running there.
///
/// # Errors
/// For a bad id.
#[tauri::command]
pub async fn remote_host_close_session(
    app: tauri::AppHandle,
    host_id: String,
    session_id: String,
) -> Result<(), String> {
    let id = parse_device_id(&host_id)?;
    check_session_id(&session_id)?;
    runtime(&app).close_session(&id, &session_id).await;
    Ok(())
}

/// Start a session on a paired host in project `project_id`, titled
/// `title` or after the project: the new session's id, once the host
/// answers. Sent again across reconnects until it does.
///
/// # Errors
/// For bad arguments, or the host's refusal in plain words.
#[tauri::command]
pub async fn remote_host_start_session(
    app: tauri::AppHandle,
    host_id: String,
    project_id: String,
    title: Option<String>,
) -> Result<String, String> {
    let id = parse_device_id(&host_id)?;
    let title = title.filter(|title| !title.trim().is_empty());
    if let Some(words) =
        kriyon_remote::authorize::start_request_words(&project_id, title.as_deref())
    {
        return Err(words.to_string());
    }
    runtime(&app)
        .start_session(&id, &project_id, title)
        .await
        .map_err(|why| why.words().to_string())
}

/// Ask a host for typing control of its session.
///
/// # Errors
/// For a bad id, or a host not connected now.
#[tauri::command]
pub async fn remote_host_take_control(
    app: tauri::AppHandle,
    host_id: String,
    session_id: String,
) -> Result<(), String> {
    let id = parse_device_id(&host_id)?;
    check_session_id(&session_id)?;
    runtime(&app)
        .take_control(&id, &session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Type into a host's session this device controls.
///
/// # Errors
/// For bad arguments, no control, or no screen yet.
#[tauri::command]
pub async fn remote_host_input(
    app: tauri::AppHandle,
    host_id: String,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let id = parse_device_id(&host_id)?;
    check_session_id(&session_id)?;
    check_input(&text)?;
    runtime(&app)
        .input(&id, &session_id, text.into_bytes())
        .await
        .map_err(|e| e.to_string())
}

/// Retry every waiting reconnect now: the app came to the front.
// Signature is dictated by Tauri's command macro (State by value).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn remote_hosts_wake(rt: tauri::State<'_, DeviceRuntime>) {
    rt.wake();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_text_has_the_prefix_and_one_line() {
        assert_eq!(check_invite_text("kriyon-pair:1:00ff"), Ok(()));
        assert_eq!(
            check_invite_text("  kriyon-pair:1:00ff\n"),
            Ok(()),
            "trimmed"
        );
        for bad in [
            "",
            "https://example.com",
            "kriyon-pair:1:00\nmore",
            &format!("kriyon-pair:1:{}", "0".repeat(MAX_INVITE_TEXT)),
        ] {
            assert!(check_invite_text(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_session_id_is_the_daemons_kind() {
        assert_eq!(check_session_id("a1-b2"), Ok(()));
        for bad in ["", "../x", "a b", "a/b"] {
            assert!(check_session_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn typing_fits_one_input() {
        assert_eq!(check_input("y\r"), Ok(()));
        assert!(check_input("").is_err());
        assert!(check_input(&"x".repeat(MAX_INPUT + 1)).is_err());
    }
}
