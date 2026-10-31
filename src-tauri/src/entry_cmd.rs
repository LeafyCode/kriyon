//! Creating, renaming and deleting entries in the [All-files browser].
//!
//! Separate from `file_cmd.rs` on purpose: that module is about a file's
//! *content* (read it, write it, diff it against HEAD) and already runs long.
//! These four are about the *entry* — its existence and its name — and share
//! two things none of the content commands need: [`SandboxRoot::resolve_new`],
//! the containment rule for a path that does not exist yet, and
//! [`SandboxRoot::resolve_existing`], the same split for one that must.
//!
//! Every one of them is destructive-adjacent, so every one of them refuses
//! rather than overwrites: a create will not truncate, a rename will not
//! clobber, and a delete goes to the Trash.

use crate::sandbox::{valid_leaf_name, SandboxRoot};
use crate::StoreState;

/// Shared refusal when something is already at a create/rename target.
const ALREADY_EXISTS_ERROR: &str = "already exists";

/// Create an empty file at `path` (relative to `root`).
///
/// `create_new(true)` rather than `create(true)`: a name collision must be a
/// refusal the user sees, never a silent truncation of a file they forgot was
/// there. The check and the create are one syscall, so there is no window
/// between them.
///
/// # Errors
/// Anything [`SandboxRoot::resolve_new`] returns, [`ALREADY_EXISTS_ERROR`], or
/// the underlying `io::Error`'s message.
fn create_file_sync(root: &SandboxRoot, path: &str) -> Result<(), String> {
    let target = root.resolve_new(path, "write")?;
    match std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target.as_path())
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(ALREADY_EXISTS_ERROR.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Create one directory at `path` (relative to `root`).
///
/// `create_dir`, never `create_dir_all`: the leaf rule says exactly one new
/// name, and `create_dir_all` would quietly materialize a whole chain of
/// directories the user never typed.
///
/// # Errors
/// Anything [`SandboxRoot::resolve_new`] returns, [`ALREADY_EXISTS_ERROR`], or
/// the underlying `io::Error`'s message.
fn create_dir_sync(root: &SandboxRoot, path: &str) -> Result<(), String> {
    let target = root.resolve_new(path, "write")?;
    if target.exists() {
        return Err(ALREADY_EXISTS_ERROR.to_string());
    }
    // `exists()` above is a fast path, not the only guard: unlike
    // `create_file_sync`'s `create_new(true)` (one atomic syscall), `mkdir`
    // has no O_EXCL-equivalent to fold the check into, so this match arm is
    // what keeps the contract string alive if the fast path loses a race —
    // two calls landing between the check and this `create_dir` — or if a
    // later refactor drops the fast path as "redundant". Deliberately
    // untested directly: reaching this arm through `create_dir_sync` itself
    // needs a genuine race (the fast path sees every non-racing collision,
    // including a dangling symlink, via the same `symlink_metadata` this
    // arm's `io::Error` would otherwise surface raw), so a test that hits it
    // without racing would have to reimplement the match instead of calling
    // this function — which is not a test of this function.
    match std::fs::create_dir(target.as_path()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(ALREADY_EXISTS_ERROR.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Create an empty file in the [All-files browser].
///
/// `(async)` for the same reason as `file_cmd::write_file`: this does
/// filesystem I/O and must never run on the main thread.
///
/// # Errors
/// See [`create_file_sync`], plus an error string if `cwd` is not a known
/// session/project root.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn create_file(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
) -> Result<(), String> {
    create_file_sync(&SandboxRoot::validate(store.inner(), &cwd)?, &path)
}

/// Create one directory in the [All-files browser].
///
/// `(async)` for the same reason as [`create_file`].
///
/// # Errors
/// See [`create_dir_sync`], plus an error string if `cwd` is not a known
/// session/project root.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn create_dir(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
) -> Result<(), String> {
    create_dir_sync(&SandboxRoot::validate(store.inner(), &cwd)?, &path)
}

/// Rename `path`'s final segment to `new_name`, in place.
///
/// Same-directory only, and structurally so: `new_name` is validated as a
/// standalone leaf via [`valid_leaf_name`] — the same rule
/// [`SandboxRoot::resolve_new`] applies to its own leaf — *before* it is
/// spliced into a path string, so the leaf rule alone rules out every
/// spelling of "somewhere else". That order matters: `resolve_new` derives
/// its own parent/leaf split from the *last* `/` in whatever string it is
/// given, so validating only the spliced `{parent}/{new_name}` string would
/// let a `new_name` of `"../escaped.ts"` smuggle a bogus parent segment past
/// that split rather than being caught by it — checking `new_name` on its own
/// first closes that gap. A move is a different operation with a different
/// blast radius; this is not it.
///
/// `std::fs::rename` (not a copy-then-delete) is what keeps this safe against
/// a symlink already sitting at `new_name`: `rename` retargets the directory
/// entry itself, so it replaces the link rather than following it into
/// whatever it points at.
///
/// The **source** goes through [`SandboxRoot::resolve_existing`], not
/// [`SandboxRoot::resolve`]: if `path` itself names a symlink, this renames
/// the link — leaving it in its own directory, pointing at whatever it always
/// pointed at — rather than canonicalizing through it and moving the
/// *pointee* into `new_name`'s directory. Silently relocating a file the user
/// never clicked would be exactly the cross-directory move `new_name` being a
/// leaf is supposed to make impossible.
///
/// The target's `exists()` refusal is check-then-act, not airtight: on a
/// single-user desktop the odds of a name landing between this check and
/// `std::fs::rename` are low, but a loss there clobbers `new_name` silently
/// rather than surfacing [`ALREADY_EXISTS_ERROR`] — unlike `create_file_sync`,
/// which folds its check into one atomic syscall, there is no `rename`-side
/// equivalent to close this window with.
///
/// # Errors
/// Anything [`SandboxRoot::resolve_existing`]/`resolve_new` returns,
/// [`ALREADY_EXISTS_ERROR`] if the target name is taken, or the underlying
/// `io::Error`'s message.
fn rename_entry_sync(root: &SandboxRoot, path: &str, new_name: &str) -> Result<(), String> {
    // The source must exist, so it takes the entry-resolution rule; only the
    // target is new.
    let source = root.resolve_existing(path, "write")?;
    valid_leaf_name(new_name)?;
    let parent = match path.rsplit_once('/') {
        Some((parent, _)) => parent,
        None => "",
    };
    let target_spec = if parent.is_empty() {
        new_name.to_string()
    } else {
        format!("{parent}/{new_name}")
    };
    let target = root.resolve_new(&target_spec, "write")?;
    if target.exists() {
        return Err(ALREADY_EXISTS_ERROR.to_string());
    }
    std::fs::rename(source.as_path(), target.as_path()).map_err(|e| e.to_string())
}

/// Move `path` to the Trash.
///
/// **Not** `remove_file`/`remove_dir_all`. This tree has no undo, the menu item
/// sits one row below Rename, and a directory delete is recursive — so the
/// recoverable option is worth an API call. A `trashItemAtURL` failure is
/// returned as an error and never falls through to a permanent delete.
///
/// `path` goes through [`SandboxRoot::resolve_existing`], not
/// [`SandboxRoot::resolve`]: a file tree operates on the entries it lists,
/// not on what they point at. `resolve` canonicalizes the whole path —
/// following a symlink to its real target — which would trash the *pointee*
/// and leave the (now dangling) link sitting in the tree; it would also
/// happily canonicalize `"."`/`""` to the sandbox root itself and hand the
/// entire project to `trashItemAtURL`. `resolve_existing` refuses both: the
/// leaf rule makes the root unnameable, and the entry's own path (parent
/// canonical, leaf untouched) is what gets trashed, so a symlink is removed
/// as a link.
///
/// Returns the Trash location `trash` reports, if any — tests use it to clean
/// up after themselves; the `delete_entry` command discards it.
///
/// # Errors
/// Anything [`SandboxRoot::resolve_existing`] returns, or the `NSError`'s
/// description.
fn delete_entry_sync(root: &SandboxRoot, path: &str) -> Result<Option<std::path::PathBuf>, String> {
    let target = root.resolve_existing(path, "write")?;
    trash(&target.as_path())
}

/// `NSFileManager.trashItemAtURL:` — macOS's own "move to Trash", so the entry
/// lands where Finder's Put Back can restore it.
///
/// Returns the location the item was actually moved to when macOS reports one
/// (it may rename on a collision with something already in the Trash) —
/// production callers can ignore it, but it is what lets tests clean up after
/// themselves instead of littering a real `~/.Trash` on every run.
///
/// # Errors
/// The `NSError`'s localized description.
#[cfg(target_os = "macos")]
fn trash(path: &std::path::Path) -> Result<Option<std::path::PathBuf>, String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let path_str = path
        .to_str()
        .ok_or_else(|| "path is not valid UTF-8".to_string())?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));
    let mut resulting_url = None;
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting_url))
        .map_err(|e| e.localizedDescription().to_string())?;
    Ok(resulting_url
        .and_then(|url| url.path())
        .map(|ns_path| std::path::PathBuf::from(ns_path.to_string())))
}

