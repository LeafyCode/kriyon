//! [Session runtime] — the one home for a session's live runtime state: its
//! [`StatusTracker`] and the mirrored open [Pending ask].
//!
//! These used to live in two parallel locked maps in the shell (`status` and
//! `asks`), and every consumer — the menu-bar badge, the OS-notification
//! dispatch, the tray's session snapshots — re-joined them by hand under a
//! "never hold both locks" ordering rule. The phantom-badge bug class lived
//! exactly in those seams. One `SessionRuntime` per session puts the join
//! behind one interface: `needs_you()` is *the* membership rule evaluated on
//! the object that owns both inputs, so no read site can disagree with
//! another.
//!
//! The ask is still *computed* by the watcher's
//! [`crate::projection::SessionActivityProjection`] (the single source, per
//! ADR-0003); the runtime only holds the mirrored value the dispatch and
//! badge read.

use std::time::{Duration, Instant};

use crate::ask::PendingAsk;
use crate::hooks::HookEvent;
use crate::session::SessionStatus;
use crate::status::{StatusChange, StatusTracker};
use crate::tray_badge::session_needs_you;

/// What the shell knows and the runtime does not when it folds a recompute:
/// where the user is looking, and what they asked to be notified about.
#[derive(Clone, Copy, Debug)]
pub struct ObserveEnv {
    /// The Kriyon window itself is focused.
    pub window_focused: bool,
    /// This session is the active (selected) one.
    pub active_is_this: bool,
    /// The user's cross-project notification preference.
    pub preference: crate::status::NotifyPreference,
}

impl ObserveEnv {
    /// A session is on screen only when the window is focused *and* it is the
    /// active one. Switch to another app and the active session is not on
    /// screen any more.
    #[must_use]
    pub const fn on_screen(&self) -> bool {
        self.window_focused && self.active_is_this
    }
}

/// What one [`SessionRuntime::observe`] leaves for the shell to carry out.
#[derive(Debug, Default)]
pub struct StatusOutcome {
    /// The committed change to emit, or `None` when nothing moved.
    pub change: Option<StatusChange>,
    /// Pull any banner shown for the state just left.
    pub withdraw: bool,
    /// The decision's inputs, for the trace line. `None` with no change.
    pub decision: Option<crate::status::NotifyDecision>,
}

/// How long a fire waits, and how long a noisy pty may hold it back.
#[derive(Clone, Copy, Debug)]
pub struct SettleTiming {
    pub settle: Duration,
    pub quiet: Duration,
    pub max_defer: Duration,
}

/// An armed notification, claimed. Everything the shell needs to plan it.
#[derive(Clone, Debug)]
pub struct SettledClaim {
    pub prev: SessionStatus,
    pub next: SessionStatus,
    pub already_unread: bool,
    pub ask: Option<PendingAsk>,
    pub secs_since_last_notify: Option<u64>,
}

