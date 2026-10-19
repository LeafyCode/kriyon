//! The [Activity log]'s pure half: what one [Hook spool] line means for the
//! log — a prompt opening a turn, a turn ending, an [Activity step] starting
//! or finishing — plus each step's kind, its [Step flags] and what allowed it.
//! The SQLite half (`src-tauri/src/activity_store.rs`) only stores what this
//! decides.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use crate::hooks::HookEvent;
use crate::redact::{redact, redact_json_text};
use crate::work_report;

/// What sort of thing an [Activity step] did, for its label and filter chips.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepKind {
    Read,
    Search,
    Edit,
    Write,
    Command,
    Web,
    Agent,
    Mcp,
    Other,
}

impl StepKind {
    /// The kind of Claude Code tool `tool`.
    #[must_use]
    pub fn of(tool: &str) -> Self {
        match tool {
            "Read" | "NotebookRead" => Self::Read,
            "Grep" | "Glob" | "LS" | "ToolSearch" => Self::Search,
            "Edit" | "MultiEdit" | "NotebookEdit" => Self::Edit,
            "Write" => Self::Write,
            "Bash" | "BashOutput" | "KillShell" | "KillBash" | "PowerShell" => Self::Command,
            "WebFetch" | "WebSearch" => Self::Web,
            "Agent" | "Task" => Self::Agent,
            t if t.starts_with("mcp__") => Self::Mcp,
            _ => Self::Other,
        }
    }

    /// The stored name (matches the serde form).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Search => "search",
            Self::Edit => "edit",
            Self::Write => "write",
            Self::Command => "command",
            Self::Web => "web",
            Self::Agent => "agent",
            Self::Mcp => "mcp",
            Self::Other => "other",
        }
    }

    /// The stored name back to a kind; anything unknown is `Other`.
    #[must_use]
    pub fn parse(name: &str) -> Self {
        [
            Self::Read,
            Self::Search,
            Self::Edit,
            Self::Write,
            Self::Command,
            Self::Web,
            Self::Agent,
            Self::Mcp,
        ]
        .into_iter()
        .find(|k| k.as_str() == name)
        .unwrap_or(Self::Other)
    }

    /// Whether the step only looks, never changes anything.
    #[must_use]
    pub const fn is_read_only(self) -> bool {
        matches!(self, Self::Read | Self::Search)
    }
}

/// [Step flags]: the things about a step worth a second look. A bit set, so
/// the store can filter on them with one integer column.
pub mod flags {
    /// Installed a package, plugin or MCP server (known by command shape only).
    pub const INSTALLED: u32 = 1;
    /// Deleted files, or rewrote history (`rm`, `git reset --hard`, …).
    pub const DELETED: u32 = 1 << 1;
    /// Reached the internet.
    pub const NETWORK: u32 = 1 << 2;
    /// Read or wrote a file outside the session's folder.
    pub const OUTSIDE_PROJECT: u32 = 1 << 3;
    /// Touched a file that usually holds secrets (`.env`, keys, `~/.ssh`, …).
    pub const SECRET_FILE: u32 = 1 << 4;
    /// Removed a package (`npm uninstall`, `brew uninstall`, …).
    pub const REMOVED_PACKAGE: u32 = 1 << 5;
}

/// A shell-command boundary: start of text or a separator before the word.
const CMD: &str = r"(?:^|[\s;&|(`])";

static INSTALLS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"{CMD}(?:(?:npm|pnpm|yarn|bun)\s+(?:add|install|i)\b|pip3?\s+install\b|uv\s+(?:add|pip\s+install)\b|brew\s+install\b|cargo\s+(?:add|install)\b|go\s+install\b|gem\s+install\b|apt(?:-get)?\s+install\b|claude\s+(?:plugin\s+install|mcp\s+add)\b|(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b)"
    ))
    .expect("a constant pattern")
});

static DELETES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"{CMD}(?:rm|rmdir|unlink|shred)\s|{CMD}git\s+(?:reset\s+--hard|clean\b|push\s+(?:.*\s)?(?:--force\b|-f\b)|branch\s+-D\b)|\s-delete\b"
    ))
    .expect("a constant pattern")
});

static REMOVES_PACKAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"{CMD}(?:(?:npm|pnpm|yarn|bun)\s+(?:uninstall|remove|rm|un)\b|pip3?\s+uninstall\b|uv\s+(?:remove|pip\s+uninstall)\b|brew\s+(?:uninstall|remove)\b|cargo\s+(?:remove|uninstall)\b|gem\s+uninstall\b|apt(?:-get)?\s+(?:remove|purge)\b)"
    ))
    .expect("a constant pattern")
});

static NETWORK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"{CMD}(?:curl|wget|ssh|scp|rsync|nc|ftp|http)\s|{CMD}git\s+(?:push|pull|fetch|clone)\b|https?://"
    ))
    .expect("a constant pattern")
});

static SECRET_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?:^|[/\s'"=])(?:\.env(?:\.[A-Za-z0-9_-]+)?|[^/\s'"]+\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519|ecdsa|dsa)|\.netrc|\.npmrc|\.pypirc)(?:$|[\s'"])|/\.ssh/|/\.aws/|/\.gnupg/|\.credentials"#,
    )
    .expect("a constant pattern")
});

/// Templates that look like secret files but are meant to be shared.
static SAFE_ENV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\.env\.(?:example|sample|template|dist)\b").expect("a constant pattern")
});

