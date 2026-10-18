//! [Managed policy] — what an organization's managed settings say about the
//! few keys Kriyon acts on, resolved across every [Managed source] the way
//! Claude Code resolves them (code.claude.com/docs/en/managed-settings).
//!
//! Pure: the Tauri shell reads the sources from disk and hands them here.

use serde::Serialize;
use serde_json::Value;

/// One managed-settings source as Kriyon found it — [Managed source].
#[derive(Clone, Debug, Default, PartialEq)]
pub enum ManagedSource {
    /// Not on this machine (or the OS denied the read, which Claude Code
    /// treats the same way: it starts without that source).
    #[default]
    Absent,
    /// Exists but can't be read or parsed as a JSON object.
    Unreadable,
    /// The source's settings object.
    Present(Value),
}

/// Every managed-settings source on macOS, in Claude Code's rank order.
#[derive(Debug, Default)]
pub struct ManagedSources {
    /// The server-managed cache, `~/.claude/remote-settings.json`.
    pub remote: ManagedSource,
    /// The `com.anthropic.claudecode` managed-preferences profile.
    pub mdm: ManagedSource,
    /// `managed-settings.json` merged with its `managed-settings.d/` drop-ins.
    pub file: ManagedSource,
}

/// The managed keys Kriyon acts on, after source precedence.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ManagedPolicy {
    /// `disableAllHooks`; `None` when no applied source sets a boolean.
    pub disable_all_hooks: Option<bool>,
    /// `allowManagedHooksOnly: true`.
    pub allow_managed_hooks_only: bool,
    /// `disableSideloadFlags` — [Side-loading] makes `claude` exit at startup.
    pub disable_sideload_flags: bool,
    /// The built-in guard's `allowManagedModsOnly` option: a mod the user
    /// brings (Kriyon's companion included) is refused.
    pub allow_managed_mods_only: bool,
}

/// The [Managed policy], or `Unknown` when Kriyon can't tell what it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyRead {
    Known(ManagedPolicy),
    /// A source exists but can't be read, or a `policyHelper` computes the
    /// policy at launch (Kriyon never runs it).
    Unknown,
}

/// Whether `claude` accepts a side-loaded plugin folder — [Side-loading].
/// Callers treat `Unknown` like `Blocked`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SideloadPolicy {
    Allowed,
    Blocked,
    Unknown,
}

impl PolicyRead {
    /// Whether Kriyon may name its companion folder in `CLAUDE_CODE_PLUGIN_DIRS`.
    #[must_use]
    pub fn sideload(self) -> SideloadPolicy {
        match self {
            Self::Known(policy) if policy.disable_sideload_flags => SideloadPolicy::Blocked,
            Self::Known(_) => SideloadPolicy::Allowed,
            Self::Unknown => SideloadPolicy::Unknown,
        }
    }

    /// Whether the organization blocks user mods (`allowManagedModsOnly`);
    /// `None` when the policy is unknown.
    #[must_use]
    pub fn mods_blocked_by_org(self) -> Option<bool> {
        match self {
            Self::Known(policy) => Some(policy.allow_managed_mods_only),
            Self::Unknown => None,
        }
    }
}

