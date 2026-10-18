//! Live "Session activity": running Subagents, Background shells, and the Task
//! list, reconstructed from the sources Claude Code ≥2.1 writes *during* a
//! session — because it no longer writes the main transcript live (so that file
//! can't drive a live view; see `docs/adr/0003-ephemeral-session-activity-projection.md`).
//!
//! Two live sources feed [`SessionActivity`]:
//! - **Hook events** (`PreToolUse`/`PostToolUse`) → running/done Subagents and
//!   launched Background shells, via [`HookActivity`].
//! - **The task store** `~/.claude/tasks/<session-id>/<n>.json` → the Task list,
//!   via [`parse_task_file`] (the watcher walks the directory).
//!
//! Tolerant throughout: an unrecognized event or malformed file changes nothing
//! and never panics, mirroring the transcript parser's discipline.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ask::PendingAsk;
use crate::hook_signal::{classify, Actor, HookSignal, InFlight, ToolCall, ToolPhase};
use crate::main_session::MainSessionLock;

/// The live, derived state of a Session beyond its `SessionStatus`: its running
/// Subagents, Background shells, and current Task list. A projection of the
/// session's live on-disk signals, rendered in the Inspector.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivity {
    pub main: MainAgent,
    pub subagents: Vec<Subagent>,
    pub shells: Vec<BackgroundShell>,
    pub tasks: Vec<Task>,
    /// The open [Pending ask] — what this session wants from the user right
    /// now, or `None`. Rides the activity snapshot so delivery and dedupe are
    /// shared; see CONTEXT.md "Pending ask".
    #[serde(default)]
    pub pending_ask: Option<PendingAsk>,
}

/// The top-level agent's in-flight tool, if any. The [`MainAgent`] carries only
/// its [`ToolActivity`]; everything else about the main turn lives in
/// `SessionStatus`. See `CONTEXT.md` "Main agent".
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MainAgent {
    pub current_tool: Option<ToolActivity>,
}

/// One tool an agent (main or subagent) is running right now: a name, an optional
/// human target, and when it started. Set on `PreToolUse`, cleared on
/// `PostToolUse`. Enrichment over the core spawn/state view. See `CONTEXT.md`
/// "Tool activity".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
    pub tool_name: String,
    pub target: Option<String>,
    pub started_at: Option<String>,
}

/// A nested agent the Session spawned via Claude Code's Agent tool (named
/// `Task` in older builds). Correlated across hook events by `tool_use_id`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub tool_use_id: String,
    pub kind: String,
    pub description: Option<String>,
    pub state: SubagentState,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub result: Option<String>,
    /// Runtime id of this subagent, so its `current_tool` can be attributed.
    /// Bound exactly from a background launch's receipt, else lazily from its
    /// first internal tool event (by `agent_type` + spawn order). `None` until
    /// either is seen.
    pub agent_id: Option<String>,
    /// This subagent's in-flight tool, if any. Enrichment; cleared on its tool's
    /// `PostToolUse`, on settle, and when the subagent completes.
    pub current_tool: Option<ToolActivity>,
    /// Exact run duration in milliseconds, from the `Agent` `PostToolUse`.
    pub duration_ms: Option<u64>,
}

impl Subagent {
    /// A subagent just spawned by the `Agent` call `tool_use_id`, running.
    fn spawned(tool_use_id: &str, ev: &crate::hooks::HookEvent) -> Self {
        Self {
            tool_use_id: tool_use_id.to_string(),
            kind: ev.subagent_type.clone().unwrap_or_default(),
            description: ev.description.clone(),
            state: SubagentState::Running,
            started_at: ev.ts.clone(),
            ended_at: None,
            result: None,
            agent_id: None,
            current_tool: None,
            duration_ms: None,
        }
    }
}

/// Lifecycle of a [`Subagent`]: `Running` on `PreToolUse`, `Done` on `PostToolUse`
/// — or, for one launched in the background, once a main `Stop` no longer lists it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentState {
    Running,
    Done,
}

/// A Bash command the Session launched with `run_in_background`, tracked by its
/// `tool_use_id`. Status is best-effort (see ADR 0002): hooks carry no
/// background-completion signal, so a launched shell stays `Running`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundShell {
    pub bash_id: String,
    pub cmd: String,
    pub status: ShellStatus,
    /// Exit code, set only if a completion is ever observed (currently never —
    /// see ADR 0002).
    pub exit: Option<i32>,
    /// Timestamp of the last status-changing signal, if any.
    pub last_polled_at: Option<String>,
}

/// Keeps [Background shell] claims honest across the passes of one session's
/// watch.
///
/// A shell is opened `Running` by a background `Bash` `PreToolUse` and nothing
/// in the hook stream ever closes it — Claude Code writes no completion event
/// (ADR 0002). Left alone the claim outlives its process: a command that exited
/// on its own, and every command ended by a [Tree stop], a crash or a
/// force-quit, stays `Running` for as long as the session exists. That claim is
/// what the [Stop cost] names in the close and quit dialogs and what vetoes
/// auto-sleep, so it makes both lie — a quit warns about a dev server that died
/// two restarts ago, and the session can never sleep.
///
/// Retracting on a plain sweep is not enough on its own, because the snapshot
/// that *introduces* a claim is emitted from its `PreToolUse`, before Claude
/// Code has forked the command. A sweep in that window sees nothing and would
/// bury a shell that is about to exist — which is worse than the stale claim,
/// since the quit gate would then stop a live dev server without asking.
///
/// So the first pass and the rest are different. Everything present on the
/// first pass was replayed from the events file when the watch was seeded: that
/// is all history, and whatever no process backs is retracted at once. A claim
/// that turns up later is newborn, and gets one free sighting for its fork to
/// land before the same rule applies to it.
#[derive(Debug, Default)]
pub struct ShellWatch {
    /// Claims this watch has already judged. Absent means newborn.
    known: std::collections::HashSet<String>,
    seeded: bool,
}

