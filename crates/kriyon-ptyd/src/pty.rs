//! PTY host backing a [`SessionEngine`] via `portable-pty`.
//!
//! This lives in the `kriyon-ptyd` daemon process: the daemon owns the PTY and
//! child shell so a session outlives an app crash. The app talks to it over the
//! [Session socket] via a `DaemonClient`, not by constructing a `PtyEngine`.

use std::io::{Read, Write};
use std::thread::JoinHandle;

use kriyon_core::session::{EngineError, SessionEngine, SessionId, SpawnSpec};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize, PtySystem};

const INITIAL_COLS: u16 = 80;
const INITIAL_ROWS: u16 = 24;
const READ_BUF_LEN: usize = 8192;
/// How long `close` waits for the reader thread once the [Tree stop] is done.
/// The reader ends on PTY EOF, which needs every holder of the slave gone; a
/// process that daemonised itself out of the session can keep it open forever,
/// and the daemon must exit regardless.
const READER_JOIN_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);
const READER_JOIN_POLL: std::time::Duration = std::time::Duration::from_millis(20);

fn pty_err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Pty(e.to_string())
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Returns `true` if the shell path's basename ends with `zsh` or `bash`,
/// meaning it should be launched as a login shell (`-l`).
fn is_login_shell(shell: &str) -> bool {
    let base = shell.rsplit('/').next().unwrap_or(shell);
    base.ends_with("zsh") || base.ends_with("bash")
}

/// The pid of the shell this daemon hosts, or `0` before one is spawned. A
/// process-wide copy of what [`PtyEngine`] holds, for the one caller that cannot
/// reach the engine: the panic hook (see [`emergency_stop`]).
static HOSTED_SHELL: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// The device number of this daemon's PTY, or `0` before one is opened: the
/// terminal an [Owning claude] must hold. Process-wide for the [Companion
/// bridge], which starts before the engine and reads it per post.
static HOSTED_TTY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The device number of the session's terminal, once this daemon has one.
#[must_use]
pub fn hosted_tty() -> Option<u64> {
    match HOSTED_TTY.load(std::sync::atomic::Ordering::SeqCst) {
        0 => None,
        rdev => Some(rdev),
    }
}

/// [Tree stop] whatever this daemon hosts, without going through the engine.
/// For the panic hook: a daemon that dies of a panic would otherwise close its
/// PTY and leave everything it hosted to launchd — the leak the tree stop
/// exists to prevent — and the engine's own `close` may be the thing that
/// panicked.
pub fn emergency_stop() {
    let shell = HOSTED_SHELL.load(std::sync::atomic::Ordering::SeqCst);
    if shell > 1 {
        let _ = crate::tree_stop::run(shell, || {});
    }
}

/// A pty-backed [`SessionEngine`]. Hosts a child shell process behind a pty,
/// streaming its output to a callback on a dedicated reader thread.
pub struct PtyEngine {
    id: SessionId,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    reader_thread: Mutex<Option<JoinHandle<()>>>,
    /// Serializes `close`: a `Shutdown` frame and the child-exit reaper can both
    /// reach it at once, and the [Tree stop] must run exactly once. A second
    /// caller blocks until the first has finished.
    stopped: std::sync::Once,
}

