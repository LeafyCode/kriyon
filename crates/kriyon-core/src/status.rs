//! Status fusion: pure logic deriving a session's [`SessionStatus`] and one-line
//! summary from Claude Code hook events, and the OS-notification policy.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::hook_signal::{classify, Actor, HookSignal, ToolCall, ToolPhase, TurnEnd};
use crate::hooks::{HookEvent, NotificationKind};
use crate::main_session::MainSessionLock;
use crate::session::SessionStatus;

/// Seconds within which a repeat notification for the same session is
/// suppressed as a duplicate.
pub const NOTIFY_COALESCE_SECS: u64 = 5;

/// How long an attention transition must stay put before it notifies. A state
/// that flips back to work inside this window — a spurious idle prompt, an
/// auto-granted permission — is disarmed and never pings. Sub-tick (the badge
/// ticker runs every 2s), so a genuine block still surfaces within ~1 tick.
/// Notifications only fire off-screen, so this small delay is never felt.
pub const NOTIFY_SETTLE: Duration = Duration::from_millis(1500);

/// How quiet a session's pty must be before a settled notification actually
/// fires. Hook events and terminal bytes arrive on separate channels with no
/// ordering between them, so a `Stop` can land while the screen is still
/// filling; waiting for the terminal to stop painting is the confirmation the
/// hook alone cannot give. Short enough to sit inside one badge tick.
pub const PTY_QUIET: Duration = Duration::from_millis(600);

/// The longest a notification may be held back by [`PTY_QUIET`]. A TUI that
/// repaints forever would otherwise starve a genuine "needs you" — past this the
/// veto yields and the notification fires late rather than never.
pub const NOTIFY_MAX_DEFER: Duration = Duration::from_secs(15);

/// Whether a status is one the user should be pulled in for: the session is
/// waiting on them, finished, or errored. `Running`/`Idle` are not — the agent
/// is working or nothing is happening. The single source of truth for both the
/// notify-on-enter ([`should_notify`]) and withdraw-on-leave
/// ([`should_withdraw_notification`]) edges.
#[must_use]
pub fn is_attention_status(status: SessionStatus) -> bool {
    matches!(
        status,
        SessionStatus::Waiting | SessionStatus::Done | SessionStatus::Error
    )
}

/// Whether a delivered notification for a `prev → next` transition is now stale
/// and should be pulled from the OS. True exactly when the session *leaves* an
/// attention state for a non-attention one (`Waiting`/`Done`/`Error` →
/// `Running`/`Idle`): the user answered the prompt, or Claude resumed on its own,
/// so a lingering "needs you" banner would misreport a state that has passed.
///
/// A move *between* attention states (the `Done`↔`Waiting` burst at a turn's
/// end) is deliberately not a withdraw — it must not pull the very banner that
/// burst is raising.
#[must_use]
pub fn should_withdraw_notification(prev: SessionStatus, next: SessionStatus) -> bool {
    is_attention_status(prev) && !is_attention_status(next)
}

/// Decide whether a transition from `prev` to `next` warrants an OS
/// notification, given window focus and time since the last notification.
#[must_use]
pub fn should_notify(
    prev: SessionStatus,
    next: SessionStatus,
    focused: bool,
    secs_since_last_notify: Option<u64>,
) -> bool {
    // Never notify the session the user is currently looking at.
    if focused {
        return false;
    }

    // Notify only on a transition into an attention state.
    if next == prev || !is_attention_status(next) {
        return false;
    }

    // Coalesce duplicate notifications fired in quick succession.
    if let Some(s) = secs_since_last_notify {
        if s < NOTIFY_COALESCE_SECS {
            return false;
        }
    }

    true
}

/// The user's cross-project preference for OS notifications, layered on top of
/// [`should_notify`]: it gates which status transitions are allowed to notify
/// at all, regardless of focus/coalescing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum NotifyPreference {
    /// Notify on every transition `should_notify` permits.
    #[default]
    All,
    /// Notify only when a session becomes blocked (waiting on the user).
    OnlyBlocked,
    /// Never notify.
    None,
}

/// The user's chosen OS-notification sound. `Default` keeps the system alert;
/// `Silent` posts a banner with no sound; the rest name a `.wav` bundled in the
/// app's Resources root (see `src-tauri/sounds/`). Distinct from
/// [`NotifyPreference`], which gates *which* sessions notify at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum NotifySound {
    /// The macOS default notification sound (current behavior).
    #[default]
    Default,
    /// No sound — banner only.
    Silent,
    Marimba,
    MusicBox,
    Vibraphone,
    Kalimba,
    Bell,
}

/// The concrete playback decision for a [`NotifySound`] — total over the enum,
/// so every consumer matches it exhaustively instead of reconstructing the
/// three-way choice from separate accessors. Adding a `NotifySound` variant is
/// then a compile error at *every* call site, not a silent fallthrough.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifySoundKind {
    /// Post the banner with no audible cue.
    Silent,
    /// Use the macOS default alert sound.
    System,
    /// Play the bundled `.wav` with this filename, resolved against the app's
    /// Resources root (what `UNNotificationSound(named:)` / `NSSound` load).
    Bundled(&'static str),
}

impl NotifySound {
    /// Resolve this choice to its concrete [`NotifySoundKind`] — the single
    /// place the Silent / system-default / bundled-file decision lives.
    #[must_use]
    pub fn kind(self) -> NotifySoundKind {
        match self {
            NotifySound::Silent => NotifySoundKind::Silent,
            NotifySound::Default => NotifySoundKind::System,
            NotifySound::Marimba => NotifySoundKind::Bundled("marimba.wav"),
            NotifySound::MusicBox => NotifySoundKind::Bundled("music_box.wav"),
            NotifySound::Vibraphone => NotifySoundKind::Bundled("vibraphone.wav"),
            NotifySound::Kalimba => NotifySoundKind::Bundled("kalimba.wav"),
            NotifySound::Bell => NotifySoundKind::Bundled("bell.wav"),
        }
    }
}

/// Whether the user's cross-project preference permits notifying about a
/// transition into `next`, layered on top of `should_notify`.
#[must_use]
pub fn preference_allows(pref: NotifyPreference, next: SessionStatus) -> bool {
    match pref {
        NotifyPreference::All => true,
        NotifyPreference::None => false,
        NotifyPreference::OnlyBlocked => next == SessionStatus::Waiting,
    }
}

/// Everything the OS-notification decision reads for one committed status
/// change. Gathered from the app state by `status_rt.rs`, which owns the locks;
/// this struct keeps the *decision* pure and testable.
#[derive(Clone, Copy, Debug)]
pub struct NotifyDecision {
    /// The status the session moved from.
    pub prev: SessionStatus,
    /// The status it moved to.
    pub next: SessionStatus,
    /// The Kriyon window itself is focused.
    pub window_focused: bool,
    /// This session is the active (selected) one.
    pub active_is_this: bool,
    /// A notification is already outstanding for this "needs you" episode (the
    /// latch), so the Done↔Waiting burst at a turn's end pings only once.
    pub already_unread: bool,
    /// The user's cross-project [`NotifyPreference`].
    pub preference: NotifyPreference,
    /// Seconds since the last notification for this session, for coalescing.
    pub secs_since_last_notify: Option<u64>,
}

impl NotifyDecision {
    /// A session is "on screen" — and so not worth notifying about — only when
    /// the Kriyon window is focused *and* this is the active session. Switch to
    /// another app and the active session should still notify.
    #[must_use]
    pub fn on_screen(&self) -> bool {
        self.window_focused && self.active_is_this
    }

    /// Whether to fire an OS notification now. Composes the three tested
    /// predicates ([`should_notify`], [`preference_allows`], the unread latch)
    /// with the on-screen rule, so the whole decision lives and is tested in one
    /// place instead of as inline glue in the Tauri shell.
    #[must_use]
    pub fn should_fire(&self) -> bool {
        !self.already_unread
            && should_notify(
                self.prev,
                self.next,
                self.on_screen(),
                self.secs_since_last_notify,
            )
            && preference_allows(self.preference, self.next)
    }
}

/// A committed status transition: the new status + summary plus the context the
/// notification policy needs (`prev` status and time since the last notify).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusChange {
    pub status: SessionStatus,
    pub summary: String,
    pub prev: SessionStatus,
    pub secs_since_last_notify: Option<u64>,
}

