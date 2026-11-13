//! [Checked folder]: the one check a folder path from the webview passes before
//! Kriyon starts a session in it or reads anything under it (ADR-0058).
//!
//! Pure apart from the filesystem lookups it must make (`canonicalize`,
//! `metadata`): the caller supplies the [Approved root]s, so this module knows
//! nothing about the store, Tauri or where the path came from. Local commands
//! and, later, remote starts pass the same function their own list.

use std::path::{Path, PathBuf};

use crate::completion::path_within_roots;

/// Why a folder path was refused, in the order the rules are checked. The
/// `Display` text is what the person sees.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FolderRefusal {
    /// Empty or relative: a relative path would resolve against wherever the
    /// app happens to run, not anything the person chose.
    #[error("folder path is not absolute")]
    NotAbsolute,
    /// Has a `.` or `..` part. Refused even when it would land inside, so the
    /// spelling a caller later hands a shell or git can never resolve
    /// differently from the one checked here (ADR-0021).
    #[error("folder path has a '.' or '..' part")]
    NotNormal,
    /// Missing, unreadable, or not a directory.
    #[error("folder is not a directory")]
    NotADirectory,
    /// Its canonical form is not inside any approved root's canonical form.
    #[error("folder is outside every approved folder")]
    OutsideApprovedRoots,
    /// Not exactly one of the [Chosen folder]s (inside one is not enough).
    #[error("folder was not chosen on this computer")]
    NotChosen,
    /// Not exactly its project's folder or one of the project's worktrees.
    #[error("folder is not the project's folder or one of its worktrees")]
    NotProjectFolder,
    /// Not where a new worktree may go: the default sibling folder, or a
    /// [Chosen folder] under the branch's own name.
    #[error("not a place a new worktree may go")]
    NotWorktreeLocation,
}

/// A folder path that passed [`check_folder`]. Its only constructor is that
/// function, so holding one proves the check ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedFolder(PathBuf);

impl CheckedFolder {
    /// The folder's canonical form (symlinks resolved).
    #[must_use]
    pub fn canonical(&self) -> &Path {
        &self.0
    }

    /// The canonical form, owned.
    #[must_use]
    pub fn into_canonical(self) -> PathBuf {
        self.0
    }
}

/// Check a folder path from the webview against the person's [Approved root]s:
/// absolute, no `.` or `..` parts, exists, is a directory, and its canonical
/// form (every symlink resolved) is an approved root's canonical form or sits
/// inside one, compared by path parts, never a string prefix.
///
/// Approved roots are canonicalized here, so a caller may pass them as stored;
/// one that no longer resolves approves nothing. Because the canonical form is
/// what is compared, a symlink inside a root that points out of it is refused.
///
/// # Errors
/// The [`FolderRefusal`] for the first rule the path breaks.
pub fn check_folder(
    path: &str,
    approved_roots: &[PathBuf],
) -> Result<CheckedFolder, FolderRefusal> {
    check_spelling(path)?;
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|_| FolderRefusal::NotADirectory)?;
    if !canonical.is_dir() {
        return Err(FolderRefusal::NotADirectory);
    }
    let roots: Vec<PathBuf> = approved_roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .collect();
    if path_within_roots(&canonical, &roots) {
        Ok(CheckedFolder(canonical))
    } else {
        Err(FolderRefusal::OutsideApprovedRoots)
    }
}

/// Rules 1 and 2 of [`check_folder`], which need no disk: absolute, and no
/// `.` or `..` parts.
fn check_spelling(path: &str) -> Result<(), FolderRefusal> {
    if !Path::new(path).is_absolute() {
        return Err(FolderRefusal::NotAbsolute);
    }
    // `Path::components` silently drops an interior `.`, so split the string.
    if path.split('/').any(|part| part == "." || part == "..") {
        return Err(FolderRefusal::NotNormal);
    }
    Ok(())
}