impl PtyEngine {
    /// Spawn a new pty-backed session running `spec.shell` in `spec.cwd`.
    ///
    /// `on_output` is invoked from a dedicated reader thread for each chunk of
    /// bytes the child writes to the pty. It takes ownership of the chunk `Vec`
    /// (read directly into a fresh allocation, no extra copy).
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] if the pty cannot be opened, the child
    /// process cannot be spawned, or the writer/reader cannot be obtained.
    pub fn spawn<F>(id: SessionId, spec: &SpawnSpec, on_output: F) -> Result<Self, EngineError>
    where
        F: Fn(Vec<u8>) + Send + 'static,
    {
        let pty_system: Box<dyn PtySystem + Send> = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(INITIAL_COLS, INITIAL_ROWS))
            .map_err(pty_err)?;

        let mut cmd = CommandBuilder::new(&spec.shell);
        if is_login_shell(&spec.shell) {
            cmd.arg("-l");
        }
        cmd.cwd(&spec.cwd);
        // Strip the launcher's Claude Code identity (CLAUDECODE,
        // CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_SESSION_ID, … — an explicit
        // list; the user's own CLAUDE_CODE_* settings pass). Without this, a Kriyon started from inside a Claude
        // Code session leaks those markers into the hosted `claude`, which then
        // runs as a nested instance and never writes its transcript — leaving
        // the transcript unreadable. `CommandBuilder` inherits the full parent env,
        // so we remove them explicitly. See `kriyon_core::session`.
        for (key, _) in std::env::vars() {
            if kriyon_core::session::is_agent_identity_var(&key) {
                cmd.env_remove(&key);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("LC_ALL", "en_US.UTF-8");
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }
        // Name the session's terminal, so Kriyon's hooks can tell the session's
        // own `claude` from one it started (see `TerminalSeat`). Never pass on
        // an inherited name: a Kriyon started from a Kriyon terminal carries
        // that terminal's, and every event from this session would be dropped.
        cmd.env_remove("KRIYON_TTY");
        if let Some(tty) = pair.master.tty_name() {
            if let Ok(meta) = std::fs::metadata(&tty) {
                use std::os::unix::fs::MetadataExt as _;
                HOSTED_TTY.store(meta.rdev(), std::sync::atomic::Ordering::SeqCst);
            }
            cmd.env("KRIYON_TTY", tty);
        }

        let child = pair.slave.spawn_command(cmd).map_err(pty_err)?;
        if let Some(pid) = child.process_id().and_then(|pid| i32::try_from(pid).ok()) {
            HOSTED_SHELL.store(pid, std::sync::atomic::Ordering::SeqCst);
        }
        // Drop the slave right after spawning to avoid hangs.
        drop(pair.slave);

        let writer = pair.master.take_writer().map_err(pty_err)?;
        let mut reader = pair.master.try_clone_reader().map_err(pty_err)?;

        // No reader-side backpressure lives here: in the daemon, `on_output`
        // writes to the client socket and a blocking socket write IS the
        // backpressure (it stalls the read, stalling the child). When detached
        // there is nothing to stall against, and nothing accumulates either —
        // output is folded into the headless emulator's one screen grid
        // (ADR-0004), which is bounded by construction.
        let reader_thread = std::thread::spawn(move || {
            loop {
                // Read straight into a fresh Vec each iteration, so the chunk
                // handed to `on_output` is owned with no second copy.
                let mut chunk = vec![0u8; READ_BUF_LEN];
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        chunk.truncate(n);
                        on_output(chunk);
                    }
                }
            }
        });

        Ok(Self {
            id,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            reader_thread: Mutex::new(Some(reader_thread)),
            stopped: std::sync::Once::new(),
        })
    }

    /// `true` if the child process has already exited.
    #[must_use]
    pub fn child_has_exited(&self) -> bool {
        matches!(self.child.lock().try_wait(), Ok(Some(_)))
    }

    /// Whether the child shell has a foreground command running.
    ///
    /// Derived from the tty's foreground process group: an interactive shell
    /// makes itself the terminal's foreground group at its prompt, and job
    /// control moves each foreground command into its own group. So
    /// `tcgetpgrp(master) != shell_pgid` ⟺ a command is running. Because the
    /// shell is spawned as a session leader (portable-pty calls `setsid`), its
    /// pgid equals its pid. Shell-agnostic — it reads the kernel's tty state, not
    /// any shell integration — and it holds across a reattach because the daemon,
    /// not the webview, owns the master fd.
    ///
    /// Returns `None` when either value is unavailable (the child has exited, or
    /// there is no foreground group), which callers treat as "not busy".
    #[must_use]
    pub fn foreground_busy(&self) -> Option<bool> {
        let shell_pid = self.child.lock().process_id()?;
        let foreground = self.master.lock().process_group_leader()?;
        let shell_pid = i32::try_from(shell_pid).ok()?;
        Some(foreground != shell_pid)
    }
}

impl PtyEngine {
    /// Join the reader thread, but only for so long. With every holder of the
    /// pty slave gone the reader sees EOF at once; if something escaped the
    /// [Tree stop] and still holds it, the thread is left to die with the process.
    fn join_reader(&self) {
        let Some(handle) = self.reader_thread.lock().take() else {
            return;
        };
        let deadline = std::time::Instant::now() + READER_JOIN_TIMEOUT;
        while !handle.is_finished() && std::time::Instant::now() < deadline {
            std::thread::sleep(READER_JOIN_POLL);
        }
        if handle.is_finished() {
            let _ = handle.join();
        }
    }
}

impl SessionEngine for PtyEngine {
    fn id(&self) -> &SessionId {
        &self.id
    }

    fn write_stdin(&self, bytes: &[u8]) -> Result<(), EngineError> {
        let mut writer = self.writer.lock();
        writer.write_all(bytes).map_err(pty_err)?;
        writer.flush().map_err(pty_err)
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), EngineError> {
        self.master
            .lock()
            .resize(pty_size(cols, rows))
            .map_err(pty_err)
    }

