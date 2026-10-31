use std::collections::HashMap;
use std::path::Path;

/// The pure launch policy for a fresh [Session] shell: everything decidable
/// before any IO. `create_session` still performs the IO (private `ZDOTDIR`
/// tempdir, daemon spawn, socket connect), but the decisions it used to inline
/// behind `#[tauri::command]` — where they could not be unit-tested — live here.
pub struct SpawnPlan {
    /// The working directory to spawn in. An empty request resolves to `home`,
    /// so the frontend can open a session without knowing an absolute path.
    pub cwd: String,
    /// The shell to spawn: `$SHELL`, or `/bin/zsh` when it is unset or empty.
    pub shell: String,
    /// Whether the shell is zsh and so needs a private `ZDOTDIR` for the OSC 133
    /// shell-integration markers (see [`build_zdotdir`]).
    pub needs_zdotdir: bool,
}

impl SpawnPlan {
    /// Resolve the cwd, shell, and zsh-ness for a fresh session shell.
    #[must_use]
    pub fn new(cwd: &str, home: &Path, shell_env: Option<&str>) -> Self {
        let cwd = if cwd.is_empty() {
            home.to_string_lossy().into_owned()
        } else {
            cwd.to_string()
        };
        let shell = user_shell(shell_env);
        let needs_zdotdir = is_zsh(&shell);
        Self {
            cwd,
            shell,
            needs_zdotdir,
        }
    }
}

/// The person's shell: `$SHELL`, or `/bin/zsh` (the macOS default) when it is
/// unset or empty. Session shells and the [Worktree bootstrap] both use it.
#[must_use]
pub fn user_shell(shell_env: Option<&str>) -> String {
    shell_env
        .filter(|s| !s.is_empty())
        .unwrap_or("/bin/zsh")
        .to_string()
}

/// True when the shell path's basename ends with `zsh` (`zsh`, `/bin/zsh`, …).
#[must_use]
pub fn is_zsh(shell: &str) -> bool {
    Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|base| base.ends_with("zsh"))
}

/// True when a path is one of Kriyon's private ZDOTDIR wrappers (basename
/// `kriyon-…`). Used to avoid chaining a new wrapper onto a parent one when
/// Kriyon is launched from inside a Kriyon-managed shell.
fn is_kriyon_wrapper(zdotdir: &str) -> bool {
    Path::new(zdotdir)
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|base| base.starts_with("kriyon-"))
}

/// Resolve the user's *real* ZDOTDIR, seeing through Kriyon's own wrappers.
///
/// Kriyon can be launched from inside a Kriyon-managed shell — a nested session,
/// or (commonly) a dev build started from a terminal. There `$ZDOTDIR` already
/// points at a private Kriyon wrapper; naively trusting it would source the
/// wrong `.zshrc` and pin history to a throwaway temp dir. So the outermost
/// Kriyon records the true original in `$KRIYON_USER_ZDOTDIR` and inner ones
/// reuse it. When that marker is absent (the first Kriyon, or one spawned by an
/// older build), fall back to `$ZDOTDIR` — unless it is itself a wrapper, in
/// which case there is no real custom dir and we resolve to `$HOME`.
///
/// `None` means "$HOME" (no custom ZDOTDIR); an empty recorded marker means the
/// same and is how the `$HOME` default survives nesting.
#[must_use]
pub fn resolve_user_zdotdir(
    recorded_user_zdotdir: Option<&str>,
    zdotdir: Option<&str>,
) -> Option<String> {
    if let Some(recorded) = recorded_user_zdotdir {
        return (!recorded.is_empty()).then(|| recorded.to_string());
    }
    match zdotdir {
        Some(dir) if !dir.is_empty() && !is_kriyon_wrapper(dir) => Some(dir.to_string()),
        _ => None,
    }
}

