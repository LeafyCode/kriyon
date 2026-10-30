//! The [Integration]: what Kriyon adds to Claude Code, decided from the user's
//! [Integration prefs] and the org's [Side-loading] policy. Pure JSON and
//! string work; the shell (`src-tauri/src/integration.rs`) does the file IO.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hooks::{is_kriyon_entry, REGISTERED_HOOK_EVENTS};
use crate::policy::SideloadPolicy;

/// The companion plugin's name. Never carries "Claude" (ADR-0030).
pub const PLUGIN_NAME: &str = "kriyon-companion";

/// What the user agreed to on the welcome screen, and the switches they set
/// since. Until `consented`, Kriyon writes nothing for Claude Code.
// Independent on/off switches, saved as the user set them: not a state machine.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IntegrationPrefs {
    pub consented: bool,
    /// Kriyon's hooks, for live status and the activity log.
    pub status_hooks: bool,
    /// The status-line wrapper, for live usage and plan limits.
    pub live_usage: bool,
    /// The companion mod: offered on, since the Structured view needs it.
    pub companion: bool,
    /// Claude refused the companion folder at startup (managed
    /// `disableSideloadFlags`), so it is never offered again on this Mac.
    pub sideload_refused: bool,
}

impl Default for IntegrationPrefs {
    /// What the welcome screen offers, pre-checked.
    fn default() -> Self {
        Self {
            consented: false,
            status_hooks: true,
            live_usage: true,
            companion: true,
            sideload_refused: false,
        }
    }
}

/// Where Kriyon's hooks are installed — the [Hook route].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HookRoute {
    /// In the companion folder, loaded only by Kriyon's sessions through
    /// `CLAUDE_CODE_PLUGIN_DIRS`. The user's settings are untouched.
    Plugin,
    /// In `~/.claude/settings.json`: the fallback when the org blocks
    /// side-loading (or Kriyon can't tell). Env-gated, so inert outside Kriyon.
    Settings,
    /// Not installed.
    Off,
}

/// The [Hook route] for `prefs` under the org's side-loading `policy`. An
/// unknown policy counts as blocked: side-loading under `disableSideloadFlags`
/// makes `claude` exit at startup.
#[must_use]
pub fn hook_route(prefs: IntegrationPrefs, policy: SideloadPolicy) -> HookRoute {
    if !prefs.consented || !prefs.status_hooks {
        return HookRoute::Off;
    }
    if policy == SideloadPolicy::Allowed && !prefs.sideload_refused {
        HookRoute::Plugin
    } else {
        HookRoute::Settings
    }
}

/// Why the hooks are on the route they are — what the UI explains, decided
/// by the same rule as [`hook_route`] so the two can't disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteReason {
    /// Loaded per session as a plugin.
    Plugin,
    /// The org's managed settings forbid side-loading.
    OrgBlocks,
    /// Kriyon couldn't read the org's policy, so it plays safe.
    PolicyUnknown,
    /// `claude` refused the plugin folder once on this Mac.
    Refused,
    /// The hooks are off (no consent yet, or turned off).
    Off,
}

/// The [`RouteReason`] for `prefs` under `policy`.
#[must_use]
pub fn route_reason(prefs: IntegrationPrefs, policy: SideloadPolicy) -> RouteReason {
    match hook_route(prefs, policy) {
        HookRoute::Off => RouteReason::Off,
        HookRoute::Plugin => RouteReason::Plugin,
        HookRoute::Settings if prefs.sideload_refused => RouteReason::Refused,
        HookRoute::Settings if policy == SideloadPolicy::Blocked => RouteReason::OrgBlocks,
        HookRoute::Settings => RouteReason::PolicyUnknown,
    }
}

/// Remove every hook entry Kriyon installed from a `settings.json` value,
/// dropping an event list or `hooks` object it leaves empty, so the file reads
/// as it did before Kriyon. Everything else is untouched.
pub fn remove_hook_config(settings: &mut Value) {
    let Some(root) = settings.as_object_mut() else {
        return;
    };
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    for entries in hooks.values_mut() {
        if let Some(list) = entries.as_array_mut() {
            list.retain(|entry| !is_kriyon_entry(entry));
        }
    }
    hooks.retain(|_, entries| entries.as_array().is_none_or(|list| !list.is_empty()));
    if hooks.is_empty() {
        root.remove("hooks");
    }
}

