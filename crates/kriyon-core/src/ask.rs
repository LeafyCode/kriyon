//! Pending ask — the concrete thing a `waiting` Session wants from the user,
//! reconstructed live from hook events. One open ask per session, newest wins;
//! cleared at every turn boundary so an ask can never outlive the turn it
//! belongs to (the settle guarantee). Tolerant: unknown or malformed input is
//! a no-op or a generic-text degradation, never an error. See CONTEXT.md
//! "Pending ask" and the 2026-07-02 actionable-needs-you spec.

use serde::{Deserialize, Serialize};

use crate::hook_signal::{classify, Actor, HookSignal, ToolPhase};
use crate::hooks::{HookEvent, NotificationKind};

/// What kind of thing the session is asking for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskKind {
    Question,
    Permission,
    PlanApproval,
}

/// The open ask: kind, one line of human text, and when it was asked
/// (the hook's ISO timestamp, driving "blocked for 12m").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAsk {
    pub kind: AskKind,
    pub text: String,
    pub asked_at: Option<String>,
}

/// Folds hook events into the session's current [`PendingAsk`].
#[derive(Debug, Default)]
pub struct AskState {
    current: Option<PendingAsk>,
    /// The tool call the current ask belongs to, so only its own
    /// `PostToolUse` closes a question/plan (permissions have none).
    tool_use_id: Option<String>,
    /// The [Subagent] whose permission dialog the current ask is, so that
    /// agent carrying on closes it — the same rule the status follows
    /// (ADR-0027). `None` for the main agent's own asks.
    asker: Option<String>,
}

impl AskState {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The open ask, if any.
    #[must_use]
    pub fn current(&self) -> Option<PendingAsk> {
        self.current.clone()
    }

    /// Fold one hook event in. Returns whether [`Self::current`] changed.
    ///
    /// Subagent-attributed events (those carrying an `agent_id`) count only as
    /// a permission dialog and its answer. A subagent's `AskUserQuestion` or
    /// `ExitPlanMode` is its own business, not a claim on the user's attention,
    /// but its permission dialog blocks the terminal like any other — and the
    /// same agent carrying on is proof it was answered. Subagent tool events
    /// carry the *main* session's id, so the caller's main-session lock cannot
    /// filter them; this is the only place that distinction can be made.
    pub fn ingest(&mut self, ev: &HookEvent) -> bool {
        let before = self.current.clone();
        match classify(ev) {
            HookSignal::Tool(call) if call.actor != Actor::Main => {
                if let Actor::Subagent(agent) = call.actor {
                    if self.asker.as_deref() == Some(agent) {
                        self.clear();
                    }
                }
            }
            HookSignal::Tool(call) if call.phase == ToolPhase::Started => match call.name {
                "AskUserQuestion" => {
                    self.open(
                        AskKind::Question,
                        question_text(ev.questions.as_deref()),
                        ev,
                    );
                }
                "ExitPlanMode" => {
                    self.open(AskKind::PlanApproval, plan_text(ev.plan.as_deref()), ev);
                }
                _ => {}
            },
            // A tool that failed is over too: a rejected question, a denied
            // permission.
            HookSignal::Tool(_) => {
                let closes_own_tool =
                    self.tool_use_id.is_some() && self.tool_use_id == ev.tool_use_id;
                // Subagent tool events were handled above, so any tool end at
                // this point is the main agent's and proves the permission
                // prompt resolved. A *parallel* main-agent tool's Post also
                // clears it — there's no id to disambiguate that case, so it's
                // accepted as a residual ambiguity.
                let resolves_permission = matches!(
                    &self.current,
                    Some(ask) if ask.kind == AskKind::Permission
                );
                if closes_own_tool || resolves_permission {
                    self.clear();
                }
            }
            // Only a *blocking* Notification is an exact ask — a permission gate
            // or an MCP elicitation dialog. An idle prompt is prose the
            // frontend's snippet fallback renders honestly, and an informational
            // one (login succeeded, background agent finished) asks nothing at
            // all. A block must never downgrade an already-open question or plan
            // (see `has_specific_ask`). It names no agent, so it keeps the asker
            // of a permission dialog already open: it is about the same dialog.
            HookSignal::Notified(kind) => {
                if kind == NotificationKind::Block && !self.has_specific_ask() {
                    self.open_permission(ev);
                }
            }
            HookSignal::PermissionRequested(actor) => {
                if !self.has_specific_ask() {
                    self.open_permission(ev);
                    self.asker = match actor {
                        Actor::Subagent(agent) => Some(agent.to_string()),
                        Actor::Main => None,
                    };
                }
            }
            HookSignal::PromptSubmitted | HookSignal::TurnEnded(_) | HookSignal::SessionEnded => {
                self.clear();
            }
            HookSignal::SessionStarted | HookSignal::Unrecognized => {}
        }
        self.current != before
    }

