//! Claude Code hook events — the reliable source of live session status.
//!
//! Interactive `claude` does not dependably write its `~/.claude/projects`
//! transcript while a session is live, so deriving status by tailing that file
//! is unreliable. Instead Kriyon installs Claude Code *hooks* (an official,
//! documented feature) that fire on each lifecycle transition. A small hook
//! script appends one JSON line per event to a per-session file Kriyon tails;
//! these functions parse those lines; [`crate::hook_signal`] says what each means.
//!
//! Parsing is tolerant: an unknown or malformed line yields `None` (never a
//! panic), mirroring the transcript parser's `Unknown` discipline.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::policy::ManagedPolicy;

/// Hook events Kriyon registers in `~/.claude/settings.json`. Chosen to cover
/// the full status lifecycle: working (prompt/tool), waiting
/// (notification/permission), done (stop), and idle (session start/end).
///
/// This is the single source of truth for *which* events Kriyon subscribes to;
/// [`crate::hook_signal::classify`] gives each of them its meaning. A test
/// proves every registered event classifies, so the registration list and the
/// classifier cannot silently drift apart.
pub const REGISTERED_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    // A tool that errors fires `PostToolUseFailure` *instead of* `PostToolUse`;
    // without it a failed tool leaves the summary stuck on "Running Bash…" and a
    // crashed subagent spinning in the inspector until the turn settles.
    "PostToolUseFailure",
    "Notification",
    "PermissionRequest",
    "Stop",
    // Likewise a turn that dies on an API error (rate limit, overload) ends in
    // `StopFailure` and never fires `Stop`.
    "StopFailure",
    "SessionEnd",
];

// What writes the lines and files parsed here is `kriyon-hook` (ADR-0066):
// every key it writes is a field of [`HookEvent`] or [`UsageSnapshot`], and
// its contract tests (crates/kriyon-hook/tests/contract.rs) prove each comes
// back, so a key spelled differently on one side fails a test, not silently.

/// Substring marking a hook command as Kriyon-owned, used to find and replace
/// Kriyon's entries idempotently without touching the user's other hooks.
pub const KRIYON_HOOK_MARKER: &str = "kriyon-hook";

/// The settings file that turns Kriyon's hooks off — [Hooks off]. Named by
/// its settings scope so the UI can say which file to look in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HooksOff {
    Managed,
    Local,
    Project,
    User,
    /// The user turned Kriyon's hooks off in Kriyon's own Settings.
    Kriyon,
    /// Not a settings file: the hooks are on, but Kriyon's hook program
    /// isn't installed (the app's copy was missing), so Kriyon left them out.
    Missing,
}

/// The parsed settings that decide whether Kriyon's hooks run for a session,
/// one per scope. A file scope is `None` when missing or unreadable; the
/// managed scope is the resolved [`ManagedPolicy`] over every managed source.
#[derive(Debug, Default)]
pub struct SettingsLayers {
    pub managed: ManagedPolicy,
    pub local: Option<Value>,
    pub project: Option<Value>,
    pub user: Option<Value>,
}

/// Which settings file, if any, stops Kriyon's hooks (and with them its status
/// line) from running.
///
/// Kriyon's hooks are user-settings hooks, so they stop when managed settings
/// set `allowManagedHooksOnly`, or when `disableAllHooks` is `true` after
/// settings precedence (managed > local > project > user: the highest file that
/// sets the key wins, so a project `false` re-enables a user `true`). A value
/// that is not a boolean counts as unset. Best-effort: a `--settings` flag is
/// invisible here (ADR-0029, ADR-0031).
#[must_use]
pub fn hooks_off(layers: &SettingsLayers) -> Option<HooksOff> {
    if layers.managed.allow_managed_hooks_only {
        return Some(HooksOff::Managed);
    }
    if let Some(on) = layers.managed.disable_all_hooks {
        return on.then_some(HooksOff::Managed);
    }
    let flag = |layer: &Option<Value>| layer.as_ref()?.get("disableAllHooks")?.as_bool();
    [
        (&layers.local, HooksOff::Local),
        (&layers.project, HooksOff::Project),
        (&layers.user, HooksOff::User),
    ]
    .into_iter()
    .find_map(|(layer, scope)| flag(layer).map(|on| (on, scope)))
    .and_then(|(on, scope)| on.then_some(scope))
}