/// The environment a fresh session shell is spawned with: the `KRIYON_SESSION`
/// hook gate (always — it gates Kriyon's Claude Code hook on this session), plus,
/// when a private ZDOTDIR was created for zsh OSC 133 injection, `ZDOTDIR`,
/// `KRIYON_USER_ZDOTDIR`, and `KRIYON_REAL_ZDOTDIR`.
///
/// `KRIYON_USER_ZDOTDIR` records the user's real ZDOTDIR (empty for the `$HOME`
/// default) so a nested Kriyon resolves the true config via
/// [`resolve_user_zdotdir`] instead of chaining onto this wrapper.
///
/// `KRIYON_REAL_ZDOTDIR` is the *concrete* base path (the real ZDOTDIR, or
/// `home` when there is none) that the wrapper startup files source the user's
/// real config from. Unlike the marker above it is never empty, and the wrappers
/// update it in place: if the user's own `.zshenv` reassigns `ZDOTDIR` (a common
/// way to relocate config to `~/.config/zsh`), the wrapper captures the new value
/// so the later wrappers (`.zprofile`/`.zshrc`/`.zlogin`) follow them there. This
/// mirrors VS Code's `USER_ZDOTDIR` handling.
#[must_use]
pub fn spawn_env(
    session_id: &str,
    zdotdir: Option<&str>,
    user_zdotdir: Option<&str>,
    home: &str,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("KRIYON_SESSION".to_string(), session_id.to_string());
    if let Some(dir) = zdotdir {
        env.insert("ZDOTDIR".to_string(), dir.to_string());
        env.insert(
            "KRIYON_USER_ZDOTDIR".to_string(),
            user_zdotdir.unwrap_or_default().to_string(),
        );
        env.insert(
            "KRIYON_REAL_ZDOTDIR".to_string(),
            user_zdotdir.unwrap_or(home).to_string(),
        );
    }
    env
}

/// A plan for a temporary `ZDOTDIR`: wrapper startup files that re-source the
/// user's real config so redirecting `ZDOTDIR` doesn't drop any of it, with
/// `.zshrc` also injecting Kriyon's OSC 133 shell-integration markers.
///
/// zsh reads *every* startup file — `.zshenv`, `.zprofile`, `.zshrc`, `.zlogin`
/// — from `$ZDOTDIR` (falling back to `$HOME` only when `ZDOTDIR` is unset). By
/// pointing `ZDOTDIR` at our private dir we take over all four, so we must
/// re-source the user's real counterpart for each or it silently never loads.
/// The classic symptom: `~/.zshenv` prepends `~/.cargo/bin` to `PATH`, so
/// without a wrapper `.zshenv`, `cargo` (and anything else configured there)
/// vanishes from Kriyon's terminal while still working in Warp/Terminal.app —
/// which never touch `ZDOTDIR`. This mirrors VS Code's zsh shell integration.
pub struct ZdotdirPlan {
    pub zshenv: String,
    pub zprofile: String,
    pub zshrc: String,
    pub zlogin: String,
}

/// Build the contents of a temporary `.zshrc` that loads the user's real zsh
/// config and appends OSC 133 shell-integration hooks.
///
/// If `real_zdotdir` is `Some(dir)`, the real config is sourced from
/// `<dir>/.zshrc`; otherwise it falls back to `$HOME/.zshrc`. The source line
/// is guarded so that a missing file does not produce an error.
///
/// It also pins `HISTFILE` back to the real history file (`<dir>/.zsh_history`,
/// or `$HOME/.zsh_history`) *before* sourcing. macOS `/etc/zshrc` sets
/// `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` before our rc runs, so redirecting
/// `ZDOTDIR` to the private temp dir would otherwise point history at an empty
/// throwaway file — losing history recall, `Ctrl-R` search, and the
/// autosuggestions plugin (which has nothing to suggest), and silently
/// discarding commands typed in Kriyon. Pinning before the source line means a
/// user who sets their own `HISTFILE=` in `.zshrc` still wins, and zsh reads the
/// file after all rc files, so the corrected value is in effect at read time.
/// This mirrors VS Code's zsh shell-integration handling.
#[must_use]
pub fn build_zdotdir(real_zdotdir: Option<&str>) -> ZdotdirPlan {
    // HISTFILE is pinned to a concrete path (resolved here) rather than the
    // runtime `$KRIYON_REAL_ZDOTDIR`, because it must be corrected *before* the
    // real `.zshrc` is sourced (see the doc comment); the runtime capture var is
    // only guaranteed populated once the wrappers run.
    let histfile_base = real_zdotdir.unwrap_or("$HOME");
    let real_histfile = format!("{histfile_base}/.zsh_history");

    let zshrc = format!(
        "# Generated by Kriyon - do not edit.\n\
         HISTFILE=\"{real_histfile}\"\n\
         {source_block}\n\
         \n\
         autoload -Uz add-zsh-hook\n\
         _kriyon_precmd()  {{ print -n \"\\e]133;D;$?\\a\\e]133;A\\a\" }}\n\
         _kriyon_preexec() {{ print -n \"\\e]133;C\\a\" }}\n\
         add-zsh-hook precmd  _kriyon_precmd\n\
         add-zsh-hook preexec _kriyon_preexec\n",
        source_block = wrap_source_block(".zshrc"),
    );

    ZdotdirPlan {
        zshenv: wrapper_file(".zshenv"),
        zprofile: wrapper_file(".zprofile"),
        zshrc,
        zlogin: wrapper_file(".zlogin"),
    }
}

