//! [Tree stop] — the IO half: sweep the process table, signal, wait, force.
//!
//! The decisions (who is a [Stop target], who still remains, what may be
//! signalled at all) are pure and live in [`kriyon_core::tree_stop`]. This
//! module only gathers their inputs and carries out their answers, and it
//! always terminates: every wait is bounded, and a sweep that cannot be trusted
//! degrades to signalling the shell alone rather than hanging the daemon.

use std::time::{Duration, Instant};

use kriyon_core::proc::{parse_ps_rows, ProcRow, ProcessTree};
use kriyon_core::tree_stop::{
    hosted_shell, may_signal, remaining, session_is_ours, stop_targets, StopTarget,
};

/// How long the polite signals get before anything still alive is forced.
const GRACE: Duration = Duration::from_secs(2);
/// How long SIGKILL is re-sent to stragglers before the stop gives up.
const FORCE_WINDOW: Duration = Duration::from_millis(500);
const POLL: Duration = Duration::from_millis(100);

/// The OS half of a [Tree stop], behind one interface.
///
/// Everything above it — snapshot before signalling, hang up the shell and
/// terminate the rest, wait a bounded grace, re-survey, force only from a sweep
/// taken this instant — is a state machine over survey results, and it holds
/// every ADR 0022 invariant that matters. With `ps`, `getsid` and `kill` called
/// directly it could not be tested at all. Two adapters justify the seam: the
/// real one in the daemon, an in-memory one built from synthetic [`ProcRow`]s
/// in tests.
pub trait Surveyor {
    /// The pid of the process running the stop — never a target, and neither
    /// are its ancestors.
    fn own_pid(&self) -> i32;

    /// One process-table sweep, or `None` when it cannot be trusted.
    fn sweep(&mut self) -> Option<Vec<ProcRow>>;

    /// Every pid in the kernel session `shell` leads. Called only once
    /// [`session_is_ours`] has said the pid still means our shell.
    fn session_members(&mut self, rows: &[ProcRow], shell: i32) -> Vec<i32>;

    /// Send `signal` to `pid`. The caller has already passed the [Signal gate].
    fn signal(&mut self, pid: i32, signal: libc::c_int);

    /// Collect the daemon's own dead child between sweeps — an unreaped zombie
    /// still has a row and would read as a survivor for the whole grace period.
    fn reap(&mut self);

    /// Wait before the next sweep.
    fn wait(&mut self, how_long: Duration);

    /// The current time. Injected with [`Self::wait`] so a fixture can run the
    /// grace and force windows without spending them.
    fn now(&mut self) -> Instant;
}

/// The real [`Surveyor`]: `ps`, `getsid(2)`, `kill(2)` and the wall clock.
pub struct OsSurveyor<R: FnMut()> {
    own_pid: i32,
    reap: R,
}

impl<R: FnMut()> OsSurveyor<R> {
    pub fn new(reap: R) -> Self {
        Self {
            own_pid: i32::try_from(std::process::id()).unwrap_or(0),
            reap,
        }
    }
}

impl<R: FnMut()> Surveyor for OsSurveyor<R> {
    fn own_pid(&self) -> i32 {
        self.own_pid
    }

