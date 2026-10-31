//! [Sandbox root] — the file sandbox at the Rust↔JS trust boundary, carried by
//! a type instead of by convention.
//!
//! Every store-taking command that lets a frontend-supplied `cwd` (and, for the
//! file commands, a frontend-supplied `path`) reach the filesystem or `git` runs
//! the same preamble: refuse a flag-like value, validate the directory against
//! the app's known session/project roots, convert the canonicalized result to
//! UTF-8 without lossy substitution — and, for a path, resolve it inside that
//! root and refuse anything under `.git/`. Seven commands used to hand-chain
//! those steps themselves. That was a convention, and the helper they chained
//! through said so in its own docs: *"a convenience, not an enforcement point —
//! nothing stops a future command from calling `validate_cwd` directly and
//! skipping `reject_flag_like`, or from skipping validation entirely."*
//!
//! The two types here hold that preamble as an invariant instead:
//!
//! - **[`SandboxRoot`]** — a `cwd` that is not flag-like, canonicalizes to a
//!   real directory inside a known session/project root, and is valid UTF-8.
//!   [`SandboxRoot::validate`] is its **only** constructor, so a value of this
//!   type cannot exist without those three checks having run.
//! - **[`SandboxedPath`]** — a canonicalized path proven to sit inside the
//!   [`SandboxRoot`] it came from. It is produced **only** by
//!   [`SandboxRoot::resolve`] / [`SandboxRoot::resolve_for_listing`]: its field
//!   is private, there is no other constructor, no `Default`/`From`/`Deserialize`
//!   impl, and no `pub(crate)` escape hatch hands out an unchecked instance.
//!
//! Because `file_cmd`'s `read_file_sync` / `list_dir_sync` / `write_file_sync`
//! and `git_cmd`'s `read_baseline_sync` take `&SandboxRoot`, and the resolved
//! target they act on is a [`SandboxedPath`], **there is no longer a spelling of
//! those calls that skips validation** — a caller cannot even name the
//! arguments without going through it. That is also why the `*_for`
//! test-delegation shims those commands carried could go: they existed so the
//! tests would exercise the real preamble instead of a transcription of it (a
//! transcription that once silently kept passing after the check it claimed to
//! test was deleted), and the tests now simply build a `SandboxRoot`.
//!
//! Nothing about *what* is refused changed here: every message below is the
//! byte-identical string its previous home produced, including the
//! [`tagged_failure`] `kind:` leader on the missing-path failure.

use std::path::{Path, PathBuf};

use kriyon_core::completion::path_within_roots;
use kriyon_core::failure::tagged_failure;

use crate::completion_cmd::validate_cwd;
use crate::StoreState;

/// Byte-identical to `MISSING_FILE_ERROR_MESSAGE` in
/// `src/changes/useFileEditorSession.ts` — the save failure with its own
/// recovery affordance (the "deleted on disk" banner, spec P1.4), tagged with
/// [`FILE_MISSING`]; both sides pin the wording itself with a test.
///
/// Produced by [`resolve_within`]'s canonicalize failure, which is what a
/// target deleted out from under an open editor hits first — before
/// `file_cmd::write_file_sync` ever `stat`s it. Named for the write path
/// because that is the boundary the frontend keys behavior off; the same
/// wording (and the same tag) is what a read of a vanished path reports too, so
/// `read_file`'s revalidation and reload paths classify on it exactly the way
/// `write_file`'s save path does.
pub(crate) const WRITE_MISSING_ERROR: &str = "path does not exist";

/// [`tagged_failure`] slug for [`WRITE_MISSING_ERROR`] — `src/ipc/failures.ts`'s
/// `commandFailure` maps this exact spelling to `"fileMissing"`.
pub(crate) const FILE_MISSING: &str = "file-missing";

/// Reject a value that could be smuggled into git as a flag.
///
/// Values cross the Rust↔JS trust boundary, so a `branch`/`path` beginning with
/// `-` must never reach git's argv as a positional — it would be parsed as an
/// option. We reject leading-`-` values up front and also pass `--` before
/// positionals at each call site.
///
/// `pub(crate)`: [`SandboxRoot::validate`] runs it on `cwd`, and `git_cmd` runs
/// it on every other frontend-supplied argv value (`repo_path`, `branch`,
/// `base`, `path`, `baseline_oid`) that is not a sandbox root.
///
/// # Errors
/// Returns an error string if `value` is empty or starts with `-`.
pub(crate) fn reject_flag_like(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if value.starts_with('-') {
        return Err(format!("{label} must not start with '-'"));
    }
    Ok(())
}

