//! [Git run] — the one way this app spawns `git`.
//!
//! Every git invocation in Kriyon needs the same three things, and before this
//! module each caller re-transcribed whichever ones it happened to remember:
//!
//! 1. **The ambient git environment cleared.** Kriyon always names its repo with
//!    `-C <path>`, but an inherited `GIT_DIR` / `GIT_WORK_TREE` /
//!    `GIT_INDEX_FILE` overrides that and silently redirects the command at
//!    whatever repo the environment points to. That happens whenever the process
//!    runs inside a git hook (git exports these) — which is exactly how the
//!    `git_cmd` tests broke under the pre-push hook: their temp-repo commits got
//!    pointed back at the main repo and fired its lefthook.
//! 2. **A spawn retry.** Under load (several agent sessions building at once)
//!    macOS transiently refuses to fork. That is machine pressure, not a git
//!    failure, so a short backoff beats surfacing it.
//! 3. **A non-zero exit mapped to its stderr** — for the callers where non-zero
//!    means failure. For [`GitRun::outcome`] it does not: a conflicted merge
//!    exits non-zero and that is the answer, not an error.
//!
//! **What forced this to be a module rather than a function.** The previous
//! `run_git(repo, args)` could express none of: streaming stdout, setting an env
//! var, or treating a non-zero exit as data. Three real needs, so three call
//! sites hand-rolled `Command::new("git")` and re-derived the list above —
//! including, in one case, the concurrent pipe draining that
//! `Command::output()` does internally. That omission was a permanent hang: see
//! [`GitRun::stream_nul`].

use std::ffi::{OsStr, OsString};
use std::io::Read as _;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use kriyon_core::git::parse_nul_paths;

/// Environment variables git uses to override `-C`, cleared on every run unless
/// the caller set one explicitly (see [`GitRun::env`]).
const AMBIENT_GIT_VARS: [&str; 5] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_PREFIX",
];

/// How many times a spawn refused with EAGAIN/ENOMEM is retried before the
/// error is surfaced.
const SPAWN_ATTEMPTS: usize = 4;

/// First backoff between spawn retries; doubles each attempt.
const SPAWN_BACKOFF: Duration = Duration::from_millis(100);

/// Read buffer for [`GitRun::stream_nul`]. Heap-allocated per call (a 64 KB
/// local trips clippy's `large_stack_arrays`, and one allocation is nothing
/// against a process spawn).
const STREAM_CHUNK: usize = 64 * 1024;

/// A completed run whose exit status is part of the answer rather than a
/// failure — see [`GitRun::outcome`].
pub struct GitOutcome {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// [`GitRun::stream_nul`]'s result.
///
/// The two states are exclusive by construction: either the ceiling held and
/// `entries` is the complete listing, or it did not and `entries` is empty (a
/// partial prefix is worse than nothing — a caller could mistake it for the
/// whole set) with `seen` reporting how many were counted before stopping.
pub struct NulStream {
    /// Every entry, or empty when `exceeded`.
    pub entries: Vec<String>,
    /// How many entries were counted. Exact when `!exceeded`; a lower bound
    /// otherwise, since the walk stopped as soon as it knew.
    pub seen: usize,
    pub exceeded: bool,
}

/// One prepared `git -C <repo> <args…>` invocation. See the module docs.
///
/// Build it, then choose an outcome shape — the shape is the whole interface,
/// and picking one is how a caller says what a non-zero exit means and whether
/// the output is bounded.
pub struct GitRun {
    repo: OsString,
    args: Vec<OsString>,
    env: Vec<(&'static str, OsString)>,
}

impl GitRun {
    /// Start a run against `repo`.
    pub fn new(repo: impl AsRef<OsStr>) -> Self {
        Self {
            repo: repo.as_ref().to_os_string(),
            args: Vec::new(),
            env: Vec::new(),
        }
    }

    /// Append arguments, in order.
    #[must_use]
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args
            .extend(args.into_iter().map(|a| a.as_ref().to_os_string()));
        self
    }

    /// Set an environment variable deliberately, exempting it from the ambient
    /// clearing. The scratch-index snapshot points `GIT_INDEX_FILE` at a
    /// throwaway index so it never touches the real one, and that must win.
    #[must_use]
    pub fn env(mut self, key: &'static str, value: impl AsRef<OsStr>) -> Self {
        self.env.push((key, value.as_ref().to_os_string()));
        self
    }