    fn open_permission(&mut self, ev: &HookEvent) {
        self.open(
            AskKind::Permission,
            ev.message
                .clone()
                .unwrap_or_else(|| "Needs permission".to_string()),
            ev,
        );
    }

    fn open(&mut self, kind: AskKind, text: String, ev: &HookEvent) {
        self.current = Some(PendingAsk {
            kind,
            text,
            asked_at: ev.ts.clone(),
        });
        self.tool_use_id.clone_from(&ev.tool_use_id);
    }

    fn clear(&mut self) {
        self.current = None;
        self.tool_use_id = None;
        self.asker = None;
    }

    /// A more specific ask — a [`AskKind::Question`] or [`AskKind::PlanApproval`]
    /// — is already open. Claude Code fires a generic permission gate
    /// (`PermissionRequest`, or a "needs permission" `Notification`) for the
    /// `AskUserQuestion` / `ExitPlanMode` tool *itself* when the user's config
    /// requires it; that gate must not overwrite the question/plan it guards.
    fn has_specific_ask(&self) -> bool {
        matches!(&self.current, Some(ask) if ask.kind != AskKind::Permission)
    }
}

/// Extract the first question (plus a "+N more" suffix) from the raw questions
/// JSON. Anything unparseable degrades to generic text, never an error.
fn question_text(raw: Option<&str>) -> String {
    #[derive(Deserialize)]
    struct Entry {
        question: String,
    }
    let parsed = raw.and_then(|text| serde_json::from_str::<Vec<Entry>>(text).ok());
    match parsed {
        Some(entries) if !entries.is_empty() => {
            let first = &entries[0].question;
            if entries.len() > 1 {
                format!("{first} (+{} more)", entries.len() - 1)
            } else {
                first.clone()
            }
        }
        _ => "Has a question for you".to_string(),
    }
}

