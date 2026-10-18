//! [Working-tree watch] — the pure half: which filesystem paths under a repo
//! are worth re-running a [Session diff] for, and when a burst of them should
//! actually fire.
//!
//! The Tauri shell (`src-tauri/src/tree_watch.rs`) owns the `notify` watcher
//! and the thread; everything decidable without a filesystem lives here so it
//! can be unit-tested directly.
//!
//! **The asymmetry that shapes [`is_interesting`].** A path wrongly ignored is
//! the exact bug this watch exists to fix — a change the user made that the
//! view never notices. A path wrongly kept costs one debounced `git diff`
//! (~0.14s on this repo, coalesced by both [`Coalescer`] here and the
//! frontend's own debounce). So the ignore list stays *small and certain*:
//! only paths that could not possibly appear in a diff, never a guess about
//! what the user probably doesn't care about.
//!
//! **The one hazard that must not be got wrong.** Computing the diff itself
//! writes inside `.git` — `snapshot_tree` runs `git add -A` against a scratch
//! index (`.git/kriyon-scratch-index`) and `git write-tree` creates objects
//! under `.git/objects`. A watch that treated those as changes would refresh
//! because it refreshed, forever. Ignoring all of `.git` except `HEAD` closes
//! that by construction rather than by naming our own scratch file — a future
//! git-touching feature can't reopen the loop by writing somewhere new.

use std::path::Path;
use std::time::Duration;

/// Directory names whose entire subtree never contributes to a [Session diff]:
/// build output and dependency trees that every one of these ecosystems also
/// gitignores, so `git add -A` skips them and a refresh triggered by one could
/// only ever be wasted work. Deliberately short — see the module doc comment
/// for why this list errs toward keeping paths rather than dropping them.
const IGNORED_DIR_NAMES: &[&str] = &[
    ".next",
    ".turbo",
    ".venv",
    "__pycache__",
    "coverage",
    "dist",
    "node_modules",
    "target",
];

/// File names that are never a real working-tree change.
const IGNORED_FILE_NAMES: &[&str] = &[".DS_Store"];

/// The only entry inside `.git` that means the working tree moved under us:
/// `HEAD` changes on checkout/branch switch. Everything else in there is
/// either irrelevant to a tree-vs-tree diff (`index` — the diff snapshots the
/// working tree into its own scratch index and never reads the real one) or
/// written *by* computing the diff (see the module doc comment).
const WATCHED_GIT_ENTRY: &str = "HEAD";

/// Whether a change at `path` could plausibly alter `repo_root`'s
/// [Session diff], and so should wake the watch.
///
/// A path outside `repo_root` is never interesting — the watch is recursive
/// from the root, so this can only happen for a symlinked-in path, which the
/// diff doesn't follow either.
#[must_use]
pub fn is_interesting(repo_root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(repo_root) else {
        return false;
    };
    let components: Vec<&str> = relative
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    if components.is_empty() {
        return false;
    }
    if components[0] == ".git" {
        // Only `.git/HEAD` itself — not `.git/HEAD.lock`, not anything below a
        // directory that happens to be called HEAD.
        return components.len() == 2 && components[1] == WATCHED_GIT_ENTRY;
    }
    if components
        .iter()
        .any(|name| IGNORED_DIR_NAMES.contains(name))
    {
        return false;
    }
    let last = components[components.len() - 1];
    !IGNORED_FILE_NAMES.contains(&last)
}

/// How long after the last interesting change to wait before firing, so a burst
/// (a formatter rewriting 200 files, a `git checkout`) settles into one diff.
pub const DEBOUNCE: Duration = Duration::from_millis(250);

/// The longest a *continuous* stream of changes may suppress a fire. Without
/// this, [`Coalescer`] would be a pure trailing debounce: something writing
/// steadily faster than [`DEBOUNCE`] — a running build, a watch-mode compiler —
/// would push the deadline forward forever and the view would stay frozen for
/// as long as it ran. That starvation is the failure mode this cap exists for.
pub const MAX_WAIT: Duration = Duration::from_secs(1);

/// Decides when a burst of interesting changes becomes one fire: quiet for
/// [`DEBOUNCE`], or dirty for [`MAX_WAIT`], whichever comes first.
///
/// Time is passed in rather than read from a clock so the whole policy is
/// testable without sleeping. The Tauri shell feeds it `Instant` deltas.
#[derive(Debug, Default)]
pub struct Coalescer {
    /// Time since the first change of the current burst, or `None` when clean.
    dirty_for: Option<Duration>,
    /// Time since the most recent change of the current burst.
    quiet_for: Duration,
}

impl Coalescer {
    /// Start (or extend) a burst. Idempotent within one burst — only the first
    /// call anchors [`MAX_WAIT`].
    pub fn touch(&mut self) {
        if self.dirty_for.is_none() {
            self.dirty_for = Some(Duration::ZERO);
        }
        self.quiet_for = Duration::ZERO;
    }