/// Resolve the [Managed policy] from every source.
#[must_use]
pub fn resolve(sources: &ManagedSources) -> PolicyRead {
    // Rank order, each with whether Claude Code honors a `policyHelper` there
    // (server-managed settings never do).
    let ranked = [
        (&sources.remote, false),
        (&sources.mdm, true),
        (&sources.file, true),
    ];
    let mut present = Vec::new();
    for (source, honors_helper) in ranked {
        match source {
            ManagedSource::Absent => {}
            ManagedSource::Unreadable => return PolicyRead::Unknown,
            ManagedSource::Present(value) => present.push((value, honors_helper)),
        }
    }

    // `managedSourcesBehavior` is read only from the highest source that
    // carries it or a policy key, so a lower source can't opt into merging.
    let merge = present
        .iter()
        .find(|(value, _)| has_policy_key(value) || value.get(BEHAVIOR_KEY).is_some())
        .and_then(|(value, _)| value.get(BEHAVIOR_KEY)?.as_str())
        == Some("merge");
    let mut applied: Vec<_> = present
        .into_iter()
        .filter(|(value, _)| has_policy_key(value))
        .collect();
    if !merge {
        applied.truncate(1);
    }

    let helper = applied.iter().any(|(value, honors_helper)| {
        *honors_helper && value.get("policyHelper").is_some_and(|h| !h.is_null())
    });
    if helper {
        return PolicyRead::Unknown;
    }

    let values: Vec<&Value> = applied.into_iter().map(|(value, _)| value).collect();
    // Locks take the strictest value of any applied source; every other key
    // comes from the highest applied source that sets it.
    let lock = |key: &str| values.iter().any(|v| restrictive(v.get(key)));
    let highest = |pointer: &str| {
        values
            .iter()
            .find_map(|v| v.pointer(pointer).filter(|x| !x.is_null()))
    };
    PolicyRead::Known(ManagedPolicy {
        // Claude Code drops a non-boolean `disableAllHooks` rather than
        // enforcing it, so only booleans count.
        disable_all_hooks: values
            .iter()
            .find_map(|v| v.get("disableAllHooks")?.as_bool()),
        allow_managed_hooks_only: values
            .iter()
            .any(|v| v.get("allowManagedHooksOnly").and_then(Value::as_bool) == Some(true)),
        disable_sideload_flags: lock("disableSideloadFlags"),
        allow_managed_mods_only: restrictive(highest(ALLOW_MANAGED_MODS_ONLY)),
    })
}

/// The control key that picks first-wins or merge across managed sources.
const BEHAVIOR_KEY: &str = "managedSourcesBehavior";

/// The built-in guard's option, as a JSON pointer into a settings object.
const ALLOW_MANAGED_MODS_ONLY: &str =
    "/pluginConfigs/cc-plugin-sec-default@builtin/options/allowManagedModsOnly";

/// A source counts only when it sets a policy key: any key but the two control
/// keys, to a value other than `null`.
fn has_policy_key(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.iter().any(|(key, v)| {
            key != BEHAVIOR_KEY && key != "wslInheritsWindowsSettings" && !v.is_null()
        })
    })
}

/// A restrictive key reads as on unless it is unset or `false`: Claude Code
/// enforces a value it can't read as the restrictive one.
fn restrictive(value: Option<&Value>) -> bool {
    value.is_some_and(|v| !v.is_null() && *v != Value::Bool(false))
}

/// Merge the file source's documents in order (`managed-settings.json` first,
/// then each drop-in): nested objects merge key by key, lists union without
/// duplicates, and any other value from a later document replaces the earlier.
#[must_use]
pub fn merge_file_documents(documents: impl IntoIterator<Item = Value>) -> Value {
    documents.into_iter().fold(
        Value::Object(serde_json::Map::new()),
        |mut merged, document| {
            merge_into(&mut merged, document);
            merged
        },
    )
}

fn merge_into(base: &mut Value, next: Value) {
    match (base, next) {
        (Value::Object(base), Value::Object(next)) => {
            for (key, value) in next {
                match base.get_mut(&key) {
                    Some(existing) => merge_into(existing, value),
                    None => {
                        base.insert(key, value);
                    }
                }
            }
        }
        (Value::Array(base), Value::Array(next)) => {
            for item in next {
                if !base.contains(&item) {
                    base.push(item);
                }
            }
        }
        (base, next) => *base = next,
    }
}

/// Whether `output` from a `claude` launch is its refusal of a side-loaded
/// plugin folder under `disableSideloadFlags`. Tolerates terminal styling and
/// line wrapping in PTY output, but the message must open a line (optionally
/// after `Error:`): the same words quoted inside other output — a source file
/// printed with `cat`, a log — are not `claude` refusing to start.
#[must_use]
pub fn is_sideload_refusal(output: &str) -> bool {
    const START: &str = "--plugin-dir is disabled";
    const REFUSAL: &str =
        "--plugin-dir is disabled by your organization's managed settings (disableSideloadFlags)";
    let plain = strip_csi(output);
    plain.match_indices(START).any(|(at, _)| {
        let line_start = plain[..at].rfind(['\n', '\r']).map_or(0, |i| i + 1);
        let lead = plain[line_start..at].trim();
        let opens_line = lead.is_empty() || lead.eq_ignore_ascii_case("error:");
        opens_line
            && plain[at..]
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .starts_with(REFUSAL)
    })
}

