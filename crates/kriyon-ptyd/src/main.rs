//! `kriyon-ptyd` — the per-session out-of-process PTY daemon. One instance owns
//! one PTY + child shell and serves one app client at a time over a Unix socket,
//! so a Kriyon session survives an app crash and resumes on reattach.

mod bridge;
mod pty;
mod server;
mod tree_stop;

use std::collections::HashMap;
use std::path::PathBuf;

use kriyon_core::session::{SessionId, SpawnSpec};

/// How long a daemon nobody is attached to tolerates a silent terminal before
/// it stops itself. Half an hour: long enough that a crash-and-relaunch, a
/// restart for an update, or a long think between tool calls never comes close;
/// short enough that a forgotten session gives its memory back the same day.
const DEFAULT_DETACHED_TTL: std::time::Duration = std::time::Duration::from_mins(30);

/// Read the value following `flag` in `args`, if present.
fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn main() {
    // A panic on any thread ends the daemon the same way everything else does:
    // by a [Tree stop]. Left to the default, a panicking reaper thread would die
    // quietly (no more shell-death or lease handling), and a panicking main
    // thread would exit with the PTY's whole tree still running.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        pty::emergency_stop();
        std::process::exit(101);
    }));

    let args: Vec<String> = std::env::args().collect();
    let Some(socket) = arg(&args, "--socket") else {
        eprintln!("kriyon-ptyd: --socket required");
        std::process::exit(2);
    };
    let Some(id) = arg(&args, "--id") else {
        eprintln!("kriyon-ptyd: --id required");
        std::process::exit(2);
    };
    let cwd = arg(&args, "--cwd").unwrap_or_default();
    let shell = arg(&args, "--shell")
        .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));

    // The daemon inherits the environment the app set for it (ZDOTDIR etc. are
    // passed through the spawn), so the spec carries no extra per-key env here.
    let spec = SpawnSpec {
        cwd,
        shell,
        env: HashMap::new(),
    };

    // The [Detached lease]. Overridable so tests need not wait half an hour; the
    // app never passes it, so every real daemon runs with the default.
    let detached_ttl = arg(&args, "--detached-ttl-secs")
        .and_then(|secs| secs.parse().ok())
        .map_or(DEFAULT_DETACHED_TTL, std::time::Duration::from_secs);

    // Before the first thread (the bridge's), so every thread inherits the mask.
    let stop_signals = server::block_stop_signals();
    bridge::spawn(&id);
    if let Err(e) = server::run(
        &PathBuf::from(socket),
        SessionId(id),
        &spec,
        detached_ttl,
        stop_signals,
    ) {
        eprintln!("kriyon-ptyd: {e}");
        std::process::exit(1);
    }
}
