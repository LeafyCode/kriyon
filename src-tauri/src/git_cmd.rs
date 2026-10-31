//! The git command family: thin shell-outs to the `git` CLI, feeding their
//! stdout into the pure parsers in `kriyon_core::git`. Each public function is
//! registered as a Tauri command directly (the same one-home-per-command-family
//! shape as `completion_cmd` / `links_cmd`); the logic itself stays plain Rust,
//! so the unit tests below exercise it without the Tauri shell.
//!
//! **Every command here is `#[tauri::command(async)]`, and that is required,
//! not stylistic.** A non-async Tauri command runs on the main thread, which on
//! macOS is the app's run loop — so a blocking `git` spawn there freezes the
//! entire window: no keystrokes, no repaint, no terminal output. Each of these
//! shells out and waits, and `output_with_retry` additionally *sleeps* on the
//! calling thread (up to ~1.5s under fork pressure). `repo_status` is the one
//! that made this matter: it re-runs on every session switch and every session
//! status transition, once per subscriber, so a rail of worktree sessions all
//! settling at once used to queue several blocking `git status` runs onto the
//! run loop. None of these touch `AppKit`, so none need the main thread.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use kriyon_core::failure::tagged_failure;
use kriyon_core::git::{
    parse_diff, parse_status, plan_untracked_reads, untracked_as_diff, BudgetExceeded,
    MergeOutcome, RepoStatus, SessionDiff,
};
use kriyon_core::session::SessionId;

use crate::git_run::GitRun;
use crate::sandbox::{reject_flag_like, SandboxRoot};
use crate::StoreState;

/// Run `git -C <repo_path> <args...>` and return stdout as text.
///
/// A one-line delegation to [`GitRun`], kept because 15 call sites in this
/// module want exactly this shape (buffered, non-zero is an error) and reading
/// `run_git(repo, &["diff", …])` at each of them beats a builder chain.
///
/// # Errors
/// Returns an error string if git cannot be spawned, or if it exits non-zero
/// (in which case the trimmed stderr is returned).
fn run_git(repo_path: &str, args: &[&str]) -> Result<String, String> {
    GitRun::new(repo_path).args(args).text()
}

/// Get the branch / ahead / behind / dirty status of the repo at `repo_path`.
///
/// # Errors
/// Returns an error string if the git invocation fails.
#[tauri::command(async)]
pub fn repo_status(repo_path: &str) -> Result<RepoStatus, String> {
    reject_flag_like("repo_path", repo_path)?;
    let stdout = run_git(repo_path, &["status", "--porcelain=v2", "--branch"])?;
    Ok(parse_status(&stdout))
}

/// Create a new worktree at `path` on a freshly-created branch `branch`, with
/// the person's [Shell PATH] so its post-checkout hook (git-lfs, say) finds
/// their tools when the app was opened from the Dock.
///
/// # Errors
/// Returns an error string if git did not create the worktree.
#[tauri::command(async)]
pub fn create_worktree(repo_path: &str, branch: &str, path: &str) -> Result<(), String> {
    create_worktree_with(repo_path, branch, path, crate::shell_path::user_path())
}

