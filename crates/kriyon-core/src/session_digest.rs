//! A [Session digest]: what a remote device's Home shows of one session
//! beside its [Session list] entry (the question asked, the tool running,
//! since when, how the last turn ended, what it changed). Built only from
//! cheap sources the host already holds (the hooks' pending question and
//! current tool, the [Activity log]'s last turn, the companion's last reply),
//! never the transcript, and redacted and capped as the [Readable view] is.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::activity::ToolActivity;
use crate::readable::{cut, AskShown, STEP_MAX};
use crate::redact::redact;
use crate::session::SessionStatus;
use crate::transcript::{parse_line, StructuredEvent};

/// The most bytes of a question's text on Home.
pub const QUESTION_MAX: usize = 300;
/// The most bytes of a finished turn's summary.
pub const SUMMARY_MAX: usize = 200;
/// The most lines of a finished turn's summary.
const SUMMARY_LINES: usize = 2;

/// Claude's question while its dialog shows: its text and options, in order.
/// Inside a nested record and not nested itself, so it can't grow (spec §3).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Question {
    pub text: String,
    pub options: Vec<String>,
}

/// What a turn changed: files, and lines added and removed. Can't grow, as
/// [`Question`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Diff {
    pub files: u32,
    pub added: u64,
    pub removed: u64,
}

/// One file change of a turn, as the [Activity log] has it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub added: u64,
    pub removed: u64,
}

/// A session's last turn, as the [Activity log] has it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TurnFacts {
    pub started_ms: i64,
    pub ended: bool,
    /// What headed it when no person started it: a [Work report]'s summary.
    pub report: Option<String>,
    /// Its file changes.
    pub changes: Vec<FileChange>,
}

/// What the digest is built from.
#[derive(Clone, Copy, Debug)]
pub struct DigestFacts<'a> {
    pub status: SessionStatus,
    /// The question showing now (`readable::asking_now`).
    pub asking: Option<&'a AskShown>,
    /// The main agent's tool running now.
    pub current_tool: Option<&'a ToolActivity>,
    pub last_turn: Option<&'a TurnFacts>,
    /// Claude's last reply, from the companion ([`last_reply`]).
    pub last_reply: Option<&'a str>,
}

/// One session's [Session digest]. Every field is `None` when it doesn't
/// apply now or isn't known.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionDigest {
    /// While the dialog shows.
    pub question: Option<Question>,
    /// "<Tool> · <target>", while running.
    pub activity: Option<String>,
    /// When the running turn began (Unix ms).
    pub running_since_ms: Option<i64>,
    /// How the last turn ended, in a line or two, once it has.
    pub turn_summary: Option<String>,
    /// What the last turn changed, once it ended; `None` when nothing.
    pub diff: Option<Diff>,
}

/// The [Session digest] of `facts`.
#[must_use]
pub fn digest(facts: &DigestFacts<'_>) -> SessionDigest {
    let running = facts.status == SessionStatus::Running;
    let ended = facts.last_turn.filter(|turn| turn.ended && !running);
    SessionDigest {
        question: facts.asking.map(|ask| Question {
            text: cut(&redact(&ask.question), QUESTION_MAX),
            options: ask.options.iter().map(|option| redact(option)).collect(),
        }),
        activity: facts.current_tool.filter(|_| running).map(activity_line),
        running_since_ms: facts
            .last_turn
            .filter(|turn| running && !turn.ended)
            .map(|turn| turn.started_ms),
        turn_summary: ended.and_then(|turn| {
            facts
                .last_reply
                .or(turn.report.as_deref())
                .map(summary_line)
                .filter(|line| !line.is_empty())
        }),
        diff: ended.and_then(|turn| diff_of(&turn.changes)),
    }
}

/// "Bash · pnpm test", redacted and capped as a step is.
fn activity_line(tool: &ToolActivity) -> String {
    let line = match tool.target.as_deref().map(str::trim) {
        Some(target) if !target.is_empty() => format!("{} · {target}", tool.tool_name),
        _ => tool.tool_name.clone(),
    };
    cut(&redact(&line), STEP_MAX)
}

/// A text's first lines that say something, redacted and capped.
fn summary_line(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(SUMMARY_LINES)
        .collect();
    cut(&redact(&lines.join("\n")), SUMMARY_MAX)
}

/// The totals of a turn's file changes; `None` when it changed nothing.
fn diff_of(changes: &[FileChange]) -> Option<Diff> {
    let files: HashSet<&str> = changes.iter().map(|change| change.path.as_str()).collect();
    let diff = Diff {
        files: u32::try_from(files.len()).unwrap_or(u32::MAX),
        added: changes.iter().map(|change| change.added).sum(),
        removed: changes.iter().map(|change| change.removed).sum(),
    };
    (diff.files > 0).then_some(diff)
}