    /// `-ww` keeps long command lines whole: the command line is a [Stop
    /// target]'s identity.
    fn sweep(&mut self) -> Option<Vec<ProcRow>> {
        let output = std::process::Command::new("ps")
            .args(["-axww", "-o", "pid=,ppid=,tpgid=,args="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let rows = parse_ps_rows(&String::from_utf8_lossy(&output.stdout));
        (!rows.is_empty()).then_some(rows)
    }

    /// The membership `ps` cannot report on macOS (its `sess` column is a
    /// pointer, not an id), so it is read per pid.
    fn session_members(&mut self, rows: &[ProcRow], shell: i32) -> Vec<i32> {
        rows.iter()
            .map(|row| row.pid)
            // SAFETY: plain getsid(2) on a positive pid; no memory involved. A
            // pid that vanished since the sweep yields -1, which never equals
            // `shell`.
            .filter(|pid| *pid > 1 && unsafe { libc::getsid(*pid) } == shell)
            .collect()
    }

    fn signal(&mut self, pid: i32, signal: libc::c_int) {
        // SAFETY: plain kill(2) on a pid the gate has proven is > 1 and not
        // ours; no memory involved.
        unsafe {
            libc::kill(pid, signal);
        }
    }

    fn reap(&mut self) {
        (self.reap)();
    }

    fn wait(&mut self, how_long: Duration) {
        std::thread::sleep(how_long);
    }

    fn now(&mut self) -> Instant {
        Instant::now()
    }
}

/// Send `signal` to `pid` if the [Signal gate] allows it. Best-effort: a pid
/// that already exited is success, not an error.
fn send(os: &mut impl Surveyor, pid: i32, signal: libc::c_int, protected: &[i32]) {
    if may_signal(pid, protected) {
        os.signal(pid, signal);
    }
}

/// What one fresh sweep says about the stop so far.
struct Survey {
    protected: Vec<i32>,
    snapshot: Vec<StopTarget>,
    left: Vec<i32>,
}

/// Sweep and work out the current targets. `earlier` is the snapshot taken
/// before any signal went out; `None` on the first survey. Returns `None` when
/// the sweep cannot be trusted.
fn survey(os: &mut impl Surveyor, shell: i32, earlier: Option<&[StopTarget]>) -> Option<Survey> {
    let own_pid = os.own_pid();
    let rows = os.sweep()?;
    let tree = ProcessTree::new(&rows);
    let mut protected = vec![own_pid];
    protected.extend(tree.ancestors_of(own_pid));
    // The kernel session is ours to stop only while the shell's pid still means
    // our shell; once anything else holds that number, its session is not ours.
    let session = if session_is_ours(&tree, shell, own_pid) {
        os.session_members(&rows, shell)
    } else {
        Vec::new()
    };
    // `None` once the shell is gone — or once its pid names something else.
    let root = hosted_shell(&tree, shell, own_pid);
    let snapshot = stop_targets(&tree, root, &session, &protected);
    let left = match earlier {
        Some(earlier) => remaining(&tree, root, &session, &protected, earlier),
        None => snapshot.iter().map(|target| target.pid).collect(),
    };
    Some(Survey {
        protected,
        snapshot,
        left,
    })
}

/// End everything `shell` hosts: polite signals, a bounded grace, then SIGKILL
/// for whatever is still the same process. `reap` is called between sweeps to
/// collect the daemon's own dead child — an unreaped zombie still has a row in
/// the process table and would otherwise read as a survivor for the whole grace
/// period.
///
/// Returns `false` if the process table could not be read at all, so the caller
/// can fall back to the one target it knows first-hand.
#[must_use]
pub fn run(shell: i32, reap: impl FnMut()) -> bool {
    run_with(&mut OsSurveyor::new(reap), shell)
}

/// [`run`], against any [`Surveyor`]. The whole choreography lives here.
#[must_use]
pub fn run_with(os: &mut impl Surveyor, shell: i32) -> bool {
    let Some(first) = survey(os, shell, None) else {
        return false;
    };

    // Interactive shells ignore SIGTERM, so the shell gets the hangup a closing
    // terminal would send. Everything else gets SIGTERM — the signal servers and
    // `claude` treat as "shut down cleanly"; SIGHUP means "reload" to some.
    for target in &first.snapshot {
        let polite = if target.pid == shell {
            libc::SIGHUP
        } else {
            libc::SIGTERM
        };
        send(os, target.pid, polite, &first.protected);
    }

    // A sweep that fails mid-wait changes nothing: keep waiting on what the last
    // good one said.
    let mut pending = !first.left.is_empty();
    let grace_ends = os.now() + GRACE;
    while pending && os.now() < grace_ends {
        os.wait(POLL);
        os.reap();
        if let Some(next) = survey(os, shell, Some(&first.snapshot)) {
            pending = !next.left.is_empty();
        }
    }

    // Forced only from a survey taken this instant — never from an older one. A
    // pid in a seconds-old list may no longer be the process it named, and
    // SIGKILL gives no second chance. Re-surveyed every round too, so a process
    // forked during the grace period is forced along with the rest. If the
    // table cannot be read, nothing is forced: a rare leak beats a wrong kill.
    if !pending {
        return true;
    }
    let force_ends = os.now() + FORCE_WINDOW;
    while let Some(now) = survey(os, shell, Some(&first.snapshot)) {
        if now.left.is_empty() {
            break;
        }
        for pid in now.left.clone() {
            send(os, pid, libc::SIGKILL, &now.protected);
        }
        if os.now() >= force_ends {
            break;
        }
        os.wait(POLL);
        os.reap();
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const DAEMON: i32 = 100;
    const SHELL: i32 = 200;

    /// One row, written the way `ps` would print it.
    fn row(pid: i32, parent: i32, cmd: &str) -> ProcRow {
        ProcRow {
            pid,
            ppid: parent,
            tpgid: -1,
            cmd: cmd.into(),
        }
    }

    /// The daemon, its shell, and whatever else the caller puts under them.
    fn table(extra: Vec<ProcRow>) -> Vec<ProcRow> {
        let mut rows = vec![
            row(DAEMON, 1, "kriyon-ptyd --id sess"),
            row(SHELL, DAEMON, "/bin/zsh -l"),
        ];
        rows.extend(extra);
        rows
    }

    /// An in-memory process table: each sweep returns the next scripted table
    /// (the last one repeats), every signal is recorded, and the clock only
    /// moves when the stop asks to wait.
    struct Fake {
        sweeps: Vec<Option<Vec<ProcRow>>>,
        taken: usize,
        /// Pids in the shell's kernel session, per sweep index; falls back to
        /// "every row under the shell".
        session: Option<Vec<i32>>,
        sent: Vec<(i32, libc::c_int)>,
        clock: Instant,
        reaps: usize,
    }

    impl Fake {
        fn new(sweeps: Vec<Option<Vec<ProcRow>>>) -> Self {
            Self {
                sweeps,
                taken: 0,
                session: None,
                sent: Vec::new(),
                clock: Instant::now(),
                reaps: 0,
            }
        }

        fn signals_to(&self, pid: i32) -> Vec<libc::c_int> {
            self.sent
                .iter()
                .filter(|(to, _)| *to == pid)
                .map(|(_, sig)| *sig)
                .collect()
        }

        fn forced(&self) -> Vec<i32> {
            self.sent
                .iter()
                .filter(|(_, sig)| *sig == libc::SIGKILL)
                .map(|(pid, _)| *pid)
                .collect()
        }
    }

    impl Surveyor for Fake {
        fn own_pid(&self) -> i32 {
            DAEMON
        }

        fn sweep(&mut self) -> Option<Vec<ProcRow>> {
            let at = self.taken.min(self.sweeps.len().saturating_sub(1));
            self.taken += 1;
            self.sweeps.get(at).cloned().flatten()
        }

        fn session_members(&mut self, rows: &[ProcRow], shell: i32) -> Vec<i32> {
            self.session.clone().unwrap_or_else(|| {
                // Stand-in for getsid: the shell leads, and everything the
                // sweep still shows beneath it is in its session.
                let mut parents: HashMap<i32, i32> = HashMap::new();
                for r in rows {
                    parents.insert(r.pid, r.ppid);
                }
                rows.iter()
                    .map(|r| r.pid)
                    .filter(|pid| {
                        let mut at = *pid;
                        for _ in 0..8 {
                            if at == shell {
                                return true;
                            }
                            match parents.get(&at) {
                                Some(up) => at = *up,
                                None => return false,
                            }
                        }
                        false
                    })
                    .collect()
            })
        }

        fn signal(&mut self, pid: i32, signal: libc::c_int) {
            self.sent.push((pid, signal));
        }

        fn reap(&mut self) {
            self.reaps += 1;
        }

        fn wait(&mut self, how_long: Duration) {
            self.clock += how_long;
        }

        fn now(&mut self) -> Instant {
            self.clock
        }
    }

    #[test]
    fn the_shell_is_hung_up_and_everything_under_it_terminated() {
        // An interactive shell ignores SIGTERM, so it gets the hangup a closing
        // terminal would send; a server told to SIGHUP may read it as "reload".
        let mut os = Fake::new(vec![
            Some(table(vec![row(300, SHELL, "claude")])),
            // Both go during the grace, so nothing is forced on top.
            Some(vec![row(DAEMON, 1, "kriyon-ptyd --id sess")]),
        ]);

        assert!(run_with(&mut os, SHELL));

        assert_eq!(os.signals_to(SHELL), vec![libc::SIGHUP]);
        assert_eq!(os.signals_to(300), vec![libc::SIGTERM]);
    }

    #[test]
    fn the_daemon_never_signals_itself() {
        let mut os = Fake::new(vec![
            Some(table(vec![])),
            Some(vec![row(DAEMON, 1, "kriyon-ptyd --id sess")]),
        ]);

        assert!(run_with(&mut os, SHELL));

        assert!(
            os.signals_to(DAEMON).is_empty(),
            "the signal gate protects the caller and its ancestors"
        );
    }

    #[test]
    fn nothing_is_forced_when_the_grace_was_enough() {
        // Everything under the shell goes during the grace; the shell itself is
        // reaped too. There is nothing left to SIGKILL.
        let mut os = Fake::new(vec![
            Some(table(vec![row(300, SHELL, "claude")])),
            Some(vec![row(DAEMON, 1, "kriyon-ptyd --id sess")]),
        ]);

        assert!(run_with(&mut os, SHELL));

        assert!(os.forced().is_empty(), "no SIGKILL was owed");
    }

    #[test]
    fn a_pid_that_changed_its_command_line_during_the_grace_is_never_forced() {
        // The pid was freed and handed to something else. SIGKILL gives no
        // second chance, so identity is the command line, not the number.
        let mut os = Fake::new(vec![
            Some(table(vec![row(300, SHELL, "pnpm dev")])),
            // The shell is gone; 300 now belongs to someone else entirely.
            Some(vec![
                row(DAEMON, 1, "kriyon-ptyd --id sess"),
                row(300, 1, "/Applications/Mail.app/Contents/MacOS/Mail"),
            ]),
        ]);

        assert!(run_with(&mut os, SHELL));

        assert!(
            !os.forced().contains(&300),
            "a reused pid is not our process, got {:?}",
            os.sent
        );
    }

    #[test]
    fn a_process_forked_during_the_grace_is_forced_too() {
        // A stop that enumerates once misses whatever the tree spawns while it
        // is waiting.
        let survivor = row(301, SHELL, "npm exec vite");
        let mut os = Fake::new(vec![
            Some(table(vec![row(300, SHELL, "claude")])),
            Some(table(vec![survivor.clone()])),
        ]);

        assert!(run_with(&mut os, SHELL));

        assert!(
            os.forced().contains(&301),
            "a newcomer is a target too, got {:?}",
            os.forced()
        );
    }

    #[test]
    fn an_unreadable_table_forces_nothing() {
        // A rare leak beats a wrong kill: with no sweep to confirm identity,
        // the force window must send nothing at all.
        let mut os = Fake::new(vec![Some(table(vec![row(300, SHELL, "claude")])), None]);

        assert!(run_with(&mut os, SHELL));

        assert!(
            os.forced().is_empty(),
            "nothing may be forced from an unreadable table, got {:?}",
            os.forced()
        );
    }

    #[test]
    fn a_first_sweep_that_fails_reports_failure_so_the_caller_can_fall_back() {
        let mut os = Fake::new(vec![None]);

        assert!(
            !run_with(&mut os, SHELL),
            "the caller must know to end the one process it holds a handle to"
        );
        assert!(os.sent.is_empty(), "and nothing was signalled blind");
    }

    #[test]
    fn a_shell_whose_pid_was_reused_roots_nothing() {
        // The shell died and its number went to an unrelated process. Rooting
        // the stop there would end that process and everything beneath it.
        let stranger = row(SHELL, 1, "/usr/bin/ssh build-host");
        let victim = row(400, SHELL, "rsync -a ./ build-host:/srv");
        let mut os = Fake::new(vec![Some(vec![
            row(DAEMON, 1, "kriyon-ptyd --id sess"),
            stranger,
            victim,
        ])]);
        // Its session is not ours either, so nothing is claimed through it.
        os.session = Some(Vec::new());

        assert!(run_with(&mut os, SHELL));

        assert!(
            os.sent.is_empty(),
            "neither the stranger nor its children may be touched, got {:?}",
            os.sent
        );
    }

    #[test]
    fn a_job_already_reparented_to_launchd_is_still_a_target() {
        // The blind spot descendants alone cannot cover: its parent is gone, so
        // only the kernel session still ties it to this terminal.
        let orphan = row(500, 1, "node server.js");
        let mut os = Fake::new(vec![Some(table(vec![orphan])), Some(table(vec![]))]);
        os.session = Some(vec![SHELL, 500]);

        assert!(run_with(&mut os, SHELL));

        assert_eq!(os.signals_to(500), vec![libc::SIGTERM]);
    }
}
