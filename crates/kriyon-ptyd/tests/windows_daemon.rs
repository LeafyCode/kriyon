//! The daemon on Windows, end to end: it serves a `cmd.exe` over its socket,
//! keeps it across a client disconnect, repaints a reattaching client, and a
//! `Shutdown` ends the shell and everything it started.

#![cfg(windows)]

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use kriyon_core::uds::UnixStream;
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

fn connect(path: &std::path::Path) -> UnixStream {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(s) = UnixStream::connect(path) {
            return s;
        }
        assert!(Instant::now() < deadline, "daemon socket never appeared");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Whether any process's command line contains `marker`.
fn process_running(marker: &str) -> bool {
    let out = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "@(Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{marker}*' -and $_.Name -eq 'ping.exe' }}).Count"
            ),
        ])
        .output()
        .expect("powershell runs");
    String::from_utf8_lossy(&out.stdout).trim() != "0"
}

#[test]
fn serves_reattaches_and_stops_the_whole_tree() {
    let dir = tempfile::tempdir().expect("tmp dir");
    let socket = dir.path().join("s.sock");
    let cwd = dir.path().to_string_lossy().into_owned();

    let mut daemon = std::process::Command::new(env!("CARGO_BIN_EXE_kriyon-ptyd"))
        .arg("--socket")
        .arg(&socket)
        .args(["--id", "wintest", "--cwd", &cwd, "--shell", "cmd.exe"])
        .env_remove("KRIYON_BRIDGE_SOCKET")
        .spawn()
        .expect("spawn daemon");

    // First client: attach and run a marker (`^` escapes nothing, so only
    // the output — never the echoed command — reads as the marker).
    let mut c1 = connect(&socket);
    c1.write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");
    c1.write_all(&Frame::Stdin(b"echo FIRST^MARK\r".to_vec()).encode())
        .expect("stdin");
    let seen = read_until(&mut c1, "FIRSTMARK", Duration::from_secs(15));
    assert!(seen.contains("FIRSTMARK"), "first client output: {seen:?}");

    // Start a long child the stop must take down with the shell.
    let marker = "127.0.0.42";
    c1.write_all(&Frame::Stdin(format!("ping -n 120 {marker} >NUL\r").into_bytes()).encode())
        .expect("stdin");
    let deadline = Instant::now() + Duration::from_secs(15);
    while !process_running(marker) {
        assert!(Instant::now() < deadline, "the child never started");
        std::thread::sleep(Duration::from_millis(200));
    }

    // Drop the client (an app crash): the shell lives on.
    drop(c1);
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        daemon.try_wait().expect("try_wait").is_none(),
        "daemon outlives its client"
    );

    // A new client is repainted from the screen the daemon kept.
    let mut c2 = connect(&socket);
    c2.write_all(&Frame::Attach { cols: 80, rows: 24 }.encode())
        .expect("attach");
    let repaint = read_until(&mut c2, "FIRSTMARK", Duration::from_secs(10));
    assert!(
        repaint.contains("FIRSTMARK"),
        "reattach repaint: {repaint:?}"
    );

    // Shutdown ends the daemon, its shell and the child.
    c2.write_all(&Frame::Shutdown.encode()).expect("shutdown");
    let deadline = Instant::now() + Duration::from_secs(10);
    while daemon.try_wait().expect("try_wait").is_none() {
        assert!(Instant::now() < deadline, "daemon did not exit on Shutdown");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !process_running(marker),
        "the shell's child outlived the stop"
    );
    assert!(
        !socket.exists(),
        "the socket file is removed on the way out"
    );
}
