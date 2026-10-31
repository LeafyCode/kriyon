//! Thin shell-out for a [Worktree bootstrap]: copy the repo's untracked
//! top-level `.env*` files into a fresh worktree, run the lockfile-detected
//! install, then the project's optional setup command — all inside the
//! worktree, through the person's own shell. A Mac app opened from the Dock
//! gets only the system PATH, so tools their shell config adds (pnpm, nvm's
//! node, Homebrew) are found only by running the step the way their terminal
//! does: an interactive login shell (`-ilc`), as VS Code and Tauri's
//! `fix-path-env` do. Best-effort: each step is recorded and the next still runs; a
//! failing step sets `ok = false` but never panics. Kept Tauri-free so it is
//! unit-testable. Pairs with the pure decisions in `kriyon_core::bootstrap`.

use std::fmt::Write as _;
use std::process::Command;

use kriyon_core::bootstrap::{detect_install, env_files_to_copy};
use serde::Serialize;

/// One step of a [`BootstrapReport`].
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStep {
    pub label: String,
    pub ok: bool,
}

/// The outcome of a [Worktree bootstrap]: whether every step succeeded, the
/// per-step results, and the combined captured output (surfaced on failure).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapReport {
    pub ok: bool,
    pub steps: Vec<BootstrapStep>,
    pub output: String,
}

