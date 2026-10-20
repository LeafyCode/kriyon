//! The daemon keeps the child alive across a client disconnect (simulating an
//! app crash) and a fresh client can reattach and drive the same child — the
//! automated proxy for the plan's `v-crash` acceptance test.

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
fn child_survives_client_disconnect_and_reattach() {
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
        .env("PS1", "")
        // Run from inside a Kriyon session, never serve (or end) its bridge.
        .env_remove("KRIYON_BRIDGE_SOCKET")
        .spawn()
        .expect("spawn daemon");

    // First client: attach, run a marker, confirm we see it.
    let mut c1 = connect(&socket_str);
    c1.write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach 1");
    c1.write_all(&Frame::Stdin(b"printf MARK_ONE\n".to_vec()).encode())
        .expect("stdin 1");
    let seen = read_until(&mut c1, "MARK_ONE", Duration::from_secs(5));
    assert!(
        seen.contains("MARK_ONE"),
        "first client should see output, got: {seen:?}"
    );

    // Simulate an app crash: drop the client connection entirely.
    drop(c1);
    std::thread::sleep(Duration::from_millis(300));

    // Reattach with a fresh client: the SAME shell child is still alive.
    let mut c2 = connect(&socket_str);
    c2.write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach 2");
    c2.write_all(&Frame::Stdin(b"printf MARK_TWO\n".to_vec()).encode())
        .expect("stdin 2");
    let seen = read_until(&mut c2, "MARK_TWO", Duration::from_secs(5));
    assert!(
        seen.contains("MARK_TWO"),
        "reattached client should drive the same child, got: {seen:?}"
    );

    // Shut down cleanly; the daemon exits and removes its socket.
    c2.write_all(&Frame::Shutdown.encode()).expect("shutdown");
    let _ = child.wait();
    assert!(!socket.exists(), "socket should be removed on shutdown");
}
