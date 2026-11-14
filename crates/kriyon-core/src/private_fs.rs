//! Owner-only files for what Kriyon keeps about sessions. Logged commands and
//! tool output must not be readable by other local accounts, so folders are
//! `0700` and files `0600` — the modes Claude Code gives its own transcripts.
//!
//! On Windows these live under the user's profile (`%LOCALAPPDATA%`,
//! `%USERPROFILE%`), whose inherited ACL already grants only the user, SYSTEM
//! and Administrators, so there is no mode to set and these are plain writes.

use std::io::Write as _;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::Path;

/// What tells the file at `path` apart from another later made at the same
/// path: its device and inode on Unix, and on Windows the volume serial number
/// and file index, which are the same thing. A symlink or reparse point is
/// identified itself, not followed.
///
/// (A file's creation time is not enough on Windows: NTFS gives a file made at
/// a just-deleted path within about 15 seconds the old file's creation time.)
///
/// # Errors
/// When the file can't be read.
#[cfg(unix)]
pub fn file_identity(path: &Path) -> std::io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt as _;
    let meta = std::fs::symlink_metadata(path)?;
    Ok((meta.dev(), meta.ino()))
}

/// What tells the file at `path` apart from another later made at the same
/// path. See the Unix version.
///
/// # Errors
/// When the file can't be opened or read.
#[cfg(windows)]
pub fn file_identity(path: &Path) -> std::io::Result<(u64, u64)> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };
    // Attributes only, sharing everything, so it never gets in a writer's or a
    // deleter's way; backup semantics so a folder opens too.
    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    // SAFETY: plain-old-data struct; all zeroes is a valid value.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is open for the call and `info` is valid for writes.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &raw mut info) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok((u64::from(info.dwVolumeSerialNumber), index))
}

/// Create `dir` (and its parents) owner-only. An existing folder keeps its
/// mode; [`lock_down`] fixes one an older build left open.
///
/// # Errors
/// When a folder can't be created.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(dir)
}

/// Open options that create a file owner-only.
fn private_file() -> std::fs::OpenOptions {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut options = std::fs::OpenOptions::new();
    #[cfg(unix)]
    options.mode(0o600);
    options
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
    private_file()
        .append(true)
        .create(true)
        .open(path)?
        .write_all(bytes)
}

/// Write `bytes` to `path`, replacing it, owner-only.
///
/// # Errors
/// When the file can't be written.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    private_file()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?
        .write_all(bytes)?;
    // An existing file keeps its old mode through `open`.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Set every folder under `root` (and `root`) to `0700` and every regular file
/// to `0600`. Symlinks are never followed or changed. Best-effort per entry:
/// one unreadable entry does not stop the rest.
///
/// # Errors
/// Only when `root` itself can't be read; a missing `root` is fine.
#[cfg(not(unix))]
#[allow(clippy::unnecessary_wraps)]
pub fn lock_down(_root: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Set every folder under `root` (and `root`) to `0700` and every regular file
/// to `0600`. Symlinks are never followed or changed. Best-effort per entry:
/// one unreadable entry does not stop the rest.
///
/// # Errors
/// Only when `root` itself can't be read; a missing `root` is fine.
#[cfg(unix)]
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

#[cfg(test)]
mod identity_tests {
    #[test]
    fn a_file_made_again_at_the_same_path_is_told_apart() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("spool");
        std::fs::write(&path, "a").expect("first");
        let first = super::file_identity(&path).expect("identity");
        assert_eq!(super::file_identity(&path).expect("again"), first);
        // Keep the old file alive under another name, so its index can't be
        // reused, then make a new one at the path straight away.
        std::fs::rename(&path, dir.path().join("old")).expect("move away");
        std::fs::write(&path, "b").expect("second");
        assert_ne!(super::file_identity(&path).expect("identity"), first);
    }
}
