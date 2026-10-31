//! Sandboxed file access for the Code Changes View's file browser: `read_file`,
//! `list_dir`, and `write_file`. All three take a `cwd` (the session/worktree
//! root) and a `path` relative to it, and all three reach their `*_sync` body
//! through exactly one door: [`SandboxRoot::validate`], which checks `cwd`
//! against the app's known session/project roots — the same IPC trust-boundary
//! check `list_files` uses — so a frontend-chosen `cwd` can't turn an arbitrary
//! directory (e.g. `/`) into the sandbox root. `path` is then resolved against
//! that validated root by [`SandboxRoot::resolve`], and the entire point of the
//! [`crate::sandbox::SandboxedPath`] it returns is that the resolved path can never leave the
//! root — not via `..`, not via an absolute `path` outside it, and not via a
//! symlink that points outside it.
//!
//! Neither of those steps is a convention any more: the `*_sync` functions take
//! `&SandboxRoot`, which has no constructor other than `validate`, so there is
//! no spelling of these commands that skips validation. See
//! [`crate::sandbox`] for the invariant the two types carry.
//!
//! `write_file` is the one command here that mutates disk, so it layers
//! several more checks on top of that shared sandbox: it refuses anything
//! under `.git/`, refuses a target that isn't a plain file, refuses a target
//! larger than [`MAX_READ_BYTES`] (the same cap [`read_file`] truncates at —
//! see [`write_file_sync`]'s docs for why that pairing matters), refuses a
//! target that is currently binary on disk, and refuses to save over a file
//! that changed since the caller last read it (see its own docs for the
//! conflict guard's residual blind spot). The write itself is atomic — a temp
//! file in the same directory, renamed over the target, with the target's
//! permission mode carried over to the temp file first — so a crash or a
//! second concurrent write can never leave a half-written file with the
//! wrong mode. There is still a residual TOCTOU window between the
//! canonicalize/metadata read and the final rename; see [`write_file_sync`]'s
//! docs for why it's the same shape as [`read_file`]'s and why a rename
//! (rather than an in-place write) closes off the symlink-swap variant of it.

use std::io::Read;
use std::path::Path;

use kriyon_core::failure::tagged_failure;

use crate::sandbox::SandboxRoot;
use crate::StoreState;

/// Cap on how much of a file [`read_file`] will return: content beyond this
/// is dropped and `truncated` is set, so a multi-gigabyte log can't be piped
/// wholesale over IPC into the frontend.
///
/// `pub(crate)`: [`crate::git_cmd::read_baseline`] reuses the exact same cap
/// for the HEAD blob it reads, so an oversized baseline degrades the same way
/// an oversized working-tree file does.
pub(crate) const MAX_READ_BYTES: u64 = 1024 * 1024;

/// How many leading bytes of a file are sniffed for a NUL byte to decide
/// whether it's binary (a common, cheap heuristic — matches
/// `read_untracked_content` in `kriyon_core::git`).
const BINARY_SNIFF_BYTES: usize = 8192;

/// Byte-identical to `CONFLICT_ERROR_MESSAGE` in
/// `src/changes/useFileEditorSession.ts` — the human-readable half of
/// [`write_file_sync`]'s conflict-guard failure, tagged with
/// [`SAVE_CONFLICT`] (see [Command failure kind]) so the frontend's
/// `commandFailure` classifies it and its Reload-on-conflict button no
/// longer depends on re-matching this wording; both sides still pin the
/// wording itself with a test.
const WRITE_CONFLICT_ERROR: &str = "file changed on disk since it was opened";

/// [`tagged_failure`] slug for [`WRITE_CONFLICT_ERROR`] — `src/ipc/failures.ts`'s
/// `commandFailure` maps this exact spelling to `"saveConflict"`.
const SAVE_CONFLICT: &str = "save-conflict";

/// A file's content as returned by [`read_file`]. `size` is the file's real,
/// full size on disk (not capped by `truncated`/[`MAX_READ_BYTES`]) so the
/// frontend can show "N bytes, truncated" accurately.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
    /// The on-disk bytes were not valid UTF-8, so `content` is a lossy
    /// rendering (invalid bytes replaced with U+FFFD) shown read-only. Like
    /// `truncated`, this means the frontend must never mount an editor over
    /// `content`: saving the lossy string back would rewrite the original
    /// bytes as U+FFFD, and the `(mtime, len)` conflict guard can't catch it
    /// (the length is unchanged). "Couldn't read faithfully → read-only",
    /// mirroring `truncated`'s "couldn't read whole → read-only".
    pub lossy: bool,
    pub size: u64,
    pub mtime: u64,
}

/// `path`'s modification time as unix milliseconds since the epoch, or `0` if
/// the metadata's `modified()` time is unavailable on this platform or
/// predates the epoch. Deliberately its own conversion rather than reusing
/// [`crate::watcher::file_signature`]: that helper returns a raw
/// `(SystemTime, u64)` pair for same-process equality checks (it never
/// crosses IPC), whereas this needs a millisecond integer the frontend can
/// hand back unchanged on save for `write_file`'s conflict guard.
///
/// The millisecond truncation is a known, accepted blind spot for that guard:
/// two writes to the same file within the same millisecond report an
/// identical `mtime`. Pairing it with the file's length (as `write_file`'s
/// conflict guard does) catches the common case — a same-millisecond rewrite
/// that also changes size — but a same-millisecond, same-length rewrite is
/// still undetectable. Mirrors the coarse-mtime caveat already documented on
/// `UsageSource::gate` in `watcher.rs`.
fn mtime_millis(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The read half of [`read_file`], over an already-validated [`SandboxRoot`]
/// — the only shape in which this body is reachable, so the `cwd` allowlist,
/// the containment check, and the `.git` refusal cannot be skipped by a future
/// call site.
fn read_file_sync(root: &SandboxRoot, path: &str) -> Result<FileContent, String> {
    let resolved = root.resolve(path, "read")?;
    let metadata = resolved.file_metadata()?;
    let size = metadata.len();
    let mtime = mtime_millis(&metadata);

    let mut file = std::fs::File::open(resolved.as_path()).map_err(|e| e.to_string())?;
    // Read at most one byte past the cap: if we get the full `cap + 1` bytes,
    // the file is longer than the cap and `truncated` is set. Bounds memory
    // use to ~1 MiB regardless of how large the file actually is.
    #[allow(clippy::cast_possible_truncation)]
    let mut buf = Vec::with_capacity((MAX_READ_BYTES + 1).min(size + 1) as usize);
    file.by_ref()
        .take(MAX_READ_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;

    let sniff_len = buf.len().min(BINARY_SNIFF_BYTES);
    if buf[..sniff_len].contains(&0) {
        return Ok(FileContent {
            content: String::new(),
            truncated: false,
            binary: true,
            lossy: false,
            size,
            mtime,
        });
    }

    #[allow(clippy::cast_possible_truncation)]
    let cap = MAX_READ_BYTES as usize;
    let truncated = buf.len() > cap;
    if truncated {
        buf.truncate(cap);
    }
    // Strict UTF-8 first: only a faithful decode is editable. A file that is
    // not valid UTF-8 (but had no NUL in the sniff window, so it wasn't
    // flagged binary — a Latin-1/CP-1252 source, a stray high byte) is still
    // shown, via the same lossy rendering as before, but flagged `lossy` so
    // the frontend keeps it read-only. Editing then saving the lossy string
    // would silently rewrite those bytes as U+FFFD, and the `(mtime, len)`
    // conflict guard can't see it (the length is unchanged).
    let (content, lossy) = match std::str::from_utf8(&buf) {
        Ok(text) => (text.to_owned(), false),
        Err(_) => (String::from_utf8_lossy(&buf).into_owned(), true),
    };
    Ok(FileContent {
        content,
        truncated,
        binary: false,
        lossy,
        size,
        mtime,
    })
}

/// Read a file at `path` (relative to `cwd`) for the file browser's preview
/// pane. `cwd` must be a known session/project root (or a descendant of one —
/// see [`SandboxRoot::validate`]); the resolved path can never leave `cwd` —
/// see [`SandboxRoot::resolve`]. Refuses anything under `.git/` — `list_dir`
/// already skips it and `write_file` already refused it, but without this,
/// `read_file` would happily hand back `.git/config`, including any
/// credentialed remote URL. Caps content at 1 MiB (`truncated: true` beyond
/// that) and sniffs the first 8 KB for a NUL byte to flag binary files
/// (`binary: true`, empty content).
///
/// `(async)` on this sync fn hands the whole body — including the `cwd`
/// validation's filesystem/DB work — to the async runtime's blocking pool,
/// the same reason `list_files` and `list_slash_commands` use it: this runs
/// on every file-browser click and must never stall the main thread.
///
/// # Errors
/// Returns an error string if `cwd` is not a known session/project root (see
/// [`SandboxRoot::validate`]), if `cwd`/`path` don't resolve inside the
/// sandbox (see [`SandboxRoot::resolve`]), if the path is under `.git/`, if
/// the resolved path isn't a file, or if it can't be read.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn read_file(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
) -> Result<FileContent, String> {
    read_file_sync(&SandboxRoot::validate(store.inner(), &cwd)?, &path)
}

/// One entry in a [`list_dir`] listing.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub ignored: bool,
}

