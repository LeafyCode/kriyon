//! [Orphan daemon] reaping — the pure half.
//!
//! A [PTY daemon] outlives the app on purpose, which means one can also outlive
//! its reason to exist: a close whose `Shutdown` never arrived, a row deleted
//! while the daemon was unreachable, a session archived while still running.
//! Nothing ever reattaches to those, so they hold a `claude` tree forever.
//!
//! The rule that keeps the reaper safe is one-sided: it only ever acts on a
//! daemon **no row owns**. An *owned* daemon that merely fails a probe is never
//! touched — one terminal tool killed every shell after an update because a liveness
//! probe timed out. And when ownership itself cannot be established (the store
//! or the terminals blob is unreadable), nothing is reaped at all.

use std::collections::{HashMap, HashSet};
use std::hash::BuildHasher;

use crate::proc::{daemon_session_id, ProcessTree};

/// A [PTY daemon] in Kriyon's run dir that nothing owns.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct OrphanDaemon {
    pub session_id: String,
    pub pid: i32,
}

/// What to do about one [Orphan daemon] this pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReapStep {
    /// Seen once. A brand-new session's daemon exists a moment before anything
    /// owns it, so a single sighting proves nothing.
    Wait,
    /// Ask it to [Tree stop] itself.
    Shutdown,
    /// It was asked and is still here: end it and its tree from outside.
    Force,
}

/// Splits a [Terminal scope] key; a NUL byte can't occur in an id or a path.
const SCOPE_SEP: char = '\0';

/// A folder path without its trailing slashes, so `/repo/` and `/repo` match.
fn trim_folder(folder: &str) -> &str {
    let trimmed = folder.trim_end_matches('/');
    if trimmed.is_empty() {
        folder
    } else {
        trimmed
    }
}

/// The [Terminal scope] key of a folder in a project: the bare project id for
/// the project's main folder (or no folder), else the project id and the folder
/// joined by a NUL. The frontend's `terminalScope` builds the same key; change
/// both together.
#[must_use]
pub fn terminal_scope(project_id: &str, folder: &str, project_path: Option<&str>) -> String {
    let main = project_path.map(trim_folder);
    if folder.is_empty() || Some(trim_folder(folder)) == main {
        project_id.to_string()
    } else {
        format!("{project_id}{SCOPE_SEP}{}", trim_folder(folder))
    }
}

/// The project a [Terminal scope] key belongs to.
#[must_use]
pub fn scope_project_id(scope: &str) -> &str {
    scope.split(SCOPE_SEP).next().unwrap_or(scope)
}

/// One open (not archived) [Session], as far as terminal ownership cares.
#[derive(Clone, Copy, Debug)]
pub struct OpenSession<'a> {
    pub project_id: &'a str,
    /// The project's main folder; `None` when the project row is gone.
    pub project_path: Option<&'a str>,
    /// The folder the session works in: its worktree, else its cwd.
    pub folder: &'a str,
    pub parked: bool,
}

/// Which [Terminal scope]s still own their panes. A scope is dormant — its
/// terminals stopped, so a daemon still serving one is a leftover — when its
/// project is a [Parked project], or when it is a worktree scope no session on
/// the rail works in. The frontend's `dormantScopes` decides the same thing for
/// the terminal dock; change both together.
#[derive(Debug, Default)]
pub struct LiveTerminalScopes {
    parked_projects: HashSet<String>,
    rail_scopes: HashSet<String>,
}

impl LiveTerminalScopes {
    #[must_use]
    pub fn from_open_sessions<'a, I>(open_sessions: I) -> Self
    where
        I: IntoIterator<Item = OpenSession<'a>>,
    {
        let sessions: Vec<OpenSession<'a>> = open_sessions.into_iter().collect();
        let parked_projects =
            fully_parked_projects(sessions.iter().map(|s| (s.project_id, s.parked)));
        let rail_scopes = sessions
            .iter()
            .filter(|s| !s.parked)
            .map(|s| terminal_scope(s.project_id, s.folder, s.project_path))
            .collect();
        Self {
            parked_projects,
            rail_scopes,
        }
    }

    /// Whether the panes saved under `scope` are still owned.
    #[must_use]
    pub fn owns(&self, scope: &str) -> bool {
        let project_id = scope_project_id(scope);
        if self.parked_projects.contains(project_id) {
            return false;
        }
        scope == project_id || self.rail_scopes.contains(scope)
    }
}

