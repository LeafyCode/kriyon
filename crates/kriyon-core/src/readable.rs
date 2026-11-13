//! The [Readable view]: a session as entries for a [Remote device] (spec §6,
//! "Readable view"), folded from what the [Structured view] shows.
//!
//! Pure: the host hands in the turns, the live [Partial reply] and the
//! question showing, and gets back keyed entries, trimmed and redacted. The
//! keys stay the same as a turn grows, so the host can send only what is new
//! or changed.

use serde::{Deserialize, Serialize};

use crate::redact::redact;
use crate::structured::{PartialReply, StructuredTurn, TurnItem};
use crate::work_report::{ReportOutcome, WorkReport};

/// The most entries kept: the newest ones.
pub const WINDOW: usize = 200;
/// The key of the note at the window's start when older entries were left
/// out.
pub const OLDER_KEY: &str = "older";
/// The most bytes of a prompt.
pub const YOU_MAX: usize = 1024;
/// The most bytes of one text of Claude's: the start, then "…".
pub const CLAUDE_MAX: usize = 4096;
/// The most bytes of a step's name and target together.
pub const STEP_MAX: usize = 160;
/// The most bytes of a report's summary and outcome together.
pub const REPORT_MAX: usize = 512;
/// The most options of a question, and the most bytes of each.
pub const ASK_OPTIONS: usize = 8;
pub const ASK_OPTION_MAX: usize = 80;
/// The most bytes of a question's header, and of the question.
pub const ASK_HEADER_MAX: usize = 80;
pub const ASK_QUESTION_MAX: usize = 300;

/// The most characters of a block the companion streams; a longer one comes
/// cut there, with "…" after (`companion.js` `cap`).
const STREAM_CAP: usize = 20_000;
const CUT_MARK: char = '…';

/// Where a step is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum StepState {
    Running,
    Done,
    Failed,
}

/// What one entry shows. Variant order is the wire's tags: append only.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EntryKind {
    /// The person's prompt.
    You { text: String },
    /// A text of Claude's; `done` once nothing more will be added to it.
    Claude { text: String, done: bool },
    /// One tool call.
    Step {
        name: String,
        target: String,
        state: StepState,
    },
    /// A [Work report].
    Report { summary: String, outcome: String },
    /// Claude's question dialog is showing: answered only in the terminal.
    Asking {
        header: String,
        question: String,
        options: Vec<String>,
    },
    /// Context compacted, a turn interrupted, a question answered.
    Note { text: String },
}

/// An entry and its key: the same thing keeps the same key as the turns
/// grow, so the host sends only what is new or changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keyed {
    pub key: String,
    pub kind: EntryKind,
}

/// Claude's question showing now, from the hook's pending question.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskShown {
    pub header: String,
    pub question: String,
    pub options: Vec<String>,
    /// When it was asked (the hook's timestamp): tells two questions apart.
    pub asked_at: Option<String>,
}

/// The entries for `turns` (oldest first), the live `partial` reply and the
/// question showing, if any: the newest [`WINDOW`], every text redacted and
/// trimmed, after a note that older ones are in the terminal when some were
/// left out. Thoughts are left out.
#[must_use]
pub fn entries(
    turns: &[StructuredTurn],
    partial: Option<&PartialReply>,
    asking: Option<&AskShown>,
) -> Vec<Keyed> {
    let mut out = Vec::new();
    for (index, turn) in turns.iter().enumerate() {
        let newest = index + 1 == turns.len();
        let live = partial.filter(|partial| newest && is_live(partial, turn));
        turn_entries(&mut out, turn, &turn_key(turn, index), live);
    }
    if turns.is_empty() {
        if let Some(partial) = partial.filter(|partial| !partial.text.trim().is_empty()) {
            out.push(claude("partial".into(), &partial.text, false));
        }
    }
    if let Some(ask) = asking {
        out.push(Keyed {
            key: format!("ask:{}", ask.asked_at.as_deref().unwrap_or_default()),
            kind: EntryKind::Asking {
                header: cut(&redact(&ask.header), ASK_HEADER_MAX),
                question: cut(&redact(&ask.question), ASK_QUESTION_MAX),
                options: ask
                    .options
                    .iter()
                    .take(ASK_OPTIONS)
                    .map(|option| cut(&redact(option), ASK_OPTION_MAX))
                    .collect(),
            },
        });
    }
    let extra = out.len().saturating_sub(WINDOW);
    if extra > 0 {
        out.splice(..extra, [note(OLDER_KEY.into(), "Older in the terminal")]);
    }
    out
}