/// Names of `dir`'s immediate children that gitignore rules (including
/// ancestor `.gitignore`/`.git/info/exclude`/global-excludes files above
/// `dir`) would hide, found by diffing a plain [`std::fs::read_dir`] against
/// an ignore-respecting [`ignore::WalkBuilder`] walk of the same directory.
/// The `ignore` crate's ignore-matching internals aren't public, so rather
/// than reimplement gitignore-stacking by hand, this reuses the same
/// `WalkBuilder` house style as `completion_cmd::walk_files` and takes the
/// set difference — entries the walk silently drops are the ignored ones.
fn ignored_names(dir: &Path) -> std::collections::HashSet<String> {
    let visible: std::collections::HashSet<String> = ignore::WalkBuilder::new(dir)
        .max_depth(Some(1))
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let rel = entry.path().strip_prefix(dir).ok()?;
            if rel.as_os_str().is_empty() {
                return None; // the root itself
            }
            Some(rel.to_string_lossy().to_string())
        })
        .collect();

    let mut ignored = std::collections::HashSet::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return ignored;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        if !visible.contains(&name) {
            ignored.insert(name);
        }
    }
    ignored
}

/// The listing half of [`list_dir`], over an already-validated
/// [`SandboxRoot`]. Resolves through [`SandboxRoot::resolve_for_listing`], not
/// [`SandboxRoot::resolve`]: this command has never refused a `.git` directory
/// *target* — it skips `.git` entries by name while listing instead — and
/// starting to refuse it here would be a behavior change rather than a
/// refactor. Containment is identical either way.
fn list_dir_sync(root: &SandboxRoot, path: &str) -> Result<Vec<DirEntry>, String> {
    let target = root.resolve_for_listing(path)?;
    let dir = target.as_path();
    if !dir.is_dir() {
        return Err("path is not a directory".to_string());
    }

    let ignored = ignored_names(dir);
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let is_dir = entry.path().is_dir();
        let ignored = ignored.contains(&name);
        out.push(DirEntry {
            name,
            is_dir,
            ignored,
        });
    }

    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

/// List the immediate children of `path` (relative to `cwd`) for the file
/// browser's tree. `cwd` must be a known session/project root (or a
/// descendant of one — see [`SandboxRoot::validate`]); `path` can
/// never resolve outside `cwd` — see [`SandboxRoot::resolve_for_listing`]. Sorted
/// directories-first then by name; `.git` is skipped entirely; gitignored
/// entries are kept but flagged (`ignored: true`), not filtered out, so the
/// browser can dim them.
///
/// `(async)` on this sync fn hands the whole body to the async runtime's
/// blocking pool — see the note on [`read_file`].
///
/// # Errors
/// Returns an error string if `cwd` is not a known session/project root (see
/// [`SandboxRoot::validate`]), if `cwd`/`path` don't resolve inside the
/// sandbox (see [`SandboxRoot::resolve_for_listing`]), or if the resolved path
/// isn't a directory.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn list_dir(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    list_dir_sync(&SandboxRoot::validate(store.inner(), &cwd)?, &path)
}

/// The result of a successful [`write_file`]: the new modification time and
/// length after the write, so the frontend can adopt them as its "last known
/// good" signature for the *next* save's conflict guard without a follow-up
/// `read_file` round trip.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub mtime: u64,
    pub len: u64,
}

/// Reads at most [`BINARY_SNIFF_BYTES`] from `reader` and reports whether a
/// NUL byte appears among them — the same cheap binary heuristic
/// [`read_file_sync`] uses, factored out so [`write_file_sync`] can share it
/// without ever reading more than the sniff window, no matter how large the
/// underlying file is. Generic over `impl Read` (rather than taking a `Path`
/// directly) so it can be exercised in isolation against a reader that never
/// hits EOF — see the `sniff_contains_nul_never_reads_past_the_sniff_window`
/// test, which is the regression guard for this bound.
fn sniff_contains_nul(reader: &mut impl Read) -> Result<bool, String> {
    let mut buf = Vec::with_capacity(BINARY_SNIFF_BYTES);
    reader
        .by_ref()
        .take(BINARY_SNIFF_BYTES as u64)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf.contains(&0))
}

