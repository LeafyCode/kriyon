//! The [Project note] commands: list, save and delete over the `SQLite` store.
//! A note from the webview is checked by `kriyon_core::project_notes::validate`
//! before it is written, and the checked copy is what the frontend gets back.

use kriyon_core::project_notes::{check_owner, validate, ProjectNote};

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

/// Insert or update a [Project note] and return the row as stored.
///
/// # Errors
/// Returns an error string for a note that fails validation, an id that
/// belongs to another project's note, a project that does not exist, or a
/// failed database write.
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

/// Validate, check the id is not another project's note, write, and read the
/// row back — an update keeps the stored project and creation time, so the
/// caller must get the row, not what it sent. Split from the command so it is
/// tested without Tauri; the caller holds the store lock across all of it.
fn save_note(store: &Store, note: ProjectNote) -> Result<ProjectNote, String> {
    let checked = validate(note).map_err(|e| e.to_string())?;
    let stored = store.project_note(&checked.id).map_err(|e| e.to_string())?;
    check_owner(stored.as_ref().map(|n| n.project_id.as_str()), &checked)
        .map_err(|e| e.to_string())?;
    store
        .upsert_project_note(&checked)
        .map_err(|e| e.to_string())?;
    store
        .project_note(&checked.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "note was not saved".to_string())
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
                pinned_at: None,
                folder_id: None,
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
    fn saves_and_returns_the_stored_row() {
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
    fn an_update_returns_the_row_as_stored() {
        let store = store_with_project();
        save_note(&store, note("Split view")).expect("insert");
        let edited = ProjectNote {
            created_ms: 999,
            ..note("Split view, side by side")
        };
        let saved = save_note(&store, edited).expect("update");
        assert_eq!(saved.text, "Split view, side by side");
        assert_eq!(saved.created_ms, 1, "an update never changes created_ms");
        assert_eq!(store.list_project_notes().expect("list"), vec![saved]);
    }

    #[test]
    fn an_id_stored_under_another_project_is_refused() {
        let store = store_with_project();
        store
            .upsert_project(&ProjectRow {
                id: "p2".to_string(),
                name: "Other".to_string(),
                path: "/other".to_string(),
                color: None,
                setup_command: None,
                pinned_at: None,
                folder_id: None,
            })
            .expect("second project");
        let original = save_note(&store, note("Split view")).expect("insert");
        let hijack = ProjectNote {
            project_id: "p2".to_string(),
            ..note("Overwritten")
        };
        let error = save_note(&store, hijack).expect_err("other project's id");
        assert_eq!(error, "this note belongs to another project");
        assert_eq!(store.list_project_notes().expect("list"), vec![original]);
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
