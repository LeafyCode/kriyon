//! The [Integration]: everything Kriyon adds to Claude Code, applied from the
//! user's [Integration prefs]. Nothing is written before the welcome screen's
//! consent. After it:
//!
//! - **Hooks** go in the companion folder, loaded only by Kriyon's sessions
//!   through `CLAUDE_CODE_PLUGIN_DIRS`, so `~/.claude/settings.json` holds none
//!   of Kriyon's hooks. When the org blocks side-loading (or Kriyon can't
//!   tell), they go in `settings.json` instead, env-gated.
//! - **The status-line wrapper** (live usage) can only live in `settings.json`
//!   — a plugin can't supply a status line. The user's own status line is
//!   saved and restored when the switch goes off.
//!
//! The pure decisions are in `kriyon_core::integration`.

use std::path::{Path, PathBuf};

use kriyon_core::integration::{
    hook_route, plugin_hooks, plugin_manifest, remove_hook_config, HookRoute, IntegrationPrefs,
};
use kriyon_core::policy::SideloadPolicy;
use serde::Serialize;

use crate::hooks;

/// The app-state key the prefs are saved under in `kriyon.db`.
const PREFS_KEY: &str = "integration";

/// What applying the prefs did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub route: HookRoute,
    /// The companion folder to put in `CLAUDE_CODE_PLUGIN_DIRS`, on the
    /// plugin route.
    pub companion_dir: Option<PathBuf>,
}

impl Default for Applied {
    fn default() -> Self {
        Self {
            route: HookRoute::Off,
            companion_dir: None,
        }
    }
}

/// The live [Integration]: the prefs and what applying them did.
#[derive(Debug, Default)]
pub struct IntegrationState {
    pub prefs: IntegrationPrefs,
    pub applied: Applied,
}

use kriyon_core::paths::companion_root;

/// Write the companion folder for `version` — owner-only, never a symlink.
/// Claude Code writes `.claude-plugin/types/`
/// into it at load, so the folder stays writable.
fn write_companion(home: &Path, version: &str, with_mod: bool) -> std::io::Result<PathBuf> {
    use kriyon_core::private_fs::{create_private_dir, write_private};
    let root = companion_root(home);
    let dir = root.join(version);
    // The code that runs must be the code Kriyon wrote: never write through a
    // symlink someone put in its place.
    for path in [&root, &dir] {
        if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            std::fs::remove_file(path)?;
        }
    }
    for d in [dir.join(".claude-plugin"), dir.join("hooks")] {
        create_private_dir(&d)?;
    }
    write_private(
        &dir.join(".claude-plugin").join("plugin.json"),
        plugin_manifest(version).as_bytes(),
    )?;
    let module = dir.join("hooks").join("companion.js");
    if with_mod {
        write_private(
            &module,
            kriyon_core::integration::COMPANION_MODULE.as_bytes(),
        )?;
    } else {
        let _ = std::fs::remove_file(&module);
    }
    write_private(
        &dir.join("hooks").join("hooks.json"),
        plugin_hooks(
            &hooks::hook_command_for(home),
            with_mod.then_some(kriyon_core::integration::COMPANION_MODULE_PATH),
        )
        .as_bytes(),
    )?;
    // Older versions stay: a shell started before an update still names its
    // folder in CLAUDE_CODE_PLUGIN_DIRS. They are a few kilobytes each and go
    // when the user removes the integration.
    kriyon_core::private_fs::lock_down(&root)?;
    Ok(dir)
}