/// Save `content` over the file at `path` (relative to `root`, an
/// already-validated [`SandboxRoot`] — the only shape in which this body is
/// reachable). Layers several checks on top of the shared read sandbox (see
/// [`SandboxRoot::resolve`]):
///
/// 1. **Must already exist.** [`SandboxRoot::resolve`] canonicalizes `path`,
///    which requires it to exist — this command only ever overwrites a file
///    the browser already showed the user, never creates one, so there is no
///    new-file/parent-directory case to reason about.
/// 2. **Refuses `.git/`.** Checked by path component, not a string prefix, so
///    it also catches a nested `.git` (e.g. `sub/.git/x`) — and checked on
///    both the literal joined path and the canonicalized result (see
///    [`SandboxRoot::resolve`]), so a symlinked `.git` can't launder the
///    check by resolving away its own `.git` component.
/// 3. **Refuses a non-file target** (via [`crate::sandbox::SandboxedPath::file_metadata`], the
///    same check [`read_file_sync`] makes). A directory would otherwise
///    surface a confusing raw `EISDIR` from the binary sniff below, and a FIFO
///    inside the sandboxed root would block that same read forever, wedging a
///    blocking-pool thread.
/// 4. **Refuses a target larger than [`MAX_READ_BYTES`].** This is the one
///    that matters most: [`read_file`] silently *truncates* content past
///    [`MAX_READ_BYTES`] while still reporting the file's real, untruncated
///    `size`. Without this check, a caller that opened a 5 MiB file (getting
///    back 1 MiB of `content` plus the real `size` as `expected_len`) could
///    save that truncated `content` right back: `content.len()` is exactly
///    [`MAX_READ_BYTES`], not greater than it, so the old oversize-`content`
///    check alone never caught it, and the conflict guard below is satisfied
///    because the on-disk `len` still matches the real (untruncated)
///    `expected_len` the caller was given. The result was a silent 4 MiB
///    data loss. A file this command could not have read whole must never be
///    saved whole, so the check is on the *target's on-disk size*, not on
///    `content` — trusting the frontend to send a short `content` for a big
///    file is not an option across an IPC trust boundary.
/// 5. **Refuses a binary target.** Sniffs the *existing* on-disk bytes (not
///    `content`) for a NUL in the first [`BINARY_SNIFF_BYTES`] — same
///    convention as [`read_file`]'s binary flag — so a file the browser
///    already can't render as text can't be silently clobbered. Bounded via
///    [`sniff_contains_nul`] (`File::open` + `take`), *not* a whole-file
///    `std::fs::read`: reading a multi-gigabyte file in full just to look at
///    its first 8 KiB is itself an unbounded-allocation vector from a
///    frontend-controlled path inside an otherwise-valid `cwd`, independent
///    of the size check above (defense in depth, and it also removes the
///    wasteful double read the old whole-file version did on the happy
///    path — `content` no longer needs a separate full read before the
///    metadata call that follows).
///
/// Then a conflict guard compares **both** the target's current `(mtime,
/// len)` against `expected_mtime`/`expected_len` — the signature the caller
/// read the file at — and refuses (with a "changed on disk" message) if
/// either differs. Comparing only `mtime` is not enough: see the blind-spot
/// note on [`mtime_millis`], which this reuses for the current-mtime read.
/// Comparing `len` too closes most of that gap (a same-millisecond rewrite
/// that also changes size is still caught); only a same-millisecond,
/// same-length rewrite slips through undetected.
///
/// Finally the write itself is atomic: the new content goes to a fresh temp
/// file created in the *same directory* as the target (so the rename below
/// is same-filesystem and therefore atomic on all platforms we ship on), the
/// target's permission mode is copied onto the temp file (`tempfile` always
/// creates at `0o600`, and `persist` is a rename, so without this every save
/// would silently clobber the target's mode — e.g. a `0o755` script losing
/// its `+x` bit, or any group/other bits, with git recording a spurious mode
/// change), the temp file's data is flushed to disk (`sync_all`) so a crash
/// immediately after the rename can't expose a short or empty file under the
/// target's name, and only then does [`tempfile::NamedTempFile::persist`]
/// rename it over the target. A crash or a competing write between the
/// temp-file write and the rename can never leave the target partially
/// written. On an early `?` return (any check above failing, or an I/O error
/// during the write/persist itself) the temp file is cleaned up by
/// `NamedTempFile`'s `Drop`, so no stray `.kriyon-write-*` file survives a
/// failed save that way — that guarantee does not extend to a hard kill
/// (e.g. `SIGKILL`) of the process between temp-file creation and persist,
/// since `Drop` never runs in that case.
///
/// **Residual TOCTOU window.** Like [`read_file`], there is a gap between
/// resolving/`stat`-ing the target (canonicalize, then the metadata read
/// above) and the final rename: something else could replace the file in
/// between. This is the same window [`read_file`] already has and accepts
/// (see its docs); here it's narrower in one respect, because the mutation
/// at the end is a *rename*, not an in-place write — so even if a symlink at
/// the target path were swapped out for one pointing outside the sandbox root
/// during that window, the rename replaces the directory entry itself
/// (`resolved` was already canonicalized to a concrete path before the
/// window opened), not whatever the symlink now points at, so this specific
/// escape is not possible; a same-directory legitimate file swap can still
/// race with the write, same as it can with `read_file`.
///
/// # Errors
/// Returns an error string if `path` doesn't resolve inside `root` (see
/// [`SandboxRoot::resolve`]), if it's under `.git/`, if the resolved path
/// isn't a plain file, if the on-disk file is larger than [`MAX_READ_BYTES`]
/// or is binary, if `content` exceeds [`MAX_READ_BYTES`], if the on-disk
/// `(mtime, len)` no longer matches `expected_mtime`/`expected_len`, or if any
/// underlying filesystem operation fails.
fn write_file_sync(
    root: &SandboxRoot,
    path: &str,
    content: &str,
    expected_mtime: u64,
    expected_len: u64,
) -> Result<FileWriteResult, String> {
    // Function-local, not module-level: `std::fs::File` implements both `Read`
    // and `Write`, and the module already imports `Read` for `read_file_sync`
    // — a module-level `Write` import makes `file.by_ref()` there ambiguous
    // between the two traits' `by_ref` methods.
    use std::io::Write as _;

    let target = root.resolve(path, "write")?;
    let resolved = target.as_path();

    // Fetched once and reused below for the too-large-to-edit-safely check,
    // the conflict guard, and (via `metadata.permissions()`) preserving the
    // target's mode across the write — no repeated `stat`s for checks that all
    // need the same snapshot. The is-a-file refusal rides along with it (see
    // [`crate::sandbox::SandboxedPath::file_metadata`]).
    let metadata = target.file_metadata()?;

    // A file `read_file` could only have returned truncated (content capped
    // at `MAX_READ_BYTES`, `size` reporting the real, larger length) must
    // never be saved whole — see the doc comment above for the exact data-loss
    // scenario this closes. Checked against the target's real on-disk size,
    // never against `content`: a same-size `content` would otherwise sail
    // through undetected.
    if metadata.len() > MAX_READ_BYTES {
        return Err("file is too large to edit safely".to_string());
    }

    let content_len = u64::try_from(content.len()).unwrap_or(u64::MAX);
    if content_len > MAX_READ_BYTES {
        return Err("file too large to save".to_string());
    }

    // Binary check sniffs the file's CURRENT on-disk bytes, not `content` —
    // this is a target-suitability check ("should we ever overwrite this?"),
    // not a check on the new text being saved. Bounded via `File::open` +
    // `sniff_contains_nul`, never a whole-file `std::fs::read`: see the doc
    // comment above for why an unbounded read here is its own OOM vector,
    // independent of the size check above.
    let mut existing_file = std::fs::File::open(resolved).map_err(|e| e.to_string())?;
    if sniff_contains_nul(&mut existing_file)? {
        return Err("refusing to write a binary file".to_string());
    }

    // Conflict guard: both fields must match (see the doc comment above and
    // the blind-spot note on `mtime_millis`). Reuses the metadata fetched
    // above rather than re-`stat`ing.
    let mtime = mtime_millis(&metadata);
    let len = metadata.len();
    if mtime != expected_mtime || len != expected_len {
        return Err(tagged_failure(SAVE_CONFLICT, WRITE_CONFLICT_ERROR));
    }

    // Atomic write: temp file in the same directory, then rename over the
    // target. Never a partial write visible to a concurrent reader.
    let dir = resolved
        .parent()
        .ok_or_else(|| "resolved path has no parent directory".to_string())?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".kriyon-write-")
        .tempfile_in(dir)
        .map_err(|e| e.to_string())?;
    tmp.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    tmp.flush().map_err(|e| e.to_string())?;
    // `tempfile` always creates at `0o600` regardless of the target's mode,
    // and `persist` below is a rename — so without this, every save would
    // silently clobber the target's permission bits (e.g. a `0o755` script
    // losing its `+x`). Applied before the rename, so the target's mode is
    // correct from the instant the new content becomes visible.
    //
    // Masked to the permission bits (`& 0o777`) rather than copying
    // `metadata.permissions()` wholesale: the full `st_mode` also carries
    // setuid/setgid/sticky, and preserving the target's *permission* mode is
    // not license to propagate those onto a freshly created inode — an
    // editor save should never be the thing that makes a file setuid.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = metadata.permissions().mode() & 0o777;
        tmp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(mode))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    {
        tmp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(|e| e.to_string())?;
    }
    // Flush the temp file's data to disk before the rename: a filesystem is
    // otherwise free to persist the rename before it persists the data the
    // renamed name now points at, so a crash or power loss right after could
    // expose a short or empty file under the target's name despite the
    // rename itself being atomic.
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    // Rename, not an in-place write. The standard atomicity tradeoff: the
    // renamed-over target ends up as a NEW inode (the temp file's), so any
    // xattrs/ACLs/hardlinks on the old inode are dropped, not carried over.
    // That's a decision, not an oversight — it's also exactly what makes the
    // symlink-swap TOCTOU variant impossible (see the doc comment above):
    // the rename replaces the directory entry itself, never whatever a
    // swapped-in symlink might now point at.
    tmp.persist(resolved).map_err(|e| e.error.to_string())?;

    let metadata = std::fs::metadata(resolved).map_err(|e| e.to_string())?;
    Ok(FileWriteResult {
        mtime: mtime_millis(&metadata),
        len: metadata.len(),
    })
}

