//! Locate and write Kriyon's Claude Code hooks and status-line wrapper.
//!
//! Kriyon derives live session status from Claude Code hook events (see
//! [`kriyon_core::hooks`]). The hook script is **env-gated**: it does nothing
//! unless `KRIYON_SESSION` is set, which Kriyon sets only in the sessions it
//! starts, and the `claude` firing it is the session's [Owning claude]
//! (ADR-0039). Where the hook entries live — the per-session companion folder or,
//! as a fallback, `~/.claude/settings.json` — is the [Integration]'s call
//! (`crate::integration`); this module provides the pieces.
//!
//! Each firing appends one JSON line to `~/.claude/kriyon/events/<id>.jsonl`
//! (the [Hook spool]), where `<id>` is Kriyon's session id.

use std::path::{Path, PathBuf};

use kriyon_core::policy::{ManagedPolicy, PolicyRead};
use serde_json::{json, Value};

use crate::policy::{managed_policy, ManagedLocations};

/// The statusLine wrapper. It hands the JSON Claude feeds the status line to
/// the usage capture: for Kriyon-launched sessions the live context reading,
/// and for *every* `claude` the account's [Plan limits] — those windows belong
/// to the account, so a session outside Kriyon moves them too (ADR-0038). It
/// then renders the user's *original* status line unchanged by piping the same
/// stdin to it, so the user's bar is untouched.
const STATUSLINE_SCRIPT: &str = r#"#!/bin/sh
# Kriyon status-line wrapper. Captures live usage and plan limits, then
# renders the user's original status line. See crate::hooks.
INPUT=$(cat)
HOOK="$HOME/.claude/kriyon/bin/kriyon-hook"
# Run the capture only when there is something to capture: a Kriyon session,
# or a reply that carried plan limits (an API-key login never does).
if [ -n "$KRIYON_SESSION" ] || printf '%s' "$INPUT" | grep -q '"rate_limits"'; then
  printf '%s' "$INPUT" | "$HOOK" usage "$KRIYON_SESSION" 2>/dev/null || true
fi
INNER_FILE="$HOME/.claude/kriyon/inner-statusline"
if [ -f "$INNER_FILE" ]; then
  INNER=$(cat "$INNER_FILE")
  if [ -n "$INNER" ]; then
    printf '%s' "$INPUT" | sh -c "$INNER"
    exit 0
  fi
fi
# No original status line: print the model name so the bar isn't blank.
printf '%s' "$INPUT" | "$HOOK" model 2>/dev/null || echo Claude
"#;

pub use kriyon_core::paths::{events_dir, events_file, kriyon_dir, usage_dir, usage_file};

/// `~/.claude/projects` — where Claude Code writes one transcript directory per
/// project (folder), each holding that folder's session `*.jsonl` transcripts.
#[must_use]
pub fn projects_dir(home: &Path) -> PathBuf {
    home.join(".claude").join("projects")
}

/// `~/.claude/tasks` — Claude Code's task store, with one `<session-id>/`
/// subdirectory of `<n>.json` files per session. Owned by Claude, read-only to
/// Kriyon; the live source for the Tasks panel.
#[must_use]
pub fn tasks_dir(home: &Path) -> PathBuf {
    home.join(".claude").join("tasks")
}

/// The shell command Claude runs for the hook: Kriyon's own program, in
/// its `event` mode (ADR-0066).
fn hook_command(program: &Path) -> String {
    format!("{} event", sh_path(program))
}

/// `path` as one word for the POSIX shell Claude Code runs hooks and the status
/// line in: quoted so spaces and apostrophes are safe, with forward slashes so
/// the Git Bash it uses on Windows reads a Windows path as one.
fn sh_path(path: &Path) -> String {
    kriyon_core::shellinit::sh_quote(&path.display().to_string().replace('\\', "/"))
}

/// The hook program's file name: `kriyon-hook`, `.exe` on Windows.
const HOOK_NAME: &str = if cfg!(windows) {
    "kriyon-hook.exe"
} else {
    "kriyon-hook"
};

/// The hook program as the app ships it: `$KRIYON_HOOK_BIN`, else beside the
/// app's own executable (where the bundler and a dev build place it).
#[cfg(not(test))]
fn bundled_hook() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("KRIYON_HOOK_BIN") {
        return Some(PathBuf::from(path));
    }
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(HOOK_NAME))
}

/// A test executable has no sidecar beside it: tests install the staged one.
#[cfg(test)]
#[allow(clippy::unnecessary_wraps)] // the same signature as the shipped one
fn bundled_hook() -> Option<PathBuf> {
    Some(tests::built_hook())
}