/// Apply `prefs` under the org's side-loading `policy`: write or remove the
/// scripts, the companion folder and the `settings.json` entries so they match.
/// Before consent nothing is touched.
///
/// # Errors
/// When a file can't be written, or `settings.json` isn't valid JSON (then it
/// is left as it was).
pub fn apply(
    home: &Path,
    prefs: IntegrationPrefs,
    policy: SideloadPolicy,
    version: &str,
) -> std::io::Result<Applied> {
    let route = hook_route(prefs, policy);
    if !prefs.consented {
        return Ok(Applied::default());
    }
    hooks::write_scripts(home)?;
    hooks::edit_settings(home, |settings| {
        if route == HookRoute::Settings {
            kriyon_core::hooks::merge_hook_config(
                settings,
                &hooks::hook_command_for(home),
                kriyon_core::hooks::REGISTERED_HOOK_EVENTS,
            );
        } else {
            remove_hook_config(settings);
        }
        if prefs.live_usage {
            hooks::install_statusline(home, settings)
        } else {
            hooks::uninstall_statusline(home, settings);
            // Without the wrapper nothing updates the readings; drop them so
            // no frozen limit outlives the switch (ADR-0038).
            let _ = std::fs::remove_dir_all(kriyon_core::paths::limits_dir(home));
            Ok(())
        }
    })?;
    let companion_dir = if route == HookRoute::Plugin {
        Some(write_companion(home, version, prefs.companion)?)
    } else {
        let _ = std::fs::remove_dir_all(companion_root(home));
        None
    };
    Ok(Applied {
        route,
        companion_dir,
    })
}

/// Serializes every read-modify-write of `settings.json` and the companion
/// folder: a launch, a Settings change, a refusal and a spawn-time policy
/// change could otherwise apply at once. Always taken before `integration`.
static APPLYING: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// The saved prefs, or the defaults (not consented) when none are saved.
#[must_use]
pub fn load_prefs(store: &crate::store::Store) -> IntegrationPrefs {
    store
        .load_layout(PREFS_KEY)
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn save_prefs(store: &crate::store::Store, prefs: IntegrationPrefs) -> Result<(), String> {
    let json = serde_json::to_string(&prefs).map_err(|e| e.to_string())?;
    store
        .save_layout(PREFS_KEY, &json)
        .map_err(|e| e.to_string())
}

fn app_version<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

/// Apply the saved prefs at launch and remember the result. Best-effort: a
/// failure is logged and status simply won't update.
pub fn startup<R: tauri::Runtime>(app: &tauri::AppHandle<R>, home: &Path) {
    use tauri::Manager as _;
    let _applying = APPLYING.lock();
    let prefs = load_prefs(&app.state::<crate::StoreState>().0.lock());
    let applied = apply(
        home,
        prefs,
        crate::policy::sideload_policy(home),
        &app_version(app),
    )
    .unwrap_or_else(|e| {
        eprintln!("kriyon: could not apply the Claude Code integration: {e}");
        Applied::default()
    });
    *app.state::<crate::AppState>().integration.lock() = IntegrationState { prefs, applied };
}

/// The env a new session's shell gets for the companion folder, if any.
#[must_use]
pub fn plugin_dirs_env(state: &IntegrationState) -> Option<String> {
    let dir = state.applied.companion_dir.as_ref()?;
    Some(kriyon_core::integration::plugin_dirs_value(
        std::env::var("CLAUDE_CODE_PLUGIN_DIRS").ok().as_deref(),
        &dir.to_string_lossy(),
    ))
}

/// `claude` refused the companion folder (managed `disableSideloadFlags`):
/// never inject it again on this Mac, move the hooks to the settings route the
/// user already agreed to as the fallback, and tell the UI.
pub fn note_sideload_refused<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::{Emitter as _, Manager as _};
    let Ok(home) = app.path().home_dir() else {
        return;
    };
    let _applying = APPLYING.lock();
    let state = app.state::<crate::AppState>();
    let mut current = state.integration.lock();
    if current.prefs.sideload_refused {
        return;
    }
    let prefs = IntegrationPrefs {
        sideload_refused: true,
        ..current.prefs
    };
    if let Err(e) = save_prefs(&app.state::<crate::StoreState>().0.lock(), prefs) {
        eprintln!("kriyon: could not save the side-loading refusal: {e}");
    }
    let applied = apply(
        &home,
        prefs,
        crate::policy::sideload_policy(&home),
        &app_version(app),
    )
    .unwrap_or_else(|e| {
        eprintln!("kriyon: could not move hooks after the refusal: {e}");
        Applied::default()
    });
    *current = IntegrationState { prefs, applied };
    let _ = app.emit("integration-refused", status(&home, &current));
}