/// [`create_worktree`] with git and its hooks run on `shell_path` (`None`
/// keeps the app's own PATH).
///
/// `git worktree add` also exits non-zero when only the repo's post-checkout
/// hook failed, after the worktree was made. That counts as created — git's
/// docs say the hook cannot change the checkout's outcome — so the caller
/// opens it rather than retrying onto a branch that is now taken. Only a
/// folder that was not there before the call counts: an existing worktree on
/// the same branch is not one this call made.
pub(crate) fn create_worktree_with(
    repo_path: &str,
    branch: &str,
    path: &str,
    shell_path: Option<&str>,
) -> Result<(), String> {
    reject_flag_like("repo_path", repo_path)?;
    reject_flag_like("branch", branch)?;
    reject_flag_like("path", path)?;
    let existed = std::path::Path::new(path).exists();
    // `--` terminates option parsing so `path` is always treated as positional.
    let mut add = GitRun::new(repo_path).args(["worktree", "add", "-b", branch, "--", path]);
    if let Some(shell_path) = shell_path {
        add = add.env("PATH", shell_path);
    }
    match add.text() {
        Ok(_) => Ok(()),
        Err(e) if !existed && is_worktree_on(path, branch) => {
            eprintln!("kriyon: worktree {path} created, but a git hook failed: {e}");
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// True when `path` is the root of a git worktree checked out on `branch`.
fn is_worktree_on(path: &str, branch: &str) -> bool {
    let Ok(out) = run_git(
        path,
        &["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"],
    ) else {
        return false;
    };
    let mut lines = out.lines();
    let (Some(top), Some(head)) = (lines.next(), lines.next()) else {
        return false;
    };
    // Canonical on both sides: `rev-parse` walks up to a parent repo when
    // `path` is not a worktree, and macOS's `/tmp` is `/private/tmp`.
    let same_dir = match (std::fs::canonicalize(top), std::fs::canonicalize(path)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    same_dir && head == branch
}

/// Remove the worktree at `path`. Git refuses a worktree with uncommitted or
/// untracked files unless `force` is set — callers must only pass `force`
/// after the user explicitly confirmed discarding those changes.
///
/// # Errors
/// Returns an error string if the git invocation fails (including the plain
/// removal of a dirty worktree).
#[tauri::command(async)]
pub fn remove_worktree(repo_path: &str, path: &str, force: bool) -> Result<(), String> {
    reject_flag_like("repo_path", repo_path)?;
    reject_flag_like("path", path)?;
    let args: &[&str] = if force {
        &["worktree", "remove", "--force", "--", path]
    } else {
        &["worktree", "remove", "--", path]
    };
    run_git(repo_path, args)?;
    Ok(())
}

/// Resolve the repo's default branch (the diff base): `origin/HEAD` if set,
/// else the first of local `main` / `master` that exists.
///
/// # Errors
/// Returns an error string if none can be determined or git fails to run.
#[tauri::command(async)]
pub fn default_branch(repo_path: &str) -> Result<String, String> {
    reject_flag_like("repo_path", repo_path)?;
    if let Ok(head) = run_git(
        repo_path,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) {
        if let Some(stripped) = head.trim().strip_prefix("origin/") {
            if !stripped.is_empty() {
                return Ok(stripped.to_string());
            }
        }
    }
    for candidate in ["main", "master"] {
        if run_git(repo_path, &["rev-parse", "--verify", "--quiet", candidate]).is_ok() {
            return Ok(candidate.to_string());
        }
    }
    Err("could not determine a base branch".to_string())
}

/// How many commits the worktree at `worktree_path` has that its repo's
/// default branch doesn't: work done there that hasn't been merged back.
/// Backs the sidebar's "Not merged" chip.
///
/// # Errors
/// Returns an error string if `worktree_path` is not a known session/project
/// root, no base branch can be found, or git fails.
#[tauri::command(async)]
#[allow(clippy::needless_pass_by_value)]
pub fn unmerged_commits(
    store: tauri::State<'_, StoreState>,
    worktree_path: String,
) -> Result<u32, String> {
    unmerged_commits_for(store.inner(), &worktree_path)
}

/// [`unmerged_commits`] over a plain `&StoreState`, so its tests run the real
/// validation (see [`diff_worktree_for`]).
///
/// # Errors
/// See [`unmerged_commits`].
fn unmerged_commits_for(store: &StoreState, worktree_path: &str) -> Result<u32, String> {
    let worktree = SandboxRoot::validate(store, worktree_path)?;
    let worktree = worktree.as_str();
    let base = default_branch(worktree)?;
    // A squash or rebase merge never makes the branch's commits part of the
    // base, and a merge on the hosting site reaches only `origin/<base>` until
    // someone pulls. So the work counts as merged once merging it into either
    // would change nothing; only then is the commit count wrong.
    if [base.clone(), format!("origin/{base}")]
        .iter()
        .any(|base_ref| merge_adds_nothing(worktree, base_ref))
    {
        return Ok(0);
    }
    let range = format!("{base}..HEAD");
    run_git(worktree, &["rev-list", "--count", &range, "--"])?
        .trim()
        .parse()
        .map_err(|e| format!("unexpected rev-list output: {e}"))
}

/// Whether merging `HEAD` into `base_ref` would leave `base_ref`'s files as
/// they are. `false` when `base_ref` doesn't exist or the merge conflicts.
fn merge_adds_nothing(repo: &str, base_ref: &str) -> bool {
    let Ok(base_tree) = run_git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base_ref}^{{tree}}"),
        ],
    ) else {
        return false;
    };
    run_git(repo, &["merge-tree", "--write-tree", base_ref, "HEAD"])
        .is_ok_and(|merged| merged.lines().next() == Some(base_tree.trim()))
}

/// Diff a worktree's committed changes against `base` (`<base>...HEAD`, the
/// three-dot form = changes since the branch diverged). Backs the merge
/// [Review panel].
///
/// `worktree_path` is validated against the app's known session/project roots
/// like every other path-taking command here. It was the one that wasn't:
/// alone among the three producers it took a frontend-supplied path straight to
/// git, and alone among them it also missed the big-file threshold and rename
/// detection. All three now come from [`session_diff`].
///
/// # Errors
/// Returns an error string if `worktree_path`/`base` look like flags,
/// `worktree_path` is not a known session/project root, or git fails.
#[tauri::command(async)]
#[allow(clippy::needless_pass_by_value)]
pub fn diff_worktree(
    store: tauri::State<'_, StoreState>,
    worktree_path: String,
    base: String,
) -> Result<SessionDiff, String> {
    diff_worktree_for(store.inner(), &worktree_path, &base)
}

/// [`diff_worktree`] over a plain `&StoreState` — the shape the store-taking
/// diff commands in this module use so their tests exercise the real
/// validation rather than a transcription of it (`tauri::State` cannot be
/// built outside a running app). The validation itself is
/// [`SandboxRoot::validate`]; this shim survives only because
/// [`session_diff`]'s `&str` repo argument (and `budget`/`base`) still has to
/// be threaded through.
///
/// # Errors
/// See [`diff_worktree`].
fn diff_worktree_for(
    store: &StoreState,
    worktree_path: &str,
    base: &str,
) -> Result<SessionDiff, String> {
    let repo = SandboxRoot::validate(store, worktree_path)?;
    session_diff(repo.as_str(), DiffAnchor::Branch(base), Budget::DEFAULT)
}

/// Resolve `base` (a branch name, `HEAD`, or any other ref git understands)
/// to its short sha, for a trustworthy diff baseline label. Returns `None`
/// rather than an error when the ref can't be resolved — a label degrades
/// gracefully; the diff itself must not fail over a missing sha.
fn resolve_short_sha(repo_path: &str, base: &str) -> Option<String> {
    let sha = run_git(
        repo_path,
        &["rev-parse", "--short", "--verify", "--quiet", base],
    )
    .ok()?;
    let sha = sha.trim();
    if sha.is_empty() {
        None
    } else {
        Some(sha.to_string())
    }
}

/// Untracked-file content size cap for [`diff_working_tree`]: files larger
/// than this are treated the same as binary (skipped), so a stray build
/// artifact or log file can't balloon the diff payload.
const UNTRACKED_MAX_BYTES: u64 = 1_000_000;

/// [Working-tree budget]: how many untracked paths the diff pipeline will look
/// at before refusing the tree outright.
///
/// Generous on purpose — an un-ignored build output of a few thousand files
/// should still render, however unwieldy. What this exists to stop is the shape
/// nothing downstream survives: the repo that prompted it carried 87,523
/// untracked files (a 6.7 GB unpacked toolchain committed nowhere), which made
/// `git add -A` write 2 GB of loose objects and the untracked pass read 1.5 GB
/// of file content into one IPC payload.
const MAX_UNTRACKED_FILES: usize = 10_000;

/// [Working-tree budget]: total untracked *bytes* [`snapshot_tree`] will let
/// `git add -A` hash into `.git/objects`.
///
/// Separate from [`MAX_UNTRACKED_BYTES`], and far larger, because it bounds a
/// different thing: that one caps what crosses the IPC boundary as diff text,
/// this one caps what gets written to disk as git objects. Without it the file
/// ceiling alone is not enough — 9,999 untracked files of 999 KB each pass it
/// comfortably and still ask git to hash ~10 GB, which is the original freeze
/// arriving inside the budget meant to prevent it.
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;

/// [Working-tree budget]: total untracked *content* one [`SessionDiff`] may
/// carry. [`UNTRACKED_MAX_BYTES`] caps a single file and cannot see the
/// aggregate — ten thousand 200 KB files each pass it individually while
/// together being 2 GB of JSON. This is the cap that actually bounds the
/// payload; the per-file one bounds a single card.
const MAX_UNTRACKED_BYTES: u64 = 8_000_000;

/// Prefix on [`snapshot_tree`]'s error when the [Working-tree budget]'s file
/// ceiling is passed, so the frontend can degrade to the (also budget-aware)
/// `diff_working_tree` instead of parking a raw error.
///
/// Deliberately distinct from [`BASELINE_OBJECT_MISSING_PREFIX`], whose
/// degrade path *also* clears the session's stored `baselineOid`: this
/// condition says nothing about the baseline, which is still a perfectly good
/// object. The tree is temporarily too big; gitignoring the offending directory
/// makes the same baseline work again. `state/changes.ts` re-declares this
/// exact string as `WORKING_TREE_TOO_LARGE_PREFIX` — kept in sync by hand,
/// like every other half of a [Command failure kind]'s wording. The two
/// conditions are additionally told apart by their `tagged_failure` slug
/// ([`OVER_BUDGET`] vs. [`BASELINE_PRUNED`]) — this prefix alone is no longer
/// what the frontend classifies on, only what it displays.
pub const WORKING_TREE_TOO_LARGE_PREFIX: &str = "working tree too large: ";

/// [`tagged_failure`] slug for [`WORKING_TREE_TOO_LARGE_PREFIX`]'s two error
/// sites in [`snapshot_tree`] — `src/ipc/failures.ts`'s `commandFailure` maps
/// this exact spelling to `"overBudget"`. See [Command failure kind].
const OVER_BUDGET: &str = "over-budget";

/// The two ceilings of a [Working-tree budget], passed explicitly rather than
/// read from the consts at each use site so the tests can cross one with a
/// handful of files instead of ten thousand.
// `max_` on every field is the point: each one is a ceiling, and dropping the
// prefix would leave `untracked_files`/`untracked_bytes` reading as counts.
#[allow(clippy::struct_field_names)]
#[derive(Clone, Copy, Debug)]
struct Budget {
    max_untracked_files: usize,
    max_untracked_bytes: u64,
    max_snapshot_bytes: u64,
}

impl Budget {
    /// What every command uses; only tests construct anything else.
    const DEFAULT: Self = Self {
        max_untracked_files: MAX_UNTRACKED_FILES,
        max_untracked_bytes: MAX_UNTRACKED_BYTES,
        max_snapshot_bytes: MAX_SNAPSHOT_BYTES,
    };
}

/// [`untracked_paths_bounded`]'s result.
///
/// The two states are exclusive by construction: either the ceiling held and
/// `paths` is the complete untracked list, or it didn't and `paths` is empty
/// (a partial prefix is worse than nothing — a caller could mistake it for the
/// changeset) with `seen` reporting how many were counted before stopping.
#[derive(Debug)]
struct BoundedUntracked {
    /// Every untracked path, or empty when `exceeded`.
    paths: Vec<String>,
    /// How many untracked paths were counted. Exact when `!exceeded`; a lower
    /// bound otherwise, since the walk stopped as soon as it knew.
    seen: usize,
    exceeded: bool,
}

/// List `repo_path`'s untracked files, stopping as soon as more than `limit` of
/// them exist.
///
/// Two deliberate choices, both load-bearing:
///
/// **Streamed, not buffered.** The point of a ceiling is that a pathological
/// tree is never fully walked. `git ls-files` writes into a pipe we stop
/// reading, so ending the read ends the walk (measured on the reported repo:
/// ~390 ms to bail versus ~910 ms to enumerate all 87,523). `output()` would
/// wait for the whole thing and defeat the exercise, which is why this uses
/// [`spawn_piped_with_retry`] instead of [`output_with_retry`].
///
/// **`ls-files --others`, not `status --porcelain=v1 -uall`.** Same set of
/// paths, but `ls-files` is plumbing: it does not refresh (and re-write) the
/// repo's real index the way `status` does, and with `-z` it emits raw path
/// bytes instead of the C-quoted, octal-escaped form that needed decoding.
///
/// # Errors
/// Returns an error string if git cannot be spawned, or exits non-zero before
/// the ceiling was reached (once it is, the non-zero exit is our own kill).
fn untracked_paths_bounded(repo_path: &str, limit: usize) -> Result<BoundedUntracked, String> {
    let (paths, seen, exceeded) = stream_ls_files(repo_path, &[], limit)?;
    Ok(BoundedUntracked {
        // Nothing downstream reads the paths of a tree it is about to refuse,
        // and a truncated list is a trap, so it is dropped rather than kept.
        paths: if exceeded { Vec::new() } else { paths },
        seen,
        exceeded,
    })
}

/// The bounded `git ls-files` both enumerations share: the untracked listing,
/// read incrementally and stopped as soon as `limit` is passed.
///
/// `extra_args` sits between `--exclude-standard` and `-z`, which is how
/// [`untracked_roots`] asks for the `--directory`-collapsed listing over the
/// same call rather than a second, unbounded one. Everything about *how* the
/// streaming is done — the concurrent stderr drain, the early kill, the read
/// error that must not read as end-of-list — belongs to [`GitRun::stream_nul`].
///
/// # Errors
/// Returns an error string if git cannot be spawned, the read fails, or git
/// exits non-zero before the ceiling was reached.
fn stream_ls_files(
    repo_path: &str,
    extra_args: &[&str],
    limit: usize,
) -> Result<(Vec<String>, usize, bool), String> {
    let mut args: Vec<&str> = vec!["ls-files", "--others", "--exclude-standard"];
    args.extend_from_slice(extra_args);
    args.push("-z");
    let got = GitRun::new(repo_path).args(args).stream_nul(limit)?;
    Ok((got.entries, got.seen, got.exceeded))
}

/// The wholly-untracked directories git collapses `repo_path`'s tree into —
/// what to name when refusing an over-budget tree, since "87,523 untracked
/// files" is a dead end and "`opt/` is untracked" is a fix.
///
/// `--directory` is why this is affordable on the very tree that is too big to
/// enumerate: it reports a fully-untracked directory as one entry instead of
/// descending it (measured on the reported repo: 156 ms and 8 entries, against
/// 910 ms and 87,523). Best-effort — a failure yields no names rather than
/// failing the refusal, which is the part that matters.
fn untracked_roots(repo_path: &str, max: usize) -> Vec<String> {
    // Bounded, because `--directory` only collapses a directory that is
    // *wholly* untracked: a tree interleaving untracked and tracked files in the
    // same directories collapses to nothing, and this would then walk every one
    // of them — on the refusal path, i.e. exactly when the tree is already known
    // pathological.
    //
    // The ceiling counts ENTRIES, not directories, and the two are not the same:
    // an earlier cut bounded at `max + 1` entries and filtered afterwards, so 30
    // loose files sorting ahead of `vendor/` left the listing with zero
    // directories and the notice with no remedy at all. The ceiling is therefore
    // far above `max` — the collapsed listing is small by construction, so
    // reading a thousand entries to find twenty directories still costs a
    // fraction of the walk it replaces.
    let Ok((paths, _, _)) = stream_ls_files(
        repo_path,
        &["--directory", "--no-empty-directory"],
        MAX_COLLAPSED_ENTRIES_SCANNED,
    ) else {
        return Vec::new();
    };
    paths
        .into_iter()
        .filter(|path| path.ends_with('/'))
        .take(max)
        .collect()
}

/// How many entries of the `--directory`-collapsed listing [`untracked_roots`]
/// will read looking for directories. Bounds the refusal path without letting a
/// run of loose files at the top of the sort order hide every directory behind
/// them.
const MAX_COLLAPSED_ENTRIES_SCANNED: usize = 1_000;

/// How many untracked directories a [`BudgetExceeded`] names. Generous
/// because the entries are a *prefix* of git's sorted listing, not a ranking:
/// naming five alphabetically-first directories and calling them the cause
/// would point the user at the wrong ones. The `--directory` listing collapses
/// each untracked directory to one line, so it is small by construction and a
/// larger cap costs nothing on any realistic tree.
const MAX_NAMED_UNTRACKED_ROOTS: usize = 20;

/// Read an untracked file's content for [`untracked_as_diff`]. Returns `None`
/// for anything over [`UNTRACKED_MAX_BYTES`], containing a null byte (a common
/// binary-file heuristic), not valid UTF-8, or not a regular file. The caller
/// counts each `None` into [`SessionDiff::omitted_untracked`] rather than
/// dropping it silently.
///
/// The [Working-tree budget]'s *aggregate* ceiling is not checked here — that is
/// [`plan_untracked_reads`]'s job, and holding the same ceiling in two places
/// only invited them to disagree. The per-file cap stays, because it is also the
/// last line of defence for a file that grew between planning and reading.
fn read_untracked_content(repo_path: &str, rel_path: &str) -> Option<String> {
    let repo_root = std::path::Path::new(repo_path).canonicalize().ok()?;
    let full_path = repo_root.join(rel_path);
    // `symlink_metadata` (lstat), never `metadata` (stat): never follow a
    // symlink. git itself exposes an untracked symlink as a link entry (its
    // target *path*), never the target file's bytes — following it here would
    // disclose file content from OUTSIDE the repo sandbox (an untracked link
    // to `~/.ssh/id_ed25519` or `~/.aws/credentials`), the one path in this
    // module that bypasses the [Sandbox root]. Skip anything that isn't a plain
    // file (a symlink's `file_type().is_file()` is false — it's `is_symlink`).
    let metadata = std::fs::symlink_metadata(&full_path).ok()?;
    if !metadata.file_type().is_file() {
        return None;
    }
    if metadata.len() > UNTRACKED_MAX_BYTES {
        return None;
    }
    // Defense in depth against a symlinked *intermediate* directory component,
    // which the final-component lstat above wouldn't catch: require the fully
    // resolved path to still sit within the (canonical) repo root before the
    // read, mirroring `SandboxRoot::resolve`'s component-wise containment.
    let resolved = full_path.canonicalize().ok()?;
    if !resolved.starts_with(&repo_root) {
        return None;
    }
    let bytes = std::fs::read(&resolved).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Total on-disk size of `rel_paths` under `repo_path`, for [`snapshot_tree`]'s
/// byte gate.
///
/// `symlink_metadata`, never `metadata`: a symlink contributes its own size,
/// not its target's, matching [`read_untracked_content`]'s refusal to follow
/// one. A path that cannot be stat'd (deleted between enumeration and here)
/// contributes nothing rather than failing the snapshot.
fn untracked_total_bytes(repo_path: &str, rel_paths: &[String]) -> u64 {
    sizes_of(repo_path, rel_paths)
        .iter()
        .map(|(_, size)| *size)
        .sum()
}

/// Resolve the merge-base commit of `base` and `HEAD` — the commit the
/// current branch actually diverged from. Unlike `base` itself (a branch
/// name whose tip moves as the branch advances), the merge-base commit never
/// moves, which is what makes it a trustworthy diff anchor: `git diff
/// <branch>` two-dot-compares against wherever `<branch>` currently sits, so
/// if it has advanced since divergence, every file it changed since then
/// renders as a fabricated deletion. `git diff <merge-base>` does not have
/// that failure mode.
///
/// Returns `None` (rather than an error) if the merge base can't be
/// resolved — no common ancestor, an unknown ref, or any other git failure —
/// so callers can degrade instead of failing outright.
fn resolve_merge_base(repo_path: &str, base: &str) -> Option<String> {
    let sha = run_git(repo_path, &["merge-base", base, "HEAD"]).ok()?;
    let sha = sha.trim();
    if sha.is_empty() {
        None
    } else {
        Some(sha.to_string())
    }
}

/// Diff the working tree against `base` (`HEAD` when `None`), then append
/// untracked files as synthetic all-added [`FileDiff`](kriyon_core::git::FileDiff)s.
///
/// For an explicit `base` (a worktree session's merge-base branch, e.g.
/// `main`), the diff is taken against `git merge-base <base> HEAD`, not
/// `base` directly — see [`resolve_merge_base`] for why a direct compare
/// fabricates deletions once `base` has advanced. If the merge base can't be
/// resolved, this degrades to diffing against `HEAD` (the same baseline the
/// plain-session path already uses): that can under-report — a worktree
/// session's own committed changes then won't show — but it can never
/// fabricate a deletion for a file the session never touched, which is the
/// failure this whole function exists to prevent. The plain-session path
/// (`base: None` → `HEAD`) has no branch base to resolve and is unaffected.
///
/// The result's `base` field is `base` (or `HEAD`) as given, unchanged — it
/// names what the caller asked to diff against. `base_sha` is the actual
/// commit the diff was taken against (the resolved merge-base, or `HEAD`),
/// resolved to a short sha (best-effort — `None` on resolution failure never
/// fails the diff itself), so the baseline label names the anchor the diff
/// really used, not a ref that may have moved since.
///
/// # Errors
/// Returns an error string if `cwd`/`base` look like flags, or if the git
/// invocation fails.
/// `true` when `cwd` sits inside a git working tree. Used to short-circuit the
/// working-tree diff for a session whose folder is not a repo at all, so git's
/// raw "not a git repository" usage message never reaches the UI. A spawn
/// failure or any non-`true` output is treated as "not a work tree".
fn is_inside_work_tree(cwd: &str) -> bool {
    run_git(cwd, &["rev-parse", "--is-inside-work-tree"]).is_ok_and(|out| out.trim() == "true")
}

/// Where a [Session diff] is measured from. The one axis the three diff
/// commands actually differ on — everything else about producing a
/// [`SessionDiff`] is shared, and used not to be.
#[derive(Clone, Copy, Debug)]
enum DiffAnchor<'a> {
    /// Committed work on a branch: `<base>...HEAD`, the changes since it
    /// diverged. No untracked pass — nothing here is uncommitted.
    Branch(&'a str),
    /// Uncommitted work against a committed ref: `HEAD`, or the merge base with
    /// `base` when one is given. Adds the untracked pass.
    WorkingTree { base: Option<&'a str> },
    /// Everything since a [Session baseline] tree oid. Tree-vs-tree, so tracked
    /// and untracked are covered by the same `git diff` and no separate
    /// untracked pass is needed.
    Baseline(&'a str),
}

/// `-c core.bigFileThreshold=1m`, applied to **every** anchor.
///
/// [`UNTRACKED_MAX_BYTES`] caps only the untracked pass, so without this a
/// modified **tracked** multi-megabyte text file reproduces I3 (one 8.8 MB file
/// → a ~9.6 MB IPC payload). `core.bigFileThreshold` makes git treat any blob at
/// or above the threshold as binary for diffing regardless of content, so it
/// renders as a `Binary files … differ` line instead (measured: 119 bytes) —
/// which `parse_diff` already flags and the frontend already renders as a
/// binary chip.
///
/// It must precede the `diff` subcommand: it is a git top-level config
/// override, not a `diff` flag. It used to be applied at two of the three
/// producers, and the one that missed it (`diff_worktree`, backing the merge
/// [Review panel]) was the one diffing a whole branch.
const BIG_FILE_THRESHOLD: [&str; 2] = ["-c", "core.bigFileThreshold=1m"];

/// Produce a [Session diff] for `repo_path` measured from `anchor`.
///
/// The single producer. Before it, three commands built a `SessionDiff` in
/// three places and answered eight policy questions independently — big-file
/// threshold, rename detection, `cwd` validation, the [Working-tree budget],
/// what `base` means, what a non-repo does, whether omissions are counted —
/// and `diff_worktree` answered three of them wrong, not by decision but
/// because no interface existed through which a fix reached all three.
///
/// `budget` applies to whichever passes can be unbounded:
/// [`DiffAnchor::WorkingTree`]'s untracked read, and the snapshot behind
/// [`DiffAnchor::Baseline`]. [`DiffAnchor::Branch`] reads no working-tree files
/// at all, so nothing there is the budget's to bound.
///
/// # Errors
/// Returns an error string if `repo_path`/`anchor` look like flags, or the git
/// invocation fails. A [`DiffAnchor::Baseline`] whose oid has been pruned is
/// tagged with [`BASELINE_OBJECT_MISSING_PREFIX`]; a tree over its budget is
/// tagged with [`WORKING_TREE_TOO_LARGE_PREFIX`]. Both let the frontend degrade
/// rather than park a raw error.
fn session_diff(
    repo_path: &str,
    anchor: DiffAnchor<'_>,
    budget: Budget,
) -> Result<SessionDiff, String> {
    reject_flag_like("repo_path", repo_path)?;
    match anchor {
        DiffAnchor::Branch(base) => {
            reject_flag_like("base", base)?;
            let range = format!("{base}...HEAD");
            // `-M` here too: a rename used to render as an add + a delete on
            // this anchor alone, so the same change read differently depending
            // on which surface showed it.
            let raw = GitRun::new(repo_path)
                .args(BIG_FILE_THRESHOLD)
                .args(["diff", "-M", &range, "--"])
                .text()?;
            Ok(SessionDiff {
                base: base.to_string(),
                // Deliberately not resolved: this backs the merge [Review
                // panel], nothing reads the label, and resolving it would spend
                // a git spawn per render on an unused value.
                base_sha: None,
                files: parse_diff(&raw),
                budget_exceeded: None,
                omitted_untracked: 0,
            })
        }
        DiffAnchor::WorkingTree { base } => {
            let base = base.unwrap_or("HEAD");
            reject_flag_like("base", base)?;
            // A session can point at a plain directory that is not a git repo
            // (a fresh folder, a scratch dir). Running `git diff` there dumps
            // git's raw "not a git repository … usage:" message, which the
            // Changes view would show verbatim as an error banner. A non-repo
            // simply has no tracked history, so report an empty changeset and
            // let the view fall back to its calm empty state.
            if !is_inside_work_tree(repo_path) {
                return Ok(SessionDiff {
                    base: base.to_string(),
                    base_sha: None,
                    files: Vec::new(),
                    budget_exceeded: None,
                    omitted_untracked: 0,
                });
            }
            let diff_ref = if base == "HEAD" {
                "HEAD".to_string()
            } else {
                resolve_merge_base(repo_path, base).unwrap_or_else(|| "HEAD".to_string())
            };
            let raw = GitRun::new(repo_path)
                .args(BIG_FILE_THRESHOLD)
                .args(["diff", "-M", &diff_ref, "--"])
                .text()?;
            let mut files = parse_diff(&raw);
            // The untracked pass is the unbounded half — it reads arbitrary
            // file content off disk — so it runs under the [Working-tree
            // budget]. The tracked diff above deliberately does not: it is
            // bounded by the index, and it is the half a user reviews, so an
            // over-budget tree degrades to "tracked changes only" rather than
            // to nothing.
            let (budget_exceeded, omitted_untracked) =
                append_untracked(repo_path, budget, &mut files)?;
            Ok(SessionDiff {
                base: base.to_string(),
                base_sha: resolve_short_sha(repo_path, &diff_ref),
                files,
                budget_exceeded,
                omitted_untracked,
            })
        }
        DiffAnchor::Baseline(oid) => {
            let current = snapshot_tree(repo_path, budget)?;
            let raw = GitRun::new(repo_path)
                .args(BIG_FILE_THRESHOLD)
                .args(["diff", "-M", oid, &current, "--"])
                .text()
                .map_err(|err| {
                    if is_missing_object_error(&err, oid) {
                        tagged_failure(
                            BASELINE_PRUNED,
                            &format!("{BASELINE_OBJECT_MISSING_PREFIX}{err}"),
                        )
                    } else {
                        err
                    }
                })?;
            Ok(SessionDiff {
                base: oid.to_string(),
                base_sha: resolve_short_sha(repo_path, oid),
                files: parse_diff(&raw),
                // Tree-vs-tree: no untracked pass to bound, and `snapshot_tree`
                // above has already refused if the tree is over its ceiling.
                budget_exceeded: None,
                omitted_untracked: 0,
            })
        }
    }
}

/// The [Working-tree budget]'s untracked pass: append synthetic all-added
/// entries to `files`, or refuse. Returns the refusal (if any) and how many
/// enumerated files carried no content.
///
/// # Errors
/// Returns an error string if the enumeration fails.
fn append_untracked(
    repo_path: &str,
    budget: Budget,
    files: &mut Vec<kriyon_core::git::FileDiff>,
) -> Result<(Option<BudgetExceeded>, usize), String> {
    let untracked = untracked_paths_bounded(repo_path, budget.max_untracked_files)?;
    if untracked.exceeded {
        return Ok((
            Some(BudgetExceeded {
                untracked_files: untracked.seen,
                file_limit: budget.max_untracked_files,
                untracked_dirs: untracked_roots(repo_path, MAX_NAMED_UNTRACKED_ROOTS),
            }),
            0,
        ));
    }
    // Paths git emitted that could not be decoded as UTF-8 are real untracked
    // files that will never reach the diff. `seen` counted them; `paths` does
    // not hold them; without this they would be missing from both channels,
    // which is exactly the silent drop `omitted_untracked` exists to prevent.
    let mut omitted = untracked.seen.saturating_sub(untracked.paths.len());
    // Size first, decide second: which files fit the byte ceiling is pure
    // arithmetic, and it now lives in `kriyon_core` where its boundaries can be
    // tested without a repo on disk. Only the reading stays here.
    let sized = sizes_of(repo_path, &untracked.paths);
    let plan = plan_untracked_reads(&sized, UNTRACKED_MAX_BYTES, budget.max_untracked_bytes);
    omitted += plan.omitted;
    for rel_path in plan.read {
        // Still through `read_untracked_content`: the gate above is arithmetic,
        // but binary / non-UTF-8 / not-a-regular-file can only be known by
        // reading, and the symlink containment check must run against the path
        // as it is at read time, not as it was at plan time.
        match read_untracked_content(repo_path, &rel_path) {
            Some(content) => files.push(untracked_as_diff(&rel_path, &content)),
            None => omitted += 1,
        }
    }
    Ok((None, omitted))
}

/// Pair each path with its on-disk size, for [`plan_untracked_reads`].
///
/// `symlink_metadata`, never `metadata`: a symlink reports its own size, not
/// its target's, matching [`read_untracked_content`]'s refusal to follow one. A
/// path that cannot be stat'd (deleted between enumeration and here) is sized
/// `0`, so it still reaches the read and is turned away there rather than
/// vanishing from the tally.
fn sizes_of(repo_path: &str, rel_paths: &[String]) -> Vec<(String, u64)> {
    let root = std::path::Path::new(repo_path);
    rel_paths
        .iter()
        .map(|rel| {
            let size = std::fs::symlink_metadata(root.join(rel))
                .map(|meta| meta.len())
                .unwrap_or_default();
            (rel.clone(), size)
        })
        .collect()
}

/// Diff the working tree (uncommitted changes, including untracked files)
/// against `base`, or `HEAD` when `base` is `None`. For worktree sessions the
/// frontend passes the merge-base branch from [`default_branch`]; for plain
/// sessions it passes nothing.
///
/// `cwd` must be a known session/project root (or a descendant of one — see
/// [`completion_cmd::validate_cwd`](crate::completion_cmd::validate_cwd)): this
/// shells out to `git` in `cwd` AND reads arbitrary untracked files under it
/// back to the frontend, so an unvalidated `cwd` would defeat the same IPC
/// trust-boundary rule `read_file`/`list_dir` are hardened for.
///
/// `(async)` hands the whole body — including the validation's filesystem/DB
/// work — to the async runtime's blocking pool, the same reason
/// `read_file`/`list_dir` use it: this shells out to `git` and reads files from
/// disk, both blocking calls that must not occupy a Tokio worker.
///
/// # Errors
/// Returns an error string if `cwd` is not a known session/project root, if
/// `cwd`/`base` look like flags, or if the git invocation fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn diff_working_tree(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    base: Option<String>,
) -> Result<SessionDiff, String> {
    diff_working_tree_for(store.inner(), &cwd, base.as_deref())
}

/// [`diff_working_tree`] over a plain `&StoreState`. See [`diff_worktree_for`]
/// for why this shape exists.
///
/// # Errors
/// See [`diff_working_tree`].
fn diff_working_tree_for(
    store: &StoreState,
    cwd: &str,
    base: Option<&str>,
) -> Result<SessionDiff, String> {
    let repo = SandboxRoot::validate(store, cwd)?;
    session_diff(
        repo.as_str(),
        DiffAnchor::WorkingTree { base },
        Budget::DEFAULT,
    )
}

/// Merge `branch` into the repo's currently checked-out base. A clean merge
/// returns [`MergeOutcome::Clean`]; a conflict returns the unmerged paths and
/// leaves the repo in the merging state for the user to resolve in the terminal.
///
/// The merge runs with the person's [Shell PATH], so a commit hook that calls
/// pnpm or node finds it when the app was opened from the Dock.
///
/// # Errors
/// Returns an error string only if git cannot be spawned, or the merge failed
/// for a reason other than conflicts.
#[tauri::command(async)]
pub fn merge_worktree(repo_path: &str, branch: &str) -> Result<MergeOutcome, String> {
    merge_worktree_with(repo_path, branch, crate::shell_path::user_path())
}

/// [`merge_worktree`] with git and its hooks run on `shell_path` (`None` keeps
/// the app's own PATH).
pub(crate) fn merge_worktree_with(
    repo_path: &str,
    branch: &str,
    shell_path: Option<&str>,
) -> Result<MergeOutcome, String> {
    reject_flag_like("repo_path", repo_path)?;
    reject_flag_like("branch", branch)?;
    let was_merging = is_merging(repo_path);
    // `outcome`, not `text`: a conflicted merge exits non-zero and that is the
    // answer this command returns, not a failure to report.
    let mut merge = GitRun::new(repo_path).args(["merge", "--no-edit", "--", branch]);
    if let Some(shell_path) = shell_path {
        merge = merge.env("PATH", shell_path);
    }
    let merge = merge.outcome()?;
    if merge.success {
        return Ok(MergeOutcome::Clean);
    }
    // Non-zero exit: a conflict leaves unmerged paths; anything else is an error.
    let conflicted =
        run_git(repo_path, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
    let files: Vec<String> = conflicted.lines().map(str::to_string).collect();
    if files.is_empty() {
        // A hook (commit-msg, pre-merge-commit) refused the merge commit and
        // git stopped mid-merge. Put the base checkout back rather than leave
        // it half-merged — unless that merge was the person's own.
        if !was_merging && is_merging(repo_path) {
            let _ = run_git(repo_path, &["merge", "--abort"]);
        }
        // Surface a non-empty message even when git wrote nothing to stderr.
        return Err(if merge.stderr.is_empty() {
            "git merge failed".to_string()
        } else {
            merge.stderr
        });
    }
    Ok(MergeOutcome::Conflicted { files })
}

/// True while the repo is in the middle of a merge (`MERGE_HEAD` exists).
fn is_merging(repo_path: &str) -> bool {
    run_git(repo_path, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok()
}

/// The scratch-index path for `repo_path`: a file **inside the repo's own git
/// dir** (`git rev-parse --absolute-git-dir`), reused across snapshots so git's
/// stat cache can skip re-hashing unchanged files (I4 fast-follow — ~5x on a
/// large repo).
///
/// Deliberately NOT a predictably-named file in the world-writable OS temp
/// dir: that lets a local attacker pre-plant `kriyon-idx-<hash>` as a symlink
/// and turn our `git add`/`write-tree`/cleanup into an arbitrary write
/// (insecure-temp-file / symlink TOCTOU). The git dir is owned by the user and
/// inherits the repo's permissions, so no foreign symlink can be planted
/// there. It is NOT the real `.git/index`; `git add`/`write-tree` against it
/// never touch refs, HEAD, the real index, or hooks. Resolving via
/// `--absolute-git-dir` handles a worktree (whose `.git` is a file pointing at
/// its own git dir) correctly.
fn scratch_index_path(repo_path: &str) -> Result<PathBuf, String> {
    let git_dir = run_git(repo_path, &["rev-parse", "--absolute-git-dir"])?;
    let git_dir = git_dir.trim();
    if git_dir.is_empty() {
        return Err("could not resolve git dir for scratch index".to_string());
    }
    Ok(Path::new(git_dir).join("kriyon-scratch-index"))
}

/// Lock serializing snapshots that share one reused scratch index (keyed by
/// the index path, i.e. the git dir): two `git add`s against the same index
/// file at once would corrupt it. Different git dirs use different index files
/// and locks, so they still run in parallel. The map grows by at most one
/// small entry per distinct git dir.
fn snapshot_lock(index_key: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut map = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Arc::clone(map.entry(index_key.to_string()).or_default())
}

/// `git add -A` + `git write-tree` against `idx` — never the real
/// `.git/index`, HEAD, refs, or hooks. `idx` is reused across calls (git
/// creates it if missing and reconciles it to the current working tree on each
/// `add -A`), so git's stat cache skips files that haven't changed.
fn write_tree_via_index(repo_path: &str, idx: &Path) -> Result<String, String> {
    // `.env` marks GIT_INDEX_FILE as deliberate, so [`GitRun`]'s ambient
    // clearing leaves it alone — that exemption is the whole reason the scratch
    // index works instead of writing to the user's real `.git/index`.
    GitRun::new(repo_path)
        .args(["add", "-A"])
        .env("GIT_INDEX_FILE", idx)
        .text()?;
    Ok(GitRun::new(repo_path)
        .args(["write-tree"])
        .env("GIT_INDEX_FILE", idx)
        .text()?
        .trim()
        .to_string())
}

/// Snapshot the current working tree (tracked + untracked, honoring
/// `.gitignore`) into a dangling tree object WITHOUT touching the real index,
/// HEAD, refs, or firing any commit hooks.
///
/// Uses a **persistent per-git-dir scratch index** (reused across calls,
/// guarded by a per-index lock) rather than a throwaway one, so git's stat
/// cache skips re-hashing unchanged files on every refresh (I4: ~5x on a large
/// repo). The scratch index lives inside the repo's own git dir (see
/// [`scratch_index_path`]) and is never the user's `.git/index`. A corrupt/
/// truncated leftover (e.g. from a killed process) is dropped and retried once
/// from a fresh index rather than wedging the view.
///
/// # Errors
/// Returns an error string if the git dir can't be resolved, git can't be
/// spawned, or either `git add`/`git write-tree` exits non-zero (after the one
/// corrupt-index retry).
fn snapshot_tree(repo_path: &str, budget: Budget) -> Result<String, String> {
    // Before anything else, and before `git add -A` in particular: that command
    // content-hashes every non-ignored file in the tree and writes each one
    // into `.git/objects`, with no flag that bounds it. On the repo that
    // prompted the [Working-tree budget] it wrote 2 GB of loose objects and a
    // 17 MB scratch index, on every refresh. The enumeration below stops as
    // soon as the ceiling is passed, so refusing costs a fraction of a second
    // where proceeding cost minutes.
    let untracked = untracked_paths_bounded(repo_path, budget.max_untracked_files)?;
    if untracked.exceeded {
        let roots = untracked_roots(repo_path, MAX_NAMED_UNTRACKED_ROOTS);
        // "including", not "mostly" — `untracked_roots` returns a prefix of
        // git's sorted listing, not the biggest offenders (see
        // `MAX_NAMED_UNTRACKED_ROOTS`).
        let named = if roots.is_empty() {
            String::new()
        } else {
            format!(" (including {})", roots.join(", "))
        };
        return Err(tagged_failure(
            OVER_BUDGET,
            &format!(
                "{WORKING_TREE_TOO_LARGE_PREFIX}over {} untracked files{named}",
                budget.max_untracked_files
            ),
        ));
    }
    // Count is not enough: the ceiling above admits ten thousand files of any
    // size, and `git add -A` hashes every byte of them. Summing the sizes we
    // already have paths for costs one lstat each (bounded by the file ceiling,
    // microseconds on a healthy tree) and is what makes "the snapshot is
    // bounded" true rather than merely likely.
    let untracked_bytes = untracked_total_bytes(repo_path, &untracked.paths);
    if untracked_bytes > budget.max_snapshot_bytes {
        return Err(tagged_failure(
            OVER_BUDGET,
            &format!(
                "{WORKING_TREE_TOO_LARGE_PREFIX}{} MB of untracked files (limit {} MB)",
                untracked_bytes / (1024 * 1024),
                budget.max_snapshot_bytes / (1024 * 1024)
            ),
        ));
    }
    let idx = scratch_index_path(repo_path)?;
    // Key the lock on the resolved index path (the git dir), so two calls with
    // different `repo_path` spellings for the same repo still serialize on the
    // one index file they share.
    let lock = snapshot_lock(&idx.to_string_lossy());
    let _guard = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match write_tree_via_index(repo_path, &idx) {
        Ok(oid) => Ok(oid),
        Err(err) => {
            // A pre-existing corrupt/truncated index makes `git add` fail;
            // drop it and retry once from a fresh index rather than parking
            // the same failure on every refresh forever.
            if idx.exists() {
                let _ = std::fs::remove_file(&idx);
                write_tree_via_index(repo_path, &idx)
            } else {
                Err(err)
            }
        }
    }
}

/// `true` if `repo_path`'s git worktree root resolves to `home` itself.
/// Errs on the side of "not home" — if the toplevel can't be resolved (`cwd`
/// isn't a git repo at all), this returns `false` and lets [`snapshot_tree`]
/// fail on its own with the real reason, rather than this guard masking it.
fn repo_root_is_home(repo_path: &str, home: &Path) -> bool {
    let Ok(toplevel) = repo_toplevel_sync(repo_path) else {
        return false;
    };
    let toplevel = Path::new(&toplevel);
    let toplevel_canonical = toplevel
        .canonicalize()
        .unwrap_or_else(|_| toplevel.to_path_buf());
    let home_canonical = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    toplevel_canonical == home_canonical
}

/// The testable core of [`capture_baseline`]: given an already-validated,
/// UTF-8 `cwd` and the resolved home directory, refuse to snapshot a repo
/// whose worktree root IS `home` itself, then delegate to [`snapshot_tree`].
/// Split out from the `#[tauri::command]` so it can be unit-tested without a
/// live `AppHandle` — mirrors this module's `*_sync` split for every other
/// command.
///
/// Belt-and-braces guard (MEDIUM from the security audit): the frontend is
/// meant to never call [`capture_baseline`] for a Home ("default cwd")
/// session, but if it ever did — and `~` is itself a git repo, a common
/// dotfiles-checkout setup — [`snapshot_tree`]'s `git add -A` would walk and
/// content-hash every non-ignored file under the user's entire home
/// directory, blocking a pool thread for minutes and permanently growing
/// `~/.git/objects`. Refused here too, independent of the frontend fix, so a
/// future call site can't reintroduce the same hazard.
fn capture_baseline_sync(cwd_str: &str, home: &Path) -> Result<String, String> {
    if repo_root_is_home(cwd_str, home) {
        return Err("refusing to capture a git baseline for the home directory".to_string());
    }
    snapshot_tree(cwd_str, Budget::DEFAULT)
}

/// Capture a hook-free snapshot of `cwd`'s working tree as a dangling tree
/// object — the foundation for a per-session baseline diff. See
/// [`snapshot_tree`] for why this never touches the real index, HEAD, or refs.
///
/// `cwd` must be a known session/project root (or a descendant of one) — see
/// [`completion_cmd::validate_cwd`](crate::completion_cmd::validate_cwd) —
/// for the same reason [`diff_working_tree`] validates it: an unvalidated
/// `cwd` would let the frontend run arbitrary git commands anywhere on disk.
///
/// # Errors
/// Returns an error string if `cwd` looks like a flag, is not a known
/// session/project root, resolves to the user's home directory, or the git
/// invocation fails.
#[tauri::command(async)]
#[allow(clippy::needless_pass_by_value)]
pub fn capture_baseline(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    cwd: String,
) -> Result<String, String> {
    let root = SandboxRoot::validate(store.inner(), &cwd)?;
    let home = crate::commands::resolve_home(&app)?;
    capture_baseline_sync(root.as_str(), &home)
}

/// Prefix [`diff_session_changes_sync`] puts on its error when `baseline_oid`
/// no longer resolves to an object in the repo — e.g. `git gc --prune=now`,
/// `git repack -ad`, or the default `gc.pruneExpire` (2 weeks) collected the
/// once-dangling snapshot tree [`capture_baseline`] wrote. Every baseline is
/// unreferenced by construction (see this module's doc comment and ADR
/// 0015), so this is guaranteed to eventually happen, not a rare edge case.
///
/// The frontend (`state/changes.ts`'s `doRefresh`, via
/// `isMissingBaselineObjectError`) degrades that refresh to
/// `diff_working_tree` — the same fallback a never-captured
/// (`baselineOid: null`) session already uses — and clears the session's
/// stored `baselineOid` so it stops retrying a dead oid on every subsequent
/// refresh (I1, round-two review). Classification itself runs on the
/// [`tagged_failure`] slug ([`BASELINE_PRUNED`]) wrapping this prefix, not on
/// the prefix alone — see [Command failure kind]. The frontend re-declares
/// this exact string as `BASELINE_OBJECT_MISSING_PREFIX` in
/// `state/changes.ts` — there's no shared codegen across the Rust↔JS
/// boundary here, so the two literals must be kept in sync by hand; the test
/// below at least pins this side of the contract.
const BASELINE_OBJECT_MISSING_PREFIX: &str = "baseline object missing: ";

/// [`tagged_failure`] slug for [`BASELINE_OBJECT_MISSING_PREFIX`]'s one error
/// site — `src/ipc/failures.ts`'s `commandFailure` maps this exact spelling
/// to `"baselinePruned"`. See [Command failure kind].
const BASELINE_PRUNED: &str = "baseline-pruned";

/// `true` if `stderr` is git reporting that `oid` doesn't exist as an object
/// in the repo — the `"fatal: bad object <oid>"` shape `git diff` produces
/// for a ref/oid it can't resolve. Checks that `oid` itself appears in the
/// message (not just the literal "bad object" substring) so a `git diff`
/// failure that happens to mention "bad object" for some *other* oid (e.g.
/// the freshly-written `current` side, which should never actually be
/// missing since it was just created, but defensively) is never
/// misclassified as the pruned-baseline case.
fn is_missing_object_error(stderr: &str, oid: &str) -> bool {
    stderr.contains("bad object") && stderr.contains(oid)
}

/// `true` if `oid` is shaped like a git object id: all-hex, and long enough to
/// be a full sha1 (40) through a full sha256 (64). Deliberately does NOT
/// accept git's abbreviated forms — every oid that reaches
/// [`diff_session_changes`] is a full [`snapshot_tree`]/`write-tree` output.
fn is_object_id(oid: &str) -> bool {
    oid.chars().all(|c| c.is_ascii_hexdigit()) && (40..=64).contains(&oid.len())
}

/// Diff a session's baseline tree (from [`snapshot_tree`], captured when the
/// session started) against a fresh snapshot of the current working tree.
///
/// Unlike [`diff_working_tree_sync`] (which diffs against a committed ref —
/// `HEAD` or a merge base), this is a tree-vs-tree comparison of two
/// [`snapshot_tree`] outputs, so tracked and untracked files are covered
/// uniformly by the same `git diff` — no separate untracked-file pass is
/// needed. That also means it catches edits made by ANY means (a Bash `sed`,
/// not just a tracked tool call) and self-corrects: reverting a file back to
/// its baseline content makes it disappear from the diff again. Uncommitted
/// changes already present when the baseline was captured are baked into the
/// baseline tree itself, so they never appear as session changes.
///
/// `-M` detects renames.
///
/// **`-c core.bigFileThreshold=1m`** (I3, round-two review, BLOCKER):
/// [`diff_working_tree_sync`]'s untracked-file pass deliberately caps
/// content at [`UNTRACKED_MAX_BYTES`] and skips binaries "so a stray build
/// artifact or log file can't balloon the diff payload" — but this
/// tree-vs-tree path has no untracked-file pass to attach that cap to (both
/// tracked and untracked content flow through the same `git diff`), so
/// without this flag a single large untracked text file (measured: 8.8 MB)
/// produces a diff string in the multi-megabyte range, buffered whole by
/// [`run_git`], expanded into per-line structs by `parse_diff`, then
/// serialized over IPC. `core.bigFileThreshold` makes git treat any blob at
/// or above the threshold as binary for diffing purposes regardless of its
/// actual content, so it renders as a `Binary files … differ` line instead
/// (measured: 119 bytes) — `parse_diff` already flags that `binary: true`,
/// and `fileKind`/`DiffFileCard` on the frontend already render a `binary`
/// chip for it, so no downstream change is needed. Must be a `-c` **before**
/// the `diff` subcommand (a git top-level config override, not a `diff`
/// flag) — [`run_git`]'s `args` slice is appended verbatim after `-C
/// repo_path`, so this only works because `-c ... diff ...` is ordered
/// correctly in the array below, not because `run_git` itself changed.
///
/// # Errors
/// Returns an error string if snapshotting the current tree or the git diff
/// invocation fails. If `baseline_oid` has been pruned out from under this
/// session (I1: a dangling tree object is fair game for `git gc
/// --prune=now`/`git repack -ad`/the default two-week `gc.pruneExpire`), the
/// returned error is tagged with [`BASELINE_OBJECT_MISSING_PREFIX`] so the
/// frontend can degrade instead of parking a dead baseline forever.
/// Diff a session's working-tree changes against its [Session baseline] (the
/// tree oid captured by [`capture_baseline`] at session start), rather than
/// against a committed ref.
///
/// Unlike the working-tree anchor, this is a tree-vs-tree comparison of two
/// [`snapshot_tree`] outputs, so tracked and untracked files are covered
/// uniformly by the same `git diff` and no separate untracked pass is needed.
/// That is also why it catches edits made by ANY means (a Bash `sed`, not just
/// a tracked tool call) and self-corrects: reverting a file back to its
/// baseline content makes it disappear from the diff again. Uncommitted changes
/// already present when the baseline was captured are baked into the baseline
/// tree itself, so they never appear as session changes.
///
/// `cwd` must be a known session/project root (or a descendant of one) — see
/// [`completion_cmd::validate_cwd`](crate::completion_cmd::validate_cwd) — for
/// the same reason [`diff_working_tree`] validates it.
///
/// # Errors
/// Returns an error string if `cwd`/`baseline_oid` look like flags,
/// `baseline_oid` is not shaped like a git object id, `cwd` is not a known
/// session/project root, or the git invocation fails. A pruned baseline is
/// tagged with [`BASELINE_OBJECT_MISSING_PREFIX`] and an over-budget tree with
/// [`WORKING_TREE_TOO_LARGE_PREFIX`], so the frontend can degrade instead of
/// parking a dead baseline or a raw error forever.
#[tauri::command(async)]
#[allow(clippy::needless_pass_by_value)]
pub fn diff_session_changes(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    baseline_oid: String,
) -> Result<SessionDiff, String> {
    diff_session_changes_for(store.inner(), &cwd, &baseline_oid, Budget::DEFAULT)
}

/// [`diff_session_changes`] over a plain `&StoreState`. See
/// [`diff_worktree_for`] for why this shape exists; `budget` is a parameter
/// here (rather than `Budget::DEFAULT` inline) so the tests can cross a ceiling
/// with a handful of files instead of ten thousand.
///
/// # Errors
/// See [`diff_session_changes`].
fn diff_session_changes_for(
    store: &StoreState,
    cwd: &str,
    baseline_oid: &str,
    budget: Budget,
) -> Result<SessionDiff, String> {
    reject_flag_like("baseline_oid", baseline_oid)?;
    // `baseline_oid` is always a `snapshot_tree`/`write-tree` output, never a
    // revision expression — constrain it to that shape rather than merely
    // rejecting flag-like values. Nothing side-effecting sits behind it
    // (diff/rev-parse are read-only) so this isn't an injection fix, just
    // retiring the question of what else (`HEAD`, `:/init`, `HEAD@{0}`,
    // `main^{tree}`) could otherwise reach `git diff` here.
    if !is_object_id(baseline_oid) {
        return Err("baseline_oid must be a git object id".to_string());
    }
    let repo = SandboxRoot::validate(store, cwd)?;
    session_diff(repo.as_str(), DiffAnchor::Baseline(baseline_oid), budget)
}

/// Resolve `repo_path`'s worktree root (`git rev-parse --show-toplevel`).
///
/// # Errors
/// Returns an error string if the git invocation fails (e.g. `repo_path` is
/// not inside a git repo).
fn repo_toplevel_sync(repo_path: &str) -> Result<String, String> {
    Ok(run_git(repo_path, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string())
}

/// Resolve a known session/project root's absolute repo toplevel — used to
/// relativize absolute `touchedFiles` paths against the repo-relative paths
/// [`diff_session_changes`]/[`diff_working_tree`] already return.
///
/// `cwd` must be a known session/project root (or a descendant of one) — see
/// [`completion_cmd::validate_cwd`](crate::completion_cmd::validate_cwd) —
/// for the same reason [`diff_working_tree`] validates it.
///
/// # Errors
/// Returns an error string if `cwd` looks like a flag, is not a known
/// session/project root, or the git invocation fails.
#[tauri::command(async)]
#[allow(clippy::needless_pass_by_value)]
pub fn repo_toplevel(store: tauri::State<'_, StoreState>, cwd: String) -> Result<String, String> {
    repo_toplevel_sync(SandboxRoot::validate(store.inner(), &cwd)?.as_str())
}

/// [`read_baseline`]'s result: the HEAD version of one working-tree file, for
/// the editor's git gutter.
///
/// Three genuinely different outcomes, kept apart on the wire because the
/// gutter renders each one differently and collapsing any two paints a
/// confidently wrong gutter:
///
/// - [`BaselineContent::NotARepo`] — `cwd` is not inside a git working tree
///   at all (a perfectly ordinary session: the All-files browser works in any
///   folder). There is no baseline and there never will be, so the frontend
///   leaves the gutter **off**. This used to collapse into the untracked case,
///   which meant every file opened in a non-git folder painted a solid
///   "every line added" gutter.
/// - [`BaselineContent::Untracked`] — a real repo, but this path has no HEAD
///   blob (new, never committed). Nothing to diff against yet, so every line
///   genuinely *is* added and the gutter says so.
/// - [`BaselineContent::Tracked`] — a HEAD blob exists. `content: None` means
///   it was too large, binary, or not UTF-8 to hand back, so the gutter stays
///   off; that is a "can't show it" state, not a "nothing to show" one.
///
/// Serialized internally tagged (`{"state": "notARepo"}`,
/// `{"state": "tracked", "content": …}`) so the TS side is a discriminated
/// union rather than a pair of overloaded booleans — see `BaselineContent` in
/// `src/ipc/bridge.ts`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum BaselineContent {
    NotARepo,
    Untracked,
    Tracked { content: Option<String> },
}

/// How many leading bytes of a HEAD blob [`read_baseline_sync`] sniffs for a
/// NUL byte to decide whether it's binary — mirrors
/// `file_cmd::BINARY_SNIFF_BYTES` (that constant is private to its module, so
/// this is its own copy rather than a `pub(crate)` re-export of a value nothing
/// else there needs exposed).
const BASELINE_BINARY_SNIFF_BYTES: usize = 8192;

/// The HEAD version of one working-tree file, for the editor's git gutter's
/// diff. Sandboxed exactly like [`crate::file_cmd::read_file`]: it takes the
/// same [`SandboxRoot`] and resolves `path` through the same
/// [`SandboxRoot::resolve`] (containment plus the `.git` refusal), so the two
/// commands' sandboxes cannot drift apart — they are not merely the same
/// checks, they are the same types.
///
/// A file with no HEAD blob at all (new, never committed) reports
/// [`BaselineContent::Untracked`], not an error — that's the ordinary
/// "nothing to diff against yet" case, not a failure. A `cwd` that is not a
/// git working tree reports [`BaselineContent::NotARepo`]. A HEAD blob that
/// exists but is over [`crate::file_cmd::MAX_READ_BYTES`], contains a NUL in
/// its first [`BASELINE_BINARY_SNIFF_BYTES`] bytes, or isn't valid UTF-8
/// reports `Tracked { content: None }` — see [`BaselineContent`]'s docs for
/// why those three mean different things to the gutter.
///
/// **`HEAD:<path>` is resolved to an oid once, and every later step names that
/// oid rather than the spec.** Three separate `HEAD:<path>` lookups (exists,
/// size, content) is three separate resolutions of a moving target: a commit,
/// checkout, or rebase landing between them meant the size gate constrained a
/// *different* object than the one then read — so the read was, in principle,
/// unbounded. One resolution makes the gate and the read agree by
/// construction.
///
/// # Errors
/// Returns an error string if `path` doesn't resolve inside `root`
/// (see [`SandboxRoot::resolve`]), if it isn't a file, if it's
/// under `.git/`, or if a git invocation fails. The tracked-ness probe is the
/// one place where a non-zero *exit* is data rather than a failure ("no HEAD
/// blob at this path"), which is exactly why it runs through
/// [`GitRun::outcome`]: a spawn failure (git missing, fork pressure) is still
/// an error and must not be silently laundered into "untracked".
fn read_baseline_sync(root: &SandboxRoot, path: &str) -> Result<BaselineContent, String> {
    let resolved = root.resolve(path, "read")?;
    // Same refusal `file_cmd::read_file_sync` makes, and now literally the same
    // call: a directory (or any other non-file) target would otherwise reach
    // git and surface a raw git error instead of a clean one.
    resolved.file_metadata()?;

    // Never `to_string_lossy`: a lossy substitution would hand git a path that
    // is NOT the validated directory — which is why the UTF-8 check is part of
    // [`SandboxRoot::validate`] and `as_str` here cannot fail.
    let repo = root.as_str();
    // The RESOLVED spelling, not the raw `path` — see
    // [`SandboxedPath::relative_to`]. git resolves `..` lexically while the
    // sandbox settles containment canonically, so the raw string can name a
    // file *above* the root that this would then hand back the HEAD blob of.
    let rel = resolved.relative_to(root)?;
    // The `./` disambiguates the pathspec half of `<rev>:<path>` from a
    // revision, the same reason `git show HEAD:./foo` is the safe spelling —
    // without it, a `rel` that happens to look like a ref could be
    // misparsed.
    let spec = format!("HEAD:./{rel}");
    let probe = GitRun::new(repo)
        .args(["rev-parse", "--verify", "--quiet", &spec])
        .outcome()?;
    if !probe.success {
        // A clean non-zero exit means "no HEAD blob at this path" — but that
        // covers two different worlds, and which one this is decides whether
        // the gutter paints every line green or draws nothing at all. So the
        // repo-ness probe runs *here*, only on the failing branch, rather
        // than unconditionally up front: the common case (a tracked file in
        // a real repo) keeps its three git spawns, and the extra
        // `rev-parse` is paid only when there's genuinely something to
        // disambiguate. `is_inside_work_tree` is the same check
        // `diff_working_tree` uses to treat "not a repo" as a state rather
        // than a failure.
        if is_inside_work_tree(repo) {
            return Ok(BaselineContent::Untracked);
        }
        return Ok(BaselineContent::NotARepo);
    }
    let oid = probe.stdout.trim();
    // git's own output, so this is a shape assertion rather than a trust
    // boundary — but it is what lets the oid be passed on as a positional.
    if !is_object_id(oid) {
        return Err("unexpected git rev-parse output".to_string());
    }
    let size: u64 = run_git(repo, &["cat-file", "-s", oid])?
        .trim()
        .parse()
        .map_err(|_| "unexpected git cat-file -s output".to_string())?;
    if size > crate::file_cmd::MAX_READ_BYTES {
        return Ok(BaselineContent::Tracked { content: None });
    }
    let bytes = GitRun::new(repo).args(["cat-file", "blob", oid]).bytes()?;
    if bytes
        .iter()
        .take(BASELINE_BINARY_SNIFF_BYTES)
        .any(|b| *b == 0)
    {
        return Ok(BaselineContent::Tracked { content: None });
    }
    Ok(BaselineContent::Tracked {
        // Not valid UTF-8: same "can't show it faithfully" call `read_file`
        // makes for a binary/oversized file — `None`, not a lossy rendering,
        // since nothing here needs the file to stay viewable read-only the
        // way `read_file`'s `lossy` flag does.
        content: String::from_utf8(bytes).ok(),
    })
}

/// The HEAD version of one working-tree file (relative to `cwd`), for the
/// editor's git gutter. `cwd` must be a known session/project root (or a
/// descendant of one — see [`SandboxRoot::validate`]); everything else is
/// enforced by [`read_baseline_sync`] — see its docs for the sandboxing and
/// [`BaselineContent`]'s for the three outcomes.
///
/// `(async)` for the same reason as [`repo_toplevel`]/[`diff_working_tree`]:
/// this shells out to git and must never run on the main thread.
///
/// # Errors
/// See [`read_baseline_sync`], plus: an error string if `cwd` is not a known
/// session/project root.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn read_baseline(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
) -> Result<BaselineContent, String> {
    read_baseline_sync(&SandboxRoot::validate(store.inner(), &cwd)?, &path)
}

/// Refusal when `path` has no HEAD blob to restore from. A plain string, not a
/// [`tagged_failure`]: nothing branches on it — the frontend only ever shows
/// it — and inventing a [Command failure kind] for a message with no behavior
/// behind it would be one more contract to keep in sync across the boundary
/// for nothing.
const NO_COMMITTED_VERSION_ERROR: &str = "file has no committed version to restore";

/// Restore one working-tree file to its HEAD version, discarding every
/// uncommitted change to it — `git checkout HEAD -- ./<path>`.
///
/// The one **destructive** command in this module, and the only one anywhere
/// that overwrites a file the user did not name in a save. Two things follow
/// from that:
///
/// - It goes through the same [`SandboxRoot::resolve`] as
///   [`read_baseline_sync`] and `file_cmd::write_file_sync`, with the `"write"`
///   verb — containment plus the `.git` refusal. `git checkout` would happily
///   write a hook or a config there.
/// - It refuses an untracked file up front, via the same `HEAD:./<path>` probe
///   [`read_baseline_sync`] uses. `git checkout HEAD -- ./<path>` on one is a
///   raw `error: pathspec … did not match any file(s) known to git`, which
///   says nothing about the actual situation ("this file was never
///   committed, so there is no version to go back to"). The probe is also
///   what makes the refusal *safe*: a clean non-zero exit is data, a spawn
///   failure is still an error, so a git that could not run is never
///   laundered into "untracked".
///
/// The caller is responsible for confirming with the user first: this cannot
/// be undone from inside the app, and the discarded content is not in git.
///
/// # Errors
/// Returns an error string if `path` doesn't resolve inside `root`, is under
/// `.git/`, isn't a file, has no HEAD blob ([`NO_COMMITTED_VERSION_ERROR`]),
/// or if a git invocation fails.
fn discard_file_changes_sync(root: &SandboxRoot, path: &str) -> Result<(), String> {
    let resolved = root.resolve(path, "write")?;
    // Same refusal as `read_baseline_sync`: a directory target would otherwise
    // reach git and check out an entire subtree.
    resolved.file_metadata()?;

    // The RESOLVED spelling, never the raw `path` — see
    // [`SandboxedPath::relative_to`] for why the two are not interchangeable
    // and why git sides with the wrong one. This command writes, so getting it
    // wrong destroys work that exists nowhere else.
    let rel = resolved.relative_to(root)?;

    let repo = root.as_str();
    // `./` for the same reason as `read_baseline_sync`'s spec: it disambiguates
    // the pathspec half of `<rev>:<path>` from a revision, so a `rel` that
    // happens to look like a ref can't be misparsed. This half is a literal
    // tree lookup already — `<rev>:<path>` is not wildmatched.
    let probe = GitRun::new(repo)
        .args(["rev-parse", "--verify", "--quiet", &format!("HEAD:./{rel}")])
        .outcome()?;
    if !probe.success {
        return Err(NO_COMMITTED_VERSION_ERROR.to_string());
    }
    // `:(literal)` is what makes the probe and the act agree: without it this
    // half is a *pathspec* and is wildmatched, so a filename containing
    // `[`, `*` or `?` restores more files than the one the user confirmed.
    // `--` still terminates option parsing and `./` still keeps a leading `-`
    // from reading as a flag; the magic prefix does not replace either.
    run_git(
        repo,
        &["checkout", "HEAD", "--", &format!(":(literal)./{rel}")],
    )?;
    Ok(())
}

/// Restore one working-tree file (relative to `cwd`) to its HEAD version,
/// discarding every uncommitted change to it. `cwd` must be a known
/// session/project root (or a descendant of one — see
/// [`SandboxRoot::validate`]); everything else is enforced by
/// [`discard_file_changes_sync`], including the `.git` refusal and the
/// untracked-file refusal.
///
/// **Destructive and unrecoverable** — the discarded content exists nowhere
/// afterwards. The frontend confirms with the user before calling this.
///
/// `(async)` for the same reason as [`read_baseline`]: this shells out to git
/// and must never run on the main thread.
///
/// # Errors
/// See [`discard_file_changes_sync`], plus: an error string if `cwd` is not a
/// known session/project root.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn discard_file_changes(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
) -> Result<(), String> {
    discard_file_changes_sync(&SandboxRoot::validate(store.inner(), &cwd)?, &path)
}

/// Start (or join) the [Working-tree watch] on the repo containing `cwd`, held
/// open on `session_id`'s behalf, and return the watched repo root.
///
/// Idempotent per session: calling it again for the same session and repo just
/// keeps the existing watch. Several sessions in one checkout share a single
/// recursive watch — see [`crate::tree_watch::TreeWatchRegistry`].
///
/// The returned root is what the emitted `working-tree-changed` payload carries,
/// so the frontend can match an event back to the sessions it affects.
///
/// # Errors
/// Returns an error string if `cwd` looks like a flag, is not a known
/// session/project root, is not inside a git repo, or the watch cannot start.
#[tauri::command(async)]
#[allow(clippy::needless_pass_by_value)]
pub fn watch_working_tree(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    store: tauri::State<'_, StoreState>,
    session_id: String,
    cwd: String,
) -> Result<String, String> {
    use tauri::Emitter as _;

    if !kriyon_core::daemon::is_valid_session_id(&session_id) {
        return Err("invalid session id".to_string());
    }
    let root = repo_toplevel_sync(SandboxRoot::validate(store.inner(), &cwd)?.as_str())?;
    let root_path = PathBuf::from(&root);

    let mut registry = state.tree_watches.lock();
    // Spawning outside the `has` check would start a second recursive watch on
    // an already-watched repo just to throw it away.
    let watch = if registry.has(&root_path) {
        None
    } else {
        let emit_root = root.clone();
        Some(crate::tree_watch::spawn_tree_watch(
            &root_path,
            move || {
                let _ = app.emit(
                    "working-tree-changed",
                    crate::tree_watch::TreeChangedPayload {
                        repo_root: emit_root.clone(),
                    },
                );
            },
        )?)
    };
    registry.retain(SessionId(session_id), root_path, watch);
    Ok(root)
}

/// Drop `session_id`'s hold on its [Working-tree watch], stopping the watch if
/// it was the last session in that repo. A no-op for a session that never
/// started one.
#[tauri::command(async)]
#[allow(clippy::needless_pass_by_value)]
pub fn unwatch_working_tree(state: tauri::State<'_, crate::AppState>, session_id: String) {
    state.tree_watches.lock().release(&SessionId(session_id));
}

#[cfg(test)]
mod tests {
    use parking_lot::Mutex;

    use super::*;
    use crate::store::{ProjectRow, Store};
    use kriyon_core::git::FileChange;

    /// Mirrors `file_cmd::tests::store_with_project_root`: an in-memory store
    /// with a single registered project root, so tests can exercise the
    /// same known-roots validation `diff_working_tree` now performs.
    fn store_with_project_root(path: &str) -> StoreState {
        let store = Store::open_in_memory().unwrap();
        store
            .upsert_project(&ProjectRow {
                id: "p1".into(),
                name: "proj".into(),
                path: path.to_string(),
                color: None,
                setup_command: None,
            })
            .unwrap();
        StoreState(Mutex::new(store))
    }

    /// The [Sandbox root] `read_baseline`'s tests act through — exactly what
    /// the `#[tauri::command]` body builds from its own `cwd` argument.
    /// Mirrors `file_cmd::tests::sandbox_root`; see its docs for why a helper
    /// that returns the *type* cannot be the drift-prone stand-in the old
    /// `*_for` shims replaced.
    fn sandbox_root(store: &StoreState, cwd: &str) -> SandboxRoot {
        SandboxRoot::validate(store, cwd).expect("cwd must be a known root")
    }

    /// One loud failure instead of forty-seven silent passes.
    ///
    /// Every git-touching test here opens `if !git_available() { return; }`, so
    /// on a machine without git the suite reports green with almost nothing
    /// actually asserted. git is a hard dependency of this app — a session
    /// cannot diff, snapshot, or merge without it — so its absence is a broken
    /// environment, not a reason to skip. This test says so once, clearly,
    /// rather than letting the skips add up to a false green.
    #[test]
    fn git_is_on_path_so_the_rest_of_this_module_actually_runs() {
        assert!(
            git_available(),
            "git is not on PATH: every other test in this module skips itself \
             and the suite reports green having asserted almost nothing"
        );
    }

    /// `true` if `git --version` runs successfully (git is on PATH).
    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_ok()
    }

    /// Run a setup git command, asserting it succeeds.
    fn git_setup(repo: &str, args: &[&str]) {
        let got = GitRun::new(repo)
            .args(args)
            .outcome()
            .expect("git setup command should spawn");
        assert!(got.success, "git {args:?} failed: {}", got.stderr);
    }

    /// Count worktrees for `repo` by shelling straight to git, bypassing the
    /// app's own command layer — these tests are asserting on
    /// `create_worktree`/`remove_worktree`'s effects, not on a `list_worktrees`
    /// command (removed as dead code; nothing in the app calls it).
    fn worktree_count(repo: &str) -> usize {
        let stdout = run_git(repo, &["worktree", "list", "--porcelain"]).expect("list worktrees");
        stdout
            .lines()
            .filter(|line| line.starts_with("worktree "))
            .count()
    }

    #[test]
    fn create_and_list_worktrees() {
        if !git_available() {
            return;
        }

        let repo_dir = tempfile::tempdir().expect("temp repo dir");
        let repo = repo_dir.path().to_str().expect("utf8 repo path");

        git_setup(repo, &["init"]);
        git_setup(repo, &["config", "user.email", "test@example.com"]);
        git_setup(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo_dir.path().join("file.txt"), "hello").expect("write file");
        git_setup(repo, &["add", "file.txt"]);
        git_setup(repo, &["commit", "-m", "init"]);

        let wt_dir = tempfile::tempdir().expect("temp worktree parent dir");
        let wt_path = wt_dir.path().join("feature");
        let wt = wt_path.to_str().expect("utf8 worktree path");

        create_worktree_with(repo, "feature", wt, None).expect("create worktree");

        assert_eq!(worktree_count(repo), 2, "expected main + feature worktrees");

        let status = repo_status(repo).expect("repo status");
        assert!(
            !status.branch.is_empty(),
            "status branch should be non-empty"
        );
    }

    #[test]
    fn remove_worktree_dirty_requires_force() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        let wt_dir = tempfile::tempdir().expect("worktree parent dir");
        let wt_path = wt_dir.path().join("feature");
        let wt = wt_path.to_str().expect("utf8 worktree path");
        create_worktree_with(repo, "feature", wt, None).expect("create worktree");
        std::fs::write(wt_path.join("dirty.txt"), "uncommitted").expect("write");

        assert!(
            remove_worktree(repo, wt, false).is_err(),
            "plain remove must refuse a dirty worktree"
        );
        remove_worktree(repo, wt, true).expect("forced remove");
        assert_eq!(
            worktree_count(repo),
            1,
            "only the main worktree should remain"
        );
    }

    #[test]
    fn rejects_flag_like_arguments() {
        // Values that could smuggle a git flag are rejected before git runs.
        assert!(create_worktree_with("/repo", "--upload-pack=evil", "/wt", None).is_err());
        assert!(create_worktree_with("/repo", "feature", "--foo", None).is_err());
        assert!(remove_worktree("/repo", "--force", false).is_err());
        assert!(repo_status("--bare").is_err());
        let store = store_with_project_root("/wt");
        assert!(diff_worktree_for(&store, "-C", "main").is_err());
        assert!(diff_worktree_for(&store, "/wt", "--evil").is_err());
        assert!(merge_worktree_with("/repo", "--force", None).is_err());
        assert!(default_branch("--bare").is_err());
    }

    /// Init a fresh repo on `main` with one commit; returns the temp dir.
    fn init_repo_with_commit() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("repo dir");
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["init", "-b", "main"]);
        git_setup(repo, &["config", "user.email", "t@e.com"]);
        git_setup(repo, &["config", "user.name", "T"]);
        std::fs::write(dir.path().join("f.txt"), "one\n").expect("write");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "init"]);
        dir
    }

    #[test]
    fn unmerged_commits_counts_a_worktree_branch_until_it_is_merged() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        let wt = dir.path().join("wt");
        let wt_path = wt.to_str().expect("utf8");
        create_worktree_with(repo, "feat/x", wt_path, None).expect("worktree");
        let store = store_with_project_root(&canonical(dir.path()));
        assert_eq!(unmerged_commits_for(&store, wt_path).expect("counts"), 0);

        commit_file(&wt, "g.txt", "two");
        assert_eq!(unmerged_commits_for(&store, wt_path).expect("counts"), 1);

        git_setup(repo, &["merge", "--no-edit", "feat/x"]);
        assert_eq!(unmerged_commits_for(&store, wt_path).expect("counts"), 0);
    }

    #[test]
    fn unmerged_commits_refuses_a_path_outside_every_known_root() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let other = tempfile::tempdir().expect("other dir");
        let store = store_with_project_root(&canonical(other.path()));
        let repo = dir.path().to_str().expect("utf8");
        assert!(unmerged_commits_for(&store, repo).is_err());
    }

    #[test]
    fn unmerged_commits_counts_squash_merged_work_as_merged() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        let wt = dir.path().join("wt");
        let wt_path = wt.to_str().expect("utf8");
        create_worktree_with(repo, "feat/x", wt_path, None).expect("worktree");
        commit_file(&wt, "g.txt", "two");
        commit_file(&wt, "h.txt", "three");
        let store = store_with_project_root(&canonical(dir.path()));
        assert_eq!(unmerged_commits_for(&store, wt_path).expect("counts"), 2);

        // A squash merge: the work lands on main, the branch's commits never do.
        git_setup(repo, &["merge", "--squash", "feat/x"]);
        git_setup(repo, &["commit", "-m", "feat x (squashed)"]);
        assert_eq!(unmerged_commits_for(&store, wt_path).expect("counts"), 0);
    }

    #[test]
    fn unmerged_commits_counts_work_merged_on_the_remote_as_merged() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        let wt = dir.path().join("wt");
        let wt_path = wt.to_str().expect("utf8");
        create_worktree_with(repo, "feat/x", wt_path, None).expect("worktree");
        commit_file(&wt, "g.txt", "two");
        let store = store_with_project_root(&canonical(dir.path()));

        // Merged on the hosting site and fetched: `origin/main` has it, the
        // local `main` hasn't been pulled.
        git_setup(repo, &["update-ref", "refs/remotes/origin/main", "feat/x"]);
        assert_eq!(unmerged_commits_for(&store, wt_path).expect("counts"), 0);
    }

    fn canonical(path: &std::path::Path) -> String {
        path.canonicalize()
            .expect("canonical")
            .to_string_lossy()
            .into_owned()
    }

    /// Commit a new file `name` with `body` in the checkout at `dir`.
    fn commit_file(dir: &std::path::Path, name: &str, body: &str) {
        let path = dir.to_str().expect("utf8");
        std::fs::write(dir.join(name), format!("{body}\n")).expect("write");
        git_setup(path, &["add", "."]);
        git_setup(path, &["commit", "-m", body]);
    }

    #[test]
    fn default_branch_resolves_local_main() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        assert_eq!(default_branch(repo).expect("default branch"), "main");
    }

    #[test]
    fn diff_worktree_shows_committed_change_vs_base() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["checkout", "-b", "feature"]);
        std::fs::write(dir.path().join("f.txt"), "two\n").expect("write");
        git_setup(repo, &["commit", "-am", "change"]);
        let store =
            store_with_project_root(&dir.path().canonicalize().expect("c").to_string_lossy());

        let diff = diff_worktree_for(&store, repo, "main").expect("diff");
        assert_eq!(diff.base, "main");
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].path, "f.txt");
    }

    /// The three hardenings `diff_worktree` was missing, now that every anchor
    /// shares one producer. Each was applied to the other two producers and
    /// skipped here — not by decision, but because no interface existed through
    /// which a fix reached all three.
    #[test]
    fn diff_worktree_detects_a_rename_like_every_other_anchor() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["checkout", "-b", "feature"]);
        std::fs::rename(dir.path().join("f.txt"), dir.path().join("renamed.txt")).expect("rename");
        git_setup(repo, &["add", "-A"]);
        git_setup(repo, &["commit", "-m", "rename"]);
        let store =
            store_with_project_root(&dir.path().canonicalize().expect("c").to_string_lossy());

        let diff = diff_worktree_for(&store, repo, "main").expect("diff");

        assert_eq!(
            diff.files.len(),
            1,
            "without -M this renders as an add plus a delete, so the same change \
             read differently depending on which surface showed it (got {:?})",
            diff.files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
        assert_eq!(diff.files[0].status, FileChange::Renamed);
        assert_eq!(diff.files[0].old_path.as_deref(), Some("f.txt"));
    }

    #[test]
    fn diff_worktree_caps_a_large_tracked_file_via_big_file_threshold() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["checkout", "-b", "feature"]);
        // Comfortably past the 1 MB threshold, and text, so only the flag can
        // keep it out of the payload.
        std::fs::write(dir.path().join("big.txt"), "x\n".repeat(900_000)).expect("write");
        git_setup(repo, &["add", "-A"]);
        git_setup(repo, &["commit", "-m", "big"]);
        let store =
            store_with_project_root(&dir.path().canonicalize().expect("c").to_string_lossy());

        let diff = diff_worktree_for(&store, repo, "main").expect("diff");

        let big = diff
            .files
            .iter()
            .find(|f| f.path == "big.txt")
            .expect("big.txt is in the diff");
        assert!(
            big.binary && big.hunks.is_empty(),
            "a multi-megabyte tracked file must render as binary, not as a \
             multi-megabyte IPC payload"
        );
    }

    #[test]
    fn diff_worktree_rejects_a_path_that_is_not_a_known_root() {
        // It was the one path-taking command here that took a frontend-supplied
        // path straight to git, with only the flag-like check in front of it.
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        let registered = tempfile::tempdir().expect("registered root");
        let store = store_with_project_root(&registered.path().to_string_lossy());

        let err = diff_worktree_for(&store, repo, "main").unwrap_err();

        assert_eq!(err, "cwd is not a known session or project root");
    }

    #[test]
    fn diff_worktree_leaves_base_sha_none() {
        // `diff_worktree` backs the merge-review surface (`ReviewPanel`), not
        // the Code Changes View's baseline label — nothing reads `base_sha`
        // from its result, so resolving it here would be an unused git call.
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["checkout", "-b", "feature"]);
        let store =
            store_with_project_root(&dir.path().canonicalize().expect("c").to_string_lossy());

        let diff = diff_worktree_for(&store, repo, "main").expect("diff");
        assert_eq!(diff.base_sha, None);
    }

    /// Git exports `GIT_DIR`/`GIT_WORK_TREE` to the hooks it runs, and both
    /// outrank `-C`. Without clearing them, any git command we spawn from a
    /// hook context silently targets the hook's repo instead of the path the
    /// caller asked for — so a diff for one repo would be computed against
    /// another. Both variables point at a *different* repo here; the command
    /// must still describe the repo we named.
    #[test]
    fn git_commands_ignore_an_inherited_git_dir() {
        if !git_available() {
            return;
        }
        let ours = init_repo_with_commit();
        let theirs = init_repo_with_commit();
        let repo = ours.path().to_str().expect("utf8");

        std::fs::write(ours.path().join("f.txt"), "changed here\n").expect("write");

        let _guard = (
            scopeguard_set(
                "GIT_DIR",
                theirs.path().join(".git").to_str().expect("utf8"),
            ),
            scopeguard_set("GIT_WORK_TREE", theirs.path().to_str().expect("utf8")),
        );

        let diff = session_diff(
            repo,
            DiffAnchor::WorkingTree { base: None },
            Budget::DEFAULT,
        )
        .expect("diff");
        assert_eq!(
            diff.files.len(),
            1,
            "expected only our repo's edit, got {:?}",
            diff.files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
        assert_eq!(diff.files[0].path, "f.txt");
    }

    /// Sets an env var for the duration of the returned guard.
    fn scopeguard_set(key: &'static str, value: &str) -> EnvGuard {
        // SAFETY: tests touching process env run single-threaded (`--test-threads=1`
        // is required on this project anyway); the guard restores the prior value.
        unsafe { std::env::set_var(key, value) };
        EnvGuard { key }
    }

    struct EnvGuard {
        key: &'static str,
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // SAFETY: see `scopeguard_set`.
            unsafe { std::env::remove_var(self.key) };
        }
    }

    #[test]
    fn resolve_short_sha_resolves_a_valid_ref() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");

        let expected = run_git(repo, &["rev-parse", "--short", "HEAD"])
            .expect("rev-parse")
            .trim()
            .to_string();
        assert_eq!(resolve_short_sha(repo, "HEAD"), Some(expected));
    }

    #[test]
    fn resolve_short_sha_none_for_unresolvable_ref() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");

        assert_eq!(resolve_short_sha(repo, "not-a-real-ref"), None);
    }

    #[test]
    fn diff_working_tree_shows_modified_tracked_file() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::write(dir.path().join("f.txt"), "two\n").expect("write");

        let diff = session_diff(
            repo,
            DiffAnchor::WorkingTree { base: None },
            Budget::DEFAULT,
        )
        .expect("diff");
        assert_eq!(diff.base, "HEAD");
        let file = diff
            .files
            .iter()
            .find(|f| f.path == "f.txt")
            .expect("f.txt present");
        assert!(!file.hunks.is_empty(), "modified file should have hunks");
    }

    #[test]
    fn diff_working_tree_shows_untracked_file_as_added() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::write(dir.path().join("new.txt"), "hello\n").expect("write");

        let diff = session_diff(
            repo,
            DiffAnchor::WorkingTree { base: None },
            Budget::DEFAULT,
        )
        .expect("diff");
        let file = diff
            .files
            .iter()
            .find(|f| f.path == "new.txt")
            .expect("new.txt present");
        assert_eq!(file.status, FileChange::Added);
        assert_eq!(file.hunks.len(), 1);
        assert_eq!(file.hunks[0].lines[0].text, "hello");
    }

    #[test]
    fn diff_working_tree_shows_untracked_file_with_space_in_name() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::write(dir.path().join("my new file.txt"), "hi\n").expect("write");

        let diff = session_diff(
            repo,
            DiffAnchor::WorkingTree { base: None },
            Budget::DEFAULT,
        )
        .expect("diff");
        let file = diff
            .files
            .iter()
            .find(|f| f.path == "my new file.txt")
            .expect("'my new file.txt' present despite git quoting the space");
        assert_eq!(file.status, FileChange::Added);
        assert_eq!(file.hunks[0].lines[0].text, "hi");
    }

    #[test]
    fn diff_working_tree_does_not_read_untracked_symlink_target() {
        if !git_available() {
            return;
        }
        // A secret file living OUTSIDE the repo.
        let outside = tempfile::tempdir().expect("outside dir");
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "TOP SECRET KEY MATERIAL\n").expect("write secret");

        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        // An untracked symlink inside the repo pointing at the outside secret.
        // git reports it as `?? link.txt`; the diff must never disclose the
        // link *target's* bytes (that would read outside the sandbox).
        std::os::unix::fs::symlink(&secret, dir.path().join("link.txt")).expect("symlink");

        let diff = session_diff(
            repo,
            DiffAnchor::WorkingTree { base: None },
            Budget::DEFAULT,
        )
        .expect("diff");
        let leaked = diff.files.iter().any(|f| {
            f.hunks
                .iter()
                .any(|h| h.lines.iter().any(|l| l.text.contains("SECRET")))
        });
        assert!(
            !leaked,
            "untracked symlink target content leaked into the diff"
        );
    }

    #[test]
    fn diff_working_tree_none_base_diffs_against_head() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");

        let diff = session_diff(
            repo,
            DiffAnchor::WorkingTree { base: None },
            Budget::DEFAULT,
        )
        .expect("diff");
        assert_eq!(diff.base, "HEAD");
        assert!(diff.files.is_empty(), "clean tree should have no diffs");
    }

    #[test]
    fn diff_working_tree_resolves_base_sha_for_head() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");

        let expected = run_git(repo, &["rev-parse", "--short", "HEAD"])
            .expect("rev-parse")
            .trim()
            .to_string();
        let diff = session_diff(
            repo,
            DiffAnchor::WorkingTree { base: None },
            Budget::DEFAULT,
        )
        .expect("diff");
        assert_eq!(diff.base_sha, Some(expected));
    }

    #[test]
    fn diff_working_tree_resolves_base_sha_for_explicit_branch() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["checkout", "-b", "feature"]);
        std::fs::write(dir.path().join("f.txt"), "two\n").expect("write");
        git_setup(repo, &["commit", "-am", "change"]);

        let expected = run_git(repo, &["rev-parse", "--short", "main"])
            .expect("rev-parse")
            .trim()
            .to_string();
        let diff = session_diff(
            repo,
            DiffAnchor::WorkingTree { base: Some("main") },
            Budget::DEFAULT,
        )
        .expect("diff");
        assert_eq!(diff.base_sha, Some(expected));
    }

    #[test]
    fn diff_working_tree_invalid_cwd_is_err() {
        assert!(session_diff(
            "-C",
            DiffAnchor::WorkingTree { base: None },
            Budget::DEFAULT
        )
        .is_err());
        assert!(session_diff(
            "/does/not/matter",
            DiffAnchor::WorkingTree {
                base: Some("--evil")
            },
            Budget::DEFAULT
        )
        .is_err());
    }

    /// Regression guard for the fabricated-deletion bug: `diff_working_tree`
    /// used to `git diff <base> --` (two-dot), which compares against
    /// wherever `base`'s tip currently sits. If `base` advances after the
    /// session's branch diverged — a teammate pushes, the user pulls — every
    /// file `base` changed since then renders as a DELETION the session
    /// never made. This reproduces exactly that: `main` gains a commit
    /// AFTER `feature` branches off, and a file that only exists because of
    /// that later `main` commit must never appear in the session's diff.
    #[test]
    fn diff_working_tree_diverged_base_excludes_base_only_commit() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");

        // Branch off main, commit something on the branch (the session's own
        // committed work).
        git_setup(repo, &["checkout", "-b", "feature"]);
        std::fs::write(dir.path().join("session.txt"), "session work\n").expect("write");
        git_setup(repo, &["add", "session.txt"]);
        git_setup(repo, &["commit", "-m", "session commit"]);

        // Base advances with its own, unrelated commit AFTER the branch
        // diverged.
        git_setup(repo, &["checkout", "main"]);
        std::fs::write(dir.path().join("main_only.txt"), "main-only content\n").expect("write");
        git_setup(repo, &["add", "main_only.txt"]);
        git_setup(repo, &["commit", "-m", "main advances"]);

        // Back on the branch, an uncommitted edit — what diff_working_tree
        // is meant to surface.
        git_setup(repo, &["checkout", "feature"]);
        std::fs::write(dir.path().join("f.txt"), "two\n").expect("write");

        let diff = session_diff(
            repo,
            DiffAnchor::WorkingTree { base: Some("main") },
            Budget::DEFAULT,
        )
        .expect("diff");
        assert!(
            !diff.files.iter().any(|f| f.path == "main_only.txt"),
            "main-only.txt must not appear in the session's diff at all \
             (got {:?}), let alone as a fabricated deletion",
            diff.files
                .iter()
                .map(|f| (&f.path, f.status))
                .collect::<Vec<_>>()
        );
        // Absence of main_only.txt alone doesn't pin merge-base behaviour: a
        // degraded fallback to plain `HEAD` (feature's tip) would satisfy it
        // too, since main_only.txt was never on `feature` either way. What
        // only the merge-base path produces is session.txt showing up as a
        // diff entry — it's already committed into HEAD, so a HEAD-diff
        // would never surface it, but it postdates the merge-base commit.
        assert!(
            diff.files.iter().any(|f| f.path == "session.txt"),
            "session.txt (the session's own committed work, which sits after \
             the merge base but is already part of HEAD) must appear in the \
             diff — its absence would mean the diff degraded to comparing \
             against HEAD instead of the merge base (got {:?})",
            diff.files
                .iter()
                .map(|f| (&f.path, f.status))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn diff_working_tree_rejects_a_cwd_that_is_not_a_known_root() {
        // The attack this closes: `diff_working_tree("/some/private/repo",
        // None)` used to run `git diff`/`git status` and read untracked file
        // contents in ANY directory the frontend named, never checked
        // against the app's known session/project roots — the same hole
        // `read_file`/`list_dir` were hardened against.
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        let registered = tempfile::tempdir().expect("temp registered root");
        let store = store_with_project_root(&registered.path().to_string_lossy());

        let err = diff_working_tree_for(&store, repo, None).unwrap_err();
        assert_eq!(err, "cwd is not a known session or project root");
    }

    #[test]
    fn diff_working_tree_accepts_a_known_root() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().canonicalize().expect("canonicalize");
        let repo_str = repo.to_str().expect("utf8");
        let store = store_with_project_root(repo_str);

        let diff = diff_working_tree_for(&store, repo_str, None).expect("diff");
        assert_eq!(diff.base, "HEAD");
    }

    #[test]
    fn diff_working_tree_in_a_non_git_dir_reports_empty_not_an_error() {
        // A registered project root that is a plain directory, not a git repo:
        // running `git diff` there would dump git's "not a git repository …"
        // usage message. The Changes view must instead see a clean empty diff.
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().expect("temp non-git dir");
        let cwd = dir.path().canonicalize().expect("canonicalize");
        let cwd_str = cwd.to_str().expect("utf8");
        std::fs::write(cwd.join("loose.txt"), "not tracked\n").expect("write");
        let store = store_with_project_root(cwd_str);

        let diff = diff_working_tree_for(&store, cwd_str, None)
            .expect("a non-git directory must not surface a raw git error");
        assert!(
            diff.files.is_empty(),
            "a non-repo has no tracked history to diff"
        );
        assert_eq!(diff.base_sha, None);
    }

    /// A tiny budget, so the [Working-tree budget] tests can cross a ceiling
    /// with a handful of files instead of the ten thousand the real one takes.
    const TEST_BUDGET: Budget = Budget {
        max_untracked_files: 3,
        max_untracked_bytes: 64,
        max_snapshot_bytes: 4096,
    };

    /// Make `dir` unreadable (or readable again). Unix-only: the deadlock this
    /// supports is a pipe-buffer property, and the permission model that
    /// provokes git into per-directory warnings is POSIX.
    #[cfg(unix)]
    fn unreadable(dir: &Path, locked: bool) {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = if locked { 0o000 } else { 0o755 };
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode));
    }

    #[cfg(not(unix))]
    fn unreadable(_dir: &Path, _locked: bool) {}

    /// Write `count` untracked files named `u0.txt`… into `repo`.
    fn write_untracked(repo: &Path, count: usize) {
        for i in 0..count {
            std::fs::write(repo.join(format!("u{i}.txt")), "x\n").expect("write untracked");
        }
    }

    #[test]
    fn untracked_enumeration_stops_once_the_file_ceiling_is_passed() {
        // The point of the bound: a tree with far more untracked files than the
        // ceiling must not be walked to the end just to learn it is too big.
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        write_untracked(dir.path(), 20);

        let found = untracked_paths_bounded(repo, 3).expect("enumeration runs");
        assert!(found.exceeded, "20 untracked files passes a ceiling of 3");
        assert!(found.seen > 3, "the count is a floor, not a census");
        assert!(
            found.paths.is_empty(),
            "a refused tree yields no paths — a truncated list would read as a \
             changeset (got {:?})",
            found.paths
        );
    }

    /// `git ls-files` writes one `warning: could not open directory 'x/'` line
    /// per unreadable directory — measured at ~60 bytes each, so past macOS's
    /// 64 KB pipe buffer (about 1,100 such directories) git blocks writing
    /// stderr. If this function drains only stdout, git never closes stdout,
    /// the read never returns, and a blocking-pool thread hangs forever: the
    /// exact failure class the [Working-tree budget] exists to prevent,
    /// reintroduced by the thing that prevents it.
    ///
    /// Run on a thread with a deadline so a regression fails the suite instead
    /// of wedging it.
    #[test]
    fn a_tree_whose_stderr_exceeds_the_pipe_buffer_does_not_deadlock() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8").to_string();
        // 1,400 × ~60 bytes ≈ 84 KB of warnings, comfortably past the 64 KB
        // buffer. Each needs a file inside, or git has nothing to warn about.
        for i in 0..1400 {
            let sub = dir.path().join(format!("locked{i}"));
            std::fs::create_dir_all(&sub).expect("mkdir");
            std::fs::write(sub.join("f.txt"), "x").expect("write");
            unreadable(&sub, true);
        }

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(untracked_paths_bounded(&repo, 10_000).is_ok());
        });
        let outcome = rx.recv_timeout(std::time::Duration::from_secs(30));

        // Restore permissions before asserting, so the TempDir can clean up
        // even when the assertion below fails.
        for i in 0..1400 {
            unreadable(&dir.path().join(format!("locked{i}")), false);
        }
        assert!(
            outcome.is_ok(),
            "enumeration deadlocked: git filled the stderr pipe while we were \
             only draining stdout"
        );
    }

    /// A read error mid-stream must not be mistaken for end-of-list. Silently
    /// truncating would hand the [Changes view] a short list it would then
    /// present as the complete set of untracked files.
    #[test]
    fn a_failed_enumeration_reports_an_error_rather_than_a_short_list() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().expect("temp dir");
        let not_a_repo = dir.path().to_str().expect("utf8");

        let err = untracked_paths_bounded(not_a_repo, 10_000).unwrap_err();
        assert!(
            !err.is_empty(),
            "a failure must carry a reason the UI can show, not an empty string"
        );
    }

    /// The previous test cannot tell a streamed bail from a buffered one: 20
    /// short paths arrive in a single 64 KB read, so `seen` ends up the exact
    /// census either way. This one makes the listing span several reads, so
    /// `seen` far below the true total is only possible if the walk actually
    /// stopped — the property the whole [Working-tree budget] rests on.
    #[test]
    fn untracked_enumeration_stops_reading_rather_than_walking_the_whole_tree() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        // Long names, few files: ~190 bytes per entry x 1,200 is ~230 KB,
        // several 64 KB reads, without paying to create 20,000 inodes.
        let pad = "n".repeat(180);
        for i in 0..1200 {
            std::fs::write(dir.path().join(format!("{pad}{i}.txt")), "x").expect("write");
        }

        let found = untracked_paths_bounded(repo, 3).expect("enumeration runs");

        assert!(found.exceeded);
        assert!(
            found.seen < 1200,
            "the walk must stop at the first chunk past the ceiling, not read \
             all 1,200 entries (seen {})",
            found.seen
        );
    }

    /// The byte ceiling's boundary. With 40-byte files against a 64-byte budget
    /// the sibling test below cannot tell `>` from `>=`; a file sized exactly to
    /// the remaining budget must still be included.
    #[test]
    fn an_untracked_file_exactly_at_the_byte_ceiling_still_fits() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::write(dir.path().join("exact.txt"), "y".repeat(64)).expect("write");

        let diff =
            session_diff(repo, DiffAnchor::WorkingTree { base: None }, TEST_BUDGET).expect("diff");

        assert!(
            diff.files.iter().any(|f| f.path == "exact.txt"),
            "a file exactly at the ceiling is inside it, not past it"
        );
        assert_eq!(diff.omitted_untracked, 0);
    }

    /// The production path: every session carries a baseline, so the refusal the
    /// frontend degrades from is `diff_session_changes`'s, not
    /// `snapshot_tree`'s. The tag has to survive that call verbatim or
    /// `isWorkingTreeTooLargeError` stops matching and the view parks a raw
    /// error instead of the notice.
    #[test]
    fn diff_session_changes_tags_an_over_budget_tree_so_the_frontend_can_degrade() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        let baseline = snapshot_tree(repo, TEST_BUDGET).expect("baseline snapshots while small");
        write_untracked(dir.path(), 20);

        let err = session_diff(repo, DiffAnchor::Baseline(&baseline), TEST_BUDGET).unwrap_err();

        assert!(
            err.starts_with(&format!("kind:{OVER_BUDGET}: ")),
            "got {err:?}"
        );
        assert!(
            err.contains(WORKING_TREE_TOO_LARGE_PREFIX),
            "the human-readable half must survive the tag verbatim (got {err:?})"
        );
    }

    #[test]
    fn untracked_enumeration_under_the_ceiling_returns_every_path() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        write_untracked(dir.path(), 3);

        let found = untracked_paths_bounded(repo, 10).expect("enumeration runs");
        assert!(!found.exceeded);
        assert_eq!(found.seen, 3);
        assert_eq!(found.paths.len(), 3);
    }

    /// The regression the `-z` switch exists to make impossible: a path with a
    /// space and a non-ASCII character used to arrive C-quoted
    /// (`"TestFlight \342\200\223 x.txt"`) and had to be decoded back. This is
    /// the exact shape of a real file in the repo that first hit this bug.
    #[test]
    fn untracked_enumeration_reads_spaces_and_non_ascii_paths_verbatim() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::write(
            dir.path().join("TestFlight – AcmeLens 1.7.20 (153).crash"),
            "boom\n",
        )
        .expect("write");

        let found = untracked_paths_bounded(repo, 10).expect("enumeration runs");
        assert_eq!(
            found.paths,
            vec!["TestFlight – AcmeLens 1.7.20 (153).crash"]
        );
    }

    /// The reported freeze, in miniature. A working tree over the ceiling must
    /// still report its *tracked* changes (bounded by the index, and the part a
    /// user actually reviews) while refusing the unbounded untracked pass.
    #[test]
    fn an_over_budget_tree_reports_tracked_changes_and_refuses_the_untracked_pass() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::write(dir.path().join("f.txt"), "one\ntwo\n").expect("modify tracked");
        write_untracked(dir.path(), 20);

        let diff =
            session_diff(repo, DiffAnchor::WorkingTree { base: None }, TEST_BUDGET).expect("diff");
        let exceeded = diff
            .budget_exceeded
            .as_ref()
            .expect("an over-budget tree must say so");
        assert_eq!(exceeded.file_limit, 3);
        assert!(exceeded.untracked_files > 3);
        assert!(
            diff.files.iter().any(|f| f.path == "f.txt"),
            "tracked changes stay visible: they are bounded by the index"
        );
        assert!(
            !diff.files.iter().any(|f| f.path.starts_with('u')),
            "no untracked file may be read once the ceiling is passed (got {:?})",
            diff.files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
    }

    /// The actionable half: naming the directory to gitignore is the whole
    /// difference between a dead end and a fix the user can apply.
    #[test]
    fn an_over_budget_tree_names_the_directories_responsible() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::create_dir_all(dir.path().join("vendor/sdk")).expect("mkdir");
        write_untracked(&dir.path().join("vendor/sdk"), 20);

        let diff =
            session_diff(repo, DiffAnchor::WorkingTree { base: None }, TEST_BUDGET).expect("diff");
        let exceeded = diff.budget_exceeded.expect("over budget");
        assert_eq!(
            exceeded.untracked_dirs,
            vec!["vendor/".to_string()],
            "`--directory` must collapse the subtree to its one untracked root \
             rather than descend it — that collapse is what makes naming the \
             directories affordable on a tree too big to enumerate"
        );
    }

    #[test]
    fn a_tree_under_budget_still_includes_untracked_files() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::write(dir.path().join("new.txt"), "hello\n").expect("write");

        let diff =
            session_diff(repo, DiffAnchor::WorkingTree { base: None }, TEST_BUDGET).expect("diff");
        assert!(diff.budget_exceeded.is_none());
        assert!(diff.files.iter().any(|f| f.path == "new.txt"));
        assert_eq!(diff.omitted_untracked, 0);
    }

    /// The byte ceiling is what actually bounds the IPC payload: a thousand
    /// small files pass the file ceiling but must not each contribute content.
    /// Omitted files are counted, never silently dropped.
    #[test]
    fn untracked_content_past_the_byte_ceiling_is_omitted_and_counted() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        // Three files of 40 bytes each against a 64-byte ceiling: the first
        // fits, the rest cannot.
        for i in 0..3 {
            std::fs::write(dir.path().join(format!("u{i}.txt")), "y".repeat(40)).expect("write");
        }

        let diff =
            session_diff(repo, DiffAnchor::WorkingTree { base: None }, TEST_BUDGET).expect("diff");
        assert!(
            diff.budget_exceeded.is_none(),
            "3 files is within the ceiling of 3"
        );
        assert_eq!(
            diff.files.len(),
            1,
            "only the content that fits the byte ceiling is carried (got {:?})",
            diff.files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
        assert_eq!(diff.omitted_untracked, 2);
    }

    /// The load-bearing one: `snapshot_tree` runs `git add -A`, which hashes
    /// and writes every non-ignored file into `.git/objects`. On the repo that
    /// triggered this work that meant 7.7 GB. It must refuse before spawning
    /// `git add`, not after.
    #[test]
    fn capturing_a_baseline_refuses_an_over_budget_tree_before_running_git_add() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        write_untracked(dir.path(), 20);

        let err = snapshot_tree(repo, TEST_BUDGET).unwrap_err();
        assert!(
            err.starts_with(&format!("kind:{OVER_BUDGET}: ")),
            "the refusal must be tagged so the frontend can degrade rather than \
             park a raw error (got {err:?})"
        );
        assert!(
            !dir.path().join(".git/kriyon-scratch-index").exists(),
            "no scratch index may be written: `git add -A` must never have run"
        );
    }

    #[test]
    fn capturing_a_baseline_still_works_under_budget() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::write(dir.path().join("new.txt"), "hello\n").expect("write");

        let oid = snapshot_tree(repo, TEST_BUDGET).expect("a small tree snapshots normally");
        assert!(is_object_id(&oid), "got {oid:?}");
    }

    /// I3, on the fallback path: [`UNTRACKED_MAX_BYTES`] only caps the
    /// *untracked* pass, so a modified **tracked** multi-megabyte text file
    /// reproduced the original payload blowup here exactly — and this is the
    /// path a session degrades onto when its baseline object has been pruned,
    /// so it is not a rare corner. Same guard as
    /// [`diff_session_changes_sync`]: `-c core.bigFileThreshold=1m`.
    ///
    /// Two deliberate details, and they are also the limits of what this guard
    /// buys on this path (both verified on git 2.50.1) — unlike
    /// [`diff_session_changes_sync`], whose two sides are always objects
    /// already in the ODB, one side here is a **working-tree** file, and git
    /// only takes the size shortcut for such a file when it does not have to
    /// read it anyway:
    ///
    /// * `core.autocrlf=false` on the test repo — with `core.autocrlf=input`
    ///   (set globally on some machines, including the one this was written
    ///   on) the file "would convert to git", so git reads and diffs it in
    ///   full regardless of the threshold. Same for an `eol`/`text` attribute
    ///   or a filter driver such as LFS.
    /// * the modification changes the file's **size** (2 MB → 3 MB) — a
    ///   same-size edit leaves the stat size matching the index entry, and git
    ///   then reads the file to compare content, again bypassing the shortcut.
    ///
    /// A real edit to a real large file changes its size, so this covers the
    /// reported case; an unconditional cap would have to live in [`run_git`]
    /// (bounding stdout), which is a bigger change than this one.
    #[test]
    fn diff_working_tree_caps_a_large_tracked_file_via_big_file_threshold() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["config", "core.autocrlf", "false"]);

        // Commit a >1 MB text file, then modify it: a tracked modification is
        // what `UNTRACKED_MAX_BYTES` cannot see.
        std::fs::write(dir.path().join("big.txt"), "a\n".repeat(1_000_000)).expect("write big");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "big"]);
        std::fs::write(dir.path().join("big.txt"), "b\n".repeat(1_500_000)).expect("modify big");

        let diff = session_diff(
            repo,
            DiffAnchor::WorkingTree { base: None },
            Budget::DEFAULT,
        )
        .expect("diff");
        let file = diff
            .files
            .iter()
            .find(|f| f.path == "big.txt")
            .expect("big.txt present");
        assert!(
            file.binary,
            "a tracked file over core.bigFileThreshold must be reported as \
             binary, not diffed line-by-line into a multi-megabyte IPC payload"
        );
        assert!(
            file.hunks.is_empty(),
            "a binary-flagged file must carry no line hunks, got {} hunks",
            file.hunks.len()
        );
    }

    /// [`snapshot_tree`] must capture the working tree — tracked file edits
    /// AND untracked files — while honoring `.gitignore`, and it must do so
    /// without moving `HEAD`, any ref, or the real index: it backs a
    /// per-session baseline diff that runs on every session, so it can never
    /// have a side effect on the repo the user is actually working in.
    #[test]
    fn snapshot_tree_captures_tracked_and_untracked_without_moving_refs() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().expect("repo dir");
        let repo = dir.path().to_str().expect("utf8 repo path");
        git_setup(repo, &["init", "-b", "main"]);
        git_setup(repo, &["config", "user.email", "t@e.com"]);
        git_setup(repo, &["config", "user.name", "T"]);

        std::fs::write(dir.path().join("committed.txt"), "a\n").expect("write");
        git_setup(repo, &["add", "committed.txt"]);
        git_setup(repo, &["commit", "-m", "init"]);

        std::fs::write(dir.path().join("committed.txt"), "a\nb\n").expect("write"); // modify tracked
        std::fs::write(dir.path().join("untracked.txt"), "new\n").expect("write"); // untracked
        std::fs::write(dir.path().join(".gitignore"), "ignored.txt\n").expect("write");
        std::fs::write(dir.path().join("ignored.txt"), "no\n").expect("write"); // ignored

        let head_before = run_git(repo, &["rev-parse", "HEAD"]).expect("rev-parse HEAD");
        let index_before = run_git(repo, &["rev-parse", "--verify", "-q", ":committed.txt"]).ok();

        let oid = snapshot_tree(repo, Budget::DEFAULT).expect("snapshot");

        // Tree contains the modified + untracked files, NOT the ignored one.
        let ls = run_git(repo, &["ls-tree", "-r", "--name-only", &oid]).expect("ls-tree");
        assert!(ls.contains("committed.txt"));
        assert!(ls.contains("untracked.txt"));
        assert!(!ls.contains("ignored.txt"));

        // committed.txt in the tree has the MODIFIED content.
        let blob = run_git(repo, &["show", &format!("{oid}:committed.txt")]).expect("show blob");
        assert_eq!(blob, "a\nb\n");

        // Nothing moved: HEAD and the real index are untouched.
        assert_eq!(
            run_git(repo, &["rev-parse", "HEAD"]).expect("rev-parse HEAD after"),
            head_before
        );
        assert_eq!(
            run_git(repo, &["rev-parse", "--verify", "-q", ":committed.txt"]).ok(),
            index_before
        );
    }

    #[test]
    fn snapshot_tree_reuses_a_persistent_scratch_index() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().expect("repo dir");
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["init", "-b", "main"]);
        git_setup(repo, &["config", "user.email", "t@e.com"]);
        git_setup(repo, &["config", "user.name", "T"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").expect("write");

        let idx = scratch_index_path(repo).expect("scratch index path");
        let _ = std::fs::remove_file(&idx); // start clean

        snapshot_tree(repo, Budget::DEFAULT).expect("snapshot");

        // The scratch index persists across calls (so git's stat cache can skip
        // re-hashing unchanged files next time), unlike the old throwaway index.
        assert!(idx.exists(), "scratch index should persist for reuse");

        // Reuse stays correct: a change made after the first snapshot is
        // reflected in the next, never masked by a stale cached index entry.
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").expect("write");
        let oid = snapshot_tree(repo, Budget::DEFAULT).expect("second snapshot");
        let blob = run_git(repo, &["show", &format!("{oid}:a.txt")]).expect("show");
        assert_eq!(blob, "one\ntwo\n");
    }

    #[test]
    fn snapshot_tree_recovers_from_a_corrupt_scratch_index() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().expect("repo dir");
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["init", "-b", "main"]);
        git_setup(repo, &["config", "user.email", "t@e.com"]);
        git_setup(repo, &["config", "user.name", "T"]);
        std::fs::write(dir.path().join("a.txt"), "x\n").expect("write");

        // A truncated/garbage leftover (e.g. from a killed process) must not
        // wedge the view forever — the snapshot drops it and retries fresh.
        let idx = scratch_index_path(repo).expect("scratch index path");
        std::fs::write(&idx, b"garbage").expect("corrupt index");

        let oid =
            snapshot_tree(repo, Budget::DEFAULT).expect("snapshot recovers from corrupt index");
        let ls = run_git(repo, &["ls-tree", "-r", "--name-only", &oid]).expect("ls-tree");
        assert!(ls.contains("a.txt"));
    }

    /// MEDIUM (security audit): a Home session's `cwd` is the user's actual
    /// home directory. If `~` is itself a git repo (a dotfiles checkout),
    /// `capture_baseline` must refuse rather than let `git add -A` walk and
    /// content-hash the whole home tree.
    #[test]
    fn capture_baseline_refuses_when_repo_root_is_home() {
        if !git_available() {
            return;
        }
        let home = init_repo_with_commit();
        let home_str = home.path().to_str().expect("utf8");

        let err = capture_baseline_sync(home_str, home.path()).unwrap_err();
        assert_eq!(
            err,
            "refusing to capture a git baseline for the home directory"
        );
    }

    /// The same guard must not fire for an ordinary project repo that simply
    /// happens to live somewhere other than home.
    #[test]
    fn capture_baseline_succeeds_for_a_project_repo_that_is_not_home() {
        if !git_available() {
            return;
        }
        let project = init_repo_with_commit();
        let unrelated_home = tempfile::tempdir().expect("unrelated home dir");
        let project_str = project.path().to_str().expect("utf8");

        let oid = capture_baseline_sync(project_str, unrelated_home.path()).expect("baseline");
        assert_ne!(oid, "");
    }

    /// A repo nested inside home (the common case — home is not itself a git
    /// repo, a project checkout lives a few levels under it) must still be
    /// baselined normally: only an EXACT repo-root-equals-home match refuses.
    #[test]
    fn capture_baseline_succeeds_for_a_repo_nested_under_home() {
        if !git_available() {
            return;
        }
        let home = tempfile::tempdir().expect("home dir (not a git repo itself)");
        let project_dir = home.path().join("code/my-project");
        std::fs::create_dir_all(&project_dir).expect("mkdir");
        let project = project_dir.to_str().expect("utf8");
        git_setup(project, &["init", "-b", "main"]);
        git_setup(project, &["config", "user.email", "t@e.com"]);
        git_setup(project, &["config", "user.name", "T"]);
        std::fs::write(project_dir.join("f.txt"), "one\n").expect("write");
        git_setup(project, &["add", "."]);
        git_setup(project, &["commit", "-m", "init"]);

        let oid = capture_baseline_sync(project, home.path()).expect("baseline");
        assert_ne!(oid, "");
    }

    /// `read_baseline` must show HEAD's content, not the working tree's —
    /// that's the entire point of a git-gutter baseline.
    ///
    /// Builds the [Sandbox root] the command builds (see `sandbox_root`)
    /// rather than reaching past it: a test that bypasses the `validate_cwd`
    /// wiring can't catch a regression in it, and this module has already been
    /// bitten by exactly that once. `read_baseline_sync` now *requires* a
    /// `&SandboxRoot`, so bypassing it is no longer expressible.
    #[test]
    fn read_baseline_returns_the_head_version_not_the_working_tree() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit(); // commits f.txt = "one\n"
        std::fs::write(dir.path().join("f.txt"), "two\n").expect("write");
        let root = dir.path().canonicalize().expect("canonicalize");
        let store = store_with_project_root(&root.to_string_lossy());

        let result = read_baseline_sync(&sandbox_root(&store, root.to_str().unwrap()), "f.txt")
            .expect("read baseline");
        assert_eq!(
            result,
            BaselineContent::Tracked {
                content: Some("one\n".to_string())
            }
        );
    }

    /// A file that was never committed has no HEAD blob at all — that's the
    /// ordinary "nothing to diff against yet" case, not an error.
    #[test]
    fn read_baseline_reports_untracked_files() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        std::fs::write(dir.path().join("new.txt"), "brand new").expect("write");
        let root = dir.path().canonicalize().expect("canonicalize");
        let store = store_with_project_root(&root.to_string_lossy());

        let result = read_baseline_sync(&sandbox_root(&store, root.to_str().unwrap()), "new.txt")
            .expect("read baseline");
        assert_eq!(result, BaselineContent::Untracked);
    }

    /// A session whose `cwd` is not a git repo at all (supported by the
    /// All-files browser — see `ChangesView`'s note on the tab strip) must
    /// report `NotARepo`, never `Untracked`. The two used to collapse into
    /// the same `{tracked: false}` result, which the frontend maps to an
    /// empty baseline — so every file opened in a non-git folder painted a
    /// confidently wrong solid-green "every line added" gutter instead of
    /// degrading to no gutter at all.
    #[test]
    fn read_baseline_reports_a_non_git_dir_as_not_a_repo() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("f.txt"), "plain\n").expect("write");
        let root = dir.path().canonicalize().expect("canonicalize");
        let store = store_with_project_root(&root.to_string_lossy());

        let result = read_baseline_sync(&sandbox_root(&store, root.to_str().unwrap()), "f.txt")
            .expect("read baseline");
        assert_eq!(result, BaselineContent::NotARepo);
    }

    /// The one behavior none of the other `read_baseline` tests exercises:
    /// [`SandboxRoot::validate`] refusing a `cwd` that isn't a known
    /// session/project root — mirrors
    /// `diff_worktree_rejects_a_path_that_is_not_a_known_root` and
    /// `file_cmd::the_file_commands_reject_a_cwd_that_is_not_a_known_root`.
    /// Every other test here registers its own `cwd` as the known root, so
    /// none of them would notice the allowlist going missing.
    #[test]
    fn read_baseline_rejects_a_cwd_that_is_not_a_known_root() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().canonicalize().expect("canonicalize");
        let registered = tempfile::tempdir().expect("registered root");
        let store = store_with_project_root(&registered.path().to_string_lossy());

        let err = SandboxRoot::validate(&store, repo.to_str().unwrap()).unwrap_err();
        assert_eq!(err, "cwd is not a known session or project root");
    }

    /// Same sandbox as `file_cmd::read_file` — literally the same
    /// [`SandboxRoot::resolve`] call: a `path` that escapes `cwd` must be
    /// refused before it ever reaches git. Through a real [Sandbox root] (see
    /// the note on `read_baseline_returns_the_head_version_not_the_working_tree`)
    /// so the `cwd` wiring is exercised too, not just containment.
    #[test]
    fn read_baseline_refuses_paths_outside_the_root() {
        let root = tempfile::tempdir().expect("temp root");
        let cwd = root.path().join("cwd");
        std::fs::create_dir(&cwd).expect("mkdir");
        std::fs::write(root.path().join("secret.txt"), "top secret").expect("write");
        let store = store_with_project_root(&cwd.to_string_lossy());

        let err = read_baseline_sync(
            &sandbox_root(&store, cwd.to_str().unwrap()),
            "../secret.txt",
        )
        .unwrap_err();
        assert_ne!(err, "");
    }

    /// Same sandbox as `file_cmd::read_file`: `.git/` must be refused even
    /// though it would happily `cat-file` there. Through a real [Sandbox root]
    /// for the same reason as the escape test above.
    #[test]
    fn read_baseline_refuses_dot_git() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir_all(cwd.path().join(".git")).expect("mkdir");
        std::fs::write(cwd.path().join(".git/config"), "[remote]\n").expect("write");
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = read_baseline_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            ".git/config",
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains(".git"));
    }

    /// A committed blob with a NUL in its first 8 KiB must come back as
    /// `Tracked { content: None }`, not as a string full of replacement
    /// characters — the gutter has nothing sensible to diff against binary
    /// content.
    #[test]
    fn read_baseline_drops_binary_blobs() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().expect("repo dir");
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["init", "-b", "main"]);
        git_setup(repo, &["config", "user.email", "t@e.com"]);
        git_setup(repo, &["config", "user.name", "T"]);
        let mut bytes = b"png-ish header".to_vec();
        bytes.push(0);
        bytes.extend_from_slice(b"more bytes after the NUL");
        std::fs::write(dir.path().join("image.bin"), &bytes).expect("write");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "binary"]);
        let root = dir.path().canonicalize().expect("canonicalize");
        let store = store_with_project_root(&root.to_string_lossy());

        let result = read_baseline_sync(&sandbox_root(&store, root.to_str().unwrap()), "image.bin")
            .expect("read baseline");
        assert_eq!(
            result,
            BaselineContent::Tracked { content: None },
            "the blob exists in HEAD but can't be shown"
        );
    }

    /// The gap the NUL sniff leaves: a blob that is *not* valid UTF-8 but has
    /// no NUL in its first 8 KiB (a lone 0x80 continuation byte — Latin-1
    /// text, say) sails past the binary check and must still come back as
    /// `Tracked { content: None }` rather than as a lossy rendering the gutter
    /// would then diff against.
    #[test]
    fn read_baseline_drops_a_non_utf8_blob_with_no_nul() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().expect("repo dir");
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["init", "-b", "main"]);
        git_setup(repo, &["config", "user.email", "t@e.com"]);
        git_setup(repo, &["config", "user.name", "T"]);
        let mut bytes = b"caf".to_vec();
        // A lone continuation byte: never valid UTF-8, and not a NUL.
        bytes.push(0x80);
        bytes.extend_from_slice(b" au lait\n");
        std::fs::write(dir.path().join("latin.txt"), &bytes).expect("write");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "latin1"]);
        let root = dir.path().canonicalize().expect("canonicalize");
        let store = store_with_project_root(&root.to_string_lossy());

        let result = read_baseline_sync(&sandbox_root(&store, root.to_str().unwrap()), "latin.txt")
            .expect("read baseline");
        assert_eq!(
            result,
            BaselineContent::Tracked { content: None },
            "not UTF-8 is as unshowable as binary, NUL or no NUL"
        );
    }

    /// Parity with `file_cmd::read_file_sync`'s `is_file` check: a directory
    /// target used to propagate a raw git error instead of a clean one.
    #[test]
    fn read_baseline_rejects_a_directory_target() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        std::fs::create_dir(dir.path().join("subdir")).expect("mkdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        let store = store_with_project_root(&root.to_string_lossy());

        let err = read_baseline_sync(&sandbox_root(&store, root.to_str().unwrap()), "subdir")
            .unwrap_err();
        assert_eq!(err, "path is not a file");
    }

    /// A committed blob over `MAX_READ_BYTES` must come back as
    /// `Tracked { content: None }` rather than piping an unbounded blob
    /// over IPC.
    #[test]
    fn read_baseline_drops_oversized_blobs() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().expect("repo dir");
        let repo = dir.path().to_str().expect("utf8");
        git_setup(repo, &["init", "-b", "main"]);
        git_setup(repo, &["config", "user.email", "t@e.com"]);
        git_setup(repo, &["config", "user.name", "T"]);
        let big = "a".repeat(usize::try_from(crate::file_cmd::MAX_READ_BYTES).unwrap() + 500);
        std::fs::write(dir.path().join("big.txt"), &big).expect("write");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "big"]);
        let root = dir.path().canonicalize().expect("canonicalize");
        let store = store_with_project_root(&root.to_string_lossy());

        let result = read_baseline_sync(&sandbox_root(&store, root.to_str().unwrap()), "big.txt")
            .expect("read baseline");
        assert_eq!(
            result,
            BaselineContent::Tracked { content: None },
            "the blob exists in HEAD but can't be shown"
        );
    }

    /// The whole point of the command: the working-tree file goes back to
    /// exactly what HEAD holds.
    #[test]
    fn discard_file_changes_restores_the_committed_content() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit(); // commits f.txt = "one\n"
        std::fs::write(dir.path().join("f.txt"), "scribbled over\n").expect("write");
        let root = dir.path().canonicalize().expect("canonicalize");
        let store = store_with_project_root(&root.to_string_lossy());

        discard_file_changes_sync(&sandbox_root(&store, root.to_str().unwrap()), "f.txt")
            .expect("discard");

        assert_eq!(
            std::fs::read_to_string(root.join("f.txt")).expect("read"),
            "one\n"
        );
    }

    /// An untracked file has no committed version, so there is nothing to
    /// restore *to* — and `git checkout HEAD --` on one is a raw
    /// "pathspec did not match" error. Refused up front with wording that
    /// says what actually happened.
    #[test]
    fn discard_file_changes_refuses_an_untracked_file() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        std::fs::write(dir.path().join("new.txt"), "brand new").expect("write");
        let root = dir.path().canonicalize().expect("canonicalize");
        let store = store_with_project_root(&root.to_string_lossy());

        let err =
            discard_file_changes_sync(&sandbox_root(&store, root.to_str().unwrap()), "new.txt")
                .unwrap_err();

        assert_eq!(err, "file has no committed version to restore");
        assert!(
            root.join("new.txt").exists(),
            "a refusal must not have touched the file"
        );
    }

    /// Same sandbox as `read_baseline`/`read_file` — literally the same
    /// [`SandboxRoot::resolve`] call, and it matters more here than on either
    /// of them: this one WRITES.
    #[test]
    fn discard_file_changes_refuses_paths_outside_the_root() {
        let root = tempfile::tempdir().expect("temp root");
        let cwd = root.path().join("cwd");
        std::fs::create_dir(&cwd).expect("mkdir");
        std::fs::write(root.path().join("secret.txt"), "top secret").expect("write");
        let store = store_with_project_root(&cwd.to_string_lossy());

        let err = discard_file_changes_sync(
            &sandbox_root(&store, cwd.to_str().unwrap()),
            "../secret.txt",
        )
        .unwrap_err();

        assert_eq!(err, "path escapes cwd");
        assert_eq!(
            std::fs::read_to_string(root.path().join("secret.txt")).expect("read"),
            "top secret"
        );
    }

    /// `.git/` must be refused, with the *write* verb: this command hands the
    /// path to `git checkout`, which would happily overwrite a config or a
    /// hook there.
    #[test]
    fn discard_file_changes_refuses_dot_git() {
        let cwd = tempfile::tempdir().expect("temp cwd");
        std::fs::create_dir_all(cwd.path().join(".git")).expect("mkdir");
        std::fs::write(cwd.path().join(".git/config"), "[remote]\n").expect("write");
        let store = store_with_project_root(&cwd.path().to_string_lossy());

        let err = discard_file_changes_sync(
            &sandbox_root(&store, cwd.path().to_str().unwrap()),
            ".git/config",
        )
        .unwrap_err();

        assert_eq!(err, "refusing to write inside .git");
    }

    /// The pathspec git receives is **wildmatched**, so any glob metacharacter
    /// in a real, ordinary filename silently widens a single-file discard into
    /// a multi-file one. `app/[slug]/` is not an exotic input — it is how every
    /// Next.js repo spells a dynamic route, and `[slug]` is a character class
    /// that also matches `s`. The confirm dialog names one file; without a
    /// literal pathspec the user loses uncommitted work in the others.
    #[test]
    fn discard_file_changes_restores_only_the_named_file() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::create_dir_all(dir.path().join("app/[slug]")).expect("mkdir");
        std::fs::create_dir_all(dir.path().join("app/s")).expect("mkdir");
        std::fs::write(dir.path().join("app/[slug]/page.tsx"), "committed\n").expect("write");
        std::fs::write(dir.path().join("app/s/page.tsx"), "committed\n").expect("write");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "routes"]);
        std::fs::write(dir.path().join("app/[slug]/page.tsx"), "target edit\n").expect("write");
        std::fs::write(dir.path().join("app/s/page.tsx"), "BYSTANDER WORK\n").expect("write");
        let root = dir.path().canonicalize().expect("canonicalize");
        let store = store_with_project_root(&root.to_string_lossy());

        discard_file_changes_sync(
            &sandbox_root(&store, root.to_str().unwrap()),
            "app/[slug]/page.tsx",
        )
        .expect("discard");

        assert_eq!(
            std::fs::read_to_string(root.join("app/[slug]/page.tsx")).expect("read"),
            "committed\n",
            "the named file is the one that must be restored"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("app/s/page.tsx")).expect("read"),
            "BYSTANDER WORK\n",
            "a file the user never named must keep its uncommitted content"
        );
    }

    /// [`SandboxRoot::resolve`] settles containment on the **canonical** path,
    /// but git resolves `..` **lexically** — so a symlink to a deeper directory
    /// inside the root makes the two disagree, in the escaping direction. The
    /// pathspec handed to git must therefore be derived from the resolved path,
    /// never from the raw string the frontend sent.
    #[test]
    fn discard_file_changes_does_not_escape_via_a_symlink_and_dotdot() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::create_dir_all(dir.path().join("frontend/a/b/c")).expect("mkdir");
        std::fs::write(dir.path().join("outside.txt"), "committed\n").expect("write");
        std::fs::write(dir.path().join("frontend/a/b/c/x.txt"), "committed\n").expect("write");
        // The decoy the canonical path lands on, so `canonicalize` succeeds and
        // the containment check says "inside the root" — while git, resolving
        // the same `..` segments lexically, lands on the one above it.
        std::fs::write(dir.path().join("frontend/a/outside.txt"), "decoy\n").expect("write");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "tree"]);
        #[cfg(unix)]
        std::os::unix::fs::symlink("a/b/c", dir.path().join("frontend/short")).expect("symlink");
        std::fs::write(dir.path().join("outside.txt"), "WORK OUTSIDE THE ROOT\n").expect("write");
        std::fs::write(dir.path().join("frontend/a/outside.txt"), "decoy edit\n").expect("write");
        // The sandbox root is the *subdirectory*, which `validate_cwd` accepts
        // as a descendant of a known root — and `outside.txt` sits above it.
        let cwd = dir
            .path()
            .join("frontend")
            .canonicalize()
            .expect("canonicalize");
        let store = store_with_project_root(&cwd.to_string_lossy());

        discard_file_changes_sync(
            &sandbox_root(&store, cwd.to_str().unwrap()),
            "short/../../outside.txt",
        )
        .expect("the path resolves inside the root, so it is a legitimate call");

        assert_eq!(
            std::fs::read_to_string(dir.path().join("outside.txt")).expect("read"),
            "WORK OUTSIDE THE ROOT\n",
            "nothing above the sandbox root may be touched"
        );
        assert_eq!(
            std::fs::read_to_string(cwd.join("a/outside.txt")).expect("read"),
            "decoy\n",
            "the file the sandbox actually resolved to is the one acted on"
        );
    }

    /// LOW 2a: `baseline_oid` must be constrained to look like an actual git
    /// object id, not any revision expression `git diff` would accept
    /// (`HEAD`, `:/init`, `HEAD@{0}`, `main^{tree}`). Nothing side-effecting
    /// sits behind it (diff/rev-parse are read-only), so this isn't closing
    /// an injection — just retiring the question of what else could reach
    /// `git diff` here.
    #[test]
    fn diff_session_changes_rejects_non_oid_baseline() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().canonicalize().expect("canonicalize");
        let repo_str = repo.to_str().expect("utf8");
        let store = store_with_project_root(repo_str);

        for bad in ["HEAD", ":/init", "HEAD@{0}", "main^{tree}", "not-hex-zzzz"] {
            let err = diff_session_changes_for(&store, repo_str, bad, Budget::DEFAULT).unwrap_err();
            assert_eq!(
                err, "baseline_oid must be a git object id",
                "expected {bad:?} to be rejected, got {err:?}"
            );
        }
    }

    /// A real `snapshot_tree` oid (40 hex chars for sha1, this repo's
    /// default) must still be accepted by the same guard.
    #[test]
    fn diff_session_changes_accepts_a_real_oid_baseline() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().canonicalize().expect("canonicalize");
        let repo_str = repo.to_str().expect("utf8");
        let store = store_with_project_root(repo_str);
        let baseline = snapshot_tree(repo_str, Budget::DEFAULT).expect("snapshot");

        let diff = diff_session_changes_for(&store, repo_str, &baseline, Budget::DEFAULT)
            .expect("valid oid baseline should be accepted");
        assert_eq!(diff.files, [] as [kriyon_core::git::FileDiff; 0]);
    }

    /// [`diff_session_changes_sync`] must catch edits made by ANY means (not
    /// just tool-tracked edits — simulates a Bash/sed edit that never went
    /// through a tracked tool call), show untracked-after-baseline files as
    /// added, and self-correct: reverting a file back to its baseline content
    /// must make it disappear from the diff again.
    #[test]
    fn diff_session_changes_catches_non_tool_edits_and_self_corrects_reverts() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::write(dir.path().join("a.txt"), "1\n").expect("write");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "a.txt"]);
        let baseline = snapshot_tree(repo, Budget::DEFAULT).expect("snapshot");

        // Edit made by ANY means (simulating a Bash/sed edit).
        std::fs::write(dir.path().join("a.txt"), "1\n2\n").expect("write");
        std::fs::write(dir.path().join("b.txt"), "new\n").expect("write"); // untracked new file after baseline

        let diff =
            session_diff(repo, DiffAnchor::Baseline(&baseline), Budget::DEFAULT).expect("diff");
        let paths: Vec<_> = diff.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.txt"), "got {paths:?}"); // caught even though no tool "touched" it
        assert!(paths.contains(&"b.txt"), "got {paths:?}"); // untracked-after-baseline shows as added

        // Revert a.txt to baseline content -> disappears.
        std::fs::write(dir.path().join("a.txt"), "1\n").expect("write");
        let diff2 =
            session_diff(repo, DiffAnchor::Baseline(&baseline), Budget::DEFAULT).expect("diff");
        let paths2: Vec<_> = diff2.files.iter().map(|f| f.path.as_str()).collect();
        assert!(!paths2.contains(&"a.txt"), "got {paths2:?}");
    }

    /// Uncommitted changes present BEFORE the baseline snapshot was taken are
    /// baked into the baseline tree itself, so they must never show up in the
    /// session diff — only changes made AFTER the baseline are "session
    /// changes".
    #[test]
    fn diff_session_changes_excludes_pre_session_dirt() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        std::fs::write(dir.path().join("a.txt"), "1\n").expect("write");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "a.txt"]);
        std::fs::write(dir.path().join("dirty.txt"), "predates\n").expect("write"); // uncommitted BEFORE baseline
        let baseline = snapshot_tree(repo, Budget::DEFAULT).expect("snapshot");
        // no further edits

        let diff =
            session_diff(repo, DiffAnchor::Baseline(&baseline), Budget::DEFAULT).expect("diff");
        assert!(
            diff.files.is_empty(),
            "pre-session dirt is baked into the baseline, got {:?}",
            diff.files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
    }

    /// [`is_missing_object_error`] must match only on the *named* oid
    /// appearing in a "bad object" message — a `git diff` failure that
    /// mentions "bad object" for some unrelated oid must not be
    /// misclassified as the pruned-baseline case, and an unrelated failure
    /// (no "bad object" at all) must not match either.
    #[test]
    fn is_missing_object_error_matches_only_the_named_oid() {
        let oid = "deadbeefcafe";
        assert!(is_missing_object_error(
            &format!("fatal: bad object {oid}"),
            oid
        ));
        assert!(!is_missing_object_error("fatal: bad object feedface", oid));
        assert!(!is_missing_object_error("fatal: some other failure", oid));
    }

    /// I1 (round-two review, BLOCKER): a `baseline_oid` is a dangling tree
    /// object by construction (see this module's doc comment), so `git gc
    /// --prune=now`, `git repack -ad`, or the default two-week
    /// `gc.pruneExpire` WILL eventually collect it. When that happens,
    /// [`diff_session_changes_sync`] must tag its error with
    /// [`BASELINE_OBJECT_MISSING_PREFIX`] rather than returning git's raw
    /// "fatal: bad object" message undistinguished from any other failure —
    /// that tag is what lets the frontend degrade to `diff_working_tree`
    /// instead of parking a dead baseline forever (the bug this fixes: every
    /// later refresh used to fail identically, forever). A syntactically
    /// valid 40-hex-char oid that was never written to this repo's object
    /// store stands in for a real baseline `git gc` has since pruned —
    /// git's `bad object` failure is identical either way, so this doesn't
    /// need an actual `git gc` run (slow, and not what this unit is
    /// responsible for verifying).
    #[test]
    fn diff_session_changes_detects_a_pruned_missing_baseline_object() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        let missing_oid = "f".repeat(40);

        let err =
            session_diff(repo, DiffAnchor::Baseline(&missing_oid), Budget::DEFAULT).unwrap_err();
        assert!(
            err.starts_with(&format!("kind:{BASELINE_PRUNED}: ")),
            "expected the kind:{BASELINE_PRUNED}: leader, got {err:?}"
        );
        assert!(
            err.contains(BASELINE_OBJECT_MISSING_PREFIX),
            "the human-readable half must survive the tag verbatim (got {err:?})"
        );
    }

    /// Contract pin (B4): the pruned-baseline self-heal (I1) works only if this
    /// prefix is byte-identical to the one the frontend displays via
    /// `failureMessage` — it is no longer what the frontend classifies on (see
    /// [`BASELINE_PRUNED`] / [Command failure kind]), only what it shows. There
    /// is no shared codegen across the Rust↔JS boundary, so the two literals
    /// are kept in sync by hand — this test freezes the Rust side to the exact
    /// string, and its sibling `matches the exact frozen contract prefix` in
    /// `src/state/changes.test.ts` freezes the JS side. Change one → the pin on
    /// that side fails loudly, telling you to change both.
    #[test]
    fn baseline_object_missing_prefix_is_the_frozen_contract_string() {
        assert_eq!(BASELINE_OBJECT_MISSING_PREFIX, "baseline object missing: ");
    }

    /// The same contract pin for the [Working-tree budget] refusal, frozen on
    /// the JS side by `matches the exact frozen contract prefix` in
    /// `src/state/changes.test.ts`. Also asserts the two tags stay distinct:
    /// they degrade the same way but differ on whether the session's stored
    /// baseline oid is cleared, so one matching the other's slug would
    /// silently throw away a still-valid baseline.
    #[test]
    fn working_tree_too_large_prefix_is_the_frozen_contract_string() {
        assert_eq!(WORKING_TREE_TOO_LARGE_PREFIX, "working tree too large: ");
        assert!(!WORKING_TREE_TOO_LARGE_PREFIX.starts_with(BASELINE_OBJECT_MISSING_PREFIX));
        assert!(!BASELINE_OBJECT_MISSING_PREFIX.starts_with(WORKING_TREE_TOO_LARGE_PREFIX));
        assert_ne!(OVER_BUDGET, BASELINE_PRUNED);
    }

    /// The tag must fire only for the missing-object case — an otherwise
    /// valid diff must not be misclassified.
    #[test]
    fn diff_session_changes_does_not_tag_a_successful_diff() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        let baseline = snapshot_tree(repo, Budget::DEFAULT).expect("snapshot");

        let diff =
            session_diff(repo, DiffAnchor::Baseline(&baseline), Budget::DEFAULT).expect("diff");
        assert_eq!(diff.files, [] as [kriyon_core::git::FileDiff; 0]);
    }

    /// I3 (round-two review, BLOCKER): a large untracked file must not
    /// balloon the tree-vs-tree diff payload the way the legacy
    /// `diff_working_tree_sync` path is guarded against via
    /// `UNTRACKED_MAX_BYTES` — this path has no separate untracked-file pass
    /// to attach that guard to (see the doc comment on
    /// `diff_session_changes_sync`), so the guard here is `-c
    /// core.bigFileThreshold=1m` on the `git diff` call itself. Uses 2 MB
    /// (comfortably over the 1 MB threshold, small enough to keep this test
    /// fast) rather than the reviewer's 8.8 MB reproduction — only size
    /// relative to the threshold matters, `core.bigFileThreshold` classifies
    /// by size alone, not content.
    #[test]
    fn diff_session_changes_caps_a_large_untracked_file_via_big_file_threshold() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");
        let baseline = snapshot_tree(repo, Budget::DEFAULT).expect("snapshot");

        let big_content = "x".repeat(2_000_000);
        std::fs::write(dir.path().join("big.txt"), &big_content).expect("write big file");

        let diff =
            session_diff(repo, DiffAnchor::Baseline(&baseline), Budget::DEFAULT).expect("diff");
        let file = diff
            .files
            .iter()
            .find(|f| f.path == "big.txt")
            .expect("big.txt present");
        assert!(
            file.binary,
            "a file over core.bigFileThreshold must be reported as binary, not diffed line-by-line"
        );
        assert!(
            file.hunks.is_empty(),
            "a binary-flagged file must carry no line hunks, got {:?}",
            file.hunks
        );
    }

    /// [`repo_toplevel_sync`] must resolve to the repo's worktree root,
    /// regardless of macOS's `/tmp` -> `/private/tmp` symlink (hence the
    /// `canonicalize` comparison on both sides).
    #[test]
    fn repo_toplevel_returns_worktree_root() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");

        let top = repo_toplevel_sync(repo).expect("repo_toplevel");
        assert_eq!(
            std::fs::canonicalize(&top).expect("canonicalize top"),
            std::fs::canonicalize(repo).expect("canonicalize repo")
        );
    }

    #[test]
    fn merge_worktree_clean_then_conflict() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().expect("utf8");

        // A non-conflicting branch merges clean.
        git_setup(repo, &["checkout", "-b", "feature"]);
        std::fs::write(dir.path().join("g.txt"), "new\n").expect("write");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "add g"]);
        git_setup(repo, &["checkout", "main"]);
        assert_eq!(
            merge_worktree_with(repo, "feature", None).expect("merge"),
            MergeOutcome::Clean
        );

        // Diverge both branches on the same file to force a conflict.
        git_setup(repo, &["checkout", "-b", "conflict"]);
        std::fs::write(dir.path().join("f.txt"), "theirs\n").expect("write");
        git_setup(repo, &["commit", "-am", "theirs"]);
        git_setup(repo, &["checkout", "main"]);
        std::fs::write(dir.path().join("f.txt"), "ours\n").expect("write");
        git_setup(repo, &["commit", "-am", "ours"]);

        match merge_worktree_with(repo, "conflict", None).expect("merge") {
            MergeOutcome::Conflicted { files } => {
                assert!(files.contains(&"f.txt".to_string()), "got {files:?}");
            }
            MergeOutcome::Clean => panic!("expected a conflict"),
        }
    }

    /// Write an executable git hook into `repo`.
    #[cfg(unix)]
    fn write_hook(repo: &std::path::Path, name: &str, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let hook = repo.join(".git/hooks").join(name);
        std::fs::write(&hook, format!("#!/bin/sh\n{body}\n")).expect("write hook");
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    /// Make `main` and `feature` diverge (no conflict), so merging needs a
    /// merge commit — the case that runs the commit hooks.
    fn diverge_feature(dir: &std::path::Path) {
        let repo = dir.to_str().expect("utf8");
        git_setup(repo, &["checkout", "-b", "feature"]);
        std::fs::write(dir.join("g.txt"), "feature\n").expect("write");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "feature"]);
        git_setup(repo, &["checkout", "main"]);
        std::fs::write(dir.join("h.txt"), "main\n").expect("write");
        git_setup(repo, &["add", "."]);
        git_setup(repo, &["commit", "-m", "main"]);
    }

    /// A tool that exists only in its own folder, so it is found only through a
    /// PATH that names that folder, standing in for pnpm in `~/Library/pnpm/bin`.
    /// Returns the folder and a PATH with it in front; the tool touches `$1`.
    #[cfg(unix)]
    fn shell_only_tool() -> (tempfile::TempDir, String) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tool dir");
        let tool = dir.path().join("kriyon-hook-tool");
        std::fs::write(&tool, "#!/bin/sh\ntouch \"$1\"\n").expect("write tool");
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let path = format!("{}:/usr/bin:/bin", dir.path().display());
        (dir, path)
    }

    /// A merge-back hook that calls a tool from the person's shell PATH finds it:
    /// the merge runs with the [Shell PATH] it is given.
    #[test]
    #[cfg(unix)]
    fn a_merge_hook_finds_tools_on_the_shell_path() {
        if !git_available() {
            return;
        }
        let (_tools, path) = shell_only_tool();
        let dir = init_repo_with_commit();
        diverge_feature(dir.path());
        let marker = dir.path().join("hook-ran");
        write_hook(
            dir.path(),
            "commit-msg",
            &format!("kriyon-hook-tool '{}'", marker.display()),
        );

        let outcome = merge_worktree_with(dir.path().to_str().unwrap(), "feature", Some(&path))
            .expect("the hook found its tool, so the merge went through");

        assert_eq!(outcome, MergeOutcome::Clean);
        assert!(marker.exists(), "the hook ran its tool");
    }

    /// The same for a new worktree's post-checkout hook (git-lfs, say).
    #[test]
    #[cfg(unix)]
    fn a_checkout_hook_finds_tools_on_the_shell_path() {
        if !git_available() {
            return;
        }
        let (_tools, path) = shell_only_tool();
        let dir = init_repo_with_commit();
        let marker = dir.path().join("hook-ran");
        write_hook(
            dir.path(),
            "post-checkout",
            &format!("kriyon-hook-tool '{}'", marker.display()),
        );
        let parent = tempfile::tempdir().expect("parent");
        let wt = parent.path().join("wt");

        create_worktree_with(
            dir.path().to_str().unwrap(),
            "feat/lfs",
            wt.to_str().unwrap(),
            Some(&path),
        )
        .expect("worktree");

        assert!(marker.exists(), "the hook ran its tool");
    }

    /// A worktree that was already there is not one this call made: asking for
    /// it again must fail, not open a second session in the same folder.
    #[test]
    fn a_worktree_that_already_existed_is_still_an_error() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().unwrap();
        let parent = tempfile::tempdir().expect("parent");
        let wt = parent.path().join("wt");
        let wt_path = wt.to_str().unwrap();
        create_worktree_with(repo, "feat/again", wt_path, None).expect("first");

        assert!(
            create_worktree_with(repo, "feat/again", wt_path, None).is_err(),
            "the branch and folder are taken"
        );
    }

    /// A merge a hook rejects leaves git mid-merge; the base checkout must be
    /// put back, not left half-merged for the person to untangle.
    #[test]
    #[cfg(unix)]
    fn a_merge_a_hook_rejects_is_undone() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().unwrap();
        diverge_feature(dir.path());
        write_hook(
            dir.path(),
            "commit-msg",
            "echo 'commitlint: not found' >&2; exit 1",
        );

        let err = merge_worktree_with(repo, "feature", None).expect_err("hook rejects the merge");
        assert!(
            err.contains("commitlint"),
            "the hook's error is shown: {err}"
        );
        assert!(!dir.path().join(".git/MERGE_HEAD").exists(), "merge undone");
        assert!(
            !dir.path().join("g.txt").exists(),
            "feature's file not left behind"
        );
        assert_eq!(
            run_git(repo, &["status", "--porcelain"]).unwrap(),
            "",
            "clean"
        );
    }

    /// A merge the person already had open is theirs: Kriyon's refused merge
    /// must not abort it.
    #[test]
    fn a_merge_already_in_progress_is_left_alone() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().unwrap();
        git_setup(repo, &["checkout", "-b", "conflict"]);
        std::fs::write(dir.path().join("f.txt"), "theirs\n").expect("write");
        git_setup(repo, &["commit", "-am", "theirs"]);
        git_setup(repo, &["checkout", "main"]);
        std::fs::write(dir.path().join("f.txt"), "ours\n").expect("write");
        git_setup(repo, &["commit", "-am", "ours"]);
        let _ = GitRun::new(repo).args(["merge", "conflict"]).outcome();
        assert!(
            dir.path().join(".git/MERGE_HEAD").exists(),
            "setup: mid-merge"
        );

        let _ = merge_worktree_with(repo, "conflict", None);
        assert!(
            dir.path().join(".git/MERGE_HEAD").exists(),
            "their merge kept"
        );
    }

    /// `git worktree add` exits non-zero when a post-checkout hook fails (a
    /// missing git-lfs), yet the worktree exists. Reporting that as "not
    /// created" makes the retry fail on the now-taken branch.
    #[test]
    #[cfg(unix)]
    fn a_worktree_whose_checkout_hook_fails_still_counts_as_created() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().unwrap();
        write_hook(dir.path(), "post-checkout", "exit 1");
        let parent = tempfile::tempdir().expect("parent");
        let wt = parent.path().join("wt");
        let wt_path = wt.to_str().unwrap();

        create_worktree_with(repo, "feat/hooked", wt_path, None).expect("worktree is there");
        assert!(wt.join("f.txt").exists(), "checked out");
    }

    /// A real failure (the branch is already taken) is still an error.
    #[test]
    fn a_worktree_on_a_taken_branch_is_still_an_error() {
        if !git_available() {
            return;
        }
        let dir = init_repo_with_commit();
        let repo = dir.path().to_str().unwrap();
        git_setup(repo, &["branch", "taken"]);
        let parent = tempfile::tempdir().expect("parent");
        let wt = parent.path().join("wt");
        assert!(create_worktree_with(repo, "taken", wt.to_str().unwrap(), None).is_err());
    }
}
