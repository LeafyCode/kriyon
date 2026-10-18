//! [Session resources] — the physical memory ([Session footprint]) and CPU one
//! session's processes use, and the [Memory budget] policy over the total.
//!
//! Which pids a session is charged for is [`crate::proc::ProcessTree`]'s job
//! this module sums the readings over them and decides when to warn. Reading the actual numbers is
//! IO and lives in the Tauri shell, so the attribution and warning rules stay
//! unit-testable.

use std::collections::HashMap;

const MIB: u64 = 1024 * 1024;

/// The mach absolute-time to nanoseconds ratio (`mach_timebase_info`).
///
/// `proc_pid_rusage` reports CPU time and process start in mach ticks, not
/// nanoseconds. On Apple Silicon a tick is 125/3 ns, so skipping the
/// conversion reads CPU ~42x too low; on Intel the ratio is 1/1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timebase {
    pub numer: u32,
    pub denom: u32,
}

impl Timebase {
    /// One tick per nanosecond (Intel, and the fallback when the syscall fails).
    pub const IDENTITY: Self = Self { numer: 1, denom: 1 };

    /// Convert mach ticks to nanoseconds, saturating instead of overflowing.
    #[must_use]
    pub fn to_ns(self, ticks: u64) -> u64 {
        if self.denom == 0 {
            return ticks;
        }
        let ns = u128::from(ticks) * u128::from(self.numer) / u128::from(self.denom);
        u64::try_from(ns).unwrap_or(u64::MAX)
    }
}

/// One pid's reading from a single `proc_pid_rusage` call.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PidReading {
    /// `ri_phys_footprint`, in bytes.
    pub footprint_bytes: u64,
    /// `ri_user_time + ri_system_time`, in mach ticks.
    pub cpu_ticks: u64,
    /// `ri_proc_start_abstime`, in mach ticks. With the pid, it identifies the
    /// process across samples, so a reused pid is never diffed against its
    /// predecessor.
    pub start_ticks: u64,
}

/// Every pid read in one sweep, and when (`mach_absolute_time`). Kept until
/// the next sweep as the CPU baseline.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResourceSample {
    pub at_ticks: u64,
    pub pids: HashMap<i32, PidReading>,
}

/// One session's [Session resources].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SessionResources {
    /// [Session footprint] in MB.
    pub memory_mb: u64,
    /// CPU over the last interval, in percent of one core (so it can exceed
    /// 100 on a multi-core machine). `None` until a second sample exists.
    pub cpu_pct: Option<f64>,
}

/// One sweep's readings: what each session costs, and what they cost together.
///
/// The totals are part of the fold rather than something each surface re-sums,
/// so the sidebar chips, the tray readout and the [Memory budget] check can
/// never disagree about either the rows or their sum.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResourceSweep {
    /// [Session resources] per session id.
    pub per_session: HashMap<String, SessionResources>,
    /// Whole-app footprint in MB: the sum of the rows' `memory_mb`.
    pub total_mb: u64,
    /// Whole-app CPU percent: the sum of the rows' `cpu_pct`, or `None` while
    /// no row has a CPU reading yet.
    pub total_cpu_pct: Option<f64>,
}

impl ResourceSweep {
    /// Drop a session from the cached sweep, keeping the totals consistent
    /// with the rows. Used when a session closes, so the tray and the
    /// [Memory budget] check stop counting it immediately instead of waiting
    /// for the next sample to overwrite the sweep.
    pub fn forget(&mut self, session_id: &str) {
        let Some(row) = self.per_session.remove(session_id) else {
            return;
        };
        self.total_mb = self.total_mb.saturating_sub(row.memory_mb);
        if let (Some(total), Some(cpu)) = (self.total_cpu_pct, row.cpu_pct) {
            self.total_cpu_pct = Some((total - cpu).max(0.0));
        }
    }
}