    /// The prepared `Command`, with the ambient environment cleared and the
    /// caller's explicit vars applied.
    fn command(&self) -> Command {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.repo).args(&self.args);
        // The person's [Shell PATH], so a hook that calls pnpm, node or
        // git-lfs finds it when the app was opened from the Dock.
        if let Some(path) = crate::shell_path::user_path() {
            cmd.env("PATH", path);
        }
        for var in AMBIENT_GIT_VARS {
            if !self.env.iter().any(|(key, _)| *key == var) {
                cmd.env_remove(var);
            }
        }
        for (key, value) in &self.env {
            cmd.env(key, value);
        }
        cmd
    }

    /// Run to completion, buffering both pipes. Non-zero exit is **data**, not
    /// an error: `merge` reports a conflict this way, and collapsing it into
    /// `Err` would discard the very thing the caller needs.
    ///
    /// # Errors
    /// Only if git could not be spawned at all.
    pub fn outcome(self) -> Result<GitOutcome, String> {
        let mut cmd = self.command();
        let mut delay = SPAWN_BACKOFF;
        let mut result = cmd.output();
        for _ in 1..SPAWN_ATTEMPTS {
            match &result {
                Err(e) if is_fork_pressure(e) => {
                    std::thread::sleep(delay);
                    delay *= 2;
                    result = cmd.output();
                }
                _ => break,
            }
        }
        let output = result.map_err(|e| format!("failed to run git: {e}"))?;
        Ok(GitOutcome {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }

    /// Run to completion and return stdout bytes; a non-zero exit is an error
    /// carrying the trimmed stderr.
    ///
    /// Bytes rather than `String` because a `-z` path listing is data: a path
    /// git emits as raw non-UTF-8 bytes would come back with replacement
    /// characters silently substituted, i.e. a path that no longer names the
    /// file.
    ///
    /// # Errors
    /// Returns an error string if git cannot be spawned or exits non-zero.
    pub fn bytes(self) -> Result<Vec<u8>, String> {
        let mut cmd = self.command();
        let mut delay = SPAWN_BACKOFF;
        let mut result = cmd.output();
        for _ in 1..SPAWN_ATTEMPTS {
            match &result {
                Err(e) if is_fork_pressure(e) => {
                    std::thread::sleep(delay);
                    delay *= 2;
                    result = cmd.output();
                }
                _ => break,
            }
        }
        let output = result.map_err(|e| format!("failed to run git: {e}"))?;
        if output.status.success() {
            return Ok(output.stdout);
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} failed ({})", self.describe(), output.status)
        } else {
            stderr
        })
    }

    /// [`Self::bytes`] with the lossy UTF-8 conversion, for line-oriented output
    /// nobody round-trips as a path.
    ///
    /// # Errors
    /// Returns an error string if git cannot be spawned or exits non-zero.
    pub fn text(self) -> Result<String, String> {
        Ok(String::from_utf8_lossy(&self.bytes()?).into_owned())
    }

    /// Stream NUL-separated stdout, stopping as soon as more than `limit`
    /// entries exist.
    ///
    /// **Streamed, not buffered**, because the point of a ceiling is that a
    /// pathological tree is never fully walked: git writes into a pipe we stop
    /// reading, so ending the read ends the walk. [`Self::bytes`] would wait for
    /// the whole thing and defeat the exercise.
    ///
    /// **Both pipes are drained concurrently, and that is not optional.** `git
    /// ls-files` emits one `warning: could not open directory 'x/'` per
    /// unreadable directory (~60 bytes), so a tree with roughly 1,100 of them
    /// fills the 64 KB pipe. git then blocks writing stderr, never closes
    /// stdout, and a loop that drains only stdout waits forever — a permanently
    /// wedged blocking-pool thread. Reading stderr *after* stdout cannot work:
    /// by then the deadlock has already happened. This is the failure mode that
    /// made a shared module worth having.
    ///
    /// # Errors
    /// Returns an error string if git cannot be spawned, the pipe read fails, or
    /// git exits non-zero before the ceiling was reached (once it is, the
    /// non-zero exit is our own kill).
    pub fn stream_nul(self, limit: usize) -> Result<NulStream, String> {
        let mut cmd = self.command();
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = spawn_with_retry(&mut cmd)?;
        let Some(mut stdout) = child.stdout.take() else {
            // Unreachable (we just asked for a pipe), but returning without
            // reaping would leave a live git process and its FDs unowned.
            reap(&mut child);
            return Err(format!("git {}: stdout was not piped", self.describe()));
        };
        let stderr_pipe = child.stderr.take();
        let stderr_reader = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = stderr_pipe {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        });