/// Which settings scope, if any, turns Kriyon's hooks off for a session in
/// `cwd` — [Hooks off]. Reads every managed source and the three file scopes
/// and leaves the decision to [`kriyon_core::hooks::hooks_off`]; a missing or
/// malformed file counts as unset, so this never fails.
#[must_use]
pub fn hooks_off_for(home: &Path, cwd: &Path) -> Option<kriyon_core::hooks::HooksOff> {
    hooks_off_with(&ManagedLocations::for_home(home), home, cwd)
}

/// [`hooks_off_for`] with the managed sources at `managed`. An unknown managed
/// policy counts as unset: Kriyon only says "hooks off" when it knows.
fn hooks_off_with(
    managed: &ManagedLocations,
    home: &Path,
    cwd: &Path,
) -> Option<kriyon_core::hooks::HooksOff> {
    let read = |path: &Path| -> Option<Value> {
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
    };
    let managed = match managed_policy(managed) {
        PolicyRead::Known(policy) => policy,
        PolicyRead::Unknown => ManagedPolicy::default(),
    };
    kriyon_core::hooks::hooks_off(&kriyon_core::hooks::SettingsLayers {
        managed,
        local: read(&cwd.join(".claude").join("settings.local.json")),
        project: read(&cwd.join(".claude").join("settings.json")),
        user: read(&home.join(".claude").join("settings.json")),
    })
}

/// `~/.claude/kriyon/bin/kriyon-hook`: the program every hook entry and the
/// status-line wrapper run. A copy of the app's, at a path that doesn't move
/// with the app and that an app update never has to replace while a hook
/// runs.
#[must_use]
pub fn hook_binary(home: &Path) -> PathBuf {
    kriyon_dir(home).join("bin").join(HOOK_NAME)
}

/// The command a hook entry runs (see [`hook_command`]), or `None` when the
/// hook program isn't installed (the app's copy was missing).
#[must_use]
pub fn hook_command_for(home: &Path) -> Option<String> {
    let program = hook_binary(home);
    program.is_file().then(|| hook_command(&program))
}

/// The command Claude runs for Kriyon's status-line wrapper.
#[must_use]
pub fn statusline_command(home: &Path) -> String {
    format!(
        "sh {}",
        sh_path(&kriyon_dir(home).join("kriyon-statusline.sh"))
    )
}

/// Install Kriyon's hook program and write its status-line wrapper and the
/// owner-only folders they write into; the Python scripts an older version
/// wrote go (ADR-0066). Idempotent; never touches settings.
///
/// # Errors
/// When a folder or the wrapper can't be written. A hook program the app
/// doesn't carry isn't an error: the hooks are then left out.
pub fn write_scripts(home: &Path) -> std::io::Result<()> {
    write_scripts_from(home, bundled_hook().as_deref())
}

/// [`write_scripts`], installing the hook program from `source`.
fn write_scripts_from(home: &Path, source: Option<&Path>) -> std::io::Result<()> {
    use kriyon_core::private_fs::{create_private_dir, write_private};
    let dir = kriyon_dir(home);
    for d in [
        dir.clone(),
        events_dir(home),
        usage_dir(home),
        dir.join("bin"),
    ] {
        create_private_dir(&d)?;
    }
    if let Some(source) = source.filter(|source| source.is_file()) {
        install_hook(source, &hook_binary(home))?;
    }
    write_private(
        &dir.join("kriyon-statusline.sh"),
        STATUSLINE_SCRIPT.as_bytes(),
    )?;
    for old in ["kriyon-hook.py", "kriyon-usage.py"] {
        let _ = std::fs::remove_file(dir.join(old));
    }
    Ok(())
}

/// Put `source` at `dest`, unless the same program is there: copied beside,
/// then renamed in, so a hook never starts a half-written file. On Windows a
/// copy a running hook holds can't be replaced; it is then kept until the
/// next start.
fn install_hook(source: &Path, dest: &Path) -> std::io::Result<()> {
    let same = std::fs::read(dest)
        .ok()
        .zip(std::fs::read(source).ok())
        .is_some_and(|(old, new)| old == new);
    if same {
        return Ok(());
    }
    let partial = dest.with_extension("partial");
    std::fs::copy(source, &partial)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o700))?;
    }
    if let Err(e) = std::fs::rename(&partial, dest) {
        let _ = std::fs::remove_file(&partial);
        if !cfg!(windows) || !dest.is_file() {
            return Err(e);
        }
    }
    Ok(())
}

