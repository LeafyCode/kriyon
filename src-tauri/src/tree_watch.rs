//! [Working-tree watch] — the Tauri half: one recursive `notify` watch per repo
//! root, shared by every [Session] running in it, emitting `working-tree-changed`
//! when the tree actually moves.
//!
//! Why this exists: before it, the only thing that re-ran a [Session diff] was
//! a *completed main-agent tool* observed in the hook-event stream (see
//! `applyActivity` in `src/state/sessions.ts`). Everything else that changes
//! files — the user's own save in the [Code editor] or an external editor, a
//! `git checkout`/`stash`/`pull`, a build step, a subagent still mid-run —
//! left the whole [Changes view] stale with nothing to re-arm it. Watching the
//! tree itself covers all of them with one signal, because it observes the
//! writes rather than trying to enumerate who might make them.
//!
//! Which paths count, and how a burst becomes one event, are decided by
//! [`kriyon_core::tree_watch`] — pure and unit-tested there. This module is the
//! thread, the `notify` subscription, and the refcounted registry.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use kriyon_core::session::SessionId;
use kriyon_core::tree_watch::{is_interesting, Coalescer};

/// How often the coalescing thread wakes to advance [`Coalescer`]. Small enough
/// that the 250ms debounce lands close to on time, large enough that an idle
/// watch costs essentially nothing.
const TICK: Duration = Duration::from_millis(50);

/// Payload for the `working-tree-changed` event: which repo moved. The frontend
/// matches it against its own [Repo toplevel] cache to decide which sessions to
/// refresh — the watch is per *repo*, not per session, since several sessions
/// commonly share one checkout.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeChangedPayload {
    pub repo_root: String,
}

/// A live working-tree watch: the `notify` watcher plus the coalescing thread.
/// Dropping it stops both — the thread observes `stop` and exits, and dropping
/// the watcher ends the filesystem subscription.
pub struct TreeWatch {
    _watcher: notify::RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

impl Drop for TreeWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Watch `repo_root` recursively, calling `on_change` once per settled burst of
/// interesting changes. Keep the returned watch alive to keep watching; drop it
/// to stop.
///
/// Filtering happens in the `notify` callback, before anything is queued: on
/// macOS the recursive `FSEvents` stream cannot exclude subpaths, so a repo with
/// a busy `node_modules`/`target` would otherwise wake the thread constantly.
///
/// # Errors
/// Returns an error string if the `notify` watcher cannot be created or cannot
/// begin watching `repo_root`.
pub fn spawn_tree_watch<F>(repo_root: &Path, on_change: F) -> Result<TreeWatch, String>
where
    F: Fn() + Send + 'static,
{
    use notify::Watcher as _;

    let (tx, rx) = mpsc::channel::<()>();
    // Filter against the *canonical* root. On macOS the events arrive from
    // FSEvents already resolved (`/private/var/...`), so a root reached through
    // a symlink (`/var/...`, and every `TMPDIR` path) would fail every
    // `strip_prefix` and the watch would silently never fire — filtered out
    // rather than erroring, which is the worst shape a bug like this can take.
    // `watch()` below still gets the caller's path; only matching is canonical.
    let root = repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf());
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else {
            return;
        };
        if event.paths.iter().any(|p| is_interesting(&root, p)) {
            let _ = tx.send(());
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(repo_root, notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    std::thread::spawn(move || {
        let mut coalescer = Coalescer::default();
        let mut last_tick = Instant::now();
        loop {
            // Any ping marks the burst dirty; the timeout is what advances the
            // clock, so a burst still settles once the writes stop.
            if rx.recv_timeout(TICK).is_ok() {
                coalescer.touch();
            }
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }
            let now = Instant::now();
            let elapsed = now.duration_since(last_tick);
            last_tick = now;
            if coalescer.tick(elapsed) {
                on_change();
            }
        }
    });

    Ok(TreeWatch {
        _watcher: watcher,
        stop,
    })
}

/// One repo root's watch and the sessions holding it open.
struct Entry {
    _watch: TreeWatch,
    refs: HashSet<SessionId>,
}

/// Every live [Working-tree watch], keyed by repo root and refcounted by
/// session, so N sessions sharing one checkout cost one recursive watch rather
/// than N — and the watch goes away exactly when the last of them does.
#[derive(Default)]
pub struct TreeWatchRegistry {
    by_root: HashMap<PathBuf, Entry>,
    /// Which root each session holds, so [`Self::release`] can find it without
    /// the caller having to remember (and without scanning every entry).
    root_by_session: HashMap<SessionId, PathBuf>,
}

impl TreeWatchRegistry {
    /// Whether `root` already has a live watch — the caller's cue to skip the
    /// (relatively expensive) `spawn_tree_watch` and just register a reference.
    #[must_use]
    pub fn has(&self, root: &Path) -> bool {
        self.by_root.contains_key(root)
    }

    /// Register `session` as holding a watch on `root`, taking ownership of a
    /// freshly spawned `watch` when this is the first reference.
    ///
    /// A session that was watching a *different* root (its cwd changed) is
    /// released from the old one first, so a re-registration can never leak a
    /// watch nobody will ever drop.
    pub fn retain(&mut self, session: SessionId, root: PathBuf, watch: Option<TreeWatch>) {
        if let Some(previous) = self.root_by_session.get(&session) {
            if previous != &root {
                let previous = previous.clone();
                self.release_from(&session, &previous);
            }
        }
        if let Some(entry) = self.by_root.get_mut(&root) {
            entry.refs.insert(session.clone());
        } else {
            let Some(watch) = watch else {
                // No live watch and none supplied — nothing to hold a
                // reference to. Deliberately not an error: the caller only
                // omits `watch` when `has()` said one existed, and a race
                // that removed it meanwhile just means no watch this time.
                return;
            };
            let mut refs = HashSet::new();
            refs.insert(session.clone());
            self.by_root.insert(
                root.clone(),
                Entry {
                    _watch: watch,
                    refs,
                },
            );
        }
        self.root_by_session.insert(session, root);
    }