/// Merge Kriyon's hook command into a `settings.json` value, idempotently:
/// existing Kriyon entries (matched by [`KRIYON_HOOK_MARKER`]) are removed
/// first, then a fresh entry is appended for each event. All non-Kriyon hooks
/// are preserved untouched.
///
/// Pure JSON manipulation with no IO, so it lives in the core and is unit-tested
/// without the Tauri shell; the shell's `hooks::install` does the surrounding
/// read-modify-write.
pub fn merge_hook_config(settings: &mut Value, command: &str, events: &[&str]) {
    if !settings.is_object() {
        *settings = json!({});
    }
    let Some(root) = settings.as_object_mut() else {
        return;
    };
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let Some(hooks) = hooks.as_object_mut() else {
        return;
    };

    for event in events {
        let entry = hooks
            .entry((*event).to_string())
            .or_insert_with(|| json!([]));
        if !entry.is_array() {
            *entry = json!([]);
        }
        let Some(arr) = entry.as_array_mut() else {
            continue;
        };
        arr.retain(|item| !is_kriyon_entry(item));
        arr.push(json!({
            "hooks": [ { "type": "command", "command": command } ]
        }));
    }
}

/// Whether a matcher-group entry is one Kriyon previously installed.
pub(crate) fn is_kriyon_entry(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c.contains(KRIYON_HOOK_MARKER))
            })
        })
}

/// A live usage snapshot captured from Claude Code's `statusLine` JSON, which
/// Claude feeds its status-line command after each assistant message. This is
/// the only exact *live* source of the context-window fill (Claude's own
/// `used_percentage`). Kriyon's
/// status-line wrapper writes one of these per session; all fields are optional
/// because Claude may omit any of them.
///
/// Field names match the JSON the wrapper writes (camelCase) so the same struct
/// round-trips from the snapshot file and out to the frontend.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    /// Percentage of the context window currently used (0–100).
    #[serde(default)]
    pub used_percentage: Option<f64>,
    /// The context window size in tokens (e.g. 200000 or 1000000).
    #[serde(default)]
    pub context_window_size: Option<u64>,
    /// Input tokens in the context window now, cache included (from the last
    /// API response) — not a session total.
    #[serde(default)]
    pub input_tokens: Option<u64>,
    /// Output tokens of the last API response.
    #[serde(default)]
    pub output_tokens: Option<u64>,
    /// Model display name, e.g. "Claude Opus 4.8".
    #[serde(default)]
    pub model: Option<String>,
    /// Claude's own session id for the main interactive agent, as reported in the
    /// `statusLine` JSON. Only the main TUI renders a status line, so this
    /// authoritatively identifies the terminal's main session (see
    /// [`crate::main_session::MainSessionLock::set_authoritative`]).
    #[serde(default)]
    pub session_id: Option<String>,
}

impl UsageSnapshot {
    /// The authoritative main-session id this snapshot anchors the main-session
    /// lock to, or `None` when the status line carried no (or an empty) id. The
    /// one place the "which id anchors the main session" rule lives, so the
    /// status path and the activity path — which each hold their own
    /// [`crate::main_session::MainSessionLock`] — can never derive it
    /// differently and drift apart.
    #[must_use]
    pub fn authoritative_main_id(&self) -> Option<&str> {
        self.session_id.as_deref().filter(|s| !s.is_empty())
    }
}

/// Parse a usage-snapshot JSON object (one whole file, not line-delimited).
/// Returns `None` on malformed input.
#[must_use]
pub fn parse_usage_snapshot(text: &str) -> Option<UsageSnapshot> {
    serde_json::from_str::<UsageSnapshot>(text.trim()).ok()
}