/// Per-session state that derives a live [`SessionStatus`] + summary. Owns the
/// fusion: the shell feeds it events and a clock (`Instant`), drives
/// [`StatusTracker::apply_recompute`], and emits the returned [`StatusChange`].
#[derive(Clone, Debug)]
pub struct StatusTracker {
    last_status: SessionStatus,
    last_summary: String,
    /// When the last OS notification fired, used to coalesce duplicates.
    last_notify_at: Option<Instant>,
    /// Whether an OS notification is already outstanding for the current "needs
    /// you" episode. Latched on notify ([`StatusTracker::record_notified`]) and
    /// cleared when the session next transitions into `Running`
    /// ([`StatusTracker::apply_recompute`]). While set, further attention
    /// transitions are suppressed, so one turn's end — which Claude Code expresses
    /// as a burst of `Stop`/`Notification` hooks flipping the status Done↔Waiting
    /// — yields a single notification, not one per flip; the next turn re-arms it.
    unread_notification: bool,
    /// Whether a Claude Code hook event has driven this tracker yet — until
    /// then it reads Idle, and live seeding may still replace it.
    hook_driven: bool,
    hook_status: Option<SessionStatus>,
    hook_summary: String,
    /// What a current `Waiting` holds for the user. Set exactly when the
    /// status is `Waiting` (see [`Self::set`]), so a Waiting can never lose
    /// its owner.
    waiting: Option<Waiting>,
    /// Which claude session is this terminal's main agent. Nested claude —
    /// subagents and one-shot `claude -p` invocations — inherit `KRIYON_SESSION`
    /// and emit their own lifecycle events into the same events file; honoring
    /// those would flap the main session's status (Done↔Idle). The lock drives
    /// status from the main session's events only, and converges on the live
    /// session across restarts (see [`MainSessionLock`]). Shared with
    /// [`crate::activity::HookActivity`] so status and the Inspector agree.
    main_lock: MainSessionLock,
    /// Where the [Main agent]'s own turn stands. Separates "Running because
    /// Claude is mid-turn" from "Running because the turn ended but [Background
    /// agent]s are still working" — the idle prompt means a block is on screen
    /// only in the first.
    main_turn: MainTurn,
    /// Whether the main agent's last `Stop` settled its turn (Done or Error)
    /// rather than pausing it on [Background agent]s. Only a settled turn was
    /// announced, so only a re-entry after one is the same turn told twice.
    last_stop_settled: bool,
    /// When the main agent's newest prompt was submitted (ms since the
    /// epoch, from its hook's `ts`): a turn end recorded before it belongs to
    /// an earlier turn and settles nothing.
    last_prompt_ms: Option<i64>,
}

/// Where the [Main turn] stands, as [`StatusTracker`] sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MainTurn {
    /// In flight: opened by the main agent's prompt or tool events.
    /// `in_own_tool` is whether the main agent is inside a tool of its own
    /// (not a [Subagent] spawn) — then a block on screen is the main agent's.
    Open { in_own_tool: bool },
    /// Over, leaving this many [Background agent]s in flight. Claude Code
    /// resends the whole list on every `Stop`, so each one replaces the count.
    Ended { background_agents: usize },
}

impl MainTurn {
    const IDLE: Self = Self::Ended {
        background_agents: 0,
    };
    const OPEN: Self = Self::Open { in_own_tool: false };

    fn is_open(self) -> bool {
        matches!(self, Self::Open { .. })
    }

    fn in_own_tool(self) -> bool {
        self == Self::Open { in_own_tool: true }
    }

    fn awaits_agents(self) -> bool {
        matches!(self, Self::Ended { background_agents } if background_agents > 0)
    }
}

/// What a `Waiting` status holds for the user.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Waiting {
    /// Whose request it is — so that only the agent that asked can lift it
    /// by carrying on.
    owner: WaitingFor,
    /// Whether it came from a definite block signal (a permission gate, or an
    /// idle prompt landing mid-turn) rather than the conservative fallback for
    /// an unrecognized `Notification`. Only an unconfirmed Waiting may be
    /// settled to Done by a later idle prompt — so an unknown message can't
    /// wedge the badge, and a real block can't be dismissed by the nudge that
    /// follows it.
    confirmed: bool,
}

/// Whose request a `Waiting` status holds for the user.
#[derive(Clone, Debug, PartialEq, Eq)]
enum WaitingFor {
    /// The [Main agent], blocked inside a tool of its own.
    MainAgent,
    /// The [Subagent] with this `agent_id`.
    Subagent(String),
    /// Claude Code did not say (a notification names no agent) and the main
    /// agent is not inside a tool — most likely a [Subagent]'s dialog.
    Unattributed,
}

impl StatusTracker {
    /// A fresh tracker for a session that has produced no events yet. `now` is
    /// taken at construction; it is overwritten by the first noted event.
    #[must_use]
    pub fn new() -> Self {
        Self {
            last_status: SessionStatus::Idle,
            last_summary: String::new(),
            last_notify_at: None,
            unread_notification: false,
            hook_driven: false,
            hook_status: None,
            hook_summary: String::new(),
            waiting: None,
            main_lock: MainSessionLock::new(),
            main_turn: MainTurn::IDLE,
            last_stop_settled: false,
            last_prompt_ms: None,
        }
    }

    /// Record a Claude Code hook event, marking the session hook-driven.
    ///
    /// Events from a *nested* claude session (a subagent or a one-shot
    /// `claude -p` that inherited `KRIYON_SESSION`) are ignored for status: only
    /// the main agent's own lifecycle drives the displayed status, so a nested
    /// claude finishing can't flap the main session Done↔Idle.
    pub fn note_hook_event(&mut self, event: &HookEvent) {
        if !self.main_lock.observe(event) {
            return;
        }
        let signal = classify(event);
        if signal == HookSignal::Unrecognized {
            return;
        }
        self.hook_driven = true;
        match signal {
            HookSignal::Notified(kind) => self.note_notification(kind),
            HookSignal::Tool(call) if call.actor != Actor::Main => self.note_subagent_tool(call),
            HookSignal::Tool(call) => {
                self.set(SessionStatus::Running, tool_summary(call));
                self.main_turn = MainTurn::Open {
                    in_own_tool: call.phase == ToolPhase::Started && !call.spawns_agent(),
                };
            }
            HookSignal::PromptSubmitted => {
                self.last_prompt_ms = event
                    .ts
                    .as_deref()
                    .and_then(crate::activity_log::parse_iso_ms);
                self.set(SessionStatus::Running, "Working…".to_string());
                self.main_turn = MainTurn::OPEN;
            }
            // A permission dialog is a definite block, and leaves the turn
            // where it was.
            HookSignal::PermissionRequested(actor) => {
                let owner = match actor {
                    Actor::Subagent(id) => WaitingFor::Subagent(id.to_string()),
                    Actor::Main => self.attribute_block(),
                };
                self.set_waiting(
                    "Needs permission",
                    Waiting {
                        owner,
                        confirmed: true,
                    },
                );
            }
            HookSignal::TurnEnded(end) if end.failed => {
                self.set(SessionStatus::Error, error_summary(event.error.as_deref()));
                self.main_turn = MainTurn::IDLE;
                self.last_stop_settled = true;
            }
            HookSignal::TurnEnded(end) => self.note_stop(end),
            HookSignal::SessionStarted | HookSignal::SessionEnded => {
                self.set(SessionStatus::Idle, String::new());
                self.main_turn = MainTurn::IDLE;
            }
            HookSignal::Unrecognized => {}
        }
    }

    /// The user stopped the turn with Esc. Claude Code fires no hook for an
    /// interrupt (no `Stop`), so without this a stopped turn stays `Running`
    /// until the next prompt. Only a running main turn is ended; a settled
    /// status keeps its word.
    pub fn note_user_interrupt(&mut self) {
        if self.hook_status != Some(SessionStatus::Running) {
            return;
        }
        self.set(SessionStatus::Idle, "Interrupted".to_string());
        self.main_turn = MainTurn::IDLE;
    }

    /// The transcript recorded the main turn's end, at `ended_ms`, while the
    /// status still says `Running` — its `Stop` was missed or, when
    /// `interrupted`, its Esc went unseen (Ctrl+C, an interrupt row slow to
    /// land). Settled as that `Stop` or [`Self::note_user_interrupt`] would
    /// have, minus the background-agent count a `Stop` would have carried —
    /// but only for a turn that ended after the newest prompt: an earlier
    /// turn's end says nothing about the one now running, and with no prompt
    /// time to compare against nothing is settled. A `Stop` that was seen and
    /// left the session waiting on its agents keeps its word.
    pub fn note_turn_ended(&mut self, ended_ms: i64, interrupted: bool) {
        let after_prompt = self.last_prompt_ms.is_some_and(|p| ended_ms > p);
        if self.hook_status != Some(SessionStatus::Running)
            || !after_prompt
            || self.main_turn.awaits_agents()
        {
            return;
        }
        if interrupted {
            self.note_user_interrupt();
            return;
        }
        self.set(SessionStatus::Done, "Done".to_string());
        self.main_turn = MainTurn::Ended {
            background_agents: 0,
        };
        self.last_stop_settled = true;
    }

    /// Commit a hook-derived status and summary. Any new status clears
    /// [`Self::waiting`]; [`Self::set_waiting`] sets it where it applies.
    fn set(&mut self, status: SessionStatus, summary: String) {
        self.hook_status = Some(status);
        self.hook_summary = summary;
        self.waiting = None;
    }

    fn set_waiting(&mut self, summary: &str, waiting: Waiting) {
        self.set(SessionStatus::Waiting, summary.to_string());
        self.waiting = Some(waiting);
    }

    /// Whose block has just appeared on screen, when the signal itself names
    /// no agent. A block already attributed keeps its owner — the
    /// notification that follows a permission request is about the same
    /// dialog.
    fn attribute_block(&self) -> WaitingFor {
        if let Some(waiting) = &self.waiting {
            return waiting.owner.clone();
        }
        if self.main_turn.in_own_tool() {
            WaitingFor::MainAgent
        } else {
            WaitingFor::Unattributed
        }
    }

