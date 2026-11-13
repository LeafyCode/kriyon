//! A `RequestHistory` frame gets the session's [Output history] back on the
//! same connection, as `History` frames closed by a `HistoryEnd`, including
//! output that has long scrolled off the screen.

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

/// Read frames until `HistoryEnd`, returning the `History` bytes.
fn read_history(stream: &mut UnixStream, timeout: Duration) -> Option<String> {
    let mut dec = FrameDecoder::new();
    let mut history = Vec::new();
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
                    match frame {
                        Frame::History(bytes) => history.extend(bytes),
                        Frame::HistoryEnd => {
                            return Some(String::from_utf8_lossy(&history).into_owned());
                        }
                        _ => {}
                    }
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    None
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
fn a_history_request_returns_output_that_scrolled_off_the_screen() {
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
        .env_remove("KRIYON_BRIDGE_SOCKET")
        .spawn()
        .expect("spawn daemon");

    let mut client = connect(&socket_str);
    client
        .write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");
    // The marker, then 200 lines that push it far off a 24-row screen.
    // `EARLY_%s` keeps the marker out of the shell's echo of the command.
    client
        .write_all(
            &Frame::Stdin(
                b"printf 'EARLY_%s\\n' MARKER; seq 1 200; printf 'DONE_%s\\n' X\n".to_vec(),
            )
            .encode(),
        )
        .expect("stdin");
    let seen = read_until(&mut client, "DONE_X", Duration::from_secs(5));
    assert!(
        seen.contains("DONE_X"),
        "the command never finished: {seen:?}"
    );

    client
        .write_all(&Frame::RequestHistory.encode())
        .expect("history request");
    let history = read_history(&mut client, Duration::from_secs(5))
        .expect("a history answer closed by HistoryEnd");
    assert!(
        history.contains("EARLY_MARKER"),
        "output that scrolled off the screen must be in the history"
    );

    client
        .write_all(&Frame::Shutdown.encode())
        .expect("shutdown");
    let _ = child.wait();
}