/// Convert a canonicalized path to `&str`, refusing rather than lossily
/// substituting on non-UTF-8 (`to_string_lossy` would hand git a path that is
/// NOT the validated directory). Its one caller is [`SandboxRoot::validate`],
/// which is why [`SandboxRoot::as_str`] can be infallible.
fn canonical_path_to_str(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| "cwd is not valid UTF-8".to_string())
}

/// Resolve `path` (frontend-supplied, untrusted) against `root_canonical` — a
/// [`SandboxRoot`]'s directory, so already validated to be a real directory
/// that is (or sits inside) a known session/project root, and therefore trusted
/// as *the sandbox root* here.
///
/// Joins `path` onto `root_canonical` and canonicalizes the result — this
/// resolves `..` segments and symlinks alike — then checks the canonical
/// result against `root_canonical` **by path components** (via
/// [`path_within_roots`], the same helper `validate_cwd` uses), never a raw
/// string `starts_with`. A string check would let `/root-evil` pass a `/root`
/// prefix test; a component check will not. Because canonicalization resolves
/// symlinks before the check runs, a symlink inside `root_canonical` that
/// points outside it is rejected the same way an absolute escape or a `..`
/// escape is.
///
/// Private to this module on purpose: the containment check is reachable only
/// through [`SandboxRoot::resolve`]/[`SandboxRoot::resolve_for_listing`], so
/// its result is always wrapped in a [`SandboxedPath`] rather than handed out
/// as a bare `PathBuf` a later refactor could forget to check.
fn resolve_within(root_canonical: &Path, path: &str) -> Result<PathBuf, String> {
    let joined = root_canonical.join(path);
    let canonical = joined
        .canonicalize()
        .map_err(|_| tagged_failure(FILE_MISSING, WRITE_MISSING_ERROR))?;
    if path_within_roots(
        &canonical,
        std::slice::from_ref(&root_canonical.to_path_buf()),
    ) {
        Ok(canonical)
    } else {
        Err("path escapes cwd".to_string())
    }
}

/// Refuse `path` if either its literal (pre-canonicalize) join onto
/// `root_canonical`, or its already-canonicalized `resolved` form, contains a
/// `.git` path component.
///
/// **Checking both is required.** [`resolve_within`] canonicalizes FIRST, so
/// if `.git` itself is a symlink to some other directory inside the
/// worktree, canonicalizing `cwd/.git/config` resolves straight through the
/// symlink to wherever it points — the resulting `resolved` path may have no
/// `.git` component left at all, even though the literal request was for a
/// path under `.git`. Checking the pre-canonicalize `joined` path closes
/// that: it still has `.git` as a literal component, symlink or not.
/// Checking `resolved` too is kept because it catches the mirror case — a
/// `.git` reached only via a symlink hop earlier in the path, which
/// `joined`'s literal components wouldn't show.
///
/// LOAD-BEARING: this correctness also depends on `canonicalize` normalizing
/// path component *case* on APFS (verified: a component spelled `.GIT`
/// canonicalizes to `.git`) — so a future refactor must not move this check
/// to run before canonicalization has resolved `resolved`, or a
/// differently-cased escape could slip through the `resolved` half of this
/// check.
fn refuse_dot_git(
    root_canonical: &Path,
    path: &str,
    resolved: &Path,
    verb: &str,
) -> Result<(), String> {
    let joined = root_canonical.join(path);
    if joined.components().any(|c| c.as_os_str() == ".git")
        || resolved.components().any(|c| c.as_os_str() == ".git")
    {
        return Err(format!("refusing to {verb} inside .git"));
    }
    Ok(())
}

/// A frontend-supplied `cwd` that has passed every trust-boundary check the
/// sandbox depends on: not flag-like, canonicalizes to an existing directory
/// inside one of the app's known session/project roots, and is valid UTF-8.
///
/// [`Self::validate`] is the only way to build one — the field is private and
/// there is no other constructor — so a function that takes a `&SandboxRoot`
/// is *statically* guaranteed to be looking at a validated root. That is the
/// whole point: the sandbox stops being a preamble each command remembers to
/// run and becomes something the compiler checks.
///
/// Holds the canonical path as a `String` rather than a `PathBuf` because the
/// UTF-8 conversion has already succeeded by construction: `git` needs a
/// `&str` argv value, and storing the checked form keeps [`Self::as_str`]
/// infallible instead of re-deriving it (and re-handling an impossible error)
/// at each call site. [`Self::as_path`] is the same value seen as a `Path`.
#[derive(Debug)]
pub(crate) struct SandboxRoot(String);