/// A standalone wrapper startup file (`.zshenv`/`.zprofile`/`.zlogin`) that
/// re-sources the user's real `<name>`.
fn wrapper_file(name: &str) -> String {
    format!(
        "# Generated by Kriyon - do not edit.\n{}\n",
        wrap_source_block(name)
    )
}

/// The guarded source block shared by every wrapper file. It reads the real base
/// dir from `$KRIYON_REAL_ZDOTDIR` (falling back to `$HOME`), and if the user's
/// real `<base>/<name>` exists:
///
/// 1. saves Kriyon's private `ZDOTDIR`,
/// 2. points `ZDOTDIR` back at the real dir so a `$ZDOTDIR` reference inside the
///    user's config resolves to the real dir, not Kriyon's private one,
/// 3. sources the real file (the recursion guard skips it in the impossible case
///    that the real dir *is* Kriyon's private dir),
/// 4. captures `ZDOTDIR` back into `$KRIYON_REAL_ZDOTDIR` — so if the user's
///    `.zshenv` relocated their config by reassigning `ZDOTDIR`, the later
///    wrappers follow them there,
/// 5. restores `ZDOTDIR` to Kriyon's private dir so the *next* startup file (and
///    the `.zshrc` OSC 133 injection) are still read from Kriyon's dir.
///
/// The file-exists guard means a user missing e.g. `~/.zlogin` never sees a
/// startup error. Mirrors VS Code's `shellIntegration-*.zsh` wrappers.
fn wrap_source_block(name: &str) -> String {
    format!(
        "if [ -f \"${{KRIYON_REAL_ZDOTDIR:-$HOME}}/{name}\" ]; then\n  \
         KRIYON_WRAP_ZDOTDIR=\"$ZDOTDIR\"\n  \
         ZDOTDIR=\"${{KRIYON_REAL_ZDOTDIR:-$HOME}}\"\n  \
         [ \"$ZDOTDIR\" != \"$KRIYON_WRAP_ZDOTDIR\" ] && source \"$ZDOTDIR/{name}\"\n  \
         KRIYON_REAL_ZDOTDIR=\"$ZDOTDIR\"\n  \
         ZDOTDIR=\"$KRIYON_WRAP_ZDOTDIR\"\n\
         fi"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zshrc_contains_osc133_markers_and_sources_real_config() {
        let plan = build_zdotdir(Some("/Users/test/.config/zsh"));
        let zshrc = &plan.zshrc;
        assert!(zshrc.contains("133;A"));
        assert!(zshrc.contains("133;C"));
        assert!(zshrc.contains("add-zsh-hook"));
        // The real .zshrc is sourced via the runtime base var, not a baked path,
        // so a ZDOTDIR the user reassigns in ~/.zshenv is honored (see capture).
        assert!(zshrc.contains("source \"$ZDOTDIR/.zshrc\""));
        assert!(zshrc.contains("KRIYON_REAL_ZDOTDIR"));
    }

    #[test]
    fn zshrc_defaults_to_home_when_the_base_var_is_unset() {
        // With no real base recorded, the wrapper falls back to $HOME at runtime.
        let plan = build_zdotdir(None);
        assert!(plan.zshrc.contains("${KRIYON_REAL_ZDOTDIR:-$HOME}/.zshrc"));
    }

    #[test]
    fn wraps_zshenv_zprofile_zlogin_so_zdotdir_redirect_does_not_drop_them() {
        // Redirecting ZDOTDIR to Kriyon's private dir makes zsh read *all four*
        // startup files (.zshenv, .zprofile, .zshrc, .zlogin) from there, not
        // just .zshrc. Without wrappers for the other three, the user's real
        // ~/.zshenv (where PATH additions like cargo live), ~/.zprofile, and
        // ~/.zlogin never load — tools silently vanish from the terminal.
        let plan = build_zdotdir(None);
        assert!(plan.zshenv.contains("/.zshenv\""));
        assert!(plan.zshenv.contains("source"));
        assert!(plan.zprofile.contains("/.zprofile\""));
        assert!(plan.zprofile.contains("source"));
        assert!(plan.zlogin.contains("/.zlogin\""));
        assert!(plan.zlogin.contains("source"));
    }

    #[test]
    fn wrappers_capture_a_zdotdir_the_user_reassigns_in_their_own_config() {
        // The whole point of the capture: after sourcing the user's real file
        // (which may relocate config by reassigning ZDOTDIR), write the possibly
        // new ZDOTDIR back into the base var so the later wrappers follow it.
        let plan = build_zdotdir(None);
        for body in [&plan.zshenv, &plan.zprofile, &plan.zshrc, &plan.zlogin] {
            assert!(body.contains("KRIYON_REAL_ZDOTDIR=\"$ZDOTDIR\""));
        }
    }

    #[test]
    fn wrappers_swap_zdotdir_to_the_real_base_while_sourcing_then_restore_it() {
        // Each wrapper points ZDOTDIR back at the real base while sourcing (so a
        // `$ZDOTDIR` reference inside the user's config resolves correctly),
        // then restores ZDOTDIR to Kriyon's private dir so the next startup
        // file — and Kriyon's own OSC 133 injection — still take effect.
        let plan = build_zdotdir(None);
        for body in [&plan.zshenv, &plan.zprofile, &plan.zlogin] {
            assert!(body.contains("ZDOTDIR=\"${KRIYON_REAL_ZDOTDIR:-$HOME}\""));
            assert!(body.contains("ZDOTDIR=\"$KRIYON_WRAP_ZDOTDIR\""));
        }
    }

    #[test]
    fn wrappers_guard_missing_files_so_a_shell_never_errors() {
        // A user with no ~/.zlogin must not get a "no such file" error at
        // startup; every wrapper guards the source with a file-exists test.
        let plan = build_zdotdir(None);
        for body in [&plan.zshenv, &plan.zprofile, &plan.zlogin] {
            assert!(body.contains("[ -f"));
        }
    }

    #[test]
    fn zshrc_pins_histfile_to_home_when_no_zdotdir() {
        // macOS /etc/zshrc sets HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history before our
        // rc runs; with ZDOTDIR redirected to the temp dir that resolves to an
        // empty file, so history (and autosuggestions) never load. Pin it back.
        let plan = build_zdotdir(None);
        assert!(plan.zshrc.contains("HISTFILE=\"$HOME/.zsh_history\""));
    }

    #[test]
    fn zshrc_pins_histfile_under_the_real_zdotdir() {
        // Mirror /etc/zshrc's ${ZDOTDIR:-$HOME} derivation: a user with a real
        // ZDOTDIR keeps history there, not in $HOME.
        let plan = build_zdotdir(Some("/Users/test/.config/zsh"));
        assert!(plan
            .zshrc
            .contains("HISTFILE=\"/Users/test/.config/zsh/.zsh_history\""));
    }

    #[test]
    fn zshrc_pins_histfile_before_sourcing_so_a_user_override_wins() {
        // The pin must precede `source`: zsh reads the history file after all rc
        // files, so setting it before the user's config both loads history and
        // lets a user's own `HISTFILE=` in their .zshrc take precedence.
        let plan = build_zdotdir(None);
        let hist = plan.zshrc.find("HISTFILE=").expect("HISTFILE pin present");
        let source = plan.zshrc.find("source").expect("source line present");
        assert!(hist < source, "HISTFILE must be pinned before sourcing");
    }

    #[test]
    fn is_zsh_matches_only_a_zsh_basename() {
        assert!(is_zsh("/bin/zsh"));
        assert!(is_zsh("zsh"));
        assert!(is_zsh("/opt/homebrew/bin/zsh"));
        assert!(!is_zsh("/bin/bash"));
        assert!(!is_zsh("/usr/bin/fish"));
        assert!(!is_zsh(""));
    }

    #[test]
    fn spawn_plan_resolves_empty_cwd_to_home() {
        let plan = SpawnPlan::new("", Path::new("/Users/me"), Some("/bin/zsh"));
        assert_eq!(plan.cwd, "/Users/me");
        assert_eq!(plan.shell, "/bin/zsh");
        assert!(plan.needs_zdotdir);
    }

    #[test]
    fn spawn_plan_keeps_a_non_empty_cwd() {
        let plan = SpawnPlan::new("/work/proj", Path::new("/Users/me"), Some("/bin/bash"));
        assert_eq!(plan.cwd, "/work/proj");
        assert_eq!(plan.shell, "/bin/bash");
        assert!(!plan.needs_zdotdir);
    }

    #[test]
    fn spawn_plan_defaults_shell_when_unset_or_empty() {
        assert_eq!(
            SpawnPlan::new("/w", Path::new("/h"), None).shell,
            "/bin/zsh"
        );
        assert_eq!(
            SpawnPlan::new("/w", Path::new("/h"), Some("")).shell,
            "/bin/zsh"
        );
    }

    #[test]
    fn spawn_env_always_gates_the_hook_and_adds_zdotdir_only_when_present() {
        let base = spawn_env("sess-1", None, None, "/Users/me");
        assert_eq!(base.get("KRIYON_SESSION"), Some(&"sess-1".to_string()));
        assert!(!base.contains_key("ZDOTDIR"));
        assert!(!base.contains_key("KRIYON_USER_ZDOTDIR"));
        assert!(!base.contains_key("KRIYON_REAL_ZDOTDIR"));

        let with = spawn_env(
            "sess-1",
            Some("/tmp/kriyon-xyz"),
            Some("/Users/me/.config/zsh"),
            "/Users/me",
        );
        assert_eq!(with.get("KRIYON_SESSION"), Some(&"sess-1".to_string()));
        assert_eq!(with.get("ZDOTDIR"), Some(&"/tmp/kriyon-xyz".to_string()));
        // The real ZDOTDIR is recorded so a nested Kriyon can see through this
        // wrapper instead of chaining onto it.
        assert_eq!(
            with.get("KRIYON_USER_ZDOTDIR"),
            Some(&"/Users/me/.config/zsh".to_string())
        );
        // The concrete base the wrapper startup files source from.
        assert_eq!(
            with.get("KRIYON_REAL_ZDOTDIR"),
            Some(&"/Users/me/.config/zsh".to_string())
        );
    }

    #[test]
    fn spawn_env_records_empty_user_zdotdir_for_the_home_default() {
        // No custom ZDOTDIR → record an empty marker so a nested Kriyon resolves
        // back to $HOME rather than treating the wrapper as the real dir.
        let env = spawn_env("s", Some("/tmp/kriyon-xyz"), None, "/Users/me");
        assert_eq!(env.get("KRIYON_USER_ZDOTDIR"), Some(&String::new()));
    }

    #[test]
    fn spawn_env_falls_back_to_home_for_the_real_base_when_no_zdotdir() {
        // The base var is never empty: with no custom ZDOTDIR it is the concrete
        // home path, so the wrappers source ~/.zshenv etc. from the right place.
        let env = spawn_env("s", Some("/tmp/kriyon-xyz"), None, "/Users/me");
        assert_eq!(
            env.get("KRIYON_REAL_ZDOTDIR"),
            Some(&"/Users/me".to_string())
        );
    }

    #[test]
    fn resolve_user_zdotdir_reuses_the_recorded_original_when_nested() {
        // A nested Kriyon must reuse the recorded original, ignoring the parent
        // wrapper in $ZDOTDIR.
        assert_eq!(
            resolve_user_zdotdir(Some("/Users/me/.config/zsh"), Some("/tmp/kriyon-abc")),
            Some("/Users/me/.config/zsh".to_string())
        );
    }

    #[test]
    fn resolve_user_zdotdir_empty_recorded_marker_means_home() {
        assert_eq!(
            resolve_user_zdotdir(Some(""), Some("/tmp/kriyon-abc")),
            None
        );
    }

    #[test]
    fn resolve_user_zdotdir_uses_a_real_zdotdir_when_not_recorded() {
        assert_eq!(
            resolve_user_zdotdir(None, Some("/Users/me/.config/zsh")),
            Some("/Users/me/.config/zsh".to_string())
        );
    }

    #[test]
    fn resolve_user_zdotdir_refuses_to_chain_onto_a_kriyon_wrapper() {
        // Launched from an older Kriyon shell: $ZDOTDIR is a wrapper and no
        // original was recorded. Do not chain — fall back to $HOME.
        assert_eq!(
            resolve_user_zdotdir(None, Some("/var/folders/x/T/kriyon-fUHnf0")),
            None
        );
    }

    #[test]
    fn resolve_user_zdotdir_defaults_to_home_when_nothing_is_set() {
        assert_eq!(resolve_user_zdotdir(None, None), None);
    }
}