/// `CLAUDE_CODE_PLUGIN_DIRS` with `dir` added to the user's own `existing`
/// value (`:`-separated, the macOS path-list separator), never replacing it.
#[must_use]
pub fn plugin_dirs_value(existing: Option<&str>, dir: &str) -> String {
    let existing = existing.unwrap_or_default();
    if existing.split(':').any(|d| d == dir) {
        return existing.to_string();
    }
    if existing.is_empty() {
        dir.to_string()
    } else {
        format!("{existing}:{dir}")
    }
}

/// The companion folder's `.claude-plugin/plugin.json`.
#[must_use]
pub fn plugin_manifest(version: &str) -> String {
    let manifest = json!({
        "name": PLUGIN_NAME,
        "version": version,
        "description": "Connects Claude Code sessions to the Kriyon app. Loaded only in sessions Kriyon starts.",
        "author": { "name": "Kriyon" },
        "license": "Apache-2.0",
    });
    serde_json::to_string_pretty(&manifest).unwrap_or_default()
}

/// The companion folder's `hooks/hooks.json`: Kriyon's command hook for every
/// registered event, plus the companion mod module when `module` is given.
#[must_use]
pub fn plugin_hooks(command: &str, module: Option<&str>) -> String {
    let hooks: serde_json::Map<String, Value> = REGISTERED_HOOK_EVENTS
        .iter()
        .map(|event| {
            (
                (*event).to_string(),
                json!([{ "hooks": [{ "type": "command", "command": command }] }]),
            )
        })
        .collect();
    let mut doc = json!({ "hooks": hooks });
    if let (Some(module), Some(obj)) = (module, doc.as_object_mut()) {
        obj.insert("modules".to_string(), json!([module]));
    }
    serde_json::to_string_pretty(&doc).unwrap_or_default()
}

/// Substring marking a status-line command as Kriyon's wrapper, so a re-wrap
/// never wraps the wrapper (which would lose the user's original).
pub const STATUSLINE_MARKER: &str = "kriyon-statusline";

/// Whether `settings.statusLine` is Kriyon's wrapper.
#[must_use]
pub fn is_kriyon_statusline(settings: &Value) -> bool {
    settings
        .get("statusLine")
        .and_then(|s| s.get("command"))
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains(STATUSLINE_MARKER))
}

/// What wrapping the status line found there before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusLineBefore {
    /// The user's own status line: keep this object for the restore.
    Theirs(Value),
    /// Kriyon's wrapper already: keep what was saved the first time.
    Ours,
    /// No status line at all.
    None,
}

/// Point `settings.statusLine` at Kriyon's `wrapper` command, and say what was
/// there, so the caller can save the user's own for [`restore_statusline`].
pub fn wrap_statusline(settings: &mut Value, wrapper: &str) -> StatusLineBefore {
    let before = match settings.get("statusLine") {
        _ if is_kriyon_statusline(settings) => StatusLineBefore::Ours,
        Some(current) => StatusLineBefore::Theirs(current.clone()),
        None => StatusLineBefore::None,
    };
    if !settings.is_object() {
        *settings = json!({});
    }
    if let Some(root) = settings.as_object_mut() {
        root.insert(
            "statusLine".to_string(),
            json!({ "type": "command", "command": wrapper }),
        );
    }
    before
}

/// Point `settings.statusLine` back at the user's own status line: the
/// `original` object Kriyon saved, else a plain command, else none at all.
/// Only acts when the current status line is Kriyon's wrapper.
pub fn restore_statusline(
    settings: &mut Value,
    original: Option<Value>,
    inner_command: Option<&str>,
) {
    if !is_kriyon_statusline(settings) {
        return;
    }
    let Some(root) = settings.as_object_mut() else {
        return;
    };
    let restored = original
        .filter(Value::is_object)
        .or_else(|| inner_command.map(|c| json!({ "type": "command", "command": c })));
    match restored {
        Some(value) => {
            root.insert("statusLine".to_string(), value);
        }
        None => {
            root.remove("statusLine");
        }
    }
}