impl ShellWatch {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Re-derive each claim's status from `live` — the command lines of the
    /// session's process tree, from a sweep, or `None` when the table could not
    /// be read.
    ///
    /// An unreadable table changes nothing and costs a newborn nothing: a pass
    /// that learned nothing must not spend the one sighting a fork is waiting
    /// for, and a missed warning lets a stop kill a real dev server silently
    /// while a spurious one only asks twice. A pass with *no claims* is the
    /// opposite case — a complete observation, with nothing to verify and no
    /// fork waiting — so it seeds the watch whether or not a sweep was taken.
    ///
    /// Matching is a substring test — Claude Code runs a background command as
    /// `zsh -c … eval '<cmd>' …`, so the claim's `cmd` appears verbatim inside
    /// the live command line — but **one live process backs at most one
    /// claim**, and it backs the most specific claim it matches. Without that,
    /// a claim that is a prefix of a longer live sibling (`pnpm dev` beside
    /// `pnpm dev --filter api`) was re-promoted by its sibling's command line
    /// on every pass: a corpse that could never be retracted, vetoing
    /// auto-sleep for good and named in every close and quit dialog.
    pub fn reconcile(&mut self, shells: &mut [BackgroundShell], live: Option<&[String]>) {
        if shells.is_empty() {
            self.seeded = true;
            return;
        }
        let Some(live) = live else {
            return;
        };
        let backed = Self::back_claims(shells, live);
        for (index, shell) in shells.iter_mut().enumerate() {
            if backed.contains(&index) {
                shell.status = ShellStatus::Running;
            } else if !self.seeded || self.known.contains(&shell.bash_id) {
                shell.status = ShellStatus::Unknown;
            }
            self.known.insert(shell.bash_id.clone());
        }
        self.seeded = true;
    }

    /// Which claims a live process backs: each command line is spent on the
    /// longest claim it contains and not yet spent on, so a longer command
    /// never stands in as evidence for the shorter one it happens to contain.
    fn back_claims(
        shells: &[BackgroundShell],
        live: &[String],
    ) -> std::collections::HashSet<usize> {
        let mut backed = std::collections::HashSet::new();
        for line in live {
            let claim = shells
                .iter()
                .enumerate()
                .filter(|(index, shell)| !backed.contains(index) && line.contains(&shell.cmd))
                .max_by_key(|(_, shell)| shell.cmd.len())
                .map(|(index, _)| index);
            if let Some(index) = claim {
                backed.insert(index);
            }
        }
        backed
    }
}

/// Best-effort status of a [`BackgroundShell`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellStatus {
    Running,
    Exited,
    Killed,
    Unknown,
}

/// One item in a Session's checklist, from Claude Code's task store
/// (`TaskCreate`/`TaskUpdate`, or a legacy `TodoWrite` entry).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub text: String,
    pub status: TaskStatus,
    pub active_form: Option<String>,
}

/// Status of a [`Task`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

/// The outcome of folding one hook event: whether the projection changed, and
/// whether the [`MainSessionLock`] judged the event to belong to this
/// terminal's main interactive agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HookIngest {
    /// The projection's visible state moved.
    pub changed: bool,
    /// The event came from the main interactive session, not a nested
    /// `claude -p` sharing this terminal's events file.
    pub is_main: bool,
}

/// Reconstructs running Subagents and Background shells from the Claude Code
/// hook-event stream. An `Agent` `PreToolUse` opens a running Subagent keyed by
/// `tool_use_id`; the matching `PostToolUse` completes it (capturing its result
/// and end time) — unless it is a background launch receipt, which leaves it
/// running until a main `Stop` stops listing it. A `Post` with no prior `Pre` —
/// replaying from mid-session — is recorded directly as `Done`. A background `Bash` `PreToolUse` opens a
/// [`BackgroundShell`]. Tolerant: events it does not recognize change nothing.
#[derive(Debug, Default)]
pub struct HookActivity {
    main: MainAgent,
    subagents: Vec<Subagent>,
    shells: Vec<BackgroundShell>,
    /// Which claude session is the *main* agent. Subagents and one-shot
    /// `claude -p` invocations inherit `KRIYON_SESSION` and emit their own
    /// `Stop`/`SessionEnd` into the same events file, so `settle` must fire only on
    /// the main session's end — otherwise the first subagent to finish settles its
    /// still-running siblings. The lock converges on the live session across
    /// restarts and is shared with [`crate::status::StatusTracker`] so the
    /// activity projection and the status badge agree (see [`MainSessionLock`]).
    main_lock: MainSessionLock,
}

impl HookActivity {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The main agent's in-flight tool, if any.
    #[must_use]
    pub fn main(&self) -> MainAgent {
        self.main.clone()
    }

    /// The claude session id currently locked as this terminal's main agent, if
    /// any. Converges on the live session (see [`MainSessionLock`]), so callers
    /// that persist it — the [Claude session id] for `claude --resume` and the
    /// task-store dir — track the real session, not a first-seen nested/ended one.
    #[must_use]
    pub fn main_session_id(&self) -> Option<&str> {
        self.main_lock.current()
    }

    /// Anchor the main session to the status-line's authoritative id (only the
    /// main interactive TUI renders a status line). See
    /// [`MainSessionLock::set_authoritative`].
    pub fn set_authoritative_main(&mut self, sid: &str) {
        self.main_lock.set_authoritative(sid);
    }

    /// The current subagents, in spawn order.
    #[must_use]
    pub fn subagents(&self) -> Vec<Subagent> {
        self.subagents.clone()
    }

    /// The current background shells, in launch order.
    #[must_use]
    pub fn shells(&self) -> Vec<BackgroundShell> {
        self.shells.clone()
    }

    /// Fold one hook event into the projection. Returns `true` when it changed.
    pub fn ingest(&mut self, ev: &crate::hooks::HookEvent) -> bool {
        self.ingest_detailed(ev).changed
    }

    /// [`Self::ingest`], also reporting the [`MainSessionLock`]'s verdict on the
    /// event. Exists because the lock is `&mut` and must be observed exactly
    /// once per event, so a sibling projection that needs the same verdict — the
    /// [Pending ask], which must ignore nested claudes — cannot ask for it
    /// separately without either a second lock that could drift from this one
    /// (against ADR-0009's "fed the same stream") or a double `observe` that
    /// would corrupt the re-lock state machine.
    pub fn ingest_detailed(&mut self, ev: &crate::hooks::HookEvent) -> HookIngest {
        let is_main = self.main_lock.observe(ev);
        HookIngest {
            changed: self.fold(ev, is_main),
            is_main,
        }
    }

    /// The fold proper, given the lock's already-taken verdict.
    fn fold(&mut self, ev: &crate::hooks::HookEvent, is_main: bool) -> bool {
        let signal = classify(ev);
        let in_flight = match signal {
            HookSignal::TurnEnded(end) => Some(end.in_flight),
            HookSignal::SessionEnded => Some(InFlight::default()),
            _ => None,
        };
        if let Some(in_flight) = in_flight {
            // A nested session ending is ignored: a subagent completes via its
            // `Agent` PostToolUse, or, run in the background, via a main turn
            // end that no longer lists it.
            return is_main && self.settle(ev, in_flight);
        }
        // A tool/agent/shell event from a nested claude — a one-shot `claude -p`
        // sharing this terminal's events file — is not the main agent's work.
        // Gate on the same lock the status badge uses so it can't set the main
        // agent's current tool or spawn a phantom subagent/shell. Subagent tool
        // events carry the main session's id, so they stay `is_main` and pass.
        if !is_main {
            return false;
        }
        let HookSignal::Tool(call) = signal else {
            return false;
        };
        if call.spawns_agent() {
            self.on_agent(ev, call)
        } else if call.name == "Bash" && ev.run_in_background == Some(true) {
            self.on_background_bash(ev)
        } else if call.name.is_empty() {
            false
        } else {
            self.on_tool(ev, call)
        }
    }