/// Kriyon only ships on macOS today; this stub exists so the crate still
/// compiles on the Linux CI runner (the `objc2-*` crates are macOS-only
/// dependencies). Mirrors `open_in_code_editor` in `links_cmd`.
#[cfg(not(target_os = "macos"))]
fn trash(_path: &std::path::Path) -> Result<Option<std::path::PathBuf>, String> {
    Err("moving to the Trash is only supported on macOS".to_string())
}

/// Rename an entry in the [All-files browser], in place.
///
/// `(async)` for the same reason as [`create_file`].
///
/// # Errors
/// See [`rename_entry_sync`], plus an error string if `cwd` is not a known
/// session/project root.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn rename_entry(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
    new_name: String,
) -> Result<(), String> {
    rename_entry_sync(
        &SandboxRoot::validate(store.inner(), &cwd)?,
        &path,
        &new_name,
    )
}

/// Move an entry in the [All-files browser] to the Trash.
///
/// **Destructive**, though recoverable from Finder. The frontend confirms with
/// the user before calling this.
///
/// `(async)` for the same reason as [`create_file`].
///
/// # Errors
/// See [`delete_entry_sync`], plus an error string if `cwd` is not a known
/// session/project root.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn delete_entry(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
) -> Result<(), String> {
    delete_entry_sync(&SandboxRoot::validate(store.inner(), &cwd)?, &path)
        .map(|_resulting_location| ())
}

