//! [Hook signal]: what one Claude Code hook event *means*, decided once.
//!
//! A [`HookEvent`] is the wire record — an event name plus two dozen optional
//! fields. Every fold that reads it (the [Status] tracker, [Session activity],
//! the [Pending ask], the [Main session lock]) needs the same few answers from
//! it: did the main turn open or end, and with what still in flight; is this a
//! tool call, in which phase, and did the [Main agent] or a [Subagent] make it;
//! is it a permission request or a notification. [`classify`] answers them in
//! one place, so the folds match on [`HookSignal`] instead of each re-matching
//! event-name strings — a turn-end rule, a subagent test or an in-flight rule
//! can then no longer mean one thing to one fold and another to the next.
//!
//! The payload (a tool's target, a question's text, timestamps) stays on the
//! [`HookEvent`]; the signal carries only the meaning.

use crate::hooks::{notification_kind, HookEvent, InFlightWork, NotificationKind};

/// What one hook event means. See the module docs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookSignal<'a> {
    /// `SessionStart`: a claude booted and sits idle at its prompt.
    SessionStarted,
    /// `SessionEnd`: that claude exited.
    SessionEnded,
    /// `UserPromptSubmit`: the main turn opens — a prompt the user typed, or a
    /// [Background agent]'s report waking the main agent.
    PromptSubmitted,
    /// A tool call starting, finishing or failing.
    Tool(ToolCall<'a>),
    /// `PermissionRequest`: a permission dialog is up.
    PermissionRequested(Actor<'a>),
    /// `Notification`, already classified.
    Notified(NotificationKind),
    /// `Stop` or `StopFailure`: the main turn is over.
    TurnEnded(TurnEnd<'a>),
    /// An event Kriyon does not subscribe to, or does not recognize.
    Unrecognized,
}

impl<'a> HookSignal<'a> {
    /// Who raised this signal. Only tool calls and permission requests can
    /// name a [Subagent]; everything else is the main agent's.
    #[must_use]
    pub fn actor(&self) -> Actor<'a> {
        match self {
            Self::Tool(call) => call.actor,
            Self::PermissionRequested(actor) => *actor,
            _ => Actor::Main,
        }
    }
}

/// Which agent raised a signal. Claude Code stamps a [Subagent]'s own events
/// with its `agent_id`, under the main session's id — so the [Main session
/// lock] cannot tell them apart, and this is where the difference is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Actor<'a> {
    Main,
    Subagent(&'a str),
}

/// One tool-call event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToolCall<'a> {
    pub phase: ToolPhase,
    pub actor: Actor<'a>,
    /// The tool name (`""` when the hook carried none).
    pub name: &'a str,
}

impl ToolCall<'_> {
    /// Whether this call spawns a [Subagent] (`Agent`, named `Task` in older
    /// builds).
    #[must_use]
    pub fn spawns_agent(&self) -> bool {
        matches!(self.name, "Agent" | "Task")
    }
}

/// Where a tool call is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolPhase {
    /// `PreToolUse`.
    Started,
    /// `PostToolUse`.
    Finished,
    /// `PostToolUseFailure`, which a failed tool fires *instead of* `PostToolUse`.
    Failed,
}

impl ToolPhase {
    /// Whether the call is over, successfully or not.
    #[must_use]
    pub fn ended(self) -> bool {
        matches!(self, Self::Finished | Self::Failed)
    }
}

/// How the main turn ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TurnEnd<'a> {
    /// `StopFailure`: the turn died on an API error and never fired `Stop`.
    pub failed: bool,
    /// A `Stop` hook blocked an earlier `Stop` and Claude carried on, so this
    /// ends a turn the user has already been told about.
    pub reentry: bool,
    /// What Claude Code says is still running in the background.
    pub in_flight: InFlight<'a>,
}

/// The [In-flight work] a turn end reported, or `None` when it reported none
/// (a build that predates the list, a failed turn, an unreadable list) —
/// unknown, which is not the same as nothing in flight.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InFlight<'a>(Option<&'a [InFlightWork]>);

impl InFlight<'_> {
    /// How many [Background agent]s are still in flight, or `None` if unknown.
    #[must_use]
    pub fn background_agents(&self) -> Option<usize> {
        self.0
            .map(|work| work.iter().filter(|w| w.is_background_agent()).count())
    }

    /// Whether the [Background agent] with this `agent_id` is still in flight.
    /// Unknown lists keep nothing running.
    #[must_use]
    pub fn keeps_agent_running(&self, agent_id: &str) -> bool {
        self.0.is_some_and(|work| {
            work.iter()
                .any(|w| w.is_background_agent() && w.id == agent_id)
        })
    }
}