impl SandboxRoot {
    /// The **only** constructor: run the full `cwd` preamble — reject
    /// flag-like values, validate the path against the app's known
    /// session/project roots (see
    /// [`validate_cwd`](crate::completion_cmd::validate_cwd)), then convert the
    /// canonicalized result to UTF-8 without lossy substitution.
    ///
    /// # Errors
    /// `cwd must not be empty` / `cwd must not start with '-'` (see
    /// [`reject_flag_like`]); `cwd is not a directory` or `cwd is not a known
    /// session or project root` (see `validate_cwd`); `cwd is not valid UTF-8`
    /// (see [`canonical_path_to_str`]).
    pub(crate) fn validate(store: &StoreState, cwd: &str) -> Result<Self, String> {
        reject_flag_like("cwd", cwd)?;
        let canonical = validate_cwd(store, Path::new(cwd))?;
        Ok(Self(canonical_path_to_str(&canonical)?.to_string()))
    }

    /// The validated root as the `&str` `git` needs for `-C <repo>`. Infallible
    /// because the UTF-8 check ran in [`Self::validate`].
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    /// The validated root as a `Path`, for filesystem work and for the
    /// containment checks below.
    pub(crate) fn as_path(&self) -> &Path {
        Path::new(&self.0)
    }

    /// Resolve a frontend-supplied `path` inside this root for a read or a
    /// write: [`resolve_within`] (containment) followed by [`refuse_dot_git`]
    /// (`verb` is the word the refusal names, `"read"` or `"write"`, so the
    /// message reads the way the caller's operation does).
    ///
    /// # Errors
    /// The tagged [`WRITE_MISSING_ERROR`] if `path` does not canonicalize,
    /// `path escapes cwd` if it resolves outside this root, or
    /// `refusing to {verb} inside .git`.
    pub(crate) fn resolve(&self, path: &str, verb: &str) -> Result<SandboxedPath, String> {
        let resolved = resolve_within(self.as_path(), path)?;
        refuse_dot_git(self.as_path(), path, &resolved, verb)?;
        Ok(SandboxedPath(resolved))
    }

    /// [`Self::resolve`] without the `.git` refusal, for `list_dir`.
    ///
    /// Not a weaker sandbox — containment is identical, and the result is the
    /// same unforgeable [`SandboxedPath`]. What differs is one *policy*:
    /// `list_dir` has never refused a `.git` directory target (it filters
    /// `.git` entries by name while listing, and its callers rely on that),
    /// so routing it through [`Self::resolve`] would start refusing a call
    /// that succeeds today. Preserving that is why this exists; tightening it
    /// is a behavior change, not a refactor.
    ///
    /// # Errors
    /// The tagged [`WRITE_MISSING_ERROR`] if `path` does not canonicalize, or
    /// `path escapes cwd` if it resolves outside this root.
    pub(crate) fn resolve_for_listing(&self, path: &str) -> Result<SandboxedPath, String> {
        Ok(SandboxedPath(resolve_within(self.as_path(), path)?))
    }

    /// Resolve a frontend-supplied `path` whose final segment does not exist
    /// yet: the parent goes through [`Self::resolve`] unchanged (canonical
    /// containment, `.git` refusal), and the leaf through [`valid_leaf_name`].
    ///
    /// Splitting rather than canonicalizing the whole path is what makes this
    /// possible at all — `canonicalize` fails on a missing target — and doing
    /// the split *before* the containment check is what keeps it safe: the
    /// parent is a real directory, so it canonicalizes, so `..` and symlinks
    /// are resolved by the filesystem rather than by string arithmetic.
    ///
    /// # Errors
    /// Anything [`Self::resolve`] returns for the parent, `parent is not a
    /// directory` if the parent is a file, or a [`valid_leaf_name`] message.
    pub(crate) fn resolve_new(&self, path: &str, verb: &str) -> Result<NewSandboxedPath, String> {
        let (parent, leaf) = match path.rsplit_once('/') {
            Some((parent, leaf)) => (parent, leaf),
            // No separator: a direct child of the root itself.
            None => ("", path),
        };
        valid_leaf_name(leaf)?;
        // `resolve` cannot take an empty path (it would canonicalize the root
        // and then be asked to contain itself, which it does), so "" is spelled
        // "." — the root as its own parent.
        let parent_spec = if parent.is_empty() { "." } else { parent };
        let resolved = self.resolve(parent_spec, verb)?;
        if !resolved.as_path().is_dir() {
            // Distinct from `SandboxRoot::validate`'s own `cwd is not a
            // directory` (a different failure, on the root itself): this one
            // names the thing the caller actually touched — the *parent* of
            // the name they are trying to create — so a right-click-a-file
            // mistake does not read like the sandbox root vanished.
            return Err("parent is not a directory".to_string());
        }
        Ok(NewSandboxedPath {
            parent: resolved.as_path().to_path_buf(),
            leaf: leaf.to_string(),
        })
    }

