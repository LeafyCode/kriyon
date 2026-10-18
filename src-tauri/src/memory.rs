//! [Session resources] sampling: read each live session's processes' memory
//! and CPU and surface it — a `session-resources` event for the sidebar chips,
//! a cached sweep for the tray snapshot, and a budget warning when the whole
//! app's footprint crosses the user's [Memory budget].
//!
//! One `proc_pid_rusage` call per pid gives the footprint, the CPU time and
//! the start time. Memory is `ri_phys_footprint` (the number the macOS memory
//! pressure system charges), never RSS: under pressure RSS reads near zero for
//! compressed processes, and it double-counts shared pages. The pure fold
//! lives in [`kriyon_core::memory`]; this module owns the IO ends.

use std::collections::HashMap;
use std::time::Instant;

use kriyon_core::memory::{PidReading, ProcFacts, ResourceSample};
use kriyon_core::session::SessionId;
use serde::Serialize;
use tauri::{Emitter as _, Manager as _};

use crate::AppState;

/// Payload for the `session-resources` event: per live session its MB and
/// (from the second sample on) CPU percent, plus the totals across all of
/// them. Every field comes straight off the one [`ResourceSweep`] — no
/// surface re-sums them.
///
/// [`ResourceSweep`]: kriyon_core::memory::ResourceSweep
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourcesUpdate {
    sessions: HashMap<String, u64>,
    /// CPU percent per session; a session is absent until it has a reading.
    cpu: HashMap<String, f64>,
    total_mb: u64,
    total_cpu_pct: Option<f64>,
}

#[cfg(target_os = "macos")]
mod mach {
    #[repr(C)]
    #[derive(Default)]
    struct MachTimebaseInfo {
        numer: u32,
        denom: u32,
    }

    // Declared here rather than taken from `libc`, which deprecates its copies
    // in favour of the `mach2` crate — two symbols don't warrant a dependency.
    extern "C" {
        fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
        fn mach_absolute_time() -> u64;
    }

    /// The machine's tick ratio, read once. Falls back to 1/1 if the call
    /// fails, which is right on Intel and only skews CPU on Apple Silicon.
    pub fn timebase() -> kriyon_core::memory::Timebase {
        static TIMEBASE: std::sync::OnceLock<kriyon_core::memory::Timebase> =
            std::sync::OnceLock::new();
        *TIMEBASE.get_or_init(|| {
            let mut info = MachTimebaseInfo::default();
            // SAFETY: `info` is a valid, writable `mach_timebase_info_data_t`.
            let status = unsafe { mach_timebase_info(&raw mut info) };
            if status != 0 || info.denom == 0 {
                return kriyon_core::memory::Timebase::IDENTITY;
            }
            kriyon_core::memory::Timebase {
                numer: info.numer,
                denom: info.denom,
            }
        })
    }

    pub fn now_ticks() -> u64 {
        // SAFETY: takes no arguments and cannot fail.
        unsafe { mach_absolute_time() }
    }
}

#[cfg(not(target_os = "macos"))]
mod mach {
    pub fn timebase() -> kriyon_core::memory::Timebase {
        kriyon_core::memory::Timebase::IDENTITY
    }

    pub fn now_ticks() -> u64 {
        0
    }
}

/// One pid's footprint, CPU time and start time, or `None` when the process
/// is gone or unreadable. Best-effort by design: a vanished pid must not fail
/// the sweep.
#[cfg(target_os = "macos")]
fn read_pid(pid: i32) -> Option<PidReading> {
    use libproc::pid_rusage::{pidrusage, RUsageInfoV4};
    let usage = pidrusage::<RUsageInfoV4>(pid).ok()?;
    Some(PidReading {
        footprint_bytes: usage.ri_phys_footprint,
        cpu_ticks: usage.ri_user_time.saturating_add(usage.ri_system_time),
        start_ticks: usage.ri_proc_start_abstime,
    })
}

#[cfg(not(target_os = "macos"))]
fn read_pid(_pid: i32) -> Option<PidReading> {
    None
}

