//! Pure notification content — the emoji, title line, and body for an
//! attention [Status], enriched with the project name, [Session title], and
//! [Pending ask]. No Tauri, no OS: unit-testable. See CONTEXT.md
//! "Notification content" and ADR 0008.

use crate::ask::{AskKind, PendingAsk};
use crate::session::SessionStatus;
use crate::status::NotifyDecision;

/// The rendered pieces of one OS notification (see CONTEXT.md). Maps onto the
/// three text tiers macOS renders: a bold `title`, a bold `subtitle`, and the
/// regular-weight `body`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotificationContent {
    /// Bold headline: the event emoji + project name — what needs attention.
    pub title: String,
    /// Bold second line: the session title — which session, empty when unknown.
    pub subtitle: String,
    /// Regular text: the ask's own words when present, else the event label.
    pub body: String,
}

/// Build the notification content for a status the user should be told about,
/// or `None` for the non-attention states (`Idle`, `Running`). A `waiting`
/// status refines its emoji + label to the [`PendingAsk`] kind when one is known.
#[must_use]
pub fn notification_content(
    status: SessionStatus,
    ask: Option<&PendingAsk>,
    project: &str,
    title: &str,
) -> Option<NotificationContent> {
    let (emoji, label) = match status {
        SessionStatus::Waiting => match ask.map(|a| a.kind) {
            Some(AskKind::Question) => ("\u{1F4AC}", "Needs your input"),
            Some(AskKind::Permission) => ("\u{1F511}", "Needs permission"),
            Some(AskKind::PlanApproval) => ("\u{1F4CB}", "Plan ready for review"),
            None => ("\u{23F3}", "Needs your input"),
        },
        SessionStatus::Done => ("\u{2705}", "Session finished"),
        SessionStatus::Error => ("\u{26A0}\u{FE0F}", "Session error"),
        SessionStatus::Idle | SessionStatus::Running => return None,
    };

    // Title carries the emoji + project (the "who needs you"); the session title
    // is its own tier so a long title never crowds the headline; the ask's own
    // words are the body, falling back to the event label when there are none.
    let title_line = format!("{emoji} {}", project.trim());
    let subtitle = title.trim().to_string();
    let ask_text = ask.map(|a| a.text.trim()).filter(|t| !t.is_empty());
    let body = ask_text.map_or_else(|| label.to_string(), ToString::to_string);

    Some(NotificationContent {
        title: title_line,
        subtitle,
        body,
    })
}