    /// Resolve a frontend-supplied `path` as the **entry itself** — not
    /// whatever it points at — and confirm something is actually there.
    ///
    /// Shares [`Self::resolve_new`]'s split (canonicalize the parent through
    /// [`Self::resolve`], validate the leaf through [`valid_leaf_name`]) and
    /// adds the one thing `resolve_new` deliberately leaves open: that a leaf
    /// with that name already exists. Checked with `symlink_metadata` (via
    /// [`NewSandboxedPath::exists`]) so a symlink — dangling or not — counts
    /// as "there" without ever being followed.
    ///
    /// Deliberately **not** [`Self::resolve`], which canonicalizes the whole
    /// path: that would swap a symlink for its target (wrong for a caller
    /// whose whole job is to act on the entry a user clicked, not on whatever
    /// it happens to point at) and would happily canonicalize `"."`, `""`, or
    /// `".."` to the sandbox root itself — a delete or rename of "the current
    /// directory" would then pass containment cleanly, because the root *is*
    /// inside the root. Splitting parent from leaf and running
    /// `valid_leaf_name` on the leaf closes that structurally: `"."`, `".."`,
    /// and `""` are all refused as names, so the root can never be named as
    /// an entry in the first place — not by a special-cased check on the
    /// caller's `path`, but by the same rule that already refuses a `.git`
    /// leaf.
    ///
    /// Returns the same [`NewSandboxedPath`] `resolve_new` does — "new" there
    /// names the shape the type proves (a validated parent plus a leaf that
    /// cannot traverse out of it), not a claim about whether the leaf exists.
    /// This is the producer that hands one back with the leaf's existence
    /// already confirmed rather than left open.
    ///
    /// # Errors
    /// Anything [`Self::resolve_new`] returns, or the tagged
    /// [`WRITE_MISSING_ERROR`] if nothing is at the resolved location.
    pub(crate) fn resolve_existing(
        &self,
        path: &str,
        verb: &str,
    ) -> Result<NewSandboxedPath, String> {
        let candidate = self.resolve_new(path, verb)?;
        if candidate.exists() {
            Ok(candidate)
        } else {
            Err(tagged_failure(FILE_MISSING, WRITE_MISSING_ERROR))
        }
    }
}

/// A canonicalized path proven to sit inside the [`SandboxRoot`] it was
/// resolved against.
///
/// **Unconstructable outside this module.** The field is private, the only
/// producers are [`SandboxRoot::resolve`] and
/// [`SandboxRoot::resolve_for_listing`], and there is deliberately no
/// `Default`, no `From<PathBuf>`, no `Deserialize`, and no `pub(crate)`
/// helper that wraps an unchecked path. A function that accepts one therefore
/// cannot be reached with a path that never passed the containment check —
/// which is the guarantee the old `resolve_within` returning a bare `PathBuf`
/// could only ask callers to remember.
#[derive(Debug)]
pub(crate) struct SandboxedPath(PathBuf);

impl SandboxedPath {
    /// The resolved target, for the filesystem calls the commands make on it.
    pub(crate) fn as_path(&self) -> &Path {
        &self.0
    }