/// A session's live runtime state: status tracker + mirrored open ask.
#[derive(Debug, Default)]
pub struct SessionRuntime {
    tracker: StatusTracker,
    ask: Option<PendingAsk>,
    /// The session finished a turn (Done/Error) while the user was not looking
    /// at it, and they have not focused it since. Counts toward
    /// [`SessionRuntime::needs_you`] — "finished, waiting for your next
    /// prompt" is attention-worthy. Set only by *live* transitions (the shell
    /// knows the focus state); a history seed never sets it, so an app restart
    /// can't relight the badge for output seen long ago. Cleared on focus
    /// ([`SessionRuntime::mark_seen`]) and when a new turn starts.
    unseen_done: bool,
    /// A fireable attention transition is waiting out its settle window before
    /// it notifies: `(armed_at, the status it moved *from*)`. Deferring the fire
    /// this way means a state that flips straight back to work — a spurious idle
    /// prompt, an auto-granted permission — is disarmed before it ever pings.
    /// Armed at most once per attention episode (the first fireable transition),
    /// so the `Done`↔`Waiting` burst at a turn's end still yields one fire. See
    /// [`SessionRuntime::arm_notify`].
    notify_armed: Option<(Instant, SessionStatus)>,
    /// When this session's pty last produced output, or `None` if none has been
    /// observed. The terminal is the source of truth for whether a turn has
    /// really settled: hook events and pty bytes arrive on separate channels, so
    /// a hook can say "done" while the screen is still filling. See
    /// [`SessionRuntime::notify_ready`].
    last_output_at: Option<Instant>,
    /// The session's processes died underneath the app — the shell exited, or
    /// the daemon crashed. Reported once by the [Daemon client]'s reader thread
    /// on EOF.
    ///
    /// It has to live here because nothing else can retire the tracker's last
    /// word: a killed `claude` fires no closing hook, so a turn interrupted
    /// mid-flight stays `Running` for good. Every surface that reads a runtime
    /// — the menu-bar badge, the tray rows, the sleep vetoes — was folding that
    /// frozen status as live work, while the frontend (which held the only copy
    /// of the exit) correctly reported the session as costing nothing to stop.
    exited: bool,
    /// Settings turn Kriyon's hooks off for this session — [Hooks off]. No
    /// hook will ever retire whatever status was tracked or seeded before, so
    /// nothing derived from it claims attention or counts as live work. A hook
    /// that fires anyway proves the hooks run and clears it.
    hooks_off: bool,
}

impl SessionRuntime {
    /// A fresh runtime for a session that has produced no events yet.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebuild a runtime from a session's recorded hook-event tail (see
    /// [`crate::status::replay_history`] for the anchor semantics). Used to
    /// seed a just-subscribed session so status + ask reflect the on-disk
    /// history rather than subscription timing.
    #[must_use]
    pub fn from_history(
        events: &[HookEvent],
        authoritative_main: Option<&str>,
        now: Instant,
    ) -> Self {
        let replayed = crate::status::replay_history(events, authoritative_main, now);
        Self {
            ask: replayed.projection.current_ask(),
            tracker: replayed.tracker,
            // Never seeded: replayed turns finished long ago, and lighting the
            // badge for every old session on every launch is noise, not signal.
            unseen_done: false,
            // A seed is silent — it never notifies (see `seed_from_history`), so
            // it must never arm a deferred fire either.
            notify_armed: None,
            // Replay reads on-disk history; it observes no pty bytes.
            last_output_at: None,
            // A replay describes processes that may be long gone and proves
            // nothing either way. Only a live EOF records an exit.
            exited: false,
            // Set by the shell at session start, never by a replay.
            hooks_off: false,
        }
    }

    /// Record a Claude Code hook event (see [`StatusTracker::note_hook_event`]).
    ///
    /// A live hook also retires any recorded exit: only a running `claude`
    /// fires one, so it is proof the session is back (the resume path after a
    /// crash, or a wake). The history seed goes through
    /// [`Self::from_history`] instead, so a replay can never claim that.
    pub fn note_hook_event(&mut self, event: &HookEvent) {
        self.exited = false;
        self.hooks_off = false;
        self.tracker.note_hook_event(event);
    }

    /// The user stopped the turn with Esc. See
    /// [`crate::status::StatusTracker::note_user_interrupt`].
    pub fn note_user_interrupt(&mut self) {
        self.tracker.note_user_interrupt();
    }

    /// The transcript recorded the turn's end. See
    /// [`crate::status::StatusTracker::note_turn_ended`].
    pub fn note_turn_ended(&mut self, ended_ms: i64, interrupted: bool) {
        self.tracker.note_turn_ended(ended_ms, interrupted);
    }

    /// The session's processes died underneath the app. See [`Self::exited`].
    pub fn note_exited(&mut self) {
        self.exited = true;
    }

    /// Record whether settings turn Kriyon's hooks off. See [`Self::hooks_off`].
    pub fn note_hooks_off(&mut self, off: bool) {
        self.hooks_off = off;
    }

    /// Whether settings turn Kriyon's hooks off for this session — [Hooks off].
    #[must_use]
    pub const fn hooks_off(&self) -> bool {
        self.hooks_off
    }

