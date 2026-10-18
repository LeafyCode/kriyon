//! A daemon takes its [Companion bridge] socket with it when it ends.
//!
//! It used to remove only its session socket, so every session ever run with
//! the companion on left a dead `<id>.b` in the run dir for good.

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use kriyon_core::wire::Frame;

/// Kills its daemon on drop, so a failed assertion cannot leak one — a leaked
/// daemon inherits the test's output pipe and hangs whatever is reading it.
struct Daemon(std::process::Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn wait_for(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "{} never appeared",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn the_bridge_socket_goes_when_the_daemon_stops() {
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket = dir.path().join("test.sock");
    let bridge = dir.path().join("test.b");

    let mut daemon = Daemon(
        Command::new(env!("CARGO_BIN_EXE_kriyon-ptyd"))
            .args([
                "--id", "test", "--cwd", "/", "--shell", "/bin/sh", "--socket",
            ])
            .arg(&socket)
            .env("PS1", "")
            .env("HOME", dir.path())
            .env("KRIYON_BRIDGE_SOCKET", &bridge)
            .spawn()
            .expect("spawn daemon"),
    );
    wait_for(&socket);
    wait_for(&bridge);

    UnixStream::connect(&socket)
        .expect("connect")
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");
    let _ = daemon.0.wait();

    assert!(!socket.exists(), "session socket left behind");
    assert!(!bridge.exists(), "bridge socket left behind");
}

/// A test or nested daemon handed a live session's bridge path can't bind it,
/// and must leave it alone when it ends: the session's companion posts there.
#[test]
fn a_daemon_leaves_a_bridge_socket_it_did_not_bind() {
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket = dir.path().join("test.sock");
    let bridge = dir.path().join("test.b");
    // The session's own daemon, serving the bridge.
    let _live = std::os::unix::net::UnixListener::bind(&bridge).expect("live bridge");

    let mut daemon = Daemon(
        Command::new(env!("CARGO_BIN_EXE_kriyon-ptyd"))
            .args([
                "--id", "test", "--cwd", "/", "--shell", "/bin/sh", "--socket",
            ])
            .arg(&socket)
            .env("PS1", "")
            .env("HOME", dir.path())
            .env("KRIYON_BRIDGE_SOCKET", &bridge)
            .spawn()
            .expect("spawn daemon"),
    );
    wait_for(&socket);

    UnixStream::connect(&socket)
        .expect("connect")
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");
    let _ = daemon.0.wait();

    assert!(!socket.exists(), "session socket left behind");
    assert!(
        UnixStream::connect(&bridge).is_ok(),
        "the live bridge socket was removed"
    );
}