/// Check that `path` is exactly one of the [Chosen folder]s, not merely
/// inside one: the folder a new [Project (Workspace)] may be saved with.
/// Inside is enough for a session, but a project must be the very folder the
/// person chose, or the home folder being chosen would approve all of it.
///
/// # Errors
/// The [`FolderRefusal`] for the first rule the path breaks; `NotChosen` when
/// it passes [`check_folder`] against `chosen` but is not one of them.
pub fn check_chosen_folder(path: &str, chosen: &[PathBuf]) -> Result<CheckedFolder, FolderRefusal> {
    let folder = check_folder(path, chosen).map_err(|refusal| match refusal {
        FolderRefusal::OutsideApprovedRoots => FolderRefusal::NotChosen,
        other => other,
    })?;
    let is_chosen = chosen
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| root == folder.canonical());
    if is_chosen {
        Ok(folder)
    } else {
        Err(FolderRefusal::NotChosen)
    }
}

/// The folder a project row may be saved with: the one it was saved with
/// before, unchecked (it was approved then, and a parked or removed project's
/// row must still save once its folder is gone), or a [Chosen folder].
///
/// # Errors
/// The [`FolderRefusal`] from [`check_chosen_folder`] for a new or changed path.
pub fn check_project_path(
    path: &str,
    saved: Option<&str>,
    chosen: &[PathBuf],
) -> Result<(), FolderRefusal> {
    if saved == Some(path) {
        return Ok(());
    }
    check_chosen_folder(path, chosen).map(|_| ())
}

/// A folder a session row may be saved with (its `cwd`, or its worktree): the
/// one it was saved with before, unchecked, or exactly its project's folder or
/// one of the project repository's linked worktrees. Exactly, not inside:
/// sessions start in one of those, and "inside" would let a session under the
/// Home project approve all of HOME. `worktrees` is asked only when the
/// project folder does not settle it, because listing them runs git.
///
/// # Errors
/// The [`FolderRefusal`] from [`check_folder`] for a new or changed path, or
/// `NotProjectFolder` when it is none of those folders.
pub fn check_session_path(
    path: &str,
    saved: Option<&str>,
    project_folder: &Path,
    worktrees: impl FnOnce() -> Vec<PathBuf>,
) -> Result<(), FolderRefusal> {
    if saved == Some(path) {
        return Ok(());
    }
    let not_project = |refusal| match refusal {
        FolderRefusal::NotChosen => FolderRefusal::NotProjectFolder,
        other => other,
    };
    match check_chosen_folder(path, &[project_folder.to_path_buf()]) {
        Err(FolderRefusal::NotChosen) => check_chosen_folder(path, &worktrees())
            .map(|_| ())
            .map_err(not_project),
        other => other.map(|_| ()).map_err(not_project),
    }
}

/// The linked worktrees `git worktree list --porcelain` names: every one but
/// the first, the main checkout, which can sit above a project kept in a
/// subfolder of its repository.
#[must_use]
pub fn parse_linked_worktrees(porcelain: &str) -> Vec<PathBuf> {
    porcelain
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .skip(1)
        .map(PathBuf::from)
        .collect()
}

