//! The [Project note] commands: list, save and delete over the `SQLite` store.
//! A note from the webview is checked by `kriyon_core::project_notes::validate`
//! before it is written, and the checked copy is what the frontend gets back.

use kriyon_core::project_notes::{validate, ProjectNote};

use crate::store::Store;
use crate::StoreState;

/// List every [Project note], oldest first. The frontend groups them by project.
///
/// # Errors
/// Returns an error string if the database read fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn list_project_notes(store: tauri::State<'_, StoreState>) -> Result<Vec<ProjectNote>, String> {
    store
        .0
        .lock()
        .list_project_notes()
        .map_err(|e| e.to_string())
}

/// Insert or update a [Project note] and return the copy that was stored.
///
/// # Errors
/// Returns an error string for a note that fails validation, a project that
/// does not exist, or a failed database write.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn upsert_project_note(
    store: tauri::State<'_, StoreState>,
    note: ProjectNote,
) -> Result<ProjectNote, String> {
    save_note(&store.0.lock(), note)
}

/// Delete a [Project note] by id. No-op if it does not exist.
///
/// # Errors
/// Returns an error string if the database write fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn delete_project_note(store: tauri::State<'_, StoreState>, id: String) -> Result<(), String> {
    store
        .0
        .lock()
        .delete_project_note(&id)
        .map_err(|e| e.to_string())
}

/// Validate, then write. Split from the command so it is tested without Tauri.
fn save_note(store: &Store, note: ProjectNote) -> Result<ProjectNote, String> {
    let checked = validate(note).map_err(|e| e.to_string())?;
    store
        .upsert_project_note(&checked)
        .map_err(|e| e.to_string())?;
    Ok(checked)
}

#[cfg(test)]
mod tests {
    use super::save_note;
    use crate::store::{ProjectRow, Store};
    use kriyon_core::project_notes::{NoteKind, ProjectNote};

    fn store_with_project() -> Store {
        let store = Store::open_in_memory().expect("open");
        store
            .upsert_project(&ProjectRow {
                id: "p1".to_string(),
                name: "Kriyon".to_string(),
                path: "/repo".to_string(),
                color: None,
                setup_command: None,
            })
            .expect("project");
        store
    }

    fn note(text: &str) -> ProjectNote {
        ProjectNote {
            id: "n1".to_string(),
            project_id: "p1".to_string(),
            kind: NoteKind::Idea,
            text: text.to_string(),
            body: String::new(),
            done_at: Some(9),
            pinned: false,
            created_ms: 1,
            updated_ms: 1,
        }
    }

    #[test]
    fn saves_and_returns_the_checked_copy() {
        let store = store_with_project();
        let saved = save_note(&store, note("  Split view  ")).expect("save");
        assert_eq!(saved.text, "Split view");
        assert_eq!(saved.done_at, None, "an idea is never done");
        assert_eq!(store.list_project_notes().expect("list"), vec![saved]);
    }

    #[test]
    fn an_invalid_note_is_refused_and_not_written() {
        let store = store_with_project();
        let error = save_note(&store, note("   ")).expect_err("blank text");
        assert_eq!(error, "a note needs some text");
        assert_eq!(store.list_project_notes().expect("list"), vec![]);
    }

    #[test]
    fn a_note_for_an_unknown_project_is_refused() {
        let store = store_with_project();
        let orphan = ProjectNote {
            project_id: "nope".to_string(),
            ..note("Split view")
        };
        assert!(save_note(&store, orphan).is_err());
    }
}