pub use kriyon_core::paths::bridge_spool;

/// The bridge socket for a session whose daemon socket is `socket`, when the
/// path is short enough for the mod to reach. Named `<id>.b`, three bytes
/// shorter than the daemon's `<id>.sock`, so it fits whenever the daemon's does.
#[must_use]
pub fn bridge_socket(socket: &Path) -> Option<PathBuf> {
    let path = socket.with_extension("b");
    (path.as_os_str().len() <= kriyon_core::integration::MAX_SOCKET_PATH).then_some(path)
}

/// Whether new sessions should get the companion: turned on, and the hooks
/// are on the plugin route (the mod rides in the same folder).
#[must_use]
pub fn companion_enabled(state: &IntegrationState) -> bool {
    state.prefs.companion && state.applied.route == HookRoute::Plugin
}

/// One session's companion, for the session header's chip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub state: kriyon_core::integration::CompanionState,
    /// The Claude Code version the mod reported.
    pub claude_version: Option<String>,
}

/// One session's [Companion state].
///
/// # Errors
/// On an invalid id or a missing HOME.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn companion_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
) -> Result<CompanionStatus, String> {
    kriyon_core::daemon::check_session_id(&session_id)?;
    let home = crate::commands::resolve_home(&app)?;
    // The session's own conversation, as Kriyon recorded it.
    let conversation = tauri::Manager::state::<crate::StoreState>(&app)
        .0
        .lock()
        .session_row(&session_id)
        .ok()
        .flatten()
        .and_then(|r| r.claude_session_id);
    let bridge = crate::activity_rt::companion_facts(&session_id, conversation.as_deref());
    let id = kriyon_core::session::SessionId(session_id);
    let injected = state.bridged.lock().contains(&id);
    let facts = kriyon_core::integration::CompanionFacts {
        // A session launched with the companion runs it until it restarts,
        // whatever Settings say now.
        enabled: injected || companion_enabled(&state.integration.lock()),
        org_blocks_mods: crate::policy::managed_policy(&crate::policy::ManagedLocations::for_home(
            &home,
        ))
        .mods_blocked_by_org(),
        // A new session is asked about while its shell is still starting;
        // until it is registered, "not injected" means "not yet".
        launched: state.sessions.lock().contains_key(&id),
        injected,
        bridge_seen: bridge.as_ref().is_some_and(|b| b.live),
        hooks_seen: state
            .runtimes
            .lock()
            .get(&id)
            .is_some_and(kriyon_core::runtime::SessionRuntime::is_hook_driven),
    };
    Ok(CompanionStatus {
        state: kriyon_core::integration::companion_state(facts),
        claude_version: bridge.and_then(|b| b.claude_version),
    })
}

/// What a new session's shell gets from the [Integration]: the env to add and
/// whether its companion can reach Kriyon. Decided once, at spawn.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LaunchPlan {
    pub env: Vec<(String, String)>,
    /// The shell carries the bridge socket, so its companion can post.
    pub bridged: bool,
}