/// One Claude Code hook firing, as recorded by Kriyon's hook script.
///
/// Only the fields Kriyon needs are kept; everything else in the hook payload
/// is ignored. `transcript_path` is the on-disk JSONL path Claude reports for
/// the session — the authoritative location to read token usage from, with no
/// path guessing.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, Default)]
pub struct HookEvent {
    /// The hook event name, e.g. `"UserPromptSubmit"`, `"Stop"`.
    pub event: String,
    /// Claude Code's own session id for this run. Kriyon launches `claude`
    /// without `--session-id` (which suppresses the live transcript — see ADR
    /// 0003), so Claude owns its id; Kriyon learns it here to locate the
    /// Claude-keyed task store (`~/.claude/tasks/<session_id>/`).
    #[serde(default)]
    pub session_id: Option<String>,
    /// Absolute path to the session transcript, when the hook provided one.
    #[serde(default)]
    pub transcript_path: Option<String>,
    /// The tool name for `PreToolUse`/`PostToolUse`, when present.
    #[serde(default)]
    pub tool_name: Option<String>,
    /// The tool-call id, correlating an Agent's `PreToolUse` (running) with its
    /// `PostToolUse` (done). Present on tool events from Claude Code ≥2.1.
    #[serde(default)]
    pub tool_use_id: Option<String>,
    /// For an `Agent` tool call, the subagent type (e.g. `"Explore"`).
    #[serde(default)]
    pub subagent_type: Option<String>,
    /// For an `Agent` tool call, the human description of the subagent's task.
    #[serde(default)]
    pub description: Option<String>,
    /// For a `Bash` tool call, whether it was launched in the background.
    #[serde(default)]
    pub run_in_background: Option<bool>,
    /// For a `Bash` tool call, the command line.
    #[serde(default)]
    pub command: Option<String>,
    /// For an `Agent` `PostToolUse`, the subagent's final output (capped).
    #[serde(default)]
    pub result: Option<String>,
    /// For an `Agent` `PostToolUse` that launched the agent in the background,
    /// the launched agent's id — the `agent_id` its own tool events carry, so the
    /// [Subagent] is bound exactly rather than guessed by type and order. Empty
    /// when the receipt carried no readable id: still a launch.
    #[serde(default)]
    pub launched_agent_id: Option<String>,
    /// The subagent runtime id an internal tool event belongs to. Absent/empty
    /// means the main agent fired the tool. Used to attribute a `currentTool` to
    /// a [`crate::activity::Subagent`]; see correlation in `activity.rs`.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// The subagent type an internal tool event belongs to (e.g. `"Explore"`),
    /// matching the spawning Agent's `subagent_type`. Used for type+order
    /// correlation when an `agent_id` is first seen.
    #[serde(default)]
    pub agent_type: Option<String>,
    /// Exact tool duration in milliseconds, reported on `PostToolUse`.
    #[serde(default)]
    pub duration_ms: Option<u64>,
    /// A short human target for the tool (a file path, else a command summary),
    /// derived from `tool_input` by the hook script. Renders as "Editing Foo.tsx".
    #[serde(default)]
    pub target: Option<String>,
    /// When the hook fired (ISO-8601), used for relative "running/done" times.
    #[serde(default)]
    pub ts: Option<String>,
    /// The human message on a `Notification` hook (e.g. "Claude needs your
    /// permission to use Bash"). Feeds the permission [Pending ask].
    #[serde(default)]
    pub message: Option<String>,
    /// Why Claude Code notified, on a `Notification` hook: one of
    /// `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`,
    /// `elicitation_complete`, `elicitation_response`, `agent_needs_input`,
    /// `agent_completed`. Absent on Claude Code builds that predate the field.
    /// Classified by [`notification_kind`] — the structured replacement for
    /// matching English prose.
    #[serde(default)]
    pub notification_type: Option<String>,
    /// The error kind on a `StopFailure` hook (e.g. `"rate_limit"`), used for
    /// the summary shown beside the status dot.
    #[serde(default)]
    pub error: Option<String>,
    /// For an `AskUserQuestion` `PreToolUse`, the raw JSON of `tool_input.questions`
    /// (capped by the hook script; dropped, not truncated, when oversized so it
    /// never arrives malformed). Parsed tolerantly in `ask.rs`.
    #[serde(default)]
    pub questions: Option<String>,
    /// For an `ExitPlanMode` `PreToolUse`, the plan's first non-empty line (capped).
    #[serde(default)]
    pub plan: Option<String>,
    /// On a `PostToolUse` that changed files, the lines it added, from Claude
    /// Code's own patch (an edit's, or the files a command edited).
    #[serde(default)]
    pub lines_added: Option<u64>,
    /// The lines that change removed; see [`Self::lines_added`].
    #[serde(default)]
    pub lines_removed: Option<u64>,
    /// On a file tool's `PostToolUse`, whether it made a new file.
    #[serde(default)]
    pub created: Option<bool>,
    /// On a [Subagent]'s own event, the `tool_use_id` of the call that launched
    /// it, from the sidecar Claude Code writes beside its transcript.
    #[serde(default)]
    pub launched_by: Option<String>,
    /// On a Bash `PostToolUse`, the files the command changed (capped).
    #[serde(default)]
    pub changed_files: Option<Vec<String>>,
    /// On a `PostToolUse`, what came of it in a few words: a test run's
    /// "43 passed" or "2 failed", a search's "6 files".
    #[serde(default)]
    pub outcome: Option<String>,
    /// On a `Stop` hook, whether Claude Code is already continuing because a
    /// previous `Stop` hook blocked — i.e. this is a *re-entry*, ending a turn
    /// the user has already been told about. Absent on every other event.
    #[serde(default)]
    pub stop_hook_active: Option<bool>,
    /// On a `Stop` hook, the [In-flight work] Claude Code still has running in
    /// the background — its own answer to "is this session done, or paused until
    /// background work wakes it?". `None` when the build predates the field or
    /// the list was unreadable; read through [`crate::hook_signal::InFlight`].
    #[serde(default, deserialize_with = "lenient_in_flight_work")]
    pub background_tasks: Option<Vec<InFlightWork>>,
    /// The tool's whole input as JSON, [Redaction] applied and capped by the
    /// hook script — what an [Activity step] shows when opened. Cut, not
    /// dropped, when oversized, so it may not parse; it is shown as text.
    #[serde(default)]
    pub input: Option<String>,
    /// On `UserPromptSubmit`, the prompt text ([Redaction] applied, capped) —
    /// the heading an [Activity log] groups a turn's steps under.
    #[serde(default)]
    pub prompt: Option<String>,
    /// The folder Claude Code runs in — what "outside the project" is measured
    /// against for an [Activity step].
    #[serde(default)]
    pub cwd: Option<String>,
    /// Claude Code's id tying a user prompt to every event until the next one:
    /// the key an [Activity log] groups a turn's steps by.
    #[serde(default)]
    pub prompt_id: Option<String>,
    /// The permission mode in force (`default`, `acceptEdits`, `plan`,
    /// `bypassPermissions`, …) — part of what allowed an [Activity step].
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// On `UserPromptSubmit`, who sent the prompt: `user`, `sdk`, `system`,
    /// `loop_wakeup`, `schedule_wakeup`, … Absent on older builds.
    #[serde(default)]
    pub prompt_source: Option<String>,
}