/// Save `content` over the file at `path` (relative to `cwd`) for the Code
/// Changes View's file editor. `cwd` must be a known session/project root
/// (see [`SandboxRoot::validate`]); everything else is enforced by
/// [`write_file_sync`] — see its docs for the full sandboxing, conflict-guard,
/// and atomicity story.
///
/// `(async)` for the same reason as [`read_file`]/[`list_dir`]: this does
/// filesystem I/O and must never run on the main thread.
///
/// # Errors
/// See [`write_file_sync`].
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn write_file(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
    content: String,
    expected_mtime: u64,
    expected_len: u64,
) -> Result<FileWriteResult, String> {
    write_file_sync(
        &SandboxRoot::validate(store.inner(), &cwd)?,
        &path,
        &content,
        expected_mtime,
        expected_len,
    )
}

#[cfg(test)]
mod tests {
    use parking_lot::Mutex;

    use super::*;
    use crate::sandbox::{FILE_MISSING, WRITE_MISSING_ERROR};
    use crate::store::{ProjectRow, Store};
    use crate::StoreState;

    /// Mirrors `completion_cmd::tests::store_with_project_root`: an in-memory
    /// store with a single registered project root, so tests can exercise the
    /// same known-roots validation `read_file`/`list_dir` now perform.
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

    /// The [Sandbox root] a test acts through — exactly what the
    /// `#[tauri::command]` bodies build from their own `cwd` argument.
    ///
    /// This is not the old `*_for` shim in disguise: it returns the *type*, not
    /// a command's result, so it cannot transcribe (and therefore cannot drift
    /// from) any validation step — [`SandboxRoot::validate`] is the only way to
    /// produce the value the `*_sync` functions demand. Tests build the root
    /// rather than calling the command because `tauri::State` cannot be
    /// constructed outside a running app.
    fn sandbox_root(store: &StoreState, cwd: &str) -> SandboxRoot {
        SandboxRoot::validate(store, cwd).expect("cwd must be a known root")
    }

    /// The `(mtime, len)` signature of a file already on disk, for tests that
    /// need to hand `write_file` the caller's "last known good" signature —
    /// mirrors what the frontend would have gotten back from a prior
    /// `read_file`/`write_file` call.
    fn file_sig(path: &Path) -> (u64, u64) {
        let metadata = std::fs::metadata(path).unwrap();
        (mtime_millis(&metadata), metadata.len())
    }