    /// Drop `session`'s reference, stopping the watch if it was the last one.
    pub fn release(&mut self, session: &SessionId) {
        let Some(root) = self.root_by_session.remove(session) else {
            return;
        };
        self.release_from(session, &root);
    }

    /// The half of [`Self::release`] that doesn't touch `root_by_session` — so
    /// [`Self::retain`] can move a session between roots without its own entry
    /// being removed a moment before it is rewritten.
    fn release_from(&mut self, session: &SessionId, root: &Path) {
        let Some(entry) = self.by_root.get_mut(root) else {
            return;
        };
        entry.refs.remove(session);
        if entry.refs.is_empty() {
            // Dropping the Entry drops its TreeWatch, which stops the thread
            // and ends the filesystem subscription.
            self.by_root.remove(root);
        }
    }

    /// How many distinct repo roots are being watched. Test/diagnostic seam.
    #[must_use]
    pub fn watched_roots(&self) -> usize {
        self.by_root.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::sync::Mutex;

    fn sid(s: &str) -> SessionId {
        SessionId(s.to_string())
    }

    /// A registry entry needs a real `TreeWatch`; spawning one on a temp dir is
    /// the cheapest way to get a genuine value (the registry's refcounting, not
    /// the watch's behavior, is what these tests cover).
    fn dummy_watch(dir: &Path) -> TreeWatch {
        spawn_tree_watch(dir, || {}).expect("watch spawns on a real directory")
    }

    #[test]
    fn the_first_reference_installs_the_watch_and_the_last_one_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let mut reg = TreeWatchRegistry::default();

        assert!(!reg.has(&root));
        reg.retain(sid("a"), root.clone(), Some(dummy_watch(&root)));
        assert_eq!(reg.watched_roots(), 1);

        reg.release(&sid("a"));
        assert_eq!(reg.watched_roots(), 0);
        assert!(!reg.has(&root));
    }

    #[test]
    fn sessions_sharing_a_repo_share_one_watch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let mut reg = TreeWatchRegistry::default();

        reg.retain(sid("a"), root.clone(), Some(dummy_watch(&root)));
        // The second session finds a live watch and supplies none.
        assert!(reg.has(&root));
        reg.retain(sid("b"), root.clone(), None);
        assert_eq!(reg.watched_roots(), 1);

        // One leaving must not stop the other's liveness.
        reg.release(&sid("a"));
        assert_eq!(reg.watched_roots(), 1, "b still holds the watch open");
        reg.release(&sid("b"));
        assert_eq!(reg.watched_roots(), 0);
    }

    #[test]
    fn a_session_moving_to_another_repo_does_not_leak_its_old_watch() {
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        let mut reg = TreeWatchRegistry::default();

        reg.retain(
            sid("a"),
            old.path().to_path_buf(),
            Some(dummy_watch(old.path())),
        );
        reg.retain(
            sid("a"),
            new.path().to_path_buf(),
            Some(dummy_watch(new.path())),
        );

        assert_eq!(reg.watched_roots(), 1, "the old root's watch was dropped");
        assert!(reg.has(new.path()));
        assert!(!reg.has(old.path()));
    }

    #[test]
    fn re_retaining_the_same_root_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let mut reg = TreeWatchRegistry::default();

        reg.retain(sid("a"), root.clone(), Some(dummy_watch(&root)));
        reg.retain(sid("a"), root.clone(), None);
        assert_eq!(reg.watched_roots(), 1);
        // One release is still enough — the second retain added no extra ref.
        reg.release(&sid("a"));
        assert_eq!(reg.watched_roots(), 0);
    }

    #[test]
    fn releasing_an_unknown_session_is_a_no_op() {
        let mut reg = TreeWatchRegistry::default();
        reg.release(&sid("never-registered"));
        assert_eq!(reg.watched_roots(), 0);
    }

    #[test]
    fn a_write_in_the_tree_fires_exactly_one_coalesced_change() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = channel::<()>();
        let tx = Mutex::new(tx);
        let _watch = spawn_tree_watch(dir.path(), move || {
            let _ = tx.lock().unwrap().send(());
        })
        .expect("watch spawns");

        // A burst of writes, well inside the debounce window.
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "x").unwrap();
        }

        rx.recv_timeout(Duration::from_secs(5))
            .expect("a write in the tree fires a change");
        // The burst coalesced: nothing more arrives once it has settled.
        assert!(
            rx.recv_timeout(Duration::from_millis(600)).is_err(),
            "the burst should have coalesced into a single change"
        );
    }

    #[test]
    fn a_write_under_an_ignored_directory_never_fires() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        let (tx, rx) = channel::<()>();
        let tx = Mutex::new(tx);
        let _watch = spawn_tree_watch(dir.path(), move || {
            let _ = tx.lock().unwrap().send(());
        })
        .expect("watch spawns");

        for i in 0..5 {
            std::fs::write(
                dir.path().join(format!("node_modules/pkg/{i}.js")),
                "module.exports={}",
            )
            .unwrap();
        }

        assert!(
            rx.recv_timeout(Duration::from_millis(800)).is_err(),
            "dependency-tree writes must not wake the changes view"
        );

        // Prove the silence above was the filter and not a dead watch — the
        // exact way this test could pass while the whole watch was broken.
        std::fs::write(dir.path().join("real.ts"), "export {}").unwrap();
        rx.recv_timeout(Duration::from_secs(5))
            .expect("a real source write still fires");
    }
}