/// Copy `.env*`, run the detected install, then the optional setup command,
/// inside `worktree_path`, each through `shell`. Best-effort and total.
#[must_use]
pub fn bootstrap_worktree(
    repo_root: &str,
    worktree_path: &str,
    setup_cmd: Option<&str>,
    shell: &str,
) -> BootstrapReport {
    let mut steps: Vec<BootstrapStep> = Vec::new();
    let mut output = String::new();

    // 1. Copy top-level dotenv files (they are gitignored, so the worktree lacks them).
    let listing: Vec<String> = match std::fs::read_dir(repo_root) {
        Ok(rd) => rd
            .filter_map(std::result::Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(e) => {
            let _ = writeln!(output, "read repo: {e}");
            steps.push(BootstrapStep {
                label: "read repo".to_string(),
                ok: false,
            });
            Vec::new()
        }
    };
    let env_files = env_files_to_copy(&listing);
    let mut copy_ok = true;
    for name in &env_files {
        let from = std::path::Path::new(repo_root).join(name);
        let to = std::path::Path::new(worktree_path).join(name);
        if let Err(e) = std::fs::copy(&from, &to) {
            copy_ok = false;
            let _ = writeln!(output, "copy {name}: {e}");
        }
    }
    if !env_files.is_empty() {
        steps.push(BootstrapStep {
            label: "copy .env files".to_string(),
            ok: copy_ok,
        });
    }

    // 2. Install dependencies, if a lockfile says how.
    let present: Vec<&str> = listing.iter().map(String::as_str).collect();
    if let Some(argv) = detect_install(&present) {
        let cmd = argv.join(" ");
        let (ok, out) = run_in(worktree_path, shell, &cmd);
        output.push_str(&out);
        steps.push(BootstrapStep {
            label: format!("install ({cmd})"),
            ok,
        });
    }

    // 3. The project's optional setup command.
    if let Some(cmd) = setup_cmd.filter(|c| !c.trim().is_empty()) {
        let (ok, out) = run_in(worktree_path, shell, cmd);
        output.push_str(&out);
        steps.push(BootstrapStep {
            label: format!("setup ({cmd})"),
            ok,
        });
    }

    BootstrapReport {
        ok: steps.iter().all(|s| s.ok),
        steps,
        output,
    }
}

/// Run `cmd` in `dir` through `shell -ilc`, returning (success, combined
/// stdout+stderr). A spawn failure (e.g. a missing shell) is a failed step,
/// not a panic. stdin is closed, so nothing can wait on input.
fn run_in(dir: &str, shell: &str, cmd: &str) -> (bool, String) {
    let result = Command::new(shell)
        .args(["-ilc", cmd])
        .current_dir(dir)
        // Oh My Zsh's update prompt would otherwise stall an interactive shell.
        .env("DISABLE_AUTO_UPDATE", "true")
        .output();
    match result {
        Ok(out) => {
            let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
            combined.push_str(&String::from_utf8_lossy(&out.stderr));
            (out.status.success(), combined)
        }
        Err(e) => (false, format!("{cmd}: {e}\n")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_env_and_runs_setup_command() {
        let repo = tempfile::tempdir().expect("repo dir");
        let wt = tempfile::tempdir().expect("worktree dir");
        std::fs::write(repo.path().join(".env"), "SECRET=1\n").expect("write .env");
        std::fs::write(repo.path().join("README.md"), "hi").expect("write readme");

        let report = bootstrap_worktree(
            repo.path().to_str().unwrap(),
            wt.path().to_str().unwrap(),
            Some("printf ok > setup-ran.txt"),
            "/bin/sh",
        );

        assert!(report.ok, "report: {report:?}");
        // .env copied, README not.
        assert!(wt.path().join(".env").exists(), "env copied");
        assert!(!wt.path().join("README.md").exists(), "only dotenv copied");
        // Setup command ran IN the worktree.
        assert!(
            wt.path().join("setup-ran.txt").exists(),
            "setup ran in worktree"
        );
    }

    /// A Mac app opened from the Dock gets only the system PATH, so a tool the
    /// person's shell config adds (`~/Library/pnpm/bin`) is invisible to a bare
    /// spawn. The install must run through their shell, like the terminal does.
    #[test]
    #[cfg(unix)]
    fn install_finds_a_tool_only_the_users_shell_puts_on_path() {
        use std::os::unix::fs::PermissionsExt;

        let repo = tempfile::tempdir().expect("repo dir");
        let wt = tempfile::tempdir().expect("worktree dir");
        let tools = tempfile::tempdir().expect("tools dir");
        std::fs::write(repo.path().join("pnpm-lock.yaml"), "").expect("write lockfile");

        // A `pnpm` that exists only on the shell's PATH.
        let bin = tools.path().join("bin");
        std::fs::create_dir(&bin).expect("bin dir");
        let pnpm = bin.join("pnpm");
        std::fs::write(&pnpm, "#!/bin/sh\nprintf \"$*\" > installed.txt\n").expect("fake pnpm");
        std::fs::set_permissions(&pnpm, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        // A stand-in for the person's shell: its config adds `bin` to PATH.
        let shell = tools.path().join("shell");
        std::fs::write(
            &shell,
            format!(
                "#!/bin/sh\n[ \"$1\" = -ilc ] || exit 9\nPATH=\"{}:$PATH\" exec /bin/sh -c \"$2\"\n",
                bin.display()
            ),
        )
        .expect("fake shell");
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        let report = bootstrap_worktree(
            repo.path().to_str().unwrap(),
            wt.path().to_str().unwrap(),
            None,
            shell.to_str().unwrap(),
        );

        assert!(report.ok, "report: {report:?}");
        assert_eq!(
            std::fs::read_to_string(wt.path().join("installed.txt"))
                .ok()
                .as_deref(),
            Some("install"),
            "the shell's pnpm ran in the worktree"
        );
    }

    #[test]
    fn a_failing_setup_command_is_reported_not_panicked() {
        let repo = tempfile::tempdir().expect("repo dir");
        let wt = tempfile::tempdir().expect("worktree dir");
        let report = bootstrap_worktree(
            repo.path().to_str().unwrap(),
            wt.path().to_str().unwrap(),
            Some("exit 3"),
            "/bin/sh",
        );
        assert!(!report.ok, "a non-zero setup command fails the report");
        assert!(
            report
                .steps
                .iter()
                .any(|s| s.label.contains("setup") && !s.ok),
            "the setup step is marked failed: {report:?}"
        );
    }

    #[test]
    fn no_lockfile_skips_install_and_still_succeeds() {
        let repo = tempfile::tempdir().expect("repo dir");
        let wt = tempfile::tempdir().expect("worktree dir");
        let report = bootstrap_worktree(
            repo.path().to_str().unwrap(),
            wt.path().to_str().unwrap(),
            None,
            "/bin/sh",
        );
        assert!(report.ok, "no env, no lockfile, no setup → clean no-op");
        assert!(report.steps.iter().all(|s| s.ok));
    }

    #[test]
    fn ordinary_files_without_dotenv_produce_no_copy_step() {
        let repo = tempfile::tempdir().expect("repo dir");
        let wt = tempfile::tempdir().expect("worktree dir");
        std::fs::write(repo.path().join("README.md"), "hi").expect("write readme");
        std::fs::write(repo.path().join("Cargo.toml"), "[package]").expect("write cargo.toml");

        let report = bootstrap_worktree(
            repo.path().to_str().unwrap(),
            wt.path().to_str().unwrap(),
            None,
            "/bin/sh",
        );

        assert!(report.ok, "report: {report:?}");
        assert!(
            !report.steps.iter().any(|s| s.label == "copy .env files"),
            "no dotenv files present, so no vacuous copy step: {report:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn unreadable_repo_dir_is_a_failed_step_not_a_silent_success() {
        use std::os::unix::fs::PermissionsExt;

        let repo = tempfile::tempdir().expect("repo dir");
        let wt = tempfile::tempdir().expect("worktree dir");
        std::fs::set_permissions(repo.path(), std::fs::Permissions::from_mode(0o000))
            .expect("chmod 000 the repo dir");

        let report = bootstrap_worktree(
            repo.path().to_str().unwrap(),
            wt.path().to_str().unwrap(),
            None,
            "/bin/sh",
        );

        // Restore permissions so `tempfile` can clean up the dir afterwards.
        std::fs::set_permissions(repo.path(), std::fs::Permissions::from_mode(0o700))
            .expect("restore repo dir permissions");

        assert!(!report.ok, "an unreadable repo dir must not report ok:true");
        assert!(
            report.steps.iter().any(|s| s.label == "read repo" && !s.ok),
            "a failed 'read repo' step is recorded: {report:?}"
        );
    }
}
