//! [Tree stop] planning — the pure half.
//!
//! A [PTY daemon] that signals only its shell leaks everything else: a job in
//! its own process group, a server that ignores SIGHUP, an MCP server `claude`
//! spawned. Once their parent dies they are reparented to launchd and nothing
//! can trace them back to the session. So a stop must decide *who* to signal
//! before it signals anyone, and re-decide after the grace period — that
//! decision is this module. The IO (the sweep, `getsid`, the signals, the
//! waiting) lives in `kriyon-ptyd`.

use std::collections::HashSet;

use crate::proc::ProcessTree;

/// One process a [Tree stop] must end: a pid plus the command line it had when
/// snapshotted. The command line is the identity check — a later sweep showing
/// the same pid with a different command line is a reused pid, not our process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StopTarget {
    pub pid: i32,
    pub cmd: String,
}

/// The [Signal gate]: whether Kriyon may send `pid` a signal at all.
///
/// `kill(0, …)` signals our own process group and `kill(-1, …)` every process
/// the user owns; pid 1 is launchd. A stale or garbled pid reaching `kill` is
/// how a terminal ends up force-killing unrelated apps, so every signal passes
/// here first. `protected` is the caller's own pid, its ancestors, and the app.
#[must_use]
pub fn may_signal(pid: i32, protected: &[i32]) -> bool {
    pid > 1 && !protected.contains(&pid)
}

/// The daemon's shell, but only while the sweep proves the pid is still that
/// shell: present and still the daemon's own child. `None` once the shell has
/// died and been reaped — and, crucially, `None` if its pid has since been
/// *reused*: a process that merely holds the old number is not ours, and rooting
/// a stop at it would end that process and everything beneath it.
#[must_use]
pub fn hosted_shell(tree: &ProcessTree, shell: i32, daemon: i32) -> Option<i32> {
    tree.row(shell)
        .is_some_and(|row| row.ppid == daemon)
        .then_some(shell)
}

/// Whether the kernel session `shell` led may still be read as ours. portable-pty
/// makes the shell a session leader, so its session id is its pid, and that
/// session outlives the shell for as long as any member does — which is what
/// finds a job already reparented to launchd. True while the shell is still our
/// child, or gone from the sweep entirely (its number is free, so nothing else
/// can be leading a session under it yet). False the moment anything else holds
/// that pid: its session is not ours to stop.
#[must_use]
pub fn session_is_ours(tree: &ProcessTree, shell: i32, daemon: i32) -> bool {
    tree.row(shell).is_none_or(|row| row.ppid == daemon)
}

/// Snapshot the [Stop target]s a daemon hosts.
///
/// Rooted at the shell, not the daemon: "everything this terminal hosts" is the
/// shell (pass [`hosted_shell`], so a reused pid is never a root) plus the union
/// of two views, each covering the other's blind spot:
/// - every transitive child of the shell — a child that called `setsid()` keeps
///   its parent, so it is still here;
/// - `same_session`, the pids the caller found in the shell's kernel session —
///   an orphan already reparented to launchd keeps its session, so it is here
///   even when the shell itself is long gone.
///
/// Only a process that left both — a true daemonising double-fork — escapes,
/// and it asked to. Anything failing the [Signal gate] is never a target.
#[must_use]
pub fn stop_targets(
    tree: &ProcessTree,
    shell: Option<i32>,
    same_session: &[i32],
    protected: &[i32],
) -> Vec<StopTarget> {
    let mut seen: HashSet<i32> = HashSet::new();
    shell
        .into_iter()
        .chain(shell.map_or_else(Vec::new, |shell| tree.descendants_of(shell)))
        .chain(same_session.iter().copied())
        .filter(|pid| may_signal(*pid, protected) && seen.insert(*pid))
        .filter_map(|pid| {
            tree.row(pid).map(|row| StopTarget {
                pid,
                cmd: row.cmd.clone(),
            })
        })
        .collect()
}