/// The [`LaunchPlan`] for a session whose daemon socket is `socket`, given
/// whether the org allows side-loading right now. With side-loading not
/// allowed, nothing is injected (`claude` would exit at startup).
#[must_use]
pub fn launch_plan(state: &IntegrationState, sideload_ok: bool, socket: &Path) -> LaunchPlan {
    if !sideload_ok {
        return LaunchPlan::default();
    }
    let mut plan = LaunchPlan::default();
    if let Some(dirs) = plugin_dirs_env(state) {
        plan.env.push(("CLAUDE_CODE_PLUGIN_DIRS".to_string(), dirs));
    }
    let bridge = companion_enabled(state)
        .then(|| bridge_socket(socket))
        .flatten();
    if let Some(bridge) = bridge {
        plan.env.push((
            "KRIYON_BRIDGE_SOCKET".to_string(),
            bridge.to_string_lossy().into_owned(),
        ));
        plan.bridged = true;
    }
    plan
}

/// Prepare a new session's launch: re-read the org's side-loading policy
/// (it can change while Kriyon runs), move the hooks off the plugin route
/// first if it now forbids them, and return the [`LaunchPlan`].
pub fn prepare_launch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    home: &Path,
    socket: &Path,
) -> LaunchPlan {
    use tauri::Manager as _;
    let sideload_ok = crate::policy::sideload_policy(home) == SideloadPolicy::Allowed;
    let state = app.state::<crate::AppState>();
    let stale_route = !sideload_ok && state.integration.lock().applied.route == HookRoute::Plugin;
    if stale_route {
        // Before the spawn, so the fallback hooks exist when this `claude` starts.
        startup(app, home);
    }
    let integration = state.integration.lock();
    launch_plan(&integration, sideload_ok, socket)
}

/// What the welcome screen and Settings show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub prefs: IntegrationPrefs,
    pub route: HookRoute,
    /// Where the hooks would go once agreed to: what the welcome screen
    /// promises, decided by the same rule as the real route.
    pub planned_route: HookRoute,
    /// Why the hooks are where they are now, and would be once agreed to.
    pub route_reason: kriyon_core::integration::RouteReason,
    pub planned_reason: kriyon_core::integration::RouteReason,
    /// The companion can be turned on (it rides on the plugin route).
    pub companion_available: bool,
    pub sideload: SideloadPolicy,
    pub companion_dir: Option<String>,
    /// The user's own status-line command, as saved before Kriyon wrapped it.
    pub original_status_line: Option<String>,
}

fn status(home: &Path, state: &IntegrationState) -> IntegrationStatus {
    use kriyon_core::integration::route_reason;
    let sideload = crate::policy::sideload_policy(home);
    let planned = IntegrationPrefs {
        consented: true,
        status_hooks: true,
        ..state.prefs
    };
    IntegrationStatus {
        prefs: state.prefs,
        route: state.applied.route,
        planned_route: hook_route(planned, sideload),
        route_reason: route_reason(state.prefs, sideload),
        planned_reason: route_reason(planned, sideload),
        companion_available: hook_route(planned, sideload) == HookRoute::Plugin,
        sideload,
        companion_dir: state
            .applied
            .companion_dir
            .as_ref()
            .map(|d| d.to_string_lossy().into_owned()),
        original_status_line: hooks::original_statusline_command(home),
    }
}

/// The [Integration] as it stands.
///
/// # Errors
/// When HOME can't be resolved.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn integration_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<IntegrationStatus, String> {
    let home = crate::commands::resolve_home(&app)?;
    Ok(status(&home, &state.integration.lock()))
}