/// The [Step flags] for one step. `path` is the file a file tool touched;
/// `command` the shell command a command tool ran; `cwd` the session folder.
#[must_use]
pub fn step_flags(
    kind: StepKind,
    command: Option<&str>,
    path: Option<&str>,
    cwd: Option<&str>,
) -> u32 {
    let mut out = 0;
    if kind == StepKind::Web {
        out |= flags::NETWORK;
    }
    if let Some(cmd) = command.filter(|_| kind == StepKind::Command) {
        if INSTALLS.is_match(cmd) {
            out |= flags::INSTALLED;
        }
        if DELETES.is_match(cmd) {
            out |= flags::DELETED;
        }
        if REMOVES_PACKAGE.is_match(cmd) {
            out |= flags::REMOVED_PACKAGE;
        }
        if NETWORK.is_match(cmd) {
            out |= flags::NETWORK;
        }
        if is_secret_path(cmd) {
            out |= flags::SECRET_FILE;
        }
        if reaches_outside(cmd, cwd) {
            out |= flags::OUTSIDE_PROJECT;
        }
    }
    if let Some(path) = path {
        if is_secret_path(path) {
            out |= flags::SECRET_FILE;
        }
        if is_outside(path, cwd) {
            out |= flags::OUTSIDE_PROJECT;
        }
    }
    out
}

fn is_secret_path(text: &str) -> bool {
    SECRET_PATH.is_match(text) && !SAFE_ENV.is_match(text)
}

/// An absolute path not under `cwd`. A relative path is inside by definition;
/// with no `cwd` known nothing is flagged.
fn is_outside(path: &str, cwd: Option<&str>) -> bool {
    let Some(cwd) = cwd.filter(|c| c.starts_with('/')) else {
        return false;
    };
    if !path.starts_with('/') {
        return false;
    }
    let root = cwd.trim_end_matches('/');
    !(path == root || path.starts_with(&format!("{root}/")))
}

/// A path a command names in the home folder or the system's own: `~/…`,
/// `$HOME/…`, `/Users/…`, `/etc/…`, `/Volumes/…`. Scratch places (`/tmp`,
/// `/dev/null`) and tools (`/usr/bin`) are left out: using them is routine.
static COMMAND_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?:^|[\s'"=(<>|;&])((?:~|\$HOME|\$\{HOME\})/[^\s'"<>|;&)]*|/(?:Users|etc|private/etc|Volumes)/[^\s'"<>|;&)]*)"#,
    )
    .expect("a constant pattern")
});

/// Whether a command names a file outside the session folder `cwd` — best
/// effort, from the paths it spells out. `~` is the home folder `cwd` sits
/// in; with `cwd` outside any home folder, a `~` path can't be inside it.
fn reaches_outside(command: &str, cwd: Option<&str>) -> bool {
    let Some(cwd) = cwd else {
        return false;
    };
    let home = cwd
        .strip_prefix("/Users/")
        .and_then(|rest| rest.split('/').next())
        .map(|user| format!("/Users/{user}"));
    COMMAND_PATH.captures_iter(command).any(|c| {
        let path = &c[1];
        let rest = ["~", "$HOME", "${HOME}"]
            .iter()
            .find_map(|h| path.strip_prefix(h).filter(|r| r.starts_with('/')));
        match (rest, &home) {
            (Some(rest), Some(home)) => is_outside(&format!("{home}{rest}"), Some(cwd)),
            (Some(_), None) => true,
            (None, _) => is_outside(path, Some(cwd)),
        }
    })
}

/// Where an [Activity step] stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Running,
    Ok,
    Error,
}

impl StepStatus {
    /// The stored name back to a status; anything unknown reads as finished.
    #[must_use]
    pub fn parse(name: &str) -> Self {
        match name {
            "running" => Self::Running,
            "error" => Self::Error,
            _ => Self::Ok,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Ok => "ok",
            Self::Error => "error",
        }
    }
}

/// One step's start or end, as the store merges it by `tool_use_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepUpdate {
    pub tool_use_id: String,
    pub prompt_id: Option<String>,
    pub claude_session_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub tool_name: String,
    pub kind: StepKind,
    pub target: Option<String>,
    /// What the step was for, in one line — see [`step_summary`].
    pub summary: Option<String>,
    /// The lines a file change added and removed (an edit, a write, or the
    /// files a command edited).
    pub lines_added: Option<i64>,
    pub lines_removed: Option<i64>,
    /// Whether a write made a new file.
    pub created: Option<bool>,
    /// What came of the call in a few words ("43 passed", "6 files").
    pub outcome: Option<String>,
    /// The files a command changed.
    pub changed_files: Vec<String>,
    /// For a step that launched a [Subagent], the type it launched
    /// ([`DEFAULT_SUBAGENT`] when it named none).
    pub launched_type: Option<String>,
    /// The agent a background launch started, when Claude Code said.
    pub launched_agent: Option<String>,
    /// For a [Subagent]'s step, the launch call that started it.
    pub launched_by: Option<String>,
    pub input: Option<String>,
    pub result: Option<String>,
    pub status: StepStatus,
    pub flags: u32,
    pub permission_mode: Option<String>,
    /// When the hook fired (epoch ms).
    pub at_ms: i64,
    pub duration_ms: Option<i64>,
}

