//! A [Tree stop] leaves nothing behind. Signalling only the shell — what the
//! daemon used to do — leaks every process that ignores SIGHUP or sits in its
//! own process group: they are reparented to launchd and run forever, holding
//! memory and ports. These tests host exactly those processes and assert that
//! none outlives the daemon, on both exit paths.

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use kriyon_core::wire::Frame;

/// A `sleep` duration no other process on the machine uses, so a `ps` match is
/// unambiguously ours even with tests running in parallel.
fn unique_sleep(slot: u32) -> String {
    format!("{}", 7_000_000 + std::process::id() * 10 + slot)
}

/// Pids of every live process whose command line contains `needle`.
fn pids_matching(needle: &str) -> Vec<i32> {
    let output = Command::new("ps")
        .args(["-axww", "-o", "pid=,args="])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.contains(needle))
        .filter_map(|line| line.split_whitespace().next()?.parse().ok())
        .collect()
}

fn wait_for(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn connect(path: &str) -> UnixStream {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(stream) = UnixStream::connect(path) {
            return stream;
        }
        assert!(Instant::now() < deadline, "daemon socket never appeared");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Kills its daemon on drop, so a failed assertion cannot leak one — a leaked
/// daemon inherits the test's output pipe and hangs whatever is reading it.
struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Daemon {
    /// Wait for the daemon to exit, but never forever: a stop that regresses into
    /// a hang must fail the test, not wedge the run.
    fn exits_within(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.0.try_wait().expect("poll daemon").is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    }
}

/// Generous next to the ~2.5 s worst case (grace + force window), so a loaded
/// machine running several `ps` sweeps does not flake.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

fn spawn_daemon(socket: &str) -> Daemon {
    spawn_daemon_with_bridge(socket, None)
}

/// `bridge`: the [Companion bridge] socket to serve, as the app asks for when
/// the companion is on. `None` clears it, so a test run from inside a Kriyon
/// session never inherits that session's.
fn spawn_daemon_with_bridge(socket: &str, bridge: Option<&std::path::Path>) -> Daemon {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kriyon-ptyd"));
    command
        .args([
            "--socket", socket, "--id", "test", "--cwd", "/", "--shell", "/bin/sh",
        ])
        .env("PS1", "")
        .env_remove("KRIYON_BRIDGE_SOCKET");
    if let Some(bridge) = bridge {
        command
            .env("KRIYON_BRIDGE_SOCKET", bridge)
            .env("HOME", bridge.parent().expect("bridge dir"));
    }
    Daemon(command.spawn().expect("spawn daemon"))
}

fn type_line(stream: &mut UnixStream, line: &str) {
    stream
        .write_all(&Frame::Stdin(format!("{line}\n").into_bytes()).encode())
        .expect("stdin");
}

/// Never let a failing assertion leak the very processes under test.
struct KillOnDrop(Vec<String>);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        for needle in &self.0 {
            for pid in pids_matching(needle) {
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
            }
        }
    }
}

#[test]
fn shutdown_ends_processes_that_ignore_hangup_and_background_jobs() {
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket = dir.path().join("s.sock");
    let socket = socket.to_str().expect("utf8 socket path");
    let background = format!("sleep {}", unique_sleep(1));
    let stubborn = format!("sleep {}", unique_sleep(2));
    let _cleanup = KillOnDrop(vec![background.clone(), stubborn.clone()]);

    let mut daemon = spawn_daemon(socket);
    let mut client = connect(socket);
    client
        .write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");

    // A background job in its own process group: the kernel's hangup, which
    // only reaches the foreground group, never touches it.
    type_line(
        &mut client,
        &format!("nohup {background} >/dev/null 2>&1 &"),
    );
    // A foreground process that ignores both polite signals (ignored
    // dispositions are inherited across exec), so only SIGKILL can end it.
    type_line(
        &mut client,
        &format!("sh -c 'trap \"\" HUP TERM; {stubborn}'"),
    );
    wait_for("both processes to start", Duration::from_secs(5), || {
        !pids_matching(&background).is_empty() && !pids_matching(&stubborn).is_empty()
    });

    client
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");
    assert!(
        daemon.exits_within(STOP_TIMEOUT),
        "the stop is bounded: polite, a short grace, then force"
    );

    assert_eq!(pids_matching(&background), Vec::<i32>::new());
    assert_eq!(pids_matching(&stubborn), Vec::<i32>::new());
}

#[test]
fn a_terminated_daemon_stops_its_tree_instead_of_orphaning_it() {
    // The reaper's fallback for a daemon whose socket is dead, and what a user
    // running `kill <pid>` gets: SIGTERM must mean "stop everything you host",
    // not "die and leave it all to launchd".
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket_path = dir.path().join("s.sock");
    let socket = socket_path.to_str().expect("utf8 socket path");
    let background = format!("sleep {}", unique_sleep(4));
    let _cleanup = KillOnDrop(vec![background.clone()]);

    let mut daemon = spawn_daemon(socket);
    let mut client = connect(socket);
    client
        .write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");
    type_line(
        &mut client,
        &format!("nohup {background} >/dev/null 2>&1 &"),
    );
    wait_for(
        "the background job to start",
        Duration::from_secs(5),
        || !pids_matching(&background).is_empty(),
    );

    let _ = Command::new("kill")
        .args(["-TERM", &daemon.0.id().to_string()])
        .status();
    assert!(
        daemon.exits_within(STOP_TIMEOUT),
        "SIGTERM must end the daemon"
    );

    assert_eq!(pids_matching(&background), Vec::<i32>::new());
    assert!(
        !socket_path.exists(),
        "socket should be removed on the way out"
    );
}