    /// A non-Agent tool event. With an `agent_id` it is attributed to a subagent
    /// (bound lazily by `agent_type` + spawn order); without one it belongs to
    /// the main agent. `PreToolUse` sets the relevant `current_tool`,
    /// `PostToolUse` clears it.
    fn on_tool(&mut self, ev: &crate::hooks::HookEvent, call: ToolCall<'_>) -> bool {
        let pre = call.phase == ToolPhase::Started;
        match call.actor {
            Actor::Subagent(agent_id) => {
                let Some(idx) = self.bind_agent(agent_id, ev.agent_type.as_deref()) else {
                    return false; // no subagent to attribute to (enrichment tier)
                };
                if pre {
                    self.subagents[idx].current_tool = Some(ToolActivity {
                        tool_name: ev.tool_name.clone().unwrap_or_default(),
                        target: ev.target.clone(),
                        started_at: ev.ts.clone(),
                    });
                } else {
                    self.subagents[idx].current_tool = None;
                }
                true
            }
            Actor::Main => {
                if pre {
                    self.main.current_tool = Some(ToolActivity {
                        tool_name: ev.tool_name.clone().unwrap_or_default(),
                        target: ev.target.clone(),
                        started_at: ev.ts.clone(),
                    });
                    true
                } else if self.main.current_tool.is_some() {
                    self.main.current_tool = None;
                    true
                } else {
                    false
                }
            }
        }
    }

    /// Resolve the subagent an `agent_id` belongs to, binding lazily on first
    /// sight: if already bound, return it; otherwise bind this id to the oldest
    /// still-running, un-bound subagent whose `kind` matches `agent_type`.
    /// Returns `None` when nothing matches (the tool then goes unattributed —
    /// enrichment only; the core spawn/state view is unaffected). Parallel
    /// same-type subagents are an accepted v1 limit: a tool may bind to the wrong
    /// identical-kind sibling, but counts/states/results stay correct.
    fn bind_agent(&mut self, agent_id: &str, agent_type: Option<&str>) -> Option<usize> {
        if let Some(i) = self
            .subagents
            .iter()
            .position(|s| s.agent_id.as_deref() == Some(agent_id))
        {
            return Some(i);
        }
        let kind = agent_type.unwrap_or_default();
        let i = self.subagents.iter().position(|s| {
            s.agent_id.is_none() && s.state == SubagentState::Running && s.kind == kind
        })?;
        self.subagents[i].agent_id = Some(agent_id.to_string());
        Some(i)
    }

    /// The turn (or session) ended: force every still-running subagent to `Done`
    /// and clear every in-flight tool — the "never stuck running" guarantee.
    /// A turn end that lists [Background agent]s still in flight spares exactly
    /// those: its list is Claude Code's own account of what is still running,
    /// so the rest are proven finished and these are proven not. Returns whether
    /// anything changed, so an idle `Stop` is correctly a no-op.
    fn settle(&mut self, ev: &crate::hooks::HookEvent, in_flight: InFlight<'_>) -> bool {
        let mut changed = false;
        for sub in &mut self.subagents {
            let still_running = sub
                .agent_id
                .as_deref()
                .is_some_and(|id| in_flight.keeps_agent_running(id));
            if sub.state == SubagentState::Running && !still_running {
                sub.state = SubagentState::Done;
                if sub.ended_at.is_none() {
                    sub.ended_at.clone_from(&ev.ts);
                }
                sub.current_tool = None;
                changed = true;
            }
        }
        if self.main.current_tool.take().is_some() {
            changed = true;
        }
        changed
    }

    fn on_agent(&mut self, ev: &crate::hooks::HookEvent, call: ToolCall<'_>) -> bool {
        let Some(id) = ev.tool_use_id.as_deref() else {
            return false;
        };
        if let Some(agent_id) = ev.launched_agent_id.as_deref() {
            return self.on_background_launch(ev, id, Some(agent_id).filter(|s| !s.is_empty()));
        }
        // A subagent that crashed reports `PostToolUseFailure` and never fires
        // `PostToolUse`; keying completion on the success hook alone left it
        // spinning in the inspector until the turn settled.
        let done = call.phase.ended();
        if let Some(agent) = self.subagents.iter_mut().find(|a| a.tool_use_id == id) {
            // Already tracked: a PostToolUse completes it; a duplicate Pre is a no-op.
            if done && agent.state != SubagentState::Done {
                agent.state = SubagentState::Done;
                agent.ended_at.clone_from(&ev.ts);
                agent.result.clone_from(&ev.result);
                agent.duration_ms = ev.duration_ms;
                agent.current_tool = None;
                return true;
            }
            return false;
        }
        let mut agent = Subagent::spawned(id, ev);
        if done {
            // Replaying from mid-session: the end with no prior `Pre`.
            agent.state = SubagentState::Done;
            agent.started_at = None;
            agent.ended_at.clone_from(&ev.ts);
            agent.result.clone_from(&ev.result);
            agent.duration_ms = ev.duration_ms;
        }
        self.subagents.push(agent);
        true
    }

    /// An `Agent` that returned at once because it runs in the background: it
    /// has only *started*. Keep it running, and bind the launched id exactly
    /// when the receipt carried one. A lazy type+order binding made from the
    /// earliest tool events may have credited that id to a same-type sibling,
    /// or credited this subagent with a sibling's id: either way the tool that
    /// binding attributed moves with the id it belongs to. The agent finishes
    /// when a main turn end no longer lists it ([`Self::settle`]). Returns
    /// whether anything changed, so a repeated receipt is a no-op.
    fn on_background_launch(
        &mut self,
        ev: &crate::hooks::HookEvent,
        tool_use_id: &str,
        agent_id: Option<&str>,
    ) -> bool {
        let known = self
            .subagents
            .iter()
            .position(|a| a.tool_use_id == tool_use_id);
        let idx = known.unwrap_or_else(|| {
            // Replaying from mid-session: the launch with no prior `Pre`.
            self.subagents.push(Subagent::spawned(tool_use_id, ev));
            self.subagents.len() - 1
        });
        let added = known.is_none();
        let Some(agent_id) = agent_id else {
            return added;
        };
        if self.subagents[idx].agent_id.as_deref() == Some(agent_id) {
            return added;
        }
        let mut credited = None;
        for (i, sub) in self.subagents.iter_mut().enumerate() {
            if i != idx && sub.agent_id.as_deref() == Some(agent_id) {
                sub.agent_id = None;
                credited = sub.current_tool.take();
            }
        }
        let agent = &mut self.subagents[idx];
        agent.agent_id = Some(agent_id.to_string());
        // Whatever tool this subagent was credited with belonged to the id it
        // was wrongly bound to; the right tool, if any, comes with the id.
        agent.current_tool = credited;
        true
    }