    /// Whether the session's processes are known to have died. The committed
    /// [`Self::status`] is left alone — it is the history of the turn, and the
    /// sidebar still shows it — but nothing derived from "is this session
    /// working" counts it any more.
    #[must_use]
    pub const fn exited(&self) -> bool {
        self.exited
    }

    /// Whether a turn is really in flight: committed `Running`, and the
    /// session still alive. The menu bar's running count reads this rather
    /// than the status, so a `claude` killed mid-turn stops being counted.
    #[must_use]
    pub fn is_running(&self) -> bool {
        !self.exited && !self.hooks_off && self.status() == SessionStatus::Running
    }

    /// Anchor the main session id (see [`StatusTracker::set_authoritative_main`]).
    pub fn set_authoritative_main(&mut self, session_id: &str) {
        self.tracker.set_authoritative_main(session_id);
    }

    /// Mirror the latest open ask from the watcher's projection. Returns
    /// whether the mirrored value changed, so the caller knows to refresh the
    /// menu-bar badge even when the status itself did not move (a mid-turn
    /// permission prompt opens and clears while status stays `running`).
    pub fn set_ask(&mut self, ask: Option<PendingAsk>) -> bool {
        let changed = self.ask != ask;
        self.ask = ask;
        changed
    }

    /// Recompute and commit status + summary (see
    /// [`StatusTracker::apply_recompute`]). A committed transition into
    /// `Running` clears the unseen-done flag: a new turn means the user (or
    /// their queued prompt) re-engaged the session.
    pub fn apply_recompute(&mut self, now: Instant) -> Option<StatusChange> {
        let change = self.tracker.apply_recompute(now);
        if change
            .as_ref()
            .is_some_and(|c| c.status == SessionStatus::Running)
        {
            self.unseen_done = false;
        }
        change
    }

    /// Fold one status recompute: commit it, decide what the shell must carry
    /// out, and leave the notification machinery in the right state.
    ///
    /// The shell used to run this dance from outside — `apply_recompute`, then
    /// `note_unseen_done`, then `disarm_notify`, then `has_unread_notification`
    /// to build the decision, then `arm_notify` — taking the runtimes lock four
    /// separate times for one event on one session, re-finding the session each
    /// time and silently bailing if it had been closed in between. Every one of
    /// those windows was a chance for the state to move under it.
    ///
    /// One call, one lock, one decision. The shell is left with the parts only
    /// it can do: emit the event, pull the banner, refresh the badge.
    pub fn observe(&mut self, now: Instant, env: &ObserveEnv) -> StatusOutcome {
        let Some(change) = self.apply_recompute(now) else {
            return StatusOutcome::default();
        };
        if matches!(change.status, SessionStatus::Done | SessionStatus::Error) && !env.on_screen() {
            self.note_unseen_done();
        }
        // Leaving an attention state makes any banner shown for it stale, and
        // cancels a fire that never got to notify.
        let withdraw = crate::status::should_withdraw_notification(change.prev, change.status);
        if withdraw {
            self.disarm_notify();
        }
        let decision = crate::status::NotifyDecision {
            prev: change.prev,
            next: change.status,
            window_focused: env.window_focused,
            active_is_this: env.active_is_this,
            already_unread: self.has_unread_notification(),
            preference: env.preference,
            secs_since_last_notify: change.secs_since_last_notify,
        };
        // Armed, not fired: a spurious attention state that flips straight back
        // to work is disarmed before its settle window elapses.
        if decision.should_fire() {
            self.arm_notify(now, change.prev);
        }
        StatusOutcome {
            change: Some(change),
            withdraw,
            decision: Some(decision),
        }
    }

