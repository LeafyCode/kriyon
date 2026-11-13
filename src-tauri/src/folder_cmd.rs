//! [Chosen folder]s: the folders the person picked in a native folder dialog
//! that the Rust core ran itself, so the webview cannot add one (ADR-0058).
//! The store commands accept a new project folder only when it is one of them
//! or the home folder.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

/// The folders picked this run through [`pick_folder`]. In memory only: once a
/// picked folder is saved as a project, its saved row is what approves it.
#[derive(Default)]
pub struct ChosenFolders(Mutex<Vec<PathBuf>>);

impl ChosenFolders {
    /// Record a folder the person picked.
    pub fn admit(&self, folder: PathBuf) {
        let mut chosen = self.0.lock();
        if !chosen.contains(&folder) {
            chosen.push(folder);
        }
    }

    /// Every [Chosen folder]: the ones picked this run, and the home folder
    /// (the Home project's).
    #[must_use]
    pub fn with_home(&self, home: &Path) -> Vec<PathBuf> {
        let mut chosen = self.0.lock().clone();
        chosen.push(home.to_path_buf());
        chosen
    }
}

/// Open the native folder picker and return what the person chose, recorded
/// as a [Chosen folder]. `None` when they cancelled.
///
/// # Errors
/// When the picker could not be run, or the chosen path is not UTF-8.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri::Manager as _;
    use tauri_plugin_dialog::DialogExt as _;
    let dialog = app.dialog().file().set_title("Choose a folder");
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    let Some(folder) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let text = folder
        .to_str()
        .ok_or_else(|| "folder path is not valid UTF-8".to_string())?
        .to_string();
    app.state::<ChosenFolders>().admit(folder);
    Ok(Some(text))
}