/// Decide whether to fire an OS notification for a committed status change, and
/// if so, what it should say — the whole notify policy behind one pure seam.
///
/// Composes the two tested pieces the Tauri shell used to string together inline
/// and untested: [`NotifyDecision::should_fire`] (the when) and
/// [`notification_content`] (the what). Returns `None` when the decision says
/// stay quiet *or* the target status carries no content.
///
/// `display` yields the `(project, title)` for the content and is only invoked
/// when the decision fires, so a caller that resolves it behind a lock (the
/// store lookup in `status_rt`) pays that cost only on the rare firing
/// transition, not on every quiet status change — while `should_fire` is still
/// evaluated exactly once, here.
#[must_use]
pub fn notification_plan(
    decision: &NotifyDecision,
    ask: Option<&PendingAsk>,
    display: impl FnOnce() -> (String, String),
) -> Option<NotificationContent> {
    if !decision.should_fire() {
        return None;
    }
    let (project, title) = display();
    notification_content(decision.next, ask, &project, &title)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::{AskKind, PendingAsk};
    use crate::session::SessionStatus;
    use crate::status::{NotifyDecision, NotifyPreference};

    fn ask(kind: AskKind, text: &str) -> PendingAsk {
        PendingAsk {
            kind,
            text: text.to_string(),
            asked_at: None,
        }
    }

    /// A decision that fires: an off-screen `running -> next` transition, no
    /// latch, preference All, never notified before.
    fn firing_decision(next: SessionStatus) -> NotifyDecision {
        NotifyDecision {
            prev: SessionStatus::Running,
            next,
            window_focused: false,
            active_is_this: false,
            already_unread: false,
            preference: NotifyPreference::All,
            secs_since_last_notify: None,
        }
    }

    /// A `display` closure yielding a fixed `(project, title)`.
    fn display(project: &str, title: &str) -> impl FnOnce() -> (String, String) {
        let (p, t) = (project.to_string(), title.to_string());
        move || (p, t)
    }

    /// A `display` closure that panics if called — proves the plan never
    /// resolves the (lock-held) display for a non-firing transition.
    fn never_display() -> (String, String) {
        panic!("display must not be resolved when the plan does not fire");
    }

    #[test]
    fn plan_fires_and_shapes_content_together() {
        let d = firing_decision(SessionStatus::Done);
        let c = notification_plan(&d, None, display("web", "Task")).expect("fires");
        assert_eq!(c.title, "\u{2705} web");
        assert_eq!(c.body, "Session finished");
    }

    #[test]
    fn plan_carries_the_ask_words_for_a_waiting_session() {
        let d = firing_decision(SessionStatus::Waiting);
        let a = ask(AskKind::Permission, "Allow Bash?");
        let c = notification_plan(&d, Some(&a), display("web", "Deploy")).expect("fires");
        assert_eq!(c.title, "\u{1F511} web");
        assert_eq!(c.body, "Allow Bash?");
    }

    #[test]
    fn plan_is_none_and_skips_display_when_the_decision_does_not_fire() {
        // Same attention transition, but the unread latch is already set: the
        // burst of Done<->Waiting at a turn's end must ping only once — and the
        // display (a lock-held store lookup in the caller) must not be resolved.
        let mut d = firing_decision(SessionStatus::Waiting);
        d.already_unread = true;
        assert_eq!(notification_plan(&d, None, never_display), None);
    }

    #[test]
    fn plan_is_none_when_on_screen() {
        let mut d = firing_decision(SessionStatus::Done);
        d.window_focused = true;
        d.active_is_this = true;
        assert_eq!(notification_plan(&d, None, never_display), None);
    }

    #[test]
    fn plan_is_none_when_preference_mutes_the_transition() {
        // OnlyBlocked mutes a Done finish (not a "blocked" state).
        let mut d = firing_decision(SessionStatus::Done);
        d.preference = NotifyPreference::OnlyBlocked;
        assert_eq!(notification_plan(&d, None, never_display), None);
    }

    #[test]
    fn plan_is_none_when_the_target_status_has_no_content() {
        // should_fire can pass for a transition into Idle/Running (e.g. a
        // configuration that allows it); the content shaper is the backstop.
        let d = firing_decision(SessionStatus::Running);
        assert_eq!(notification_plan(&d, None, display("web", "Task")), None);
    }

    #[test]
    fn waiting_question_uses_question_emoji_and_ask_text() {
        let a = ask(AskKind::Question, "Which migration strategy?");
        let c = notification_content(
            SessionStatus::Waiting,
            Some(&a),
            "auth-service",
            "Fix login flow",
        )
        .expect("attention state");
        assert_eq!(c.title, "\u{1F4AC} auth-service");
        assert_eq!(c.subtitle, "Fix login flow");
        assert_eq!(c.body, "Which migration strategy?");
    }

    #[test]
    fn waiting_permission_uses_key_emoji() {
        let a = ask(AskKind::Permission, "Allow Bash?");
        let c = notification_content(SessionStatus::Waiting, Some(&a), "web", "Deploy")
            .expect("attention state");
        assert_eq!(c.title, "\u{1F511} web");
        assert_eq!(c.subtitle, "Deploy");
        assert_eq!(c.body, "Allow Bash?");
    }

    #[test]
    fn waiting_plan_uses_clipboard_emoji() {
        let a = ask(AskKind::PlanApproval, "Approve plan: ship it");
        let c = notification_content(SessionStatus::Waiting, Some(&a), "web", "Plan")
            .expect("attention state");
        assert_eq!(c.title, "\u{1F4CB} web");
        assert_eq!(c.subtitle, "Plan");
        assert_eq!(c.body, "Approve plan: ship it");
    }

    #[test]
    fn waiting_without_ask_uses_hourglass_and_generic_body() {
        let c = notification_content(SessionStatus::Waiting, None, "web", "Task")
            .expect("attention state");
        assert_eq!(c.title, "\u{23F3} web");
        assert_eq!(c.subtitle, "Task");
        assert_eq!(c.body, "Needs your input");
    }

    #[test]
    fn done_uses_check_emoji() {
        let c = notification_content(SessionStatus::Done, None, "web", "Task")
            .expect("attention state");
        assert_eq!(c.title, "\u{2705} web");
        assert_eq!(c.subtitle, "Task");
        assert_eq!(c.body, "Session finished");
    }

    #[test]
    fn error_uses_warning_emoji() {
        let c = notification_content(SessionStatus::Error, None, "web", "Task")
            .expect("attention state");
        assert_eq!(c.title, "\u{26A0}\u{FE0F} web");
        assert_eq!(c.subtitle, "Task");
        assert_eq!(c.body, "Session error");
    }

    #[test]
    fn idle_and_running_have_no_content() {
        assert_eq!(
            notification_content(SessionStatus::Idle, None, "web", "T"),
            None
        );
        assert_eq!(
            notification_content(SessionStatus::Running, None, "web", "T"),
            None
        );
    }

    #[test]
    fn trims_project_title_and_ask_text() {
        let a = ask(AskKind::Question, "  spaced?  ");
        let c = notification_content(SessionStatus::Waiting, Some(&a), "  web  ", "  Task  ")
            .expect("attention state");
        assert_eq!(c.title, "\u{1F4AC} web");
        assert_eq!(c.subtitle, "Task");
        assert_eq!(c.body, "spaced?");
    }

    #[test]
    fn blank_ask_text_falls_back_to_label_only() {
        let a = ask(AskKind::Question, "   ");
        let c = notification_content(SessionStatus::Waiting, Some(&a), "web", "Task")
            .expect("attention state");
        assert_eq!(c.body, "Needs your input");
    }
}
