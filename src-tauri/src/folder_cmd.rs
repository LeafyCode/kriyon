//! [Chosen folder]s: the folders the person picked in a native folder dialog
//! that the Rust core ran itself, so the webview cannot add one (ADR-0058).
//! The store commands accept a new project folder only when it is one of them
//! or the home folder.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

use crate::StoreState;

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

/// The linked worktrees of the repository at `project_folder`, as git lists
/// them; none when it is not a repository or git fails.
pub(crate) fn project_worktrees(project_folder: &str) -> Vec<PathBuf> {
    crate::git_run::GitRun::new(project_folder)
        .args(["worktree", "list", "--porcelain"])
        .text()
        .map(|out| kriyon_core::folder::parse_linked_worktrees(&out))
        .unwrap_or_default()
}

/// Refuse `repo` unless it is a saved project's folder, spelled as saved: the
/// only repository a worktree may be made from or set up for. As saved, not
/// merely the same folder, because the default worktree location is built
/// from this spelling.
fn check_project_repo(store: &StoreState, repo: &str) -> Result<(), String> {
    let saved = store
        .0
        .lock()
        .list_projects()
        .map_err(|e| e.to_string())?
        .into_iter()
        .any(|p| p.path == repo);
    if saved {
        Ok(())
    } else {
        Err("repo_path is not a saved project's folder".to_string())
    }
}

/// Refuse a new worktree of `repo` at `path` unless `repo` is a saved
/// project's folder and `path` is where a new worktree may go (see
/// `kriyon_core::folder::check_new_worktree_path`).
pub(crate) fn check_new_worktree(
    store: &StoreState,
    chosen: &ChosenFolders,
    repo: &str,
    path: &str,
) -> Result<(), String> {
    check_project_repo(store, repo)?;
    let picked = chosen.0.lock().clone();
    kriyon_core::folder::check_new_worktree_path(repo, path, &picked)
        .map_err(|refusal| format!("path: {refusal}"))
}

/// Refuse a [Worktree bootstrap] unless `repo` is a saved project's folder and
/// `worktree` is one of its linked worktrees (see
/// `kriyon_core::folder::check_worktree_to_set_up`): setup copies `.env` files
/// out of `repo` and runs install scripts in `worktree`.
pub(crate) fn check_worktree_setup(
    store: &StoreState,
    repo: &str,
    worktree: &str,
) -> Result<(), String> {
    check_project_repo(store, repo)?;
    kriyon_core::folder::check_worktree_to_set_up(repo, worktree, &project_worktrees(repo))
        .map(|_| ())
        .map_err(|refusal| format!("worktree_path: {refusal}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_project(path: &Path) -> StoreState {
        let store = crate::store::Store::open_in_memory().unwrap();
        store
            .upsert_project(&crate::store::ProjectRow {
                id: "p".into(),
                name: "proj".into(),
                path: path.to_string_lossy().into_owned(),
                color: None,
                setup_command: None,
                pinned_at: None,
                folder_id: None,
            })
            .unwrap();
        StoreState(Mutex::new(store))
    }

    fn s(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    /// A repo with one commit and one linked worktree (needs git).
    fn repo_with_worktree() -> (tempfile::TempDir, tempfile::TempDir, PathBuf) {
        let repo = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let got = crate::git_run::GitRun::new(repo.path())
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
        git(&["worktree", "add", "-q", "-b", "feature", s(&wt)]);
        (repo, parent, wt)
    }

    #[test]
    fn a_worktree_of_a_repo_that_is_no_saved_project_is_refused() {
        let project = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let store = store_with_project(project.path());
        let repo = s(other.path());
        let err = check_new_worktree(
            &store,
            &ChosenFolders::default(),
            repo,
            &kriyon_core::bootstrap::worktree_path_for(repo, "x"),
        )
        .unwrap_err();
        assert_eq!(err, "repo_path is not a saved project's folder");
    }

    #[test]
    fn a_new_worktree_goes_next_to_a_saved_project_or_in_a_chosen_folder() {
        let project = tempfile::tempdir().unwrap();
        let store = store_with_project(project.path());
        let repo = s(project.path());
        let chosen = ChosenFolders::default();
        check_new_worktree(
            &store,
            &chosen,
            repo,
            &kriyon_core::bootstrap::worktree_path_for(repo, "x"),
        )
        .unwrap();
        let picked = tempfile::tempdir().unwrap();
        let err =
            check_new_worktree(&store, &chosen, repo, s(&picked.path().join("x"))).unwrap_err();
        assert_eq!(err, "path: not a place a new worktree may go");
        chosen.admit(picked.path().to_path_buf());
        check_new_worktree(&store, &chosen, repo, s(&picked.path().join("x"))).unwrap();
    }

    #[test]
    fn setup_runs_only_in_a_linked_worktree_of_a_saved_project() {
        let (repo, _parent, wt) = repo_with_worktree();
        let store = store_with_project(repo.path());
        check_worktree_setup(&store, s(repo.path()), s(&wt)).unwrap();
        // The main checkout is not a worktree to set up: copying its `.env`
        // files onto themselves would empty them.
        assert_eq!(
            check_worktree_setup(&store, s(repo.path()), s(repo.path())).unwrap_err(),
            "worktree_path: folder is not one of the project's linked worktrees"
        );
        let elsewhere = tempfile::tempdir().unwrap();
        assert_eq!(
            check_worktree_setup(&store, s(repo.path()), s(elsewhere.path())).unwrap_err(),
            "worktree_path: folder is not one of the project's linked worktrees"
        );
    }

    #[test]
    fn setup_for_a_repo_that_is_no_saved_project_is_refused() {
        let (repo, _parent, wt) = repo_with_worktree();
        let store = store_with_project(Path::new("/somewhere/else"));
        assert_eq!(
            check_worktree_setup(&store, s(repo.path()), s(&wt)).unwrap_err(),
            "repo_path is not a saved project's folder"
        );
    }
}