/// A turn's key: when it started, which never changes; its place in the
/// list only for a turn with no time.
fn turn_key(turn: &StructuredTurn, index: usize) -> String {
    turn.started_ms
        .map_or_else(|| format!("i{index}"), |ms| format!("t{ms}"))
}

fn turn_entries(
    out: &mut Vec<Keyed>,
    turn: &StructuredTurn,
    key: &str,
    live: Option<&PartialReply>,
) {
    if let Some(prompt) = &turn.prompt {
        out.push(Keyed {
            key: format!("{key}:you"),
            kind: EntryKind::You {
                text: cut(&redact(prompt), YOU_MAX),
            },
        });
    }
    for (n, report) in turn.reports.iter().enumerate() {
        out.push(Keyed {
            key: format!("{key}:report:{n}"),
            kind: report_kind(report),
        });
    }
    // Texts are keyed by their place among the turn's texts (the reply is
    // the last one): a text moves between `did` and `reply` as the turn goes
    // on, but never changes its place among the texts.
    let texts = turn
        .did
        .iter()
        .filter(|item| matches!(item, TurnItem::Text { .. }))
        .count()
        + usize::from(turn.reply.is_some());
    // A text something came after is done; the reply only once the turn
    // ended or another text streams after it.
    let reply_done = turn.ended || live.is_some();
    let mut nth = 0;
    let mut text_entry = |out: &mut Vec<Keyed>, text: &str, done: bool| {
        out.push(claude(format!("{key}:text:{nth}"), text, done));
        nth += 1;
    };
    for (n, item) in turn.did.iter().enumerate() {
        match item {
            TurnItem::Text { text } => text_entry(out, text, true),
            TurnItem::Step {
                id,
                name,
                target,
                result,
                is_error,
                ..
            } => out.push(Keyed {
                key: format!("step:{id}"),
                kind: step_kind(
                    name,
                    target.as_deref(),
                    *is_error,
                    result.is_some() || turn.ended,
                ),
            }),
            TurnItem::Thought { .. } => {}
            TurnItem::Compacted => out.push(note(format!("{key}:note:{n}"), "Context compacted")),
        }
    }
    if let Some(reply) = &turn.reply {
        text_entry(out, reply, reply_done);
    }
    if let Some(partial) = live {
        out.push(claude(format!("{key}:text:{texts}"), &partial.text, false));
    }
    if turn.interrupted {
        out.push(note(format!("{key}:interrupted"), "Interrupted"));
    }
}

/// Whether a [Partial reply] still shows under `turn`, the newest: it came
/// after the turn's prompt and the turn hasn't kept its text yet.
fn is_live(partial: &PartialReply, turn: &StructuredTurn) -> bool {
    if partial.text.trim().is_empty() {
        return false;
    }
    if turn
        .started_ms
        .is_some_and(|started| partial.received_ms < started)
    {
        return false;
    }
    let kept = turn
        .reply
        .iter()
        .chain(turn.did.iter().filter_map(|item| match item {
            TurnItem::Text { text } => Some(text),
            _ => None,
        }));
    !kept.into_iter().any(|text| is_kept(&partial.text, text))
}

/// Whether `streamed` is the text the turn kept as `text`. A streamed block
/// that was cut short is matched by the part that was sent.
fn is_kept(streamed: &str, text: &str) -> bool {
    let sent: String = streamed.chars().take(STREAM_CAP).collect();
    let was_cut = streamed.chars().count() == STREAM_CAP + 1 && streamed.ends_with(CUT_MARK);
    if was_cut {
        text.starts_with(&sent)
    } else {
        text.trim() == streamed.trim()
    }
}

fn claude(key: String, text: &str, done: bool) -> Keyed {
    Keyed {
        key,
        kind: EntryKind::Claude {
            text: cut(&redact(text), CLAUDE_MAX),
            done,
        },
    }
}

fn note(key: String, text: &str) -> Keyed {
    Keyed {
        key,
        kind: EntryKind::Note { text: text.into() },
    }
}

fn step_kind(name: &str, target: Option<&str>, is_error: bool, finished: bool) -> EntryKind {
    let name = cut(&redact(name), STEP_MAX / 2);
    let target = cut(&redact(target.unwrap_or_default()), STEP_MAX - name.len());
    let state = if is_error {
        StepState::Failed
    } else if finished {
        StepState::Done
    } else {
        StepState::Running
    };
    EntryKind::Step {
        name,
        target,
        state,
    }
}

