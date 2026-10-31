//! [Shell PATH] — the PATH the person's own shell sets up, read once.
//!
//! A Mac app opened from the Dock or Finder gets only the system PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`). Tools the person's shell config adds —
//! pnpm, nvm's node, Homebrew, git-lfs — are invisible to it, so a worktree
//! install fails with "No such file or directory" and a git hook that calls
//! `pnpm` fails a merge. The session terminal never hits this: it starts the
//! person's shell, which reads their config.
//!
//! The fix most desktop apps use (VS Code, Tauri's `fix-path-env`): run the
//! person's shell once as an interactive login shell (`-ilc`, so `.zshrc` is
//! read too) and take its PATH. Every git run uses it once it is known
//! ([`ready`], which never waits), so hooks and LFS filters find the person's
//! tools. The commands that must have it wait for it ([`user_path`]) and pass
//! it in: the [Worktree bootstrap], creating a worktree and merging one back.
//!
//! A slow or broken shell config must never wedge the app, so the probe has a
//! timeout and a failure falls back to the app's own PATH.

use std::io::Read as _;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use kriyon_core::shellinit::{parse_path_probe, user_shell, PATH_PROBE};

/// How long the person's shell gets to print its PATH. VS Code allows 10s;
/// a shell config that needs more than this is treated as broken.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// The read [Shell PATH]: unset until the first [`user_path`] call finishes.
static PATH: OnceLock<Option<String>> = OnceLock::new();

/// The shell PATH if it has already been read, without waiting for it or
/// starting the read. Every git run uses this; tests never start a read, so
/// they never run the developer's own shell.
pub fn ready() -> Option<&'static str> {
    PATH.get().and_then(Option::as_deref)
}

/// The person's shell PATH, or `None` when it could not be read (the caller
/// then keeps the app's own PATH). Resolved once per app run; the first caller
/// waits for it, so [`warm`] starts it at launch.
pub fn user_path() -> Option<&'static str> {
    PATH.get_or_init(|| {
        let shell = user_shell(std::env::var("SHELL").ok().as_deref());
        let path = probe(&shell, PROBE_TIMEOUT);
        if path.is_none() {
            eprintln!("kriyon: could not read PATH from {shell}; using the app's own PATH");
        }
        path
    })
    .as_deref()
}

/// Start reading the shell PATH in the background, so the first git call or
/// worktree setup does not wait for the person's shell to start.
pub fn warm() {
    std::thread::spawn(|| {
        let _ = user_path();
    });
}

/// Run `shell -ilc PATH_PROBE` and return the PATH it prints, or `None` if the
/// shell can't start, prints no PATH, or takes longer than `timeout`. Returns
/// as soon as the PATH is printed, even if the shell config left a background
/// process holding the output open.
fn probe(shell: &str, timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(shell);
    cmd.args(["-ilc", PATH_PROBE])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Oh My Zsh's update prompt would otherwise stall an interactive shell.
        .env("DISABLE_AUTO_UPDATE", "true");
    if let Some(home) = std::env::var_os("HOME") {
        cmd.current_dir(home);
    }
    // Its own process group, so a timeout can stop whatever the config started.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut seen = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    seen.extend_from_slice(&chunk[..n]);
                    if let Some(path) = parse_path_probe(&String::from_utf8_lossy(&seen)) {
                        let _ = tx.send(path);
                        return;
                    }
                }
            }
        }
        // Dropping `tx` without sending tells the receiver there is no PATH.
    });

    let path = rx.recv_timeout(timeout).ok();
    if path.is_none() {
        // A hung config: stop the shell and anything it started.
        #[cfg(unix)]
        if let Ok(pid) = i32::try_from(child.id()) {
            crate::daemon_rt::signal_group_gated(pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    path
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Instant;

    /// A stand-in for the person's shell that runs `body` as its script.
    fn fake_shell(dir: &std::path::Path, body: &str) -> String {
        let path = dir.join("shell");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write shell");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn reads_the_path_the_shell_config_sets() {
        let dir = tempfile::tempdir().expect("dir");
        let shell = fake_shell(
            dir.path(),
            "[ \"$1\" = -ilc ] || exit 9\necho 'config banner'\nPATH=/from/zshrc:/usr/bin exec /bin/sh -c \"$2\"",
        );
        assert_eq!(
            probe(&shell, Duration::from_secs(5)).as_deref(),
            Some("/from/zshrc:/usr/bin")
        );
    }

    #[test]
    fn a_hung_shell_config_times_out() {
        let dir = tempfile::tempdir().expect("dir");
        let shell = fake_shell(dir.path(), "sleep 30");
        let started = Instant::now();
        assert_eq!(probe(&shell, Duration::from_millis(300)), None);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "did not wait for the shell"
        );
    }

    #[test]
    fn a_background_process_holding_the_output_does_not_block() {
        let dir = tempfile::tempdir().expect("dir");
        // The config starts a daemon that inherits stdout and outlives the shell.
        let shell = fake_shell(dir.path(), "sleep 30 &\n/bin/sh -c \"$2\"");
        let started = Instant::now();
        assert!(probe(&shell, Duration::from_secs(5)).is_some());
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "returned once PATH printed"
        );
    }

    #[test]
    fn a_missing_shell_is_none() {
        assert_eq!(probe("/no/such/shell", Duration::from_secs(1)), None);
    }

    #[test]
    fn a_shell_that_prints_no_path_is_none() {
        let dir = tempfile::tempdir().expect("dir");
        let shell = fake_shell(dir.path(), "echo nothing useful");
        assert_eq!(probe(&shell, Duration::from_secs(5)), None);
    }
}