/// The companion mod's module file, written into the [Companion folder] when
/// the user turns it on. It observes, plus one tool and one report for nested
/// sessions (ADR-0049); see its header.
pub const COMPANION_MODULE: &str = include_str!("../companion/companion.js");

/// Where the companion module sits, relative to `hooks/hooks.json`.
pub const COMPANION_MODULE_PATH: &str = "./companion.js";

/// The longest Unix socket path macOS takes is about 104 bytes; the mod's
/// fetch says "near 100". A longer path means no companion for that session.
pub const MAX_SOCKET_PATH: usize = 100;

/// One session's [Companion state]: the one chip the UI shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompanionState {
    /// Turned off (or the hooks aren't on the plugin route).
    Off,
    /// The org allows only its own mods (`allowManagedModsOnly`).
    Blocked,
    /// Turned on after this session started: it needs a restart.
    NeedsRestart,
    /// Nothing from Claude yet: still starting, or waiting for the user to
    /// trust the folder (no plugin loads before that).
    Starting,
    /// The mod is talking to Kriyon.
    On,
    /// Kriyon's hooks fire but the mod never spoke: Claude Code older than
    /// 2.1.287, or mods are off for this session.
    Silent,
}

/// What Kriyon knows about one session's companion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[allow(clippy::struct_excessive_bools)] // independent observations, not states
pub struct CompanionFacts {
    /// The user turned the companion on and the hooks are on the plugin route.
    pub enabled: bool,
    /// The org blocks non-managed mods; `None` when its policy is unknown.
    pub org_blocks_mods: Option<bool>,
    /// The session's shell is running (started or adopted by this app), so
    /// whether it carries the bridge socket is known. Until then a new session
    /// is starting, not missing the companion.
    pub launched: bool,
    /// The session's shell was started with the bridge socket in its env.
    pub injected: bool,
    /// The mod has posted at least one event for this session.
    pub bridge_seen: bool,
    /// Kriyon's hooks have fired for this session.
    pub hooks_seen: bool,
}

/// The [Companion state] for a session.
#[must_use]
pub const fn companion_state(facts: CompanionFacts) -> CompanionState {
    if !facts.enabled {
        return CompanionState::Off;
    }
    if facts.bridge_seen {
        return CompanionState::On;
    }
    if matches!(facts.org_blocks_mods, Some(true)) {
        return CompanionState::Blocked;
    }
    if facts.launched && !facts.injected {
        return CompanionState::NeedsRestart;
    }
    if facts.hooks_seen {
        CompanionState::Silent
    } else {
        CompanionState::Starting
    }
}

/// Watches a session's PTY output for `claude` refusing the companion folder
/// at startup (managed `disableSideloadFlags`), across chunk boundaries. A
/// cheap byte search runs on every chunk; the full match only when it hits.
#[derive(Debug, Default)]
pub struct RefusalWatch {
    tail: Vec<u8>,
    seen: bool,
}

impl RefusalWatch {
    /// What is kept between chunks: enough for the whole message.
    const KEEP: usize = 512;
    const NEEDLE: &'static [u8] = b"disableSideloadFlags";

    /// Feed the next output chunk. True once, on the chunk that completes the
    /// refusal message.
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        if self.seen {
            return false;
        }
        self.tail.extend_from_slice(bytes);
        let hit = self
            .tail
            .windows(Self::NEEDLE.len())
            .any(|w| w == Self::NEEDLE)
            && crate::policy::is_sideload_refusal(&String::from_utf8_lossy(&self.tail));
        if self.tail.len() > Self::KEEP {
            self.tail.drain(..self.tail.len() - Self::KEEP);
        }
        self.seen = hit;
        hit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefs(consented: bool, status_hooks: bool) -> IntegrationPrefs {
        IntegrationPrefs {
            consented,
            status_hooks,
            ..IntegrationPrefs::default()
        }
    }