    fn on_background_bash(&mut self, ev: &crate::hooks::HookEvent) -> bool {
        let Some(id) = ev.tool_use_id.as_deref() else {
            return false;
        };
        if self.shells.iter().any(|s| s.bash_id == id) {
            return false;
        }
        self.shells.push(BackgroundShell {
            bash_id: id.to_string(),
            cmd: ev.command.clone().unwrap_or_default(),
            status: ShellStatus::Running,
            exit: None,
            last_polled_at: ev.ts.clone(),
        });
        true
    }
}

/// Parse one `~/.claude/tasks/<session-id>/<n>.json` file into a [`Task`].
/// Returns `None` for malformed JSON or a `deleted` task. Tolerant: never panics.
#[must_use]
pub fn parse_task_file(json: &str) -> Option<Task> {
    let value: Value = serde_json::from_str(json).ok()?;
    let status = value.get("status").and_then(Value::as_str);
    if status == Some("deleted") {
        return None;
    }
    Some(Task {
        text: opt_str(&value, "subject").unwrap_or_default(),
        status: parse_task_status(status),
        active_form: opt_str(&value, "activeForm"),
    })
}

/// Map a Claude Code task status string to [`TaskStatus`]; unknown/missing
/// defaults to `Pending` (`"deleted"` is handled by the caller).
fn parse_task_status(status: Option<&str>) -> TaskStatus {
    match status {
        Some("in_progress") => TaskStatus::InProgress,
        Some("completed") => TaskStatus::Completed,
        _ => TaskStatus::Pending,
    }
}

