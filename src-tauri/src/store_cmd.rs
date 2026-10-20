//! The persistence command family: thin CRUD wrappers over the `SQLite`
//! [`crate::store::Store`] for projects, sessions, and the UI's persisted
//! layout — no policy here, just typed reads/writes behind the `StoreState`
//! mutex. [Saved prompt] CRUD lives in `prompt_cmd` instead (it also owns the
//! promote/import commands that touch `.claude/commands/*.md`, not just the
//! store), and this module has no test module of its own — the store's own
//! round-trip tests live in `crate::store`.

use crate::store::{ProjectRow, SessionRow};
use crate::StoreState;

/// Save a UI layout value (JSON) under `key`.
///
/// # Errors
/// Returns an error string if the database write fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn save_layout(
    store: tauri::State<'_, StoreState>,
    key: String,
    value_json: String,
) -> Result<(), String> {
    store
        .0
        .lock()
        .save_layout(&key, &value_json)
        .map_err(|e| e.to_string())
}

/// Load the UI layout value (JSON) stored under `key`, if any.
///
/// # Errors
/// Returns an error string if the database read fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn load_layout(
    store: tauri::State<'_, StoreState>,
    key: String,
) -> Result<Option<String>, String> {
    store.0.lock().load_layout(&key).map_err(|e| e.to_string())
}

/// Insert or update a project.
///
/// # Errors
/// Returns an error string if the database write fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn upsert_project(
    store: tauri::State<'_, StoreState>,
    project: ProjectRow,
) -> Result<(), String> {
    store
        .0
        .lock()
        .upsert_project(&project)
        .map_err(|e| e.to_string())
}

/// List all persisted projects.
///
/// # Errors
/// Returns an error string if the database read fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn list_projects(store: tauri::State<'_, StoreState>) -> Result<Vec<ProjectRow>, String> {
    store.0.lock().list_projects().map_err(|e| e.to_string())
}

/// Insert or update a session.
///
/// # Errors
/// Returns an error string if the database write fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn upsert_session(
    store: tauri::State<'_, StoreState>,
    session: SessionRow,
) -> Result<(), String> {
    store
        .0
        .lock()
        .upsert_session(&session)
        .map_err(|e| e.to_string())
}

/// List all persisted sessions, ordered by creation time.
///
/// # Errors
/// Returns an error string if the database read fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn list_sessions(store: tauri::State<'_, StoreState>) -> Result<Vec<SessionRow>, String> {
    store.0.lock().list_sessions().map_err(|e| e.to_string())
}

/// Delete a persisted session row by id.
///
/// # Errors
/// Returns an error string if the database write fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn delete_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    id: String,
) -> Result<(), String> {
    store
        .0
        .lock()
        .delete_session(&id)
        .map_err(|e| e.to_string())?;
    // What Kriyon logged about it goes too: activity, spool, usage snapshot.
    if kriyon_core::daemon::is_valid_session_id(&id) {
        if let Err(e) =
            crate::activity_rt::forget_session(&crate::commands::resolve_home(&app)?, &id)
        {
            eprintln!("kriyon: could not forget session {id}'s activity: {e}");
        }
    }
    Ok(())
}
