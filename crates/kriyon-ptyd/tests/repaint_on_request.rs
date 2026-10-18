//! A `Repaint` frame must make the daemon resend its screen snapshot on the
//! SAME connection. This backs the frontend's remount healing: a React remount
//! reuses the live socket (no reconnect, so no attach-time repaint), and its
//! fresh xterm starts blank — the client asks for the screen instead of relying
//! on never being remounted.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use kriyon_core::wire::{Frame, FrameDecoder};

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
                while let Some(frame) = dec.next_frame() {
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

/// Read and discard everything for `ms`, so the child is provably idle and all
/// prior output is off the socket before the repaint request.
fn drain_for(stream: &mut UnixStream, ms: u64) {
    let mut buf = [0u8; 4096];
    let start = Instant::now();
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("set read timeout");
    while start.elapsed() < Duration::from_millis(ms) {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
}

/// Connect to the daemon socket, retrying until it appears.
fn connect(path: &str) -> UnixStream {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(s) = UnixStream::connect(path) {
            return s;
        }
        assert!(Instant::now() < deadline, "daemon socket never appeared");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn repaint_request_resends_the_screen_on_the_same_connection() {
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket = dir.path().join("s.sock");
    let socket_str = socket.to_str().expect("utf8 socket path").to_string();

    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_kriyon-ptyd"))
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
        .env("PS1", "$ ")
        // Run from inside a Kriyon session, never serve (or end) its bridge.
        .env_remove("KRIYON_BRIDGE_SOCKET")
        .spawn()
        .expect("spawn daemon");

    let mut client = connect(&socket_str);
    client
        .write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");
    client
        .write_all(&Frame::Stdin(b"printf REPAINT_MARKER\n".to_vec()).encode())
        .expect("stdin");
    let seen = read_until(&mut client, "REPAINT_MARKER", Duration::from_secs(5));
    assert!(
        seen.contains("REPAINT_MARKER"),
        "client should see the marker live, got: {seen:?}"
    );

    // Idle the child and clear the pipe: anything read after this exists only
    // because the daemon chose to resend it.
    drain_for(&mut client, 500);

    client
        .write_all(&Frame::Repaint.encode())
        .expect("repaint request");
    let repainted = read_until(&mut client, "REPAINT_MARKER", Duration::from_secs(5));
    assert!(
        repainted.contains("REPAINT_MARKER"),
        "a Repaint frame must resend the screen snapshot, got: {repainted:?}"
    );

    client
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");
    let _ = child.wait();
}