    /// `stat` the target and refuse anything that is not a plain file — the
    /// check `read_file`, `write_file`, and `read_baseline` each need before
    /// they touch it, shared here so all three keep making it identically.
    ///
    /// A directory would otherwise surface a confusing raw `EISDIR` from a
    /// binary sniff (or a raw git error), and a FIFO inside the sandboxed root
    /// would block that same read forever, wedging a blocking-pool thread. The
    /// `Metadata` is returned rather than discarded because two of the three
    /// callers go on to use the very same snapshot for their size check,
    /// conflict guard, and mode preservation — no repeated `stat`s.
    ///
    /// # Errors
    /// The underlying `io::Error`'s message if the target cannot be `stat`ed,
    /// or `path is not a file`.
    /// This target spelled the one way it is safe to hand to `git`: **relative
    /// to `root`, derived from the resolved path**, never from the string the
    /// frontend sent.
    ///
    /// LOAD-BEARING — the raw request and the resolved path are not
    /// interchangeable, and git sides with the raw one:
    ///
    /// - [`resolve_within`] settles containment on the **canonical** path,
    ///   which follows symlinks. git resolves `..` **lexically**, which does
    ///   not. A symlink pointing at a deeper directory inside the root makes
    ///   the two disagree in the escaping direction — `short/../../f` can
    ///   canonicalize to a file inside the root while git writes to one above
    ///   it. Only the resolved spelling closes that.
    /// - A pathspec is wildmatched, so glob metacharacters in an ordinary
    ///   filename widen the match. `app/[slug]/page.tsx` — how every Next.js
    ///   repo spells a dynamic route — also matches `app/s/page.tsx`. Callers
    ///   that hand this to a *pathspec* (rather than the literal `<rev>:<path>`
    ///   half of a `rev-parse`) must therefore prefix `:(literal)`; keep the
    ///   `./` after it so a leading `-` still can't read as a flag.
    ///
    /// # Errors
    /// `path escapes cwd` if this target is somehow not under `root` (it
    /// always is, by construction — the check is kept so the invariant is
    /// enforced rather than assumed), or `path is not valid UTF-8`.
    pub(crate) fn relative_to(&self, root: &SandboxRoot) -> Result<&str, String> {
        self.0
            .strip_prefix(root.as_path())
            .map_err(|_| "path escapes cwd".to_string())?
            .to_str()
            .ok_or_else(|| "path is not valid UTF-8".to_string())
    }

    pub(crate) fn file_metadata(&self) -> Result<std::fs::Metadata, String> {
        let metadata = std::fs::metadata(&self.0).map_err(|e| e.to_string())?;
        if metadata.is_file() {
            Ok(metadata)
        } else {
            Err("path is not a file".to_string())
        }
    }
}

/// The longest single filename every filesystem Kriyon targets accepts.
const MAX_LEAF_BYTES: usize = 255;

/// Validate the final segment of a not-yet-existing path as a *name*.
///
/// LOAD-BEARING. [`SandboxRoot::resolve_new`] settles containment on the
/// canonical parent and then joins this on. That join is safe only because a
/// value passing here cannot traverse: no separator, no `.`/`..`, no NUL. Relax
/// any one of those and the parent's containment stops implying the target's.
///
/// `.git` is refused here too, so a name cannot create the one directory the
/// sandbox otherwise refuses to write inside.
///
/// `pub(crate)` (not just used internally by [`SandboxRoot::resolve_new`])
/// because `entry_cmd::rename_entry_sync` must run this on a frontend-supplied
/// `new_name` *before* splicing it into a path string: `resolve_new` derives
/// its own parent/leaf split from the *last* `/` in whatever string it is
/// given, so a `new_name` that already contains a `/` (e.g. `"../escaped.ts"`)
/// can smuggle a bogus parent segment past that split rather than being
/// caught by it. Validating the caller-supplied leaf on its own, with this
/// exact rule, is what closes that gap.
///
/// # Errors
/// A message naming the rule the candidate broke.
pub(crate) fn valid_leaf_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("name must not be empty".to_string());
    }
    if name.len() > MAX_LEAF_BYTES {
        return Err("name is too long".to_string());
    }
    if name == "." || name == ".." {
        return Err("name must not be . or ..".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("name must not contain a path separator".to_string());
    }
    if name.eq_ignore_ascii_case(".git") {
        return Err("refusing to use .git as a name".to_string());
    }
    Ok(())
}