/// What one [Hook spool] line means for the [Activity log].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogEntry {
    /// A prompt opened a turn.
    Prompt {
        prompt_id: Option<String>,
        claude_session_id: Option<String>,
        text: String,
        source: Option<String>,
        at_ms: i64,
    },
    /// The turn ended (`stop`, or `error:<kind>` after an API error).
    TurnEnd {
        prompt_id: Option<String>,
        claude_session_id: Option<String>,
        reason: String,
        at_ms: i64,
    },
    /// A step started or finished.
    /// Boxed: a step carries far more than the other entries.
    Step(Box<StepUpdate>),
    /// Claude asked the user's permission for the latest running `tool_name`
    /// step (the request carries no step id).
    Asked {
        tool_name: String,
        /// The conversation that asked, so the mark lands on its own call.
        claude_session_id: Option<String>,
        at_ms: i64,
    },
    /// A `claude` in the session ended: its steps still running never will
    /// finish. Scoped to that conversation — a nested `claude -p` ending must
    /// not close the main conversation's steps.
    SessionEnded {
        claude_session_id: Option<String>,
        at_ms: i64,
    },
}

/// The [Activity log] entry for one hook event, or `None` when it has none
/// (a notification, a session start, a tool event with no id or timestamp).
/// Every stored text is redacted again here, so lines from an older hook
/// script are covered too.
#[must_use]
pub fn log_entry(ev: &HookEvent) -> Option<LogEntry> {
    let at_ms = parse_iso_ms(ev.ts.as_deref()?)?;
    match ev.event.as_str() {
        "UserPromptSubmit" => Some(LogEntry::Prompt {
            prompt_id: ev.prompt_id.clone(),
            claude_session_id: ev.session_id.clone(),
            text: redact(ev.prompt.as_deref().unwrap_or_default()),
            source: ev.prompt_source.clone(),
            at_ms,
        }),
        "Stop" | "StopFailure" => Some(LogEntry::TurnEnd {
            prompt_id: ev.prompt_id.clone(),
            claude_session_id: ev.session_id.clone(),
            reason: match (ev.event.as_str(), ev.error.as_deref()) {
                ("StopFailure", Some(kind)) => format!("error:{kind}"),
                ("StopFailure", None) => "error".to_string(),
                _ => "stop".to_string(),
            },
            at_ms,
        }),
        "SessionEnd" => Some(LogEntry::SessionEnded {
            claude_session_id: ev.session_id.clone(),
            at_ms,
        }),
        "PermissionRequest" => Some(LogEntry::Asked {
            tool_name: ev.tool_name.clone()?,
            claude_session_id: ev.session_id.clone(),
            at_ms,
        }),
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => {
            step_update(ev, at_ms).map(|step| LogEntry::Step(Box::new(step)))
        }
        _ => None,
    }
}

fn step_update(ev: &HookEvent, at_ms: i64) -> Option<StepUpdate> {
    let tool_use_id = ev.tool_use_id.clone().filter(|id| !id.is_empty())?;
    let tool_name = ev.tool_name.clone().unwrap_or_default();
    let kind = StepKind::of(&tool_name);
    let status = match ev.event.as_str() {
        "PreToolUse" => StepStatus::Running,
        "PostToolUse" => StepStatus::Ok,
        _ => StepStatus::Error,
    };
    let input = ev.input.as_deref().map(redact_json_text);
    let path = input_path(input.as_deref()).or_else(|| {
        matches!(kind, StepKind::Read | StepKind::Edit | StepKind::Write)
            .then(|| ev.target.clone())
            .flatten()
    });
    let result = match status {
        StepStatus::Error => ev.error.as_deref().or(ev.result.as_deref()),
        _ => ev.result.as_deref(),
    };
    let description = ev.description.as_deref().map(redact);
    let summary = step_summary(&tool_name, input.as_deref(), description.as_deref());
    let changed_files: Vec<String> = ev
        .changed_files
        .iter()
        .flatten()
        .map(|f| redact(f))
        .collect();
    // A file a command changed counts like one a file tool touched.
    let changed_flags = changed_files.iter().fold(0, |out, file| {
        out | step_flags(StepKind::Edit, None, Some(file), ev.cwd.as_deref())
    });
    Some(StepUpdate {
        flags: changed_flags
            | step_flags(
                kind,
                ev.command.as_deref(),
                path.as_deref(),
                ev.cwd.as_deref(),
            ),
        tool_use_id,
        prompt_id: ev.prompt_id.clone(),
        claude_session_id: ev.session_id.clone(),
        agent_id: ev.agent_id.clone().filter(|a| !a.is_empty()),
        agent_type: ev.agent_type.clone(),
        tool_name,
        kind,
        target: ev.target.as_deref().map(redact),
        summary,
        lines_added: ev.lines_added.and_then(|n| i64::try_from(n).ok()),
        lines_removed: ev.lines_removed.and_then(|n| i64::try_from(n).ok()),
        created: ev.created,
        outcome: ev.outcome.as_deref().map(redact),
        changed_files,
        launched_type: (kind == StepKind::Agent).then(|| {
            ev.subagent_type
                .clone()
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| DEFAULT_SUBAGENT.to_string())
        }),
        launched_agent: ev.launched_agent_id.clone().filter(|a| !a.is_empty()),
        launched_by: ev.launched_by.clone(),
        input,
        result: result.map(redact),
        status,
        permission_mode: ev.permission_mode.clone(),
        at_ms,
        duration_ms: ev.duration_ms.and_then(|d| i64::try_from(d).ok()),
    })
}

/// The subagent type Claude Code runs when a launch names none.
pub const DEFAULT_SUBAGENT: &str = "general-purpose";

/// A step that launched a [Subagent], as [`link_subagents`] needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentLaunch {
    /// The step's own id in the store.
    pub step_id: i64,
    /// Claude Code's id for the launch call.
    pub tool_use_id: String,
    /// The type it launched, [`DEFAULT_SUBAGENT`] when it named none.
    pub launched_type: String,
    /// The launched agent's id, when Claude Code said it (a background launch).
    pub launched_agent: Option<String>,
    pub started_ms: i64,
}