        let mut raw: Vec<u8> = Vec::new();
        let mut buffer = vec![0u8; STREAM_CHUNK].into_boxed_slice();
        let mut seen = 0usize;
        let mut exceeded = false;
        let mut read_error = None;
        loop {
            let read = match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => n,
                // NOT a break: treating a read failure as end-of-list would hand
                // back a truncated listing that callers would take for the
                // complete set — a short answer presented as the whole story.
                Err(e) => {
                    read_error = Some(e);
                    break;
                }
            };
            // `naive_bytecount` wants the `bytecount` crate. A SIMD byte counter
            // is not worth a dependency for a 64 KB chunk read a few times a
            // minute.
            #[allow(clippy::naive_bytecount)]
            {
                seen += buffer[..read].iter().filter(|byte| **byte == 0).count();
            }
            raw.extend_from_slice(&buffer[..read]);
            if seen > limit {
                exceeded = true;
                break;
            }
        }
        if exceeded || read_error.is_some() {
            // Deterministic where relying on SIGPIPE is not: git may not write
            // again for a while, and until it does it would keep walking.
            let _ = child.kill();
        }
        drop(stdout);
        let stderr = stderr_reader.join().unwrap_or_default();
        let status = child
            .wait()
            .map_err(|e| format!("git {}: {e}", self.describe()))?;
        if let Some(e) = read_error {
            return Err(format!("git {}: {e}", self.describe()));
        }
        if !exceeded && !status.success() {
            let reason = stderr.trim();
            return Err(if reason.is_empty() {
                format!("git {} failed ({status})", self.describe())
            } else {
                reason.to_string()
            });
        }

        Ok(NulStream {
            entries: if exceeded {
                Vec::new()
            } else {
                parse_nul_paths(&raw)
            },
            seen,
            exceeded,
        })
    }

    /// The subcommand, for error messages — enough to name what failed without
    /// echoing a path back into the UI.
    fn describe(&self) -> String {
        self.args
            .first()
            .map_or_else(|| "?".to_string(), |a| a.to_string_lossy().into_owned())
    }
}

/// Whether a spawn failure is the kernel refusing to fork right now rather than
/// a real problem with the command.
fn is_fork_pressure(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::OutOfMemory
    )
}

/// Spawn with the same backoff [`GitRun::outcome`] uses, for the streamed path
/// (which cannot go through `output()`).
fn spawn_with_retry(cmd: &mut Command) -> Result<Child, String> {
    let mut delay = SPAWN_BACKOFF;
    let mut result = cmd.spawn();
    for _ in 1..SPAWN_ATTEMPTS {
        match &result {
            Err(e) if is_fork_pressure(e) => {
                std::thread::sleep(delay);
                delay *= 2;
                result = cmd.spawn();
            }
            _ => break,
        }
    }
    result.map_err(|e| format!("failed to run git: {e}"))
}

