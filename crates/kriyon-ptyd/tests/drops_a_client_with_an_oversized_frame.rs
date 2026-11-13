//! A client that announces a frame longer than the protocol allows is cut off,
//! and the session carries on for the next client. Before the limit existed the
//! daemon waited for the whole frame, buffering everything the client sent.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use kriyon_core::wire::{Frame, FrameDecoder};

/// How long to wait for something that must happen eventually. A passing run
/// takes well under a second; a loaded machine can take several.
const PATIENCE: Duration = Duration::from_secs(30);

/// Ends the daemon when the test does, a failed assertion included, so a
/// failure never leaves one behind.
struct Daemon(std::process::Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Read framed output until `needle` is seen or `timeout` elapses.
fn read_until(stream: &mut UnixStream, needle: &str, timeout: Duration) -> String {
    let mut dec = FrameDecoder::new();
    let mut acc = String::new();
    let mut buf = [0u8; 4096];
    let start = Instant::now();
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .expect("set read timeout");
    while start.elapsed() < timeout {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                dec.push(&buf[..n]);
                while let Ok(Some(frame)) = dec.next_frame() {
                    if let Frame::Output(bytes) = frame {
                        acc.push_str(&String::from_utf8_lossy(&bytes));
                    }
                }
                if acc.contains(needle) {
                    return acc;
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    acc
}

/// Whether the daemon closes `stream` within `timeout`.
fn closed_within(stream: &mut UnixStream, timeout: Duration) -> bool {
    let mut buf = [0u8; 4096];
    let start = Instant::now();
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .expect("set read timeout");
    while start.elapsed() < timeout {
        match stream.read(&mut buf) {
            Ok(0) => return true,
            Ok(_) => {}
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => return true,
        }
    }
    false
}

/// Connect to the daemon socket, retrying until it appears.
fn connect(path: &str) -> UnixStream {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Ok(s) = UnixStream::connect(path) {
            return s;
        }
        assert!(Instant::now() < deadline, "daemon socket never appeared");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn an_oversized_frame_ends_that_client_and_not_the_session() {
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket = dir.path().join("s.sock");
    let socket_str = socket.to_str().expect("utf8 socket path").to_string();

    let child = std::process::Command::new(env!("CARGO_BIN_EXE_kriyon-ptyd"))
        .args([
            "--socket",
            &socket_str,
            "--id",
            "test",
            "--cwd",
            "/",
            "--shell",
            "/bin/sh",
        ])
        .env("PS1", "")
        // Run from inside a Kriyon session, never serve (or end) its bridge.
        .env_remove("KRIYON_BRIDGE_SOCKET")
        .spawn()
        .expect("spawn daemon");
    let _daemon = Daemon(child);

    let mut bad = connect(&socket_str);
    bad.write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");
    // A Stdin header (tag 1) announcing 4 GiB of payload that never comes.
    bad.write_all(&[1, 0xFF, 0xFF, 0xFF, 0xFF]).expect("header");
    // The bound only catches a daemon that never closes it; how fast it does
    // depends on the machine's load, so it is generous.
    assert!(
        closed_within(&mut bad, PATIENCE),
        "the daemon kept waiting for a frame it can never finish"
    );

    let mut next = connect(&socket_str);
    next.write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach next");
    next.write_all(&Frame::Stdin(b"printf STILL_ALIVE\n".to_vec()).encode())
        .expect("stdin next");
    let seen = read_until(&mut next, "STILL_ALIVE", PATIENCE);
    assert!(
        seen.contains("STILL_ALIVE"),
        "the session should serve the next client, got: {seen:?}"
    );
}
