//! What each [Session digest] is built from, kept where the session list
//! can read it every tick without IO: the main agent's tool running now (as
//! the watcher last said) and the [Activity log]'s last turn with Claude's
//! last reply, read again only when the log says the session worked since.

use std::collections::HashMap;

use kriyon_core::activity::ToolActivity;
use kriyon_core::activity_log::StepKind;
use kriyon_core::session::SessionId;
use kriyon_core::session_digest::{last_reply, FileChange, TurnFacts};
use parking_lot::Mutex;

use crate::activity_store::ActivityTurn;

/// How many of the companion's newest rows are looked through for Claude's
/// last reply.
const REPLY_ROWS: i64 = 40;

/// A session's last turn as last read, and when the log had seen it work.
#[derive(Clone, Debug, Default)]
struct ReadTurn {
    last_active_ms: Option<i64>,
    turn: Option<TurnFacts>,
    reply: Option<String>,
}

/// The digests' sources, by session.
#[derive(Debug, Default)]
pub struct DigestSources {
    tools: Mutex<HashMap<SessionId, ToolActivity>>,
    turns: Mutex<HashMap<String, ReadTurn>>,
}

impl DigestSources {
    /// The watcher's latest word on session `id`'s running tool.
    pub fn note_tool(&self, id: &SessionId, tool: Option<ToolActivity>) {
        let mut tools = self.tools.lock();
        match tool {
            Some(tool) => {
                tools.insert(id.clone(), tool);
            }
            None => {
                tools.remove(id);
            }
        }
    }

    /// Session `id`'s running tool, as the watcher last said.
    #[must_use]
    pub fn tool(&self, id: &SessionId) -> Option<ToolActivity> {
        self.tools.lock().get(id).cloned()
    }

    /// Session `id`'s last turn and Claude's last reply: read from the
    /// [Activity log] only when `last_active_ms` moved since the last read.
    pub fn last_turn(
        &self,
        id: &str,
        last_active_ms: Option<i64>,
    ) -> (Option<TurnFacts>, Option<String>) {
        self.last_turn_with(id, last_active_ms, || {
            let turn = crate::activity_rt::last_turn(id).map(|turn| turn_facts(&turn));
            // The reply only matters once the turn is over.
            let reply = turn.as_ref().filter(|turn| turn.ended).and_then(|_| {
                let rows = crate::activity_rt::bridge_tail(id, REPLY_ROWS);
                let rows: Vec<&str> = rows.iter().map(String::as_str).collect();
                last_reply(&rows)
            });
            (turn, reply)
        })
    }

    fn last_turn_with(
        &self,
        id: &str,
        last_active_ms: Option<i64>,
        read: impl FnOnce() -> (Option<TurnFacts>, Option<String>),
    ) -> (Option<TurnFacts>, Option<String>) {
        if let Some(read) = self.turns.lock().get(id) {
            if read.last_active_ms == last_active_ms {
                return (read.turn.clone(), read.reply.clone());
            }
        }
        let (turn, reply) = read();
        self.turns.lock().insert(
            id.to_string(),
            ReadTurn {
                last_active_ms,
                turn: turn.clone(),
                reply: reply.clone(),
            },
        );
        (turn, reply)
    }

    /// Forget session `id` (it closed).
    pub fn forget(&self, id: &SessionId) {
        self.tools.lock().remove(id);
        self.turns.lock().remove(&id.0);
    }
}

/// An [Activity log] turn as the digest reads it: the main agent's file
/// changes, each file once per change (a command's lines go on its first).
fn turn_facts(turn: &ActivityTurn) -> TurnFacts {
    let mut changes = Vec::new();
    for step in turn.steps.iter().filter(|step| step.agent_id.is_none()) {
        if step.lines_added.is_none() && step.lines_removed.is_none() {
            continue;
        }
        let count = |lines: Option<i64>| lines.and_then(|n| u64::try_from(n).ok()).unwrap_or(0);
        let paths: Vec<&str> = if step.changed_files.is_empty() {
            match step.kind {
                StepKind::Edit | StepKind::Write => step.target.as_deref().into_iter().collect(),
                _ => Vec::new(),
            }
        } else {
            step.changed_files.iter().map(String::as_str).collect()
        };
        for (at, path) in paths.into_iter().enumerate() {
            let first = at == 0;
            changes.push(FileChange {
                path: path.to_string(),
                added: if first { count(step.lines_added) } else { 0 },
                removed: if first { count(step.lines_removed) } else { 0 },
            });
        }
    }
    TurnFacts {
        started_ms: turn.started_ms,
        ended: turn.ended_ms.is_some(),
        report: turn.report.clone(),
        changes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity_store::ActivityStep;

    fn step(kind: StepKind, target: &str, lines: Option<(i64, i64)>) -> ActivityStep {
        ActivityStep {
            id: 1,
            tool_name: "Edit".into(),
            kind,
            target: Some(target.into()),
            summary: None,
            lines_added: lines.map(|l| l.0),
            lines_removed: lines.map(|l| l.1),
            created: false,
            outcome: None,
            approved: false,
            changed_files: vec![],
            agent_id: None,
            parent_step_id: None,
            agent_name: None,
            status: kriyon_core::activity_log::StepStatus::Ok,
            flags: 0,
            agent_type: None,
            started_ms: 0,
            duration_ms: None,
        }
    }

    #[test]
    fn a_turns_file_changes_are_its_main_agents_edits_and_commands() {
        let mut command = step(StepKind::Command, "sed -i …", Some((4, 4)));
        command.changed_files = vec!["a.ts".into(), "b.ts".into()];
        let mut subagents = step(StepKind::Edit, "c.ts", Some((9, 9)));
        subagents.agent_id = Some("agent".into());
        let turn = ActivityTurn {
            id: 1,
            prompt: None,
            report: None,
            source: None,
            started_ms: 5,
            ended_ms: Some(9),
            end_reason: None,
            steps: vec![
                step(StepKind::Edit, "a.ts", Some((3, 1))),
                step(StepKind::Read, "a.ts", None),
                command,
                subagents,
            ],
        };
        let facts = turn_facts(&turn);
        assert!(facts.ended);
        assert_eq!(facts.started_ms, 5);
        let changes: Vec<(&str, u64, u64)> = facts
            .changes
            .iter()
            .map(|c| (c.path.as_str(), c.added, c.removed))
            .collect();
        assert_eq!(changes, [("a.ts", 3, 1), ("a.ts", 4, 4), ("b.ts", 0, 0)]);
    }

    #[test]
    fn the_last_turn_is_read_again_only_when_the_session_worked_since() {
        let sources = DigestSources::default();
        let reads = std::cell::Cell::new(0);
        let read = || {
            reads.set(reads.get() + 1);
            (Some(TurnFacts::default()), None)
        };
        let _ = sources.last_turn_with("s", Some(1), read);
        let _ = sources.last_turn_with("s", Some(1), read);
        assert_eq!(reads.get(), 1);
        let _ = sources.last_turn_with("s", Some(2), read);
        assert_eq!(reads.get(), 2);
    }

    #[test]
    fn a_tool_ending_is_forgotten() {
        let sources = DigestSources::default();
        let id = SessionId("s".into());
        let bash = ToolActivity {
            tool_name: "Bash".into(),
            target: None,
            started_at: None,
        };
        sources.note_tool(&id, Some(bash.clone()));
        assert_eq!(sources.tool(&id), Some(bash));
        sources.note_tool(&id, None);
        assert_eq!(sources.tool(&id), None);
    }
}
