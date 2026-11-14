//! A client that stops reading must never stall the session. The child keeps
//! running and its output keeps feeding the daemon's screen. When the client
//! reads again, it gets a fresh screen ([Skip ahead]) instead of the backlog.

// Drives a POSIX shell through the daemon; the Windows path is covered by
// `windows_daemon.rs`.
#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

use kriyon_core::wire::{Frame, FrameDecoder};

/// Read framed output until `needle` is seen or `timeout` elapses.
fn read_until(stream: &mut UnixStream, needle: &str, timeout: Duration) -> String {
    let mut dec = FrameDecoder::new();
    let mut acc = String::new();
    let mut buf = vec![0u8; 65536];
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
                    if let Frame::Output(bytes) | Frame::Screen(bytes) = frame {
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

fn wait_for_file(path: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn a_client_that_stops_reading_never_stalls_the_session() {
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket = dir.path().join("s.sock");
    let socket_str = socket.to_str().expect("utf8 socket path").to_string();
    let done = dir.path().join("flood-done");

    let mut daemon = std::process::Command::new(env!("CARGO_BIN_EXE_kriyon-ptyd"))
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
        .env_remove("KRIYON_BRIDGE_SOCKET")
        .spawn()
        .expect("spawn daemon");

    let mut client = connect(&socket_str);
    client
        .write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");
    // `AFTER_%s` keeps the marker out of the shell's echo of this line, so
    // only the command's output can show it.
    // About 16 MB of output, far more than the socket buffer and the client's
    // queue hold, then a file the test can see without reading the socket.
    let flood = format!(
        "head -c 16000000 /dev/zero | tr '\\0' x; printf '\\nAFTER_%s\\n' FLOOD; touch {}\n",
        done.display()
    );
    client
        .write_all(&Frame::Stdin(flood.into_bytes()).encode())
        .expect("stdin");

    // The client reads nothing. A daemon that waits on it stalls the child
    // within the first few hundred KB, and the file never appears.
    let finished = wait_for_file(&done, Duration::from_secs(30));

    // Typing still reaches the session while the client is stuck.
    let typed = dir.path().join("typed");
    client
        .write_all(&Frame::Stdin(format!("touch {}\n", typed.display()).into_bytes()).encode())
        .expect("stdin while stuck");
    let typed_arrived = wait_for_file(&typed, Duration::from_secs(10));

    // Resume reading: the client must catch up to the current screen.
    let seen = read_until(&mut client, "AFTER_FLOOD", Duration::from_secs(30));

    client
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");
    let _ = daemon.wait();

    assert!(
        finished,
        "the child stalled behind a client that stopped reading"
    );
    assert!(
        typed_arrived,
        "typing waited behind a client that stopped reading"
    );
    assert!(
        seen.contains("AFTER_FLOOD"),
        "a client that reads again must get the current screen"
    );
}
