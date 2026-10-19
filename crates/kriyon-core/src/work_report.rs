//! A [Work report]: what Claude Code tells the main agent when a piece of
//! [In-flight work] finishes, fails, stops or emits a monitor event. It arrives
//! as a `user` row of `<task-notification>` blocks that no person typed, so the
//! [Structured view] shows it as a line of its own, never as a prompt.

use serde::Serialize;

/// The tag Claude Code wraps each report in.
const OPEN: &str = "<task-notification>";
const CLOSE: &str = "</task-notification>";

/// The preface newer builds put before the blocks, telling the model no
/// person wrote them.
const PREFACE: &str = "[SYSTEM NOTIFICATION";

/// The `origin.kind` Claude Code stamps on a report's row.
pub const ORIGIN: &str = "task-notification";

/// The `origin.kind` of a message another agent sent the main agent: a
/// [Subagent] handing back its final report, or another Claude session.
pub const PEER_ORIGIN: &str = "peer";

/// What a subagent's hand-back says of itself, after the sender's tag.
const HANDBACK: &str = "[Subagent hand-back]";

/// How a hand-back's summary ends.
const HANDBACK_SUMMARY: &str = " reported back";

/// How the work a report is about came out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReportOutcome {
    Completed,
    Failed,
    /// Stopped or killed before it finished.
    Stopped,
    /// A monitor saw something; the work goes on.
    Event,
    /// Anything else (an outcome a newer build added).
    Update,
}

/// One [Work report], reduced to what the view shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkReport {
    /// Claude Code's one-line summary: `Agent "Review" finished`.
    pub summary: String,
    pub outcome: ReportOutcome,
    /// What a monitor saw, for an [`ReportOutcome::Event`].
    pub event: Option<String>,
}

/// The reports a prompt's text carries, or `None` when the text is not
/// reports only: a person's prompt that quotes one stays a prompt.
#[must_use]
pub fn parse(text: &str) -> Option<Vec<WorkReport>> {
    let mut rest = text.trim();
    if rest.starts_with(PREFACE) {
        rest = &rest[rest.find(OPEN)?..];
    }
    let mut reports = Vec::new();
    while !rest.is_empty() {
        let body = rest.strip_prefix(OPEN)?;
        let (inside, after) = body.split_once(CLOSE).unwrap_or((body, ""));
        reports.push(report(inside));
        rest = after.trim_start();
    }
    (!reports.is_empty()).then_some(reports)
}

fn report(inside: &str) -> WorkReport {
    let event = field(inside, "event");
    let outcome = match field(inside, "status").as_deref() {
        Some("completed") => ReportOutcome::Completed,
        Some("failed") => ReportOutcome::Failed,
        Some("stopped" | "killed") => ReportOutcome::Stopped,
        _ if event.is_some() => ReportOutcome::Event,
        _ => ReportOutcome::Update,
    };
    WorkReport {
        summary: field(inside, "summary").unwrap_or_else(|| "Background work reported".into()),
        outcome,
        event,
    }
}

/// The agent id a peer message names as its sender
/// (`<agent-message from="…">`).
#[must_use]
pub fn peer_sender(text: &str) -> Option<&str> {
    crate::transcript::between(text, "<agent-message from=\"", "\"").filter(|id| !id.is_empty())
}

/// The report a peer message reads as: a subagent handing back, named by
/// what Claude called it when it launched it (`agent`) when that is known,
/// or another Claude session's message.
#[must_use]
pub fn from_peer(text: &str, agent: Option<&str>) -> WorkReport {
    if !text.contains(HANDBACK) {
        return WorkReport {
            summary: "Another Claude session sent a message".into(),
            outcome: ReportOutcome::Update,
            event: None,
        };
    }
    WorkReport {
        summary: agent.map_or_else(
            || format!("A subagent{HANDBACK_SUMMARY}"),
            |name| format!("Agent \"{name}\"{HANDBACK_SUMMARY}"),
        ),
        outcome: ReportOutcome::Completed,
        event: None,
    }
}