/// Kill and reap, for an early return that still owns a live child.
fn reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn repo_with_commit() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("repo dir");
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "t@e.com"],
            vec!["config", "user.name", "T"],
        ] {
            GitRun::new(dir.path())
                .args(args)
                .outcome()
                .expect("git setup");
        }
        std::fs::write(dir.path().join("f.txt"), "one\n").expect("write");
        GitRun::new(dir.path())
            .args(["add", "."])
            .outcome()
            .expect("add");
        GitRun::new(dir.path())
            .args(["commit", "-m", "init"])
            .outcome()
            .expect("commit");
        dir
    }

    #[test]
    fn text_returns_stdout_for_a_successful_run() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit();
        let out = GitRun::new(dir.path())
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .text()
            .expect("rev-parse");
        assert_eq!(out.trim(), "main");
    }

    #[test]
    fn bytes_maps_a_non_zero_exit_to_its_stderr() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().expect("not a repo");
        let err = GitRun::new(dir.path())
            .args(["rev-parse", "--show-toplevel"])
            .bytes()
            .unwrap_err();
        assert!(!err.is_empty(), "a failure must carry a reason");
    }

    /// A non-zero exit with nothing on stderr used to surface as `Err("")`,
    /// which reaches the UI as a blank banner.
    #[test]
    fn a_silent_failure_still_names_the_subcommand() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit();
        let err = GitRun::new(dir.path())
            .args(["rev-parse", "--verify", "--quiet", "refs/heads/nope"])
            .bytes()
            .unwrap_err();
        assert!(err.contains("rev-parse"), "got {err:?}");
    }

    /// The distinction `outcome` exists for: a conflicted merge exits non-zero
    /// and that is the answer, not a failure to report.
    #[test]
    fn outcome_treats_a_non_zero_exit_as_data() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().expect("not a repo");
        let got = GitRun::new(dir.path())
            .args(["rev-parse", "--show-toplevel"])
            .outcome()
            .expect("spawning still succeeded");
        assert!(!got.success);
        assert_ne!(got.stderr, "");
    }

    #[test]
    fn stream_nul_returns_every_entry_under_the_ceiling() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit();
        for i in 0..3 {
            std::fs::write(dir.path().join(format!("u{i}.txt")), "x").expect("write");
        }
        let got = GitRun::new(dir.path())
            .args(["ls-files", "--others", "--exclude-standard", "-z"])
            .stream_nul(10)
            .expect("stream");
        assert!(!got.exceeded);
        assert_eq!(got.seen, 3);
        assert_eq!(got.entries.len(), 3);
    }

    #[test]
    fn stream_nul_drops_the_listing_once_the_ceiling_is_passed() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit();
        for i in 0..20 {
            std::fs::write(dir.path().join(format!("u{i}.txt")), "x").expect("write");
        }
        let got = GitRun::new(dir.path())
            .args(["ls-files", "--others", "--exclude-standard", "-z"])
            .stream_nul(3)
            .expect("stream");
        assert!(got.exceeded);
        assert!(got.seen > 3, "the count is a floor, not a census");
        assert!(
            got.entries.is_empty(),
            "a refused listing yields no entries — a truncated one reads as complete"
        );
    }

    /// The deadlock this module exists to make impossible, in its own tests as
    /// well as `git_cmd`'s: `ls-files` writes one warning per unreadable
    /// directory, and past the 64 KB pipe buffer git blocks on stderr while a
    /// stdout-only reader blocks on stdout. Run with a deadline so a regression
    /// fails the suite instead of wedging it.
    #[cfg(unix)]
    #[test]
    fn stream_nul_does_not_deadlock_when_stderr_exceeds_the_pipe_buffer() {
        use std::os::unix::fs::PermissionsExt as _;
        if !git_available() {
            return;
        }
        let dir = repo_with_commit();
        let root = dir.path().to_path_buf();
        for i in 0..1400 {
            let sub = root.join(format!("locked{i}"));
            std::fs::create_dir_all(&sub).expect("mkdir");
            std::fs::write(sub.join("f.txt"), "x").expect("write");
            let _ = std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o000));
        }

        let probe = root.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let got = GitRun::new(&probe)
                .args(["ls-files", "--others", "--exclude-standard", "-z"])
                .stream_nul(10_000);
            let _ = tx.send(got.is_ok());
        });
        let outcome = rx.recv_timeout(Duration::from_secs(30));

        for i in 0..1400 {
            let _ = std::fs::set_permissions(
                root.join(format!("locked{i}")),
                std::fs::Permissions::from_mode(0o755),
            );
        }
        assert!(
            outcome.is_ok(),
            "stream_nul deadlocked: git filled the stderr pipe while only stdout was drained"
        );
    }

    /// `-C` must stay authoritative even when the process inherited a git
    /// environment — the shape a git hook leaves behind.
    #[test]
    fn an_inherited_git_dir_does_not_redirect_the_run() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit();
        let elsewhere = repo_with_commit();
        // SAFETY: process env is global, so this is only sound because the
        // suite runs with `--test-threads=1` (see `pnpm rust:test`). Under the
        // default parallel runner this poisons every concurrent git test.
        unsafe { std::env::set_var("GIT_DIR", elsewhere.path().join(".git")) };
        let top = GitRun::new(dir.path())
            .args(["rev-parse", "--show-toplevel"])
            .text();
        unsafe { std::env::remove_var("GIT_DIR") };

        let top = top.expect("rev-parse");
        assert!(
            std::path::Path::new(top.trim())
                .canonicalize()
                .expect("canonicalize")
                == dir.path().canonicalize().expect("canonicalize"),
            "an inherited GIT_DIR must not win over -C (got {top:?})"
        );
    }

    /// …but a var the caller set deliberately must survive, or the scratch-index
    /// snapshot would write to the user's real index.
    #[test]
    fn an_explicit_env_var_survives_the_ambient_clearing() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit();
        let scratch = dir.path().join("scratch-index");
        GitRun::new(dir.path())
            .args(["add", "-A"])
            .env("GIT_INDEX_FILE", &scratch)
            .outcome()
            .expect("add");
        assert!(
            scratch.exists(),
            "GIT_INDEX_FILE set on the run must reach git"
        );
    }
}
