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
    if !Path::new(path).is_absolute() {
        return Err(FolderRefusal::NotAbsolute);
    }
    // `Path::components` silently drops an interior `.`, so split the string.
    if path.split('/').any(|part| part == "." || part == "..") {
        return Err(FolderRefusal::NotNormal);
    }
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
}