/// What `PROC_PIDTBSDINFO` says about one pid that the sampler needs.
#[derive(Clone, Copy, Default)]
struct BsdFacts {
    /// Controlling terminal device, or `None` without one.
    tty: Option<u32>,
    /// An exited process its parent has not reaped. Its rusage is stale, so
    /// it reads as zero.
    zombie: bool,
    /// Owned by the user Kriyon runs as.
    same_uid: bool,
    /// Process start (seconds, microseconds): with the pid, the key the
    /// environment cache is held under, so a reused pid is read afresh.
    start: (u64, u64),
}

#[cfg(target_os = "macos")]
fn read_bsd(pid: i32) -> Option<BsdFacts> {
    use libproc::bsd_info::BSDInfo;
    use libproc::proc_pid::pidinfo;
    /// `NODEV`: the process has no controlling terminal.
    const NO_TTY: u32 = u32::MAX;
    /// `SZOMB` from `<sys/proc.h>`.
    const ZOMBIE: u32 = 5;
    let info = pidinfo::<BSDInfo>(pid, 0).ok()?;
    // SAFETY: getuid takes no arguments and cannot fail.
    let uid = unsafe { libc::getuid() };
    Some(BsdFacts {
        tty: (info.e_tdev != NO_TTY && info.e_tdev != 0).then_some(info.e_tdev),
        zombie: info.pbi_status == ZOMBIE,
        same_uid: info.pbi_uid == uid,
        start: (info.pbi_start_tvsec, info.pbi_start_tvusec),
    })
}

/// A pid's [`SESSION_ENV`] value, read from its `KERN_PROCARGS2` (argv +
/// environment). Works for same-user processes without entitlements; `None`
/// when the process is gone, unreadable or doesn't carry the variable.
///
/// [`SESSION_ENV`]: kriyon_core::memory::SESSION_ENV
#[cfg(target_os = "macos")]
fn read_session_env(pid: i32) -> Option<String> {
    let mut argmax: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: `mib` names KERN_ARGMAX, whose value is one c_int, and `size`
    // is that buffer's length.
    let status = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&raw mut argmax).cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    let capacity = usize::try_from(argmax).ok().filter(|_| status == 0)?;
    let mut buf = vec![0_u8; capacity];
    let mut size = buf.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    // SAFETY: `buf` is writable for `size` bytes, and the kernel writes at
    // most that many, reporting the count back through `size`.
    let status = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return None;
    }
    buf.truncate(size);
    kriyon_core::memory::env_value(&buf, kriyon_core::memory::SESSION_ENV)
}

#[cfg(not(target_os = "macos"))]
fn read_session_env(_pid: i32) -> Option<String> {
    None
}

/// [`read_session_env`] results, by pid and start time. Reading another
/// process's environment is the costly step of a sweep, and a daemonized
/// process's environment doesn't change, so each process is read once.
type EnvCache = HashMap<(i32, (u64, u64)), Option<String>>;

fn env_cache() -> &'static parking_lot::Mutex<EnvCache> {
    static CACHE: std::sync::OnceLock<parking_lot::Mutex<EnvCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(parking_lot::Mutex::default)
}

#[cfg(not(target_os = "macos"))]
fn read_bsd(_pid: i32) -> Option<BsdFacts> {
    None
}