    #[test]
    fn the_welcome_screen_offers_the_companion_on() {
        // Without it the Structured view is off, which new users missed.
        assert!(IntegrationPrefs::default().companion);
    }

    #[test]
    fn the_route_needs_consent_and_falls_back_when_side_loading_is_not_allowed() {
        use SideloadPolicy::{Allowed, Blocked, Unknown};
        assert_eq!(hook_route(prefs(false, true), Allowed), HookRoute::Off);
        assert_eq!(hook_route(prefs(true, false), Allowed), HookRoute::Off);
        assert_eq!(hook_route(prefs(true, true), Allowed), HookRoute::Plugin);
        assert_eq!(hook_route(prefs(true, true), Blocked), HookRoute::Settings);
        assert_eq!(hook_route(prefs(true, true), Unknown), HookRoute::Settings);
        let refused = IntegrationPrefs {
            sideload_refused: true,
            ..prefs(true, true)
        };
        assert_eq!(hook_route(refused, Allowed), HookRoute::Settings);
    }

    #[test]
    fn the_route_reason_names_why_the_hooks_left_the_plugin_route() {
        use SideloadPolicy::{Allowed, Blocked, Unknown};
        let on = prefs(true, true);
        assert_eq!(route_reason(on, Allowed), RouteReason::Plugin);
        assert_eq!(route_reason(on, Blocked), RouteReason::OrgBlocks);
        assert_eq!(route_reason(on, Unknown), RouteReason::PolicyUnknown);
        let refused = IntegrationPrefs {
            sideload_refused: true,
            ..on
        };
        assert_eq!(route_reason(refused, Allowed), RouteReason::Refused);
        assert_eq!(route_reason(prefs(true, false), Allowed), RouteReason::Off);
    }

