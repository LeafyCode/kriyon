//! Which claude session is a terminal's *main* interactive agent.
//!
//! Kriyon keys one events file per **terminal** (`events/<KRIYON_SESSION>.jsonl`),
//! but over a terminal's life many claude *session ids* write into it: the main
//! interactive session (whose id changes on restart/resume), subagents, and
//! one-shot `claude -p` invocations that inherit `KRIYON_SESSION`. Status and the
//! activity projection must reflect the *main* session only — a nested claude
//! finishing must not flap the main session's status.
//!
//! The naive "lock onto the first id seen, only re-lock on an `Agent` spawn" rule
//! gets **stuck**: if the first id belongs to a session that ends immediately (or
//! to a nested one-shot), and the real interactive session never spawns an
//! `Agent`, its events are dropped forever and the terminal looks idle while it is
//! actually working. [`MainSessionLock`] instead *converges*: it re-locks when the
//! current main ends, refuses to lock onto an obvious one-shot, and accepts an
//! authoritative id from the status-line wrapper (which only the main interactive
//! TUI renders). Both [`crate::status::StatusTracker`] and
//! [`crate::activity::HookActivity`] share this one type, so the status badge and
//! the activity projection can never disagree about which events are the main agent's.

use crate::hook_signal::{classify, HookSignal};
use crate::hooks::HookEvent;

/// Tracks the terminal's main interactive claude session amid nested claudes.
///
/// Feed it every hook event via [`MainSessionLock::observe`], which returns
/// whether that event belongs to the main session; gate status/activity updates
/// on that. Feed it the status-line's session id via
/// [`MainSessionLock::set_authoritative`] when known.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MainSessionLock {
    /// The session id currently treated as the main agent, if locked.
    current: Option<String>,
    /// Whether `current` has emitted `SessionEnd` (so the next real session may
    /// take over). A live main is never displaced by a nested claude.
    ended: bool,
}

impl MainSessionLock {
    /// A fresh lock that has seen nothing yet.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The session id currently locked as the main agent, if any.
    #[must_use]
    pub fn current(&self) -> Option<&str> {
        self.current.as_deref()
    }

    /// Anchor the main session to `sid` authoritatively. The status-line wrapper
    /// captures this id from Claude's `statusLine` JSON, and only the main
    /// interactive TUI renders a status line (a one-shot `claude -p` and a
    /// subagent do not) — so this id is trusted: it (re)locks immediately and
    /// clears the ended flag, correcting a heuristic mis-lock and re-anchoring
    /// after a restart/resume that produced no `SessionEnd` for the old session.
    pub fn set_authoritative(&mut self, sid: &str) {
        if sid.is_empty() {
            return;
        }
        if self.current.as_deref() != Some(sid) {
            self.current = Some(sid.to_string());
        }
        self.ended = false;
    }

    /// Observe one hook event, updating the lock, and return whether it belongs to
    /// the current main session.
    ///
    /// Re-lock rules (a candidate must be *lockable*: a real, non-subagent session
    /// — see [`is_lockable`]):
    /// - nothing locked yet → lock onto it;
    /// - the current main has `SessionEnd`ed → a new session supersedes it;
    /// - an `Agent`/`Task` spawn is authoritatively the main agent (subagents
    ///   don't spawn agents), so it always re-locks — self-healing a resume that
    ///   began mid-subagent.
    ///
    /// A live (un-ended) main is never displaced by another session's events, so a
    /// nested claude — a one-shot `claude -p` or a subagent — can't flap it.
    ///
    /// Legacy no-id streams (a session id never appears) are honored only while no
    /// lock has been taken, matching the historical contract: once a real id is
    /// locked, an event with a missing/empty id is not main.
    pub fn observe(&mut self, ev: &HookEvent) -> bool {
        let Some(sid) = ev.session_id.as_deref().filter(|s| !s.is_empty()) else {
            // No id on this event: main only if we never locked onto a real id.
            return self.current.is_none();
        };

        let signal = classify(ev);
        let is_agent = matches!(signal, HookSignal::Tool(call) if call.spawns_agent());
        let relock = self.current.is_none() || self.ended || is_agent;
        // `is_lockable` gates *every* re-lock, the Agent spawn included. An
        // Agent spawn is strong evidence of a main agent, but it is not
        // evidence of an *interactive* one: a one-shot `claude -p` that uses
        // the Task tool spawns agents too, and letting that bypass the
        // one-shot filter handed it the lock. Every subsequent event from the
        // real session then read as "not main" — muting its status, its
        // activity, and (since the ask is gated on this verdict) its Pending
        // ask, so a genuinely blocked terminal went silent.
        if relock && is_lockable(ev) {
            self.current = Some(sid.to_string());
            self.ended = false;
        }

        let is_main = self.current.as_deref() == Some(sid);
        if is_main && signal == HookSignal::SessionEnded {
            self.ended = true;
        }
        is_main
    }
}