    #[test]
    fn read_file_reads_utf8_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("foo.txt"), "hello world").unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());

        let result = read_file_sync(
            &sandbox_root(&store, dir.path().to_str().unwrap()),
            "foo.txt",
        )
        .expect("read");
        assert_eq!(result.content, "hello world");
        assert!(!result.truncated);
        assert!(!result.binary);
        assert_eq!(result.size, 11);
    }

    #[test]
    fn read_file_reports_mtime() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hi").unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());

        // Through a real [Sandbox root] like every other test here. This one
        // used to hand `read_file_sync` a raw `PathBuf` it had canonicalized
        // itself — on macOS `tempdir()`'s path sits under a `/var` symlink to
        // `/private/var`, so an uncanonicalized root tripped "path escapes
        // cwd" for a reason unrelated to what the test covers. Canonicalizing
        // is now part of `SandboxRoot::validate`, so there is no raw-path
        // shape left to get wrong.
        let fc =
            read_file_sync(&sandbox_root(&store, dir.path().to_str().unwrap()), "a.txt").unwrap();
        assert!(fc.mtime > 0);
    }

    #[test]
    fn read_file_reads_from_a_nested_relative_path() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::write(dir.path().join("a/b/c.txt"), "nested").unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());

        let result = read_file_sync(
            &sandbox_root(&store, dir.path().to_str().unwrap()),
            "a/b/c.txt",
        )
        .expect("read");
        assert_eq!(result.content, "nested");
    }

    #[test]
    fn read_file_truncates_over_one_mib() {
        let dir = tempfile::tempdir().expect("temp dir");
        let big = "a".repeat(usize::try_from(MAX_READ_BYTES).unwrap() + 500);
        std::fs::write(dir.path().join("big.txt"), &big).unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());

        let result = read_file_sync(
            &sandbox_root(&store, dir.path().to_str().unwrap()),
            "big.txt",
        )
        .expect("read");
        assert!(result.truncated);
        assert!(!result.binary);
        assert_eq!(result.content.len() as u64, MAX_READ_BYTES);
        assert_eq!(result.size, MAX_READ_BYTES + 500);
    }

    #[test]
    fn read_file_does_not_truncate_at_exactly_the_cap() {
        let dir = tempfile::tempdir().expect("temp dir");
        let exact = "a".repeat(usize::try_from(MAX_READ_BYTES).unwrap());
        std::fs::write(dir.path().join("exact.txt"), &exact).unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());

        let result = read_file_sync(
            &sandbox_root(&store, dir.path().to_str().unwrap()),
            "exact.txt",
        )
        .expect("read");
        assert!(!result.truncated);
        assert_eq!(result.content.len() as u64, MAX_READ_BYTES);
    }

    #[test]
    fn read_file_flags_binary_content() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut bytes = b"png-ish header".to_vec();
        bytes.push(0);
        bytes.extend_from_slice(b"more bytes after the NUL");
        std::fs::write(dir.path().join("image.bin"), &bytes).unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());

        let result = read_file_sync(
            &sandbox_root(&store, dir.path().to_str().unwrap()),
            "image.bin",
        )
        .expect("read");
        assert!(result.binary);
        assert_eq!(result.content, "");
        assert_eq!(result.size, bytes.len() as u64);
    }

    #[test]
    fn read_file_flags_non_utf8_content_as_lossy() {
        let dir = tempfile::tempdir().expect("temp dir");
        // Latin-1 'é' (0xE9): invalid UTF-8, but no NUL, so the binary sniff
        // passes. If this came back editable, an edit-then-save would rewrite
        // the byte as U+FFFD and the (mtime, len) conflict guard could not
        // catch it (length unchanged). It must come back read-only (`lossy`),
        // while staying viewable.
        std::fs::write(dir.path().join("latin1.txt"), [b'H', b'i', 0xE9, b'\n']).unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());

        let result = read_file_sync(
            &sandbox_root(&store, dir.path().to_str().unwrap()),
            "latin1.txt",
        )
        .expect("read");
        assert!(
            result.lossy,
            "non-UTF-8 content must be flagged lossy (read-only)"
        );
        assert!(!result.binary, "it is text, not binary — stays viewable");
        assert!(!result.content.is_empty(), "lossy content stays viewable");
    }

    #[test]
    fn read_file_does_not_flag_binary_when_nul_is_past_the_sniff_window() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut bytes = "x".repeat(BINARY_SNIFF_BYTES + 10).into_bytes();
        bytes.push(0); // NUL sits past the 8 KiB sniff window
        std::fs::write(dir.path().join("late-nul.bin"), &bytes).unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());

        let result = read_file_sync(
            &sandbox_root(&store, dir.path().to_str().unwrap()),
            "late-nul.bin",
        )
        .expect("read");
        assert!(!result.binary);
    }

    #[test]
    fn read_file_rejects_dot_dot_escape() {
        let root = tempfile::tempdir().expect("temp root");
        let cwd = root.path().join("cwd");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::write(root.path().join("secret.txt"), "top secret").unwrap();
        let store = store_with_project_root(&cwd.to_string_lossy());

        let err = read_file_sync(
            &sandbox_root(&store, cwd.to_str().unwrap()),
            "../secret.txt",
        )
        .unwrap_err();
        assert_ne!(err, "");
    }

    #[test]
    fn read_file_rejects_absolute_path_outside_root() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        let outside = tempfile::tempdir().expect("temp outside");
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "top secret").unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = read_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            outside_file.to_str().unwrap(),
        )
        .unwrap_err();
        assert_ne!(err, "");
    }

    #[test]
    fn read_file_rejects_a_sibling_that_shares_a_string_prefix() {
        // Regression guard for the exact bug a raw string `starts_with` check
        // would introduce: `/root-evil` is not inside `/root` even though the
        // string "/root-evil" starts with the string "/root".
        let root = tempfile::tempdir().expect("temp root");
        let cwd = root.path().join("root");
        let evil = root.path().join("root-evil");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::create_dir(&evil).unwrap();
        std::fs::write(evil.join("secret.txt"), "top secret").unwrap();
        let store = store_with_project_root(&cwd.to_string_lossy());

        let err = read_file_sync(
            &sandbox_root(&store, cwd.to_str().unwrap()),
            &format!(
                "../{}/secret.txt",
                evil.file_name().unwrap().to_str().unwrap()
            ),
        )
        .unwrap_err();
        assert_ne!(err, "");
    }

    #[test]
    #[cfg(unix)]
    fn read_file_rejects_symlink_pointing_outside_root() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        let outside = tempfile::tempdir().expect("temp outside");
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "top secret").unwrap();

        let link = cwd.path().join("escape-link");
        std::os::unix::fs::symlink(&outside_file, &link).unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = read_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "escape-link",
        )
        .unwrap_err();
        assert_ne!(err, "");
    }

    #[test]
    fn read_file_rejects_nonexistent_path() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        let store = store_with_project_root(&cwd.path().to_string_lossy());
        let err = read_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "nope.txt",
        )
        .unwrap_err();
        assert_ne!(err, "");
    }

    #[test]
    fn read_file_rejects_a_directory() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir(cwd.path().join("subdir")).unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = read_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "subdir",
        )
        .unwrap_err();
        assert_ne!(err, "");
    }

    #[test]
    fn read_file_refuses_to_read_inside_dot_git() {
        // LOW 3: `write_file` already refused `.git/`, but `read_file` did
        // not — it would happily hand back `.git/config`, including any
        // credentialed remote URL.
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir_all(cwd.path().join(".git")).unwrap();
        std::fs::write(cwd.path().join(".git/config"), "[remote]\n").unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = read_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            ".git/config",
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains(".git"));
    }

    #[test]
    fn read_file_refuses_to_read_inside_a_nested_dot_git() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir_all(cwd.path().join("sub/.git")).unwrap();
        std::fs::write(cwd.path().join("sub/.git/config"), "[remote]\n").unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = read_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "sub/.git/config",
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains(".git"));
    }

    #[test]
    #[cfg(unix)]
    fn read_file_refuses_when_dot_git_itself_is_a_symlink() {
        // LOW 3: `SandboxRoot::resolve` canonicalizes FIRST. If `.git` is a
        // symlink to another directory inside the worktree, canonicalizing
        // `cwd/.git/config` resolves straight through the symlink, and the
        // resulting path can end up with NO `.git` path component at all —
        // a check on only the canonical `resolved` path would then miss it
        // entirely. The join-time (pre-canonicalize) check must catch this.
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir_all(cwd.path().join("real-git-storage")).unwrap();
        std::fs::write(cwd.path().join("real-git-storage/config"), "[remote]\n").unwrap();
        std::os::unix::fs::symlink(cwd.path().join("real-git-storage"), cwd.path().join(".git"))
            .unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = read_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            ".git/config",
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains(".git"));
    }

    #[test]
    #[cfg(unix)]
    fn write_file_refuses_when_dot_git_itself_is_a_symlink() {
        // Mirrors `read_file_refuses_when_dot_git_itself_is_a_symlink` for
        // `write_file`: writing `.git/config` this way could otherwise wire
        // up `filter.*.clean` for code execution on the next git command —
        // which this feature now runs automatically via `capture_baseline`.
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir_all(cwd.path().join("real-git-storage")).unwrap();
        std::fs::write(cwd.path().join("real-git-storage/config"), "[remote]\n").unwrap();
        std::os::unix::fs::symlink(cwd.path().join("real-git-storage"), cwd.path().join(".git"))
            .unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            ".git/config",
            "[core]\n\tevil = true\n",
            0,
            0,
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains(".git"));
        assert_eq!(
            std::fs::read_to_string(cwd.path().join("real-git-storage/config")).unwrap(),
            "[remote]\n"
        );
    }

    /// The attack this closes: `read_file("/", "etc/passwd")` used to succeed
    /// because `cwd` itself was never checked against any known
    /// session/project root — only the joined `path` was sandboxed inside
    /// whatever `cwd` the frontend supplied.
    ///
    /// One test for all three commands, because there is now exactly one door:
    /// `read_file_sync`/`list_dir_sync`/`write_file_sync` take a
    /// [`SandboxRoot`], whose only constructor is [`SandboxRoot::validate`], so
    /// "this command skips the allowlist" is no longer a state the code can be
    /// in — it fails to compile rather than failing a test. What remains
    /// runtime-assertable is that the shared constructor still refuses an
    /// unregistered `cwd`, which is what this pins.
    #[test]
    fn the_file_commands_reject_a_cwd_that_is_not_a_known_root() {
        let unregistered_cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::write(unregistered_cwd.path().join("secret.txt"), "top secret").unwrap();
        let registered = tempfile::tempdir().expect("temp registered root");
        let store = store_with_project_root(&registered.path().to_string_lossy());

        let err =
            SandboxRoot::validate(&store, unregistered_cwd.path().to_str().unwrap()).unwrap_err();
        assert_eq!(err, "cwd is not a known session or project root");
    }

    #[test]
    fn list_dir_sorts_dirs_first_then_by_name() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::write(cwd.path().join("b.txt"), "").unwrap();
        std::fs::write(cwd.path().join("a.txt"), "").unwrap();
        std::fs::create_dir(cwd.path().join("zdir")).unwrap();
        std::fs::create_dir(cwd.path().join("adir")).unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let entries =
            list_dir_sync(&sandbox_root(&store, cwd.path().to_str().unwrap()), ".").expect("list");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["adir", "zdir", "a.txt", "b.txt"]);
        assert!(entries[0].is_dir);
        assert!(entries[1].is_dir);
        assert!(!entries[2].is_dir);
        assert!(!entries[3].is_dir);
    }

    #[test]
    fn list_dir_flags_gitignored_entries_without_dropping_them() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::write(cwd.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(cwd.path().join("ignored.txt"), "").unwrap();
        std::fs::write(cwd.path().join("kept.txt"), "").unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let entries =
            list_dir_sync(&sandbox_root(&store, cwd.path().to_str().unwrap()), ".").expect("list");
        let ignored = entries.iter().find(|e| e.name == "ignored.txt").unwrap();
        let kept = entries.iter().find(|e| e.name == "kept.txt").unwrap();
        assert!(ignored.ignored, "ignored.txt should be flagged ignored");
        assert!(!kept.ignored, "kept.txt should not be flagged ignored");
    }

    #[test]
    fn list_dir_skips_the_git_directory() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir(cwd.path().join(".git")).unwrap();
        std::fs::write(cwd.path().join("readme.md"), "").unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let entries =
            list_dir_sync(&sandbox_root(&store, cwd.path().to_str().unwrap()), ".").expect("list");
        assert!(!entries.iter().any(|e| e.name == ".git"));
    }

    #[test]
    fn list_dir_lists_a_nested_subdirectory() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir_all(cwd.path().join("sub")).unwrap();
        std::fs::write(cwd.path().join("sub/file.txt"), "").unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let entries = list_dir_sync(&sandbox_root(&store, cwd.path().to_str().unwrap()), "sub")
            .expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "file.txt");
    }

    #[test]
    fn list_dir_rejects_dot_dot_escape() {
        let root = tempfile::tempdir().expect("temp root");
        let cwd = root.path().join("cwd");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::create_dir(root.path().join("secret-dir")).unwrap();
        let store = store_with_project_root(&cwd.to_string_lossy());

        let err = list_dir_sync(
            &sandbox_root(&store, cwd.to_str().unwrap()),
            "../secret-dir",
        )
        .unwrap_err();
        assert_ne!(err, "");
    }

    #[test]
    fn list_dir_rejects_absolute_path_outside_root() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        let outside = tempfile::tempdir().expect("temp outside");
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = list_dir_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            outside.path().to_str().unwrap(),
        )
        .unwrap_err();
        assert_ne!(err, "");
    }

    #[test]
    #[cfg(unix)]
    fn list_dir_rejects_symlink_pointing_outside_root() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        let outside = tempfile::tempdir().expect("temp outside");
        std::fs::create_dir(outside.path().join("stuff")).unwrap();

        let link = cwd.path().join("escape-link");
        std::os::unix::fs::symlink(outside.path().join("stuff"), &link).unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = list_dir_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "escape-link",
        )
        .unwrap_err();
        assert_ne!(err, "");
    }

    #[test]
    fn write_file_roundtrips_and_returns_new_signature() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::write(cwd.path().join("a.txt"), "old").unwrap();
        let sig = file_sig(&cwd.path().join("a.txt"));
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let res = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "a.txt",
            "new content",
            sig.0,
            sig.1,
        )
        .expect("write");

        assert_eq!(
            std::fs::read_to_string(cwd.path().join("a.txt")).unwrap(),
            "new content"
        );
        assert_eq!(res.len, "new content".len() as u64);
        assert_eq!(res.len, file_sig(&cwd.path().join("a.txt")).1);
    }

    #[test]
    fn write_file_is_atomic_and_leaves_no_temp_file_behind() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::write(cwd.path().join("a.txt"), "old").unwrap();
        let sig = file_sig(&cwd.path().join("a.txt"));
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "a.txt",
            "new content",
            sig.0,
            sig.1,
        )
        .expect("write");

        let names: Vec<String> = std::fs::read_dir(cwd.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a.txt".to_string()]);
    }

    #[test]
    fn write_file_refuses_when_mtime_and_len_both_differ() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::write(cwd.path().join("a.txt"), "old").unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "a.txt",
            "x",
            1,
            1,
        )
        .unwrap_err();
        assert!(err.contains("changed on disk"));
        assert_eq!(
            std::fs::read_to_string(cwd.path().join("a.txt")).unwrap(),
            "old"
        );
    }

    #[test]
    fn write_file_refuses_when_only_len_differs() {
        // Regression guard for comparing `mtime` alone: the real mtime is
        // correct, but the caller's remembered length is stale — this must
        // still be refused as a conflict.
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::write(cwd.path().join("a.txt"), "old").unwrap();
        let sig = file_sig(&cwd.path().join("a.txt"));
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "a.txt",
            "x",
            sig.0,
            sig.1 + 1,
        )
        .unwrap_err();
        assert!(err.contains("changed on disk"));
    }

    #[test]
    fn write_file_refuses_when_only_mtime_differs() {
        // Regression guard for comparing `len` alone: the real length is
        // correct, but the caller's remembered mtime is stale — this must
        // still be refused as a conflict.
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::write(cwd.path().join("a.txt"), "old").unwrap();
        let sig = file_sig(&cwd.path().join("a.txt"));
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "a.txt",
            "x",
            sig.0.wrapping_add(1),
            sig.1,
        )
        .unwrap_err();
        assert!(err.contains("changed on disk"));
    }

    #[test]
    fn write_conflict_error_wording_is_pinned_for_the_frontend() {
        // src/changes/useFileEditorSession.ts CONFLICT_ERROR_MESSAGE must be
        // byte-identical; its test pins the same literal. Only the wording is
        // pinned here — classification runs on the `SAVE_CONFLICT` tag (see
        // `save_conflict_and_file_missing_slugs_are_the_frozen_contract_strings`
        // below), not on this text.
        assert_eq!(
            WRITE_CONFLICT_ERROR,
            "file changed on disk since it was opened"
        );
    }

    #[test]
    fn write_missing_error_wording_is_pinned_for_the_frontend() {
        // src/changes/useFileEditorSession.ts MISSING_FILE_ERROR_MESSAGE must
        // be byte-identical; its test pins the same literal. This is the save
        // failure the deleted-file banner is keyed off — see
        // `write_file_reports_the_pinned_missing_message_for_a_deleted_target`.
        assert_eq!(WRITE_MISSING_ERROR, "path does not exist");
    }

    /// Contract pin (Command failure kind): the wire format `tagged_failure`
    /// produces for each of this module's two kinds, so a change to the
    /// leader shape or either slug's spelling breaks this test instead of
    /// silently drifting from `src/ipc/failures.ts`'s `KIND_BY_SLUG`.
    #[test]
    fn save_conflict_and_file_missing_slugs_are_the_frozen_contract_strings() {
        assert_eq!(SAVE_CONFLICT, "save-conflict");
        assert_eq!(FILE_MISSING, "file-missing");
        assert_eq!(
            tagged_failure(SAVE_CONFLICT, WRITE_CONFLICT_ERROR),
            "kind:save-conflict: file changed on disk since it was opened"
        );
        assert_eq!(
            tagged_failure(FILE_MISSING, WRITE_MISSING_ERROR),
            "kind:file-missing: path does not exist"
        );
    }

    /// The save path's half of the deleted-file affordance (spec P1.4): a file
    /// deleted out from under an open editor must fail the save with exactly
    /// the message the frontend recognizes, so Save surfaces the same
    /// "deleted on disk" banner revalidation does — not a bare generic error.
    #[test]
    fn write_file_reports_the_pinned_missing_message_for_a_deleted_target() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        let target = cwd.path().join("a.txt");
        std::fs::write(&target, "old").unwrap();
        let sig = file_sig(&target);
        let store = store_with_project_root(&cwd.path().to_string_lossy());
        // Deleted after it was opened (its signature captured), exactly the
        // race the banner exists for.
        std::fs::remove_file(&target).unwrap();

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "a.txt",
            "x",
            sig.0,
            sig.1,
        )
        .unwrap_err();
        assert_eq!(err, tagged_failure(FILE_MISSING, WRITE_MISSING_ERROR));
    }

    #[test]
    fn write_file_rejects_dot_dot_escape() {
        let root = tempfile::tempdir().expect("temp root");
        let cwd = root.path().join("cwd");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::write(root.path().join("escape"), "top secret").unwrap();
        let store = store_with_project_root(&cwd.to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.to_str().unwrap()),
            "../escape",
            "x",
            0,
            0,
        )
        .unwrap_err();
        // Specific message, not just "some error": a refactor that starts
        // erroring for the wrong reason (e.g. a bug that makes `../escape`
        // fail to canonicalize instead of being caught by the containment
        // check) would still pass a bare `!err.is_empty()` assertion.
        assert_eq!(err, "path escapes cwd");
        assert_eq!(
            std::fs::read_to_string(root.path().join("escape")).unwrap(),
            "top secret"
        );
    }

    #[test]
    fn write_file_refuses_writes_inside_dot_git() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir_all(cwd.path().join(".git")).unwrap();
        std::fs::write(cwd.path().join(".git/x"), "a").unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            ".git/x",
            "x",
            0,
            0,
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains(".git"));
        assert_eq!(
            std::fs::read_to_string(cwd.path().join(".git/x")).unwrap(),
            "a"
        );
    }

    #[test]
    fn write_file_refuses_a_binary_target_on_disk() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::write(cwd.path().join("b.bin"), [0u8, 1, 2]).unwrap();
        let sig = file_sig(&cwd.path().join("b.bin"));
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "b.bin",
            "x",
            sig.0,
            sig.1,
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains("binary"));
    }

    #[test]
    fn write_file_rejects_content_larger_than_max_read_bytes() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::write(cwd.path().join("c.txt"), "x").unwrap();
        let sig = file_sig(&cwd.path().join("c.txt"));
        let store = store_with_project_root(&cwd.path().to_string_lossy());
        let big = "a".repeat(usize::try_from(MAX_READ_BYTES + 1).unwrap());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "c.txt",
            &big,
            sig.0,
            sig.1,
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains("large"));
    }

    #[test]
    fn write_file_rejects_a_nonexistent_target() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "nope.txt",
            "x",
            0,
            0,
        )
        .unwrap_err();
        // Specific message (see the note on `write_file_rejects_dot_dot_escape`
        // above): distinguishes "doesn't exist" from any other failure mode a
        // future refactor might introduce.
        assert_eq!(err, tagged_failure(FILE_MISSING, "path does not exist"));
    }

    #[test]
    fn write_file_rejects_absolute_path_outside_root() {
        // Mirrors `read_file_rejects_absolute_path_outside_root`: closes the
        // same test gap for `write_file`.
        let cwd = tempfile::tempdir().expect("temp cwd");
        let outside = tempfile::tempdir().expect("temp outside");
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "top secret").unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            outside_file.to_str().unwrap(),
            "x",
            0,
            0,
        )
        .unwrap_err();
        assert_eq!(err, "path escapes cwd");
        assert_eq!(
            std::fs::read_to_string(&outside_file).unwrap(),
            "top secret"
        );
    }

    #[test]
    #[cfg(unix)]
    fn write_file_rejects_symlink_pointing_outside_root() {
        // Mirrors `read_file_rejects_symlink_pointing_outside_root`: closes
        // the same test gap for `write_file`.
        let cwd = tempfile::tempdir().expect("temp cwd");
        let outside = tempfile::tempdir().expect("temp outside");
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "top secret").unwrap();

        let link = cwd.path().join("escape-link");
        std::os::unix::fs::symlink(&outside_file, &link).unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "escape-link",
            "x",
            0,
            0,
        )
        .unwrap_err();
        assert_eq!(err, "path escapes cwd");
        assert_eq!(
            std::fs::read_to_string(&outside_file).unwrap(),
            "top secret"
        );
    }

    #[test]
    fn write_file_refuses_writes_inside_a_nested_dot_git() {
        // The doc comment claims a nested `.git` (not just a top-level one)
        // is caught because the check is component-wise, not a string
        // prefix — nothing exercised that claim until now.
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir_all(cwd.path().join("sub/.git")).unwrap();
        std::fs::write(cwd.path().join("sub/.git/x"), "a").unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "sub/.git/x",
            "x",
            0,
            0,
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains(".git"));
        assert_eq!(
            std::fs::read_to_string(cwd.path().join("sub/.git/x")).unwrap(),
            "a"
        );
    }

    #[test]
    fn write_file_rejects_a_directory_target() {
        // M3: without an `is_file` check, a directory target used to surface
        // a confusing raw `EISDIR` from the binary sniff instead of a clean
        // error — and a FIFO would have blocked that same read forever,
        // wedging a blocking-pool thread.
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir(cwd.path().join("subdir")).unwrap();
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "subdir",
            "x",
            0,
            0,
        )
        .unwrap_err();
        assert_eq!(err, "path is not a file");
    }

    #[test]
    fn write_file_refuses_a_target_larger_than_the_read_cap() {
        // I1 (data loss): `read_file` truncates content past `MAX_READ_BYTES`
        // while still reporting the file's real, untruncated `size`. Before
        // the fix, saving exactly `MAX_READ_BYTES` of `content` back (what a
        // naive "read, edit, save" round trip on a truncated read would send)
        // passed straight through: `content.len()` is exactly the cap, not
        // greater than it, and the conflict guard is satisfied because the
        // real on-disk `len` still equals the real (untruncated)
        // `expected_len` the caller was given. The result was a silent write
        // of only the first `MAX_READ_BYTES`, destroying everything past it.
        let cwd = tempfile::tempdir().expect("temp cwd");
        let big = "a".repeat(usize::try_from(MAX_READ_BYTES).unwrap() + 500);
        std::fs::write(cwd.path().join("big.txt"), &big).unwrap();
        // The real (untruncated) signature — exactly what `read_file` would
        // have handed back as `expected_len`/`expected_mtime` alongside its
        // truncated `content`.
        let sig = file_sig(&cwd.path().join("big.txt"));
        let store = store_with_project_root(&cwd.path().to_string_lossy());
        let truncated_content = "a".repeat(usize::try_from(MAX_READ_BYTES).unwrap());

        let err = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "big.txt",
            &truncated_content,
            sig.0,
            sig.1,
        )
        .unwrap_err();
        assert_eq!(err, "file is too large to edit safely");
        // The original, untruncated file must survive completely untouched.
        assert_eq!(
            std::fs::read_to_string(cwd.path().join("big.txt")).unwrap(),
            big
        );
    }

    #[test]
    #[cfg(unix)]
    fn write_file_preserves_the_target_permission_mode() {
        // I3 (metadata corruption): `tempfile` creates its temp file at
        // `0o600` and `persist` is a rename, so without carrying the
        // target's mode over, a `0o755` script would silently become
        // `0o600` on every save — losing `+x` and any group/other bits.
        use std::os::unix::fs::PermissionsExt as _;

        let cwd = tempfile::tempdir().expect("temp cwd");
        let target = cwd.path().join("script.sh");
        std::fs::write(&target, "#!/bin/sh\necho old\n").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sig = file_sig(&target);
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "script.sh",
            "#!/bin/sh\necho new\n",
            sig.0,
            sig.1,
        )
        .expect("write");

        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o755,
            "write_file must preserve the target's permission mode"
        );
    }

    #[test]
    #[cfg(unix)]
    fn write_file_masks_setuid_off_the_preserved_mode() {
        // LOW 4: `metadata.permissions()` carries the full `st_mode`, so
        // naively preserving it onto the fresh temp-file inode would also
        // propagate setuid/setgid/sticky. Preserving the permission mode is
        // correct; copying setuid onto a file an editor just rewrote is not.
        use std::os::unix::fs::PermissionsExt as _;

        let cwd = tempfile::tempdir().expect("temp cwd");
        let target = cwd.path().join("suid.sh");
        std::fs::write(&target, "old\n").unwrap();
        // Setuid + rwxr-xr-x. Setting the bit on a file you own doesn't
        // require root — only actually exercising the privilege escalation
        // at exec time does, which this test never attempts.
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o4755)).unwrap();
        let sig = file_sig(&target);
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "suid.sh",
            "new\n",
            sig.0,
            sig.1,
        )
        .expect("write");

        let mode = std::fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o755,
            "the ordinary permission bits must still be preserved"
        );
        assert_eq!(
            mode & 0o4000,
            0,
            "write_file must never propagate setuid onto the rewritten file"
        );
    }

    #[test]
    #[cfg(unix)]
    fn write_file_leaves_no_stray_temp_file_when_the_write_fails() {
        // M2: the existing atomicity test only covers the success path. Make
        // the containing directory unwritable so the atomic-write step
        // itself (temp-file creation) fails after every guard check has
        // already passed — proving a failed write leaves the directory
        // exactly as it was, not just that a successful one does.
        use std::os::unix::fs::PermissionsExt as _;

        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::write(cwd.path().join("a.txt"), "old").unwrap();
        let sig = file_sig(&cwd.path().join("a.txt"));
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let original_mode = std::fs::metadata(cwd.path()).unwrap().permissions();
        std::fs::set_permissions(cwd.path(), std::fs::Permissions::from_mode(0o500)).unwrap();

        let result = write_file_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            "a.txt",
            "new content",
            sig.0,
            sig.1,
        );

        // Restore write access before any assertion can early-return via
        // `?`/panic, so the tempdir's own cleanup on `Drop` doesn't fail.
        std::fs::set_permissions(cwd.path(), original_mode).unwrap();

        assert!(result.is_err());
        let names: Vec<String> = std::fs::read_dir(cwd.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a.txt".to_string()]);
        assert_eq!(
            std::fs::read_to_string(cwd.path().join("a.txt")).unwrap(),
            "old"
        );
    }

    #[test]
    fn sniff_contains_nul_never_reads_past_the_sniff_window() {
        // I2 (OOM vector): the old implementation called `std::fs::read` on
        // the ENTIRE file just to sniff the first 8 KiB for a NUL byte. This
        // reader never reaches EOF — standing in for an arbitrarily large
        // (or multi-GB) file — so if `sniff_contains_nul` ever read past its
        // bound (e.g. via `read_to_end` on the raw reader instead of a
        // `.take(BINARY_SNIFF_BYTES)`-limited one), this test would hang and
        // eventually exhaust memory instead of returning. Because it's
        // actually bounded, it returns immediately having consumed at most
        // `BINARY_SNIFF_BYTES` bytes.
        struct Infinite {
            bytes_read: u64,
        }
        impl Read for Infinite {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.bytes_read += buf.len() as u64;
                buf.fill(b'a');
                Ok(buf.len())
            }
        }

        let mut src = Infinite { bytes_read: 0 };
        let result = sniff_contains_nul(&mut src).unwrap();
        assert!(!result);
        assert!(src.bytes_read <= u64::try_from(BINARY_SNIFF_BYTES).unwrap());
    }
}