/// Drop a hand-back that only echoes another report of the same turn: Claude
/// Code may also send its own `Agent "…" finished` for that agent.
pub fn drop_echoed_handbacks(reports: &mut Vec<WorkReport>) {
    let named = |report: &WorkReport| {
        crate::transcript::between(&report.summary, "\"", "\"").map(str::to_string)
    };
    let others: Vec<Option<String>> = reports
        .iter()
        .map(|r| (!is_handback(r)).then(|| named(r)).flatten())
        .collect();
    reports.retain(|r| !is_handback(r) || named(r).is_none() || !others.contains(&named(r)));
}

fn is_handback(report: &WorkReport) -> bool {
    report.summary.ends_with(HANDBACK_SUMMARY)
}

/// The trimmed, non-blank text of the first `<tag>…</tag>`.
fn field(inside: &str, tag: &str) -> Option<String> {
    crate::transcript::between(inside, &format!("<{tag}>"), &format!("</{tag}>"))
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHELL: &str = "<task-notification>\n<task-id>bc1a9h969</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Background command \"Watch the nightly run until it finishes\" completed (exit code 0)</summary>\n</task-notification>";

    #[test]
    fn a_finished_shell_reads_as_its_summary() {
        assert_eq!(
            parse(SHELL),
            Some(vec![WorkReport {
                summary: "Background command \"Watch the nightly run until it finishes\" completed (exit code 0)".into(),
                outcome: ReportOutcome::Completed,
                event: None,
            }])
        );
    }

    #[test]
    fn the_preface_newer_builds_add_is_skipped() {
        let text = format!(
            "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n\n{SHELL}"
        );
        assert_eq!(parse(&text).map(|r| r.len()), Some(1));
    }

    #[test]
    fn each_outcome_is_named() {
        let outcome = |status: &str| {
            parse(&format!(
                "{OPEN}<status>{status}</status><summary>s</summary>{CLOSE}"
            ))
            .map(|r| r[0].outcome)
        };
        assert_eq!(outcome("failed"), Some(ReportOutcome::Failed));
        assert_eq!(outcome("stopped"), Some(ReportOutcome::Stopped));
        assert_eq!(outcome("killed"), Some(ReportOutcome::Stopped));
        assert_eq!(outcome("paused"), Some(ReportOutcome::Update));
    }

    #[test]
    fn a_monitor_event_keeps_what_it_saw() {
        let text = format!(
            "{OPEN}\n<task-id>b7</task-id>\n<summary>Monitor event: \"iPhone build\"</summary>\n<event>- Installing CocoaPods...</event>\nIf this event matters, notify.\n{CLOSE}"
        );
        let reports = parse(&text).expect("a report");
        assert_eq!(reports[0].outcome, ReportOutcome::Event);
        assert_eq!(
            reports[0].event.as_deref(),
            Some("- Installing CocoaPods...")
        );
    }

    #[test]
    fn several_reports_in_one_row_are_all_kept() {
        let text = format!("{SHELL}\n{SHELL}");
        assert_eq!(parse(&text).map(|r| r.len()), Some(2));
    }

    #[test]
    fn a_message_from_another_session_is_not_a_handback() {
        let text = "Another Claude session sent a message:\n<agent-message from=\"s1\">\nhi\n</agent-message>";
        assert_eq!(peer_sender(text), Some("s1"));
        let report = from_peer(text, None);
        assert_eq!(report.summary, "Another Claude session sent a message");
        assert_eq!(report.outcome, ReportOutcome::Update);
    }

    #[test]
    fn a_handback_echoing_its_finished_report_is_dropped() {
        let handback = from_peer(&format!("{HANDBACK} …"), Some("Review"));
        let finished = parse(&format!(
            "{OPEN}<status>completed</status><summary>Agent \"Review\" finished</summary>{CLOSE}"
        ))
        .expect("a report")
        .remove(0);
        let other = from_peer(&format!("{HANDBACK} …"), Some("Scan"));
        let mut reports = vec![handback, finished.clone(), other.clone()];
        drop_echoed_handbacks(&mut reports);
        assert_eq!(reports, vec![finished, other]);
    }

    #[test]
    fn a_prompt_that_quotes_a_report_is_not_one() {
        assert_eq!(parse(&format!("Look at this:\n{SHELL}")), None);
        assert_eq!(parse(&format!("{SHELL}\nwhy did it do that?")), None);
        assert_eq!(parse("fix the bug"), None);
    }
}