/// Fold one sweep's per-pid readings into per-session [Session resources]
/// plus the totals, given the pids charged to each session.
///
/// Memory sums bytes and converts to MB once per session, so no per-pid
/// rounding is lost. CPU is the cpu-time delta against `prev` over the wall
/// time between the two samples; `prev` of `None` (the first sweep) leaves
/// CPU unknown. Pids missing from `now` (raced an exit, unreadable, zombie)
/// contribute zero: the fold must never fail the sweep.
#[must_use]
pub fn fold_resources(
    trees: &[(String, Vec<i32>)],
    now: &ResourceSample,
    prev: Option<&ResourceSample>,
    timebase: Timebase,
) -> ResourceSweep {
    let wall_ns = prev
        .map(|prev| timebase.to_ns(now.at_ticks.saturating_sub(prev.at_ticks)))
        .filter(|ns| *ns > 0);
    let mut sweep = ResourceSweep::default();
    for (session_id, pids) in trees {
        let mut bytes: u64 = 0;
        let mut cpu_ticks: u64 = 0;
        for pid in pids {
            let Some(reading) = now.pids.get(pid) else {
                continue;
            };
            bytes = bytes.saturating_add(reading.footprint_bytes);
            if let Some(prev) = prev {
                cpu_ticks = cpu_ticks.saturating_add(cpu_delta(*pid, reading, prev));
            }
        }
        let row = SessionResources {
            memory_mb: (bytes + MIB / 2) / MIB,
            cpu_pct: wall_ns.map(|wall| percent(timebase.to_ns(cpu_ticks), wall)),
        };
        sweep.total_mb += row.memory_mb;
        if let Some(cpu) = row.cpu_pct {
            sweep.total_cpu_pct = Some(sweep.total_cpu_pct.unwrap_or(0.0) + cpu);
        }
        sweep.per_session.insert(session_id.clone(), row);
    }
    sweep
}

/// The CPU ticks one pid spent since `prev`. The same process (pid and start
/// time match) diffs against its baseline; one born after `prev` was taken
/// counts its whole lifetime; anything else (no baseline) counts zero.
fn cpu_delta(pid: i32, reading: &PidReading, prev: &ResourceSample) -> u64 {
    match prev.pids.get(&pid) {
        Some(before) if before.start_ticks == reading.start_ticks => {
            reading.cpu_ticks.saturating_sub(before.cpu_ticks)
        }
        _ if reading.start_ticks > prev.at_ticks => reading.cpu_ticks,
        _ => 0,
    }
}

#[allow(clippy::cast_precision_loss)] // ns counts stay far below 2^52.
fn percent(cpu_ns: u64, wall_ns: u64) -> f64 {
    cpu_ns as f64 / wall_ns as f64 * 100.0
}

/// What the detached-process rules need to know about one process beyond
/// its place in the ppid tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcFacts {
    pub pid: i32,
    pub ppid: i32,
    /// Controlling terminal device (`e_tdev`), or `None` without one.
    pub tty: Option<u32>,
    /// Owned by the user Kriyon runs as, so its environment is readable.
    pub same_uid: bool,
}

/// The environment variable every session's shell exports with its id.
pub const SESSION_ENV: &str = "KRIYON_SESSION";