    /// Claim an armed notification whose settle window has elapsed, together
    /// with everything the shell needs to plan it — or `None` if none is due.
    ///
    /// Claimed atomically: the armed state is read and disarmed in one call, so
    /// a concurrent event and ticker pass cannot both deliver it. If the plan
    /// then says stay quiet, the disarm still stands — we did not want to fire.
    pub fn claim_settled(&mut self, now: Instant, timing: &SettleTiming) -> Option<SettledClaim> {
        let prev = self.notify_ready(now, timing.settle, timing.quiet, timing.max_defer)?;
        let claim = SettledClaim {
            prev,
            next: self.status(),
            already_unread: self.has_unread_notification(),
            ask: self.ask.clone(),
            secs_since_last_notify: self.secs_since_last_notify(now),
        };
        self.disarm_notify();
        Some(claim)
    }

    /// Record that this session finished a turn while the user was not looking
    /// at it. Called by the shell on a live Done/Error transition (only the
    /// shell knows window + session focus).
    fn note_unseen_done(&mut self) {
        self.unseen_done = true;
    }

    /// The user focused this session: whatever it finished is now seen.
    pub fn mark_seen(&mut self) {
        self.unseen_done = false;
    }

    /// Stamp the notified clock + unread latch (see
    /// [`StatusTracker::record_notified`]).
    pub fn record_notified(&mut self, now: Instant) {
        self.tracker.record_notified(now);
    }

    /// Whether a notification is outstanding for the current episode.
    #[must_use]
    fn has_unread_notification(&self) -> bool {
        self.tracker.has_unread_notification()
    }

    /// Arm the settle window for a fireable attention transition, stashing the
    /// status it moved *from* so the deferred fire can rebuild the same
    /// [`crate::status::NotifyDecision`]. Idempotent within an episode: a second
    /// arm while one is pending is ignored, so a turn's `Done`↔`Waiting` burst
    /// keeps the first arm and yields a single fire. Cleared by
    /// [`SessionRuntime::disarm_notify`] when the session leaves attention or the
    /// deferred fire is claimed.
    fn arm_notify(&mut self, now: Instant, prev: SessionStatus) {
        if self.notify_armed.is_none() {
            self.notify_armed = Some((now, prev));
        }
    }

    /// Clear any armed settle window: the state that would have notified passed
    /// (the session went back to work) or the fire was just claimed.
    fn disarm_notify(&mut self) {
        self.notify_armed = None;
    }

    /// The stashed pre-attention status if an armed notification has now outlived
    /// its `settle` window (so it is a stable attention state, not a flash), else
    /// `None`. The caller rebuilds the notify decision from this `prev` and the
    /// current status, and should disarm as it claims the fire.
    /// Also held back while the session's pty is still producing output: the
    /// hook said "your turn", but the terminal is mid-paint, so the turn has not
    /// actually settled (Claude is still writing, or a `Stop` hook resumed it).
    /// The veto only *defers* — the arm is left standing, and the 2s badge ticker
    /// re-drives this, so the fire goes out as soon as the pty falls quiet. Past
    /// `max_defer` the veto yields regardless: a TUI that repaints forever must
    /// never starve a "needs you" notification.
    #[must_use]
    fn notify_ready(
        &self,
        now: Instant,
        settle: Duration,
        quiet: Duration,
        max_defer: Duration,
    ) -> Option<SessionStatus> {
        let (armed_at, prev) = self.notify_armed?;
        let waited = now.saturating_duration_since(armed_at);
        if waited < settle {
            return None;
        }
        if waited < max_defer && self.pty_noisy(now, quiet) {
            return None;
        }
        Some(prev)
    }

    /// Whether the pty produced output within the last `quiet`. A session whose
    /// output was never observed (detached, or no daemon stream) has no evidence
    /// either way and counts as quiet — the veto never invents a reason to hold
    /// a notification back.
    fn pty_noisy(&self, now: Instant, quiet: Duration) -> bool {
        self.last_output_at
            .is_some_and(|at| now.saturating_duration_since(at) < quiet)
    }

    /// Record that the session's pty produced output at `now`. Fed from the
    /// daemon's output stream, which every live session's bytes flow through.
    pub fn note_pty_output(&mut self, now: Instant) {
        self.last_output_at = Some(now);
    }