/// Where a new worktree of `repo` (a saved project's folder) on `branch` may
/// be made: the default sibling folder, `<repo>-worktrees/<branch dir>`, or a
/// [Chosen folder] with the branch's directory name under it, which is how
/// the spawn dialog builds a chosen location. The path does not exist yet, so
/// only its spelling and its chosen parent are checked.
///
/// # Errors
/// `NotAbsolute` or `NotNormal` for the spelling, else `NotWorktreeLocation`.
pub fn check_new_worktree_path(
    repo: &str,
    branch: &str,
    path: &str,
    chosen: &[PathBuf],
) -> Result<(), FolderRefusal> {
    check_spelling(path)?;
    if path == crate::bootstrap::worktree_path_for(repo, branch) {
        return Ok(());
    }
    let path = Path::new(path);
    let named_for_branch = path
        .file_name()
        .is_some_and(|leaf| *leaf == *crate::bootstrap::sanitize_branch_dir(branch));
    let parent_chosen = path
        .parent()
        .and_then(Path::to_str)
        .is_some_and(|parent| check_chosen_folder(parent, chosen).is_ok());
    if named_for_branch && parent_chosen {
        Ok(())
    } else {
        Err(FolderRefusal::NotWorktreeLocation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canon(p: &Path) -> PathBuf {
        p.canonicalize().expect("canonicalize")
    }

    fn approved(dir: &tempfile::TempDir) -> Vec<PathBuf> {
        vec![dir.path().to_path_buf()]
    }

    fn s(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    #[test]
    fn an_approved_root_itself_passes_as_its_canonical_form() {
        let root = tempfile::tempdir().unwrap();
        let folder = check_folder(s(root.path()), &approved(&root)).unwrap();
        assert_eq!(folder.canonical(), canon(root.path()));
    }

    #[test]
    fn a_folder_inside_an_approved_root_passes() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("a/b")).unwrap();
        let folder = check_folder(s(&root.path().join("a/b")), &approved(&root)).unwrap();
        assert_eq!(folder.canonical(), canon(root.path()).join("a/b"));
    }

    #[test]
    fn a_folder_outside_every_approved_root_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let err = check_folder(s(elsewhere.path()), &approved(&root)).unwrap_err();
        assert_eq!(err, FolderRefusal::OutsideApprovedRoots);
    }

    #[test]
    fn no_approved_roots_refuses_everything() {
        let dir = tempfile::tempdir().unwrap();
        let err = check_folder(s(dir.path()), &[]).unwrap_err();
        assert_eq!(err, FolderRefusal::OutsideApprovedRoots);
    }

    #[test]
    fn a_sibling_sharing_a_name_prefix_is_outside() {
        // `/x/proj2` is not inside `/x/proj`: containment is by path parts,
        // never a string prefix.
        let parent = tempfile::tempdir().unwrap();
        std::fs::create_dir(parent.path().join("proj")).unwrap();
        std::fs::create_dir(parent.path().join("proj2")).unwrap();
        let err = check_folder(
            s(&parent.path().join("proj2")),
            &[parent.path().join("proj")],
        )
        .unwrap_err();
        assert_eq!(err, FolderRefusal::OutsideApprovedRoots);
    }

    #[test]
    fn a_relative_path_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let err = check_folder("some/dir", &approved(&root)).unwrap_err();
        assert_eq!(err, FolderRefusal::NotAbsolute);
    }

    #[test]
    fn an_empty_path_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let err = check_folder("", &approved(&root)).unwrap_err();
        assert_eq!(err, FolderRefusal::NotAbsolute);
    }

    #[test]
    fn a_dot_dot_part_is_refused_even_when_it_lands_inside() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("a")).unwrap();
        let raw = format!("{}/a/..", s(root.path()));
        let err = check_folder(&raw, &approved(&root)).unwrap_err();
        assert_eq!(err, FolderRefusal::NotNormal);
    }

    #[test]
    fn a_dot_part_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let raw = format!("{}/./", s(root.path()));
        let err = check_folder(&raw, &approved(&root)).unwrap_err();
        assert_eq!(err, FolderRefusal::NotNormal);
    }

    #[test]
    fn a_missing_folder_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let err = check_folder(s(&root.path().join("gone")), &approved(&root)).unwrap_err();
        assert_eq!(err, FolderRefusal::NotADirectory);
    }

    #[test]
    fn a_file_is_refused() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("f"), "").unwrap();
        let err = check_folder(s(&root.path().join("f")), &approved(&root)).unwrap_err();
        assert_eq!(err, FolderRefusal::NotADirectory);
    }

    #[test]
    fn a_symlink_inside_a_root_that_points_outside_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = root.path().join("escape");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let err = check_folder(s(&link), &approved(&root)).unwrap_err();
        assert_eq!(err, FolderRefusal::OutsideApprovedRoots);
    }

    #[test]
    fn a_symlink_to_a_folder_inside_a_root_passes_as_its_target() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("real")).unwrap();
        let link = root.path().join("alias");
        std::os::unix::fs::symlink(root.path().join("real"), &link).unwrap();
        let folder = check_folder(s(&link), &approved(&root)).unwrap();
        assert_eq!(folder.canonical(), canon(root.path()).join("real"));
    }

    #[test]
    fn a_root_spelled_through_a_symlink_still_contains_its_folders() {
        // macOS: `/var/folders/...` is a symlink to `/private/var/...`. A root
        // saved in one spelling must contain folders given in the other.
        let real = tempfile::tempdir().unwrap();
        let links = tempfile::tempdir().unwrap();
        let root_alias = links.path().join("root");
        std::os::unix::fs::symlink(real.path(), &root_alias).unwrap();
        std::fs::create_dir(real.path().join("sub")).unwrap();
        let folder = check_folder(s(&real.path().join("sub")), &[root_alias]).unwrap();
        assert_eq!(folder.canonical(), canon(real.path()).join("sub"));
    }

    #[test]
    fn an_approved_root_that_no_longer_exists_approves_nothing() {
        let gone = tempfile::tempdir().unwrap();
        let gone_path = gone.path().to_path_buf();
        drop(gone);
        let err = check_folder("/", &[gone_path]).unwrap_err();
        assert_eq!(err, FolderRefusal::OutsideApprovedRoots);
    }

    // --- Chosen folders and saved rows ---

    #[test]
    fn a_chosen_folder_itself_passes() {
        let chosen = tempfile::tempdir().unwrap();
        let folder = check_chosen_folder(s(chosen.path()), &approved(&chosen)).unwrap();
        assert_eq!(folder.canonical(), canon(chosen.path()));
    }

    #[test]
    fn a_folder_inside_a_chosen_folder_was_not_itself_chosen() {
        // Inside is enough for a session; a project must be the very folder
        // the person picked, or choosing HOME would approve all of it.
        let chosen = tempfile::tempdir().unwrap();
        std::fs::create_dir(chosen.path().join("sub")).unwrap();
        let err =
            check_chosen_folder(s(&chosen.path().join("sub")), &approved(&chosen)).unwrap_err();
        assert_eq!(err, FolderRefusal::NotChosen);
    }

    #[test]
    fn a_chosen_folder_matches_through_a_symlinked_spelling() {
        let real = tempfile::tempdir().unwrap();
        let links = tempfile::tempdir().unwrap();
        let alias = links.path().join("alias");
        std::os::unix::fs::symlink(real.path(), &alias).unwrap();
        check_chosen_folder(s(&alias), &[real.path().to_path_buf()]).unwrap();
    }

    #[test]
    fn a_missing_folder_cannot_be_chosen() {
        let chosen = tempfile::tempdir().unwrap();
        let err =
            check_chosen_folder(s(&chosen.path().join("gone")), &approved(&chosen)).unwrap_err();
        assert_eq!(err, FolderRefusal::NotADirectory);
    }

    #[test]
    fn a_project_keeps_its_saved_folder_even_once_the_folder_is_gone() {
        // A parked or removed project's row must still save (its name, its
        // pin); its folder was approved when it was first saved.
        assert_eq!(
            check_project_path("/no/such/project", Some("/no/such/project"), &[]),
            Ok(())
        );
    }

    #[test]
    fn a_new_project_folder_must_be_chosen() {
        let chosen = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        assert_eq!(
            check_project_path(s(chosen.path()), None, &approved(&chosen)),
            Ok(())
        );
        assert_eq!(
            check_project_path(s(other.path()), None, &approved(&chosen)),
            Err(FolderRefusal::NotChosen)
        );
    }

    #[test]
    fn re_pointing_a_saved_project_is_checked_like_a_new_one() {
        let saved = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        assert_eq!(
            check_project_path(s(other.path()), Some(s(saved.path())), &[]),
            Err(FolderRefusal::NotChosen)
        );
    }

    fn no_worktrees() -> Vec<PathBuf> {
        panic!("git must not be asked when the project folder settles it")
    }

    #[test]
    fn a_session_keeps_its_saved_folder_without_asking_git() {
        assert_eq!(
            check_session_path("/gone/wt", Some("/gone/wt"), Path::new("/p"), no_worktrees),
            Ok(())
        );
    }

    #[test]
    fn a_session_in_its_project_folder_passes_without_asking_git() {
        let project = tempfile::tempdir().unwrap();
        assert_eq!(
            check_session_path(s(project.path()), None, project.path(), no_worktrees),
            Ok(())
        );
    }

    #[test]
    fn a_session_below_its_project_folder_is_refused() {
        // Sessions start in the project folder or a worktree, never below:
        // "inside" would let a session under the Home project approve all
        // of HOME.
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir(project.path().join("sub")).unwrap();
        assert_eq!(
            check_session_path(
                s(&project.path().join("sub")),
                None,
                project.path(),
                Vec::new
            ),
            Err(FolderRefusal::NotProjectFolder)
        );
    }

    #[test]
    fn a_session_in_one_of_the_projects_worktrees_passes() {
        let project = tempfile::tempdir().unwrap();
        let worktree = tempfile::tempdir().unwrap();
        let wt = worktree.path().to_path_buf();
        assert_eq!(
            check_session_path(s(worktree.path()), None, project.path(), move || vec![wt]),
            Ok(())
        );
    }

    #[test]
    fn a_session_outside_its_project_and_worktrees_is_refused() {
        let project = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        assert_eq!(
            check_session_path(s(elsewhere.path()), None, project.path(), Vec::new),
            Err(FolderRefusal::NotProjectFolder)
        );
    }

    #[test]
    fn a_session_in_a_missing_folder_is_refused() {
        let project = tempfile::tempdir().unwrap();
        assert_eq!(
            check_session_path(
                s(&project.path().join("gone")),
                None,
                project.path(),
                Vec::new
            ),
            Err(FolderRefusal::NotADirectory)
        );
    }

    #[test]
    fn linked_worktrees_leave_out_the_main_checkout() {
        // The main checkout can sit above a project kept in a monorepo's
        // subfolder; it is approved only as the project folder itself.
        let porcelain = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n\
                         worktree /repo-worktrees/feat x\nHEAD def\nbranch refs/heads/feat\n\n\
                         worktree /tmp/detached\nHEAD 123\ndetached\n";
        assert_eq!(
            parse_linked_worktrees(porcelain),
            vec![
                PathBuf::from("/repo-worktrees/feat x"),
                PathBuf::from("/tmp/detached"),
            ]
        );
    }

    // --- New worktree locations ---

    #[test]
    fn a_new_worktree_may_go_in_the_default_sibling_folder() {
        assert_eq!(
            check_new_worktree_path("/work/repo", "feat/x", "/work/repo-worktrees/feat-x", &[]),
            Ok(())
        );
    }

    #[test]
    fn a_new_worktree_may_go_in_a_chosen_folder_under_its_branch_name() {
        let chosen = tempfile::tempdir().unwrap();
        let path = chosen.path().join("feat-x");
        assert_eq!(
            check_new_worktree_path("/work/repo", "feat/x", s(&path), &approved(&chosen)),
            Ok(())
        );
    }

    #[test]
    fn a_new_worktree_anywhere_else_is_refused() {
        let chosen = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        // A folder nobody chose.
        assert_eq!(
            check_new_worktree_path(
                "/work/repo",
                "feat/x",
                s(&elsewhere.path().join("feat-x")),
                &approved(&chosen)
            ),
            Err(FolderRefusal::NotWorktreeLocation)
        );
        // A chosen folder, but not under the branch's own name.
        assert_eq!(
            check_new_worktree_path(
                "/work/repo",
                "feat/x",
                s(&chosen.path().join("other")),
                &approved(&chosen)
            ),
            Err(FolderRefusal::NotWorktreeLocation)
        );
    }

    #[test]
    fn a_new_worktree_path_must_be_spelled_plainly() {
        assert_eq!(
            check_new_worktree_path("/work/repo", "x", "/work/repo-worktrees/../x", &[]),
            Err(FolderRefusal::NotNormal)
        );
        assert_eq!(
            check_new_worktree_path("/work/repo", "x", "repo-worktrees/x", &[]),
            Err(FolderRefusal::NotAbsolute)
        );
    }
}