#[test]
fn a_terminated_daemon_with_the_companion_on_still_stops_its_tree() {
    // The bridge thread used to start before the stop signals were blocked, so
    // a SIGTERM could land on it and kill the daemon outright — leaving the
    // shell, `claude` and every background job to launchd.
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket_path = dir.path().join("s.sock");
    let socket = socket_path.to_str().expect("utf8 socket path");
    let bridge = dir.path().join("s.b");
    let background = format!("sleep {}", unique_sleep(6));
    let _cleanup = KillOnDrop(vec![background.clone()]);

    let mut daemon = spawn_daemon_with_bridge(socket, Some(&bridge));
    let mut client = connect(socket);
    client
        .write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");
    wait_for("the bridge socket", Duration::from_secs(5), || {
        bridge.exists()
    });
    type_line(
        &mut client,
        &format!("nohup {background} >/dev/null 2>&1 &"),
    );
    wait_for(
        "the background job to start",
        Duration::from_secs(5),
        || !pids_matching(&background).is_empty(),
    );

    let _ = Command::new("kill")
        .args(["-TERM", &daemon.0.id().to_string()])
        .status();
    assert!(
        daemon.exits_within(STOP_TIMEOUT),
        "SIGTERM must end the daemon"
    );

    assert_eq!(pids_matching(&background), Vec::<i32>::new());
}

#[test]
fn a_stopping_daemon_is_unreachable_before_its_tree_is_gone() {
    // A stop can take seconds. If the socket stayed connectable through it, a
    // quick quit-and-relaunch would reattach to a daemon that is already dying,
    // skip launching claude ("reattached"), and be left with a dead pane.
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket_path = dir.path().join("s.sock");
    let socket = socket_path.to_str().expect("utf8 socket path");
    let stubborn = format!("sleep {}", unique_sleep(5));
    let _cleanup = KillOnDrop(vec![stubborn.clone()]);

    let mut daemon = spawn_daemon(socket);
    let mut client = connect(socket);
    client
        .write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");
    // Ignores both polite signals, so the stop runs its full grace period.
    type_line(
        &mut client,
        &format!("sh -c 'trap \"\" HUP TERM; {stubborn}'"),
    );
    wait_for(
        "the stubborn process to start",
        Duration::from_secs(5),
        || !pids_matching(&stubborn).is_empty(),
    );

    client
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");

    // Well inside the grace period: the daemon is still alive and still
    // stopping, but nothing can reach it any more.
    wait_for("the socket to be unlinked", Duration::from_secs(1), || {
        !socket_path.exists()
    });
    assert!(
        daemon.0.try_wait().expect("poll daemon").is_none(),
        "the daemon should still be mid-stop when its socket disappears"
    );
    assert!(UnixStream::connect(socket).is_err());

    assert!(daemon.exits_within(STOP_TIMEOUT));
    assert_eq!(pids_matching(&stubborn), Vec::<i32>::new());
}

#[test]
fn a_shutdown_from_a_client_that_hangs_up_at_once_still_lands() {
    // How the app closes a session it never attached to this run: connect, write
    // the one frame, hang up. There is no `Attach`, and the connection is gone
    // before the daemon reads it — the frame must still be honoured. While
    // another client holds the daemon's single slot, the connection waits in the
    // accept backlog and the frame with it.
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket_path = dir.path().join("s.sock");
    let socket = socket_path.to_str().expect("utf8 socket path");

    let mut daemon = spawn_daemon(socket);
    let holder = connect(socket);

    let mut passer_by = connect(socket);
    passer_by
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");
    drop(passer_by);

    // The slot frees up — as when a crashed app's connection is torn down.
    drop(holder);

    let deadline = Instant::now() + Duration::from_secs(8);
    while daemon.0.try_wait().expect("poll daemon").is_none() {
        assert!(
            Instant::now() < deadline,
            "the daemon never honoured the frame"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !socket_path.exists(),
        "socket should be removed on the way out"
    );
}

#[test]
fn a_shell_that_exits_on_its_own_takes_its_background_jobs_with_it() {
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket = dir.path().join("s.sock");
    let socket = socket.to_str().expect("utf8 socket path");
    let background = format!("sleep {}", unique_sleep(3));
    let _cleanup = KillOnDrop(vec![background.clone()]);

    let mut daemon = spawn_daemon(socket);
    let mut client = connect(socket);
    client
        .write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");

    type_line(
        &mut client,
        &format!("nohup {background} >/dev/null 2>&1 &"),
    );
    wait_for(
        "the background job to start",
        Duration::from_secs(5),
        || !pids_matching(&background).is_empty(),
    );

    // The shell leaves first, so its job is reparented to launchd before the
    // daemon ever looks: only the kernel session still ties it to us.
    type_line(&mut client, "exit");
    assert!(
        daemon.exits_within(STOP_TIMEOUT),
        "a daemon whose shell exited must follow it"
    );

    assert_eq!(pids_matching(&background), Vec::<i32>::new());
}