    /// Seconds since the last OS notification for this session, for coalescing
    /// the deferred fire the same way an immediate one is (see
    /// [`crate::status::NOTIFY_COALESCE_SECS`]).
    #[must_use]
    fn secs_since_last_notify(&self, now: Instant) -> Option<u64> {
        self.tracker.secs_since_last_notify(now)
    }

    /// Whether a live hook event has driven this runtime's tracker yet.
    #[must_use]
    pub fn is_hook_driven(&self) -> bool {
        self.tracker.is_hook_driven()
    }

    /// The claude session id locked as this terminal's main agent, if any.
    #[must_use]
    pub fn main_session_id(&self) -> Option<&str> {
        self.tracker.main_session_id()
    }

    /// The committed status.
    #[must_use]
    pub fn status(&self) -> SessionStatus {
        self.tracker.status()
    }

    /// The committed one-line summary.
    #[must_use]
    pub fn summary(&self) -> &str {
        self.tracker.summary()
    }

    /// The mirrored open ask, if any.
    #[must_use]
    pub fn ask(&self) -> Option<&PendingAsk> {
        self.ask.as_ref()
    }

    /// THE membership rule for "this session needs the user": Waiting, an
    /// open ask, or finished-with-unseen-output. The badge counts runtimes
    /// where this is true; the tray rows carry it per session — one rule, one
    /// owner, no cross-map join.
    #[must_use]
    pub fn needs_you(&self) -> bool {
        if self.exited || self.hooks_off {
            // A session whose processes are gone cannot be waiting on anyone,
            // and one with hooks off has a status nothing can retire.
            // Its ask and its unseen-done are claims about a turn that ended
            // the moment the tree died.
            return false;
        }
        session_needs_you(self.status(), self.ask.is_some()) || self.unseen_done
    }
}

#[cfg(test)]
mod tests {
    use super::{ObserveEnv, SessionRuntime, SettleTiming};
    use crate::ask::{AskKind, PendingAsk};
    use crate::hooks::HookEvent;
    use crate::session::SessionStatus;
    use std::time::Instant;

    fn ev(event: &str) -> HookEvent {
        HookEvent {
            event: event.to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        }
    }

    fn ask() -> PendingAsk {
        PendingAsk {
            kind: AskKind::Permission,
            text: "Needs permission".to_string(),
            asked_at: None,
        }
    }

    /// A killed `claude` fires no closing hook, so the tracker's last word
    /// stands forever. Every surface that reads a runtime was therefore folding
    /// a dead tree as live work: the menu bar counted it as running, the tray
    /// row still asked for attention, and the sleep vetoes still protected it —
    /// while the frontend, which had the exit, correctly said the session cost
    /// nothing to stop. One fact, two homes, two answers.
    #[test]
    fn a_runtime_told_its_session_died_asks_for_nothing() {
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        rt.note_hook_event(&ev("Notification"));
        let _ = rt.apply_recompute(now);
        assert!(rt.needs_you(), "waiting on the user");

        rt.note_exited();

        assert!(rt.exited());
        assert!(!rt.needs_you(), "a dead session needs nothing");
    }

    #[test]
    fn a_dead_session_is_not_running_however_its_turn_froze() {
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        rt.note_hook_event(&ev("UserPromptSubmit"));
        let _ = rt.apply_recompute(now);
        assert_eq!(rt.status(), SessionStatus::Running);
        assert!(rt.is_running());

        // SIGKILL mid-turn: no `Stop` ever arrives, so the status stays put.
        rt.note_exited();

        assert_eq!(
            rt.status(),
            SessionStatus::Running,
            "the committed status is history, and stays readable"
        );
        assert!(!rt.is_running(), "but nothing is running any more");
    }

    #[test]
    fn a_live_hook_retires_a_recorded_exit() {
        // Only a running claude fires a hook, so one is proof the session is
        // back — the resume path after a crash or a wake.
        let mut rt = SessionRuntime::new();
        rt.note_exited();
        assert!(rt.exited());

        rt.note_hook_event(&ev("SessionStart"));

        assert!(!rt.exited(), "it is alive again");
    }

