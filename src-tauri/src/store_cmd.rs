//! The persistence command family: thin CRUD wrappers over the `SQLite`
//! [`crate::store::Store`] for projects, sessions, and the UI's persisted
//! layout, typed reads/writes behind the `StoreState` mutex. [Saved prompt]
//! CRUD lives in `prompt_cmd` instead (it also owns the promote/import
//! commands that touch `.claude/commands/*.md`, not just the store); the
//! store's own round-trip tests live in `crate::store`.
//!
//! One rule is enforced here: a saved project or session folder becomes an
//! [Approved root], so a project or session row is saved only when its folders
//! pass the checks in `kriyon_core::folder` (ADR-0058).

use std::path::Path;

use crate::folder_cmd::ChosenFolders;
use crate::store::{ProjectRow, SessionRow};
use crate::StoreState;

/// Refuse `project` unless its folder is the one it was saved with, or a
/// [Chosen folder] (see `kriyon_core::folder::check_project_path`).
fn check_project_row(
    store: &StoreState,
    chosen: &ChosenFolders,
    home: &Path,
    project: &ProjectRow,
) -> Result<(), String> {
    let saved = store
        .0
        .lock()
        .project_row(&project.id)
        .map_err(|e| e.to_string())?
        .map(|p| p.path);
    kriyon_core::folder::check_project_path(
        &project.path,
        saved.as_deref(),
        &chosen.with_home(home),
    )
    .map_err(|refusal| format!("project folder: {refusal}"))
}

/// Refuse `session` unless its project is saved and each of its folders is
/// the one it was saved with, or exactly the project's folder or one of the
/// project repository's linked worktrees (see
/// `kriyon_core::folder::check_session_path`).
fn check_session_row(store: &StoreState, session: &SessionRow) -> Result<(), String> {
    // Read both rows, then let the lock go: the checks touch the disk, and
    // may run git.
    let (project, saved) = {
        let store = store.0.lock();
        let project = store
            .project_row(&session.project_id)
            .map_err(|e| e.to_string())?;
        let saved = store.session_row(&session.id).map_err(|e| e.to_string())?;
        (project, saved)
    };
    let project = project.ok_or_else(|| "session's project is not saved".to_string())?;
    let project_folder = Path::new(&project.path);
    let worktrees = || crate::folder_cmd::project_worktrees(&project.path);
    kriyon_core::folder::check_session_path(
        &session.cwd,
        saved.as_ref().map(|s| s.cwd.as_str()),
        project_folder,
        worktrees,
    )
    .map_err(|refusal| format!("session folder: {refusal}"))?;
    // A worktree session's `cwd` is its worktree: checked once, git run once.
    if let Some(worktree) = session
        .worktree_path
        .as_ref()
        .filter(|w| **w != session.cwd)
    {
        kriyon_core::folder::check_session_path(
            worktree,
            saved.as_ref().and_then(|s| s.worktree_path.as_deref()),
            project_folder,
            worktrees,
        )
        .map_err(|refusal| format!("session worktree: {refusal}"))?;
    }
    Ok(())
}

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