/// What [`link_subagents`] knows of one [Subagent] from its own steps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentSeen {
    pub agent_id: String,
    pub agent_type: Option<String>,
    /// The launch call its sidecar names, when the hook could read it.
    pub launched_by: Option<String>,
    /// When its first step started.
    pub first_ms: i64,
}

/// One launch as the subagent-linking rule sees it — the one rule both the
/// live Agents panel (`HookActivity`) and the [Activity log] link by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchKey<'a> {
    pub tool_use_id: &'a str,
    pub launched_type: &'a str,
    pub launched_agent: Option<&'a str>,
    /// When it started, when the caller knows it as a number.
    pub started_ms: Option<i64>,
    /// Not yet linked to another subagent (and, live, still running).
    pub free: bool,
}

/// One [Subagent] as the linking rule sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentKey<'a> {
    pub agent_id: &'a str,
    pub agent_type: Option<&'a str>,
    pub launched_by: Option<&'a str>,
    /// When its first step started, when the caller knows it as a number.
    pub first_ms: Option<i64>,
}

/// The launch that certainly started `agent`: the one its sidecar names, or
/// the background launch that returned its id — while it is still free. A
/// launch already given to another subagent (by an earlier guess) is never
/// taken from it, so no binding is silently dropped.
#[must_use]
pub fn exact_launch(agent: &AgentKey<'_>, launches: &[LaunchKey<'_>]) -> Option<usize> {
    launches.iter().position(|l| {
        l.free
            && (agent.launched_by == Some(l.tool_use_id)
                || l.launched_agent == Some(agent.agent_id))
    })
}

/// The launch that probably started `agent` when nothing names it: the
/// earliest free launch of its type made before its first step. It can mix up
/// two of one type started together. A subagent with no type is Claude Code's
/// own helper, which nobody launched.
#[must_use]
pub fn guessed_launch(agent: &AgentKey<'_>, launches: &[LaunchKey<'_>]) -> Option<usize> {
    let kind = agent.agent_type?;
    launches.iter().position(|l| {
        let before = match (l.started_ms, agent.first_ms) {
            (Some(launch), Some(first)) => launch <= first,
            _ => true,
        };
        l.free && l.launched_type == kind && before
    })
}

impl SubagentSeen {
    fn key(&self) -> AgentKey<'_> {
        AgentKey {
            agent_id: &self.agent_id,
            agent_type: self.agent_type.as_deref(),
            launched_by: self.launched_by.as_deref(),
            first_ms: Some(self.first_ms),
        }
    }
}

/// Which launch started each [Subagent]: agent id → the launch's step id.
/// Every exact link ([`exact_launch`]) is made before any guess
/// ([`guessed_launch`]), so a guess never takes a launch another subagent's
/// sidecar names. `agents` in first-step order.
#[must_use]
pub fn link_subagents(
    launches: &[SubagentLaunch],
    agents: &[SubagentSeen],
) -> HashMap<String, i64> {
    let mut claimed = HashSet::new();
    let keys = |claimed: &HashSet<i64>| -> Vec<LaunchKey<'_>> {
        launches
            .iter()
            .map(|l| LaunchKey {
                tool_use_id: &l.tool_use_id,
                launched_type: &l.launched_type,
                launched_agent: l.launched_agent.as_deref(),
                started_ms: Some(l.started_ms),
                free: !claimed.contains(&l.step_id),
            })
            .collect()
    };
    let mut links = HashMap::new();
    let mut guess = Vec::new();
    for agent in agents {
        match exact_launch(&agent.key(), &keys(&claimed)) {
            Some(i) => {
                claimed.insert(launches[i].step_id);
                links.insert(agent.agent_id.clone(), launches[i].step_id);
            }
            None => guess.push(agent),
        }
    }
    for agent in guess {
        if let Some(i) = guessed_launch(&agent.key(), &keys(&claimed)) {
            claimed.insert(launches[i].step_id);
            links.insert(agent.agent_id.clone(), launches[i].step_id);
        }
    }
    links
}

/// The line that heads a turn no person started, or `None` for a person's
/// prompt: Claude Code's own [Work report]s (`<task-notification>`), and a
/// message another agent sent the main agent (`<agent-message from="…">`) —
/// a [Subagent] handing back its report, named `agent` when that is known.
/// Their tags are for the model; the person reads the summary.
#[must_use]
pub fn report_heading(prompt: &str, agent: Option<&str>) -> Option<String> {
    if let Some(reports) = work_report::parse(prompt) {
        let summaries: Vec<String> = reports.into_iter().map(|r| r.summary).collect();
        return Some(summaries.join(" · "));
    }
    let peer = prompt.trim_start();
    (peer.starts_with("<agent-message") || peer.starts_with(PEER_PREFACE))
        .then(|| work_report::from_peer(prompt, agent).summary)
}

/// How Claude Code introduces another session's message before its tag.
const PEER_PREFACE: &str = "Another Claude session sent a message:";

/// The input field that says what a tool call was about, for the tools whose
/// call has no `description`: what a search looked for, the page it opened.
fn summary_key(tool: &str) -> Option<&'static str> {
    match tool {
        "Grep" | "Glob" => Some("pattern"),
        "WebSearch" | "ToolSearch" => Some("query"),
        "WebFetch" => Some("url"),
        "Skill" => Some("skill"),
        "ScheduleWakeup" => Some("reason"),
        _ => None,
    }
}

/// The longest summary kept: a row shows one line of it.
const SUMMARY_MAX: usize = 200;