/// A path proven to land inside a [`SandboxRoot`] via the parent/leaf split —
/// canonicalize the parent, validate the leaf on its own so it cannot
/// traverse. What the split leaves open is whether the leaf itself exists,
/// and the two producers settle that differently: [`SandboxRoot::resolve_new`]
/// leaves it unknown (the target of a create, or a rename's destination —
/// "new" names the shape, not a guarantee), while [`SandboxRoot::resolve_existing`]
/// confirms it before handing one back (the source of a rename, or a delete's
/// target).
///
/// Deliberately NOT a [`SandboxedPath`]. That type means "this canonicalized,
/// as a whole, inside the root"; this one means "its parent did, and its leaf
/// cannot leave that parent". A function wanting a path proven by whole-path
/// canonicalization must not silently accept this instead, so they are
/// separate types with no conversion between them.
///
/// Unconstructable outside this module, the same discipline
/// [`SandboxedPath`] holds: private fields, and [`SandboxRoot::resolve_new`]
/// and [`SandboxRoot::resolve_existing`] are the only producers.
#[derive(Debug)]
pub(crate) struct NewSandboxedPath {
    parent: PathBuf,
    leaf: String,
}

impl NewSandboxedPath {
    /// The target itself — the canonical parent with the validated leaf joined.
    pub(crate) fn as_path(&self) -> PathBuf {
        self.parent.join(&self.leaf)
    }

    /// Whether something is already there. Callers decide what that means:
    /// a create refuses, a rename target refuses, nothing silently overwrites.
    pub(crate) fn exists(&self) -> bool {
        self.as_path().symlink_metadata().is_ok()
    }
}

#[cfg(test)]
mod tests {
    use parking_lot::Mutex;

    use super::*;
    use crate::store::{ProjectRow, Store};
    use kriyon_core::failure::tagged_failure;

    /// Mirrors `file_cmd::tests::store_with_project_root` and
    /// `git_cmd::tests::store_with_project_root`: an in-memory store with a
    /// single registered project root, so these tests exercise the same
    /// known-roots allowlist [`SandboxRoot::validate`] checks in production.
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