    /// Advance the clock by `elapsed` and report whether the burst should fire
    /// now. Returns `false` while clean, so an idle watch never fires.
    pub fn tick(&mut self, elapsed: Duration) -> bool {
        let Some(dirty_for) = self.dirty_for else {
            return false;
        };
        let dirty_for = dirty_for + elapsed;
        self.quiet_for += elapsed;
        if self.quiet_for >= DEBOUNCE || dirty_for >= MAX_WAIT {
            self.dirty_for = None;
            self.quiet_for = Duration::ZERO;
            return true;
        }
        self.dirty_for = Some(dirty_for);
        false
    }

    /// Whether a burst is currently pending.
    #[must_use]
    pub fn is_dirty(&self) -> bool {
        self.dirty_for.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        PathBuf::from("/repo")
    }

    fn interesting(rel: &str) -> bool {
        is_interesting(&root(), &root().join(rel))
    }

    #[test]
    fn ordinary_source_files_are_interesting() {
        assert!(interesting("src/main.rs"));
        assert!(interesting("README.md"));
        assert!(interesting("deeply/nested/path/to/file.ts"));
    }

    #[test]
    fn build_output_and_dependency_trees_are_ignored() {
        assert!(!interesting("node_modules/react/index.js"));
        assert!(!interesting("target/debug/kriyon"));
        assert!(!interesting("dist/assets/index-abc.js"));
        assert!(!interesting("src/__pycache__/mod.pyc"));
        assert!(!interesting("packages/web/node_modules/x/y.js"));
    }

    #[test]
    fn a_directory_named_like_an_ignored_one_is_ignored_at_any_depth() {
        // The scan is component-wise, not prefix-wise: a nested `target` in a
        // cargo workspace member is just as much build output as the root one.
        assert!(!interesting("crates/core/target/debug/build.rs"));
    }

    #[test]
    fn git_internals_are_ignored_so_computing_the_diff_cannot_retrigger_itself() {
        // `snapshot_tree` writes both of these on every single refresh. If
        // either woke the watch, every refresh would schedule the next one.
        assert!(!interesting(".git/kriyon-scratch-index"));
        assert!(!interesting(".git/objects/ab/cdef0123456789"));
        assert!(!interesting(".git/index"));
        assert!(!interesting(".git/refs/heads/main"));
    }

    #[test]
    fn git_head_is_watched_so_a_branch_switch_refreshes() {
        assert!(interesting(".git/HEAD"));
    }

    #[test]
    fn git_head_lock_is_not_git_head() {
        // Git writes `HEAD.lock` around every ref update; firing on it would
        // double every branch switch and fire on operations that then abort.
        assert!(!interesting(".git/HEAD.lock"));
        assert!(!interesting(".git/logs/HEAD"));
    }

    #[test]
    fn noise_files_are_ignored() {
        assert!(!interesting(".DS_Store"));
        assert!(!interesting("src/.DS_Store"));
    }

    #[test]
    fn a_dotfile_that_is_real_content_stays_interesting() {
        assert!(interesting(".gitignore"));
        assert!(interesting(".github/workflows/ci.yml"));
        assert!(interesting(".claude/settings.json"));
    }

    #[test]
    fn a_path_outside_the_repo_is_never_interesting() {
        assert!(!is_interesting(&root(), Path::new("/elsewhere/file.ts")));
        assert!(!is_interesting(&root(), &root()));
    }

    #[test]
    fn a_clean_coalescer_never_fires() {
        let mut c = Coalescer::default();
        assert!(!c.is_dirty());
        for _ in 0..100 {
            assert!(!c.tick(Duration::from_millis(100)));
        }
    }

    #[test]
    fn one_change_fires_after_the_debounce_and_not_before() {
        let mut c = Coalescer::default();
        c.touch();
        assert!(!c.tick(Duration::from_millis(100)));
        assert!(!c.tick(Duration::from_millis(100)));
        assert!(c.tick(Duration::from_millis(100))); // 300ms >= DEBOUNCE
        assert!(!c.is_dirty());
    }

    #[test]
    fn a_burst_coalesces_into_one_fire() {
        let mut c = Coalescer::default();
        for _ in 0..5 {
            c.touch();
            assert!(!c.tick(Duration::from_millis(50)));
        }
        // Only once the writes stop does it fire, once.
        assert!(!c.tick(Duration::from_millis(100)));
        assert!(c.tick(Duration::from_millis(150)));
        assert!(!c.tick(Duration::from_millis(150)));
    }

    #[test]
    fn a_continuous_writer_cannot_starve_the_fire() {
        // The regression this cap exists for: something writing faster than
        // DEBOUNCE forever. A pure trailing debounce would never fire at all.
        let mut c = Coalescer::default();
        let mut fires = 0;
        for _ in 0..100 {
            c.touch();
            if c.tick(Duration::from_millis(100)) {
                fires += 1;
            }
        }
        // 100 ticks x 100ms = 10s of continuous writing, capped at MAX_WAIT.
        assert_eq!(fires, 10, "expected one fire per MAX_WAIT window");
    }

    #[test]
    fn firing_rearms_cleanly_for_the_next_burst() {
        let mut c = Coalescer::default();
        c.touch();
        assert!(c.tick(DEBOUNCE));
        assert!(!c.is_dirty());
        c.touch();
        assert!(c.is_dirty());
        assert!(c.tick(DEBOUNCE));
    }
}