/// What a step was for, in one line: the `description` Claude writes for a
/// command or a subagent ("Run the tests"), or the input that names what a
/// search or fetch was about. Costs no tokens — Claude already sends it.
///
/// `description` is the hook's own copy, kept for when the recorded `input`
/// was capped mid-JSON and no longer parses (a long command comes first).
#[must_use]
pub fn step_summary(tool: &str, input: Option<&str>, description: Option<&str>) -> Option<String> {
    let value: Option<serde_json::Value> = input.and_then(|i| serde_json::from_str(i).ok());
    let field = |key: &str| value.as_ref()?.get(key)?.as_str().map(str::to_string);
    let text = summary_key(tool)
        .and_then(field)
        .or_else(|| field("description"))
        .or_else(|| description.map(str::to_string))?;
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(match line.char_indices().nth(SUMMARY_MAX) {
        Some((cut, _)) => format!("{}\u{2026}", line[..cut].trim_end()),
        None => line.to_string(),
    })
}

/// The file a tool input names (`file_path`, `notebook_path`, `path`), when the
/// recorded input still parses (a capped one may not).
fn input_path(input: Option<&str>) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(input?).ok()?;
    ["file_path", "notebook_path", "path"]
        .iter()
        .find_map(|key| value.get(key)?.as_str().map(str::to_string))
}

/// Plain words for what let a step run. From hooks alone the rule that
/// matched is unknown, so this names one only when the companion reported it
/// (`check`). A permission dialog alone doesn't prove the user said yes: only a
/// step that then finished reads as approved.
#[must_use]
pub fn allowed_by(
    kind: StepKind,
    permission_mode: Option<&str>,
    asked: bool,
    status: StepStatus,
    check: Option<&crate::bridge::ToolCheck>,
) -> String {
    if asked {
        return match status {
            StepStatus::Ok => "You approved it in the terminal",
            StepStatus::Running => "Waiting for your answer in the terminal",
            StepStatus::Error => "You were asked in the terminal; it didn't complete",
        }
        .to_string();
    }
    if let Some(rule) = check
        .filter(|c| c.decision == "allow")
        .and_then(|c| c.rule.as_deref())
    {
        return format!("Allowed by your rule {rule}");
    }
    if permission_mode == Some("auto")
        && status == StepStatus::Ok
        && check.is_some_and(|c| c.decision == "ask")
    {
        return "Auto mode approved it (your settings would have asked)".to_string();
    }
    match permission_mode {
        Some("bypassPermissions") => "Bypass-permissions mode (no prompts)",
        Some("acceptEdits") if matches!(kind, StepKind::Edit | StepKind::Write) => {
            "Accept-edits mode"
        }
        Some("auto") => "Auto mode",
        _ if kind.is_read_only() => "Read-only, no prompt needed",
        _ => "Allowed by your permission settings",
    }
    .to_string()
}

/// Epoch milliseconds for an ISO-8601 UTC-offset timestamp as the hook script
/// writes it (`2026-10-03T12:00:00.123456+00:00`, or a `Z` suffix). `None`
/// for anything else — a bad line is skipped, never an error.
#[must_use]
pub fn parse_iso_ms(ts: &str) -> Option<i64> {
    let (date, rest) = ts.split_once('T')?;
    let mut ymd = date.splitn(3, '-').map(str::parse::<i64>);
    let (year, month, day) = (ymd.next()?.ok()?, ymd.next()?.ok()?, ymd.next()?.ok()?);
    let (clock, offset_secs) = if let Some(c) = rest.strip_suffix('Z') {
        (c, 0)
    } else {
        let at = rest.rfind(['+', '-'])?;
        let (c, off) = rest.split_at(at);
        let sign = if off.starts_with('-') { -1 } else { 1 };
        let mut parts = off[1..].splitn(2, ':').map(str::parse::<i64>);
        let hours = parts.next()?.ok()?;
        let minutes = parts.next().unwrap_or(Ok(0)).ok()?;
        (c, sign * (hours * 3600 + minutes * 60))
    };
    let (hms, frac) = clock.split_once('.').unwrap_or((clock, ""));
    let mut parts = hms.splitn(3, ':').map(str::parse::<i64>);
    let (hour, minute, second) = (
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next()?.ok()?,
    );
    let millis = format!("{frac:0<3}").get(..3)?.parse::<i64>().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3600 + minute * 60 + second - offset_secs) * 1000) + millis)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm).