    /// [Hooks off]: no hook will ever retire a status seeded or tracked
    /// before the settings change, so nothing derived from it may claim the
    /// user's attention or count as live work (ADR-0029).
    #[test]
    fn a_runtime_with_hooks_off_asks_for_nothing_until_a_hook_fires() {
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        rt.note_hook_event(&ev("UserPromptSubmit"));
        let _ = rt.apply_recompute(now);
        assert!(rt.set_ask(Some(ask())));
        assert!(rt.needs_you() && rt.is_running());

        rt.note_hooks_off(true);

        assert!(rt.hooks_off());
        assert!(!rt.needs_you(), "an unknowable status needs nothing");
        assert!(!rt.is_running(), "and is not counted as running");

        // A hook arriving proves the hooks run after all.
        rt.note_hook_event(&ev("Stop"));
        assert!(!rt.hooks_off());
    }

    #[test]
    fn a_history_seed_never_records_an_exit() {
        // A replay describes processes that may be long gone, and proves
        // nothing either way. Claiming an exit here would blank a live
        // session's badge on every launch.
        let rt = SessionRuntime::from_history(&[ev("Stop")], None, Instant::now());
        assert!(!rt.exited());
    }

    fn env(window_focused: bool, active_is_this: bool) -> ObserveEnv {
        ObserveEnv {
            window_focused,
            active_is_this,
            preference: crate::status::NotifyPreference::All,
        }
    }

    fn timing() -> SettleTiming {
        SettleTiming {
            settle: crate::status::NOTIFY_SETTLE,
            quiet: crate::status::PTY_QUIET,
            max_defer: crate::status::NOTIFY_MAX_DEFER,
        }
    }

    /// The whole settle policy in one fold: a turn that ends off-screen is
    /// unseen-done, arms a fire rather than firing, and delivers it once the
    /// window has elapsed.
    #[test]
    fn a_turn_ending_off_screen_arms_a_fire_and_delivers_it_once_settled() {
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        rt.note_hook_event(&ev("UserPromptSubmit"));
        let _ = rt.observe(now, &env(true, true));

        rt.note_hook_event(&ev("Notification"));
        let outcome = rt.observe(now, &env(false, false));

        assert_eq!(
            outcome.change.as_ref().map(|c| c.status),
            Some(SessionStatus::Waiting)
        );
        assert!(outcome.decision.is_some_and(|d| d.should_fire()));
        assert!(
            rt.claim_settled(now, &timing()).is_none(),
            "nothing fires before the settle window"
        );

        let settled = now + crate::status::NOTIFY_SETTLE;
        let claim = rt.claim_settled(settled, &timing()).expect("now it fires");
        assert_eq!(claim.next, SessionStatus::Waiting);
    }

    /// The claim is the disarm, so the live event and the 2 s ticker cannot
    /// both deliver the same notification.
    #[test]
    fn a_settled_notification_is_claimed_exactly_once() {
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        rt.note_hook_event(&ev("Notification"));
        let _ = rt.observe(now, &env(false, false));

        let settled = now + crate::status::NOTIFY_SETTLE;
        assert!(rt.claim_settled(settled, &timing()).is_some());
        assert!(
            rt.claim_settled(settled, &timing()).is_none(),
            "a second pass must find nothing left to deliver"
        );
    }

    /// The spurious attention state this deferral exists for: it flips straight
    /// back to work, and the arm goes with it, so nothing ever pings.
    #[test]
    fn leaving_an_attention_state_withdraws_and_disarms() {
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        rt.note_hook_event(&ev("Notification"));
        let _ = rt.observe(now, &env(false, false));

        rt.note_hook_event(&ev("UserPromptSubmit"));
        let outcome = rt.observe(now, &env(false, false));

        assert!(outcome.withdraw, "the banner shown for it is stale");
        assert!(
            rt.claim_settled(now + crate::status::NOTIFY_SETTLE, &timing())
                .is_none(),
            "the pending fire was cancelled with it"
        );
    }