/// Save new prefs and apply them. Consent is given by setting `consented`.
/// `sideload_refused` is Kriyon's own finding: the UI can only clear it.
///
/// # Errors
/// When the prefs can't be saved or applied.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn integration_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    store: tauri::State<'_, crate::StoreState>,
    prefs: IntegrationPrefs,
) -> Result<IntegrationStatus, String> {
    let home = crate::commands::resolve_home(&app)?;
    let _applying = APPLYING.lock();
    let mut current = state.integration.lock();
    // The UI may clear the refusal (to try the plugin again), never set it.
    let prefs = IntegrationPrefs {
        sideload_refused: current.prefs.sideload_refused && prefs.sideload_refused,
        ..prefs
    };
    save_prefs(&store.0.lock(), prefs)?;
    let applied = apply(
        &home,
        prefs,
        crate::policy::sideload_policy(&home),
        &app_version(&app),
    )
    .map_err(|e| e.to_string())?;
    *current = IntegrationState { prefs, applied };
    Ok(status(&home, &current))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn settings(home: &Path) -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(home.join(".claude/settings.json")).unwrap_or_default(),
        )
        .unwrap_or(Value::Null)
    }

    fn write_settings(home: &Path, value: &Value) {
        std::fs::create_dir_all(home.join(".claude")).expect("dir");
        std::fs::write(home.join(".claude/settings.json"), value.to_string()).expect("write");
    }

    fn consented() -> IntegrationPrefs {
        IntegrationPrefs {
            consented: true,
            ..IntegrationPrefs::default()
        }
    }

    const USERS: &str =
        r#"{"model":"opus","statusLine":{"type":"command","command":"my-bar","padding":1}}"#;

    #[test]
    fn nothing_is_written_before_consent() {
        let home = tempfile::tempdir().expect("tempdir");
        let applied = apply(
            home.path(),
            IntegrationPrefs::default(),
            SideloadPolicy::Allowed,
            "1",
        )
        .expect("applies");
        assert_eq!(applied, Applied::default());
        assert!(!home.path().join(".claude").exists());
    }

    #[test]
    fn the_plugin_route_keeps_hooks_out_of_settings_and_writes_the_companion() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut before: Value = serde_json::from_str(USERS).expect("json");
        kriyon_core::hooks::merge_hook_config(
            &mut before,
            "python3 '/old/kriyon-hook.py'",
            &["Stop"],
        );
        write_settings(home.path(), &before);

        let applied =
            apply(home.path(), consented(), SideloadPolicy::Allowed, "1.2.3").expect("applies");

        assert_eq!(applied.route, HookRoute::Plugin);
        let dir = applied.companion_dir.expect("a companion folder");
        assert!(dir.join(".claude-plugin/plugin.json").is_file());
        assert!(dir.join("hooks/hooks.json").is_file());
        let after = settings(home.path());
        assert!(
            after.get("hooks").is_none(),
            "the old global hooks are gone"
        );
        assert!(after["statusLine"]["command"]
            .as_str()
            .is_some_and(|c| c.contains("kriyon-statusline")));
        assert_eq!(after["model"], "opus");
    }

    #[test]
    fn a_blocked_org_gets_the_settings_route() {
        let home = tempfile::tempdir().expect("tempdir");
        let applied =
            apply(home.path(), consented(), SideloadPolicy::Unknown, "1").expect("applies");
        assert_eq!(applied.route, HookRoute::Settings);
        assert_eq!(applied.companion_dir, None);
        assert!(settings(home.path())["hooks"]["Stop"].is_array());
    }

    #[test]
    fn turning_everything_off_puts_settings_back_as_they_were() {
        let home = tempfile::tempdir().expect("tempdir");
        let original: Value = serde_json::from_str(USERS).expect("json");
        write_settings(home.path(), &original);
        apply(home.path(), consented(), SideloadPolicy::Blocked, "1").expect("applies");
        assert_ne!(settings(home.path()), original);

        let off = IntegrationPrefs {
            status_hooks: false,
            live_usage: false,
            ..consented()
        };
        let applied = apply(home.path(), off, SideloadPolicy::Blocked, "1").expect("applies");

        assert_eq!(applied.route, HookRoute::Off);
        assert_eq!(
            settings(home.path()),
            original,
            "status line object restored whole"
        );
        assert!(!companion_root(home.path()).exists());
    }

    #[test]
    fn a_settings_file_that_is_not_json_is_left_alone() {
        let home = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(home.path().join(".claude")).expect("dir");
        std::fs::write(home.path().join(".claude/settings.json"), "{oops").expect("write");
        assert!(apply(home.path(), consented(), SideloadPolicy::Allowed, "1").is_err());
        assert_eq!(
            std::fs::read_to_string(home.path().join(".claude/settings.json")).expect("read"),
            "{oops"
        );
    }

    #[test]
    fn the_companion_mod_is_written_only_when_turned_on() {
        let home = tempfile::tempdir().expect("tempdir");
        let with = IntegrationPrefs {
            companion: true,
            ..consented()
        };
        let dir = apply(home.path(), with, SideloadPolicy::Allowed, "1")
            .expect("applies")
            .companion_dir
            .expect("a folder");
        assert!(dir.join("hooks/companion.js").is_file());
        let hooks = std::fs::read_to_string(dir.join("hooks/hooks.json")).expect("read");
        assert!(hooks.contains("companion.js"));

        let without = IntegrationPrefs {
            companion: false,
            ..consented()
        };
        apply(home.path(), without, SideloadPolicy::Allowed, "1").expect("applies");
        assert!(!dir.join("hooks/companion.js").exists(), "turned off: gone");
    }

    #[test]
    fn the_bridge_socket_sits_beside_the_daemon_socket_when_short_enough() {
        assert_eq!(
            bridge_socket(Path::new("/h/.claude/kriyon/run/abc.sock")),
            Some(PathBuf::from("/h/.claude/kriyon/run/abc.b"))
        );
        let long = format!("/{}/abc.sock", "x".repeat(100));
        assert_eq!(bridge_socket(Path::new(&long)), None);
    }

    #[test]
    fn the_bridge_socket_fits_whenever_the_daemon_socket_does() {
        // macOS takes a socket path of up to 103 bytes. A real one: a smoke
        // build's run folder under a 6-letter user name is 99 bytes, and its
        // `.b.sock` bridge (103) was refused, silently leaving the companion off.
        let run = "/Users/abcdef/.claude/kriyon/run-com.leafycode.kriyon.smoke";
        let socket = format!("{run}/f399c5bc-3831-4f2c-b8b6-ef253833cbfb.sock");
        assert!(bridge_socket(Path::new(&socket)).is_some());
        let longest = format!("/{}.sock", "x".repeat(97));
        assert_eq!(longest.len(), 103);
        assert!(bridge_socket(Path::new(&longest)).is_some());
    }

    #[test]
    fn the_launch_plan_injects_only_what_policy_and_prefs_allow() {
        let state = IntegrationState {
            prefs: IntegrationPrefs {
                companion: true,
                ..consented()
            },
            applied: Applied {
                route: HookRoute::Plugin,
                companion_dir: Some(PathBuf::from("/k/companion/1")),
            },
        };
        let socket = Path::new("/h/.claude/kriyon/run/abc.sock");
        let plan = launch_plan(&state, true, socket);
        let keys: Vec<&str> = plan.env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["CLAUDE_CODE_PLUGIN_DIRS", "KRIYON_BRIDGE_SOCKET"]);
        assert!(plan.bridged);

        assert_eq!(
            launch_plan(&state, false, socket),
            LaunchPlan::default(),
            "policy forbids"
        );
        let no_mod = IntegrationState {
            prefs: IntegrationPrefs {
                companion: false,
                ..consented()
            },
            applied: state.applied.clone(),
        };
        let plan = launch_plan(&no_mod, true, socket);
        assert!(!plan.bridged);
        assert_eq!(plan.env.len(), 1, "hooks only");
    }

    #[test]
    fn the_companion_env_appends_to_the_users_own_value() {
        let state = IntegrationState {
            prefs: consented(),
            applied: Applied {
                route: HookRoute::Plugin,
                companion_dir: Some(PathBuf::from("/k/companion/1")),
            },
        };
        assert!(plugin_dirs_env(&state).is_some_and(|v| v.ends_with("/k/companion/1")));
        assert_eq!(plugin_dirs_env(&IntegrationState::default()), None);
    }
}
