//! Only the session's own `claude` speaks for it (ADR-0039): the one holding
//! the foreground of the session's terminal. Run as Claude Code runs the
//! hook, in the foreground of a fresh terminal (`script(1)` gives its child
//! a new pty), with `CLAUDE_PID` that process and `KRIYON_TTY` its terminal
//! or another.

#![cfg(target_os = "macos")]

use std::path::Path;

/// Whether a `Stop` was recorded when the hook ran as the foreground of a
/// terminal, `KRIYON_TTY` naming that terminal or `other_tty`.
fn recorded_on_a_terminal(other_tty: Option<&str>) -> bool {
    let home = tempfile::tempdir().expect("home");
    let payload = home.path().join("payload.json");
    std::fs::write(&payload, r#"{"hook_event_name":"Stop","session_id":"c-1"}"#).expect("payload");
    let tty = other_tty.map_or_else(|| "$(tty)".to_string(), str::to_string);
    let inner = format!(
        "CLAUDE_PID=$$ KRIYON_TTY={tty} exec '{}' event < '{}'",
        env!("CARGO_BIN_EXE_kriyon-hook"),
        payload.display()
    );
    let status = std::process::Command::new("script")
        .args(["-q", "/dev/null", "sh", "-c", &inner])
        .env("HOME", home.path())
        .env("KRIYON_SESSION", "sess-1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .status()
        .expect("runs script(1)");
    assert!(status.success(), "the hook never fails Claude");
    Path::new(&home.path().join(".claude/kriyon/events/sess-1.jsonl")).exists()
}

#[test]
fn the_claude_holding_the_session_terminal_is_recorded() {
    assert!(recorded_on_a_terminal(None));
}

#[test]
fn a_claude_holding_some_other_terminal_is_dropped() {
    assert!(!recorded_on_a_terminal(Some("/dev/ttys999")));
}

#[test]
fn a_session_id_that_could_name_another_path_is_dropped() {
    let home = tempfile::tempdir().expect("home");
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_kriyon-hook"))
        .arg("event")
        .env("HOME", home.path())
        .env("KRIYON_SESSION", "../escape")
        .env_remove("KRIYON_TTY")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .expect("runs");
    {
        use std::io::Write as _;
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(br#"{"hook_event_name":"Stop"}"#)
            .expect("feeds");
    }
    assert!(child.wait().expect("waits").success());
    assert!(!home.path().join(".claude/kriyon/escape.jsonl").exists());
    assert!(!home.path().join(".claude/kriyon/events").exists());
}