const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::parse_hook_line;

    fn ev(json: &str) -> HookEvent {
        parse_hook_line(json).expect("a hook line")
    }

    #[test]
    fn parses_the_hook_scripts_timestamps() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00+00:00"), Some(0));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(
            parse_iso_ms("2026-10-03T12:00:00.123456+00:00"),
            Some(1_791_028_800_123)
        );
        assert_eq!(
            parse_iso_ms("2026-10-03T14:00:00+02:00"),
            parse_iso_ms("2026-10-03T12:00:00Z")
        );
        assert_eq!(parse_iso_ms("not a time"), None);
        assert_eq!(parse_iso_ms("2026-13-03T12:00:00Z"), None);
    }

    #[test]
    fn kinds_cover_the_built_in_tools() {
        assert_eq!(StepKind::of("Read"), StepKind::Read);
        assert_eq!(StepKind::of("Grep"), StepKind::Search);
        assert_eq!(StepKind::of("MultiEdit"), StepKind::Edit);
        assert_eq!(StepKind::of("Write"), StepKind::Write);
        assert_eq!(StepKind::of("Bash"), StepKind::Command);
        assert_eq!(StepKind::of("WebFetch"), StepKind::Web);
        assert_eq!(StepKind::of("Agent"), StepKind::Agent);
        assert_eq!(StepKind::of("mcp__github__create_issue"), StepKind::Mcp);
        assert_eq!(StepKind::of("TodoWrite"), StepKind::Other);
        for kind in [StepKind::Read, StepKind::Mcp, StepKind::Other] {
            assert_eq!(StepKind::parse(kind.as_str()), kind);
        }
    }

    fn cmd_flags(cmd: &str) -> u32 {
        step_flags(StepKind::Command, Some(cmd), None, Some("/w"))
    }

    #[test]
    fn flags_installs_by_command_shape() {
        for cmd in [
            "pnpm add zod",
            "cd web && npm install",
            "pip install requests",
            "brew install jq",
            "cargo add serde",
            "claude mcp add github",
            "curl -fsSL https://x.sh | sh",
        ] {
            assert_ne!(cmd_flags(cmd) & flags::INSTALLED, 0, "{cmd}");
        }
        for cmd in ["pnpm test", "npm run build", "echo install", "cargo build"] {
            assert_eq!(cmd_flags(cmd) & flags::INSTALLED, 0, "{cmd}");
        }
    }

    #[test]
    fn flags_deletes_and_history_rewrites() {
        for cmd in [
            "rm -rf dist",
            "git reset --hard HEAD~1",
            "git push origin main --force",
            "git clean -fdx",
            "find . -name '*.log' -delete",
        ] {
            assert_ne!(cmd_flags(cmd) & flags::DELETED, 0, "{cmd}");
        }
        for cmd in [
            "npm uninstall date-fns",
            "pnpm remove zod",
            "yarn remove zod",
            "pip uninstall -y requests",
            "uv pip uninstall requests",
            "brew uninstall jq",
            "cargo remove serde",
        ] {
            let flags = cmd_flags(cmd);
            assert_ne!(flags & flags::REMOVED_PACKAGE, 0, "{cmd}");
            assert_eq!(flags & flags::DELETED, 0, "{cmd}: a package, not files");
        }
        for cmd in [
            "git status",
            "npm run format",
            "git push origin main",
            "npm install zod",
        ] {
            assert_eq!(cmd_flags(cmd) & flags::DELETED, 0, "{cmd}");
        }
    }

    #[test]
    fn flags_network_use() {
        assert_ne!(cmd_flags("curl -s api.example.com") & flags::NETWORK, 0);
        assert_ne!(cmd_flags("git push origin main") & flags::NETWORK, 0);
        assert_eq!(cmd_flags("git commit -m x") & flags::NETWORK, 0);
        assert_ne!(
            step_flags(StepKind::Web, None, None, None) & flags::NETWORK,
            0
        );
    }

    #[test]
    fn flags_files_outside_the_project_and_secret_files() {
        let read = |path: &str| step_flags(StepKind::Read, None, Some(path), Some("/w/app"));
        assert_ne!(read("/etc/hosts") & flags::OUTSIDE_PROJECT, 0);
        assert_ne!(
            read("/w/app-other/x") & flags::OUTSIDE_PROJECT,
            0,
            "a sibling is outside"
        );
        assert_eq!(read("/w/app/src/main.rs") & flags::OUTSIDE_PROJECT, 0);
        assert_eq!(read("src/main.rs") & flags::OUTSIDE_PROJECT, 0);

        assert_ne!(read("/w/app/.env") & flags::SECRET_FILE, 0);
        assert_ne!(read("/w/app/.env.local") & flags::SECRET_FILE, 0);
        assert_ne!(read("/Users/me/.ssh/id_ed25519") & flags::SECRET_FILE, 0);
        assert_ne!(read("/w/app/certs/server.pem") & flags::SECRET_FILE, 0);
        assert_eq!(read("/w/app/.env.example") & flags::SECRET_FILE, 0);
        assert_eq!(read("/w/app/src/environment.ts") & flags::SECRET_FILE, 0);
        assert_ne!(cmd_flags("cat .env") & flags::SECRET_FILE, 0);
    }

    #[test]
    fn flags_a_command_that_reaches_outside_the_project() {
        let run = |cmd: &str| {
            step_flags(StepKind::Command, Some(cmd), None, Some("/Users/me/app"))
                & flags::OUTSIDE_PROJECT
        };
        assert_ne!(run("cat ~/.claude/settings.json"), 0);
        assert_ne!(
            run("for f in src/*; do cat \"$f\"; done; cat $HOME/.zshrc"),
            0
        );
        assert_ne!(run("ls /Users/me/other"), 0);
        assert_ne!(run("cat /etc/hosts"), 0);
        assert_eq!(run("cat ~/app/src/a.js"), 0, "inside, spelled from home");
        assert_eq!(run("cat /Users/me/app/src/a.js"), 0);
        assert_eq!(
            run("npm test 2>/dev/null > /tmp/out.txt"),
            0,
            "scratch places"
        );
        assert_eq!(run("/usr/bin/env node a.js"), 0);
        assert_ne!(
            cmd_flags("cat ~/.npmrc") & flags::OUTSIDE_PROJECT,
            0,
            "no home known"
        );
    }

    #[test]
    fn a_launch_step_says_what_it_launched() {
        let entry = |json: &str| {
            let Some(LogEntry::Step(step)) = log_entry(&ev(json)) else {
                panic!("a step");
            };
            step
        };
        let typed = entry(
            r#"{"event":"PostToolUse","tool_name":"Agent","tool_use_id":"t1","subagent_type":"Explore","launched_agent_id":"a9","ts":"1970-01-01T00:00:01Z"}"#,
        );
        assert_eq!(typed.launched_type.as_deref(), Some("Explore"));
        assert_eq!(typed.launched_agent.as_deref(), Some("a9"));
        let untyped = entry(
            r#"{"event":"PreToolUse","tool_name":"Agent","tool_use_id":"t2","launched_agent_id":"","ts":"1970-01-01T00:00:01Z"}"#,
        );
        assert_eq!(untyped.launched_type.as_deref(), Some(DEFAULT_SUBAGENT));
        assert_eq!(untyped.launched_agent, None);
        let sub = entry(
            r#"{"event":"PreToolUse","tool_name":"Read","tool_use_id":"t3","agent_id":"a9","launched_by":"t1","ts":"1970-01-01T00:00:01Z"}"#,
        );
        assert_eq!(
            (sub.launched_type, sub.launched_by.as_deref()),
            (None, Some("t1"))
        );
    }

    #[test]
    fn a_command_that_changed_files_outside_is_flagged() {
        let step = log_entry(&ev(
            r#"{"event":"PostToolUse","tool_name":"Bash","tool_use_id":"t1","command":"./fix.sh","changed_files":["/w/a.js","/u/.zshrc"],"cwd":"/w","ts":"1970-01-01T00:00:01Z"}"#,
        ));
        let Some(LogEntry::Step(step)) = step else {
            panic!("a step: {step:?}");
        };
        assert_ne!(step.flags & flags::OUTSIDE_PROJECT, 0);
        assert_eq!(step.changed_files, ["/w/a.js", "/u/.zshrc"]);
    }

    #[test]
    fn a_prompt_opens_a_turn_and_a_stop_ends_it() {
        let prompt = log_entry(&ev(
            r#"{"event":"UserPromptSubmit","session_id":"c1","prompt_id":"p1","prompt":"fix it token=abc","prompt_source":"user","ts":"1970-01-01T00:00:01Z"}"#,
        ));
        assert_eq!(
            prompt,
            Some(LogEntry::Prompt {
                prompt_id: Some("p1".into()),
                claude_session_id: Some("c1".into()),
                text: "fix it token=[REDACTED]".into(),
                source: Some("user".into()),
                at_ms: 1000,
            })
        );
        let failed = log_entry(&ev(
            r#"{"event":"StopFailure","error":"rate_limit","ts":"1970-01-01T00:00:02Z"}"#,
        ));
        assert!(
            matches!(failed, Some(LogEntry::TurnEnd { ref reason, .. }) if reason == "error:rate_limit")
        );
    }

    #[test]
    fn a_tool_event_becomes_a_step_update() {
        let pre = log_entry(&ev(
            r#"{"event":"PreToolUse","tool_name":"Bash","tool_use_id":"t1","prompt_id":"p1","command":"rm -rf build","target":"rm -rf build","input":"{\"command\":\"rm -rf build\"}","cwd":"/w","permission_mode":"default","ts":"1970-01-01T00:00:01Z"}"#,
        ));
        let Some(LogEntry::Step(step)) = pre else {
            panic!("a step: {pre:?}");
        };
        assert_eq!(step.status, StepStatus::Running);
        assert_eq!(step.kind, StepKind::Command);
        assert_ne!(step.flags & flags::DELETED, 0);
        assert_eq!(step.prompt_id.as_deref(), Some("p1"));

        let post = log_entry(&ev(
            r#"{"event":"PostToolUseFailure","tool_name":"Read","tool_use_id":"t2","error":"no such file","input":"{\"file_path\":\"/etc/passwd\"}","cwd":"/w","duration_ms":4,"ts":"1970-01-01T00:00:02Z"}"#,
        ));
        let Some(LogEntry::Step(step)) = post else {
            panic!("a step: {post:?}");
        };
        assert_eq!(step.status, StepStatus::Error);
        assert_eq!(step.result.as_deref(), Some("no such file"));
        assert_ne!(
            step.flags & flags::OUTSIDE_PROJECT,
            0,
            "path read from the input"
        );
        assert_eq!(step.duration_ms, Some(4));
    }

    #[test]
    fn a_step_says_what_it_was_for() {
        let bash = r#"{"command":"pnpm check","description":"Run every check"}"#;
        assert_eq!(
            step_summary("Bash", Some(bash), None).as_deref(),
            Some("Run every check")
        );
        let grep = r#"{"pattern":"fn map_blocks","path":"crates"}"#;
        assert_eq!(
            step_summary("Grep", Some(grep), None).as_deref(),
            Some("fn map_blocks")
        );
        assert_eq!(
            step_summary(
                "WebFetch",
                Some(r#"{"url":"https://docs.rs/x","prompt":"how?"}"#),
                None
            )
            .as_deref(),
            Some("https://docs.rs/x")
        );
        // A long command caps the input mid-JSON: the hook's own copy of the
        // description still says what it was for.
        let capped = r#"{"command":"python3 - <<'EOF'\nimport sys…"#;
        assert_eq!(
            step_summary("Bash", Some(capped), Some("Print the bytes")).as_deref(),
            Some("Print the bytes")
        );
        assert_eq!(
            step_summary("Read", Some(r#"{"file_path":"/a"}"#), None),
            None
        );
        assert_eq!(
            step_summary("Agent", None, Some("\n  Score the findings\nmore")).as_deref(),
            Some("Score the findings"),
            "one line"
        );
        let long = "x".repeat(SUMMARY_MAX + 10);
        let capped = step_summary("Bash", None, Some(&long)).expect("a summary");
        assert_eq!(capped.chars().count(), SUMMARY_MAX + 1);
    }

    fn launch(step_id: i64, kind: &str, started_ms: i64) -> SubagentLaunch {
        SubagentLaunch {
            step_id,
            tool_use_id: format!("toolu_{step_id}"),
            launched_type: kind.to_string(),
            launched_agent: None,
            started_ms,
        }
    }

    fn seen(agent_id: &str, kind: Option<&str>, first_ms: i64) -> SubagentSeen {
        SubagentSeen {
            agent_id: agent_id.to_string(),
            agent_type: kind.map(str::to_string),
            launched_by: None,
            first_ms,
        }
    }

    #[test]
    fn a_subagent_links_to_the_launch_that_named_it() {
        // Two of one type, started together; B's first step comes first.
        let launches = [launch(1, "Explore", 100), launch(2, "Explore", 101)];
        let a = SubagentSeen {
            launched_by: Some("toolu_1".into()),
            ..seen("a", Some("Explore"), 160)
        };
        let b = SubagentSeen {
            launched_by: Some("toolu_2".into()),
            ..seen("b", Some("Explore"), 150)
        };
        let links = link_subagents(&launches, &[b, a]);
        assert_eq!(
            (links["a"], links["b"]),
            (1, 2),
            "by the sidecar, not by order"
        );

        // A background launch says which agent it started.
        let bg = SubagentLaunch {
            launched_agent: Some("c".into()),
            ..launch(3, "Plan", 100)
        };
        let links = link_subagents(
            &[launch(4, "Plan", 90), bg],
            &[seen("c", Some("Plan"), 200)],
        );
        assert_eq!(links["c"], 3);
    }

    #[test]
    fn with_no_exact_link_a_subagent_takes_the_earliest_free_launch_of_its_type() {
        let launches = [
            launch(1, "Explore", 100),
            launch(2, "Plan", 101),
            launch(3, "Explore", 102),
        ];
        let exact = SubagentSeen {
            launched_by: Some("toolu_1".into()),
            ..seen("x", Some("Explore"), 300)
        };
        let links = link_subagents(
            &launches,
            &[
                seen("y", Some("Explore"), 150),
                exact,
                seen("p", Some("Plan"), 99),
            ],
        );
        assert_eq!(links["x"], 1);
        assert_eq!(links["y"], 3, "launch 1 is taken exactly");
        assert!(!links.contains_key("p"), "no launch before its first step");
        assert!(
            link_subagents(&launches, &[seen("h", None, 500)]).is_empty(),
            "a helper"
        );
    }

    #[test]
    fn a_turn_no_person_started_is_headed_by_its_summary() {
        let handback = "<agent-message from=\"a35\">\n[Subagent hand-back] The text below is the final report\n…\n</agent-message>";
        assert_eq!(
            report_heading(handback, Some("pr-scorer")).as_deref(),
            Some("Agent \"pr-scorer\" reported back")
        );
        assert_eq!(
            report_heading(handback, None).as_deref(),
            Some("A subagent reported back")
        );
        let report = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"Build\" completed</summary>\n</task-notification>";
        assert_eq!(
            report_heading(report, None).as_deref(),
            Some("Background command \"Build\" completed")
        );
        assert_eq!(report_heading("fix the <agent-message> parser", None), None);
        assert_eq!(report_heading("run the tests", None), None);
    }

    #[test]
    fn events_the_log_does_not_keep_are_skipped() {
        assert_eq!(
            log_entry(&ev(
                r#"{"event":"Notification","ts":"1970-01-01T00:00:01Z"}"#
            )),
            None
        );
        assert_eq!(
            log_entry(&ev(
                r#"{"event":"PreToolUse","tool_name":"Bash","ts":"1970-01-01T00:00:01Z"}"#
            )),
            None,
            "no tool_use_id: nothing to merge the end into"
        );
        assert_eq!(log_entry(&ev(r#"{"event":"Stop"}"#)), None, "no timestamp");
    }

    #[test]
    fn allowed_by_says_what_hooks_and_the_companion_can_know() {
        use crate::bridge::ToolCheck;
        let ok = StepStatus::Ok;
        assert_eq!(
            allowed_by(StepKind::Command, Some("default"), true, ok, None),
            "You approved it in the terminal"
        );
        assert_eq!(
            allowed_by(StepKind::Command, None, true, StepStatus::Running, None),
            "Waiting for your answer in the terminal",
            "a dialog alone is not an approval"
        );
        assert_eq!(
            allowed_by(StepKind::Command, None, true, StepStatus::Error, None),
            "You were asked in the terminal; it didn't complete"
        );
        let rule = ToolCheck {
            decision: "allow".into(),
            rule: Some("Bash(npm *)".into()),
        };
        assert_eq!(
            allowed_by(StepKind::Command, None, false, ok, Some(&rule)),
            "Allowed by your rule Bash(npm *)"
        );
        let asks = ToolCheck {
            decision: "ask".into(),
            rule: None,
        };
        assert_eq!(
            allowed_by(StepKind::Command, Some("auto"), false, ok, Some(&asks)),
            "Auto mode approved it (your settings would have asked)"
        );
        assert_eq!(
            allowed_by(
                StepKind::Command,
                Some("auto"),
                false,
                StepStatus::Error,
                Some(&asks)
            ),
            "Auto mode",
            "an ask that never ran proves no approval"
        );
        assert_eq!(
            allowed_by(StepKind::Edit, Some("acceptEdits"), false, ok, None),
            "Accept-edits mode"
        );
        assert_eq!(
            allowed_by(StepKind::Read, Some("default"), false, ok, None),
            "Read-only, no prompt needed"
        );
        assert_eq!(
            allowed_by(StepKind::Command, None, false, ok, None),
            "Allowed by your permission settings"
        );
    }
}