fn report_kind(report: &WorkReport) -> EntryKind {
    let outcome = match report.outcome {
        ReportOutcome::Completed => "Finished".to_string(),
        ReportOutcome::Failed => "Failed".to_string(),
        ReportOutcome::Stopped => "Stopped".to_string(),
        ReportOutcome::Event => report.event.clone().unwrap_or_else(|| "Event".into()),
        ReportOutcome::Update => "Update".to_string(),
    };
    let outcome = cut(&redact(&outcome), REPORT_MAX / 4);
    EntryKind::Report {
        summary: cut(&redact(&report.summary), REPORT_MAX - outcome.len()),
        outcome,
    }
}

/// `text` in at most `max` bytes: whole if it fits, else its start cut on a
/// character boundary, then "…".
#[must_use]
pub fn cut(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let room = max.saturating_sub(CUT_MARK.len_utf8());
    let end = (0..=room)
        .rev()
        .find(|&at| text.is_char_boundary(at))
        .unwrap_or_default();
    let mut out = text[..end].to_string();
    out.push(CUT_MARK);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity_log::StepKind;
    use crate::structured::{PartialReply, StructuredTurn, TurnItem, TurnSource};

    fn turn(started_ms: i64, prompt: &str) -> StructuredTurn {
        StructuredTurn {
            prompt: Some(prompt.into()),
            reports: Vec::new(),
            did: Vec::new(),
            reply: None,
            source: TurnSource::Live,
            interrupted: false,
            ended: false,
            images: Vec::new(),
            started_ms: Some(started_ms),
            ended_ms: Some(started_ms),
        }
    }

    fn text(text: &str) -> TurnItem {
        TurnItem::Text { text: text.into() }
    }

    fn step(id: &str, result: Option<&str>, is_error: bool) -> TurnItem {
        TurnItem::Step {
            id: id.into(),
            name: "Bash".into(),
            kind: StepKind::Command,
            input: "{}".into(),
            target: Some("cargo test".into()),
            description: None,
            result: result.map(Into::into),
            is_error,
        }
    }

    fn partial(text: &str, received_ms: i64) -> PartialReply {
        PartialReply {
            turn_id: "t".into(),
            step: 0,
            block: 0,
            text: text.into(),
            done: false,
            received_ms,
        }
    }

    fn kinds(entries: &[Keyed]) -> Vec<&EntryKind> {
        entries.iter().map(|entry| &entry.kind).collect()
    }

    #[test]
    fn a_turn_is_the_prompt_its_steps_and_the_reply_without_thoughts() {
        let mut t = turn(10, "Fix it");
        t.did = vec![
            text("Looking."),
            TurnItem::Thought {
                duration_ms: Some(12_000),
            },
            step("s1", Some("ok"), false),
            step("s2", None, false),
            step("s3", Some("boom"), true),
        ];
        // Still running: the newest text isn't done, nor is the open step.
        t.reply = Some("Fixed.".into());
        let entries = entries(&[t], None, None);
        assert_eq!(
            kinds(&entries),
            vec![
                &EntryKind::You {
                    text: "Fix it".into()
                },
                &EntryKind::Claude {
                    text: "Looking.".into(),
                    done: true
                },
                &EntryKind::Step {
                    name: "Bash".into(),
                    target: "cargo test".into(),
                    state: StepState::Done
                },
                &EntryKind::Step {
                    name: "Bash".into(),
                    target: "cargo test".into(),
                    state: StepState::Running
                },
                &EntryKind::Step {
                    name: "Bash".into(),
                    target: "cargo test".into(),
                    state: StepState::Failed
                },
                &EntryKind::Claude {
                    text: "Fixed.".into(),
                    done: false
                },
            ]
        );
    }

    #[test]
    fn a_text_something_came_after_is_done_and_the_reply_is_while_more_streams() {
        let mut t = turn(10, "Go");
        t.did = vec![text("Looking."), step("s1", None, false)];
        let built = entries(std::slice::from_ref(&t), None, None);
        assert_eq!(
            built[1].kind,
            EntryKind::Claude {
                text: "Looking.".into(),
                done: true
            }
        );
        t.did = Vec::new();
        t.reply = Some("First.".into());
        let streaming = entries(&[t], Some(&partial("Second", 20)), None);
        assert_eq!(
            streaming[1].kind,
            EntryKind::Claude {
                text: "First.".into(),
                done: true
            },
            "a text streams after it"
        );
    }

    #[test]
    fn keys_stay_put_as_a_turn_grows() {
        // Running: the newest text is the reply; then a step follows it and
        // the text moves back into what Claude did. Its key must not change.
        let mut early = turn(10, "Go");
        early.reply = Some("First.".into());
        let mut later = turn(10, "Go");
        later.did = vec![text("First."), step("s1", None, false)];
        later.reply = Some("Second.".into());
        let before = entries(&[early], None, None);
        let after = entries(&[later], None, None);
        assert_eq!(before[1].key, after[1].key);
        assert_ne!(after[1].key, after[3].key);
        assert_eq!(after[2].key, "step:s1");
    }

    #[test]
    fn a_streaming_reply_takes_the_place_its_kept_text_will_have() {
        let t = turn(10, "Go");
        let streaming = entries(std::slice::from_ref(&t), Some(&partial("Half", 20)), None);
        assert_eq!(
            streaming[1].kind,
            EntryKind::Claude {
                text: "Half".into(),
                done: false
            }
        );
        let mut kept = t;
        kept.reply = Some("Half done.".into());
        let landed = entries(&[kept.clone()], Some(&partial("Half done.", 20)), None);
        assert_eq!(landed.len(), 2, "the kept text, not the partial again");
        assert_eq!(streaming[1].key, landed[1].key);
        // A partial from before the newest prompt is the old turn's: left out.
        assert_eq!(entries(&[kept], Some(&partial("Stale", 5)), None).len(), 2);
    }

    #[test]
    fn reports_compactions_and_an_interrupt_are_shown() {
        let mut t = turn(10, "Go");
        t.prompt = None;
        t.reports = vec![crate::work_report::WorkReport {
            summary: "Agent \"Review\" finished".into(),
            outcome: crate::work_report::ReportOutcome::Completed,
            event: None,
            task_id: None,
            handback: false,
        }];
        t.did = vec![TurnItem::Compacted];
        t.interrupted = true;
        let entries = entries(&[t], None, None);
        assert_eq!(
            kinds(&entries),
            vec![
                &EntryKind::Report {
                    summary: "Agent \"Review\" finished".into(),
                    outcome: "Finished".into()
                },
                &EntryKind::Note {
                    text: "Context compacted".into()
                },
                &EntryKind::Note {
                    text: "Interrupted".into()
                },
            ]
        );
    }

    #[test]
    fn a_question_showing_comes_last_keyed_by_when_it_was_asked() {
        let ask = AskShown {
            header: "Database".into(),
            question: "Which db?".into(),
            options: vec!["Postgres".into(), "SQLite".into()],
            asked_at: Some("2026-11-14T10:00:00Z".into()),
        };
        let entries = entries(&[turn(10, "Go")], None, Some(&ask));
        let last = entries.last().expect("an entry");
        assert_eq!(
            last.kind,
            EntryKind::Asking {
                header: "Database".into(),
                question: "Which db?".into(),
                options: vec!["Postgres".into(), "SQLite".into()],
            }
        );
        assert!(last.key.starts_with("ask:"), "{}", last.key);
    }

    #[test]
    fn every_text_is_redacted_and_trimmed_on_a_character_boundary() {
        let mut t = turn(10, "my key is sk-ant-abcdefghijklmnop");
        t.reply = Some("é".repeat(CLAUDE_MAX));
        t.ended = true;
        let entries = entries(&[t], None, None);
        let EntryKind::You { text } = &entries[0].kind else {
            panic!("the prompt");
        };
        assert!(!text.contains("sk-ant-abcdefghijklmnop"), "{text}");
        assert!(text.contains("[REDACTED]"), "{text}");
        let EntryKind::Claude { text, .. } = &entries[1].kind else {
            panic!("the reply");
        };
        assert!(text.len() <= CLAUDE_MAX, "{}", text.len());
        assert!(text.ends_with('…'));
    }

    #[test]
    fn only_the_newest_window_of_entries_is_kept() {
        let turns: Vec<StructuredTurn> = (0..i64::try_from(WINDOW).expect("small"))
            .map(|n| {
                let mut t = turn(n, "Go");
                t.reply = Some("Done.".into());
                t.ended = true;
                t
            })
            .collect();
        let entries = entries(&turns, None, None);
        assert_eq!(entries.len(), WINDOW + 1);
        assert_eq!(
            entries[0],
            Keyed {
                key: OLDER_KEY.into(),
                kind: EntryKind::Note {
                    text: "Older in the terminal".into()
                }
            }
        );
        assert_eq!(
            entries.last().map(|entry| &entry.kind),
            Some(&EntryKind::Claude {
                text: "Done.".into(),
                done: true
            })
        );
    }
}