/// One entry of Claude Code's `background_tasks` list: background work still in
/// flight when a turn ended. Claude Code lists only running/pending work, so
/// presence alone means "not finished".
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct InFlightWork {
    pub id: String,
    /// Claude Code's friendly type label: `subagent`, `workflow`, `shell`,
    /// `monitor`, `teammate`, `cloud session`, … (a raw type name for anything
    /// newer).
    #[serde(rename = "type")]
    pub kind: String,
}

impl InFlightWork {
    /// Whether this is a [Background agent]: agent work the session is paused
    /// on and will be woken by. Shells, monitors and housekeeping (`dream`,
    /// `auto-mode scan`, MCP tasks) are not — they can outlive the work the
    /// user asked for, and a session waiting on them is done. An unknown type is
    /// not waited on either, so a type added after this build can never hold a
    /// session in Running.
    #[must_use]
    pub fn is_background_agent(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "subagent" | "workflow" | "teammate" | "cloud session"
        )
    }
}

/// Read `background_tasks` without ever failing the whole hook line: anything
/// that is not an array degrades to `None`, and an entry that does not parse is
/// skipped. Losing the `Stop` itself over a malformed list would be far worse
/// than losing the list.
fn lenient_in_flight_work<'de, D>(deserializer: D) -> Result<Option<Vec<InFlightWork>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    let Value::Array(entries) = value else {
        return Ok(None);
    };
    Ok(Some(
        entries
            .into_iter()
            .filter_map(|entry| serde_json::from_value(entry).ok())
            .collect(),
    ))
}

/// Parse one hook-events line. Returns `None` for blank or malformed lines so
/// the tailer never hard-errors on a partial or unexpected write.
#[must_use]
pub fn parse_hook_line(line: &str) -> Option<HookEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str::<HookEvent>(trimmed).ok()
}

/// What a `Notification` hook actually means for the session it belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationKind {
    /// The user is blocked right now: a permission gate or an MCP elicitation
    /// dialog is on screen and nothing proceeds until they answer.
    Block,
    /// The prompt has sat idle. Means "the turn is over" at a turn boundary, and
    /// "a TUI block is on screen" mid-turn — the caller decides which.
    IdlePrompt,
    /// A status message that asks nothing of this session: a login succeeded, an
    /// MCP elicitation resolved elsewhere, or a *background agent* reporting its
    /// own lifecycle. Must never move the session's status or open an ask.
    Informational,
    /// Claude Code sent no `notification_type` (a build predating the field) and
    /// the message matched nothing known. The caller keeps its own conservative
    /// rule rather than guessing.
    Unknown,
}