/// Whether a hook event may lock the main session: it must look like a real
/// interactive session, not a one-shot `claude -p`. A missing path carries no
/// signal and is allowed (unit fixtures, and older hook payloads without the field).
///
/// The naive "is it under `~/.claude/projects/`?" test is not enough: a one-shot
/// `claude -p` launched from a temp cwd has that cwd *slugified into the project-dir
/// name*, so its transcript still lands under `~/.claude/projects/` — e.g.
/// `…/projects/-private-var-folders----…-T/…` (measured in real logs, 2026-07-24).
/// A one-shot must be under `/projects/` AND not carry a temp-dir slug.
fn is_lockable(ev: &HookEvent) -> bool {
    match ev.transcript_path.as_deref() {
        None => true,
        Some(path) => path.contains("/projects/") && !is_temp_dir_slug(path),
    }
}

/// Whether a transcript path's project slug is a slugified temp directory — the
/// fingerprint of a one-shot `claude -p`. macOS temp dirs live under
/// `/var/folders/…` (slugified to `…-var-folders-…`); Linux/generic temp under
/// `/tmp/…` (`…-tmp-…`). Kriyon is Mac-first, so `var-folders` is the primary mark.
fn is_temp_dir_slug(path: &str) -> bool {
    path.contains("var-folders") || path.contains("-tmp-")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(event: &str, sid: Option<&str>) -> HookEvent {
        HookEvent {
            event: event.to_string(),
            session_id: sid.map(str::to_string),
            ..HookEvent::default()
        }
    }

    fn ev_real(event: &str, sid: &str) -> HookEvent {
        HookEvent {
            transcript_path: Some(format!(
                "/Users/x/.claude/projects/-Users-x-proj/{sid}.jsonl"
            )),
            ..ev(event, Some(sid))
        }
    }

    #[test]
    fn locks_onto_first_seen_session() {
        let mut lock = MainSessionLock::new();
        assert!(lock.observe(&ev("UserPromptSubmit", Some("a"))));
        assert_eq!(lock.current(), Some("a"));
    }

    #[test]
    fn live_main_is_not_flapped_by_a_nested_session() {
        let mut lock = MainSessionLock::new();
        assert!(lock.observe(&ev("UserPromptSubmit", Some("main"))));
        // A nested claude finishes: its Stop/SessionEnd must not be "main".
        assert!(!lock.observe(&ev("Stop", Some("nested"))));
        assert!(!lock.observe(&ev("SessionEnd", Some("nested"))));
        // The main is still locked and un-ended.
        assert!(lock.observe(&ev("Stop", Some("main"))));
        assert_eq!(lock.current(), Some("main"));
    }

    #[test]
    fn ended_main_relocks_to_the_next_session() {
        // The regression: a terminal's first session ends immediately, then a new
        // interactive session runs. Its events must drive status, not be dropped.
        let mut lock = MainSessionLock::new();
        assert!(lock.observe(&ev_real("SessionStart", "old")));
        assert!(lock.observe(&ev_real("SessionEnd", "old")));
        // A brand-new session supersedes the ended one.
        assert!(lock.observe(&ev_real("UserPromptSubmit", "new")));
        assert_eq!(lock.current(), Some("new"));
        assert!(lock.observe(&ev_real("PreToolUse", "new")));
    }

    #[test]
    fn agent_spawn_relocks_even_when_current_is_live() {
        // A resume that began mid-subagent may lock a stale id; an Agent spawn is
        // authoritatively the main session and re-locks it.
        let mut lock = MainSessionLock::new();
        assert!(lock.observe(&ev("PreToolUse", Some("stale"))));
        let mut agent = ev("PreToolUse", Some("real-main"));
        agent.tool_name = Some("Agent".to_string());
        assert!(lock.observe(&agent));
        assert_eq!(lock.current(), Some("real-main"));
        // The stale session's events are now ignored.
        assert!(!lock.observe(&ev("Stop", Some("stale"))));
    }

    #[test]
    fn a_one_shot_never_becomes_main() {
        // A one-shot `claude -p` (temp transcript) is the very first event: it must
        // not lock, so a real session that follows still drives status.
        let mut lock = MainSessionLock::new();
        let one_shot = HookEvent {
            transcript_path: Some("/private/var/folders/aa/bb/T/oneshot.jsonl".to_string()),
            ..ev("UserPromptSubmit", Some("oneshot"))
        };
        assert!(!lock.observe(&one_shot));
        assert_eq!(lock.current(), None, "a one-shot must not lock");
        // The real interactive session locks and drives status.
        assert!(lock.observe(&ev_real("UserPromptSubmit", "main")));
        assert_eq!(lock.current(), Some("main"));
        // A concurrent one-shot mid-session still can't displace the live main.
        assert!(!lock.observe(&one_shot));
        assert_eq!(lock.current(), Some("main"));
    }

    #[test]
    fn a_one_shot_spawning_an_agent_still_never_becomes_main() {
        // The Agent-spawn re-lock used to bypass `is_lockable`, so a one-shot
        // `claude -p` that used the Task tool stole the lock from the live
        // interactive session. Everything the real session emitted afterwards
        // read as "not main" — muting its status and its Pending ask.
        let mut lock = MainSessionLock::new();
        assert!(lock.observe(&ev_real("UserPromptSubmit", "main")));

        let mut one_shot_agent = HookEvent {
            transcript_path: Some("/private/var/folders/aa/bb/T/oneshot.jsonl".to_string()),
            tool_name: Some("Agent".to_string()),
            ..ev("PreToolUse", Some("oneshot"))
        };
        assert!(!lock.observe(&one_shot_agent));
        assert_eq!(lock.current(), Some("main"), "a one-shot must not lock");

        // The real session still drives everything.
        assert!(lock.observe(&ev_real("PreToolUse", "main")));

        // And a Task spawn from the one-shot is no different.
        one_shot_agent.tool_name = Some("Task".to_string());
        assert!(!lock.observe(&one_shot_agent));
        assert_eq!(lock.current(), Some("main"));
    }

    /// A one-shot `claude -p` launched from a temp cwd. Claude slugifies that cwd
    /// into the project-dir name under `~/.claude/projects/`, so the transcript DOES
    /// sit under `/projects/` — e.g. `…/projects/-private-var-folders----…-T/…`.
    /// (Measured in real `~/.claude/kriyon/events` logs, 2026-07-24.)
    fn ev_one_shot(event: &str, sid: &str) -> HookEvent {
        HookEvent {
            transcript_path: Some(format!(
                "/Users/x/.claude/projects/-private-var-folders----tn0abc-T/{sid}.jsonl"
            )),
            ..ev(event, Some(sid))
        }
    }

    #[test]
    fn a_one_shot_under_projects_temp_slug_is_not_lockable_at_bootstrap() {
        // The real bug: a one-shot's temp cwd is slugified under `~/.claude/projects/`,
        // so the old `contains("/projects/")` check locked onto it. If it arrives first,
        // it must NOT lock, so the real interactive session that follows drives status.
        let mut lock = MainSessionLock::new();
        assert!(!lock.observe(&ev_one_shot("UserPromptSubmit", "oneshot")));
        assert_eq!(lock.current(), None, "a temp-slug one-shot must not lock");
        // The real interactive session locks and drives status.
        assert!(lock.observe(&ev_real("UserPromptSubmit", "main")));
        assert_eq!(lock.current(), Some("main"));
    }

    #[test]
    fn a_one_shot_under_projects_temp_slug_spawning_agent_never_steals_live_main() {
        // A one-shot `claude -p` that uses the Task tool spawns an Agent, tripping the
        // `is_agent` re-lock. With its temp transcript under `/projects/`, the old
        // `is_lockable` let it steal the lock from a LIVE interactive main — the source
        // of false "Session finished" pings and a muted real session.
        let mut lock = MainSessionLock::new();
        assert!(lock.observe(&ev_real("UserPromptSubmit", "main")));

        let mut one_shot_agent = ev_one_shot("PreToolUse", "oneshot");
        one_shot_agent.tool_name = Some("Task".to_string());
        assert!(!lock.observe(&one_shot_agent));
        assert_eq!(
            lock.current(),
            Some("main"),
            "a temp-slug one-shot must not steal"
        );
    }

    #[test]
    fn no_id_event_after_lock_is_not_main() {
        let mut lock = MainSessionLock::new();
        assert!(lock.observe(&ev("UserPromptSubmit", Some("main"))));
        assert!(!lock.observe(&ev("Stop", None)));
        assert_eq!(lock.current(), Some("main"));
    }

    #[test]
    fn legacy_no_id_stream_is_always_main() {
        let mut lock = MainSessionLock::new();
        assert!(lock.observe(&ev("Stop", None)));
        assert!(lock.observe(&ev("UserPromptSubmit", None)));
    }

    #[test]
    fn authoritative_id_relocks_a_live_mislock() {
        // The heuristic mis-locked onto a nested id; the status-line's authoritative
        // id corrects it even though the mis-lock is still "live" (un-ended).
        let mut lock = MainSessionLock::new();
        assert!(lock.observe(&ev("UserPromptSubmit", Some("wrong"))));
        lock.set_authoritative("right");
        assert_eq!(lock.current(), Some("right"));
        assert!(lock.observe(&ev("PreToolUse", Some("right"))));
        assert!(!lock.observe(&ev("Stop", Some("wrong"))));
    }

    #[test]
    fn authoritative_reanchors_after_restart_without_session_end() {
        // The old main never emitted SessionEnd (e.g. /clear or a hard restart); the
        // status-line reports the new session id, which re-anchors the lock.
        let mut lock = MainSessionLock::new();
        assert!(lock.observe(&ev_real("UserPromptSubmit", "first")));
        lock.set_authoritative("second");
        assert_eq!(lock.current(), Some("second"));
        assert!(lock.observe(&ev_real("PreToolUse", "second")));
    }

    #[test]
    fn empty_authoritative_id_is_ignored() {
        let mut lock = MainSessionLock::new();
        assert!(lock.observe(&ev("UserPromptSubmit", Some("main"))));
        lock.set_authoritative("");
        assert_eq!(lock.current(), Some("main"));
    }

    #[test]
    fn status_and_activity_locks_agree_on_the_same_stream() {
        // ADR-0009 gives the status tracker and the activity projection each
        // their own MainSessionLock (not one shared instance — that would put a
        // lock across two subsystems on the hot path). "They can't disagree" then
        // rests on both being fed the same hook stream and the same authoritative
        // id. This pins that invariant at the two real owners, so a future change
        // that feeds one path differently fails here rather than shipping a status
        // badge and activity projection that silently disagree. See ADR-0010.
        use crate::projection::SessionActivityProjection;
        use crate::status::StatusTracker;

        let mut status = StatusTracker::new();
        let mut activity = SessionActivityProjection::new();

        // The ten-session regression in miniature: an early session ends, a new
        // one supersedes it. Both surfaces must converge on the same id, step by
        // step (in production the same event reaches note_hook_event and ingest).
        let stream = [
            ev_real("SessionStart", "old"),
            ev_real("SessionEnd", "old"),
            ev_real("UserPromptSubmit", "new"),
            ev_real("PreToolUse", "new"),
        ];
        for e in &stream {
            status.note_hook_event(e);
            activity.ingest(e);
            assert_eq!(
                status.main_session_id(),
                activity.main_session_id(),
                "locks diverged after {} / {:?}",
                e.event,
                e.session_id
            );
        }
        assert_eq!(status.main_session_id(), Some("new"));

        // The status-line's authoritative id anchors both paths from one accessor
        // (`UsageSnapshot::authoritative_main_id`) in production; feed both the
        // same id and assert they still agree.
        status.set_authoritative_main("live");
        activity.set_authoritative_main("live");
        assert_eq!(status.main_session_id(), activity.main_session_id());
        assert_eq!(status.main_session_id(), Some("live"));
    }
}