    /// A recompute that commits nothing leaves the shell nothing to do — and
    /// must not touch the machinery on the way past.
    #[test]
    fn an_unchanged_status_asks_the_shell_for_nothing() {
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        rt.note_hook_event(&ev("Notification"));
        let _ = rt.observe(now, &env(false, false));

        let again = rt.observe(now, &env(false, false));

        assert!(again.change.is_none());
        assert!(!again.withdraw);
        assert!(again.decision.is_none());
        assert!(
            rt.claim_settled(now + crate::status::NOTIFY_SETTLE, &timing())
                .is_some(),
            "the arm from the real transition still stands"
        );
    }

    #[test]
    fn needs_you_is_waiting_or_open_ask() {
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        assert!(!rt.needs_you(), "idle, no ask");

        // Running with an open ask (mid-turn permission) needs the user.
        rt.note_hook_event(&ev("UserPromptSubmit"));
        let _ = rt.apply_recompute(now);
        assert_eq!(rt.status(), SessionStatus::Running);
        assert!(!rt.needs_you());
        assert!(rt.set_ask(Some(ask())));
        assert!(rt.needs_you());

        // Ask clears, turn ends: no longer needs the user.
        assert!(rt.set_ask(None));
        rt.note_hook_event(&ev("Stop"));
        let _ = rt.apply_recompute(now);
        assert!(!rt.needs_you());
    }

    #[test]
    fn set_ask_reports_change_only_on_change() {
        let mut rt = SessionRuntime::new();
        assert!(!rt.set_ask(None), "None → None is no change");
        assert!(rt.set_ask(Some(ask())));
        assert!(!rt.set_ask(Some(ask())), "same ask is no change");
        assert!(rt.set_ask(None));
    }

    #[test]
    fn unseen_done_counts_until_seen_or_a_new_turn() {
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        rt.note_hook_event(&ev("UserPromptSubmit"));
        rt.note_hook_event(&ev("Stop"));
        let _ = rt.apply_recompute(now);
        assert!(!rt.needs_you(), "done alone is not attention");

        // The shell saw the Done land off-screen.
        rt.note_unseen_done();
        assert!(rt.needs_you(), "finished-with-unseen-output needs the user");

        // Focusing the session clears it…
        rt.mark_seen();
        assert!(!rt.needs_you());

        // …and so does a new turn starting.
        rt.note_unseen_done();
        rt.note_hook_event(&ev("UserPromptSubmit"));
        let _ = rt.apply_recompute(now);
        assert!(!rt.needs_you(), "a new turn re-engages the session");
    }

    #[test]
    fn notify_arm_settles_after_the_window_then_disarms() {
        use std::time::Duration;
        let settle = Duration::from_secs(2);
        let now = Instant::now();
        let mut rt = SessionRuntime::new();

        // Nothing armed → never ready.
        assert!(rt
            .notify_ready(
                now,
                settle,
                Duration::from_millis(600),
                Duration::from_secs(15)
            )
            .is_none());

        // Arm on a Running → Waiting transition; not ready until the window passes.
        rt.arm_notify(now, SessionStatus::Running);
        assert!(
            rt.notify_ready(
                now,
                settle,
                Duration::from_millis(600),
                Duration::from_secs(15)
            )
            .is_none(),
            "inside the settle window"
        );
        assert!(rt
            .notify_ready(
                now + Duration::from_secs(1),
                settle,
                Duration::from_millis(600),
                Duration::from_secs(15)
            )
            .is_none());

        // Past the window it is ready, reporting the stashed pre-attention status.
        let later = now + settle;
        assert_eq!(
            rt.notify_ready(
                later,
                settle,
                Duration::from_millis(600),
                Duration::from_secs(15)
            ),
            Some(SessionStatus::Running)
        );

        // Re-arming while already armed keeps the first arm (one fire per episode).
        rt.arm_notify(later, SessionStatus::Done);
        assert_eq!(
            rt.notify_ready(
                later,
                settle,
                Duration::from_millis(600),
                Duration::from_secs(15)
            ),
            Some(SessionStatus::Running)
        );

        // Disarm clears it — a spurious flash that left attention never fires.
        rt.disarm_notify();
        assert!(rt
            .notify_ready(
                later,
                settle,
                Duration::from_millis(600),
                Duration::from_secs(15)
            )
            .is_none());
    }