/// Classify a `Notification` hook, preferring Claude Code's structured
/// `notification_type` and falling back to the English message only when the
/// field is absent (older builds) or carries a type this version predates.
///
/// Matching prose was the previous — and only — signal, and it silently placed
/// every unlisted type in the "user is blocked" bucket: a successful login or a
/// background agent's own completion would flip a working session to Waiting and
/// fire a "needs you" banner at a session that was busy.
#[must_use]
pub fn notification_kind(
    notification_type: Option<&str>,
    message: Option<&str>,
) -> NotificationKind {
    match notification_type {
        Some("permission_prompt" | "elicitation_dialog") => return NotificationKind::Block,
        Some("idle_prompt") => return NotificationKind::IdlePrompt,
        Some(
            "auth_success"
            | "elicitation_complete"
            | "elicitation_response"
            | "agent_needs_input"
            | "agent_completed",
        ) => return NotificationKind::Informational,
        // No type, or one added after this build: fall through to the prose.
        Some(_) | None => {}
    }
    if is_permission_message(message) {
        NotificationKind::Block
    } else if is_idle_prompt_message(message) {
        NotificationKind::IdlePrompt
    } else {
        NotificationKind::Unknown
    }
}

/// Whether a `Notification` hook's message is a permission gate. Claude Code's
/// wording is "Claude needs your permission…"; matching that phrase — not the
/// bare word "permission", which also appears in unrelated prose like
/// "Permission denied reading ~/.config" — keeps error notifications from
/// masquerading as blocks. Shared by the status fusion and the [`crate::ask`]
/// reconstruction so the two can never classify the same message differently.
#[must_use]
pub fn is_permission_message(message: Option<&str>) -> bool {
    message.is_some_and(|m| m.to_lowercase().contains("needs your permission"))
}

