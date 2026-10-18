//! Owner-only files for what Kriyon keeps about sessions. Logged commands and
//! tool output must not be readable by other local accounts, so folders are
//! `0700` and files `0600` — the modes Claude Code gives its own transcripts.

use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::Path;

/// Create `dir` (and its parents) owner-only. An existing folder keeps its
/// mode; [`lock_down`] fixes one an older build left open.
///
/// # Errors
/// When a folder can't be created.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

/// Append `bytes` to `path` in one `O_APPEND` write, creating it owner-only
/// (and its folder) if needed.
///
/// # Errors
/// When the folder or file can't be created or written.
pub fn append_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        create_private_dir(dir)?;
    }
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)
}

/// Write `bytes` to `path`, replacing it, owner-only.
///
/// # Errors
/// When the file can't be written.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)?;
    // An existing file keeps its old mode through `open`.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

/// Set every folder under `root` (and `root`) to `0700` and every regular file
/// to `0600`. Symlinks are never followed or changed. Best-effort per entry:
/// one unreadable entry does not stop the rest.
///
/// # Errors
/// Only when `root` itself can't be read; a missing `root` is fine.
pub fn lock_down(root: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    let meta = match std::fs::symlink_metadata(root) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if !meta.is_dir() {
        return Ok(());
    }
    let _ = std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700));
    for entry in std::fs::read_dir(root)?.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            let _ = lock_down(&entry.path());
        } else if kind.is_file() {
            let _ = std::fs::set_permissions(entry.path(), std::fs::Permissions::from_mode(0o600));
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path)
            .expect("exists")
            .permissions()
            .mode()
            & 0o777
    }

    #[test]
    fn lock_down_makes_folders_0700_and_files_0600() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("kriyon");
        let events = root.join("events");
        std::fs::create_dir_all(&events).expect("dirs");
        let file = events.join("s.jsonl");
        std::fs::write(&file, "{}").expect("file");
        for p in [&root, &events] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, "x").expect("file");
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        std::os::unix::fs::symlink(&outside, root.join("link")).expect("symlink");

        lock_down(&root).expect("locks down");

        assert_eq!(mode(&root), 0o700);
        assert_eq!(mode(&events), 0o700);
        assert_eq!(mode(&file), 0o600);
        assert_eq!(mode(&outside), 0o644, "a symlink's target is left alone");
    }

    #[test]
    fn lock_down_of_a_missing_folder_is_fine() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(lock_down(&tmp.path().join("nope")).is_ok());
    }
}