/// Sample every live session's [Session resources], cache the sweep on
/// [`AppState`], emit `session-resources`, and fire the budget warning when
/// due. Called from the background ticker; all locks are taken briefly and
/// never nested.
pub fn sample_and_emit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    let ids: Vec<SessionId> = {
        let sessions = state.sessions.lock();
        sessions.keys().cloned().collect()
    };
    if ids.is_empty() {
        return;
    }
    let Some(survey) = crate::status_rt::process_table() else {
        return; // No trustworthy sweep — keep the previous readings.
    };

    // Index the sweep once, then walk each session's tree exactly once.
    let tree = survey.tree();
    let ppid_trees: Vec<(String, Vec<i32>)> = ids
        .iter()
        .map(|id| (id.0.clone(), tree.tree_pids(&id.0)))
        .collect();

    // Processes that left the tree but kept the session's terminal, or that
    // daemonized but carry its env, still count. An unreadable pid just has
    // no tty and no env: never fail the sweep.
    let bsd: HashMap<i32, BsdFacts> = survey
        .rows()
        .iter()
        .map(|row| (row.pid, read_bsd(row.pid).unwrap_or_default()))
        .collect();
    let facts: Vec<ProcFacts> = survey
        .rows()
        .iter()
        .map(|row| ProcFacts {
            pid: row.pid,
            ppid: row.ppid,
            tty: bsd.get(&row.pid).and_then(|facts| facts.tty),
            same_uid: bsd.get(&row.pid).is_some_and(|facts| facts.same_uid),
        })
        .collect();
    let trees = {
        let mut cache = env_cache().lock();
        // Forget processes that are gone, so the cache can't grow unbounded.
        cache.retain(|(pid, start), _| bsd.get(pid).is_some_and(|facts| facts.start == *start));
        kriyon_core::memory::attribute(&ppid_trees, &facts, |pid| {
            let start = bsd.get(&pid).map(|facts| facts.start).unwrap_or_default();
            cache
                .entry((pid, start))
                .or_insert_with(|| read_session_env(pid))
                .clone()
        })
    };

    // One read per pid; `attribute` charges each pid to one session. Zombies
    // are skipped, so they read as zero.
    let mut now = ResourceSample {
        at_ticks: mach::now_ticks(),
        pids: HashMap::new(),
    };
    for pid in trees.iter().flat_map(|(_, pids)| pids) {
        if bsd.get(pid).is_some_and(|facts| facts.zombie) {
            continue;
        }
        if let Some(reading) = read_pid(*pid) {
            now.pids.insert(*pid, reading);
        }
    }

    let sweep = {
        let mut baseline = state.resource_baseline.lock();
        let sweep =
            kriyon_core::memory::fold_resources(&trees, &now, baseline.as_ref(), mach::timebase());
        *baseline = Some(now);
        sweep
    };
    state.memory.lock().clone_from(&sweep);
    let _ = app.emit(
        "session-resources",
        ResourcesUpdate {
            sessions: sweep
                .per_session
                .iter()
                .map(|(id, row)| (id.clone(), row.memory_mb))
                .collect(),
            cpu: sweep
                .per_session
                .iter()
                .filter_map(|(id, row)| row.cpu_pct.map(|cpu| (id.clone(), cpu)))
                .collect(),
            total_mb: sweep.total_mb,
            total_cpu_pct: sweep.total_cpu_pct,
        },
    );

    maybe_warn(app, &sweep);
}

/// Fire the over-budget notification when the pure policy says so. The
/// notification names the top sessions by footprint and clicking it focuses
/// the biggest one (the existing notification click-routing already focuses
/// the session id a notification carries).
fn maybe_warn<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    sweep: &kriyon_core::memory::ResourceSweep,
) {
    let state = app.state::<AppState>();
    let budget = *state.memory_budget.lock();
    let since = state
        .last_memory_warn
        .lock()
        .map(|at| at.elapsed().as_secs());
    if !kriyon_core::memory::should_warn(&budget, sweep.total_mb, since) {
        return;
    }

    let mut top: Vec<(&String, u64)> = sweep
        .per_session
        .iter()
        .map(|(id, row)| (id, row.memory_mb))
        .collect();
    top.sort_by_key(|(_, mb)| std::cmp::Reverse(*mb));
    let Some((top_id, _)) = top.first().copied() else {
        return;
    };
    let store = app.state::<crate::StoreState>();
    let names: Vec<String> = top
        .iter()
        .take(3)
        .map(|(id, mb)| {
            let title = {
                let store = store.0.lock();
                store
                    .session_identity(id)
                    .ok()
                    .flatten()
                    .map_or_else(|| (*id).clone(), |identity| identity.title)
            };
            format!("{title} ({})", format_mb(*mb))
        })
        .collect();

    let sound = *state.notify_sound.lock();
    crate::notify::show(
        app,
        top_id,
        "Sessions are using a lot of memory",
        &format!(
            "{} in use — budget is {}",
            format_mb(sweep.total_mb),
            format_mb(budget.budget_mb)
        ),
        &format!("Top: {}. Click to open the biggest.", names.join(", ")),
        sound,
    );
    *state.last_memory_warn.lock() = Some(Instant::now());
}