/// Read `~/.claude/settings.json`, let `edit` change it, and write it back only
/// if it changed. A missing or empty file reads as `{}`. A file that isn't
/// valid JSON is left alone and is an error, rather than risk clobbering the
/// user's configuration.
///
/// # Errors
/// When the file can't be read, parsed or written.
pub fn edit_settings(
    home: &Path,
    edit: impl FnOnce(&mut Value) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let settings_path = home.join(".claude").join("settings.json");
    let before: Value = match std::fs::read_to_string(&settings_path) {
        Ok(text) if text.trim().is_empty() => json!({}),
        Ok(text) => serde_json::from_str(&text).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("~/.claude/settings.json is not valid JSON: {e}"),
            )
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e),
    };
    let mut after = before.clone();
    edit(&mut after)?;
    if after == before {
        return Ok(());
    }
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let serialized = serde_json::to_string_pretty(&after)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    std::fs::write(&settings_path, serialized)
}

/// Install the status-line wrapper, first saving the user's own status line
/// (the whole object, for a faithful restore).
///
/// # Errors
/// When the saved copies can't be written.
pub fn install_statusline(home: &Path, settings: &mut Value) -> std::io::Result<()> {
    use kriyon_core::integration::{wrap_statusline, StatusLineBefore};
    use kriyon_core::private_fs::write_private;
    let (original, inner) = (
        original_statusline_file(home),
        kriyon_dir(home).join("inner-statusline"),
    );
    match wrap_statusline(settings, &statusline_command(home)) {
        StatusLineBefore::Theirs(current) => {
            write_private(&original, current.to_string().as_bytes())?;
            // The wrapper renders the user's own command from this file.
            let command = current
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            write_private(&inner, command.as_bytes())?;
        }
        StatusLineBefore::Ours => {}
        StatusLineBefore::None => {
            let _ = std::fs::remove_file(&original);
            let _ = std::fs::remove_file(&inner);
        }
    }
    Ok(())
}

/// Put the user's own status line back, if Kriyon's wrapper is installed.
pub fn uninstall_statusline(home: &Path, settings: &mut Value) {
    let original = std::fs::read_to_string(original_statusline_file(home))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let inner = std::fs::read_to_string(kriyon_dir(home).join("inner-statusline")).ok();
    kriyon_core::integration::restore_statusline(
        settings,
        original,
        inner.as_deref().filter(|c| !c.trim().is_empty()),
    );
}

/// The user's own status line as it was before Kriyon wrapped it, for display.
#[must_use]
pub fn original_statusline_command(home: &Path) -> Option<String> {
    std::fs::read_to_string(kriyon_dir(home).join("inner-statusline"))
        .ok()
        .filter(|c| !c.trim().is_empty())
}