/// After the grace period: every pid a fresh sweep says still needs ending.
///
/// `snapshot` entries count only while the sweep shows the *same* process — same
/// pid, same command line — so a pid reused since the snapshot is never
/// signalled. Anything newly found under `shell` or in the session (forked
/// during the grace period) is added: a stop that enumerates once misses it.
#[must_use]
pub fn remaining(
    tree: &ProcessTree,
    shell: Option<i32>,
    same_session: &[i32],
    protected: &[i32],
    snapshot: &[StopTarget],
) -> Vec<i32> {
    let mut seen: HashSet<i32> = HashSet::new();
    let survivors = snapshot
        .iter()
        .filter(|target| {
            tree.row(target.pid)
                .is_some_and(|row| row.cmd == target.cmd)
        })
        .map(|target| target.pid);
    let newcomers = stop_targets(tree, shell, same_session, protected)
        .into_iter()
        .map(|target| target.pid);
    survivors
        .chain(newcomers)
        .filter(|pid| may_signal(*pid, protected) && seen.insert(*pid))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc::ProcRow;

    const DAEMON: i32 = 100;
    const SHELL: i32 = 200;

    fn proc(pid: i32, parent: i32, cmd: &str) -> ProcRow {
        ProcRow {
            pid,
            ppid: parent,
            tpgid: -1,
            cmd: cmd.into(),
        }
    }

    /// App (50) → daemon (100) → shell (200) → claude (300) → MCP server (400).
    fn session_table() -> Vec<ProcRow> {
        vec![
            proc(1, 0, "/sbin/launchd"),
            proc(50, 1, "Kriyon"),
            proc(DAEMON, 50, "kriyon-ptyd --socket /run/s.sock --id s"),
            proc(SHELL, DAEMON, "/bin/zsh -l"),
            proc(300, SHELL, "claude"),
            proc(400, 300, "node mcp-server.js"),
        ]
    }

    fn pids(targets: &[StopTarget]) -> Vec<i32> {
        let mut pids: Vec<i32> = targets.iter().map(|t| t.pid).collect();
        pids.sort_unstable();
        pids
    }

    #[test]
    fn the_gate_refuses_every_dangerous_pid() {
        let protected = [DAEMON, 50];
        for pid in [0, 1, -1, -300, i32::MIN] {
            assert!(
                !may_signal(pid, &protected),
                "{pid} must never be signalled"
            );
        }
        assert!(!may_signal(DAEMON, &protected), "never ourselves");
        assert!(!may_signal(50, &protected), "never the app");
        assert!(may_signal(300, &protected));
    }

    #[test]
    fn a_shell_pid_is_only_trusted_while_it_is_still_the_daemons_child() {
        let rows = session_table();
        let tree = ProcessTree::new(&rows);
        assert_eq!(hosted_shell(&tree, SHELL, DAEMON), Some(SHELL));
        // Gone from the sweep: dead and reaped. Nothing to root a walk at.
        assert_eq!(hosted_shell(&tree, 4242, DAEMON), None);
    }

    #[test]
    fn a_reused_shell_pid_is_never_the_root_of_a_stop() {
        // The shell died and the kernel handed its number to an unrelated
        // process. Rooting the walk there would stop that process *and
        // everything under it*.
        let rows = vec![
            proc(1, 0, "/sbin/launchd"),
            proc(DAEMON, 1, "kriyon-ptyd --socket /run/s.sock --id s"),
            proc(SHELL, 1, "/Applications/Safari.app/Contents/MacOS/Safari"),
            proc(900, SHELL, "Safari Web Content"),
        ];
        let tree = ProcessTree::new(&rows);
        assert_eq!(hosted_shell(&tree, SHELL, DAEMON), None);
        assert!(!session_is_ours(&tree, SHELL, DAEMON));
        let targets = stop_targets(&tree, hosted_shell(&tree, SHELL, DAEMON), &[], &[DAEMON]);
        assert!(targets.is_empty(), "Safari must be left alone: {targets:?}");
    }

    #[test]
    fn a_dead_shells_session_is_still_ours() {
        // Absent from the sweep means its pid is free, so nothing else can be
        // leading a session under that number yet — the orphans in it are ours.
        let rows = vec![proc(DAEMON, 1, "kriyon-ptyd --socket /run/s.sock --id s")];
        assert!(session_is_ours(&ProcessTree::new(&rows), SHELL, DAEMON));
        assert!(session_is_ours(
            &ProcessTree::new(&session_table()),
            SHELL,
            DAEMON
        ));
    }

    #[test]
    fn the_whole_tree_is_targeted_but_never_the_daemon_itself() {
        let rows = session_table();
        let targets = stop_targets(&ProcessTree::new(&rows), Some(SHELL), &[], &[DAEMON, 50, 1]);
        assert_eq!(pids(&targets), vec![SHELL, 300, 400]);
    }

    #[test]
    fn a_child_that_called_setsid_is_still_found_by_its_parent() {
        // `setsid()` moves a process out of the shell's session but not out from
        // under its parent — a leak other terminal tools have shipped. It is absent from
        // `same_session`; the descendant walk is what finds it.
        let mut rows = session_table();
        rows.push(proc(500, 300, "node dev-server.js"));
        let targets = stop_targets(
            &ProcessTree::new(&rows),
            Some(SHELL),
            &[SHELL, 300],
            &[DAEMON],
        );
        assert!(pids(&targets).contains(&500));
    }

    #[test]
    fn an_orphan_reparented_to_launchd_is_still_found_by_its_session() {
        // The shell died first; its background job now has ppid 1 and no path
        // back to the daemon — except that it never left the shell's session.
        let rows = vec![
            proc(1, 0, "/sbin/launchd"),
            proc(DAEMON, 1, "kriyon-ptyd --socket /run/s.sock --id s"),
            proc(600, 1, "sleep 3002"),
        ];
        let targets = stop_targets(&ProcessTree::new(&rows), None, &[600], &[DAEMON, 1]);
        assert_eq!(pids(&targets), vec![600]);
    }

    #[test]
    fn a_target_seen_both_ways_is_listed_once() {
        let rows = session_table();
        let targets = stop_targets(
            &ProcessTree::new(&rows),
            Some(SHELL),
            &[SHELL, 300, 400],
            &[DAEMON],
        );
        assert_eq!(pids(&targets), vec![SHELL, 300, 400]);
    }

    #[test]
    fn a_protected_or_vanished_pid_in_the_session_list_is_dropped() {
        let rows = session_table();
        // 50 is the app, 1 is launchd, 0 is "our group", 4242 is not in the sweep.
        let targets = stop_targets(
            &ProcessTree::new(&rows),
            Some(SHELL),
            &[50, 1, 0, 4242],
            &[DAEMON, 50, 1],
        );
        assert_eq!(pids(&targets), vec![SHELL, 300, 400]);
    }

    #[test]
    fn targets_carry_the_command_line_they_were_snapshotted_with() {
        let rows = session_table();
        let targets = stop_targets(&ProcessTree::new(&rows), Some(SHELL), &[], &[DAEMON]);
        let claude = targets.iter().find(|t| t.pid == 300).expect("claude");
        assert_eq!(claude.cmd, "claude");
    }

    #[test]
    fn nothing_remains_once_every_target_is_gone() {
        let before = session_table();
        let snapshot = stop_targets(&ProcessTree::new(&before), Some(SHELL), &[], &[DAEMON]);
        let after = vec![
            proc(1, 0, "/sbin/launchd"),
            proc(DAEMON, 1, "kriyon-ptyd --socket /run/s.sock --id s"),
        ];
        let left = remaining(
            &ProcessTree::new(&after),
            Some(SHELL),
            &[],
            &[DAEMON],
            &snapshot,
        );
        assert_eq!(left, [] as [i32; 0]);
    }

    #[test]
    fn a_survivor_reparented_to_launchd_still_remains() {
        // Its parent died during the grace period, so the descendant walk no
        // longer reaches it — only the snapshot remembers it was ours.
        let before = session_table();
        let snapshot = stop_targets(&ProcessTree::new(&before), Some(SHELL), &[], &[DAEMON]);
        let after = vec![
            proc(1, 0, "/sbin/launchd"),
            proc(DAEMON, 1, "kriyon-ptyd --socket /run/s.sock --id s"),
            proc(400, 1, "node mcp-server.js"),
        ];
        let left = remaining(
            &ProcessTree::new(&after),
            Some(SHELL),
            &[],
            &[DAEMON],
            &snapshot,
        );
        assert_eq!(left, vec![400]);
    }

    #[test]
    fn a_reused_pid_is_never_mistaken_for_the_target() {
        // pid 400 died and the kernel handed the number to an unrelated process.
        let before = session_table();
        let snapshot = stop_targets(&ProcessTree::new(&before), Some(SHELL), &[], &[DAEMON]);
        let after = vec![
            proc(1, 0, "/sbin/launchd"),
            proc(DAEMON, 1, "kriyon-ptyd --socket /run/s.sock --id s"),
            proc(400, 1, "/Applications/Safari.app/Contents/MacOS/Safari"),
        ];
        let left = remaining(
            &ProcessTree::new(&after),
            Some(SHELL),
            &[],
            &[DAEMON],
            &snapshot,
        );
        assert!(left.is_empty(), "a different process now owns pid 400");
    }

    #[test]
    fn a_process_forked_during_the_grace_period_is_added() {
        // A single enumeration misses anything forked after its snapshot, so it is never
        // signalled. The re-sweep is what catches it.
        let before = session_table();
        let snapshot = stop_targets(&ProcessTree::new(&before), Some(SHELL), &[], &[DAEMON]);
        let mut after = session_table();
        after.push(proc(700, 300, "bash -c cleanup.sh"));
        let mut left = remaining(
            &ProcessTree::new(&after),
            Some(SHELL),
            &[],
            &[DAEMON],
            &snapshot,
        );
        left.sort_unstable();
        assert_eq!(left, vec![SHELL, 300, 400, 700]);
    }
}
