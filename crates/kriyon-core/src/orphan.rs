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

/// The [Terminal pane] ids in the persisted `terminals` layout blob
/// (`{projectId: {tabs: [{panes: [{id}]}]}}`).
///
/// `Some(vec![])` when there is no blob — no panes were ever saved. `None` when
/// a blob is present but unreadable: the caller must then reap nothing, because
/// an unreadable blob says nothing about which daemons are owned. Entries of an
/// unexpected shape inside a readable blob are skipped, matching the frontend's
/// own tolerant `parseTerminals`.
///
/// Panes of a [Parked project] (ids in `parked_projects`) are left out: parking stops
/// them, so a daemon still serving one is a leftover.
#[must_use]
pub fn terminal_pane_ids<S: BuildHasher>(
    blob: Option<&str>,
    parked_projects: &HashSet<String, S>,
) -> Option<Vec<String>> {
    let Some(blob) = blob else {
        return Some(Vec::new());
    };
    let parsed: serde_json::Value = serde_json::from_str(blob).ok()?;
    let projects = parsed.as_object()?;
    let ids = projects
        .iter()
        .filter(|(project_id, _)| !parked_projects.contains(*project_id))
        .map(|(_, project)| project)
        .filter_map(|project| project.get("tabs")?.as_array())
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
        let mut ids = terminal_pane_ids(Some(blob), &HashSet::new()).expect("readable blob");
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
        let parked = HashSet::from(["parked".to_string()]);
        assert_eq!(
            terminal_pane_ids(Some(blob), &parked),
            Some(vec!["pane-a".to_string()])
        );
    }

    #[test]
    fn no_blob_means_no_panes_but_an_unreadable_blob_means_unknown() {
        assert_eq!(terminal_pane_ids(None, &HashSet::new()), Some(Vec::new()));
        // Fail closed: `None` tells the caller ownership is unknowable.
        assert_eq!(terminal_pane_ids(Some("{not json"), &HashSet::new()), None);
        assert_eq!(terminal_pane_ids(Some("[1, 2]"), &HashSet::new()), None);
    }

    #[test]
    fn oddly_shaped_entries_inside_a_readable_blob_are_skipped() {
        let blob = r#"{"layout": {"sidebar": 240}, "proj": {"tabs": [{"panes": [{"id": "p"}, {"noid": 1}]}, 7]}}"#;
        assert_eq!(
            terminal_pane_ids(Some(blob), &HashSet::new()),
            Some(vec!["p".to_string()])
        );
    }

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