/// Which pids each session is charged for: its ppid tree, plus processes that
/// left the tree but still hold the session's terminal, plus daemonized
/// processes that still carry the session's [`SESSION_ENV`], plus the
/// children of both.
///
/// A process that backgrounds itself and loses its parent (`npm run dev &`
/// after the shell exits) is reparented to launchd and drops out of the ppid
/// walk, but keeps its controlling terminal. A session's terminal is the
/// controlling tty of its tree's top-level children (the shell the [PTY
/// daemon] hosts) — never the daemons' own, which they may inherit from
/// wherever the app was started.
///
/// A process that fully daemonizes (`setsid` and detach, like a plugin's
/// broker) has neither, but usually keeps the environment it was started
/// with. Reading another process's environment is the expensive step, so
/// `session_env` (the pid's [`SESSION_ENV`] value) is asked only about
/// unclaimed, same-user processes whose parent is launchd. A process can
/// scrub its environment, so this rule is best-effort.
///
/// Each pid is charged once, in rule order: a tree member stays where the
/// tree put it. A tty two sessions both claim is trusted for neither.
#[must_use]
pub fn attribute(
    trees: &[(String, Vec<i32>)],
    procs: &[ProcFacts],
    mut session_env: impl FnMut(i32) -> Option<String>,
) -> Vec<(String, Vec<i32>)> {
    let by_pid: HashMap<i32, &ProcFacts> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut claimed: HashMap<i32, usize> = HashMap::new();
    let mut charged: Vec<(String, Vec<i32>)> = Vec::with_capacity(trees.len());
    for (index, (id, pids)) in trees.iter().enumerate() {
        let own: Vec<i32> = pids
            .iter()
            .copied()
            .filter(|pid| *claimed.entry(*pid).or_insert(index) == index)
            .collect();
        charged.push((id.clone(), own));
    }

    // tty -> the one session whose shell holds it (None once two do).
    let mut ttys: HashMap<u32, Option<usize>> = HashMap::new();
    for (index, (_, pids)) in charged.iter().enumerate() {
        for tty in shell_ttys(pids, &by_pid) {
            ttys.entry(tty)
                .and_modify(|owner| {
                    if *owner != Some(index) {
                        *owner = None;
                    }
                })
                .or_insert(Some(index));
        }
    }

    for proc in procs {
        if claimed.contains_key(&proc.pid) {
            continue;
        }
        if let Some(Some(index)) = proc.tty.and_then(|tty| ttys.get(&tty)) {
            claimed.insert(proc.pid, *index);
            charged[*index].1.push(proc.pid);
        }
    }

    for proc in procs {
        if proc.ppid != 1 || !proc.same_uid || claimed.contains_key(&proc.pid) {
            continue;
        }
        let Some(id) = session_env(proc.pid) else {
            continue;
        };
        if let Some(index) = charged.iter().position(|(session, _)| *session == id) {
            claimed.insert(proc.pid, index);
            charged[index].1.push(proc.pid);
        }
    }

    adopt_children(&mut charged, &mut claimed, procs);
    charged
}

/// The value of environment variable `key` in a `KERN_PROCARGS2` buffer, or
/// `None` when it is absent or the buffer doesn't parse.
///
/// The layout is: `argc` (a native-endian `i32`), the executable path, NUL
/// padding, `argc` NUL-terminated arguments, then the NUL-terminated
/// environment, ending at an empty string. Arguments are skipped by count,
/// so an argument that looks like `KEY=value` is never read as the env.
#[must_use]
pub fn env_value(procargs: &[u8], key: &str) -> Option<String> {
    let argc = usize::try_from(i32::from_ne_bytes(procargs.get(..4)?.try_into().ok()?)).ok()?;
    let mut strings = procargs[4..].split(|byte| *byte == 0);
    strings.next()?; // The executable path.
    let mut strings = strings.skip_while(|s| s.is_empty());
    for _ in 0..argc {
        strings.next()?;
    }
    let prefix = format!("{key}=");
    for entry in strings {
        if entry.is_empty() {
            return None;
        }
        if let Some(value) = entry.strip_prefix(prefix.as_bytes()) {
            return Some(String::from_utf8_lossy(value).into_owned());
        }
    }
    None
}

/// The ttys of a tree's top-level children: processes whose parent is a tree
/// root (a pid whose own parent is outside the tree, i.e. a daemon).
fn shell_ttys(pids: &[i32], by_pid: &HashMap<i32, &ProcFacts>) -> Vec<u32> {
    let roots: Vec<i32> = pids
        .iter()
        .copied()
        .filter(|pid| by_pid.get(pid).is_none_or(|p| !pids.contains(&p.ppid)))
        .collect();
    pids.iter()
        .filter_map(|pid| by_pid.get(pid))
        .filter(|p| roots.contains(&p.ppid))
        .filter_map(|p| p.tty)
        .collect()
}

/// Charge every unclaimed descendant of a claimed pid to the same session,
/// so a detached process's workers follow it.
fn adopt_children(
    charged: &mut [(String, Vec<i32>)],
    claimed: &mut HashMap<i32, usize>,
    procs: &[ProcFacts],
) {
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for proc in procs {
        children.entry(proc.ppid).or_default().push(proc.pid);
    }
    for (index, (_, pids)) in charged.iter_mut().enumerate() {
        let mut cursor = 0;
        while cursor < pids.len() {
            let parent = pids[cursor];
            cursor += 1;
            for child in children.get(&parent).into_iter().flatten() {
                if !claimed.contains_key(child) {
                    claimed.insert(*child, index);
                    pids.push(*child);
                }
            }
        }
    }
}