fn plan_text(plan: Option<&str>) -> String {
    match plan {
        Some(line) if !line.trim().is_empty() => format!("Approve plan: {}", line.trim()),
        _ => "Plan ready for review".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use crate::ask::{AskKind, AskState};
    use crate::hooks::HookEvent;

    fn ev(event: &str) -> HookEvent {
        HookEvent {
            event: event.to_string(),
            ..HookEvent::default()
        }
    }

    fn pre(tool: &str) -> HookEvent {
        HookEvent {
            event: "PreToolUse".to_string(),
            tool_name: Some(tool.to_string()),
            tool_use_id: Some("toolu_1".to_string()),
            ts: Some("2026-07-02T10:00:00Z".to_string()),
            ..HookEvent::default()
        }
    }

    #[test]
    fn question_opens_with_extracted_text() {
        let mut state = AskState::new();
        let mut event = pre("AskUserQuestion");
        event.questions =
            Some(r#"[{"question":"Which db?"},{"question":"Which region?"}]"#.to_string());
        assert!(state.ingest(&event));
        let ask = state.current().expect("open ask");
        assert_eq!(ask.kind, AskKind::Question);
        assert_eq!(ask.text, "Which db? (+1 more)");
        assert_eq!(ask.asked_at.as_deref(), Some("2026-07-02T10:00:00Z"));
    }

    #[test]
    fn single_question_has_no_more_suffix() {
        let mut state = AskState::new();
        let mut event = pre("AskUserQuestion");
        event.questions = Some(r#"[{"question":"Which db?"}]"#.to_string());
        state.ingest(&event);
        assert_eq!(state.current().expect("open").text, "Which db?");
    }

    #[test]
    fn malformed_questions_degrade_to_generic_text() {
        let mut state = AskState::new();
        let mut event = pre("AskUserQuestion");
        event.questions = Some("{not json".to_string());
        state.ingest(&event);
        assert_eq!(
            state.current().expect("open").text,
            "Has a question for you"
        );
        // Missing entirely (hook dropped an oversized payload) degrades the same way.
        let mut state = AskState::new();
        state.ingest(&pre("AskUserQuestion"));
        assert_eq!(
            state.current().expect("open").text,
            "Has a question for you"
        );
    }

    #[test]
    fn matching_post_tool_use_clears_the_question() {
        let mut state = AskState::new();
        state.ingest(&pre("AskUserQuestion"));
        let mut post = ev("PostToolUse");
        post.tool_use_id = Some("toolu_1".to_string());
        assert!(state.ingest(&post));
        assert_eq!(state.current(), None);
    }

    #[test]
    fn unrelated_post_tool_use_keeps_the_question() {
        let mut state = AskState::new();
        state.ingest(&pre("AskUserQuestion"));
        let mut post = ev("PostToolUse");
        post.tool_use_id = Some("toolu_other".to_string());
        assert!(!state.ingest(&post));
        assert!(state.current().is_some());
    }

    #[test]
    fn plan_approval_opens_with_plan_line() {
        let mut state = AskState::new();
        let mut event = pre("ExitPlanMode");
        event.plan = Some("Ship the actionable needs-you".to_string());
        state.ingest(&event);
        let ask = state.current().expect("open");
        assert_eq!(ask.kind, AskKind::PlanApproval);
        assert_eq!(ask.text, "Approve plan: Ship the actionable needs-you");
    }

    #[test]
    fn plan_approval_without_plan_uses_generic_text() {
        let mut state = AskState::new();
        state.ingest(&pre("ExitPlanMode"));
        assert_eq!(state.current().expect("open").text, "Plan ready for review");
    }

    #[test]
    fn permission_notification_opens_a_permission_ask() {
        let mut state = AskState::new();
        let mut event = ev("Notification");
        event.message = Some("Claude needs your permission to use Bash".to_string());
        assert!(state.ingest(&event));
        let ask = state.current().expect("open");
        assert_eq!(ask.kind, AskKind::Permission);
        assert_eq!(ask.text, "Claude needs your permission to use Bash");
    }

    #[test]
    fn a_blocking_notification_type_opens_an_ask_whatever_the_wording() {
        // Classified by `notification_type`, so a permission gate whose prose the
        // substring match would miss still becomes a real ask — and an MCP
        // elicitation dialog, which blocks the user just as hard, finally does too.
        for (ty, text) in [
            ("permission_prompt", "Allow Bash to run `rm -rf build`?"),
            ("elicitation_dialog", "Claude Code needs your input"),
        ] {
            let mut state = AskState::new();
            let mut event = ev("Notification");
            event.notification_type = Some(ty.to_string());
            event.message = Some(text.to_string());
            assert!(state.ingest(&event), "{ty}");
            let ask = state.current().expect("open");
            assert_eq!(ask.kind, AskKind::Permission, "{ty}");
            assert_eq!(ask.text, text, "{ty}");
        }
    }

    #[test]
    fn an_informational_notification_opens_nothing() {
        // A login-succeeded toast or a background agent's own lifecycle asks
        // nothing of this session — it must never surface as a pending ask.
        for ty in ["auth_success", "agent_completed", "elicitation_complete"] {
            let mut state = AskState::new();
            let mut event = ev("Notification");
            event.notification_type = Some(ty.to_string());
            event.message = Some("some status message".to_string());
            assert!(!state.ingest(&event), "{ty}");
            assert_eq!(state.current(), None, "{ty}");
        }
    }

    #[test]
    fn non_permission_notification_opens_nothing() {
        // An idle-prompt Notification is prose the snippet fallback renders better;
        // claiming it as a permission would be a confident wrong state.
        let mut state = AskState::new();
        let mut event = ev("Notification");
        event.message = Some("Claude is waiting for your input".to_string());
        assert!(!state.ingest(&event));
        assert_eq!(state.current(), None);
    }

    #[test]
    fn permission_request_event_opens_a_permission_ask() {
        let mut state = AskState::new();
        state.ingest(&ev("PermissionRequest"));
        let ask = state.current().expect("open");
        assert_eq!(ask.kind, AskKind::Permission);
        assert_eq!(ask.text, "Needs permission");
    }

    #[test]
    fn any_post_tool_use_resolves_a_permission() {
        // Sequence: PreToolUse(Bash) → permission Notification → user approves →
        // the tool runs → PostToolUse(Bash). The Post proves the prompt resolved.
        let mut state = AskState::new();
        let mut event = ev("Notification");
        event.message = Some("Claude needs your permission to run rm".to_string());
        state.ingest(&event);
        assert!(state.ingest(&ev("PostToolUse")));
        assert_eq!(state.current(), None);
    }

    #[test]
    fn subagent_post_tool_use_keeps_the_permission() {
        // A subagent's own tool events carry an agent_id. Its PostToolUse must
        // not be mistaken for resolution of the main agent's permission ask —
        // the user is still blocked.
        let mut state = AskState::new();
        let mut event = ev("Notification");
        event.message = Some("Claude needs your permission to use Bash".to_string());
        state.ingest(&event);
        let mut sub_post = ev("PostToolUse");
        sub_post.agent_id = Some("agent_7".to_string());
        assert!(!state.ingest(&sub_post));
        assert!(state.current().is_some());
    }

    fn subagent_permission(agent: &str) -> HookEvent {
        HookEvent {
            event: "PermissionRequest".to_string(),
            agent_id: Some(agent.to_string()),
            message: Some("Allow Bash?".to_string()),
            ..HookEvent::default()
        }
    }

    fn subagent_tool(agent: &str) -> HookEvent {
        HookEvent {
            event: "PostToolUse".to_string(),
            agent_id: Some(agent.to_string()),
            ..HookEvent::default()
        }
    }

    #[test]
    fn a_subagents_permission_gate_is_an_ask_until_it_carries_on() {
        // A subagent's permission dialog blocks the terminal like any other
        // (ADR-0027). The Notification that follows names no agent. When the
        // agent that asked carries on, the dialog was answered.
        let mut state = AskState::new();
        assert!(state.ingest(&subagent_permission("agent_7")));
        let mut note = ev("Notification");
        note.message = Some("Claude needs your permission to use Bash".to_string());
        state.ingest(&note);
        assert!(state.current().is_some(), "the dialog is on screen");

        assert!(state.ingest(&subagent_tool("agent_7")));
        assert_eq!(state.current(), None, "the asker carrying on answers it");
    }

    #[test]
    fn another_subagents_tool_event_keeps_the_permission() {
        let mut state = AskState::new();
        state.ingest(&subagent_permission("agent_7"));
        assert!(!state.ingest(&subagent_tool("agent_8")));
        assert!(state.current().is_some());
    }

    #[test]
    fn matching_post_tool_use_clears_a_plan_approval() {
        let mut state = AskState::new();
        state.ingest(&pre("ExitPlanMode"));
        let mut post = ev("PostToolUse");
        post.tool_use_id = Some("toolu_1".to_string());
        assert!(state.ingest(&post));
        assert_eq!(state.current(), None);
    }

    #[test]
    fn turn_boundaries_settle_any_ask() {
        for boundary in ["UserPromptSubmit", "Stop", "SessionEnd"] {
            let mut state = AskState::new();
            state.ingest(&pre("AskUserQuestion"));
            assert!(state.ingest(&ev(boundary)), "{boundary} clears");
            assert_eq!(state.current(), None, "{boundary} cleared");
        }
    }

    #[test]
    fn newest_ask_wins() {
        let mut state = AskState::new();
        state.ingest(&pre("AskUserQuestion"));
        let mut plan = pre("ExitPlanMode");
        plan.tool_use_id = Some("toolu_2".to_string());
        state.ingest(&plan);
        assert_eq!(state.current().expect("open").kind, AskKind::PlanApproval);
    }

    #[test]
    fn unknown_events_are_a_no_op() {
        let mut state = AskState::new();
        assert!(!state.ingest(&ev("PreCompact")));
        assert!(!state.ingest(&ev("SomethingNew")));
        assert_eq!(state.current(), None);
    }

    #[test]
    fn ingest_reports_changed_only_on_change() {
        let mut state = AskState::new();
        assert!(!state.ingest(&ev("Stop")), "clearing nothing is no change");
        assert!(state.ingest(&pre("AskUserQuestion")));
        assert!(!state.ingest(&ev("PreCompact")), "no-op is no change");
    }

    #[test]
    fn permission_gate_for_a_question_keeps_it_a_question() {
        // When the user's config requires permission to use the AskUserQuestion
        // tool, Claude Code fires (in order) PreToolUse(AskUserQuestion) →
        // PermissionRequest(AskUserQuestion) → a "needs permission" Notification.
        // The permission gate is for the ask tool itself; it must not downgrade
        // the open question to a bare permission. (Observed 2026-07-05.)
        let mut state = AskState::new();
        let mut pre_ask = pre("AskUserQuestion");
        pre_ask.questions = Some(r#"[{"question":"Which color?"}]"#.to_string());
        state.ingest(&pre_ask);
        assert_eq!(
            state.current().expect("question opened").kind,
            AskKind::Question
        );

        let mut perm_req = ev("PermissionRequest");
        perm_req.tool_name = Some("AskUserQuestion".to_string());
        perm_req.questions = Some(r#"[{"question":"Which color?"}]"#.to_string());
        state.ingest(&perm_req);
        assert_eq!(
            state.current().expect("still open").kind,
            AskKind::Question,
            "PermissionRequest for the ask tool must not downgrade the question"
        );

        let mut notif = ev("Notification");
        notif.message = Some("Claude needs your permission".to_string());
        state.ingest(&notif);
        let ask = state.current().expect("still open");
        assert_eq!(
            ask.kind,
            AskKind::Question,
            "a generic permission Notification must not downgrade the question"
        );
        assert_eq!(ask.text, "Which color?");
    }

    #[test]
    fn permission_gate_for_a_plan_keeps_it_a_plan_approval() {
        let mut state = AskState::new();
        state.ingest(&pre("ExitPlanMode"));
        let mut perm_req = ev("PermissionRequest");
        perm_req.tool_name = Some("ExitPlanMode".to_string());
        state.ingest(&perm_req);
        assert_eq!(
            state.current().expect("plan still open").kind,
            AskKind::PlanApproval,
            "PermissionRequest for the plan tool must not downgrade the plan approval"
        );
    }

    #[test]
    fn a_failed_question_or_permission_closes_its_ask() {
        // A rejected question and a denied permission end their tool with
        // `PostToolUseFailure`, never `PostToolUse`; the ask must still close.
        let mut state = AskState::new();
        state.ingest(&crate::hooks::parse_hook_line(
            r#"{"event":"PreToolUse","tool_name":"AskUserQuestion","tool_use_id":"q1","questions":"[{\"question\":\"Merge?\"}]"}"#,
        ).expect("parses"));
        assert!(state.current().is_some());
        assert!(state.ingest(&crate::hooks::parse_hook_line(
            r#"{"event":"PostToolUseFailure","tool_name":"AskUserQuestion","tool_use_id":"q1"}"#,
        ).expect("parses")));
        assert!(state.current().is_none());
    }
}