/// The [Terminal pane] ids in the persisted `terminals` layout blob
/// (`{scope: {tabs: [{panes: [{id}]}]}}`, keyed by [Terminal scope]).
///
/// `Some(vec![])` when there is no blob — no panes were ever saved. `None` when
/// a blob is present but unreadable: the caller must then reap nothing, because
/// an unreadable blob says nothing about which daemons are owned. Entries of an
/// unexpected shape inside a readable blob are skipped, matching the frontend's
/// own tolerant `parseTerminals`.
///
/// Panes of a dormant scope (see [`LiveTerminalScopes`]) are left out: their
/// terminals were stopped, so a daemon still serving one is a leftover.
#[must_use]
pub fn terminal_pane_ids(blob: Option<&str>, live: &LiveTerminalScopes) -> Option<Vec<String>> {
    let Some(blob) = blob else {
        return Some(Vec::new());
    };
    let parsed: serde_json::Value = serde_json::from_str(blob).ok()?;
    let scopes = parsed.as_object()?;
    let ids = scopes
        .iter()
        .filter(|(scope, _)| live.owns(scope))
        .map(|(_, scope)| scope)
        .filter_map(|scope| scope.get("tabs")?.as_array())
        .flatten()
        .filter_map(|tab| tab.get("panes")?.as_array())
        .flatten()
        .filter_map(|pane| pane.get("id")?.as_str())
        .map(str::to_string)
        .collect();
    Some(ids)
}