/// Whether a `Notification` hook's message is the idle prompt ("Claude is
/// waiting for your input"), which Claude Code fires once the prompt has sat
/// idle after a turn. It means "the turn is over", never "blocked mid-turn" —
/// classifying it by message keeps status correct even when the preceding
/// `Stop` was missed (app restart, re-subscribe).
#[must_use]
pub fn is_idle_prompt_message(message: Option<&str>) -> bool {
    message.is_some_and(|m| m.to_lowercase().contains("waiting for your input"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(json: &str) -> Option<Value> {
        serde_json::from_str(json).ok()
    }

    #[test]
    fn hooks_run_when_no_file_turns_them_off() {
        assert_eq!(hooks_off(&SettingsLayers::default()), None);
        let layers = SettingsLayers {
            user: layer(r#"{"hooks":{}}"#),
            ..SettingsLayers::default()
        };
        assert_eq!(hooks_off(&layers), None);
    }

    #[test]
    fn disable_all_hooks_names_the_file_that_set_it() {
        for (layers, want) in [
            (
                SettingsLayers {
                    user: layer(r#"{"disableAllHooks":true}"#),
                    ..SettingsLayers::default()
                },
                HooksOff::User,
            ),
            (
                SettingsLayers {
                    project: layer(r#"{"disableAllHooks":true}"#),
                    ..SettingsLayers::default()
                },
                HooksOff::Project,
            ),
            (
                SettingsLayers {
                    local: layer(r#"{"disableAllHooks":true}"#),
                    ..SettingsLayers::default()
                },
                HooksOff::Local,
            ),
            (
                SettingsLayers {
                    managed: ManagedPolicy {
                        disable_all_hooks: Some(true),
                        ..ManagedPolicy::default()
                    },
                    ..SettingsLayers::default()
                },
                HooksOff::Managed,
            ),
        ] {
            assert_eq!(hooks_off(&layers), Some(want));
        }
    }

    #[test]
    fn a_higher_scope_false_overrides_a_lower_true() {
        // Settings precedence: managed > local > project > user. The value
        // from the highest file that sets the key wins.
        let layers = SettingsLayers {
            project: layer(r#"{"disableAllHooks":false}"#),
            user: layer(r#"{"disableAllHooks":true}"#),
            ..SettingsLayers::default()
        };
        assert_eq!(hooks_off(&layers), None);

        let layers = SettingsLayers {
            managed: ManagedPolicy {
                disable_all_hooks: Some(false),
                ..ManagedPolicy::default()
            },
            user: layer(r#"{"disableAllHooks":true}"#),
            ..SettingsLayers::default()
        };
        assert_eq!(hooks_off(&layers), None);
    }

    #[test]
    fn managed_hooks_only_turns_off_kriyons_user_hooks() {
        let layers = SettingsLayers {
            managed: ManagedPolicy {
                allow_managed_hooks_only: true,
                ..ManagedPolicy::default()
            },
            project: layer(r#"{"disableAllHooks":false}"#),
            ..SettingsLayers::default()
        };
        assert_eq!(hooks_off(&layers), Some(HooksOff::Managed));
        // It is a managed-only key: anywhere else it has no effect.
        let layers = SettingsLayers {
            user: layer(r#"{"allowManagedHooksOnly":true}"#),
            ..SettingsLayers::default()
        };
        assert_eq!(hooks_off(&layers), None);
    }

    #[test]
    fn a_non_boolean_value_is_ignored() {
        let layers = SettingsLayers {
            user: layer(r#"{"disableAllHooks":"yes"}"#),
            ..SettingsLayers::default()
        };
        assert_eq!(hooks_off(&layers), None);
    }

    #[test]
    fn parses_a_minimal_event() {
        let line = r#"{"event":"Stop","session_id":"claude-1","transcript_path":"/t/x.jsonl"}"#;
        assert_eq!(
            parse_hook_line(line),
            Some(HookEvent {
                event: "Stop".to_string(),
                session_id: Some("claude-1".to_string()),
                transcript_path: Some("/t/x.jsonl".to_string()),
                ..HookEvent::default()
            })
        );
    }

    #[test]
    fn parses_event_without_optional_fields() {
        assert_eq!(
            parse_hook_line(r#"{"event":"SessionStart"}"#),
            Some(HookEvent {
                event: "SessionStart".to_string(),
                ..HookEvent::default()
            })
        );
    }

    #[test]
    fn parses_agent_tool_event_with_identity() {
        let line = r#"{"event":"PreToolUse","tool_name":"Agent","tool_use_id":"toolu_01","subagent_type":"Explore","description":"Map it"}"#;
        let ev = parse_hook_line(line).expect("parses");
        assert_eq!(ev.tool_name.as_deref(), Some("Agent"));
        assert_eq!(ev.tool_use_id.as_deref(), Some("toolu_01"));
        assert_eq!(ev.subagent_type.as_deref(), Some("Explore"));
        assert_eq!(ev.description.as_deref(), Some("Map it"));
    }

    #[test]
    fn parses_subagent_tool_event_with_enrichment_fields() {
        let line = r#"{"event":"PostToolUse","tool_name":"Edit","tool_use_id":"toolu_9","agent_id":"agent_7","agent_type":"Explore","duration_ms":1234,"target":"src/foo.tsx"}"#;
        let ev = parse_hook_line(line).expect("parses");
        assert_eq!(ev.agent_id.as_deref(), Some("agent_7"));
        assert_eq!(ev.agent_type.as_deref(), Some("Explore"));
        assert_eq!(ev.duration_ms, Some(1234));
        assert_eq!(ev.target.as_deref(), Some("src/foo.tsx"));
    }

    #[test]
    fn enrichment_fields_default_to_none_when_absent() {
        let ev = parse_hook_line(r#"{"event":"Stop"}"#).expect("parses");
        assert_eq!(ev.agent_id, None);
        assert_eq!(ev.agent_type, None);
        assert_eq!(ev.duration_ms, None);
        assert_eq!(ev.target, None);
    }

    #[test]
    fn notification_kind_reads_the_structured_type() {
        use NotificationKind::{Block, IdlePrompt, Informational};
        // Claude Code ≥2.1 tells us *why* it notified. The blocking pair and the
        // idle prompt are the only types that concern this session's status; the
        // rest are status messages that must never claim the user's attention.
        let cases = [
            ("permission_prompt", Block),
            ("elicitation_dialog", Block),
            ("idle_prompt", IdlePrompt),
            ("auth_success", Informational),
            ("elicitation_complete", Informational),
            ("elicitation_response", Informational),
            ("agent_needs_input", Informational),
            ("agent_completed", Informational),
        ];
        for (ty, expected) in cases {
            assert_eq!(
                notification_kind(Some(ty), None),
                expected,
                "notification_type {ty}"
            );
        }
    }

    #[test]
    fn notification_kind_falls_back_to_the_message_without_a_type() {
        use NotificationKind::{Block, IdlePrompt, Unknown};
        // Older Claude Code sends no `notification_type`; the prose match is the
        // only signal left, and anything it can't place stays Unknown so the
        // caller keeps its own conservative rule.
        assert_eq!(
            notification_kind(None, Some("Claude needs your permission to use Bash")),
            Block
        );
        assert_eq!(
            notification_kind(None, Some("Claude is waiting for your input")),
            IdlePrompt
        );
        assert_eq!(notification_kind(None, Some("something new")), Unknown);
        assert_eq!(notification_kind(None, None), Unknown);
        // An unrecognised *type* also degrades to the message, not to Unknown.
        assert_eq!(
            notification_kind(
                Some("future_type"),
                Some("Claude is waiting for your input")
            ),
            IdlePrompt
        );
    }

    #[test]
    fn blank_and_malformed_lines_are_none() {
        assert_eq!(parse_hook_line(""), None);
        assert_eq!(parse_hook_line("   "), None);
        assert_eq!(parse_hook_line("not json"), None);
        assert_eq!(parse_hook_line("{partial"), None);
    }

    #[test]
    fn the_failure_hooks_are_registered() {
        // Claude Code routes a failing turn to `StopFailure` and a failing tool
        // to `PostToolUseFailure` — neither also fires the success hook. Without
        // subscribing, an API-error turn end never reaches Error and a failed
        // tool leaves the summary stuck on "Running …".
        assert!(REGISTERED_HOOK_EVENTS.contains(&"StopFailure"));
        assert!(REGISTERED_HOOK_EVENTS.contains(&"PostToolUseFailure"));
    }

    #[test]
    fn parse_hook_line_keeps_the_notification_type_and_error() {
        let ev = parse_hook_line(
            r#"{"event":"Notification","notification_type":"auth_success","message":"ok"}"#,
        )
        .expect("parses");
        assert_eq!(ev.notification_type.as_deref(), Some("auth_success"));
        let ev =
            parse_hook_line(r#"{"event":"StopFailure","error":"rate_limit"}"#).expect("parses");
        assert_eq!(ev.error.as_deref(), Some("rate_limit"));
    }

    #[test]
    fn parses_usage_snapshot_with_partial_fields() {
        let snap = parse_usage_snapshot(
            r#"{"usedPercentage":28.5,"contextWindowSize":200000,"inputTokens":45000,"model":"Claude Opus 4.8"}"#,
        )
        .expect("snapshot parses");
        assert_eq!(snap.used_percentage, Some(28.5));
        assert_eq!(snap.context_window_size, Some(200_000));
        assert_eq!(snap.input_tokens, Some(45_000));
        assert_eq!(snap.output_tokens, None);
        assert_eq!(snap.model.as_deref(), Some("Claude Opus 4.8"));
    }

    #[test]
    fn malformed_usage_snapshot_is_none() {
        assert!(parse_usage_snapshot("not json").is_none());
    }

    #[test]
    fn usage_snapshot_carries_authoritative_session_id() {
        let snap = parse_usage_snapshot(r#"{"usedPercentage":10,"sessionId":"claude-abc"}"#)
            .expect("snapshot parses");
        assert_eq!(snap.session_id.as_deref(), Some("claude-abc"));
        // Absent sessionId (older snapshots / a status line without it) is None.
        let snap = parse_usage_snapshot(r#"{"usedPercentage":10}"#).expect("snapshot parses");
        assert_eq!(snap.session_id, None);
    }

    #[test]
    fn authoritative_main_id_treats_missing_and_empty_alike() {
        // The one accessor both the status and activity anchor paths use, so an
        // empty id can't anchor one lock while being dropped by the other.
        let snap = parse_usage_snapshot(r#"{"sessionId":"claude-abc"}"#).expect("parses");
        assert_eq!(snap.authoritative_main_id(), Some("claude-abc"));
        let snap = parse_usage_snapshot(r#"{"sessionId":""}"#).expect("parses");
        assert_eq!(snap.authoritative_main_id(), None);
        let snap = parse_usage_snapshot("{}").expect("parses");
        assert_eq!(snap.authoritative_main_id(), None);
    }

    #[test]
    fn parses_ask_fields() {
        let line = r#"{"event":"PreToolUse","tool_name":"AskUserQuestion","tool_use_id":"toolu_5","questions":"[{\"question\":\"Which db?\"}]"}"#;
        let ev = parse_hook_line(line).expect("parses");
        assert_eq!(
            ev.questions.as_deref(),
            Some(r#"[{"question":"Which db?"}]"#)
        );

        let line =
            r#"{"event":"Notification","message":"Claude needs your permission to use Bash"}"#;
        let ev = parse_hook_line(line).expect("parses");
        assert_eq!(
            ev.message.as_deref(),
            Some("Claude needs your permission to use Bash")
        );

        let line = r#"{"event":"PreToolUse","tool_name":"ExitPlanMode","plan":"Ship the thing"}"#;
        let ev = parse_hook_line(line).expect("parses");
        assert_eq!(ev.plan.as_deref(), Some("Ship the thing"));
    }

    #[test]
    fn ask_fields_default_to_none_when_absent() {
        let ev = parse_hook_line(r#"{"event":"Stop"}"#).expect("parses");
        assert_eq!(ev.message, None);
        assert_eq!(ev.questions, None);
        assert_eq!(ev.plan, None);
    }

    #[test]
    fn merge_into_empty_settings_registers_all_events() {
        let mut settings = json!({});
        merge_hook_config(
            &mut settings,
            "python3 '/h/kriyon-hook.py'",
            REGISTERED_HOOK_EVENTS,
        );

        let hooks = settings.get("hooks").unwrap().as_object().unwrap();
        for event in REGISTERED_HOOK_EVENTS {
            let arr = hooks.get(*event).unwrap().as_array().unwrap();
            assert_eq!(arr.len(), 1, "event {event} should have one entry");
            let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains(KRIYON_HOOK_MARKER));
        }
    }

    #[test]
    fn merge_preserves_unrelated_hooks_and_other_keys() {
        let mut settings = json!({
            "model": "opus",
            "hooks": {
                "Stop": [
                    { "hooks": [ { "type": "command", "command": "my-own-thing" } ] }
                ]
            }
        });
        merge_hook_config(
            &mut settings,
            "python3 '/h/kriyon-hook.py'",
            REGISTERED_HOOK_EVENTS,
        );

        // Unrelated top-level key untouched.
        assert_eq!(settings["model"], "opus");
        // The user's own Stop hook is preserved alongside ours.
        let stop = settings["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert!(stop
            .iter()
            .any(|e| e["hooks"][0]["command"] == "my-own-thing"));
        assert!(stop.iter().any(|e| e["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains(KRIYON_HOOK_MARKER)));
    }

    #[test]
    fn merge_is_idempotent() {
        let cmd = "python3 '/h/kriyon-hook.py'";
        let mut settings = json!({});
        merge_hook_config(&mut settings, cmd, REGISTERED_HOOK_EVENTS);
        merge_hook_config(&mut settings, cmd, REGISTERED_HOOK_EVENTS);
        merge_hook_config(&mut settings, cmd, REGISTERED_HOOK_EVENTS);

        for event in REGISTERED_HOOK_EVENTS {
            let arr = settings["hooks"][*event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "event {event} must not accumulate duplicates");
        }
    }

    #[test]
    fn merge_replaces_a_stale_kriyon_entry() {
        let mut settings = json!({});
        merge_hook_config(&mut settings, "python3 '/old/kriyon-hook.py'", &["Stop"]);
        merge_hook_config(&mut settings, "python3 '/new/kriyon-hook.py'", &["Stop"]);

        let arr = settings["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(
            cmd.contains("/new/"),
            "stale Kriyon entry should be replaced"
        );
    }

    /// ADR-0066: an install from before Rust (a Python hook entry) becomes
    /// the program's, once and idempotently; the person's own hooks stay.
    #[test]
    fn a_python_hook_entry_is_replaced_by_the_hook_program() {
        let mut settings = json!({"hooks": {"Stop": [
            {"hooks": [{"type": "command", "command": "python3 '/h/.claude/kriyon/kriyon-hook.py'"}]},
            {"hooks": [{"type": "command", "command": "~/bin/my-own-hook.sh"}]}
        ]}});
        let program = "'/h/.claude/kriyon/bin/kriyon-hook' event";
        merge_hook_config(&mut settings, program, &["Stop"]);
        let again = settings.clone();
        merge_hook_config(&mut settings, program, &["Stop"]);
        assert_eq!(settings, again, "idempotent");
        let commands: Vec<&str> = settings["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["hooks"][0]["command"].as_str().unwrap())
            .collect();
        assert_eq!(commands, ["~/bin/my-own-hook.sh", program]);
    }

    #[test]
    fn a_malformed_background_list_never_loses_the_event() {
        // The Stop itself is what matters; a list Kriyon can't read degrades to
        // "not reported" and a bad entry is skipped.
        let ev = parse_hook_line(r#"{"event":"Stop","background_tasks":"soon"}"#).expect("parses");
        assert_eq!(ev.event, "Stop");
        assert_eq!(ev.background_tasks, None);
        let ev = parse_hook_line(
            r#"{"event":"Stop","background_tasks":[7,{"type":"subagent"},{"id":"a","type":"subagent"}]}"#,
        )
        .expect("parses");
        let ids: Vec<_> = ev
            .background_tasks
            .expect("the list")
            .into_iter()
            .map(|w| w.id)
            .collect();
        assert_eq!(ids, ["a"]);
    }
}