/// Drop terminal control sequences (`ESC [ … final-byte`) from PTY text.
pub(crate) fn strip_csi(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            plain.push(c);
            continue;
        }
        if chars.next() == Some('[') {
            // Parameters and intermediates run until a final byte in @..~.
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        }
    }
    plain
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn present(value: Value) -> ManagedSource {
        ManagedSource::Present(value)
    }

    fn known(sources: &ManagedSources) -> ManagedPolicy {
        match resolve(sources) {
            PolicyRead::Known(policy) => policy,
            PolicyRead::Unknown => panic!("expected a known policy"),
        }
    }

    #[test]
    fn no_sources_is_a_known_empty_policy() {
        let read = resolve(&ManagedSources::default());
        assert_eq!(read, PolicyRead::Known(ManagedPolicy::default()));
        assert_eq!(read.sideload(), SideloadPolicy::Allowed);
        assert_eq!(read.mods_blocked_by_org(), Some(false));
    }

    #[test]
    fn disable_sideload_flags_in_any_single_source_blocks() {
        for slot in 0..3 {
            let mut sources = ManagedSources::default();
            let source = present(json!({ "disableSideloadFlags": true }));
            match slot {
                0 => sources.remote = source,
                1 => sources.mdm = source,
                _ => sources.file = source,
            }
            assert_eq!(resolve(&sources).sideload(), SideloadPolicy::Blocked);
        }
    }

    #[test]
    fn the_first_source_with_a_policy_key_wins() {
        let sources = ManagedSources {
            remote: present(json!({ "model": "opus" })),
            mdm: present(json!({ "disableSideloadFlags": true })),
            ..ManagedSources::default()
        };
        assert_eq!(resolve(&sources).sideload(), SideloadPolicy::Allowed);
    }

    #[test]
    fn a_source_holding_only_control_keys_is_skipped() {
        let sources = ManagedSources {
            remote: present(json!({ "managedSourcesBehavior": "highestPriority" })),
            mdm: present(json!({ "wslInheritsWindowsSettings": true, "model": null })),
            file: present(json!({ "disableSideloadFlags": true })),
        };
        assert_eq!(resolve(&sources).sideload(), SideloadPolicy::Blocked);
    }

    #[test]
    fn merge_takes_the_strictest_lock_from_every_source() {
        let sources = ManagedSources {
            remote: present(json!({ "managedSourcesBehavior": "merge", "model": "opus" })),
            file: present(json!({ "disableSideloadFlags": true })),
            ..ManagedSources::default()
        };
        assert_eq!(resolve(&sources).sideload(), SideloadPolicy::Blocked);
    }

    #[test]
    fn merge_is_read_only_from_the_highest_source() {
        // A lower source can't opt itself into merging with the one above it.
        let sources = ManagedSources {
            remote: present(json!({ "model": "opus" })),
            file: present(json!({
                "managedSourcesBehavior": "merge",
                "disableSideloadFlags": true
            })),
            ..ManagedSources::default()
        };
        assert_eq!(resolve(&sources).sideload(), SideloadPolicy::Allowed);
    }

    #[test]
    fn merge_takes_other_keys_from_the_highest_source_that_sets_them() {
        let sources = ManagedSources {
            remote: present(json!({ "managedSourcesBehavior": "merge", "disableAllHooks": false })),
            mdm: present(json!({ "disableAllHooks": true })),
            file: present(json!({ "allowManagedHooksOnly": true })),
        };
        let policy = known(&sources);
        assert_eq!(policy.disable_all_hooks, Some(false));
        assert!(policy.allow_managed_hooks_only);
    }

    #[test]
    fn an_unreadable_source_makes_the_policy_unknown() {
        let sources = ManagedSources {
            mdm: ManagedSource::Unreadable,
            file: present(json!({ "model": "opus" })),
            ..ManagedSources::default()
        };
        let read = resolve(&sources);
        assert_eq!(read, PolicyRead::Unknown);
        assert_eq!(read.sideload(), SideloadPolicy::Unknown);
        assert_eq!(read.mods_blocked_by_org(), None);
    }

    #[test]
    fn a_policy_helper_on_the_applied_source_makes_the_policy_unknown() {
        let helper = json!({ "policyHelper": { "path": "/usr/local/bin/p" } });
        let sources = ManagedSources {
            file: present(helper.clone()),
            ..ManagedSources::default()
        };
        assert_eq!(resolve(&sources), PolicyRead::Unknown);

        // A server-managed policy shadows a lower helper, and remote settings
        // never honor `policyHelper` themselves.
        let sources = ManagedSources {
            remote: present(helper),
            mdm: present(json!({ "policyHelper": { "path": "/p" } })),
            ..ManagedSources::default()
        };
        assert_eq!(resolve(&sources).sideload(), SideloadPolicy::Allowed);
    }

    #[test]
    fn a_non_boolean_sideload_value_counts_as_blocked() {
        // Claude Code enforces a restrictive key it can't read as restrictive.
        let sources = ManagedSources {
            file: present(json!({ "disableSideloadFlags": "yes" })),
            ..ManagedSources::default()
        };
        assert_eq!(resolve(&sources).sideload(), SideloadPolicy::Blocked);
    }

    #[test]
    fn a_non_boolean_disable_all_hooks_is_dropped() {
        let sources = ManagedSources {
            file: present(json!({ "disableAllHooks": "true" })),
            ..ManagedSources::default()
        };
        assert_eq!(known(&sources).disable_all_hooks, None);
    }

    #[test]
    fn reads_allow_managed_mods_only_from_the_built_in_guard_options() {
        let sources = ManagedSources {
            mdm: present(json!({
                "pluginConfigs": {
                    "cc-plugin-sec-default@builtin": {
                        "options": { "allowManagedModsOnly": true }
                    }
                }
            })),
            ..ManagedSources::default()
        };
        assert_eq!(resolve(&sources).mods_blocked_by_org(), Some(true));
        assert_eq!(resolve(&sources).sideload(), SideloadPolicy::Allowed);
    }

    #[test]
    fn merges_file_documents_in_order() {
        let merged = merge_file_documents([
            json!({ "model": "opus", "permissions": { "deny": ["A", "B"] }, "env": { "X": "1" } }),
            json!({ "model": "sonnet", "permissions": { "deny": ["B", "C"] }, "env": { "Y": "2" } }),
        ]);
        assert_eq!(
            merged,
            json!({
                "model": "sonnet",
                "permissions": { "deny": ["A", "B", "C"] },
                "env": { "X": "1", "Y": "2" }
            })
        );
        assert_eq!(merge_file_documents([]), json!({}));
    }

    #[test]
    fn matches_the_sideload_refusal_message() {
        assert!(is_sideload_refusal(
            "--plugin-dir is disabled by your organization's managed settings \
             (disableSideloadFlags). Unset CLAUDE_CODE_PLUGIN_DIRS"
        ));
        // Styled and wrapped the way a PTY shows it.
        assert!(is_sideload_refusal(
            "\x1b[31m--plugin-dir is disabled by your organization's\r\n managed \x1b[1msettings\x1b[0m (disableSideloadFlags)"
        ));
        assert!(!is_sideload_refusal("disableSideloadFlags"));
        // The message quoted inside other output (a source file printed with
        // `cat`, a log) is not `claude` refusing to start.
        assert!(!is_sideload_refusal(
            "    const REFUSAL: &str =\r\n        \"--plugin-dir is disabled by your organization's managed settings (disableSideloadFlags)\";"
        ));
        assert!(is_sideload_refusal(
            "Error: --plugin-dir is disabled by your organization's managed settings\r\n(disableSideloadFlags). Unset it."
        ));
        assert!(!is_sideload_refusal("$ claude\r\nWelcome to Claude Code"));
    }
}