    /// The main agent's turn ended. Done — unless it reports [Background
    /// agent]s still in flight, in which case Claude is paused, not finished: it
    /// wakes itself when they report back, and the `Stop` ending that turn
    /// carries a fresh list. A `Stop` from a build that predates the list is
    /// taken at its word, as before.
    ///
    /// An agent's block still on screen outlives the main turn: the session
    /// keeps waiting on the user rather than on its agents.
    fn note_stop(&mut self, end: TurnEnd<'_>) {
        let background_agents = end.in_flight.background_agents().unwrap_or(0);
        self.main_turn = MainTurn::Ended { background_agents };
        let announced_before = self.last_stop_settled;
        self.last_stop_settled = background_agents == 0;
        if background_agents > 0 {
            let agent_still_asks =
                matches!(&self.waiting, Some(waiting) if waiting.owner != WaitingFor::MainAgent);
            if !agent_still_asks {
                self.set(
                    SessionStatus::Running,
                    awaiting_agents_summary(background_agents),
                );
            }
            return;
        }
        self.set(SessionStatus::Done, "Done".to_string());
        // A `Stop` hook that blocked made Claude carry on, and the turn is now
        // ending again. The user saw one turn and was already told about it —
        // the `Running` in between cleared the latch, so re-latch here to keep
        // the re-entry from announcing it twice. Only a turn that ends Done was
        // announced; one paused on agents announced nothing — neither this
        // `Stop` nor the one it re-enters from.
        if end.reentry && announced_before {
            self.unread_notification = true;
        }
    }

    /// A [Subagent]'s own tool event. It says the agent is working, which the
    /// main agent's `Stop` list already accounts for, so it never reopens a
    /// finished session: after a `Stop` that listed no agent, a straggling
    /// event from a killed one must not wedge it in Running. It does:
    ///
    /// - lift a block the same agent raised (it carrying on is proof the block
    ///   was answered), or an unattributed one while the main agent is not
    ///   inside a tool of its own — never the main agent's own question;
    /// - name the work in the summary while the main turn is open (a foreground
    ///   subagent);
    /// - count as work for a tracker that has seen nothing else yet.
    fn note_subagent_tool(&mut self, call: ToolCall<'_>) {
        let Actor::Subagent(agent) = call.actor else {
            return;
        };
        match self.hook_status {
            Some(SessionStatus::Waiting) => {
                let lifts = match self.waiting.as_ref().map(|waiting| &waiting.owner) {
                    Some(WaitingFor::MainAgent) => false,
                    Some(WaitingFor::Subagent(asker)) => asker == agent,
                    Some(WaitingFor::Unattributed) | None => !self.main_turn.in_own_tool(),
                };
                if lifts {
                    let summary = match self.main_turn {
                        MainTurn::Open { .. } => tool_summary(call),
                        MainTurn::Ended { background_agents } => {
                            awaiting_agents_summary(background_agents)
                        }
                    };
                    self.set(SessionStatus::Running, summary);
                }
            }
            Some(SessionStatus::Running) if self.main_turn.is_open() => {
                self.hook_summary = tool_summary(call);
            }
            None => self.set(SessionStatus::Running, tool_summary(call)),
            _ => {}
        }
    }

    /// Fold a classified `Notification` into the status, so the result does
    /// not depend on which earlier events this watch happened to see (a
    /// re-subscribe can miss the preceding `Stop`):
    ///
    /// - A `Block` — a permission gate or an MCP elicitation dialog — is a
    ///   genuine block: always Waiting, confirmed.
    /// - An `Informational` notification (a login succeeded, an elicitation
    ///   resolved, a *background agent's* own lifecycle) asks nothing of this
    ///   session and leaves the status untouched. Treating these as blocks was
    ///   the stale-"needs attention" misfire: they arrive mid-turn and would flip
    ///   a busy session to Waiting.
    /// - The idle prompt depends on where the turn stands. While the main turn
    ///   is over but [Background agent]s still run, it asks nothing and is
    ///   ignored. Mid-turn (`Running`) the prompt can only sit idle because a
    ///   TUI block — question, plan approval, permission — is on screen, so it
    ///   is a confirmed Waiting (the pre-existing behaviour a blocked
    ///   `AskUserQuestion` relies on for its OS notification). A confirmed
    ///   Waiting stays put. Anywhere else — after Done, or as the first event of
    ///   a window that missed the `Stop` — the turn is over: Done, never a
    ///   wedge.
    /// - An `Unknown` notification (no type and unrecognized prose — only older
    ///   Claude Code gets here) keeps the conservative rule: Waiting, except
    ///   straight after Done (the turn-end burst must not flap Done↔Waiting) —
    ///   but *unconfirmed*, so a later idle prompt settles it to Done instead
    ///   of wedging a phantom onto the menu-bar badge.
    fn note_notification(&mut self, kind: NotificationKind) {
        match kind {
            NotificationKind::Block => self.note_block(true),
            NotificationKind::IdlePrompt => match self.hook_status {
                Some(SessionStatus::Waiting)
                    if self.waiting.as_ref().is_some_and(|w| w.confirmed) => {}
                Some(SessionStatus::Running) if self.main_turn.is_open() => {
                    self.note_block(true);
                }
                // The turn is over but agents are still in flight: the prompt
                // is idle because Claude is waiting on them, not on the user.
                Some(SessionStatus::Running) if self.main_turn.awaits_agents() => {}
                _ => self.set(SessionStatus::Done, "Done".to_string()),
            },
            // Asks nothing of this session — leave the status exactly as it was.
            NotificationKind::Informational => {}
            NotificationKind::Unknown => {
                if self.hook_status != Some(SessionStatus::Done) {
                    self.note_block(false);
                }
            }
        }
    }

    /// A block on screen that the notification itself does not attribute.
    fn note_block(&mut self, confirmed: bool) {
        let owner = self.attribute_block();
        self.set_waiting("Waiting for you", Waiting { owner, confirmed });
    }

    /// Anchor the main session to the id reported by the status-line wrapper
    /// (which only the main interactive TUI renders), correcting a heuristic
    /// mis-lock and re-anchoring after a restart that produced no `SessionEnd`.
    /// See [`MainSessionLock::set_authoritative`].
    pub fn set_authoritative_main(&mut self, session_id: &str) {
        self.main_lock.set_authoritative(session_id);
    }

    /// The claude session id currently locked as this terminal's main agent, if
    /// any. Mirrors [`crate::activity::HookActivity::main_session_id`]: fed the
    /// same hook stream and the same authoritative id, the two must agree.
    #[must_use]
    pub fn main_session_id(&self) -> Option<&str> {
        self.main_lock.current()
    }

    /// Stamp the last-notified clock and latch the unread flag after the shell
    /// dispatches a notification. The latch suppresses repeat notifications for
    /// the same "needs you" episode — the burst of Done↔Waiting transitions
    /// Claude Code emits as one turn ends — until the session begins a *new* work
    /// cycle (a transition into [`SessionStatus::Running`] clears it in
    /// [`StatusTracker::apply_recompute`]), at which point the next completion
    /// notifies afresh.
    pub fn record_notified(&mut self, now: Instant) {
        self.last_notify_at = Some(now);
        self.unread_notification = true;
    }

    /// Whether a notification is already outstanding for the current "needs you"
    /// episode. The shell consults this to suppress repeat notifications until the
    /// session starts a new turn (which clears the latch, see `apply_recompute`).
    #[must_use]
    pub fn has_unread_notification(&self) -> bool {
        self.unread_notification
    }

    /// Seconds since the last OS notification fired for this session, or `None`
    /// if none has. Lets the deferred-notification path coalesce against a recent
    /// fire the same way `apply_recompute` does for an immediate one.
    #[must_use]
    pub fn secs_since_last_notify(&self, now: Instant) -> Option<u64> {
        self.last_notify_at
            .map(|t| now.saturating_duration_since(t).as_secs())
    }

    /// Whether a Claude Code hook event has driven this tracker yet. A
    /// hook-driven tracker is authoritative; seeding it from on-disk history
    /// (see [`replay_history`]) would only regress its main-session lock.
    #[must_use]
    pub fn is_hook_driven(&self) -> bool {
        self.hook_driven
    }

    /// The tracker's current committed status (updated by `apply_recompute`).
    #[must_use]
    pub fn status(&self) -> SessionStatus {
        self.last_status
    }

    /// The tracker's current committed one-line summary (updated by
    /// `apply_recompute`). Used to snapshot live state for a late-joining
    /// subscriber (e.g. the menu-bar popover on open).
    #[must_use]
    pub fn summary(&self) -> &str {
        &self.last_summary
    }

    fn recompute(&self) -> (SessionStatus, String) {
        (
            self.hook_status.unwrap_or(SessionStatus::Idle),
            self.hook_summary.clone(),
        )
    }

    /// Recompute the status + summary at `now`; if either changed, commit it and
    /// return the [`StatusChange`], else `None`.
    pub fn apply_recompute(&mut self, now: Instant) -> Option<StatusChange> {
        let (status, summary) = self.recompute();
        if (status, summary.as_str()) == (self.last_status, self.last_summary.as_str()) {
            return None;
        }
        let prev = self.last_status;
        let secs_since_last_notify = self
            .last_notify_at
            .map(|t| now.saturating_duration_since(t).as_secs());
        // A new work cycle opens a fresh "needs you" episode: clear the unread
        // latch so the completion (or block) that ends *this* turn notifies, even
        // if the user never refocused the session after the previous turn. Only a
        // transition *into* Running resets it — staying Running does not re-arm.
        if status == SessionStatus::Running && prev != SessionStatus::Running {
            self.unread_notification = false;
        }
        self.last_status = status;
        self.last_summary.clone_from(&summary);
        Some(StatusChange {
            status,
            summary,
            prev,
            secs_since_last_notify,
        })
    }
}