fn original_statusline_file(home: &Path) -> PathBuf {
    kriyon_dir(home).join("original-statusline.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Managed locations under a temp dir, so the test never reads this Mac's
    /// real managed settings.
    fn temp_managed(dir: &Path) -> ManagedLocations {
        ManagedLocations {
            system_dir: dir.join("ClaudeCode"),
            mdm_plists: vec![dir.join("mdm.plist")],
            remote: dir.join("remote-settings.json"),
        }
    }

    /// A built `kriyon-hook` to install: the staged sidecar, which the
    /// app's own build already requires (`node scripts/sidecar-ptyd.mjs`).
    pub(super) fn built_hook() -> PathBuf {
        let binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        std::fs::read_dir(&binaries)
            .expect("staged sidecars")
            .flatten()
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("kriyon-hook-"))
            })
            .expect("stage it first: node scripts/sidecar-ptyd.mjs")
    }

    #[cfg(unix)]
    #[test]
    fn a_hook_path_with_an_apostrophe_reaches_the_shell_as_one_word() {
        let command = hook_command(Path::new("/Users/O'Neil/.claude/kriyon/bin/kriyon-hook"));
        let quoted = command.strip_suffix(" event").expect("the event mode last");
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("printf '%s|' {quoted}")])
            .output()
            .expect("sh runs");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "/Users/O'Neil/.claude/kriyon/bin/kriyon-hook|"
        );
    }

    /// ADR-0066: the hook is Kriyon's own program, installed under
    /// `~/.claude/kriyon/bin` from the app; no Python anywhere.
    #[test]
    fn the_hook_program_is_installed_and_the_python_scripts_go() {
        let home = tempfile::tempdir().unwrap();
        let dir = kriyon_dir(home.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("kriyon-hook.py"), "old").unwrap();
        std::fs::write(dir.join("kriyon-usage.py"), "old").unwrap();
        assert_eq!(hook_command_for(home.path()), None, "nothing installed yet");
        write_scripts_from(home.path(), Some(&built_hook())).unwrap();
        let installed = hook_binary(home.path());
        assert!(installed.is_file());
        assert!(!dir.join("kriyon-hook.py").exists() && !dir.join("kriyon-usage.py").exists());
        let command = hook_command_for(home.path()).expect("a command");
        assert!(
            command.contains(kriyon_core::hooks::KRIYON_HOOK_MARKER),
            "{command}"
        );
        assert!(
            command.ends_with(" event") && !command.contains("python"),
            "{command}"
        );
        let wrapper = std::fs::read_to_string(dir.join("kriyon-statusline.sh")).unwrap();
        assert!(!wrapper.contains("python"), "{wrapper}");
        // Again: nothing changes, nothing fails.
        write_scripts_from(home.path(), Some(&built_hook())).unwrap();
        assert!(installed.is_file());
    }

    /// The status-line wrapper, run as Claude runs it, keeps the session's
    /// usage and prints the person's own line, else the model's name.
    #[cfg(unix)]
    #[test]
    fn the_status_line_wrapper_keeps_usage_and_prints_a_line() {
        let home = tempfile::tempdir().unwrap();
        write_scripts_from(home.path(), Some(&built_hook())).unwrap();
        let input = r#"{"session_id":"c-1","model":{"display_name":"Opus"},"context_window":{"used_percentage":7}}"#;
        let run = || {
            let mut child = std::process::Command::new("sh")
                .arg(kriyon_dir(home.path()).join("kriyon-statusline.sh"))
                .env("HOME", home.path())
                .env("KRIYON_SESSION", "sess-1")
                .env_remove("KRIYON_TTY")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            {
                use std::io::Write as _;
                child
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(input.as_bytes())
                    .unwrap();
            }
            String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
        };
        assert_eq!(run(), "Opus\n");
        let usage = std::fs::read_to_string(usage_dir(home.path()).join("sess-1.json")).unwrap();
        assert!(usage.contains("\"usedPercentage\": 7"), "{usage}");
        std::fs::write(
            kriyon_dir(home.path()).join("inner-statusline"),
            "echo mine",
        )
        .unwrap();
        assert_eq!(run(), "mine\n");
    }

    #[test]
    fn hooks_off_reads_user_and_project_settings() {
        use kriyon_core::hooks::HooksOff;
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let managed = temp_managed(home.path());
        let write = |dir: &Path, file: &str, body: &str| {
            std::fs::create_dir_all(dir.join(".claude")).unwrap();
            std::fs::write(dir.join(".claude").join(file), body).unwrap();
        };
        let off = || hooks_off_with(&managed, home.path(), cwd.path());
        assert_eq!(off(), None);

        write(home.path(), "settings.json", r#"{"disableAllHooks":true}"#);
        assert_eq!(off(), Some(HooksOff::User));

        // A malformed project file counts as unset, not as an error.
        write(cwd.path(), "settings.json", "{not json");
        assert_eq!(off(), Some(HooksOff::User));

        write(
            cwd.path(),
            "settings.local.json",
            r#"{"disableAllHooks":false}"#,
        );
        assert_eq!(off(), None);
    }

    #[test]
    fn hooks_off_reads_every_managed_source() {
        use kriyon_core::hooks::HooksOff;
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let managed = temp_managed(home.path());
        let drop_ins = managed.system_dir.join("managed-settings.d");
        std::fs::create_dir_all(&drop_ins).unwrap();
        let off = || hooks_off_with(&managed, home.path(), cwd.path());

        // A drop-in alone turns the hooks off.
        std::fs::write(
            drop_ins.join("10.json"),
            r#"{"allowManagedHooksOnly":true}"#,
        )
        .unwrap();
        assert_eq!(off(), Some(HooksOff::Managed));

        // A server-managed policy outranks the file source.
        std::fs::write(&managed.remote, r#"{"model":"opus"}"#).unwrap();
        assert_eq!(off(), None);
        std::fs::write(&managed.remote, r#"{"disableAllHooks":true}"#).unwrap();
        assert_eq!(off(), Some(HooksOff::Managed));
    }

    #[test]
    fn events_file_is_under_kriyon_events_dir() {
        let home = Path::new("/Users/x");
        assert_eq!(
            events_file(home, "abc-123"),
            Path::new("/Users/x/.claude/kriyon/events/abc-123.jsonl")
        );
    }
}
