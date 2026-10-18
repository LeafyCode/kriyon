//! The [Detached lease]: a daemon nobody is attached to stops itself once its
//! terminal has been silent for the whole lease — and only then.
//!
//! The lease is what bounds a session left to finish its turn at quit, and the
//! survivor of a crash nobody relaunched after. These tests run with a
//! two-second lease (`--detached-ttl-secs`); the shipped default is 30 minutes.

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use kriyon_core::wire::Frame;

const LEASE_SECS: u64 = 2;

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
    fn exited(&mut self) -> bool {
        self.0.try_wait().expect("poll daemon").is_some()
    }

    fn exits_within(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.exited() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

fn spawn_daemon(socket: &str) -> Daemon {
    let child = Command::new(env!("CARGO_BIN_EXE_kriyon-ptyd"))
        .args([
            "--socket",
            socket,
            "--id",
            "test",
            "--cwd",
            "/",
            "--shell",
            "/bin/sh",
            "--detached-ttl-secs",
            &LEASE_SECS.to_string(),
        ])
        .env("PS1", "")
        .spawn()
        .expect("spawn daemon");
    Daemon(child)
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

fn attach(socket: &str) -> UnixStream {
    let mut client = connect(socket);
    client
        .write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");
    client
}

fn type_line(stream: &mut UnixStream, line: &str) {
    stream
        .write_all(&Frame::Stdin(format!("{line}\n").into_bytes()).encode())
        .expect("stdin");
}

#[test]
fn a_silent_daemon_nobody_returns_to_stops_itself() {
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket_path = dir.path().join("s.sock");
    let socket = socket_path.to_str().expect("utf8 socket path");
    let mut daemon = spawn_daemon(socket);

    // The app goes away — a quit that left this session to finish, or a crash.
    drop(attach(socket));

    assert!(
        daemon.exits_within(Duration::from_secs(LEASE_SECS + 6)),
        "a detached, silent daemon must not live forever"
    );
    assert!(
        !socket_path.exists(),
        "socket should be removed on the way out"
    );
}

#[test]
fn an_attached_daemon_outlives_any_number_of_leases() {
    // While the app holds the daemon, an idle session is the app's business.
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket = dir.path().join("s.sock");
    let socket = socket.to_str().expect("utf8 socket path");
    let mut daemon = spawn_daemon(socket);
    let mut client = attach(socket);

    std::thread::sleep(Duration::from_secs(LEASE_SECS * 2 + 1));
    assert!(
        !daemon.exited(),
        "the lease must not run while a client is attached"
    );

    client
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");
    let _ = daemon.0.wait();
}

#[test]
fn a_detached_daemon_that_keeps_printing_is_left_to_work() {
    // Left to finish its turn: output is the proof of work, however long it runs.
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket = dir.path().join("s.sock");
    let socket = socket.to_str().expect("utf8 socket path");
    let mut daemon = spawn_daemon(socket);
    let mut client = attach(socket);
    type_line(&mut client, "while true; do echo working; sleep 0.5; done");
    std::thread::sleep(Duration::from_millis(500));
    drop(client);

    std::thread::sleep(Duration::from_secs(LEASE_SECS * 2 + 1));
    assert!(
        !daemon.exited(),
        "a daemon still producing output is still working"
    );

    let mut client = attach(socket);
    client
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");
    let _ = daemon.0.wait();
}
