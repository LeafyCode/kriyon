//! [Chosen folder]s: the folders the person picked in a native folder dialog
//! that the Rust core ran itself, so the webview cannot add one (ADR-0058).
//! The store commands accept a new project folder only when it is one of them
//! or the home folder.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

use kriyon_core::folder::{check_folder, CheckedFolder, FolderRefusal};
use kriyon_core::paths::Canonical as _;

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

/// The worktrees Kriyon made this run, by the project folder they were made
/// from: approved for that project's sessions without asking git (see
/// `store_cmd::check_session_row`). In memory only: once a session is saved
/// in one, its saved row approves it.
#[derive(Default)]
pub struct MadeWorktrees(Mutex<Vec<(String, PathBuf)>>);

impl MadeWorktrees {
    /// Record that a worktree was made at `path` from the repository `repo`.
    pub fn note(&self, repo: &str, path: &Path) {
        self.0.lock().push((repo.to_string(), path.to_path_buf()));
    }

    /// The worktrees made from `repo`.
    #[must_use]
    pub fn of(&self, repo: &str) -> Vec<PathBuf> {
        self.0
            .lock()
            .iter()
            .filter(|(from, _)| from == repo)
            .map(|(_, path)| path.clone())
            .collect()
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

/// Every directory the composer is allowed to touch: each persisted project
/// root, session cwd, and session worktree path, canonicalized (entries whose
/// path no longer resolves are dropped). The IPC trust-boundary allowlist that
/// [`validate_cwd`] checks a frontend-supplied `cwd` against.
pub(crate) fn known_roots(store: &StoreState) -> Vec<PathBuf> {
    // The store lock is scoped to the queries alone. Canonicalizing is one
    // `realpath` syscall per root, and this runs on every `@`-mention keystroke
    // (via `list_files`) — holding the mutex across that loop parked every
    // main-thread store command (`list_sessions`, `save_layout`,
    // `session_snapshots`, the tray poll) behind a pile of filesystem calls.
    let roots: Vec<PathBuf> = {
        let store = store.0.lock();
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Ok(projects) = store.list_projects() {
            roots.extend(projects.into_iter().map(|p| PathBuf::from(p.path)));
        }
        if let Ok(sessions) = store.list_sessions() {
            for s in sessions {
                roots.push(PathBuf::from(s.cwd));
                if let Some(w) = s.worktree_path {
                    roots.push(PathBuf::from(w));
                }
            }
        }
        roots
    };
    roots
        .into_iter()
        .filter_map(|r| r.canonical().ok())
        .collect()
}

/// Validate a frontend-supplied `cwd` before any filesystem walk or process
/// spawn: it must be a [Checked folder] inside one of the [Approved root]s
/// ([`known_roots`]). Returns the canonical path so callers act on the
/// resolved directory, never the raw string. This enforces the AGENTS.md IPC
/// trust-boundary rule — never walk or spawn in a blindly-trusted path.
///
/// # Errors
/// `cwd is not valid UTF-8`; `cwd is not absolute`; `cwd has a '.' or '..'
/// part`; `cwd is not a directory` when the path does not resolve to a
/// directory; `cwd is not a known session or project root` when it resolves
/// but falls outside every approved root.
pub(crate) fn validate_cwd(store: &StoreState, cwd: &Path) -> Result<PathBuf, String> {
    let raw = cwd
        .to_str()
        .ok_or_else(|| "cwd is not valid UTF-8".to_string())?;
    check_folder(raw, &known_roots(store))
        .map(CheckedFolder::into_canonical)
        .map_err(|refusal| cwd_refusal_message(&refusal).to_string())
}

/// The `cwd`-worded message for each [`FolderRefusal`]. The last two are the
/// strings these commands have always returned.
fn cwd_refusal_message(refusal: &FolderRefusal) -> &'static str {
    match refusal {
        FolderRefusal::NotAbsolute => "cwd is not absolute",
        FolderRefusal::NotNormal => "cwd has a '.' or '..' part",
        FolderRefusal::NotADirectory => "cwd is not a directory",
        // `OutsideApprovedRoots`, plus the other rules' refusals, which
        // `check_folder` never returns.
        _ => "cwd is not a known session or project root",
    }
}

/// A project's folder, as [`project_folder`] finds it.
#[derive(Debug)]
pub enum ProjectFolderCheck {
    /// The project is saved and its folder passes the check.
    Approved(kriyon_core::folder::CheckedFolder),
    /// The project is saved, but its folder fails the check.
    NotAllowed(FolderRefusal),
    NoSuchProject,
}

/// The folder of the saved project `project_id`, checked against the
/// [Approved root]s: what a remote start asks before it starts anything.
///
/// # Errors
/// When the store cannot be read.
pub fn project_folder(store: &StoreState, project_id: &str) -> Result<ProjectFolderCheck, String> {
    let project = store
        .0
        .lock()
        .project_row(project_id)
        .map_err(|e| e.to_string())?;
    let Some(project) = project else {
        return Ok(ProjectFolderCheck::NoSuchProject);
    };
    Ok(match check_folder(&project.path, &known_roots(store)) {
        Ok(folder) => ProjectFolderCheck::Approved(folder),
        Err(refusal) => ProjectFolderCheck::NotAllowed(refusal),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_project_root(path: &str) -> StoreState {
        let store = crate::store::Store::open_in_memory().unwrap();
        store
            .upsert_project(&crate::store::ProjectRow {
                id: "p1".into(),
                name: "proj".into(),
                path: path.to_string(),
                color: None,
                setup_command: None,
                pinned_at: None,
                folder_id: None,
            })
            .unwrap();
        StoreState(Mutex::new(store))
    }

    #[test]
    fn validate_cwd_accepts_a_known_root_and_its_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonical().unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        let state = store_with_project_root(&root.to_string_lossy());

        assert_eq!(validate_cwd(&state, &root).unwrap(), root);
        assert_eq!(
            validate_cwd(&state, &root.join("sub")).unwrap(),
            root.join("sub").canonical().unwrap()
        );
    }

    #[test]
    fn validate_cwd_rejects_a_dir_outside_every_known_root() {
        // A real, existing directory that was never registered as a root.
        let outside = tempfile::tempdir().unwrap();
        let registered = tempfile::tempdir().unwrap();
        let state = store_with_project_root(&registered.path().to_string_lossy());
        let err = validate_cwd(&state, outside.path()).unwrap_err();
        assert_eq!(err, "cwd is not a known session or project root");
    }

    #[test]
    fn validate_cwd_rejects_a_dot_dot_spelling_even_inside_a_known_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonical().unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        let state = store_with_project_root(&root.to_string_lossy());
        let err = validate_cwd(&state, &root.join("sub/..")).unwrap_err();
        assert_eq!(err, "cwd has a '.' or '..' part");
    }

    // A path that isn't UTF-8 is made from raw bytes, which only Unix allows.
    #[cfg(unix)]
    #[test]
    fn validate_cwd_names_a_non_utf8_path_for_what_it_is() {
        use std::os::unix::ffi::OsStrExt as _;
        let state = store_with_project_root("/tmp");
        let raw = std::ffi::OsStr::from_bytes(b"/tmp/\xff");
        let err = validate_cwd(&state, Path::new(raw)).unwrap_err();
        assert_eq!(err, "cwd is not valid UTF-8");
    }

    #[test]
    fn validate_cwd_rejects_a_relative_path() {
        let state = store_with_project_root("/tmp");
        let err = validate_cwd(&state, Path::new("tmp")).unwrap_err();
        assert_eq!(err, "cwd is not absolute");
    }

    #[test]
    fn validate_cwd_rejects_a_nonexistent_path() {
        let state = store_with_project_root("/tmp");
        let err = validate_cwd(&state, Path::new("/no/such/dir/anywhere")).unwrap_err();
        assert_eq!(err, "cwd is not a directory");
    }

    #[test]
    fn a_projects_folder_is_approved_missing_or_not_a_project() {
        let project = tempfile::tempdir().unwrap();
        let store = store_with_project(project.path());
        assert!(matches!(
            project_folder(&store, "p"),
            Ok(ProjectFolderCheck::Approved(folder))
                if folder.canonical() == project.path().canonical().unwrap()
        ));
        assert!(matches!(
            project_folder(&store, "nope"),
            Ok(ProjectFolderCheck::NoSuchProject)
        ));
        let gone = store_with_project(Path::new("/no/such/folder"));
        assert!(matches!(
            project_folder(&gone, "p"),
            Ok(ProjectFolderCheck::NotAllowed(FolderRefusal::NotADirectory))
        ));
    }

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
