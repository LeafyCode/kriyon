//! The [Session activity] projection: the single fold that turns a session's
//! live hook-event stream into its Session activity.
//!
//! Two independent projections used to be ingested side by side at the call site
//! (`HookActivity` for running subagents + background shells, `AskState` for the
//! open [Pending ask]), so the combination lived only in the order of two
//! `.ingest` calls in the watcher and could not be unit-tested as one thing.
//! `SessionActivityProjection` owns both behind one `ingest`, so the coordination
//! — most notably that a turn-ending `Stop` both settles running subagents *and*
//! clears the pending ask — has one home and one test surface (see ADR 0003).

use crate::activity::{BackgroundShell, HookActivity, MainAgent, SessionActivity, Subagent, Task};
use crate::ask::{AskState, PendingAsk};
use crate::hooks::HookEvent;

/// Folds a session's hook events into its live [Session activity]: the running
/// subagents/background shells and the open [Pending ask], assembled with the
/// on-disk task list into one `SessionActivity` snapshot.
pub struct SessionActivityProjection {
    activity: HookActivity,
    ask: AskState,
}

impl SessionActivityProjection {
    #[must_use]
    pub fn new() -> Self {
        Self {
            activity: HookActivity::new(),
            ask: AskState::new(),
        }
    }

    /// Fold one hook event into both inner projections. Returns whether either
    /// changed, so a caller can skip re-emitting an unchanged snapshot.
    ///
    /// Both projections observe every event the main agent emits — the two
    /// `ingest` calls are bound before combining so neither is short-circuited:
    /// a `Stop` must reach the activity projection (to settle subagents) *and*
    /// the ask projection (to clear the pending ask) on the same event.
    ///
    /// The ask, unlike the activity, is gated on the [Main session lock]: a
    /// [Pending ask] is a claim that *the user* is blocked, and only the main
    /// interactive agent can block them. A nested `claude -p` inherits
    /// `KRIYON_SESSION` and writes into the same events file, so without this
    /// gate its permission gate could fabricate an ask the user never saw and —
    /// far worse — its `Stop` would clear a real one, dropping a genuinely
    /// blocked session out of Needs-you while the terminal still waits. The
    /// activity projection deliberately stays ungated here because it already
    /// makes the main-vs-nested distinction itself, per event kind.
    pub fn ingest(&mut self, ev: &HookEvent) -> bool {
        let ingested = self.activity.ingest_detailed(ev);
        let ask_changed = ingested.is_main && self.ask.ingest(ev);
        ingested.changed || ask_changed
    }

    #[must_use]
    pub fn main(&self) -> MainAgent {
        self.activity.main()
    }

    /// The claude session id locked as this terminal's main agent, if any. Used to
    /// bind the persisted [Claude session id] + task-store dir to the live session.
    #[must_use]
    pub fn main_session_id(&self) -> Option<&str> {
        self.activity.main_session_id()
    }

    /// Anchor the main session to the status-line's authoritative id.
    pub fn set_authoritative_main(&mut self, sid: &str) {
        self.activity.set_authoritative_main(sid);
    }

    #[must_use]
    pub fn subagents(&self) -> Vec<Subagent> {
        self.activity.subagents()
    }

    #[must_use]
    pub fn shells(&self) -> Vec<BackgroundShell> {
        self.activity.shells()
    }

    #[must_use]
    pub fn current_ask(&self) -> Option<PendingAsk> {
        self.ask.current()
    }

    /// Assemble the full [Session activity] snapshot, folding in the `tasks` the
    /// caller read from the on-disk task store (the one part that is not derived
    /// from the hook stream).
    #[must_use]
    pub fn snapshot(&self, tasks: Vec<Task>) -> SessionActivity {
        SessionActivity {
            main: self.main(),
            subagents: self.subagents(),
            shells: self.shells(),
            tasks,
            pending_ask: self.current_ask(),
        }
    }
}