/// Human MB/GB label: whole MB below 1 GB, one decimal above.
fn format_mb(mb: u64) -> String {
    if mb >= 1024 {
        #[allow(clippy::cast_precision_loss)]
        let gb = mb as f64 / 1024.0;
        format!("{gb:.1} GB")
    } else {
        format!("{mb} MB")
    }
}

#[cfg(test)]
mod tests {
    use super::format_mb;

    #[cfg(target_os = "macos")]
    #[test]
    fn a_process_in_a_pty_reports_that_terminal_as_its_tty() {
        // The detached-process rule leans on e_tdev naming the session's PTY:
        // a child spawned into a fresh pty must report a tty, and not ours.
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let pair = native_pty_system()
            .openpty(PtySize::default())
            .expect("open a pty");
        let mut sleep = CommandBuilder::new("sleep");
        sleep.arg("5");
        let mut child = pair.slave.spawn_command(sleep).expect("spawn into the pty");
        let pid = i32::try_from(child.process_id().expect("child pid")).expect("pid fits");
        let mut tty = None;
        for _ in 0..50 {
            tty = super::read_bsd(pid).and_then(|facts| facts.tty);
            if tty.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let own = super::read_bsd(i32::try_from(std::process::id()).expect("pid fits"))
            .expect("own pid is readable");
        let _ = child.kill();
        assert!(tty.is_some(), "the pty child has a controlling tty");
        assert_ne!(tty, own.tty, "and it is the pty, not ours");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_childs_session_env_is_read_from_its_procargs() {
        // node, not /bin/sleep: macOS hides the environment of its own
        // platform binaries, but not of the node/python servers that daemonize
        // in practice. node is on PATH wherever `pnpm check` runs.
        let mut child = std::process::Command::new("node")
            .args(["-e", "setTimeout(() => {}, 5000)"])
            .env(kriyon_core::memory::SESSION_ENV, "sess-env-probe")
            .spawn()
            .expect("spawn sleep");
        let pid = i32::try_from(child.id()).expect("pid fits");
        let mut value = None;
        for _ in 0..50 {
            value = super::read_session_env(pid);
            if value.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(value.as_deref(), Some("sess-env-probe"));
        assert_eq!(super::read_session_env(i32::MAX), None, "no such pid");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cpu_ticks_convert_to_real_cpu_time() {
        // Spin ~100 ms of wall time on this thread, then check the converted
        // CPU delta is the right order of magnitude. Skipping the timebase on
        // Apple Silicon would read ~2 ms here (42x low).
        let pid = i32::try_from(std::process::id()).expect("pid fits");
        let before = super::read_pid(pid).expect("own pid is readable");
        let spin = std::time::Instant::now();
        let mut x: u64 = 0;
        while spin.elapsed() < std::time::Duration::from_millis(100) {
            x = std::hint::black_box(x.wrapping_add(1));
        }
        let after = super::read_pid(pid).expect("own pid is readable");
        assert_eq!(before.start_ticks, after.start_ticks, "same process");
        assert!(after.footprint_bytes > 0);
        let cpu_ns = super::mach::timebase().to_ns(after.cpu_ticks - before.cpu_ticks);
        assert!(
            (20_000_000..10_000_000_000).contains(&cpu_ns),
            "cpu delta {cpu_ns} ns"
        );
    }

    #[test]
    fn footprints_format_as_mb_below_a_gb_and_gb_above() {
        assert_eq!(format_mb(0), "0 MB");
        assert_eq!(format_mb(431), "431 MB");
        assert_eq!(format_mb(1024), "1.0 GB");
        assert_eq!(format_mb(6144), "6.0 GB");
        assert_eq!(format_mb(7370), "7.2 GB");
    }
}