/// Claude's last reply in the companion's rows (oldest first): the newest
/// prose it wrote. Only the rows' tail need be passed.
#[must_use]
pub fn last_reply(rows: &[&str]) -> Option<String> {
    rows.iter().rev().find_map(|row| {
        parse_line(row)
            .into_iter()
            .rev()
            .find_map(|event| match event {
                StructuredEvent::Assistant { text } if !text.trim().is_empty() => Some(text),
                _ => None,
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, target: Option<&str>) -> ToolActivity {
        ToolActivity {
            tool_name: name.into(),
            target: target.map(Into::into),
            started_at: None,
        }
    }

    fn facts(status: SessionStatus) -> DigestFacts<'static> {
        DigestFacts {
            status,
            asking: None,
            current_tool: None,
            last_turn: None,
            last_reply: None,
        }
    }

    fn change(path: &str, added: u64, removed: u64) -> FileChange {
        FileChange {
            path: path.into(),
            added,
            removed,
        }
    }

    #[test]
    fn a_running_turn_says_its_tool_and_since_when() {
        let bash = tool("Bash", Some("pnpm test"));
        let turn = TurnFacts {
            started_ms: 1_000,
            ..TurnFacts::default()
        };
        let running = digest(&DigestFacts {
            current_tool: Some(&bash),
            last_turn: Some(&turn),
            ..facts(SessionStatus::Running)
        });
        assert_eq!(running.activity.as_deref(), Some("Bash · pnpm test"));
        assert_eq!(running.running_since_ms, Some(1_000));
        assert_eq!(running.turn_summary, None);
        assert_eq!(running.diff, None);
        // A tool without a target is its name; nothing runs while waiting.
        let think = tool("Think", None);
        let named = digest(&DigestFacts {
            current_tool: Some(&think),
            ..facts(SessionStatus::Running)
        });
        assert_eq!(named.activity.as_deref(), Some("Think"));
        let waiting = digest(&DigestFacts {
            current_tool: Some(&bash),
            last_turn: Some(&turn),
            ..facts(SessionStatus::Waiting)
        });
        assert_eq!(waiting.activity, None);
        assert_eq!(waiting.running_since_ms, None);
    }

    #[test]
    fn a_question_shows_its_text_and_options_in_order_redacted() {
        let ask = AskShown {
            header: "Database".into(),
            question: "Use key sk-ant-abcdefghijklmnop?".into(),
            options: vec!["Postgres".into(), "SQLite".into()],
            asked_at: None,
        };
        let shown = digest(&DigestFacts {
            asking: Some(&ask),
            ..facts(SessionStatus::Waiting)
        });
        let question = shown.question.expect("asked");
        assert!(
            !question.text.contains("sk-ant-abcdefghijklmnop"),
            "{question:?}"
        );
        assert_eq!(question.options, vec!["Postgres", "SQLite"]);
        assert_eq!(digest(&facts(SessionStatus::Waiting)).question, None);
    }

    #[test]
    fn a_finished_turn_says_how_it_ended_and_what_it_changed() {
        let turn = TurnFacts {
            started_ms: 1,
            ended: true,
            report: Some("Agent \"Review\" finished".into()),
            changes: vec![
                change("src/a.ts", 10, 2),
                change("src/a.ts", 3, 1),
                change("src/b.ts", 4, 0),
            ],
        };
        let reply = "\nFixed the login bug.\n\nThe form now waits.\nThird line.";
        let done = digest(&DigestFacts {
            last_turn: Some(&turn),
            last_reply: Some(reply),
            ..facts(SessionStatus::Done)
        });
        assert_eq!(
            done.turn_summary.as_deref(),
            Some("Fixed the login bug.\nThe form now waits.")
        );
        assert_eq!(
            done.diff,
            Some(Diff {
                files: 2,
                added: 17,
                removed: 3
            })
        );
        assert_eq!(done.running_since_ms, None);
        // No reply: the report's summary; nothing changed: no diff.
        let quiet = TurnFacts {
            changes: vec![],
            ..turn
        };
        let reported = digest(&DigestFacts {
            last_turn: Some(&quiet),
            ..facts(SessionStatus::Idle)
        });
        assert_eq!(
            reported.turn_summary.as_deref(),
            Some("Agent \"Review\" finished")
        );
        assert_eq!(reported.diff, None);
    }

    #[test]
    fn long_texts_are_cut() {
        let ask = AskShown {
            header: String::new(),
            question: "q".repeat(5_000),
            options: vec![],
            asked_at: None,
        };
        let turn = TurnFacts {
            ended: true,
            ..TurnFacts::default()
        };
        let long_reply = "r".repeat(5_000);
        let long_target = "t".repeat(5_000);
        let bash = tool("Bash", Some(&long_target));
        let shown = digest(&DigestFacts {
            asking: Some(&ask),
            last_turn: Some(&turn),
            last_reply: Some(&long_reply),
            ..facts(SessionStatus::Idle)
        });
        assert!(shown.question.expect("asked").text.len() <= QUESTION_MAX);
        assert!(shown.turn_summary.expect("summary").len() <= SUMMARY_MAX);
        let running = digest(&DigestFacts {
            current_tool: Some(&bash),
            ..facts(SessionStatus::Running)
        });
        assert!(running.activity.expect("tool").len() <= STEP_MAX);
    }

    #[test]
    fn the_last_reply_is_the_newest_prose_in_the_rows() {
        let rows = [
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"First."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Last."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#,
            "not json",
        ];
        assert_eq!(last_reply(&rows).as_deref(), Some("Last."));
        assert_eq!(last_reply(&[]), None);
    }
}
