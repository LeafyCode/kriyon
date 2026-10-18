//! A second daemon must never take a socket path a live daemon still serves.
//!
//! The daemon used to unlink whatever sat at its socket path before binding.
//! Pointed at a *live* daemon's path, that stranded the first daemon for good:
//! still running, still hosting a `claude`, but with no path left that anything
//! could connect to — a daemon left orphaned forever because it was busy.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::process::Command;
use std::time::{Duration, Instant};

use kriyon_core::wire::{Frame, FrameDecoder};

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

fn read_until(stream: &mut UnixStream, needle: &str, timeout: Duration) -> String {
    let mut decoder = FrameDecoder::new();
    let mut seen = String::new();
    let mut buf = [0u8; 4096];
    let start = Instant::now();
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .expect("set read timeout");
    while start.elapsed() < timeout && !seen.contains(needle) {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                decoder.push(&buf[..n]);
                while let Some(frame) = decoder.next_frame() {
                    if let Frame::Output(bytes) = frame {
                        seen.push_str(&String::from_utf8_lossy(&bytes));
                    }
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    seen
}

/// Kills its daemon on drop, so a failed assertion cannot leak one — a leaked
/// daemon inherits the test's output pipe and hangs whatever is reading it.
struct Daemon(std::process::Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn daemon_command(socket: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kriyon-ptyd"));
    command
        .args([
            "--socket", socket, "--id", "test", "--cwd", "/", "--shell", "/bin/sh",
        ])
        .env("PS1", "");
    command
}

#[test]
fn a_second_daemon_backs_off_and_the_first_stays_reachable() {
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket = dir.path().join("s.sock");
    let socket = socket.to_str().expect("utf8 socket path");

    let mut first = Daemon(daemon_command(socket).spawn().expect("spawn first"));
    drop(connect(socket));

    // Bounded: a daemon that wrongly takes the path never exits on its own, and
    // the test must fail rather than hang.
    let mut second = Daemon(
        daemon_command(socket)
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn second"),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let refused = loop {
        if let Some(status) = second.0.try_wait().expect("poll second") {
            break !status.success();
        }
        if Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(
        refused,
        "the second daemon must refuse a live daemon's path"
    );

    // The first daemon's socket path still leads to it.
    let mut client = connect(socket);
    client
        .write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");
    client
        .write_all(&Frame::Stdin(b"printf STILL_HERE\n".to_vec()).encode())
        .expect("stdin");
    let seen = read_until(&mut client, "STILL_HERE", Duration::from_secs(5));
    assert!(
        seen.contains("STILL_HERE"),
        "first daemon lost, got: {seen:?}"
    );

    client
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");
    let _ = first.0.wait();
}

#[test]
fn a_stale_socket_file_is_still_cleared() {
    // An unclean exit leaves the file behind with nobody listening. That one
    // must still be replaced, or a crashed session could never be reopened.
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket_path = dir.path().join("s.sock");
    let socket = socket_path.to_str().expect("utf8 socket path");
    drop(std::os::unix::net::UnixListener::bind(&socket_path).expect("bind then abandon"));
    assert!(socket_path.exists());

    let mut daemon = Daemon(daemon_command(socket).spawn().expect("spawn"));
    let mut client = connect(socket);
    client
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");
    let _ = daemon.0.wait();
}
