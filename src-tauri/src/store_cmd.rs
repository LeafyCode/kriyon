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

use crate::folder_cmd::{ChosenFolders, MadeWorktrees};
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
fn check_session_row(
    store: &StoreState,
    made: &MadeWorktrees,
    session: &SessionRow,
) -> Result<(), String> {
    // Read the rows, then let the lock go: the checks touch the disk.
    let (project, saved, others) = {
        let store = store.0.lock();
        let project = store
            .project_row(&session.project_id)
            .map_err(|e| e.to_string())?;
        let saved = store.session_row(&session.id).map_err(|e| e.to_string())?;
        let others = store.list_sessions().map_err(|e| e.to_string())?;
        (project, saved, others)
    };
    let project = project.ok_or_else(|| "session's project is not saved".to_string())?;
    let project_folder = Path::new(&project.path);
    // The worktrees this session may be saved in: those Kriyon made from this
    // project this run, and those its other sessions saved (a nested session
    // starts in its lead's). Never git: this command runs on the main thread.
    // Every worktree the app makes is one of these, or already saved for this
    // row; a worktree made outside Kriyon becomes a project of its own.
    let mut known = made.of(&project.path);
    known.extend(
        others
            .into_iter()
            .filter(|other| other.project_id == project.id && other.id != session.id)
            .filter_map(|other| other.worktree_path.map(std::path::PathBuf::from)),
    );
    let check = |path: &str, saved: Option<&str>| {
        kriyon_core::folder::check_session_path(path, saved, project_folder, || known.clone())
    };
    check(&session.cwd, saved.as_ref().map(|s| s.cwd.as_str()))
        .map_err(|refusal| format!("session folder: {refusal}"))?;
    // A worktree session's `cwd` is its worktree: checked once, git run once.
    if let Some(worktree) = session
        .worktree_path
        .as_ref()
        .filter(|w| **w != session.cwd)
    {
        check(
            worktree,
            saved.as_ref().and_then(|s| s.worktree_path.as_deref()),
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
        .map_err(|e| e.to_string())?;
    projects_changed(&app);
    Ok(())
}

/// Tell remote devices the project list may have changed, off the main
/// thread (it checks every project's folder).
fn projects_changed(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    if let Some(serve) = app.try_state::<kriyon_remote_link::host_runtime::Serve>() {
        let serve = serve.inner().clone();
        tauri::async_runtime::spawn_blocking(move || serve.projects_changed());
    }
}

/// Save a session's rows, its project's first when given, each through the
/// same checks as [`upsert_project`] and [`upsert_session`]: what every start
/// does before its shell opens, since the shell's folder must be one a saved
/// row approves (ADR-0058).
///
/// # Errors
/// A folder refused, or a database write that failed.
pub(crate) fn save_rows(
    app: &tauri::AppHandle,
    project: Option<&ProjectRow>,
    session: &SessionRow,
) -> Result<(), String> {
    use tauri::Manager as _;
    let store = app.state::<StoreState>();
    if let Some(project) = project {
        let home = crate::commands::resolve_home(app)?;
        check_project_row(&store, &app.state::<ChosenFolders>(), &home, project)?;
        store
            .0
            .lock()
            .upsert_project(project)
            .map_err(|e| e.to_string())?;
    }
    check_session_row(&store, &app.state::<MadeWorktrees>(), session)?;
    let saved = store
        .0
        .lock()
        .upsert_session(session)
        .map_err(|e| e.to_string());
    saved
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
    made: tauri::State<'_, MadeWorktrees>,
    session: SessionRow,
) -> Result<(), String> {
    check_session_row(&store, &made, &session)?;
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
        let err = check_session_row(
            &empty_store(),
            &MadeWorktrees::default(),
            &session("p", folder.path(), None),
        )
        .unwrap_err();
        assert_eq!(err, "session's project is not saved");
    }

    #[test]
    fn a_session_in_its_project_folder_is_saved_and_one_elsewhere_is_not() {
        let folder = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let store = empty_store();
        saved(&store, &project("p", folder.path()));
        check_session_row(
            &store,
            &MadeWorktrees::default(),
            &session("p", folder.path(), None),
        )
        .unwrap();
        assert_eq!(
            check_session_row(
                &store,
                &MadeWorktrees::default(),
                &session("p", elsewhere.path(), None)
            )
            .unwrap_err(),
            "session folder: folder is not the project's folder or one of its worktrees"
        );
    }

    #[test]
    fn a_home_session_cannot_approve_a_folder_under_home() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".ssh")).unwrap();
        let store = empty_store();
        saved(&store, &project("default", home.path()));
        assert!(check_session_row(
            &store,
            &MadeWorktrees::default(),
            &session("default", &home.path().join(".ssh"), None)
        )
        .is_err());
    }

    #[test]
    fn a_worktree_session_needs_both_folders_approved() {
        let folder = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let store = empty_store();
        saved(&store, &project("p", folder.path()));
        assert_eq!(
            check_session_row(
                &store,
                &MadeWorktrees::default(),
                &session("p", folder.path(), Some(elsewhere.path()))
            )
            .unwrap_err(),
            "session worktree: folder is not the project's folder or one of its worktrees"
        );
    }

    #[test]
    fn a_worktree_only_git_knows_is_not_approved_on_the_main_thread() {
        // This command runs on the main thread, so it never asks git: a worktree
        // made outside Kriyon becomes a project of its own instead.
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
        assert!(check_session_row(
            &store,
            &MadeWorktrees::default(),
            &session("p", &wt, Some(&wt)),
        )
        .is_err());
    }

    #[test]
    fn a_worktree_kriyon_made_this_run_needs_no_git_to_approve() {
        // A plain folder git would never list: only the record approves it.
        let folder = tempfile::tempdir().unwrap();
        let worktree = tempfile::tempdir().unwrap();
        let store = empty_store();
        saved(&store, &project("p", folder.path()));
        let made = MadeWorktrees::default();
        made.note(folder.path().to_str().unwrap(), worktree.path());
        check_session_row(
            &store,
            &made,
            &session("p", worktree.path(), Some(worktree.path())),
        )
        .unwrap();
        // Recorded for another project, it approves nothing here.
        let other = MadeWorktrees::default();
        other.note("/elsewhere", worktree.path());
        assert!(check_session_row(&store, &other, &session("p", worktree.path(), None)).is_err());
    }

    #[test]
    fn a_worktree_another_session_of_the_project_saved_needs_no_git() {
        // A nested session starts in its lead's worktree.
        let folder = tempfile::tempdir().unwrap();
        let worktree = tempfile::tempdir().unwrap();
        let store = empty_store();
        saved(&store, &project("p", folder.path()));
        let lead = SessionRow {
            id: "lead".into(),
            ..session("p", worktree.path(), Some(worktree.path()))
        };
        store.0.lock().upsert_session(&lead).unwrap();
        check_session_row(
            &store,
            &MadeWorktrees::default(),
            &session("p", worktree.path(), Some(worktree.path())),
        )
        .unwrap();
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
        check_session_row(
            &store,
            &MadeWorktrees::default(),
            &session("p", &gone, Some(&gone)),
        )
        .unwrap();
    }
}