impl Default for SessionActivityProjection {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::SubagentState;
    use crate::hooks::parse_hook_line;

    fn ev(json: &str) -> HookEvent {
        parse_hook_line(json).expect("valid hook line")
    }

    #[test]
    fn a_main_stop_settles_subagents_and_clears_the_ask_in_one_ingest() {
        let mut proj = SessionActivityProjection::new();

        // The main agent spawns a subagent (running) and hits a permission ask.
        proj.ingest(&ev(
            r#"{"event":"PreToolUse","session_id":"c1","tool_name":"Agent","tool_use_id":"t1","subagent_type":"Explore","description":"map"}"#,
        ));
        proj.ingest(&ev(
            r#"{"event":"PermissionRequest","session_id":"c1","message":"Allow Bash?"}"#,
        ));
        assert_eq!(proj.subagents().len(), 1, "subagent should be running");
        assert!(proj.current_ask().is_some(), "ask should be open");

        // The turn ends. One event must settle the subagent AND clear the ask —
        // the coordination this projection exists to make single and testable.
        let changed = proj.ingest(&ev(r#"{"event":"Stop","session_id":"c1"}"#));

        assert!(changed, "settling + clearing on Stop is a change");
        assert!(
            proj.subagents()
                .iter()
                .all(|s| s.state == SubagentState::Done),
            "the subagent must be settled to Done on the main Stop"
        );
        assert!(
            proj.current_ask().is_none(),
            "the pending ask must be cleared on the main Stop"
        );
    }

    #[test]
    fn a_nested_claude_cannot_open_or_clear_the_main_agents_ask() {
        // A one-shot `claude -p` (a subagent shelling out, a hook running
        // `claude`) inherits KRIYON_SESSION and writes into the SAME events
        // file under its own session id. Its permission gate must not fabricate
        // an ask the user never saw, and — worse — its `Stop` must not clear a
        // real ask, which would silently drop the session out of Needs-you
        // while the terminal is still blocked.
        let mut proj = SessionActivityProjection::new();

        // The main interactive session locks in and hits a real question.
        proj.ingest(&ev(
            r#"{"event":"UserPromptSubmit","session_id":"main","transcript_path":"/Users/x/.claude/projects/-Users-x-p/main.jsonl"}"#,
        ));
        proj.ingest(&ev(
            r#"{"event":"PreToolUse","session_id":"main","tool_name":"AskUserQuestion","tool_use_id":"t1","questions":"[{\"question\":\"Merge or rebase?\"}]"}"#,
        ));
        let open = proj.current_ask().expect("the main agent's question");
        assert_eq!(open.text, "Merge or rebase?");

        // A nested one-shot runs and ends. Neither end of it may touch the ask.
        proj.ingest(&ev(
            r#"{"event":"PermissionRequest","session_id":"nested","message":"Allow Bash?"}"#,
        ));
        assert_eq!(
            proj.current_ask().expect("still the main question").text,
            "Merge or rebase?",
            "a nested claude's permission gate must not replace the main ask"
        );

        proj.ingest(&ev(r#"{"event":"Stop","session_id":"nested"}"#));
        assert!(
            proj.current_ask().is_some(),
            "a nested claude's Stop must not clear the main agent's ask"
        );

        // The main session's own Stop still settles it.
        proj.ingest(&ev(r#"{"event":"Stop","session_id":"main"}"#));
        assert!(proj.current_ask().is_none(), "the main Stop clears the ask");
    }

    #[test]
    fn a_subagents_own_ask_is_not_the_users_problem() {
        // A subagent's tool events carry the MAIN session id (so the lock alone
        // can't filter them) plus an `agent_id`. A subagent cannot block the
        // user — it has no interactive channel — so its ask must never surface.
        let mut proj = SessionActivityProjection::new();
        proj.ingest(&ev(
            r#"{"event":"PreToolUse","session_id":"c1","tool_name":"Agent","tool_use_id":"t1","subagent_type":"Explore","description":"map"}"#,
        ));
        proj.ingest(&ev(
            r#"{"event":"PreToolUse","session_id":"c1","tool_name":"AskUserQuestion","tool_use_id":"t2","agent_id":"agent_7","questions":"[{\"question\":\"Subagent asking\"}]"}"#,
        ));

        assert!(
            proj.current_ask().is_none(),
            "a subagent's ask must not read as the terminal being blocked"
        );
    }

    #[test]
    fn snapshot_folds_in_the_task_list() {
        let proj = SessionActivityProjection::new();
        let snap = proj.snapshot(Vec::new());
        assert_eq!(snap.subagents, [] as [crate::activity::Subagent; 0]);
        assert_eq!(snap.tasks, [] as [crate::activity::Task; 0]);
        assert!(snap.pending_ask.is_none());
    }

    #[test]
    fn ingest_reports_no_change_for_an_irrelevant_event() {
        let mut proj = SessionActivityProjection::new();
        assert!(
            !proj.ingest(&ev(r#"{"event":"Stop","session_id":"c1"}"#)),
            "settling and clearing nothing is not a change"
        );
    }

    #[test]
    fn a_failed_turn_settles_subagents_and_clears_the_ask_like_a_stop() {
        // A turn that dies on an API error fires `StopFailure` *instead of*
        // `Stop`. Status already read it as the end of the turn (Error); the
        // Inspector kept a subagent spinning and the ask stayed open.
        let mut proj = SessionActivityProjection::new();
        proj.ingest(&ev(
            r#"{"event":"PreToolUse","session_id":"c1","tool_name":"Agent","tool_use_id":"t1","subagent_type":"Explore"}"#,
        ));
        proj.ingest(&ev(
            r#"{"event":"PermissionRequest","session_id":"c1","message":"Allow Bash?"}"#,
        ));
        assert!(proj.ingest(&ev(
            r#"{"event":"StopFailure","session_id":"c1","error":"rate_limit"}"#
        )));
        assert!(proj
            .subagents()
            .iter()
            .all(|s| s.state == SubagentState::Done));
        assert!(proj.current_ask().is_none());
    }

    #[test]
    fn status_and_the_inspector_agree_on_which_agents_are_still_running() {
        // One stream, both folds. An in-flight entry of a type Kriyon does not
        // wait on must read as finished to both — it used to keep a subagent
        // spinning in the Inspector while status already said Done.
        let stream = [
            r#"{"event":"UserPromptSubmit","session_id":"c1"}"#,
            r#"{"event":"PreToolUse","session_id":"c1","tool_name":"Agent","tool_use_id":"t1","subagent_type":"general-purpose"}"#,
            r#"{"event":"PostToolUse","session_id":"c1","tool_name":"Agent","tool_use_id":"t1","launched_agent_id":"a1"}"#,
            r#"{"event":"PreToolUse","session_id":"c1","tool_name":"Agent","tool_use_id":"t2","subagent_type":"general-purpose"}"#,
            r#"{"event":"PostToolUse","session_id":"c1","tool_name":"Agent","tool_use_id":"t2","launched_agent_id":"a2"}"#,
            r#"{"event":"Stop","session_id":"c1","background_tasks":[{"id":"a1","type":"subagent"},{"id":"a2","type":"something newer"}]}"#,
        ];
        let mut proj = SessionActivityProjection::new();
        let mut status = crate::status::StatusTracker::new();
        for line in stream {
            let event = ev(line);
            proj.ingest(&event);
            status.note_hook_event(&event);
        }
        let _ = status.apply_recompute(std::time::Instant::now());
        let running: Vec<_> = proj
            .subagents()
            .into_iter()
            .filter(|s| s.state == SubagentState::Running)
            .filter_map(|s| s.agent_id)
            .collect();
        assert_eq!(running, ["a1"]);
        assert_eq!(status.summary(), "Waiting on 1 agent…");
    }
}