/// The user's [Memory budget]: the whole-app footprint (MB) above which Kriyon
/// warns, and whether warnings fire at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemoryBudget {
    pub budget_mb: u64,
    pub warn_enabled: bool,
}

impl Default for MemoryBudget {
    fn default() -> Self {
        Self {
            budget_mb: 6144,
            warn_enabled: true,
        }
    }
}

/// Minimum quiet time between two memory warnings. A budget overrun persists
/// for as long as the user leaves sessions running; re-notifying every sweep
/// would train them to ignore it.
pub const WARN_COOLDOWN_SECS: u64 = 30 * 60;

/// Whether a memory warning should fire now. `secs_since_last_warn` is `None`
/// when no warning has fired yet this run.
#[must_use]
pub fn should_warn(
    budget: &MemoryBudget,
    total_mb: u64,
    secs_since_last_warn: Option<u64>,
) -> bool {
    budget.warn_enabled
        && total_mb > budget.budget_mb
        && secs_since_last_warn.is_none_or(|secs| secs >= WARN_COOLDOWN_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc::{ProcRow, ProcessTree};

    // `pid`/`ppid` are the right names for these POSIX columns.
    #[allow(clippy::similar_names)]
    fn row(pid: i32, ppid: i32, cmd: &str) -> ProcRow {
        ProcRow {
            pid,
            ppid,
            tpgid: -1,
            cmd: cmd.into(),
        }
    }

    fn table() -> Vec<ProcRow> {
        vec![
            row(
                100,
                1,
                "kriyon-ptyd /Users/x/.claude/kriyon/run/sess-a.sock",
            ),
            row(200, 100, "/bin/zsh -l"),
            row(300, 200, "claude --resume"),
            row(310, 300, "npm exec context7-mcp"),
            row(311, 310, "node context7-mcp-server"),
            // A different session's daemon + child: must not be counted.
            row(
                400,
                1,
                "kriyon-ptyd /Users/x/.claude/kriyon/run/sess-b.sock",
            ),
            row(410, 400, "/bin/zsh -l"),
            // Unrelated process mentioning the id: not a daemon.
            row(900, 1, "grep sess-a.sock /tmp/log"),
        ]
    }

    fn trees() -> Vec<(String, Vec<i32>)> {
        let rows = table();
        let tree = ProcessTree::new(&rows);
        ["sess-a", "sess-b"]
            .into_iter()
            .map(|id| (id.to_string(), tree.tree_pids(id)))
            .collect()
    }

    const MIB: u64 = 1024 * 1024;

    fn reading(footprint_bytes: u64, cpu_ticks: u64, start_ticks: u64) -> PidReading {
        PidReading {
            footprint_bytes,
            cpu_ticks,
            start_ticks,
        }
    }

    fn sample(at_ticks: u64, pids: &[(i32, PidReading)]) -> ResourceSample {
        ResourceSample {
            at_ticks,
            pids: pids.iter().copied().collect(),
        }
    }

    #[test]
    fn apple_silicon_ticks_convert_to_nanoseconds() {
        // M-series: 125/3 ns per tick. Without this CPU reads ~42x low.
        let m1 = Timebase {
            numer: 125,
            denom: 3,
        };
        assert_eq!(m1.to_ns(24_000_000), 1_000_000_000);
        assert_eq!(Timebase::IDENTITY.to_ns(42), 42);
        // A zero denominator (a failed syscall) must not divide by zero.
        assert_eq!(Timebase { numer: 1, denom: 0 }.to_ns(7), 7);
        // Huge tick counts don't overflow the intermediate product.
        assert_eq!(m1.to_ns(u64::MAX), u64::MAX);
    }

    #[test]
    fn memory_sums_bytes_and_converts_once() {
        // Ten pids of 1.5 MiB each: flooring per pid would read 10 MB.
        let pids: Vec<(i32, PidReading)> = (0..10)
            .map(|i| (100 + i, reading(MIB + MIB / 2, 0, 0)))
            .collect();
        let trees = vec![("s".to_string(), (100..110).collect())];
        let sweep = fold_resources(&trees, &sample(10, &pids), None, Timebase::IDENTITY);
        assert_eq!(sweep.per_session["s"].memory_mb, 15);
    }

    #[test]
    fn cpu_is_unknown_until_a_second_sample() {
        let now = sample(1_000, &[(100, reading(MIB, 500, 0))]);
        let trees = vec![("s".to_string(), vec![100])];
        let sweep = fold_resources(&trees, &now, None, Timebase::IDENTITY);
        assert_eq!(sweep.per_session["s"].cpu_pct, None);
        assert_eq!(sweep.total_cpu_pct, None);
    }

    #[test]
    fn cpu_is_cpu_time_over_wall_time_summed_per_session() {
        let trees = vec![
            ("a".to_string(), vec![100, 101]),
            ("b".to_string(), vec![200]),
        ];
        let prev = sample(
            1_000,
            &[
                (100, reading(0, 100, 5)),
                (101, reading(0, 0, 5)),
                (200, reading(0, 0, 5)),
            ],
        );
        // 1000 ticks of wall time; a used 1500 ticks (1.5 cores), b 250.
        let now = sample(
            2_000,
            &[
                (100, reading(0, 1_100, 5)),
                (101, reading(0, 500, 5)),
                (200, reading(0, 250, 5)),
            ],
        );
        let sweep = fold_resources(&trees, &now, Some(&prev), Timebase::IDENTITY);
        assert_eq!(sweep.per_session["a"].cpu_pct, Some(150.0));
        assert_eq!(sweep.per_session["b"].cpu_pct, Some(25.0));
        assert_eq!(sweep.total_cpu_pct, Some(175.0));
    }

    #[test]
    fn cpu_uses_the_timebase() {
        let tb = Timebase {
            numer: 125,
            denom: 3,
        };
        let trees = vec![("s".to_string(), vec![100])];
        let prev = sample(0, &[(100, reading(0, 0, 0))]);
        let now = sample(3_000, &[(100, reading(0, 300, 0))]);
        // Both deltas scale alike, so the ratio is unchanged: 10%.
        let sweep = fold_resources(&trees, &now, Some(&prev), tb);
        let pct = sweep.per_session["s"].cpu_pct.expect("a reading");
        assert!((pct - 10.0).abs() < 1e-9, "{pct}");
    }

    #[test]
    fn a_reused_pid_is_not_diffed_against_its_predecessor() {
        let trees = vec![("s".to_string(), vec![100])];
        // Same pid, different start time, started before the previous sample
        // (the sample raced the reuse): no baseline, so it counts zero.
        let prev = sample(1_000, &[(100, reading(0, 9_000, 5))]);
        let now = sample(2_000, &[(100, reading(0, 100, 7))]);
        let sweep = fold_resources(&trees, &now, Some(&prev), Timebase::IDENTITY);
        assert_eq!(sweep.per_session["s"].cpu_pct, Some(0.0));
    }

    #[test]
    fn a_pid_born_after_the_previous_sample_counts_its_whole_cpu_time() {
        let trees = vec![("s".to_string(), vec![100, 101])];
        let prev = sample(1_000, &[(100, reading(0, 0, 5))]);
        let now = sample(
            2_000,
            &[(100, reading(0, 0, 5)), (101, reading(0, 400, 1_500))],
        );
        let sweep = fold_resources(&trees, &now, Some(&prev), Timebase::IDENTITY);
        assert_eq!(sweep.per_session["s"].cpu_pct, Some(40.0));
    }

    #[test]
    fn an_exited_pid_just_drops_out() {
        let trees = vec![("s".to_string(), vec![100])];
        let prev = sample(1_000, &[(100, reading(0, 0, 5)), (101, reading(0, 0, 5))]);
        let now = sample(2_000, &[(100, reading(MIB, 100, 5))]);
        let sweep = fold_resources(&trees, &now, Some(&prev), Timebase::IDENTITY);
        assert_eq!(sweep.per_session["s"].cpu_pct, Some(10.0));
        assert_eq!(sweep.per_session["s"].memory_mb, 1);
    }

    #[test]
    fn forgetting_a_session_drops_its_cpu_from_the_total() {
        let trees = vec![("a".to_string(), vec![100]), ("b".to_string(), vec![200])];
        let prev = sample(0, &[(100, reading(0, 0, 0)), (200, reading(0, 0, 0))]);
        let now = sample(
            1_000,
            &[(100, reading(0, 500, 0)), (200, reading(0, 100, 0))],
        );
        let mut sweep = fold_resources(&trees, &now, Some(&prev), Timebase::IDENTITY);
        sweep.forget("a");
        assert_eq!(sweep.total_cpu_pct, Some(10.0));
    }

    /// Fold whole-MB footprints over [`trees`], the shape the older tests use.
    fn fold_mb(footprints: &[(i32, u64)]) -> ResourceSweep {
        let pids = footprints
            .iter()
            .map(|(pid, mb)| (*pid, reading(mb * MIB, 0, 0)))
            .collect::<Vec<_>>();
        fold_resources(&trees(), &sample(0, &pids), None, Timebase::IDENTITY)
    }

    #[test]
    fn each_session_is_charged_only_its_own_tree() {
        let footprints: &[(i32, u64)] = &[
            (100, 5),
            (200, 10),
            (300, 400),
            (310, 117),
            (311, 43),
            (400, 5),
            (410, 10),
            (900, 999),
        ];
        let sweep = fold_mb(footprints);
        assert_eq!(sweep.per_session["sess-a"].memory_mb, 575);
        assert_eq!(sweep.per_session["sess-b"].memory_mb, 15);
    }

    #[test]
    fn the_total_is_the_sum_of_the_rows_and_is_derived_once() {
        // The one place the whole-app total is computed. Every surface — the
        // event, the budget check, the tray readout — reads this number, so
        // they cannot drift from each other or from the per-session rows.
        let footprints: &[(i32, u64)] = &[(100, 5), (200, 10), (300, 400), (400, 5)];
        let sweep = fold_mb(footprints);
        assert_eq!(sweep.total_mb, 420);
        assert_eq!(
            sweep.total_mb,
            sweep.per_session.values().map(|r| r.memory_mb).sum::<u64>()
        );
    }

    #[test]
    fn pids_without_a_reading_contribute_zero() {
        let footprints: &[(i32, u64)] = &[(300, 400)];
        let sweep = fold_mb(footprints);
        assert_eq!(sweep.per_session["sess-a"].memory_mb, 400);
        assert_eq!(
            sweep.per_session["sess-b"].memory_mb, 0,
            "a read-less tree is zero"
        );
        assert_eq!(sweep.total_mb, 400);
    }

    #[test]
    fn forgetting_a_session_keeps_the_total_consistent_with_the_rows() {
        let footprints: &[(i32, u64)] = &[(100, 5), (200, 10), (300, 400), (400, 5), (410, 10)];
        let mut sweep = fold_mb(footprints);
        assert_eq!(
            sweep.total_mb,
            sweep.per_session.values().map(|r| r.memory_mb).sum::<u64>()
        );

        sweep.forget("sess-a");
        assert!(!sweep.per_session.contains_key("sess-a"));
        assert_eq!(
            sweep.total_mb,
            sweep.per_session.values().map(|r| r.memory_mb).sum::<u64>(),
            "the total still equals the surviving rows"
        );

        // Forgetting an unknown id, or a second forget, cannot underflow.
        sweep.forget("sess-a");
        sweep.forget("ghost");
        assert_eq!(
            sweep.total_mb,
            sweep.per_session.values().map(|r| r.memory_mb).sum::<u64>()
        );
    }

    #[test]
    fn an_empty_sweep_totals_zero() {
        let sweep = fold_resources(&[], &ResourceSample::default(), None, Timebase::IDENTITY);
        assert_eq!(sweep.total_mb, 0);
        assert!(sweep.per_session.is_empty());
    }

    // `pid`/`ppid` are the right names for these POSIX columns.
    #[allow(clippy::similar_names)]
    fn facts(pid: i32, ppid: i32, tty: Option<u32>) -> ProcFacts {
        ProcFacts {
            pid,
            ppid,
            tty,
            same_uid: true,
        }
    }

    fn no_env(_pid: i32) -> Option<String> {
        None
    }

    /// Two sessions: a's daemon 100 hosts shell 200 on tty 7; b's daemon 400
    /// hosts shell 410 on tty 9. Both daemons sit on tty 3 (the terminal the
    /// app was started from) — that must not count as a session's tty.
    fn two_sessions() -> (Vec<(String, Vec<i32>)>, Vec<ProcFacts>) {
        let trees = vec![
            ("a".to_string(), vec![100, 200, 300]),
            ("b".to_string(), vec![400, 410]),
        ];
        let procs = vec![
            facts(100, 1, Some(3)),
            facts(200, 100, Some(7)),
            facts(300, 200, Some(7)),
            facts(400, 1, Some(3)),
            facts(410, 400, Some(9)),
        ];
        (trees, procs)
    }

    fn pids_of<'a>(attributed: &'a [(String, Vec<i32>)], id: &str) -> &'a [i32] {
        attributed
            .iter()
            .find(|(session, _)| session == id)
            .map(|(_, pids)| pids.as_slice())
            .expect("session present")
    }

    #[test]
    fn an_orphan_on_the_sessions_tty_is_still_charged_to_it() {
        // `npm run dev &`, then the shell that started it exited: reparented
        // to launchd, but it keeps the session's terminal.
        let (trees, mut procs) = two_sessions();
        procs.push(facts(500, 1, Some(7)));
        let attributed = attribute(&trees, &procs, no_env);
        assert_eq!(pids_of(&attributed, "a"), &[100, 200, 300, 500]);
        assert_eq!(pids_of(&attributed, "b"), &[400, 410]);
    }

    #[test]
    fn processes_on_other_ttys_or_none_are_not_charged() {
        let (trees, mut procs) = two_sessions();
        procs.push(facts(600, 1, Some(42)));
        procs.push(facts(601, 1, None));
        // Shares the daemons' inherited tty, not a session's own.
        procs.push(facts(602, 1, Some(3)));
        let attributed = attribute(&trees, &procs, no_env);
        assert_eq!(pids_of(&attributed, "a"), &[100, 200, 300]);
        assert_eq!(pids_of(&attributed, "b"), &[400, 410]);
    }

    #[test]
    fn a_tree_member_is_never_reclaimed_by_another_sessions_tty() {
        // 300 is in a's tree but opened b's tty: the ppid tree wins.
        let (trees, mut procs) = two_sessions();
        procs[2] = facts(300, 200, Some(9));
        let attributed = attribute(&trees, &procs, no_env);
        assert_eq!(pids_of(&attributed, "a"), &[100, 200, 300]);
        assert_eq!(pids_of(&attributed, "b"), &[400, 410]);
    }

    #[test]
    fn children_of_a_detached_process_follow_it() {
        let (trees, mut procs) = two_sessions();
        procs.push(facts(500, 1, Some(7)));
        // The detached dev server's worker gave up the tty.
        procs.push(facts(501, 500, None));
        let attributed = attribute(&trees, &procs, no_env);
        assert_eq!(pids_of(&attributed, "a"), &[100, 200, 300, 500, 501]);
    }

    #[test]
    fn a_pid_listed_in_two_trees_is_charged_once() {
        let (mut trees, procs) = two_sessions();
        trees[1].1.push(300);
        let attributed = attribute(&trees, &procs, no_env);
        assert_eq!(pids_of(&attributed, "a"), &[100, 200, 300]);
        assert_eq!(pids_of(&attributed, "b"), &[400, 410]);
    }

    #[test]
    fn a_tty_two_sessions_both_claim_charges_neither() {
        // A garbled table can't be trusted to say whose terminal it is.
        let (trees, mut procs) = two_sessions();
        procs[4] = facts(410, 400, Some(7));
        procs.push(facts(500, 1, Some(7)));
        let attributed = attribute(&trees, &procs, no_env);
        assert!(!pids_of(&attributed, "a").contains(&500));
        assert!(!pids_of(&attributed, "b").contains(&500));
    }

    #[test]
    fn a_daemonized_process_carrying_the_session_env_is_charged() {
        // A broker that did setsid + detach: ppid 1, no tty, but it still has
        // KRIYON_SESSION from the shell it was started in.
        let (trees, mut procs) = two_sessions();
        procs.push(facts(700, 1, None));
        procs.push(facts(701, 700, None));
        let attributed = attribute(&trees, &procs, |pid| (pid == 700).then(|| "b".to_string()));
        assert_eq!(pids_of(&attributed, "b"), &[400, 410, 700, 701]);
    }

    #[test]
    fn env_is_only_read_for_unclaimed_same_user_orphans() {
        let (trees, mut procs) = two_sessions();
        procs.push(facts(500, 1, Some(7))); // claimed by tty already
        procs.push(facts(600, 42, None)); // has a live parent
        procs.push(ProcFacts {
            same_uid: false,
            ..facts(601, 1, None)
        });
        procs.push(facts(602, 1, None)); // the one candidate
        let mut asked = Vec::new();
        let _ = attribute(&trees, &procs, |pid| {
            asked.push(pid);
            None
        });
        assert_eq!(asked, vec![602]);
    }

    #[test]
    fn an_env_naming_no_live_session_is_ignored() {
        let (trees, mut procs) = two_sessions();
        procs.push(facts(700, 1, None));
        let attributed = attribute(&trees, &procs, |_| Some("closed".to_string()));
        assert!(attributed.iter().all(|(_, pids)| !pids.contains(&700)));
    }

    /// Build a `KERN_PROCARGS2` buffer: argc, exec path, padding, argv, env.
    fn procargs(argv: &[&str], env: &[&str]) -> Vec<u8> {
        let mut buf = i32::try_from(argv.len())
            .expect("argc fits")
            .to_ne_bytes()
            .to_vec();
        buf.extend_from_slice(b"/usr/bin/node\0\0\0\0");
        for arg in argv.iter().chain(env) {
            buf.extend_from_slice(arg.as_bytes());
            buf.push(0);
        }
        buf.push(0);
        buf
    }

    #[test]
    fn the_session_env_is_read_from_procargs() {
        let buf = procargs(
            &["node", "broker.mjs"],
            &["HOME=/Users/x", "KRIYON_SESSION=sess-a", "PATH=/bin"],
        );
        assert_eq!(env_value(&buf, "KRIYON_SESSION").as_deref(), Some("sess-a"));
        assert_eq!(env_value(&buf, "HOME").as_deref(), Some("/Users/x"));
        assert_eq!(env_value(&buf, "KRIYON"), None, "whole names only");
    }

    #[test]
    fn an_argument_that_looks_like_the_env_is_not_read_as_it() {
        let buf = procargs(&["env", "KRIYON_SESSION=fake"], &["PATH=/bin"]);
        assert_eq!(env_value(&buf, "KRIYON_SESSION"), None);
    }

    #[test]
    fn garbled_procargs_read_as_no_env() {
        assert_eq!(env_value(&[], "KRIYON_SESSION"), None);
        assert_eq!(env_value(&[1, 0], "KRIYON_SESSION"), None);
        let mut cut = procargs(&["node"], &["KRIYON_SESSION=sess-a"]);
        cut.truncate(10);
        assert_eq!(env_value(&cut, "KRIYON_SESSION"), None);
        // argc larger than the strings present.
        let mut lying = procargs(&["node"], &["KRIYON_SESSION=sess-a"]);
        lying[..4].copy_from_slice(&99_i32.to_ne_bytes());
        assert_eq!(env_value(&lying, "KRIYON_SESSION"), None);
    }

    #[test]
    fn warning_gates_on_toggle_budget_and_cooldown() {
        let budget = MemoryBudget {
            budget_mb: 6144,
            warn_enabled: true,
        };
        assert!(should_warn(&budget, 7000, None));
        assert!(should_warn(&budget, 7000, Some(WARN_COOLDOWN_SECS)));
        assert!(!should_warn(&budget, 7000, Some(10)), "cooldown suppresses");
        assert!(!should_warn(&budget, 6144, None), "at budget is not over");
        let off = MemoryBudget {
            warn_enabled: false,
            ..budget
        };
        assert!(!should_warn(&off, 99_999, None), "toggle wins");
    }
}