    #[test]
    fn a_noisy_pty_holds_the_notification_back_without_dropping_it() {
        // The terminal is still painting, so whatever the hook said, the turn is
        // not settled — Claude is mid-sentence, or a Stop hook resumed it. Hold
        // the fire, but stay armed: the 2s ticker re-drives this, so the moment
        // the pty falls quiet the notification still goes out.
        use std::time::Duration;
        let (settle, quiet, cap) = (
            Duration::from_secs(2),
            Duration::from_millis(600),
            Duration::from_secs(15),
        );
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        rt.arm_notify(now, SessionStatus::Running);

        // Past the settle window, but the pty produced bytes just now.
        let ready_at = now + settle;
        rt.note_pty_output(ready_at);
        assert!(
            rt.notify_ready(ready_at, settle, quiet, cap).is_none(),
            "the terminal is still painting"
        );
        // Still noisy a moment later: bytes keep arriving.
        let noisy = ready_at + Duration::from_millis(500);
        rt.note_pty_output(noisy);
        assert!(rt.notify_ready(noisy, settle, quiet, cap).is_none());

        // The pty falls quiet — now it fires, still reporting the stashed status.
        let calm = noisy + quiet;
        assert_eq!(
            rt.notify_ready(calm, settle, quiet, cap),
            Some(SessionStatus::Running)
        );
    }

    #[test]
    fn a_pty_that_never_falls_quiet_still_notifies_once_the_cap_passes() {
        // A TUI that repaints forever must not starve the notification: past the
        // deferral cap the veto yields. Holding a "needs you" back indefinitely
        // is worse than firing it a little late.
        use std::time::Duration;
        let (settle, quiet, cap) = (
            Duration::from_secs(2),
            Duration::from_millis(600),
            Duration::from_secs(15),
        );
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        rt.arm_notify(now, SessionStatus::Running);

        let overdue = now + cap;
        rt.note_pty_output(overdue); // still noisy at the moment we check
        assert_eq!(
            rt.notify_ready(overdue, settle, quiet, cap),
            Some(SessionStatus::Running),
            "the cap must win over an endlessly noisy pty"
        );
    }

    #[test]
    fn a_session_with_no_observed_output_is_never_vetoed() {
        // Nothing has ever been seen on this session's pty (it is detached, or
        // the daemon is not streaming): the veto has no evidence and must not
        // invent any — behave exactly as before.
        use std::time::Duration;
        let (settle, quiet, cap) = (
            Duration::from_secs(2),
            Duration::from_millis(600),
            Duration::from_secs(15),
        );
        let now = Instant::now();
        let mut rt = SessionRuntime::new();
        rt.arm_notify(now, SessionStatus::Running);
        assert_eq!(
            rt.notify_ready(now + settle, settle, quiet, cap),
            Some(SessionStatus::Running)
        );
    }

    #[test]
    fn from_history_never_seeds_unseen_done() {
        // A seed replays finished turns from long ago; lighting the badge for
        // every old session on every app launch would be noise, not attention.
        let events = [ev("SessionStart"), ev("UserPromptSubmit"), ev("Stop")];
        let rt = SessionRuntime::from_history(&events, Some("main"), Instant::now());
        assert_eq!(rt.status(), SessionStatus::Done);
        assert!(!rt.needs_you());
    }

    #[test]
    fn from_history_carries_both_status_and_ask() {
        let mut permission = ev("Notification");
        permission.message = Some("Claude needs your permission to use Bash".to_string());
        let events = [ev("SessionStart"), ev("UserPromptSubmit"), permission];
        let rt = SessionRuntime::from_history(&events, Some("main"), Instant::now());
        assert_eq!(rt.status(), SessionStatus::Waiting);
        assert!(rt.ask().is_some());
        assert!(rt.needs_you());
    }
}