/// Insert or update a project. Its folder must be the one it was saved with,
/// or a [Chosen folder] (ADR-0058).
///
/// # Errors
/// Returns an error string if the folder is refused or the database write
/// fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn upsert_project(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    chosen: tauri::State<'_, ChosenFolders>,
    project: ProjectRow,
) -> Result<(), String> {
    let home = crate::commands::resolve_home(&app)?;
    check_project_row(&store, &chosen, &home, &project)?;
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

/// Insert or update a session. Its project must be saved, and its folders
/// must be the project's folder or one of its worktrees (ADR-0058).
///
/// # Errors
/// Returns an error string if a folder is refused or the database write
/// fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn upsert_session(
    store: tauri::State<'_, StoreState>,
    session: SessionRow,
) -> Result<(), String> {
    check_session_row(&store, &session)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_store() -> StoreState {
        StoreState(parking_lot::Mutex::new(
            crate::store::Store::open_in_memory().unwrap(),
        ))
    }

    fn project(id: &str, path: &Path) -> ProjectRow {
        ProjectRow {
            id: id.into(),
            name: "proj".into(),
            path: path.to_string_lossy().into_owned(),
            color: None,
            setup_command: None,
            pinned_at: None,
            folder_id: None,
        }
    }

    fn session(project_id: &str, cwd: &Path, worktree: Option<&Path>) -> SessionRow {
        SessionRow {
            id: "s1".into(),
            project_id: project_id.into(),
            title: "t".into(),
            cwd: cwd.to_string_lossy().into_owned(),
            worktree_path: worktree.map(|w| w.to_string_lossy().into_owned()),
            created_at: 0,
            claude_session_id: None,
            archived_at: None,
            baseline_oid: None,
            title_locked: false,
            nested_under: None,
            parent_session_id: None,
            parked_at: None,
            pinned_at: None,
        }
    }

    fn saved(store: &StoreState, p: &ProjectRow) {
        store.0.lock().upsert_project(p).unwrap();
    }

    #[test]
    fn a_new_project_in_a_folder_nobody_chose_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let err = check_project_row(
            &empty_store(),
            &ChosenFolders::default(),
            home.path(),
            &project("p", folder.path()),
        )
        .unwrap_err();
        assert_eq!(
            err,
            "project folder: folder was not chosen on this computer"
        );
    }

    #[test]
    fn a_new_project_in_a_picked_folder_is_saved() {
        let home = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let chosen = ChosenFolders::default();
        chosen.admit(folder.path().to_path_buf());
        check_project_row(
            &empty_store(),
            &chosen,
            home.path(),
            &project("p", folder.path()),
        )
        .unwrap();
    }

    #[test]
    fn the_home_project_is_saved_but_a_folder_under_home_is_not() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("code")).unwrap();
        let chosen = ChosenFolders::default();
        let store = empty_store();
        check_project_row(
            &store,
            &chosen,
            home.path(),
            &project("default", home.path()),
        )
        .unwrap();
        assert!(check_project_row(
            &store,
            &chosen,
            home.path(),
            &project("p", &home.path().join("code"))
        )
        .is_err());
    }

    #[test]
    fn a_saved_project_saves_again_once_its_folder_is_gone() {
        let home = tempfile::tempdir().unwrap();
        let gone = home.path().join("gone");
        let store = empty_store();
        saved(&store, &project("p", &gone));
        check_project_row(
            &store,
            &ChosenFolders::default(),
            home.path(),
            &project("p", &gone),
        )
        .unwrap();
    }

    #[test]
    fn a_session_whose_project_is_not_saved_is_refused() {
        let folder = tempfile::tempdir().unwrap();
        let err =
            check_session_row(&empty_store(), &session("p", folder.path(), None)).unwrap_err();
        assert_eq!(err, "session's project is not saved");
    }

    #[test]
    fn a_session_in_its_project_folder_is_saved_and_one_elsewhere_is_not() {
        let folder = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let store = empty_store();
        saved(&store, &project("p", folder.path()));
        check_session_row(&store, &session("p", folder.path(), None)).unwrap();
        assert_eq!(
            check_session_row(&store, &session("p", elsewhere.path(), None)).unwrap_err(),
            "session folder: folder is not the project's folder or one of its worktrees"
        );
    }

    #[test]
    fn a_home_session_cannot_approve_a_folder_under_home() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".ssh")).unwrap();
        let store = empty_store();
        saved(&store, &project("default", home.path()));
        assert!(
            check_session_row(&store, &session("default", &home.path().join(".ssh"), None))
                .is_err()
        );
    }

    #[test]
    fn a_worktree_session_needs_both_folders_approved() {
        let folder = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let store = empty_store();
        saved(&store, &project("p", folder.path()));
        assert_eq!(
            check_session_row(&store, &session("p", folder.path(), Some(elsewhere.path())))
                .unwrap_err(),
            "session worktree: folder is not the project's folder or one of its worktrees"
        );
    }

    #[test]
    fn a_session_in_a_git_worktree_of_its_project_is_saved() {
        let repo_dir = tempfile::tempdir().unwrap();
        let repo = repo_dir.path().to_str().unwrap();
        let git = |args: &[&str]| {
            let got = crate::git_run::GitRun::new(repo)
                .args(args)
                .outcome()
                .unwrap();
            assert!(got.success, "git {args:?}: {}", got.stderr);
        };
        git(&["init", "-q"]);
        git(&[
            "-c",
            "user.email=t@e",
            "-c",
            "user.name=T",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "i",
        ]);
        let parent = tempfile::tempdir().unwrap();
        let wt = parent.path().join("feature");
        git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            wt.to_str().unwrap(),
        ]);
        let store = empty_store();
        saved(&store, &project("p", repo_dir.path()));
        check_session_row(&store, &session("p", &wt, Some(&wt))).unwrap();
    }

    #[test]
    fn a_saved_session_saves_again_once_its_worktree_is_gone() {
        let folder = tempfile::tempdir().unwrap();
        let gone = std::path::PathBuf::from("/no/such/worktree");
        let store = empty_store();
        saved(&store, &project("p", folder.path()));
        store
            .0
            .lock()
            .upsert_session(&session("p", &gone, Some(&gone)))
            .unwrap();
        check_session_row(&store, &session("p", &gone, Some(&gone))).unwrap();
    }
}