    fn close(&self) -> Result<(), EngineError> {
        // A [Tree stop], never a bare `child.kill()`: that signals the shell pid
        // alone, and everything it leaves behind is reparented to launchd and
        // runs on, untraceable. Best-effort throughout; never panics.
        self.stopped.call_once(|| {
            let shell = self
                .child
                .lock()
                .process_id()
                .and_then(|pid| i32::try_from(pid).ok());
            let swept = shell.is_some_and(|shell| {
                crate::tree_stop::run(shell, || {
                    let _ = self.child.lock().try_wait();
                })
            });
            if !swept {
                // No pid, or no readable process table: end the one process we
                // hold a handle to (SIGHUP, a short grace, SIGKILL). Its
                // foreground job is hung up by the kernel when it goes.
                let _ = self.child.lock().kill();
            }
            self.join_reader();
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn the_shell_is_told_which_terminal_is_the_sessions() {
        let mut env = HashMap::new();
        env.insert("PS1".to_string(), String::new());
        let spec = SpawnSpec {
            cwd: "/".to_string(),
            shell: "/bin/sh".to_string(),
            env,
        };
        let collected = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&collected);
        let engine = PtyEngine::spawn(SessionId("tty".to_string()), &spec, move |bytes| {
            sink.lock()
                .expect("lock poisoned")
                .extend_from_slice(&bytes);
        })
        .expect("pty spawn should succeed");
        // The echoed command line reads `tty-%s`; only a match prints `tty-same`.
        engine
            .write_stdin(b"[ -n \"$KRIYON_TTY\" ] && [ \"$KRIYON_TTY\" = \"$(tty)\" ] && printf 'tty-%s\\n' same\n")
            .expect("write_stdin should succeed");
        let mut found = false;
        for _ in 0..60 {
            if String::from_utf8_lossy(&collected.lock().expect("lock poisoned"))
                .contains("tty-same")
            {
                found = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = engine.close();
        assert!(found, "KRIYON_TTY must name the session's own terminal");
    }

    #[test]
    fn pty_engine_echoes_shell_output() {
        let mut env = HashMap::new();
        env.insert("PS1".to_string(), String::new());
        let spec = SpawnSpec {
            cwd: "/".to_string(),
            shell: "/bin/sh".to_string(),
            env,
        };

        let collected = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&collected);
        let engine = PtyEngine::spawn(SessionId("test".to_string()), &spec, move |bytes| {
            sink.lock()
                .expect("lock poisoned")
                .extend_from_slice(&bytes);
        })
        .expect("pty spawn should succeed");

        engine
            .write_stdin(b"printf hello\n")
            .expect("write_stdin should succeed");

        let mut found = false;
        for _ in 0..60 {
            {
                let buf = collected.lock().expect("lock poisoned");
                if String::from_utf8_lossy(&buf).contains("hello") {
                    found = true;
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        let buf = collected.lock().expect("lock poisoned");
        assert!(
            found,
            "expected shell output to contain 'hello', got: {:?}",
            String::from_utf8_lossy(&buf)
        );
        drop(buf);

        engine.close().expect("close should succeed");
    }

    #[test]
    fn foreground_busy_tracks_a_running_command() {
        // An interactive shell on a pty has job control, so a foreground command
        // gets its own process group and the tty's foreground group changes.
        // We assert the full cycle — busy while a command runs, idle after — and
        // rely only on the transition (not on catching a pre-command idle window,
        // which is racy under parallel test load). Typed-ahead input runs once
        // the shell reaches its prompt, so no explicit "wait for prompt" is needed.
        // Use bash, not zsh: bash ships on both macOS and the Linux CI runner and
        // is a full job-control shell, so the foreground-pgroup edge behaves the
        // same. `is_login_shell` launches it as a login shell just like zsh.
        let spec = SpawnSpec {
            cwd: "/".to_string(),
            shell: "/bin/bash".to_string(),
            env: HashMap::new(),
        };
        let engine = PtyEngine::spawn(SessionId("busy".to_string()), &spec, |_bytes| {})
            .expect("pty spawn should succeed");

        // Run a bounded foreground command; job control moves it into its own
        // process group, so the tty's foreground group differs from the shell.
        engine
            .write_stdin(b"sleep 2\n")
            .expect("write_stdin should succeed");

        // Poll generously (up to ~12s) for the busy edge — the shell may still be
        // starting up under load, and the typed-ahead command runs after.
        let mut became_busy = false;
        for _ in 0..240 {
            if engine.foreground_busy() == Some(true) {
                became_busy = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            became_busy,
            "foreground_busy should be true while a command runs"
        );

        // Once `sleep` finishes, the shell reclaims the terminal → idle again.
        let mut idle_again = false;
        for _ in 0..160 {
            if engine.foreground_busy() == Some(false) {
                idle_again = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            idle_again,
            "foreground_busy should return to false after the command finishes"
        );

        engine.close().expect("close should succeed");
    }

    #[test]
    fn close_completes_promptly_with_a_silent_sink() {
        let mut env = HashMap::new();
        env.insert("PS1".to_string(), String::new());
        let spec = SpawnSpec {
            cwd: "/".to_string(),
            shell: "/bin/sh".to_string(),
            env,
        };

        // A sink that does nothing: the engine must still tear down without
        // hanging the reader thread.
        let engine = PtyEngine::spawn(SessionId("drain".to_string()), &spec, |_bytes| {})
            .expect("pty spawn should succeed");

        engine
            .write_stdin(b"printf hello\n")
            .expect("write_stdin should succeed");

        // close() kills the child (closing the pty), so the reader sees EOF and
        // the join returns promptly.
        let start = std::time::Instant::now();
        engine.close().expect("close should succeed");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "close() should complete promptly, not hang the reader thread"
        );
    }
}