    #[test]
    fn removing_kriyon_hooks_leaves_the_users_own_and_drops_empty_lists() {
        let mut settings = json!({
            "model": "opus",
            "hooks": {
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "python3 '/h/kriyon-hook.py'" }] },
                    { "hooks": [{ "type": "command", "command": "say done" }] }
                ],
                "PreToolUse": [
                    { "hooks": [{ "type": "command", "command": "python3 '/h/kriyon-hook.py'" }] }
                ]
            }
        });
        remove_hook_config(&mut settings);
        assert_eq!(
            settings,
            json!({
                "model": "opus",
                "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] }
            })
        );

        let mut only_ours = json!({"hooks": {"Stop": [
            { "hooks": [{ "type": "command", "command": "python3 '/h/kriyon-hook.py'" }] }
        ]}});
        remove_hook_config(&mut only_ours);
        assert_eq!(only_ours, json!({}), "as it was before Kriyon");
    }

    #[test]
    fn the_plugin_dir_is_appended_to_the_users_value_once() {
        assert_eq!(plugin_dirs_value(None, "/k"), "/k");
        assert_eq!(plugin_dirs_value(Some(""), "/k"), "/k");
        assert_eq!(plugin_dirs_value(Some("/mine"), "/k"), "/mine:/k");
        assert_eq!(plugin_dirs_value(Some("/mine:/k"), "/k"), "/mine:/k");
    }

    #[test]
    fn plugin_hooks_register_every_event_and_the_mod_only_when_asked() {
        let doc: Value = serde_json::from_str(&plugin_hooks("python3 'x'", None)).expect("JSON");
        for event in REGISTERED_HOOK_EVENTS {
            assert_eq!(doc["hooks"][event][0]["hooks"][0]["command"], "python3 'x'");
        }
        assert!(doc.get("modules").is_none());
        let doc: Value =
            serde_json::from_str(&plugin_hooks("c", Some("./companion.js"))).expect("JSON");
        assert_eq!(doc["modules"], json!(["./companion.js"]));
        let manifest: Value = serde_json::from_str(&plugin_manifest("1.2.3")).expect("JSON");
        assert_eq!(manifest["name"], PLUGIN_NAME);
    }

    #[test]
    fn the_companion_state_says_why_it_is_not_on() {
        let on = CompanionFacts {
            enabled: true,
            org_blocks_mods: Some(false),
            launched: true,
            injected: true,
            ..CompanionFacts::default()
        };
        assert_eq!(
            companion_state(CompanionFacts::default()),
            CompanionState::Off
        );
        assert_eq!(companion_state(on), CompanionState::Starting);
        assert_eq!(
            companion_state(CompanionFacts {
                hooks_seen: true,
                ..on
            }),
            CompanionState::Silent
        );
        assert_eq!(
            companion_state(CompanionFacts {
                bridge_seen: true,
                hooks_seen: true,
                ..on
            }),
            CompanionState::On
        );
        assert_eq!(
            companion_state(CompanionFacts {
                injected: false,
                ..on
            }),
            CompanionState::NeedsRestart
        );
        assert_eq!(
            companion_state(CompanionFacts {
                org_blocks_mods: Some(true),
                ..on
            }),
            CompanionState::Blocked
        );
    }

    /// A brand-new session is asked about before its shell has started: it
    /// isn't injected *yet*, which is not the same as started without it.
    #[test]
    fn a_session_whose_shell_has_not_started_is_starting_not_needing_a_restart() {
        let new = CompanionFacts {
            enabled: true,
            org_blocks_mods: Some(false),
            ..CompanionFacts::default()
        };
        assert_eq!(companion_state(new), CompanionState::Starting);
    }

    #[test]
    fn the_refusal_watch_sees_the_message_across_chunks_once() {
        let msg = b"\x1b[31m--plugin-dir is disabled by your organization's managed settings (disableSideloadFlags). Unset CLAUDE_CODE_PLUGIN_DIRS.\x1b[0m\r\n";
        let mut watch = RefusalWatch::default();
        assert!(!watch.feed(b"some earlier output\r\n"));
        let (a, b) = msg.split_at(30);
        assert!(!watch.feed(a));
        assert!(watch.feed(b));
        assert!(!watch.feed(msg), "once");

        let mut quiet = RefusalWatch::default();
        assert!(!quiet.feed(b"disableSideloadFlags is a managed setting"));
    }

    #[test]
    fn wrapping_says_what_was_there_and_never_wraps_the_wrapper() {
        let wrapper = "sh '/h/kriyon-statusline.sh'";
        let mut s = json!({"statusLine": {"type": "command", "command": "my-bar", "padding": 1}});
        assert_eq!(
            wrap_statusline(&mut s, wrapper),
            StatusLineBefore::Theirs(json!({"type": "command", "command": "my-bar", "padding": 1}))
        );
        assert_eq!(s["statusLine"]["command"], wrapper);
        assert_eq!(
            wrap_statusline(&mut s, wrapper),
            StatusLineBefore::Ours,
            "idempotent"
        );
        assert_eq!(
            wrap_statusline(&mut json!({}), wrapper),
            StatusLineBefore::None
        );
    }

    #[test]
    fn restoring_the_status_line_brings_back_the_users_own() {
        let wrapper =
            json!({"statusLine": {"type": "command", "command": "sh '/h/kriyon-statusline.sh'"}});
        let original = json!({"type": "command", "command": "my-bar", "padding": 2});

        let mut s = wrapper.clone();
        restore_statusline(&mut s, Some(original.clone()), Some("my-bar"));
        assert_eq!(s["statusLine"], original, "the whole saved object");

        let mut s = wrapper.clone();
        restore_statusline(&mut s, None, Some("my-bar"));
        assert_eq!(
            s["statusLine"],
            json!({"type": "command", "command": "my-bar"})
        );

        let mut s = wrapper;
        restore_statusline(&mut s, None, None);
        assert_eq!(s, json!({}), "no status line before Kriyon, none after");

        let mut theirs = json!({"statusLine": {"type": "command", "command": "other"}});
        restore_statusline(&mut theirs, None, None);
        assert_eq!(
            theirs["statusLine"]["command"], "other",
            "not ours: untouched"
        );
    }
}