fn opt_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::HookEvent;

    fn hook(event: &str, tool: Option<&str>, id: Option<&str>) -> HookEvent {
        HookEvent {
            event: event.to_string(),
            tool_name: tool.map(str::to_string),
            tool_use_id: id.map(str::to_string),
            ..HookEvent::default()
        }
    }

    #[test]
    fn a_failed_agent_completes_instead_of_running_forever() {
        // Claude Code sends `PostToolUseFailure` for a tool that errored — and
        // *not* the success hook. Keying completion on `PostToolUse` alone left a
        // crashed subagent spinning in the inspector until the turn settled.
        let mut a = HookActivity::new();
        let mut start = hook("PreToolUse", Some("Agent"), Some("t1"));
        start.subagent_type = Some("Explore".to_string());
        assert!(a.ingest(&start));
        let mut failed = hook("PostToolUseFailure", Some("Agent"), Some("t1"));
        failed.ts = Some("2026-06-17T00:00:09Z".to_string());
        assert!(a.ingest(&failed));
        let agent = a.subagents().pop().expect("the subagent");
        assert_eq!(agent.state, SubagentState::Done);
        assert_eq!(agent.ended_at.as_deref(), Some("2026-06-17T00:00:09Z"));
    }

    #[test]
    fn a_failed_tool_clears_the_current_tool() {
        let mut a = HookActivity::new();
        assert!(a.ingest(&hook("PreToolUse", Some("Bash"), Some("t1"))));
        assert!(a.main().current_tool.is_some());
        assert!(a.ingest(&hook("PostToolUseFailure", Some("Bash"), Some("t1"))));
        assert_eq!(a.main().current_tool, None);
    }

    #[test]
    fn pre_tool_use_agent_starts_running_subagent() {
        let mut a = HookActivity::new();
        let mut ev = hook("PreToolUse", Some("Agent"), Some("t1"));
        ev.subagent_type = Some("Explore".to_string());
        ev.description = Some("map it".to_string());
        ev.ts = Some("2026-06-17T00:00:00Z".to_string());
        assert!(a.ingest(&ev));
        assert_eq!(
            a.subagents(),
            vec![Subagent {
                tool_use_id: "t1".to_string(),
                kind: "Explore".to_string(),
                description: Some("map it".to_string()),
                state: SubagentState::Running,
                started_at: Some("2026-06-17T00:00:00Z".to_string()),
                ended_at: None,
                result: None,
                agent_id: None,
                current_tool: None,
                duration_ms: None,
            }]
        );
    }

    #[test]
    fn post_tool_use_agent_completes_matching_subagent() {
        let mut a = HookActivity::new();
        let mut pre = hook("PreToolUse", Some("Agent"), Some("t1"));
        pre.subagent_type = Some("Explore".to_string());
        a.ingest(&pre);
        assert!(a.ingest(&hook("PostToolUse", Some("Agent"), Some("t1"))));
        assert_eq!(a.subagents()[0].state, SubagentState::Done);
    }

    #[test]
    fn post_tool_use_captures_result_and_timestamps() {
        let mut a = HookActivity::new();
        let mut pre = hook("PreToolUse", Some("Agent"), Some("t1"));
        pre.ts = Some("2026-06-17T00:00:00Z".to_string());
        a.ingest(&pre);
        let mut post = hook("PostToolUse", Some("Agent"), Some("t1"));
        post.ts = Some("2026-06-17T00:01:00Z".to_string());
        post.result = Some("found 3 files".to_string());
        a.ingest(&post);
        let s = &a.subagents()[0];
        assert_eq!(s.started_at.as_deref(), Some("2026-06-17T00:00:00Z"));
        assert_eq!(s.ended_at.as_deref(), Some("2026-06-17T00:01:00Z"));
        assert_eq!(s.result.as_deref(), Some("found 3 files"));
    }

    #[test]
    fn post_without_pre_creates_a_done_subagent() {
        // Replaying from mid-session: a Post we have no Pre for still shows.
        let mut a = HookActivity::new();
        let mut post = hook("PostToolUse", Some("Agent"), Some("t9"));
        post.subagent_type = Some("Plan".to_string());
        assert!(a.ingest(&post));
        assert_eq!(a.subagents().len(), 1);
        assert_eq!(a.subagents()[0].state, SubagentState::Done);
        assert_eq!(a.subagents()[0].kind, "Plan");
    }

    #[test]
    fn two_agents_tracked_by_tool_use_id() {
        let mut a = HookActivity::new();
        a.ingest(&hook("PreToolUse", Some("Agent"), Some("t1")));
        a.ingest(&hook("PreToolUse", Some("Agent"), Some("t2")));
        a.ingest(&hook("PostToolUse", Some("Agent"), Some("t2")));
        let subs = a.subagents();
        assert_eq!(subs[0].state, SubagentState::Running);
        assert_eq!(subs[1].state, SubagentState::Done);
    }

    #[test]
    fn main_tool_set_on_pre_and_cleared_on_post() {
        let mut a = HookActivity::new();
        let mut pre = hook("PreToolUse", Some("Edit"), Some("e1"));
        pre.target = Some("src/foo.tsx".to_string());
        pre.ts = Some("2026-06-21T00:00:00Z".to_string());
        assert!(a.ingest(&pre));
        let main = a.main();
        let tool = main.current_tool.expect("main has a current tool");
        assert_eq!(tool.tool_name, "Edit");
        assert_eq!(tool.target.as_deref(), Some("src/foo.tsx"));
        assert_eq!(tool.started_at.as_deref(), Some("2026-06-21T00:00:00Z"));

        assert!(a.ingest(&hook("PostToolUse", Some("Edit"), Some("e1"))));
        assert!(a.main().current_tool.is_none(), "post clears the main tool");
    }

    #[test]
    fn a_nested_one_shot_tool_does_not_touch_the_main_agent() {
        // A one-shot `claude -p` inherits KRIYON_SESSION and writes into the same
        // events file. Its PreToolUse (own session id, no agent_id, temp
        // transcript) must not set the MAIN agent's current tool.
        let mut a = HookActivity::new();
        let mut main_pre = hook("PreToolUse", Some("Edit"), Some("e1"));
        main_pre.session_id = Some("main".to_string());
        main_pre.transcript_path = Some("/Users/x/.claude/projects/-p/main.jsonl".to_string());
        main_pre.target = Some("src/a.ts".to_string());
        a.ingest(&main_pre);

        let mut one_shot = hook("PreToolUse", Some("Bash"), Some("x1"));
        one_shot.session_id = Some("oneshot".to_string());
        one_shot.transcript_path = Some("/private/var/folders/T/oneshot.jsonl".to_string());
        one_shot.command = Some("git status".to_string());
        let changed = a.ingest(&one_shot);

        assert!(!changed, "a nested one-shot's tool is not the main agent's");
        assert_eq!(
            a.main().current_tool.expect("main tool intact").tool_name,
            "Edit",
            "the one-shot must not overwrite the main agent's current tool"
        );
    }

    #[test]
    fn agent_tool_event_does_not_become_a_main_tool() {
        // Spawning a subagent must not show up as a *main* tool — it is the
        // subagent list's job. The Agent tool is handled by on_agent only.
        let mut a = HookActivity::new();
        let mut pre = hook("PreToolUse", Some("Agent"), Some("t1"));
        pre.subagent_type = Some("Explore".to_string());
        a.ingest(&pre);
        assert!(a.main().current_tool.is_none());
        assert_eq!(a.subagents().len(), 1);
    }

    #[test]
    fn background_bash_becomes_a_shell_foreground_does_not() {
        let mut a = HookActivity::new();
        let mut bg = hook("PreToolUse", Some("Bash"), Some("b1"));
        bg.run_in_background = Some(true);
        bg.command = Some("pnpm dev".to_string());
        assert!(a.ingest(&bg));
        let shells = a.shells();
        assert_eq!(shells.len(), 1);
        assert_eq!(shells[0].bash_id, "b1");
        assert_eq!(shells[0].cmd, "pnpm dev");
        assert_eq!(shells[0].status, ShellStatus::Running);
        // A foreground Bash sets the main agent's current tool but adds no shell.
        let mut fg = hook("PreToolUse", Some("Bash"), Some("b2"));
        fg.command = Some("ls".to_string());
        assert!(a.ingest(&fg));
        assert_eq!(a.shells().len(), 1, "foreground bash is not a shell");
        assert!(
            a.main().current_tool.is_some(),
            "foreground bash is a main tool"
        );
    }

    #[test]
    fn the_first_pass_retracts_the_claims_replayed_from_the_events_file() {
        // Everything the projection was seeded with is history: those processes
        // died with an earlier run, and nothing will ever close them.
        let mut watch = ShellWatch::new();
        let mut shells = vec![shell("b1", "pnpm dev"), shell("b2", "old server")];
        watch.reconcile(
            &mut shells,
            Some(&["/bin/zsh -c eval 'pnpm dev' < /dev/null".to_string()]),
        );
        assert_eq!(shells[0].status, ShellStatus::Running, "still alive");
        assert_eq!(shells[1].status, ShellStatus::Unknown, "long gone");
    }

    #[test]
    fn a_claim_born_after_the_first_pass_gets_one_free_sighting() {
        // The snapshot carrying a new shell is emitted from its `PreToolUse`,
        // before Claude Code has forked the command, so the sweep in that pass
        // cannot see it. Retracting there left a live dev server unnamed in the
        // quit dialog until the next hook event.
        let mut watch = ShellWatch::new();
        let mut shells = vec![shell("b1", "pnpm dev")];
        watch.reconcile(&mut shells, Some(&["/bin/zsh -i".to_string()]));
        assert_eq!(
            shells[0].status,
            ShellStatus::Unknown,
            "seeded, so retracted"
        );

        shells.push(shell("b2", "cargo watch"));
        watch.reconcile(&mut shells, Some(&["/bin/zsh -i".to_string()]));
        assert_eq!(shells[1].status, ShellStatus::Running, "not forked yet");

        // Its fork lands, and the claim is confirmed.
        watch.reconcile(
            &mut shells,
            Some(&["/bin/zsh -c eval 'cargo watch' < /dev/null".to_string()]),
        );
        assert_eq!(shells[1].status, ShellStatus::Running);
    }

    #[test]
    fn a_newborn_that_never_appears_is_retracted_on_the_pass_after() {
        let mut watch = ShellWatch::new();
        let mut shells: Vec<BackgroundShell> = Vec::new();
        watch.reconcile(&mut shells, Some(&[]));

        shells.push(shell("b1", "never started"));
        watch.reconcile(&mut shells, Some(&[]));
        assert_eq!(shells[0].status, ShellStatus::Running, "free sighting");
        watch.reconcile(&mut shells, Some(&[]));
        assert_eq!(shells[0].status, ShellStatus::Unknown, "and no more");
    }

    #[test]
    fn a_pass_with_no_claims_seeds_the_watch_without_a_sweep() {
        // A pass that finds no claims is a complete observation — there is
        // nothing to verify and no fork waiting for its sighting — so it seeds
        // the watch even when the caller took no sweep at all. Without this a
        // session that backgrounds its first command long after the watch
        // opened would meet an unseeded watch, be read as history, and be
        // retracted before Claude Code had forked it.
        let mut watch = ShellWatch::new();
        let mut none: Vec<BackgroundShell> = Vec::new();
        watch.reconcile(&mut none, None);

        let mut shells = vec![shell("b1", "pnpm dev")];
        watch.reconcile(&mut shells, Some(&["/bin/zsh -i".to_string()]));
        assert_eq!(
            shells[0].status,
            ShellStatus::Running,
            "newborn, so it keeps its free sighting"
        );
    }

    #[test]
    fn a_longer_live_command_does_not_revive_its_dead_prefix() {
        // One live process backs one claim. `pnpm dev` died; `pnpm dev --filter
        // api` is still up, and its command line contains the dead claim's text
        // — so a plain substring test re-promoted the corpse on every pass,
        // vetoing auto-sleep for good and naming a dead command in every
        // close and quit dialog.
        let mut watch = ShellWatch::new();
        let mut shells = vec![
            shell("b1", "pnpm dev"),
            shell("b2", "pnpm dev --filter api"),
        ];
        watch.reconcile(
            &mut shells,
            Some(&["/bin/zsh -c eval 'pnpm dev --filter api' < /dev/null".to_string()]),
        );

        assert_eq!(shells[1].status, ShellStatus::Running, "the live one");
        assert_eq!(
            shells[0].status,
            ShellStatus::Unknown,
            "its prefix is dead, and the live sibling is not evidence for it"
        );
    }

    #[test]
    fn two_live_processes_back_two_claims_that_share_a_prefix() {
        // The converse: both are up, so both stay up. Claiming the most
        // specific match first must not starve the shorter claim of the line
        // that is genuinely its own.
        let mut watch = ShellWatch::new();
        let mut shells = vec![
            shell("b1", "pnpm dev"),
            shell("b2", "pnpm dev --filter api"),
        ];
        watch.reconcile(
            &mut shells,
            Some(&[
                "/bin/zsh -c eval 'pnpm dev' < /dev/null".to_string(),
                "/bin/zsh -c eval 'pnpm dev --filter api' < /dev/null".to_string(),
            ]),
        );

        assert_eq!(shells[0].status, ShellStatus::Running);
        assert_eq!(shells[1].status, ShellStatus::Running);
    }

    #[test]
    fn an_unreadable_table_spends_no_free_sighting() {
        // A pass that learned nothing must not cost the claim its one chance.
        let mut watch = ShellWatch::new();
        let mut shells = vec![shell("b1", "pnpm dev")];
        watch.reconcile(&mut shells, None);
        watch.reconcile(&mut shells, None);
        assert_eq!(shells[0].status, ShellStatus::Running);
    }

    #[test]
    fn a_shell_the_sweep_still_sees_stays_running() {
        let mut shells = vec![shell("b1", "pnpm dev")];
        ShellWatch::new().reconcile(
            &mut shells,
            Some(&["/bin/zsh -c eval 'pnpm dev' < /dev/null".to_string()]),
        );
        assert_eq!(shells[0].status, ShellStatus::Running);
    }

    #[test]
    fn a_shell_no_live_process_backs_is_no_longer_running() {
        // The claim the hook stream never retracts (ADR 0002): claude was
        // SIGKILLed, so no closing hook ever fired and `Running` froze.
        let mut shells = vec![shell("b1", "python3 -m http.server 8765")];
        ShellWatch::new().reconcile(&mut shells, Some(&["/bin/zsh -i".to_string()]));
        assert_eq!(shells[0].status, ShellStatus::Unknown);
    }

    #[test]
    fn an_unreadable_process_table_retracts_nothing() {
        // Demotion needs positive evidence. Under-warning would let a stop kill
        // a dev server with no dialog at all.
        let mut shells = vec![shell("b1", "pnpm dev")];
        ShellWatch::new().reconcile(&mut shells, None);
        assert_eq!(shells[0].status, ShellStatus::Running);
    }

    #[test]
    fn a_claim_demoted_before_its_process_existed_comes_back() {
        // The race that made this a re-derivation rather than a latch: the
        // `PreToolUse` snapshot is emitted before Claude Code has forked the
        // command, so the first sweep cannot see it. A one-way demotion would
        // bury a genuinely running dev server for the rest of the session, and
        // the quit gate would stop it without ever asking.
        let mut watch = ShellWatch::new();
        let mut shells = vec![shell("b1", "pnpm dev")];
        watch.reconcile(&mut shells, Some(&["/bin/zsh -i".to_string()]));
        assert_eq!(
            shells[0].status,
            ShellStatus::Unknown,
            "seeded, so retracted"
        );

        watch.reconcile(
            &mut shells,
            Some(&["/bin/zsh -c eval 'pnpm dev' < /dev/null".to_string()]),
        );
        assert_eq!(shells[0].status, ShellStatus::Running, "the fork landed");
    }

    fn shell(bash_id: &str, cmd: &str) -> BackgroundShell {
        BackgroundShell {
            bash_id: bash_id.to_string(),
            cmd: cmd.to_string(),
            status: ShellStatus::Running,
            exit: None,
            last_polled_at: None,
        }
    }

    #[test]
    fn subagent_tool_attributed_by_agent_id() {
        let mut a = HookActivity::new();
        let mut spawn = hook("PreToolUse", Some("Agent"), Some("t1"));
        spawn.subagent_type = Some("Explore".to_string());
        a.ingest(&spawn);

        // The subagent's internal Edit, tagged with its runtime agent_id + type.
        let mut edit = hook("PreToolUse", Some("Edit"), Some("e1"));
        edit.agent_id = Some("agent_a".to_string());
        edit.agent_type = Some("Explore".to_string());
        edit.target = Some("a.rs".to_string());
        assert!(a.ingest(&edit));

        let sub = &a.subagents()[0];
        assert_eq!(sub.agent_id.as_deref(), Some("agent_a"));
        assert_eq!(
            sub.current_tool.as_ref().map(|t| t.tool_name.as_str()),
            Some("Edit")
        );

        // Its PostToolUse clears the subagent's current tool but not the main's.
        let mut done = hook("PostToolUse", Some("Edit"), Some("e1"));
        done.agent_id = Some("agent_a".to_string());
        assert!(a.ingest(&done));
        assert!(a.subagents()[0].current_tool.is_none());
        assert!(a.main().current_tool.is_none());
    }

    #[test]
    fn correlation_binds_by_type_then_spawn_order() {
        // Two distinct types: each tool binds to the correct subagent.
        let mut a = HookActivity::new();
        let mut s1 = hook("PreToolUse", Some("Agent"), Some("t1"));
        s1.subagent_type = Some("Explore".to_string());
        a.ingest(&s1);
        let mut s2 = hook("PreToolUse", Some("Agent"), Some("t2"));
        s2.subagent_type = Some("Plan".to_string());
        a.ingest(&s2);

        let mut t_plan = hook("PreToolUse", Some("Read"), Some("r1"));
        t_plan.agent_id = Some("agent_plan".to_string());
        t_plan.agent_type = Some("Plan".to_string());
        a.ingest(&t_plan);

        let explore = &a.subagents()[0];
        let plan = &a.subagents()[1];
        assert!(explore.current_tool.is_none(), "Explore got nothing");
        assert_eq!(
            plan.current_tool.as_ref().map(|t| t.tool_name.as_str()),
            Some("Read")
        );
        assert_eq!(plan.agent_id.as_deref(), Some("agent_plan"));
    }

    #[test]
    fn agent_post_records_duration_and_clears_current_tool() {
        let mut a = HookActivity::new();
        let mut spawn = hook("PreToolUse", Some("Agent"), Some("t1"));
        spawn.subagent_type = Some("Explore".to_string());
        a.ingest(&spawn);
        let mut tool = hook("PreToolUse", Some("Edit"), Some("e1"));
        tool.agent_id = Some("agent_a".to_string());
        tool.agent_type = Some("Explore".to_string());
        a.ingest(&tool);

        let mut post = hook("PostToolUse", Some("Agent"), Some("t1"));
        post.duration_ms = Some(4200);
        a.ingest(&post);

        let sub = &a.subagents()[0];
        assert_eq!(sub.state, SubagentState::Done);
        assert_eq!(sub.duration_ms, Some(4200));
        assert!(
            sub.current_tool.is_none(),
            "done subagent has no current tool"
        );
    }

    #[test]
    fn stop_settles_orphaned_running_subagent_and_clears_main_tool() {
        let mut a = HookActivity::new();
        let mut spawn = hook("PreToolUse", Some("Agent"), Some("t1"));
        spawn.subagent_type = Some("Explore".to_string());
        a.ingest(&spawn);
        let mut maintool = hook("PreToolUse", Some("Bash"), Some("b1"));
        maintool.command = Some("ls".to_string());
        a.ingest(&maintool); // sets main.current_tool

        // The turn ends with no Agent PostToolUse — settle must finish it.
        let mut stop = hook("Stop", None, None);
        stop.ts = Some("2026-06-21T00:05:00Z".to_string());
        assert!(a.ingest(&stop));
        assert_eq!(a.subagents()[0].state, SubagentState::Done);
        assert_eq!(
            a.subagents()[0].ended_at.as_deref(),
            Some("2026-06-21T00:05:00Z")
        );
        assert!(a.main().current_tool.is_none());

        // Settling again with nothing running changes nothing.
        assert!(!a.ingest(&hook("Stop", None, None)));
    }

    #[test]
    fn subagent_stop_does_not_settle_siblings_only_main_stop_does() {
        // A subagent runs as its own nested claude session and fires Stop +
        // SessionEnd into the SAME events file (it inherits KRIYON_SESSION). Those
        // must NOT settle the still-running siblings; only the main session's Stop
        // (the session that spawned the agents) settles.
        let mut a = HookActivity::new();
        let mut start = hook("SessionStart", None, None);
        start.session_id = Some("main".to_string());
        a.ingest(&start);
        let mut s1 = hook("PreToolUse", Some("Agent"), Some("t1"));
        s1.session_id = Some("main".to_string());
        s1.subagent_type = Some("Explore".to_string());
        a.ingest(&s1);
        let mut s2 = hook("PreToolUse", Some("Agent"), Some("t2"));
        s2.session_id = Some("main".to_string());
        s2.subagent_type = Some("Explore".to_string());
        a.ingest(&s2);

        // A subagent's own nested session ends — must change nothing.
        let mut sub_stop = hook("Stop", None, None);
        sub_stop.session_id = Some("subagent-1".to_string());
        assert!(!a.ingest(&sub_stop), "a subagent Stop must not settle");
        let mut sub_end = hook("SessionEnd", None, None);
        sub_end.session_id = Some("subagent-1".to_string());
        assert!(!a.ingest(&sub_end), "a subagent SessionEnd must not settle");
        assert!(
            a.subagents()
                .iter()
                .all(|s| s.state == SubagentState::Running),
            "siblings must stay running after a subagent's own stop"
        );

        // The main session's Stop settles everything.
        let mut main_stop = hook("Stop", None, None);
        main_stop.session_id = Some("main".to_string());
        assert!(a.ingest(&main_stop), "the main Stop settles");
        assert!(
            a.subagents().iter().all(|s| s.state == SubagentState::Done),
            "the main Stop forces orphaned siblings done"
        );
    }

    #[test]
    fn session_end_settles_too() {
        let mut a = HookActivity::new();
        let mut spawn = hook("PreToolUse", Some("Agent"), Some("t1"));
        spawn.subagent_type = Some("Explore".to_string());
        a.ingest(&spawn);
        assert!(a.ingest(&hook("SessionEnd", None, None)));
        assert_eq!(a.subagents()[0].state, SubagentState::Done);
    }

    #[test]
    fn non_tool_events_are_ignored() {
        let mut a = HookActivity::new();
        assert!(!a.ingest(&hook("Stop", None, None)));
        assert!(!a.ingest(&hook("UserPromptSubmit", None, None)));
        assert_eq!(a.subagents(), [] as [crate::activity::Subagent; 0]);
    }

    #[test]
    fn parse_task_file_maps_subject_status_active_form() {
        let json = r#"{"id":"1","subject":"Write guard","description":"d","activeForm":"Writing the guard","status":"completed","blocks":[],"blockedBy":[]}"#;
        assert_eq!(
            parse_task_file(json),
            Some(Task {
                text: "Write guard".to_string(),
                status: TaskStatus::Completed,
                active_form: Some("Writing the guard".to_string()),
            })
        );
    }

    #[test]
    fn parse_task_file_defaults_and_tolerates() {
        // Missing activeForm → None; unknown status → Pending.
        let json = r#"{"id":"2","subject":"Do thing","status":"in_progress"}"#;
        assert_eq!(
            parse_task_file(json),
            Some(Task {
                text: "Do thing".to_string(),
                status: TaskStatus::InProgress,
                active_form: None,
            })
        );
        // A deleted task file (should it linger) is not shown.
        assert_eq!(
            parse_task_file(r#"{"id":"3","subject":"x","status":"deleted"}"#),
            None
        );
        assert_eq!(parse_task_file("not json"), None);
    }

    #[test]
    fn snapshot_serializes_camel_case() {
        let activity = SessionActivity {
            main: MainAgent::default(),
            subagents: vec![Subagent {
                tool_use_id: "t1".to_string(),
                kind: "Explore".to_string(),
                description: None,
                state: SubagentState::Running,
                started_at: None,
                ended_at: None,
                result: None,
                agent_id: None,
                current_tool: None,
                duration_ms: None,
            }],
            shells: vec![],
            tasks: vec![Task {
                text: "wire store".to_string(),
                status: TaskStatus::InProgress,
                active_form: Some("wiring store".to_string()),
            }],
            pending_ask: None,
        };
        let json = serde_json::to_string(&activity).expect("serialize");
        assert!(json.contains("\"toolUseId\":\"t1\""), "got: {json}");
        assert!(json.contains("\"state\":\"running\""), "got: {json}");
        assert!(
            json.contains("\"activeForm\":\"wiring store\""),
            "got: {json}"
        );
        assert!(json.contains("\"status\":\"in_progress\""), "got: {json}");
    }

    /// A background `Agent` launch as the hook script records it: `Pre`, then a
    /// `Post` that returns at once carrying the launched agent's id.
    fn launch_in_background(a: &mut HookActivity, tool_use_id: &str, agent_id: &str) {
        let mut pre = hook("PreToolUse", Some("Agent"), Some(tool_use_id));
        pre.subagent_type = Some("general-purpose".to_string());
        a.ingest(&pre);
        let mut post = hook("PostToolUse", Some("Agent"), Some(tool_use_id));
        post.launched_agent_id = Some(agent_id.to_string());
        a.ingest(&post);
    }

    fn stop_listing(agent_ids: &[&str]) -> HookEvent {
        let mut stop = hook("Stop", None, None);
        stop.ts = Some("2026-09-27T00:01:00Z".to_string());
        stop.background_tasks = Some(
            agent_ids
                .iter()
                .map(|id| crate::hooks::InFlightWork {
                    id: (*id).to_string(),
                    kind: "subagent".to_string(),
                })
                .collect(),
        );
        stop
    }

    #[test]
    fn a_background_agent_keeps_running_after_its_launch_returns() {
        let mut a = HookActivity::new();
        launch_in_background(&mut a, "t1", "a5bb2047");
        let agent = a.subagents().pop().expect("the subagent");
        assert_eq!(agent.state, SubagentState::Running);
        assert_eq!(agent.agent_id.as_deref(), Some("a5bb2047"));
        assert_eq!(agent.result, None);
    }

    #[test]
    fn a_stop_settles_only_the_agents_it_no_longer_lists() {
        let mut a = HookActivity::new();
        launch_in_background(&mut a, "t1", "agent_a");
        launch_in_background(&mut a, "t2", "agent_b");
        a.ingest(&stop_listing(&["agent_b"]));
        let states: Vec<_> = a.subagents().iter().map(|s| s.state).collect();
        assert_eq!(states, [SubagentState::Done, SubagentState::Running]);
        a.ingest(&stop_listing(&[]));
        assert!(a.subagents().iter().all(|s| s.state == SubagentState::Done));
    }

    #[test]
    fn a_background_agents_tools_are_attributed_by_its_exact_id() {
        // Two same-type agents: order-based binding could swap them; the
        // launch id cannot.
        let mut a = HookActivity::new();
        launch_in_background(&mut a, "t1", "agent_a");
        launch_in_background(&mut a, "t2", "agent_b");
        let mut tool = hook("PreToolUse", Some("Read"), Some("r1"));
        tool.agent_id = Some("agent_b".to_string());
        tool.agent_type = Some("general-purpose".to_string());
        a.ingest(&tool);
        let subs = a.subagents();
        assert!(subs[0].current_tool.is_none());
        assert_eq!(
            subs[1].current_tool.as_ref().map(|t| t.tool_name.as_str()),
            Some("Read")
        );
    }

    #[test]
    fn a_session_end_settles_background_agents_too() {
        let mut a = HookActivity::new();
        launch_in_background(&mut a, "t1", "agent_a");
        a.ingest(&hook("SessionEnd", None, None));
        assert_eq!(a.subagents()[0].state, SubagentState::Done);
    }

    #[test]
    fn a_permission_request_leaves_the_tool_it_guards_in_flight() {
        // The dialog is up *because* the tool is about to run; only the tool's
        // own end clears it. The request carries the tool's name, and used to
        // be taken for that tool finishing.
        let mut a = HookActivity::new();
        let mut pre = hook("PreToolUse", Some("Bash"), Some("b1"));
        pre.target = Some("rm -rf build".to_string());
        a.ingest(&pre);
        a.ingest(&hook("PermissionRequest", Some("Bash"), None));
        assert_eq!(
            a.main().current_tool.map(|t| t.tool_name).as_deref(),
            Some("Bash")
        );
    }

    #[test]
    fn a_background_launch_without_a_usable_id_still_runs_until_the_turn_ends() {
        let mut a = HookActivity::new();
        a.ingest(&hook("PreToolUse", Some("Agent"), Some("t1")));
        let mut post = hook("PostToolUse", Some("Agent"), Some("t1"));
        post.launched_agent_id = Some(String::new());
        a.ingest(&post);
        let agent = a.subagents().pop().expect("the subagent");
        assert_eq!(agent.state, SubagentState::Running);
        assert_eq!(agent.agent_id, None);
        a.ingest(&stop_listing(&[]));
        assert_eq!(a.subagents()[0].state, SubagentState::Done);
    }

    #[test]
    fn a_launch_receipt_drops_a_tool_it_was_lazily_credited_with() {
        // Agent Y's first tool binds by type + order to t1; t1's receipt then
        // says t1 is X. Y's Read was never t1's.
        let mut a = HookActivity::new();
        for id in ["t1", "t2"] {
            let mut pre = hook("PreToolUse", Some("Agent"), Some(id));
            pre.subagent_type = Some("general-purpose".to_string());
            a.ingest(&pre);
        }
        let mut read = hook("PreToolUse", Some("Read"), Some("r1"));
        read.agent_id = Some("agent_y".to_string());
        read.agent_type = Some("general-purpose".to_string());
        a.ingest(&read);
        let mut receipt = hook("PostToolUse", Some("Agent"), Some("t1"));
        receipt.launched_agent_id = Some("agent_x".to_string());
        a.ingest(&receipt);
        let t1 = &a.subagents()[0];
        assert_eq!(t1.agent_id.as_deref(), Some("agent_x"));
        assert!(t1.current_tool.is_none(), "{:?}", t1.current_tool);
    }

    #[test]
    fn a_repeated_launch_receipt_changes_nothing() {
        let mut a = HookActivity::new();
        launch_in_background(&mut a, "t1", "agent_a");
        let mut again = hook("PostToolUse", Some("Agent"), Some("t1"));
        again.launched_agent_id = Some("agent_a".to_string());
        assert!(!a.ingest(&again));
    }
}