    #[test]
    fn validate_refuses_an_empty_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());
        assert_eq!(
            SandboxRoot::validate(&store, "").unwrap_err(),
            "cwd must not be empty"
        );
    }

    #[test]
    fn validate_refuses_a_flag_like_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());
        assert_eq!(
            SandboxRoot::validate(&store, "--upload-pack=evil").unwrap_err(),
            "cwd must not start with '-'"
        );
    }

    #[test]
    fn validate_refuses_a_cwd_that_is_not_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());
        assert_eq!(
            SandboxRoot::validate(&store, "/no/such/dir/anywhere").unwrap_err(),
            "cwd is not a directory"
        );
    }

    #[test]
    fn validate_refuses_a_cwd_outside_every_known_root() {
        let outside = tempfile::tempdir().unwrap();
        let registered = tempfile::tempdir().unwrap();
        let store = store_with_project_root(&registered.path().to_string_lossy());
        assert_eq!(
            SandboxRoot::validate(&store, outside.path().to_str().unwrap()).unwrap_err(),
            "cwd is not a known session or project root"
        );
    }

    /// The non-UTF-8 half of [`SandboxRoot::validate`], exercised against
    /// [`canonical_path_to_str`] directly rather than end-to-end: `cwd` arrives
    /// as a `&str`, so the only way `validate` reaches a non-UTF-8 path is a
    /// symlink resolving onto one — and APFS refuses to create such a name at
    /// all (`EILSEQ`), so the end-to-end setup cannot exist on the platform we
    /// ship on. The refusal itself still must not regress into
    /// `to_string_lossy`, which would hand git a path that is NOT the validated
    /// directory.
    #[test]
    #[cfg(unix)]
    fn a_non_utf8_canonical_path_is_refused_rather_than_lossily_substituted() {
        use std::os::unix::ffi::OsStrExt as _;

        let bad = PathBuf::from(std::ffi::OsStr::from_bytes(b"/tmp/bad\xFF"));
        assert_eq!(
            canonical_path_to_str(&bad).unwrap_err(),
            "cwd is not valid UTF-8"
        );
    }

    #[test]
    fn validate_canonicalizes_the_accepted_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let store = store_with_project_root(&root.to_string_lossy());

        let sandbox = SandboxRoot::validate(&store, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(sandbox.as_path(), root);
        assert_eq!(sandbox.as_str(), root.to_str().unwrap());
    }

    #[test]
    fn resolve_refuses_a_dot_dot_escape() {
        let outer = tempfile::tempdir().unwrap();
        let cwd = outer.path().join("cwd");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::write(outer.path().join("secret.txt"), "top secret").unwrap();
        let store = store_with_project_root(&cwd.to_string_lossy());
        let root = SandboxRoot::validate(&store, cwd.to_str().unwrap()).unwrap();

        assert_eq!(
            root.resolve("../secret.txt", "read").unwrap_err(),
            "path escapes cwd"
        );
        assert_eq!(
            root.resolve_for_listing("../secret.txt").unwrap_err(),
            "path escapes cwd"
        );
    }

    #[test]
    fn resolve_refuses_a_path_that_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());
        let root = SandboxRoot::validate(&store, dir.path().to_str().unwrap()).unwrap();

        assert_eq!(
            root.resolve("nope.txt", "read").unwrap_err(),
            tagged_failure(FILE_MISSING, WRITE_MISSING_ERROR)
        );
    }

    #[test]
    fn resolve_refuses_dot_git_with_the_callers_verb() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/config"), "[remote]\n").unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());
        let root = SandboxRoot::validate(&store, dir.path().to_str().unwrap()).unwrap();

        assert_eq!(
            root.resolve(".git/config", "read").unwrap_err(),
            "refusing to read inside .git"
        );
        assert_eq!(
            root.resolve(".git/config", "write").unwrap_err(),
            "refusing to write inside .git"
        );
    }

    #[test]
    fn resolve_for_listing_still_reaches_dot_git_itself() {
        // Behavior pin, not an endorsement: `list_dir` has never refused a
        // `.git` *directory* target — it filters `.git` entries by name while
        // listing instead — so the listing constructor must not start
        // refusing it. Making it refuse would be a behavior change, out of
        // scope for a type-level refactor; see `resolve_for_listing`'s docs.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());
        let root = SandboxRoot::validate(&store, dir.path().to_str().unwrap()).unwrap();

        assert!(root.resolve_for_listing(".git").is_ok());
    }

    #[test]
    fn file_metadata_refuses_a_target_that_is_not_a_plain_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("subdir")).unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());
        let root = SandboxRoot::validate(&store, dir.path().to_str().unwrap()).unwrap();

        let resolved = root.resolve("subdir", "read").unwrap();
        assert_eq!(resolved.file_metadata().unwrap_err(), "path is not a file");
    }

    #[test]
    fn file_metadata_returns_the_targets_metadata_for_a_plain_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        let store = store_with_project_root(&dir.path().to_string_lossy());
        let root = SandboxRoot::validate(&store, dir.path().to_str().unwrap()).unwrap();

        let resolved = root.resolve("a.txt", "read").unwrap();
        assert_eq!(resolved.file_metadata().unwrap().len(), 5);
    }

    /// A leaf is a *name*, not a path: the whole reason `resolve_new` can trust
    /// a target that does not exist yet is that the parent was canonicalized and
    /// the leaf cannot walk out of it.
    #[test]
    fn valid_leaf_name_refuses_anything_that_could_traverse() {
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "a\0b",
            ".git",
            &"x".repeat(256),
            &"é".repeat(200),
        ] {
            assert!(
                valid_leaf_name(bad).is_err(),
                "leaf {bad:?} must be refused"
            );
        }
        for good in ["a.txt", "New Folder", ".env", "a.b.c", &"x".repeat(255)] {
            assert!(
                valid_leaf_name(good).is_ok(),
                "leaf {good:?} must be allowed"
            );
        }
    }

    #[test]
    fn resolve_new_accepts_a_name_under_an_existing_directory() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join("src")).expect("mkdir");
        let store = store_with_project_root(&root.path().to_string_lossy());
        let sandbox = SandboxRoot::validate(&store, root.path().to_str().unwrap()).expect("root");

        let target = sandbox.resolve_new("src/new.ts", "write").expect("resolve");

        assert_eq!(
            target.as_path(),
            root.path()
                .canonicalize()
                .expect("canon")
                .join("src/new.ts")
        );
        assert!(
            !target.exists(),
            "the point of this type is that it need not exist yet"
        );
    }

    #[test]
    fn resolve_new_refuses_a_parent_outside_the_root() {
        let root = tempfile::tempdir().expect("temp root");
        let cwd = root.path().join("cwd");
        std::fs::create_dir(&cwd).expect("mkdir");
        let store = store_with_project_root(&cwd.to_string_lossy());
        let sandbox = SandboxRoot::validate(&store, cwd.to_str().unwrap()).expect("root");

        let err = sandbox.resolve_new("../evil.txt", "write").unwrap_err();

        assert_eq!(err, "path escapes cwd");
    }

    #[test]
    fn resolve_new_refuses_a_dot_git_parent() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join(".git")).expect("mkdir");
        let store = store_with_project_root(&root.path().to_string_lossy());
        let sandbox = SandboxRoot::validate(&store, root.path().to_str().unwrap()).expect("root");

        let err = sandbox.resolve_new(".git/hook", "write").unwrap_err();

        assert_eq!(err, "refusing to write inside .git");
    }

    /// The escape the 2026-08-30 security review found in `discard_file_changes`,
    /// aimed at the new resolver: a symlink to a deeper directory plus `..`
    /// disagrees with a lexical reading. Containment is settled on the canonical
    /// parent, so the leaf lands wherever the parent really is — inside the root.
    ///
    /// Unix-only (symlinks), and deliberately `#[cfg]`'d on the whole test, not
    /// just the `symlink` call: this is the one case among the six that a purely
    /// lexical `..`-normalizer would get wrong (it would resolve to
    /// `root/new.txt`, not `root/a/b/new.txt`) — `../evil.txt` above passes
    /// under a lexical stub too. Gating only the symlink call would leave the
    /// assertions running against a `short` that was never created, panicking
    /// on `.expect("resolve")` on every non-unix target instead of skipping.
    #[test]
    #[cfg(unix)]
    fn resolve_new_settles_containment_on_the_canonical_parent() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir_all(root.path().join("a/b/c")).expect("mkdir");
        std::os::unix::fs::symlink("a/b/c", root.path().join("short")).expect("symlink");
        let store = store_with_project_root(&root.path().to_string_lossy());
        let sandbox = SandboxRoot::validate(&store, root.path().to_str().unwrap()).expect("root");

        let target = sandbox
            .resolve_new("short/../new.txt", "write")
            .expect("resolve");

        let canonical_root = root.path().canonicalize().expect("canon");
        assert_eq!(target.as_path(), canonical_root.join("a/b/new.txt"));
        assert!(
            target.as_path().starts_with(&canonical_root),
            "the resolved target must sit inside the root"
        );
    }

    /// An empty parent means the root itself, which is the "right-click the tree's
    /// empty area" case.
    #[test]
    fn resolve_new_treats_a_bare_name_as_a_child_of_the_root() {
        let root = tempfile::tempdir().expect("temp root");
        let store = store_with_project_root(&root.path().to_string_lossy());
        let sandbox = SandboxRoot::validate(&store, root.path().to_str().unwrap()).expect("root");

        let target = sandbox.resolve_new("top.txt", "write").expect("resolve");

        assert_eq!(
            target.as_path(),
            root.path().canonicalize().expect("canon").join("top.txt")
        );
    }

    #[test]
    fn resolve_new_refuses_a_parent_that_is_a_file() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::write(root.path().join("README.md"), "hi").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());
        let sandbox = SandboxRoot::validate(&store, root.path().to_str().unwrap()).expect("root");

        let err = sandbox
            .resolve_new("README.md/new.txt", "write")
            .unwrap_err();

        assert_eq!(err, "parent is not a directory");
    }

    #[test]
    fn exists_is_true_for_a_target_already_on_disk() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::write(root.path().join("taken.txt"), "hi").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());
        let sandbox = SandboxRoot::validate(&store, root.path().to_str().unwrap()).expect("root");

        let target = sandbox.resolve_new("taken.txt", "write").expect("resolve");

        assert!(
            target.exists(),
            "a name already on disk must report as taken"
        );
    }

    /// `exists()` must use `symlink_metadata`, not `metadata`: a dangling
    /// symlink is still something sitting at that path — a create must still
    /// refuse it rather than silently following or replacing it — even though
    /// `metadata()` (which follows the link) would report nothing there.
    #[test]
    #[cfg(unix)]
    fn exists_is_true_for_a_dangling_symlink() {
        let root = tempfile::tempdir().expect("temp root");
        std::os::unix::fs::symlink("nowhere", root.path().join("dangling")).expect("symlink");
        let store = store_with_project_root(&root.path().to_string_lossy());
        let sandbox = SandboxRoot::validate(&store, root.path().to_str().unwrap()).expect("root");

        let target = sandbox.resolve_new("dangling", "write").expect("resolve");

        assert!(
            std::fs::metadata(target.as_path()).is_err(),
            "the symlink's target must not exist"
        );
        assert!(
            target.exists(),
            "symlink_metadata must still see the dangling link itself"
        );
    }
}