/// The projects whose every open session is parked (and that have at least
/// one): a [Parked project]'s [Project terminal]s are stopped with it and stay
/// stopped until one of its sessions comes back, so their panes are not owned.
///
/// `open_sessions` is each non-archived session as `(project_id, parked)`.
/// The frontend's `fullyParkedProjectIds` decides the same thing for the
/// terminal dock; change both together.
#[must_use]
pub fn fully_parked_projects<'a, I>(open_sessions: I) -> HashSet<String>
where
    I: IntoIterator<Item = (&'a str, bool)>,
{
    let mut parked = HashSet::new();
    let mut live = HashSet::new();
    for (project_id, is_parked) in open_sessions {
        if is_parked {
            parked.insert(project_id.to_string());
        } else {
            live.insert(project_id);
        }
    }
    parked.retain(|project| !live.contains(project.as_str()));
    parked
}

/// Every daemon in the sweep whose socket is in `run_dir` and whose id is not
/// in `owned`. A daemon anywhere else — a `cargo test` daemon, another tool's —
/// is never claimed (see [`daemon_session_id`]).
#[must_use]
pub fn orphan_daemons<S: BuildHasher>(
    tree: &ProcessTree,
    run_dir: &str,
    owned: &HashSet<String, S>,
) -> Vec<OrphanDaemon> {
    tree.daemons()
        .filter_map(|row| {
            let session_id = daemon_session_id(row, run_dir)?;
            (!owned.contains(&session_id)).then_some(OrphanDaemon {
                session_id,
                pid: row.pid,
            })
        })
        .collect()
}

/// How many *consecutive* passes have seen each [Orphan daemon]. Keyed by id
/// and pid together, so a fresh daemon spawned for a reused id starts over.
#[derive(Debug, Default)]
pub struct OrphanLedger {
    sightings: HashMap<OrphanDaemon, u32>,
}

/// Sightings before a daemon is asked to stop.
const SIGHTINGS_TO_SHUTDOWN: u32 = 2;

impl OrphanLedger {
    /// Fold one pass and decide each orphan's step. An orphan absent from this
    /// pass is forgotten, so only consecutive sightings ever count.
    ///
    /// `at_launch` skips the waiting pass: before the UI exists nothing can have
    /// been created this run, so an unowned daemon is unambiguous.
    pub fn observe(
        &mut self,
        orphans: &[OrphanDaemon],
        at_launch: bool,
    ) -> Vec<(OrphanDaemon, ReapStep)> {
        let previous = std::mem::take(&mut self.sightings);
        orphans
            .iter()
            .map(|orphan| {
                let first = if at_launch { SIGHTINGS_TO_SHUTDOWN } else { 1 };
                let seen = previous.get(orphan).map_or(first, |count| count + 1);
                self.sightings.insert(orphan.clone(), seen);
                let step = match seen.cmp(&SIGHTINGS_TO_SHUTDOWN) {
                    std::cmp::Ordering::Less => ReapStep::Wait,
                    std::cmp::Ordering::Equal => ReapStep::Shutdown,
                    std::cmp::Ordering::Greater => ReapStep::Force,
                };
                (orphan.clone(), step)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc::ProcRow;

    const RUN_DIR: &str = "/Users/x/.claude/kriyon/run";

    fn daemon(pid: i32, socket_dir: &str, id: &str) -> ProcRow {
        ProcRow {
            pid,
            ppid: 1,
            tpgid: -1,
            cmd: format!(
                "/Applications/Kriyon.app/Contents/MacOS/kriyon-ptyd --socket \
                 {socket_dir}/{id}.sock --id {id} --cwd / --shell /bin/zsh"
            ),
        }
    }

    fn owned(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_string()).collect()
    }

    fn orphan(id: &str, pid: i32) -> OrphanDaemon {
        OrphanDaemon {
            session_id: id.into(),
            pid,
        }
    }

    #[test]
    fn pane_ids_are_read_out_of_the_terminals_blob() {
        let blob = r#"{
            "proj-1": {"activeTabId": "t1", "tabs": [
                {"id": "t1", "panes": [{"id": "pane-a"}, {"id": "pane-b"}]},
                {"id": "t2", "panes": [{"id": "pane-c"}]}
            ]},
            "proj-2": {"activeTabId": "t3", "tabs": []}
        }"#;
        let mut ids =
            terminal_pane_ids(Some(blob), &LiveTerminalScopes::default()).expect("readable blob");
        ids.sort();
        assert_eq!(ids, vec!["pane-a", "pane-b", "pane-c"]);
    }

    #[test]
    fn a_project_is_fully_parked_only_with_no_open_session_left() {
        let parked = fully_parked_projects([
            ("all-parked", true),
            ("all-parked", true),
            ("mixed", true),
            ("mixed", false),
            ("live", false),
        ]);
        assert_eq!(parked, HashSet::from(["all-parked".to_string()]));
        assert!(fully_parked_projects([]).is_empty());
    }

    #[test]
    fn a_parked_projects_panes_are_left_out() {
        let blob = r#"{
            "proj-1": {"tabs": [{"panes": [{"id": "pane-a"}]}]},
            "parked": {"tabs": [{"panes": [{"id": "pane-z"}]}]}
        }"#;
        let live = LiveTerminalScopes::from_open_sessions([
            open("proj-1", "/one", "/one", false),
            open("parked", "/two", "/two", true),
        ]);
        assert_eq!(
            terminal_pane_ids(Some(blob), &live),
            Some(vec!["pane-a".to_string()])
        );
    }

    fn open<'a>(
        project_id: &'a str,
        project_path: &'a str,
        folder: &'a str,
        parked: bool,
    ) -> OpenSession<'a> {
        OpenSession {
            project_id,
            project_path: Some(project_path),
            folder,
            parked,
        }
    }

    #[test]
    fn a_scope_key_matches_the_frontend() {
        assert_eq!(terminal_scope("p", "/repo", Some("/repo")), "p");
        assert_eq!(terminal_scope("p", "/repo/", Some("/repo")), "p");
        assert_eq!(terminal_scope("p", "", Some("/repo")), "p");
        assert_eq!(
            terminal_scope("p", "/wt/feat", Some("/repo")),
            "p\0/wt/feat"
        );
        assert_eq!(scope_project_id("p\0/wt/feat"), "p");
        assert_eq!(scope_project_id("p"), "p");
    }

    #[test]
    fn a_parked_projects_worktree_panes_are_left_out() {
        let blob = "{\"p\": {\"tabs\": [{\"panes\": [{\"id\": \"main\"}]}]}, \
                    \"p\\u0000/wt/feat\": {\"tabs\": [{\"panes\": [{\"id\": \"wt\"}]}]}}";
        let live = LiveTerminalScopes::from_open_sessions([open("p", "/repo", "/wt/feat", true)]);
        assert_eq!(terminal_pane_ids(Some(blob), &live), Some(Vec::new()));
    }

    #[test]
    fn a_worktree_no_rail_session_works_in_is_left_out() {
        let blob = "{\"p\": {\"tabs\": [{\"panes\": [{\"id\": \"main\"}]}]}, \
                    \"p\\u0000/wt/feat\": {\"tabs\": [{\"panes\": [{\"id\": \"feat\"}]}]}, \
                    \"p\\u0000/wt/gone\": {\"tabs\": [{\"panes\": [{\"id\": \"gone\"}]}]}}";
        let live = LiveTerminalScopes::from_open_sessions([
            open("p", "/repo", "/repo", false),
            open("p", "/repo", "/wt/feat", false),
        ]);
        let mut ids = terminal_pane_ids(Some(blob), &live).expect("readable blob");
        ids.sort();
        assert_eq!(ids, vec!["feat", "main"]);
    }

    #[test]
    fn no_blob_means_no_panes_but_an_unreadable_blob_means_unknown() {
        let live = LiveTerminalScopes::default();
        assert_eq!(terminal_pane_ids(None, &live), Some(Vec::new()));
        // Fail closed: `None` tells the caller ownership is unknowable.
        assert_eq!(terminal_pane_ids(Some("{not json"), &live), None);
        assert_eq!(terminal_pane_ids(Some("[1, 2]"), &live), None);
    }

    #[test]
    fn oddly_shaped_entries_inside_a_readable_blob_are_skipped() {
        let blob = r#"{"layout": {"sidebar": 240}, "proj": {"tabs": [{"panes": [{"id": "p"}, {"noid": 1}]}, 7]}}"#;
        assert_eq!(
            terminal_pane_ids(Some(blob), &LiveTerminalScopes::default()),
            Some(vec!["p".to_string()])
        );
    }

    // POSIX run-dir fixture; the Windows join is covered in `proc`.
    #[cfg(unix)]
    #[test]
    fn a_daemon_nothing_owns_is_an_orphan_and_an_owned_one_is_not() {
        let rows = vec![daemon(100, RUN_DIR, "live"), daemon(200, RUN_DIR, "gone")];
        let orphans = orphan_daemons(&ProcessTree::new(&rows), RUN_DIR, &owned(&["live"]));
        assert_eq!(orphans, vec![orphan("gone", 200)]);
    }

    #[test]
    fn a_daemon_outside_the_run_dir_is_never_an_orphan() {
        // A `cargo test` daemon owns nothing in the store, but it is not ours.
        let rows = vec![daemon(100, "/var/folders/tmp", "test")];
        let orphans = orphan_daemons(&ProcessTree::new(&rows), RUN_DIR, &owned(&[]));
        assert_eq!(orphans, [] as [crate::orphan::OrphanDaemon; 0]);
    }

    #[test]
    fn on_the_ticker_an_orphan_waits_one_pass_then_is_asked_then_forced() {
        let mut ledger = OrphanLedger::default();
        let seen = [orphan("gone", 200)];
        let steps = |ledger: &mut OrphanLedger| -> Vec<ReapStep> {
            ledger
                .observe(&seen, false)
                .into_iter()
                .map(|(_, step)| step)
                .collect()
        };
        assert_eq!(steps(&mut ledger), vec![ReapStep::Wait]);
        assert_eq!(steps(&mut ledger), vec![ReapStep::Shutdown]);
        assert_eq!(steps(&mut ledger), vec![ReapStep::Force]);
        assert_eq!(steps(&mut ledger), vec![ReapStep::Force]);
    }

    #[test]
    fn at_launch_an_orphan_is_asked_immediately() {
        let mut ledger = OrphanLedger::default();
        let steps = ledger.observe(&[orphan("gone", 200)], true);
        assert_eq!(steps, vec![(orphan("gone", 200), ReapStep::Shutdown)]);
    }

    #[test]
    fn only_consecutive_sightings_count() {
        // A brand-new session's daemon is unowned for a moment. Seen once, then
        // owned (absent from the orphan list), then somehow unowned again: that
        // is a first sighting, not a second.
        let mut ledger = OrphanLedger::default();
        let seen = [orphan("new", 300)];
        assert_eq!(ledger.observe(&seen, false)[0].1, ReapStep::Wait);
        assert_eq!(
            ledger.observe(&[], false),
            [] as [(crate::orphan::OrphanDaemon, crate::orphan::ReapStep); 0]
        );
        assert_eq!(ledger.observe(&seen, false)[0].1, ReapStep::Wait);
    }

    #[test]
    fn a_new_daemon_for_the_same_id_starts_its_own_count() {
        let mut ledger = OrphanLedger::default();
        assert_eq!(
            ledger.observe(&[orphan("s", 300)], false)[0].1,
            ReapStep::Wait
        );
        assert_eq!(
            ledger.observe(&[orphan("s", 301)], false)[0].1,
            ReapStep::Wait
        );
    }
}