/// The summary for a tool event: what is running, or what just failed.
fn tool_summary(call: ToolCall<'_>) -> String {
    match (call.phase, call.name) {
        (ToolPhase::Failed, "") => "Tool failed".to_string(),
        (ToolPhase::Failed, name) => format!("{name} failed"),
        (_, "") => "Working…".to_string(),
        (_, name) => format!("Running {name}…"),
    }
}

/// The summary for a turn that died on an API error.
fn error_summary(error: Option<&str>) -> String {
    match error {
        Some(err) if !err.is_empty() => format!("Error: {err}"),
        _ => "Error".to_string(),
    }
}

/// The summary while the main turn is over but [Background agent]s still run.
fn awaiting_agents_summary(agents: usize) -> String {
    match agents {
        0 => "Agents working…".to_string(),
        1 => "Waiting on 1 agent…".to_string(),
        n => format!("Waiting on {n} agents…"),
    }
}

impl Default for StatusTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// What replaying a session's recorded hook events rebuilds: its status
/// tracker and its [Session activity projection], anchored to the same main
/// session. See [`replay_history`].
pub struct Replayed {
    pub tracker: StatusTracker,
    pub projection: crate::projection::SessionActivityProjection,
}

/// Replay a session's recorded hook events into a fresh tracker and activity
/// projection. Status and [Session activity] become a pure function of the
/// on-disk history instead of whichever events a live watch happened to see —
/// the shell seeds a just-subscribed session from this (app restart,
/// re-subscribe) so a blocked session counts on the menu-bar badge immediately
/// and a finished one can never masquerade as blocked. Both folds are the live
/// ones, so replay and live can never disagree, and both come from this one
/// replay, so the status seed and the activity seed can never disagree about
/// which session is the main one.
///
/// `authoritative_main` is the [Claude session id] the status-line wrapper
/// last reported (only the main interactive TUI renders one). When known, both
/// folds see only that session's events: the tail may open with an earlier
/// claude that died without `SessionEnd`, and the heuristic
/// [`crate::main_session::MainSessionLock`] — replaying blind — would lock onto
/// that corpse (an `Agent` spawn re-locks) and report *its* state. With no
/// anchor the heuristic fold runs as-is.
#[must_use]
pub fn replay_history(
    events: &[HookEvent],
    authoritative_main: Option<&str>,
    now: Instant,
) -> Replayed {
    let mut tracker = StatusTracker::new();
    let mut projection = crate::projection::SessionActivityProjection::new();
    if let Some(sid) = authoritative_main {
        tracker.set_authoritative_main(sid);
        projection.set_authoritative_main(sid);
    }
    let anchored = events.iter().filter(|event| match authoritative_main {
        Some(sid) => event.session_id.as_deref() == Some(sid),
        None => true,
    });
    for event in anchored {
        tracker.note_hook_event(event);
        projection.ingest(event);
    }
    // Commit the folded state so `status()`/`summary()` reflect the replay
    // immediately; the caller emits the resulting snapshot itself (silently —
    // a replayed transition must never fire an OS notification).
    let _ = tracker.apply_recompute(now);
    Replayed {
        tracker,
        projection,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_is_hook_driven_once_a_hook_is_seen() {
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        let event = HookEvent {
            event: "UserPromptSubmit".to_string(),
            ..HookEvent::default()
        };
        tracker.note_hook_event(&event);
        let change = tracker.apply_recompute(now).expect("hook drives status");
        assert_eq!(change.status, SessionStatus::Running);
    }

    #[test]
    fn an_interrupt_ends_a_running_turn_and_leaves_a_settled_one_alone() {
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&line(PROMPT));
        tracker.apply_recompute(now);
        tracker.note_user_interrupt();
        let change = tracker.apply_recompute(now).expect("interrupt changes it");
        assert_eq!(change.status, SessionStatus::Idle);
        assert_eq!(tracker.summary(), "Interrupted");

        // A turn that already ended keeps its word.
        let mut done = StatusTracker::new();
        done.note_hook_event(&line(PROMPT));
        done.note_hook_event(&line(STOP_NOTHING_LEFT));
        done.apply_recompute(now);
        let before = done.status();
        done.note_user_interrupt();
        assert!(done.apply_recompute(now).is_none());
        assert_eq!(done.status(), before);
    }

    #[test]
    fn a_recorded_turn_end_settles_a_running_status_that_missed_its_stop() {
        let prompt =
            r#"{"event":"UserPromptSubmit","session_id":"main","ts":"2026-10-07T10:00:00Z"}"#;
        let at = crate::activity_log::parse_iso_ms("2026-10-07T10:00:00Z").expect("ts");
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&line(prompt));
        tracker.apply_recompute(now);
        // The end of the turn before this prompt settles nothing.
        tracker.note_turn_ended(at - 5_000, false);
        assert!(tracker.apply_recompute(now).is_none());
        tracker.note_turn_ended(at + 30_000, false);
        let change = tracker.apply_recompute(now).expect("settles");
        assert_eq!(change.status, SessionStatus::Done);
        // Only a running turn is settled.
        tracker.note_turn_ended(at + 60_000, false);
        assert!(tracker.apply_recompute(now).is_none());

        // With no prompt time to compare against, nothing is settled.
        let mut untimed = StatusTracker::new();
        untimed.note_hook_event(&line(PROMPT));
        untimed.apply_recompute(now);
        untimed.note_turn_ended(i64::MAX, false);
        assert!(untimed.apply_recompute(now).is_none());
    }

    #[test]
    fn a_recorded_interrupt_stops_a_running_status_that_missed_its_esc() {
        let prompt =
            r#"{"event":"UserPromptSubmit","session_id":"main","ts":"2026-10-07T10:00:00Z"}"#;
        let at = crate::activity_log::parse_iso_ms("2026-10-07T10:00:00Z").expect("ts");
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&line(prompt));
        tracker.apply_recompute(now);
        // An earlier turn's interrupt says nothing about this one.
        tracker.note_turn_ended(at - 5_000, true);
        assert!(tracker.apply_recompute(now).is_none());
        tracker.note_turn_ended(at + 3_000, true);
        let change = tracker.apply_recompute(now).expect("settles");
        assert_eq!(change.status, SessionStatus::Idle);
        assert_eq!(tracker.summary(), "Interrupted");
    }

    #[test]
    fn tracker_emits_change_then_stays_quiet() {
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&line(PROMPT));
        let change = tracker
            .apply_recompute(now)
            .expect("first recompute changes");
        assert_eq!(change.status, SessionStatus::Running);
        assert_eq!(change.prev, SessionStatus::Idle);
        // Re-running with no new event yields no change.
        assert!(tracker.apply_recompute(now).is_none());
    }

    #[test]
    fn tracker_reports_seconds_since_last_notify() {
        use std::time::Duration;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.record_notified(now);
        tracker.note_hook_event(&line(PROMPT));
        let later = now + Duration::from_secs(7);
        let change = tracker.apply_recompute(later).expect("change");
        assert_eq!(change.secs_since_last_notify, Some(7));
    }

    #[test]
    fn tracker_relocks_to_the_live_session_after_earlier_ones_end() {
        // Regression: a terminal cycles through several short-lived claude sessions
        // (each SessionStart→SessionEnd) plus a nested one-shot, then the real
        // interactive session runs. The old rule locked onto the first (ended)
        // session and dropped every later event, freezing the badge as idle while
        // the terminal was actively working. Status must follow the live session.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();

        let real = |event: &str, sid: &str| HookEvent {
            event: event.to_string(),
            session_id: Some(sid.to_string()),
            transcript_path: Some(format!("/home/.claude/projects/-proj/{sid}.jsonl")),
            ..HookEvent::default()
        };

        // Two early sessions each start and end within seconds.
        tracker.note_hook_event(&real("SessionStart", "early-1"));
        tracker.note_hook_event(&real("SessionEnd", "early-1"));
        tracker.note_hook_event(&real("SessionStart", "early-2"));
        tracker.note_hook_event(&real("SessionEnd", "early-2"));

        // A one-shot `claude -p` (temp transcript) fires in between — never main.
        tracker.note_hook_event(&HookEvent {
            event: "Stop".to_string(),
            session_id: Some("one-shot".to_string()),
            transcript_path: Some("/private/var/folders/x/T/one-shot.jsonl".to_string()),
            ..HookEvent::default()
        });

        // The real interactive session now works: its events must drive Running.
        tracker.note_hook_event(&real("UserPromptSubmit", "live"));
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Running),
            "status must follow the live session, not stay stuck on an ended one",
        );
        tracker.note_hook_event(&real("PreToolUse", "live"));
        assert_eq!(tracker.status(), SessionStatus::Running);
    }

    #[test]
    fn idle_prompt_notification_maps_to_done_even_without_the_stop() {
        // The phantom-badge regression: a watch that (re)subscribes after a
        // turn's Stop sees the idle-prompt Notification as its FIRST event.
        // The old rule mapped every Notification to Waiting unless the Stop
        // had been seen in the same window, so that lone Notification wedged
        // the session in Waiting forever and the menu-bar badge showed a
        // permanent count. The idle prompt means "the turn is over" — it must
        // read as Done regardless of what was seen before it.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            message: Some("Claude is waiting for your input".to_string()),
            ..HookEvent::default()
        });
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Done),
            "an idle-prompt Notification must never wedge a session in Waiting",
        );
    }

    #[test]
    fn permission_notification_sets_waiting_even_as_first_event() {
        // Same gappy-window scenario, opposite polarity: a subscribe that
        // lands mid-turn right on the permission Notification must still
        // count the session as blocked.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            message: Some("Claude needs your permission to use Bash".to_string()),
            ..HookEvent::default()
        });
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Waiting),
        );
    }

    #[test]
    fn idle_prompt_notification_does_not_downgrade_an_open_block() {
        // A genuine block (permission prompt) is showing; a later idle-prompt
        // Notification must not clear it — the user is still blocked.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            message: Some("Claude needs your permission to use Bash".to_string()),
            ..HookEvent::default()
        });
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            message: Some("Claude is waiting for your input".to_string()),
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);
        assert_eq!(tracker.status(), SessionStatus::Waiting);
    }

    #[test]
    fn replay_history_full_turn_lands_done_with_no_ask() {
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let ev = |event: &str| HookEvent {
            event: event.to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        };
        let events = [
            ev("SessionStart"),
            ev("UserPromptSubmit"),
            ev("PreToolUse"),
            ev("PostToolUse"),
            ev("Stop"),
        ];
        let replayed = replay_history(&events, None, Instant::now());
        let tracker = replayed.tracker;
        let ask = replayed.projection.current_ask();
        assert_eq!(tracker.status(), SessionStatus::Done);
        assert!(ask.is_none(), "a settled turn has no open ask");
    }

    #[test]
    fn replay_history_trailing_permission_block_is_waiting_with_ask() {
        // A session that was genuinely blocked on a permission prompt when the
        // app (re)started must seed as Waiting with its ask open, so the
        // menu-bar badge counts it immediately instead of showing Idle.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let ev = |event: &str| HookEvent {
            event: event.to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        };
        let mut permission = ev("Notification");
        permission.message = Some("Claude needs your permission to use Bash".to_string());
        let events = [
            ev("SessionStart"),
            ev("UserPromptSubmit"),
            ev("PreToolUse"),
            permission,
        ];
        let replayed = replay_history(&events, None, Instant::now());
        let tracker = replayed.tracker;
        let ask = replayed.projection.current_ask();
        assert_eq!(tracker.status(), SessionStatus::Waiting);
        let ask = ask.expect("the permission ask must survive the replay");
        assert_eq!(ask.kind, crate::ask::AskKind::Permission);
    }

    #[test]
    fn replay_history_anchored_ignores_a_stale_session_without_end() {
        // The tail opens with an earlier claude that died without SessionEnd
        // (its last event a permission Notification), then the live session's
        // events follow. A blind heuristic fold locks onto the corpse and
        // reports its stale Waiting; anchored to the status-line's id, the
        // replay must report the live session's Done instead.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let ev = |event: &str, sid: &str| HookEvent {
            event: event.to_string(),
            session_id: Some(sid.to_string()),
            transcript_path: Some(format!("/h/.claude/projects/-p/{sid}.jsonl")),
            ..HookEvent::default()
        };
        let mut stale_block = ev("Notification", "corpse");
        stale_block.message = Some("Claude needs your permission to use Bash".to_string());
        let events = [
            ev("SessionStart", "corpse"),
            ev("UserPromptSubmit", "corpse"),
            stale_block,
            // No SessionEnd for "corpse" — it was killed. The live session:
            ev("SessionStart", "live"),
            ev("UserPromptSubmit", "live"),
            ev("Stop", "live"),
        ];
        let replayed = replay_history(&events, Some("live"), Instant::now());
        let tracker = replayed.tracker;
        let _ = replayed.projection.current_ask();
        assert_eq!(
            tracker.status(),
            SessionStatus::Done,
            "the anchored replay must follow the live session, not the corpse",
        );
        assert_eq!(tracker.main_session_id(), Some("live"));
    }

    #[test]
    fn idle_prompt_during_a_running_block_is_waiting() {
        // AskUserQuestion blocks the TUI mid-turn: PreToolUse set Running, and
        // 60s later Claude fires the idle-prompt Notification. Mid-turn the
        // prompt can only sit idle because a block is on screen — this must
        // read as Waiting (as it always did), not be flattened to Done.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&HookEvent {
            event: "PreToolUse".to_string(),
            tool_name: Some("AskUserQuestion".to_string()),
            ..HookEvent::default()
        });
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            message: Some("Claude is waiting for your input".to_string()),
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);
        assert_eq!(tracker.status(), SessionStatus::Waiting);
    }

    #[test]
    fn idle_prompt_settles_an_unconfirmed_waiting_to_done() {
        // A window that missed the Stop sees an unrecognized Notification
        // first → conservative Waiting. The idle prompt that follows proves
        // the turn is over; an unconfirmed Waiting must settle to Done rather
        // than wedge a phantom onto the menu-bar badge.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            message: None,
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);
        assert_eq!(
            tracker.status(),
            SessionStatus::Waiting,
            "conservative fallback"
        );
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            message: Some("Claude is waiting for your input".to_string()),
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);
        assert_eq!(
            tracker.status(),
            SessionStatus::Done,
            "idle prompt settles it"
        );
    }

    #[test]
    fn an_informational_notification_never_claims_the_users_attention() {
        // The misfire class: a login-succeeded toast, a resolved MCP elicitation
        // or a *background agent's* own lifecycle all arrive as `Notification`
        // hooks. None of them blocks this session, so none may flip a working
        // session to Waiting — that fires a "needs you" banner for a session that
        // is busy working.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        for ty in [
            "auth_success",
            "elicitation_complete",
            "elicitation_response",
            "agent_needs_input",
            "agent_completed",
        ] {
            let now = Instant::now();
            let mut tracker = StatusTracker::new();
            tracker.note_hook_event(&HookEvent {
                event: "UserPromptSubmit".to_string(),
                ..HookEvent::default()
            });
            let _ = tracker.apply_recompute(now);
            tracker.note_hook_event(&HookEvent {
                event: "Notification".to_string(),
                notification_type: Some(ty.to_string()),
                message: Some("some status message".to_string()),
                ..HookEvent::default()
            });
            assert!(
                tracker.apply_recompute(now).is_none(),
                "{ty} must not change a running session's status",
            );
            assert_eq!(tracker.status(), SessionStatus::Running, "{ty}");
        }
    }

    #[test]
    fn an_elicitation_dialog_is_a_confirmed_block() {
        // An MCP server's elicitation dialog is on screen and the user must
        // answer it — a genuine block, and (being confirmed) one that a later
        // idle prompt must not clear.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            notification_type: Some("elicitation_dialog".to_string()),
            message: Some("Claude Code needs your input".to_string()),
            ..HookEvent::default()
        });
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Waiting)
        );
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            notification_type: Some("idle_prompt".to_string()),
            message: Some("Claude is waiting for your input".to_string()),
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);
        assert_eq!(
            tracker.status(),
            SessionStatus::Waiting,
            "an open elicitation must survive the idle nudge"
        );
    }

    #[test]
    fn the_structured_type_outranks_the_prose() {
        // The permission gate classified by type, with wording that the old
        // substring match would not have recognised at all.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            notification_type: Some("permission_prompt".to_string()),
            message: Some("Allow Bash to run `rm -rf build`?".to_string()),
            ..HookEvent::default()
        });
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Waiting)
        );
    }

    #[test]
    fn a_failed_turn_ends_in_error() {
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&HookEvent {
            event: "UserPromptSubmit".to_string(),
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);
        tracker.note_hook_event(&HookEvent {
            event: "StopFailure".to_string(),
            error: Some("rate_limit".to_string()),
            ..HookEvent::default()
        });
        let change = tracker.apply_recompute(now).expect("a failed turn changes");
        assert_eq!(change.status, SessionStatus::Error);
        assert_eq!(change.summary, "Error: rate_limit");
    }

    #[test]
    fn a_failed_tool_keeps_the_turn_running_and_says_so() {
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        tracker.note_hook_event(&HookEvent {
            event: "PreToolUse".to_string(),
            tool_name: Some("Bash".to_string()),
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);
        tracker.note_hook_event(&HookEvent {
            event: "PostToolUseFailure".to_string(),
            tool_name: Some("Bash".to_string()),
            ..HookEvent::default()
        });
        let change = tracker.apply_recompute(now).expect("the summary changes");
        assert_eq!(change.status, SessionStatus::Running);
        assert_eq!(change.summary, "Bash failed");
    }

    #[test]
    fn replay_history_of_no_events_is_idle() {
        use std::time::Instant;
        let replayed = replay_history(&[], None, Instant::now());
        let tracker = replayed.tracker;
        let ask = replayed.projection.current_ask();
        assert_eq!(tracker.status(), SessionStatus::Idle);
        assert!(ask.is_none());
    }

    #[test]
    fn nested_claude_session_does_not_flap_main_status() {
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();

        // The main claude session starts a turn (locks the main session).
        tracker.note_hook_event(&HookEvent {
            event: "UserPromptSubmit".to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        });
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Running)
        );

        // A nested claude (subagent / one-shot `claude -p`) finishes and ends,
        // emitting Stop + SessionEnd into the same events file. These must NOT
        // move the main session to Done/Idle.
        tracker.note_hook_event(&HookEvent {
            event: "Stop".to_string(),
            session_id: Some("nested".to_string()),
            ..HookEvent::default()
        });
        tracker.note_hook_event(&HookEvent {
            event: "SessionEnd".to_string(),
            session_id: Some("nested".to_string()),
            ..HookEvent::default()
        });
        assert!(
            tracker.apply_recompute(now).is_none(),
            "nested session events must not change main status"
        );
        assert_eq!(tracker.status(), SessionStatus::Running);

        // The main session's own Stop still drives Done.
        tracker.note_hook_event(&HookEvent {
            event: "Stop".to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        });
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Done)
        );
    }

    #[test]
    fn agent_spawn_relocks_main_session() {
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();

        // A resume that begins mid-subagent may first lock onto a stale id; an
        // `Agent` spawn is authoritatively the main session and re-locks it.
        tracker.note_hook_event(&HookEvent {
            event: "PreToolUse".to_string(),
            session_id: Some("stale".to_string()),
            ..HookEvent::default()
        });
        tracker.note_hook_event(&HookEvent {
            event: "PreToolUse".to_string(),
            tool_name: Some("Agent".to_string()),
            session_id: Some("real-main".to_string()),
            ..HookEvent::default()
        });
        // The re-locked main session's Stop now drives Done…
        tracker.note_hook_event(&HookEvent {
            event: "Stop".to_string(),
            session_id: Some("real-main".to_string()),
            ..HookEvent::default()
        });
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Done)
        );

        // …while a Stop from the abandoned stale session is ignored.
        tracker.note_hook_event(&HookEvent {
            event: "UserPromptSubmit".to_string(),
            session_id: Some("real-main".to_string()),
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);
        tracker.note_hook_event(&HookEvent {
            event: "Stop".to_string(),
            session_id: Some("stale".to_string()),
            ..HookEvent::default()
        });
        assert!(
            tracker.apply_recompute(now).is_none(),
            "stale session Stop must be ignored after re-lock"
        );
        assert_eq!(tracker.status(), SessionStatus::Running);
    }

    #[test]
    fn no_id_event_after_lock_is_not_main() {
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();

        // Lock onto a real main session, then run it (Running).
        tracker.note_hook_event(&HookEvent {
            event: "UserPromptSubmit".to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);

        // A stray Stop with no session id must NOT flap the locked main session to
        // Done — matching HookActivity, which compares against the raw id.
        tracker.note_hook_event(&HookEvent {
            event: "Stop".to_string(),
            session_id: None,
            ..HookEvent::default()
        });
        assert!(tracker.apply_recompute(now).is_none());
        assert_eq!(tracker.status(), SessionStatus::Running);
    }

    #[test]
    fn legacy_no_id_stream_still_drives_status() {
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        // A stream that never carries a session id (lock never taken) is honored.
        tracker.note_hook_event(&HookEvent {
            event: "Stop".to_string(),
            session_id: None,
            ..HookEvent::default()
        });
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Done)
        );
    }

    #[test]
    fn idle_notification_after_stop_stays_done() {
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();

        // A turn finishes: the main session's Stop drives Done.
        tracker.note_hook_event(&HookEvent {
            event: "Stop".to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        });
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Done)
        );

        // Claude Code then emits an idle-prompt Notification ("waiting for your
        // input"), which fires *after* Stop and only means "ready for your next
        // prompt". It must NOT downgrade the finished turn into a "waiting on
        // you" block — the session stays Done (neutral, no highlight).
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        });
        assert!(
            tracker.apply_recompute(now).is_none(),
            "an idle notification after Stop must not change a done session"
        );
        assert_eq!(tracker.status(), SessionStatus::Done);
    }

    #[test]
    fn notification_while_running_still_waits() {
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();

        // Mid-turn work: the session is Running.
        tracker.note_hook_event(&HookEvent {
            event: "UserPromptSubmit".to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        });
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Running)
        );

        // A genuine block (permission/input request) arrives mid-turn — while the
        // session is Running, before any Stop — and must still drive Waiting.
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        });
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Waiting)
        );
    }

    #[test]
    fn notification_latch_clears_on_new_work_cycle() {
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        assert!(!tracker.has_unread_notification());

        // A turn finishes and we notify: the latch holds through the burst of
        // Done↔Waiting flips the same turn end produces.
        tracker.note_hook_event(&HookEvent {
            event: "Stop".to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);
        tracker.record_notified(now);
        assert!(tracker.has_unread_notification());
        // An idle "waiting for you" Notification for the SAME turn keeps the latch.
        tracker.note_hook_event(&HookEvent {
            event: "Notification".to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);
        assert!(tracker.has_unread_notification());

        // The next turn begins (Running): a genuinely new episode clears the latch
        // so its completion notifies afresh — even without the user refocusing.
        tracker.note_hook_event(&HookEvent {
            event: "UserPromptSubmit".to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        });
        let _ = tracker.apply_recompute(now);
        assert!(!tracker.has_unread_notification());
    }

    #[test]
    fn a_reentrant_stop_does_not_announce_the_same_turn_twice() {
        // A `Stop` hook that blocks makes Claude carry on working, and the turn
        // ends again — Claude Code marks that second `Stop` with
        // `stop_hook_active`. The user saw one turn, so they must get one
        // "finished", not one per re-entry. The intervening `Running` would
        // otherwise clear the unread latch and re-arm the announcement.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        let ev = |event: &str| HookEvent {
            event: event.to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        };

        tracker.note_hook_event(&ev("Stop"));
        let _ = tracker.apply_recompute(now);
        tracker.record_notified(now);
        assert!(tracker.has_unread_notification());

        // A Stop hook resumed the turn: Claude works again, clearing the latch.
        tracker.note_hook_event(&ev("UserPromptSubmit"));
        let _ = tracker.apply_recompute(now);
        assert!(!tracker.has_unread_notification());

        // The re-entrant Stop lands. Status is still Done…
        let mut reentrant = ev("Stop");
        reentrant.stop_hook_active = Some(true);
        tracker.note_hook_event(&reentrant);
        assert_eq!(
            tracker.apply_recompute(now).map(|c| c.status),
            Some(SessionStatus::Done)
        );
        // …but it is the same turn, already announced.
        assert!(
            tracker.has_unread_notification(),
            "a re-entrant Stop must not re-announce the turn",
        );
    }

    #[test]
    fn an_ordinary_stop_still_announces_a_fresh_turn() {
        // The guard above must not swallow real turn ends: a Stop that is not a
        // re-entry announces normally.
        use crate::hooks::HookEvent;
        use std::time::Instant;
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        let ev = |event: &str| HookEvent {
            event: event.to_string(),
            session_id: Some("main".to_string()),
            ..HookEvent::default()
        };

        tracker.note_hook_event(&ev("Stop"));
        let _ = tracker.apply_recompute(now);
        tracker.record_notified(now);
        tracker.note_hook_event(&ev("UserPromptSubmit"));
        let _ = tracker.apply_recompute(now);

        let mut fresh = ev("Stop");
        fresh.stop_hook_active = Some(false);
        tracker.note_hook_event(&fresh);
        let _ = tracker.apply_recompute(now);
        assert!(
            !tracker.has_unread_notification(),
            "a genuine new turn end must still announce",
        );
    }

    #[test]
    fn preference_allows_table() {
        use NotifyPreference::{All, None, OnlyBlocked};
        use SessionStatus::{Done, Error, Idle, Running, Waiting};
        let cases = [
            // `All` permits every transition.
            (All, Idle, true),
            (All, Running, true),
            (All, Waiting, true),
            (All, Done, true),
            (All, Error, true),
            // `None` permits nothing.
            (None, Idle, false),
            (None, Running, false),
            (None, Waiting, false),
            (None, Done, false),
            (None, Error, false),
            // `OnlyBlocked` permits only a transition into Waiting.
            (OnlyBlocked, Waiting, true),
            (OnlyBlocked, Idle, false),
            (OnlyBlocked, Running, false),
            (OnlyBlocked, Done, false),
            (OnlyBlocked, Error, false),
        ];

        for (pref, next, expected) in cases {
            assert_eq!(
                preference_allows(pref, next),
                expected,
                "case: {pref:?} next={next:?}"
            );
        }
    }

    #[test]
    fn notify_preference_serializes_snake_case() {
        let json = serde_json::to_string(&NotifyPreference::OnlyBlocked).expect("serialize");
        assert_eq!(json, "\"only_blocked\"");
    }

    #[test]
    fn notify_sound_serializes_snake_case_and_resolves_kind() {
        use NotifySound::{Bell, Default as Def, Kalimba, Marimba, MusicBox, Silent, Vibraphone};
        use NotifySoundKind::{Bundled, Silent as KindSilent, System};
        assert_eq!(serde_json::to_string(&Marimba).expect("ser"), "\"marimba\"");
        assert_eq!(
            serde_json::to_string(&MusicBox).expect("ser"),
            "\"music_box\""
        );
        assert_eq!(NotifySound::default(), Def);
        assert_eq!(Def.kind(), System);
        assert_eq!(Silent.kind(), KindSilent);
        assert_eq!(Marimba.kind(), Bundled("marimba.wav"));
        assert_eq!(MusicBox.kind(), Bundled("music_box.wav"));
        assert_eq!(Vibraphone.kind(), Bundled("vibraphone.wav"));
        assert_eq!(Kalimba.kind(), Bundled("kalimba.wav"));
        assert_eq!(Bell.kind(), Bundled("bell.wav"));
    }

    #[test]
    fn should_withdraw_table() {
        use SessionStatus::{Done, Error, Idle, Running, Waiting};
        let cases = [
            // Leaving an attention state for work/idle → the banner is now stale
            // (the user answered, or Claude resumed): withdraw it.
            (Waiting, Running, true),
            (Done, Running, true),
            (Error, Running, true),
            (Waiting, Idle, true),
            (Done, Idle, true),
            // Moving between / staying in attention states → the turn-end
            // Done↔Waiting burst must not pull its own banner.
            (Waiting, Done, false),
            (Done, Waiting, false),
            (Waiting, Waiting, false),
            // Entering (or staying outside) attention → nothing was shown to pull.
            (Running, Waiting, false),
            (Idle, Running, false),
            (Running, Idle, false),
            (Idle, Idle, false),
        ];
        for (prev, next, expected) in cases {
            assert_eq!(
                should_withdraw_notification(prev, next),
                expected,
                "case: {prev:?}->{next:?}"
            );
        }
    }

    #[test]
    fn should_notify_table() {
        use SessionStatus::{Done, Error, Running, Waiting};
        let cases = [
            // focused -> false even on a real transition into done.
            (Running, Done, true, None, false),
            // running -> done, unfocused, no recent notify -> true.
            (Running, Done, false, None, true),
            // done -> done is not a transition.
            (Done, Done, false, None, false),
            // waiting -> waiting is not a transition.
            (Waiting, Waiting, false, None, false),
            // transition but coalesced (last notify 2s ago) -> false.
            (Running, Done, false, Some(2), false),
            // transition with last notify 10s ago -> true.
            (Running, Error, false, Some(10), true),
            // running -> running is not an attention state.
            (Running, Running, false, None, false),
        ];

        for (prev, next, focused, since, expected) in cases {
            assert_eq!(
                should_notify(prev, next, focused, since),
                expected,
                "case: {prev:?}->{next:?} focused={focused} since={since:?}"
            );
        }
    }

    fn base_decision() -> NotifyDecision {
        // A transition worth notifying: running -> waiting, off screen, no latch,
        // preference All, never notified before.
        NotifyDecision {
            prev: SessionStatus::Running,
            next: SessionStatus::Waiting,
            window_focused: false,
            active_is_this: false,
            already_unread: false,
            preference: NotifyPreference::All,
            secs_since_last_notify: None,
        }
    }

    #[test]
    fn notify_decision_fires_on_a_real_off_screen_transition() {
        assert!(base_decision().should_fire());
    }

    #[test]
    fn notify_decision_on_screen_needs_both_window_and_active() {
        let d = base_decision();
        // On screen only when the window is focused AND this is the active
        // session; either alone still notifies.
        assert!(!NotifyDecision {
            window_focused: true,
            active_is_this: true,
            ..d
        }
        .should_fire());
        assert!(NotifyDecision {
            window_focused: true,
            active_is_this: false,
            ..d
        }
        .should_fire());
        assert!(NotifyDecision {
            window_focused: false,
            active_is_this: true,
            ..d
        }
        .should_fire());
    }

    #[test]
    fn notify_decision_suppressed_by_unread_latch() {
        assert!(!NotifyDecision {
            already_unread: true,
            ..base_decision()
        }
        .should_fire());
    }

    #[test]
    fn notify_decision_respects_preference() {
        // OnlyBlocked permits waiting but not done; None mutes everything.
        assert!(NotifyDecision {
            preference: NotifyPreference::OnlyBlocked,
            ..base_decision()
        }
        .should_fire());
        assert!(!NotifyDecision {
            next: SessionStatus::Done,
            preference: NotifyPreference::OnlyBlocked,
            ..base_decision()
        }
        .should_fire());
        assert!(!NotifyDecision {
            preference: NotifyPreference::None,
            ..base_decision()
        }
        .should_fire());
    }

    /// A hook line as Kriyon's hook script records it, for the background-agent
    /// tests below (which replay real Claude Code 2.1.283 sequences).
    fn line(json: &str) -> crate::hooks::HookEvent {
        crate::hooks::parse_hook_line(json).expect("fixture parses")
    }

    fn fold(events: &[&str]) -> StatusTracker {
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        for json in events {
            tracker.note_hook_event(&line(json));
            let _ = tracker.apply_recompute(now);
        }
        tracker
    }

    const PROMPT: &str = r#"{"event":"UserPromptSubmit","session_id":"main"}"#;
    const SPAWN: &str =
        r#"{"event":"PostToolUse","session_id":"main","tool_name":"Agent","tool_use_id":"t1"}"#;
    const STOP_AWAITING_TWO: &str = r#"{"event":"Stop","session_id":"main","background_tasks":[{"id":"a1","type":"subagent"},{"id":"a2","type":"subagent"},{"id":"s1","type":"shell"}]}"#;
    const SUBAGENT_TOOL: &str = r#"{"event":"PostToolUse","session_id":"main","tool_name":"Bash","agent_id":"a1","agent_type":"general-purpose"}"#;
    const IDLE_PROMPT: &str = r#"{"event":"Notification","session_id":"main","notification_type":"idle_prompt","message":"Claude is waiting for your input"}"#;
    const STOP_NOTHING_LEFT: &str =
        r#"{"event":"Stop","session_id":"main","background_tasks":[{"id":"s1","type":"shell"}]}"#;

    #[test]
    fn a_turn_that_hands_work_to_background_agents_is_not_done() {
        // The main turn ends while two subagents still run: Claude is paused,
        // not finished, and will wake itself when they report back.
        let tracker = fold(&[PROMPT, SPAWN, STOP_AWAITING_TWO]);
        assert_eq!(tracker.status(), SessionStatus::Running);
        assert_eq!(tracker.summary(), "Waiting on 2 agents…");
    }

    #[test]
    fn the_session_is_done_once_no_background_agent_is_left() {
        // Each agent's report wakes the main agent (a `<task-notification>`
        // UserPromptSubmit), and the Stop that ends that turn carries a fresh
        // list. A shell still running does not hold the session open.
        let tracker = fold(&[
            PROMPT,
            SPAWN,
            STOP_AWAITING_TWO,
            PROMPT,
            r#"{"event":"Stop","session_id":"main","background_tasks":[{"id":"a2","type":"subagent"}]}"#,
        ]);
        assert_eq!(tracker.summary(), "Waiting on 1 agent…");
        let tracker = fold(&[PROMPT, SPAWN, STOP_AWAITING_TWO, PROMPT, STOP_NOTHING_LEFT]);
        assert_eq!(tracker.status(), SessionStatus::Done);
    }

    #[test]
    fn a_recorded_turn_end_leaves_a_session_waiting_on_its_agents() {
        // The Stop was seen and kept the session Running for its agents; the
        // transcript's record of the same turn's end must not call it Done.
        let prompt =
            r#"{"event":"UserPromptSubmit","session_id":"main","ts":"2026-10-07T10:00:00Z"}"#;
        let at = crate::activity_log::parse_iso_ms("2026-10-07T10:00:00Z").expect("ts");
        let mut tracker = fold(&[prompt, SPAWN, STOP_AWAITING_TWO]);
        tracker.note_turn_ended(at + 30_000, false);
        assert!(tracker.apply_recompute(Instant::now()).is_none());
        assert_eq!(tracker.summary(), "Waiting on 2 agents…");
    }

    #[test]
    fn the_idle_prompt_while_agents_work_does_not_ask_for_the_user() {
        // The reported bug: a subagent's tool event, then Claude's idle nudge a
        // minute after the main turn ended. The prompt is idle because Claude is
        // waiting on its agents — no question is on screen.
        let tracker = fold(&[PROMPT, SPAWN, STOP_AWAITING_TWO, SUBAGENT_TOOL, IDLE_PROMPT]);
        assert_eq!(tracker.status(), SessionStatus::Running);
        assert_eq!(tracker.summary(), "Waiting on 2 agents…");
    }

    #[test]
    fn subagent_tool_events_do_not_reopen_a_finished_session() {
        // The main agent's Stop is authoritative about what is still in flight;
        // a straggling event from a killed agent must not wedge it in Running.
        let tracker = fold(&[PROMPT, SPAWN, STOP_NOTHING_LEFT, SUBAGENT_TOOL]);
        assert_eq!(tracker.status(), SessionStatus::Done);
    }

    #[test]
    fn a_background_agent_blocked_on_permission_needs_the_user_until_it_resumes() {
        let blocked = r#"{"event":"Notification","session_id":"main","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}"#;
        let tracker = fold(&[PROMPT, SPAWN, STOP_AWAITING_TWO, blocked]);
        assert_eq!(tracker.status(), SessionStatus::Waiting);
        // The agent's next tool event is proof the block was answered.
        let tracker = fold(&[PROMPT, SPAWN, STOP_AWAITING_TWO, blocked, SUBAGENT_TOOL]);
        assert_eq!(tracker.status(), SessionStatus::Running);
        assert_eq!(tracker.summary(), "Waiting on 2 agents…");
    }

    #[test]
    fn a_question_on_screen_mid_turn_still_needs_the_user() {
        // Only the idle prompt of a *closed* main turn is ignored; mid-turn it
        // still means a TUI block is up, background agents or not.
        let tracker = fold(&[
            PROMPT,
            SPAWN,
            STOP_AWAITING_TWO,
            PROMPT,
            r#"{"event":"PreToolUse","session_id":"main","tool_name":"AskUserQuestion"}"#,
            IDLE_PROMPT,
        ]);
        assert_eq!(tracker.status(), SessionStatus::Waiting);
    }

    #[test]
    fn replay_history_restores_a_session_paused_on_background_agents() {
        let events: Vec<_> = [PROMPT, SPAWN, STOP_AWAITING_TWO, SUBAGENT_TOOL, IDLE_PROMPT]
            .iter()
            .map(|json| line(json))
            .collect();
        let replayed = replay_history(&events, Some("main"), Instant::now());
        let tracker = replayed.tracker;
        let ask = replayed.projection.current_ask();
        assert_eq!(tracker.status(), SessionStatus::Running);
        assert!(ask.is_none());
    }

    #[test]
    fn going_quiet_on_background_agents_never_notifies() {
        // Running is not an attention state, so pausing on agents neither pings
        // nor spends the unread latch the real completion will need.
        let now = Instant::now();
        let mut tracker = StatusTracker::new();
        for json in [PROMPT, SPAWN, STOP_AWAITING_TWO, SUBAGENT_TOOL, IDLE_PROMPT] {
            tracker.note_hook_event(&line(json));
            if let Some(change) = tracker.apply_recompute(now) {
                assert!(!is_attention_status(change.status), "{change:?}");
            }
        }
        assert!(!tracker.has_unread_notification());
    }

    #[test]
    fn the_summary_says_what_is_running_and_what_went_wrong() {
        let summary = |events: &[&str]| fold(events).summary().to_string();
        assert_eq!(
            summary(&[r#"{"event":"PreToolUse","session_id":"main","tool_name":"Bash"}"#]),
            "Running Bash…"
        );
        assert_eq!(
            summary(&[r#"{"event":"PostToolUseFailure","session_id":"main","tool_name":"Bash"}"#]),
            "Bash failed"
        );
        assert_eq!(
            summary(&[r#"{"event":"PostToolUseFailure","session_id":"main"}"#]),
            "Tool failed"
        );
        assert_eq!(
            summary(&[r#"{"event":"StopFailure","session_id":"main"}"#]),
            "Error"
        );
        assert_eq!(
            summary(&[r#"{"event":"StopFailure","session_id":"main","error":"rate_limit"}"#]),
            "Error: rate_limit"
        );
        assert_eq!(
            summary(&[r#"{"event":"PermissionRequest","session_id":"main"}"#]),
            "Needs permission"
        );
    }

    const MAIN_QUESTION: &str = r#"{"event":"PreToolUse","session_id":"main","tool_name":"AskUserQuestion","tool_use_id":"q1"}"#;
    const AGENT_A1_ASKS: &str =
        r#"{"event":"PermissionRequest","session_id":"main","tool_name":"Bash","agent_id":"a1"}"#;
    const AGENT_A2_TOOL: &str = r#"{"event":"PostToolUse","session_id":"main","tool_name":"Read","agent_id":"a2","agent_type":"general-purpose"}"#;
    const PERMISSION_PROMPT: &str = r#"{"event":"Notification","session_id":"main","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}"#;

    #[test]
    fn a_background_agent_working_does_not_answer_the_main_agents_question() {
        let tracker = fold(&[
            PROMPT,
            SPAWN,
            STOP_AWAITING_TWO,
            PROMPT,
            MAIN_QUESTION,
            IDLE_PROMPT,
            AGENT_A2_TOOL,
        ]);
        assert_eq!(tracker.status(), SessionStatus::Waiting);
    }

    #[test]
    fn only_the_agent_that_asked_can_lift_its_permission_prompt() {
        let tracker = fold(&[
            PROMPT,
            SPAWN,
            STOP_AWAITING_TWO,
            AGENT_A1_ASKS,
            AGENT_A2_TOOL,
        ]);
        assert_eq!(
            tracker.status(),
            SessionStatus::Waiting,
            "a2 working answers nothing"
        );
        let tracker = fold(&[
            PROMPT,
            SPAWN,
            STOP_AWAITING_TWO,
            AGENT_A1_ASKS,
            SUBAGENT_TOOL,
        ]);
        assert_eq!(
            tracker.status(),
            SessionStatus::Running,
            "a1 carrying on does"
        );
    }

    #[test]
    fn a_turn_ending_does_not_hide_an_agents_open_permission_prompt() {
        // Agent a1 asks mid-turn; the main turn then ends with agents in flight.
        // The dialog is still on screen.
        let tracker = fold(&[
            PROMPT,
            SPAWN,
            AGENT_A1_ASKS,
            PERMISSION_PROMPT,
            STOP_AWAITING_TWO,
        ]);
        assert_eq!(tracker.status(), SessionStatus::Waiting);
        let tracker = fold(&[
            PROMPT,
            SPAWN,
            AGENT_A1_ASKS,
            PERMISSION_PROMPT,
            STOP_AWAITING_TWO,
            IDLE_PROMPT,
        ]);
        assert_eq!(tracker.status(), SessionStatus::Waiting);
    }

    #[test]
    fn a_reentrant_stop_that_waits_on_agents_keeps_the_real_completion_announceable() {
        // Nothing was announced when the turn paused on agents, so nothing may
        // be latched; the completion after the agents report must still notify.
        let reentry = r#"{"event":"Stop","session_id":"main","stop_hook_active":true,"background_tasks":[{"id":"a1","type":"subagent"}]}"#;
        let tracker = fold(&[PROMPT, SPAWN, reentry]);
        assert_eq!(tracker.status(), SessionStatus::Running);
        assert!(!tracker.has_unread_notification());
    }

    #[test]
    fn a_reentrant_stop_after_a_pause_on_agents_still_announces() {
        // The first Stop paused on an agent and announced nothing. A blocking
        // Stop hook made Claude carry on, and the re-entrant Stop is the real
        // completion: it must notify.
        let reentry =
            r#"{"event":"Stop","session_id":"main","stop_hook_active":true,"background_tasks":[]}"#;
        let main_tool =
            r#"{"event":"PostToolUse","session_id":"main","tool_name":"Bash","tool_use_id":"t2"}"#;
        let stop_awaiting_one = r#"{"event":"Stop","session_id":"main","background_tasks":[{"id":"a1","type":"subagent"}]}"#;
        let tracker = fold(&[PROMPT, SPAWN, stop_awaiting_one, main_tool, reentry]);
        assert_eq!(tracker.status(), SessionStatus::Done);
        assert!(
            !tracker.has_unread_notification(),
            "nothing announced this turn yet, so its end must notify",
        );
    }

    #[test]
    fn the_idle_prompt_settles_a_session_no_agent_is_holding_open() {
        // After a Stop that listed no agent, an unattributed prompt is answered
        // and some straggler carries on; the idle nudge must still end it.
        let tracker = fold(&[
            PROMPT,
            SPAWN,
            STOP_NOTHING_LEFT,
            PERMISSION_PROMPT,
            SUBAGENT_TOOL,
            IDLE_PROMPT,
        ]);
        assert_eq!(tracker.status(), SessionStatus::Done);
    }

    #[test]
    fn a_foreground_subagents_work_shows_in_the_summary() {
        let tracker = fold(&[
            PROMPT,
            r#"{"event":"PreToolUse","session_id":"main","tool_name":"Agent","tool_use_id":"t9"}"#,
            r#"{"event":"PreToolUse","session_id":"main","tool_name":"Grep","agent_id":"f1","agent_type":"Explore"}"#,
        ]);
        assert_eq!(tracker.status(), SessionStatus::Running);
        assert_eq!(tracker.summary(), "Running Grep…");
    }

    #[test]
    fn a_subagents_work_is_work_even_before_the_main_agent_is_seen() {
        // A watch that starts mid-subagent sees its events first.
        let tracker = fold(&[SUBAGENT_TOOL]);
        assert_eq!(tracker.status(), SessionStatus::Running);
    }

    #[test]
    fn a_replay_anchors_status_and_activity_to_the_same_session() {
        // The tail opens with an earlier claude that died without SessionEnd;
        // the live one never spawns an agent (the only other re-lock). Both
        // folds must follow the anchor, not the corpse.
        let events: Vec<_> = [
            r#"{"event":"UserPromptSubmit","session_id":"old"}"#,
            r#"{"event":"PreToolUse","session_id":"old","tool_name":"Agent","tool_use_id":"t0"}"#,
            r#"{"event":"UserPromptSubmit","session_id":"live"}"#,
            r#"{"event":"Stop","session_id":"live"}"#,
        ]
        .iter()
        .map(|json| line(json))
        .collect();
        let replayed = replay_history(&events, Some("live"), Instant::now());
        assert_eq!(replayed.tracker.main_session_id(), Some("live"));
        assert_eq!(replayed.projection.main_session_id(), Some("live"));
        assert!(
            replayed.projection.subagents().is_empty(),
            "the corpse's subagent is not this session's"
        );
        assert_eq!(replayed.tracker.status(), SessionStatus::Done);
    }
}
