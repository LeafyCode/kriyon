//! Reattaching to an *idle* session must repaint the current screen. The daemon
//! keeps a server-side terminal-state snapshot (a headless VT emulator fed by all
//! PTY output), so a fresh client that connects while the child has produced
//! nothing since the last detach still sees the on-screen contents — the
//! blank-past-session bug. Without the snapshot, an idle child's detached-output
//! buffer is empty and the reattaching client renders a blank terminal.

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

/// Read and discard everything for `ms`, so all pending child output is drained
/// off the socket (and thus never lands in the detached ring) before detaching.
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
fn reattach_repaints_current_screen_of_idle_child() {
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

    // First client: print a marker that stays on screen, then confirm we saw it.
    let mut c1 = connect(&socket_str);
    c1.write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach 1");
    c1.write_all(&Frame::Stdin(b"printf SNAPSHOT_MARKER\n".to_vec()).encode())
        .expect("stdin 1");
    let seen = read_until(&mut c1, "SNAPSHOT_MARKER", Duration::from_secs(5));
    assert!(
        seen.contains("SNAPSHOT_MARKER"),
        "first client should see the marker, got: {seen:?}"
    );

    // Fully drain c1 so every byte the child produced is consumed off the socket
    // (nothing left to spill into the detached ring), then detach. The child is
    // now provably idle: it produces NOTHING while detached, so the old
    // detached-output ring is empty and a reattach would render blank.
    drain_for(&mut c1, 500);
    drop(c1);
    std::thread::sleep(Duration::from_millis(300));

    // Reattach and read the snapshot the daemon pushes on connect — WITHOUT
    // sending any input that could nudge the child into redrawing. The marker
    // must be present, reconstructed from server-side screen state.
    let mut c2 = connect(&socket_str);
    let snapshot = read_until(&mut c2, "SNAPSHOT_MARKER", Duration::from_secs(5));
    assert!(
        snapshot.contains("SNAPSHOT_MARKER"),
        "reattaching to an idle child must repaint the current screen, got: {snapshot:?}"
    );

    c2.write_all(&Frame::Shutdown.encode()).expect("shutdown");
    let _ = child.wait();
}