/// Claude Code's id for a tool call a mod made with `$.tool.call`, not the
/// model: such as the Companion's report, sent after its turn's `Stop`.
const MOD_CALL_PREFIX: &str = "toolu_plugin_";

/// A tool call a mod made says nothing about whether Claude is working, so no
/// fold reads it. Should Claude Code change the spelling, a mod's call counts
/// as Claude's again: a session can look busy, nothing breaks.
fn is_mod_call(ev: &HookEvent) -> bool {
    ev.tool_use_id
        .as_deref()
        .is_some_and(|id| id.starts_with(MOD_CALL_PREFIX))
}

/// Classify one hook event. Total and tolerant: anything unrecognized is
/// [`HookSignal::Unrecognized`], never an error.
#[must_use]
pub fn classify(ev: &HookEvent) -> HookSignal<'_> {
    let actor = match ev.agent_id.as_deref() {
        Some(id) if !id.is_empty() => Actor::Subagent(id),
        _ => Actor::Main,
    };
    let tool = |phase| {
        if is_mod_call(ev) {
            return HookSignal::Unrecognized;
        }
        HookSignal::Tool(ToolCall {
            phase,
            actor,
            name: ev.tool_name.as_deref().unwrap_or_default(),
        })
    };
    match ev.event.as_str() {
        "SessionStart" => HookSignal::SessionStarted,
        "SessionEnd" => HookSignal::SessionEnded,
        "UserPromptSubmit" => HookSignal::PromptSubmitted,
        "PreToolUse" => tool(ToolPhase::Started),
        "PostToolUse" => tool(ToolPhase::Finished),
        "PostToolUseFailure" => tool(ToolPhase::Failed),
        "PermissionRequest" => HookSignal::PermissionRequested(actor),
        "Notification" => HookSignal::Notified(notification_kind(
            ev.notification_type.as_deref(),
            ev.message.as_deref(),
        )),
        "Stop" => HookSignal::TurnEnded(TurnEnd {
            failed: false,
            reentry: ev.stop_hook_active == Some(true),
            in_flight: InFlight(ev.background_tasks.as_deref()),
        }),
        "StopFailure" => HookSignal::TurnEnded(TurnEnd {
            failed: true,
            reentry: false,
            in_flight: InFlight(None),
        }),
        _ => HookSignal::Unrecognized,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::{parse_hook_line, REGISTERED_HOOK_EVENTS};

    fn ev(json: &str) -> HookEvent {
        parse_hook_line(json).expect("fixture parses")
    }

    #[test]
    fn every_registered_event_means_something() {
        // The registration list and the classifier are one conceptual table: a
        // registered event that classified as Unrecognized would be recorded
        // and then silently ignored by every fold.
        for event in REGISTERED_HOOK_EVENTS {
            let ev = HookEvent {
                event: (*event).to_string(),
                ..HookEvent::default()
            };
            assert_ne!(
                classify(&ev),
                HookSignal::Unrecognized,
                "registered hook event {event} is unrecognized"
            );
        }
    }

    #[test]
    fn classifies_real_claude_code_lines() {
        // Lines as Kriyon's hook script records them from Claude Code 2.1.283.
        assert_eq!(
            classify(&ev(r#"{"event":"SessionStart","session_id":"m"}"#)),
            HookSignal::SessionStarted
        );
        assert_eq!(
            classify(&ev(r#"{"event":"SessionEnd","session_id":"m"}"#)),
            HookSignal::SessionEnded
        );
        assert_eq!(
            classify(&ev(r#"{"event":"UserPromptSubmit","session_id":"m"}"#)),
            HookSignal::PromptSubmitted
        );
        assert_eq!(
            classify(&ev(
                r#"{"event":"PreToolUse","session_id":"m","tool_name":"Agent"}"#
            )),
            HookSignal::Tool(ToolCall {
                phase: ToolPhase::Started,
                actor: Actor::Main,
                name: "Agent",
            })
        );
        assert_eq!(
            classify(&ev(
                r#"{"event":"PostToolUseFailure","session_id":"m","tool_name":"Bash","agent_id":"a5bb2047","agent_type":"general-purpose"}"#
            )),
            HookSignal::Tool(ToolCall {
                phase: ToolPhase::Failed,
                actor: Actor::Subagent("a5bb2047"),
                name: "Bash",
            })
        );
        assert_eq!(
            classify(&ev(
                r#"{"event":"PermissionRequest","session_id":"m","tool_name":"Bash"}"#
            )),
            HookSignal::PermissionRequested(Actor::Main)
        );
        assert_eq!(
            classify(&ev(
                r#"{"event":"Notification","notification_type":"idle_prompt","message":"Claude is waiting for your input"}"#
            )),
            HookSignal::Notified(NotificationKind::IdlePrompt)
        );
        assert_eq!(
            classify(&ev(r#"{"event":"PreCompact"}"#)),
            HookSignal::Unrecognized
        );
    }

    #[test]
    fn an_empty_agent_id_is_the_main_agent() {
        assert_eq!(
            classify(&ev(
                r#"{"event":"PreToolUse","tool_name":"Read","agent_id":""}"#
            ))
            .actor(),
            Actor::Main
        );
    }

    #[test]
    fn a_stop_reports_its_background_agents_and_a_failure_reports_none() {
        let stop = ev(
            r#"{"event":"Stop","stop_hook_active":true,"background_tasks":[{"id":"a1","type":"subagent"},{"id":"s1","type":"shell"}]}"#,
        );
        let HookSignal::TurnEnded(end) = classify(&stop) else {
            panic!("a Stop ends the turn");
        };
        assert!(!end.failed);
        assert!(end.reentry);
        assert_eq!(end.in_flight.background_agents(), Some(1));
        assert!(end.in_flight.keeps_agent_running("a1"));
        // A shell is in flight, but it is not an agent the session waits on.
        assert!(!end.in_flight.keeps_agent_running("s1"));

        let stop = ev(r#"{"event":"StopFailure","error":"rate_limit"}"#);
        let HookSignal::TurnEnded(end) = classify(&stop) else {
            panic!("a StopFailure ends the turn too");
        };
        assert!(end.failed);
        assert_eq!(end.in_flight.background_agents(), None);
        assert!(!end.in_flight.keeps_agent_running("a1"));
    }

    #[test]
    fn a_stop_without_the_list_reports_unknown_not_none() {
        let stop = ev(r#"{"event":"Stop"}"#);
        let HookSignal::TurnEnded(end) = classify(&stop) else {
            panic!("a Stop ends the turn");
        };
        assert_eq!(end.in_flight.background_agents(), None);
        let stop = ev(r#"{"event":"Stop","background_tasks":[]}"#);
        let HookSignal::TurnEnded(end) = classify(&stop) else {
            panic!("a Stop ends the turn");
        };
        assert_eq!(end.in_flight.background_agents(), Some(0));
    }

    #[test]
    fn only_agent_work_is_awaited() {
        let stop = ev(r#"{"event":"Stop","background_tasks":[
                {"id":"1","type":"shell"},{"id":"2","type":"monitor"},{"id":"3","type":"dream"},
                {"id":"4","type":"subagent"},{"id":"5","type":"workflow"},
                {"id":"6","type":"teammate"},{"id":"7","type":"cloud session"}]}"#);
        let HookSignal::TurnEnded(end) = classify(&stop) else {
            panic!("a Stop ends the turn");
        };
        assert_eq!(end.in_flight.background_agents(), Some(4));
    }

    #[test]
    fn agent_spawns_are_recognized_under_both_names() {
        for name in ["Agent", "Task"] {
            let call = ToolCall {
                phase: ToolPhase::Started,
                actor: Actor::Main,
                name,
            };
            assert!(call.spawns_agent(), "{name}");
        }
        assert!(!ToolCall {
            phase: ToolPhase::Started,
            actor: Actor::Main,
            name: "Bash",
        }
        .spawns_agent());
    }

    #[test]
    fn a_mods_own_tool_call_is_not_claude_working() {
        // The Companion sends a nested session's report after its turn's Stop
        // (ADR-0049); read as a tool start, it left the session working forever.
        for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
            let line = format!(
                r#"{{"event":"{event}","tool_name":"SendMessage","tool_use_id":"toolu_plugin_ff7b"}}"#
            );
            assert_eq!(classify(&ev(&line)), HookSignal::Unrecognized, "{event}");
        }
        let model =
            ev(r#"{"event":"PreToolUse","tool_name":"SendMessage","tool_use_id":"toolu_01RA"}"#);
        assert!(matches!(classify(&model), HookSignal::Tool(_)));
    }
}