#[cfg(test)]
mod tests {
    use parking_lot::Mutex;

    use super::*;
    use crate::store::{ProjectRow, Store};
    use crate::StoreState;

    /// Mirrors `file_cmd::tests::store_with_project_root`: an in-memory store
    /// with a single registered project root, so these tests exercise the same
    /// known-roots validation the real commands perform.
    fn store_with_project_root(path: &str) -> StoreState {
        let store = Store::open_in_memory().unwrap();
        store
            .upsert_project(&ProjectRow {
                id: "p1".into(),
                name: "proj".into(),
                path: path.to_string(),
                color: None,
                setup_command: None,
                parked_at: None,
            })
            .unwrap();
        StoreState(Mutex::new(store))
    }

    fn sandbox(store: &StoreState, cwd: &str) -> SandboxRoot {
        SandboxRoot::validate(store, cwd).expect("cwd must be a known root")
    }

    #[test]
    fn create_file_writes_an_empty_file() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join("src")).expect("mkdir");
        let store = store_with_project_root(&root.path().to_string_lossy());

        create_file_sync(
            &sandbox(&store, root.path().to_str().unwrap()),
            "src/new.ts",
        )
        .expect("create");

        assert_eq!(
            std::fs::read_to_string(root.path().join("src/new.ts")).expect("read"),
            ""
        );
    }

    /// `create` must never be a disguised truncate: the whole reason it uses
    /// `create_new` is that a name collision is a refusal, not a silent
    /// overwrite of whatever was there.
    #[test]
    fn create_file_refuses_an_existing_path_without_touching_it() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::write(root.path().join("a.txt"), "PRECIOUS").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err =
            create_file_sync(&sandbox(&store, root.path().to_str().unwrap()), "a.txt").unwrap_err();

        assert_eq!(err, "already exists");
        assert_eq!(
            std::fs::read_to_string(root.path().join("a.txt")).expect("read"),
            "PRECIOUS"
        );
    }

    #[test]
    fn create_file_refuses_a_name_that_escapes() {
        let root = tempfile::tempdir().expect("temp root");
        let cwd = root.path().join("cwd");
        std::fs::create_dir(&cwd).expect("mkdir");
        let store = store_with_project_root(&cwd.to_string_lossy());

        let err =
            create_file_sync(&sandbox(&store, cwd.to_str().unwrap()), "../evil.txt").unwrap_err();

        assert_eq!(err, "path escapes cwd");
        assert!(!root.path().join("evil.txt").exists());
    }

    /// The 2026-08-30 review finding on `NewSandboxedPath`: it proves the
    /// *path* sits inside the root, not that writing to it stays inside the
    /// root. A symlink already sitting at the leaf (plausible in a repo Claude
    /// has been editing — e.g. `root/notes` pointing at
    /// `~/.ssh/authorized_keys`) would let a naive `File::create` follow the
    /// link and write outside the sandbox entirely. `create_new(true)` is
    /// `O_EXCL`: it fails on an existing symlink rather than following it, so
    /// the file the symlink points at must come out untouched.
    #[test]
    #[cfg(unix)]
    fn create_file_refuses_a_symlink_at_the_target_without_touching_its_destination() {
        let root = tempfile::tempdir().expect("temp root");
        let outside = tempfile::tempdir().expect("temp outside");
        std::fs::write(outside.path().join("secret.txt"), "PRECIOUS-OUTSIDE").expect("write");
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.path().join("notes"))
            .expect("symlink");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err =
            create_file_sync(&sandbox(&store, root.path().to_str().unwrap()), "notes").unwrap_err();

        assert_eq!(err, "already exists");
        assert_eq!(
            std::fs::read_to_string(outside.path().join("secret.txt")).expect("read"),
            "PRECIOUS-OUTSIDE"
        );
    }

    #[test]
    fn create_dir_makes_one_directory() {
        let root = tempfile::tempdir().expect("temp root");
        let store = store_with_project_root(&root.path().to_string_lossy());

        create_dir_sync(&sandbox(&store, root.path().to_str().unwrap()), "docs").expect("create");

        assert!(root.path().join("docs").is_dir());
    }

    /// Leaf-only, deliberately: `create_dir_all` would let one call
    /// materialize a whole chain of directories the user never named.
    #[test]
    fn create_dir_refuses_when_the_parent_does_not_exist() {
        let root = tempfile::tempdir().expect("temp root");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err =
            create_dir_sync(&sandbox(&store, root.path().to_str().unwrap()), "a/b").unwrap_err();

        assert_eq!(err, "kind:file-missing: path does not exist");
        assert!(!root.path().join("a").exists());
    }

    #[test]
    fn create_dir_refuses_dot_git() {
        let root = tempfile::tempdir().expect("temp root");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err =
            create_dir_sync(&sandbox(&store, root.path().to_str().unwrap()), ".git").unwrap_err();

        assert_eq!(err, "refusing to use .git as a name");
    }

    // 2026-08-30 fix-round-1 review finding: the previous version of this test
    // (`create_dir_maps_the_io_alreadyexists_error_even_when_the_fast_path_is_
    // bypassed`) never called `create_dir_sync` — it reimplemented its match
    // arms inline, so it kept passing even with the production arm deleted.
    // `create_dir_sync`'s `exists()` fast path sees every non-racing
    // collision (including a dangling symlink, via the same
    // `symlink_metadata`), so there is no fixture that reaches the io-path
    // `AlreadyExists` arm through the real function without a genuine
    // multi-thread race. Per the review ruling, the test is deleted rather
    // than kept as a reimplementation; the arm itself stays (see its comment
    // in `create_dir_sync`) as a documented, deliberately-untested defensive
    // mirror of `create_file_sync`'s mapping.

    #[test]
    fn rename_entry_moves_the_name_within_the_same_directory() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join("src")).expect("mkdir");
        std::fs::write(root.path().join("src/old.ts"), "body").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        rename_entry_sync(
            &sandbox(&store, root.path().to_str().unwrap()),
            "src/old.ts",
            "new.ts",
        )
        .expect("rename");

        assert!(!root.path().join("src/old.ts").exists());
        assert_eq!(
            std::fs::read_to_string(root.path().join("src/new.ts")).expect("read"),
            "body"
        );
    }

    /// `new_name` is a *leaf*, so a rename is structurally incapable of moving
    /// an entry somewhere else — there is no spelling of "up one directory"
    /// that survives `valid_leaf_name`.
    #[test]
    fn rename_entry_cannot_move_an_entry_out_of_its_directory() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join("src")).expect("mkdir");
        std::fs::write(root.path().join("src/a.ts"), "body").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err = rename_entry_sync(
            &sandbox(&store, root.path().to_str().unwrap()),
            "src/a.ts",
            "../escaped.ts",
        )
        .unwrap_err();

        assert_eq!(err, "name must not contain a path separator");
        assert!(root.path().join("src/a.ts").exists());
        assert!(!root.path().join("escaped.ts").exists());
    }

    #[test]
    fn rename_entry_refuses_to_clobber_an_existing_name() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::write(root.path().join("a.txt"), "a").expect("write");
        std::fs::write(root.path().join("b.txt"), "PRECIOUS").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err = rename_entry_sync(
            &sandbox(&store, root.path().to_str().unwrap()),
            "a.txt",
            "b.txt",
        )
        .unwrap_err();

        assert_eq!(err, "already exists");
        assert_eq!(
            std::fs::read_to_string(root.path().join("b.txt")).expect("read"),
            "PRECIOUS"
        );
    }

    /// 2026-08-30 fix-round-1 review finding (IMPORTANT): `rename_entry_sync`
    /// used to resolve its source through `SandboxRoot::resolve`, which
    /// canonicalizes the whole path — for a symlink source that means
    /// `source` became the *pointee*, so renaming `docs/link` to `x.ts` moved
    /// `src/real.ts` into `docs/x.ts`, silently relocating a file the user
    /// never clicked and violating the very same-directory invariant the
    /// `valid_leaf_name` fix (ratified in round 0) was about. Now that the
    /// source goes through `SandboxRoot::resolve_existing`, the rename must act on
    /// the link itself: it stays in `docs/`, still points at the same target,
    /// and the target is never touched.
    #[test]
    #[cfg(unix)]
    fn rename_entry_keeps_a_symlink_in_its_own_directory() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join("src")).expect("mkdir src");
        std::fs::create_dir(root.path().join("docs")).expect("mkdir docs");
        std::fs::write(root.path().join("src/real.ts"), "PRECIOUS").expect("write");
        std::os::unix::fs::symlink(
            root.path().join("src/real.ts"),
            root.path().join("docs/link"),
        )
        .expect("symlink");
        let store = store_with_project_root(&root.path().to_string_lossy());

        rename_entry_sync(
            &sandbox(&store, root.path().to_str().unwrap()),
            "docs/link",
            "x.ts",
        )
        .expect("rename");

        assert!(
            !root.path().join("docs/link").exists(),
            "the old link name must be gone"
        );
        let renamed = root.path().join("docs/x.ts");
        assert!(
            std::fs::symlink_metadata(&renamed)
                .expect("renamed entry")
                .file_type()
                .is_symlink(),
            "the entry must still be a symlink, not the file it pointed at"
        );
        assert_eq!(
            std::fs::read_link(&renamed).expect("read_link"),
            root.path().join("src/real.ts"),
            "the link must still point at its original target"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("src/real.ts")).expect("read"),
            "PRECIOUS",
            "the pointee must never have moved or been touched"
        );
    }

    /// `trash()` moves real files into the developer's actual `~/.Trash`, so
    /// every happy-path delete test cleans up what it put there (2026-08-30
    /// fix-round-1 review finding, MINOR-promoted) rather than leaving litter
    /// on every `cargo test` run.
    ///
    /// Asserts `trashed` is `Some` (rather than silently no-op-ing on `None`)
    /// and that the reported location is actually gone afterward — a cleanup
    /// step that can silently fail to clean up is worse than none, since it
    /// would hide the very litter this exists to prevent.
    #[cfg(target_os = "macos")]
    fn clean_up_trashed(trashed: Option<std::path::PathBuf>) {
        let path = trashed.expect("trashItemAtURL should report where it moved the entry");
        std::fs::remove_file(&path)
            .or_else(|_| std::fs::remove_dir_all(&path))
            .expect("remove the trashed test fixture during teardown");
        assert!(
            std::fs::symlink_metadata(&path).is_err(),
            "the trashed fixture must actually be gone after cleanup"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn delete_entry_removes_a_file_from_the_tree() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::write(root.path().join("a.txt"), "body").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let trashed = delete_entry_sync(&sandbox(&store, root.path().to_str().unwrap()), "a.txt")
            .expect("delete");

        assert!(!root.path().join("a.txt").exists());
        clean_up_trashed(trashed);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn delete_entry_removes_a_directory_and_its_contents() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join("docs")).expect("mkdir");
        std::fs::write(root.path().join("docs/a.md"), "body").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let trashed = delete_entry_sync(&sandbox(&store, root.path().to_str().unwrap()), "docs")
            .expect("delete");

        assert!(!root.path().join("docs").exists());
        clean_up_trashed(trashed);
    }

    #[test]
    fn delete_entry_refuses_dot_git() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join(".git")).expect("mkdir");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err =
            delete_entry_sync(&sandbox(&store, root.path().to_str().unwrap()), ".git").unwrap_err();

        // 2026-08-30 fix-round-1: `delete_entry_sync` now resolves through
        // `SandboxRoot::resolve_existing` (parent canonicalized, leaf validated by
        // `valid_leaf_name`) rather than `SandboxRoot::resolve`, so a bare
        // `.git` leaf is refused by the same rule `create_dir`/`create_file`
        // already use for it — this is now the identical message
        // `create_dir_refuses_dot_git` asserts, not `resolve`'s
        // "refusing to {verb} inside .git" (still what a *nested* `.git`,
        // e.g. `"a/.git/hooks"`, hits via the parent's own `resolve` call).
        assert_eq!(err, "refusing to use .git as a name");
        assert!(root.path().join(".git").exists());
    }

    /// CRITICAL, 2026-08-30 fix-round-1 review finding: `delete_entry_sync(root,
    /// ".")` used to canonicalize straight to the sandbox root — `resolve`'s
    /// containment check treats a candidate equal to the root as "inside" it
    /// — and hand the whole project to `trashItemAtURL`. `SandboxRoot::resolve_existing`
    /// closes this structurally: `"."` has no `/`, so it is the whole leaf,
    /// and `valid_leaf_name` refuses `"."` outright before any existence
    /// check or trash call runs.
    #[test]
    fn delete_entry_refuses_the_current_directory_as_an_entry() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::write(root.path().join("a.txt"), "body").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err =
            delete_entry_sync(&sandbox(&store, root.path().to_str().unwrap()), ".").unwrap_err();

        assert_eq!(err, "name must not be . or ..");
        assert!(root.path().exists());
        assert!(root.path().join("a.txt").exists());
    }

    /// Same Critical, the other degenerate spelling: an empty relative path
    /// also canonicalizes to the sandbox root under the old `resolve`-based
    /// implementation. `valid_leaf_name` refuses an empty leaf the same way.
    #[test]
    fn delete_entry_refuses_an_empty_path_as_an_entry() {
        let root = tempfile::tempdir().expect("temp root");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err =
            delete_entry_sync(&sandbox(&store, root.path().to_str().unwrap()), "").unwrap_err();

        assert_eq!(err, "name must not be empty");
        assert!(root.path().exists());
    }

    /// IMPORTANT, 2026-08-30 fix-round-1 review finding: `delete_entry_sync`
    /// used to resolve `path` through `SandboxRoot::resolve`, which
    /// canonicalizes through a symlink to its target — so deleting a symlink
    /// trashed the file it pointed at and left the (now dangling) link
    /// sitting in the tree. `SandboxRoot::resolve_existing` acts on the entry's own
    /// path, so deleting a symlink removes the link and leaves its target
    /// untouched.
    // `cfg(target_os = "macos")`, not `cfg(unix)`: the happy path ends in a
    // real `trash()` call, which only the macOS build has.
    #[test]
    #[cfg(target_os = "macos")]
    fn delete_entry_removes_a_symlink_without_touching_its_pointee() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join("src")).expect("mkdir");
        std::fs::write(root.path().join("src/real.ts"), "PRECIOUS").expect("write");
        std::os::unix::fs::symlink(root.path().join("src/real.ts"), root.path().join("link"))
            .expect("symlink");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let trashed = delete_entry_sync(&sandbox(&store, root.path().to_str().unwrap()), "link")
            .expect("delete");

        assert!(
            std::fs::symlink_metadata(root.path().join("link")).is_err(),
            "the link itself must be gone"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("src/real.ts")).expect("read"),
            "PRECIOUS",
            "the pointee must never have been trashed"
        );
        clean_up_trashed(trashed);
    }
}
