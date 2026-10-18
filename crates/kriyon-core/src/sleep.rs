//! [Sleeping session] policy and bookkeeping: when is it safe and worthwhile
//! to stop a session's `claude` process, when may a slept session be woken,
//! and where each session currently sits in that lifecycle.
//!
//! Pure decisions only — the kill/type IO lives in the Tauri shell. The rules
//! err hard toward doing nothing: killing the wrong process loses user state,
//! while not sleeping merely keeps memory a while longer.

use std::collections::HashMap;
use std::time::Instant;

use crate::proc::PtyForeground;

/// The user's auto-sleep policy: whether idle sessions are slept at all, and
/// how long a session must sit idle first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AutoSleep {
    pub enabled: bool,
    pub after_secs: u64,
}

impl AutoSleep {
    /// The policy behind "Sleep idle sessions now": on, with no idle threshold.
    /// It waives only *how long* a session must have been idle. Every gate that
    /// protects work — mid-turn, on screen, a running subagent or background
    /// shell, no resumable id — still applies, because it goes through the same
    /// [`should_sleep`].
    pub const NOW: Self = Self {
        enabled: true,
        after_secs: 0,
    };
}

impl Default for AutoSleep {
    fn default() -> Self {
        Self {
            enabled: true,
            after_secs: 3 * 3600,
        }
    }
}

/// A Claude session id safe to embed in a typed `claude --resume` command line:
/// UUID-shaped, nothing else. The wake path types this into a shell, so the
/// validation is what keeps it injection-proof.
///
/// A leading `-` is rejected even though the charset would allow it: a real
/// Claude session id is a UUID and never starts with a dash, and
/// `claude --resume -x` would tokenize `-x` as a *separate flag* rather than
/// the resume value (argument injection, not shell injection). The id is
/// learned from hook events whose `session_id` a session's own `claude` can be
/// prompt-injected into writing, so an id like `--dangerously-skip-permissions`
/// is entirely charset-legal and must not survive this gate.
#[must_use]
pub fn is_safe_claude_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Everything the sleep decision needs to know about one candidate session.
pub struct SleepCandidate<'a> {
    /// What holds the session's terminal right now.
    pub foreground: PtyForeground,
    /// How long the session's status has been Idle/Done, or `None` while it is
    /// active (or its idleness has not been observed yet).
    pub idle_secs: Option<u64>,
    /// The user is currently looking at this session.
    pub focused: bool,
    /// Hook-derived activity reports a background shell still running (a dev
    /// server started by claude would die with it).
    pub has_running_shells: bool,
    /// Hook-derived activity reports a [Subagent] still running. The main
    /// session's status reads Idle while a subagent works — the subagent's own
    /// hook events carry its session id, which the [Main session lock] filters
    /// out, so the main session sees no events and times out to Idle. Stopping
    /// its `claude` now would kill the in-flight subagent orchestration, so a
    /// running subagent vetoes sleep exactly as a background shell does.
    pub has_running_subagents: bool,
    /// The session's [Claude session id], required to wake it later.
    pub claude_id: Option<&'a str>,
}

/// Whether the session is quiescent enough to sleep — every gate except having
/// a resumable id: a `claude` visibly holds the terminal (there is something to
/// stop, and the shell is not mid-command), the session has been idle past the
/// policy threshold, nothing is running in the background (no live [Subagent],
/// no background shell), and the user is not looking at it.
///
/// Split out so a caller can check the cheap gates before paying to look the
/// [Claude session id] up — that is a per-session store read on every pass, and
/// on a busy workspace nearly every session fails a gate here anyway.
/// `claude_id` is ignored.
#[must_use]
pub fn is_quiescent(policy: &AutoSleep, candidate: &SleepCandidate) -> bool {
    policy.enabled
        && candidate.foreground == PtyForeground::Claude
        && candidate
            .idle_secs
            .is_some_and(|secs| secs >= policy.after_secs)
        && !candidate.focused
        && !candidate.has_running_shells
        && !candidate.has_running_subagents
}

/// Whether this session should be slept now: quiescent, and a resumable id
/// exists so waking is guaranteed possible.
#[must_use]
pub fn should_sleep(policy: &AutoSleep, candidate: &SleepCandidate) -> bool {
    is_quiescent(policy, candidate) && candidate.claude_id.is_some_and(is_safe_claude_id)
}

/// Whether a slept session may be woken by typing `claude --resume` into its
/// shell. Only a shell sitting at its own prompt may be typed into — anything
/// else (claude still dying, a user-run command, an unreadable table) means
/// wait; the caller retries on a later pass.
#[must_use]
pub fn can_type_resume(foreground: PtyForeground) -> bool {
    foreground == PtyForeground::ShellPrompt
}

/// How long a stop signal may stay unconfirmed before the attempt is
/// abandoned (claude ignored it, or is taking too long to exit). The session
/// simply stays awake; a later pass may retry.
pub const STOP_CONFIRM_MAX_SECS: u64 = 60;

/// How long the wake path may keep failing before the session is reported
/// stuck. A stuck session stops being auto-retried (only a fresh user focus
/// tries again), so this bounds how long a genuinely unresumable session — a
/// purged conversation id that always fails "No conversation found" — keeps
/// re-typing the doomed resume before it settles to a stuck moon.
pub const WAKE_RETRY_MAX_SECS: u64 = 24;

/// How long after typing `claude --resume` to wait for a `claude` to appear in
/// the foreground before judging the wake to have failed. A successful resume
/// makes `claude` the terminal foreground within a beat (the process holds the
/// terminal even while it loads the conversation), so a shell still at its own
/// prompt a couple of ticks later is proof the resume did not take (a purged
/// id, an immediate error). Kept short so a failed wake settles quickly instead
/// of spinning for the old 30s.
pub const WAKE_CONFIRM_MAX_SECS: u64 = 10;

/// Where a session sits in the [Sleeping session] lifecycle — the whole answer
/// to "is this session asleep, and can it come back?".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SleepState {
    /// Running normally: nothing has been stopped.
    Awake,
    /// Its `claude` was signalled; its shell has not yet been seen back at its
    /// prompt, so it is not safe to type into.
    Stopping,
    /// Confirmed asleep: the shell was *seen* at its prompt, so the wake path
    /// may type `claude --resume`.
    Asleep,
    /// Asleep, but every wake attempt in the retry window failed. Still
    /// resumable in principle — this is a report to the user, not a give-up.
    Stuck,
}

impl SleepState {
    /// The wire name the frontend renders (`session-sleeping` event). The one
    /// place the vocabulary lives, so the Rust emit and the TypeScript
    /// `SleepPhase` union cannot drift. `Stopping` is deliberately reported as
    /// `"awake"`: nothing is safe to type into yet, and the row must look
    /// normal until the stop is confirmed.
    #[must_use]
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::Asleep => "asleep",
            Self::Stuck => "stuck",
            Self::Awake | Self::Stopping => "awake",
        }
    }

    /// How this state is written to the persisted sleep mark, or `None` for a
    /// state that must never be persisted. Only a *confirmed stopped* session
    /// (`Asleep`/`Stuck`) is written: `Stopping` is not yet safe to wake, and a
    /// restart must not restore a stop that was never confirmed.
    #[must_use]
    pub const fn persist_mark(self) -> Option<&'static str> {
        match self {
            Self::Asleep => Some("asleep"),
            Self::Stuck => Some("stuck"),
            Self::Awake | Self::Stopping => None,
        }
    }

    /// Parse a persisted sleep mark back into the state to restore at launch.
    /// Unknown text degrades to `None` (the mark is ignored) rather than
    /// failing — a store written by a newer build must never break startup.
    #[must_use]
    pub fn from_persist_mark(mark: &str) -> Option<Self> {
        match mark {
            "asleep" => Some(Self::Asleep),
            "stuck" => Some(Self::Stuck),
            _ => None,
        }
    }
}

/// What an [`SleepLedger::observe`] or wake report changed, when it changed
/// something. The shell turns these into signals, events and log lines; the
/// ledger itself never does IO.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SleepTransition {
    /// The stop is confirmed — the session is now asleep.
    Confirmed,
    /// The stop never took (claude outlasted the window); the session is awake
    /// again and may be retried on a later pass.
    Abandoned,
    /// The session's whole process tree is gone — it was closed mid-stop or
    /// mid-wake. Nothing to mark, nothing to wake.
    Vanished,
    /// Waking has failed for the whole retry window.
    Stuck,
    /// A typed resume was confirmed: a `claude` is back in the foreground, so
    /// the session is awake again.
    Woke,
}

/// What the ledger remembers about one session. Absent from the map means an
/// ordinary awake session with no idle clock and no background shells.
#[derive(Debug, Default)]
struct Entry {
    /// The stop lifecycle, when this session is in one.
    phase: Option<Phase>,
    /// When idleness was first observed. Never earlier — an unobserved past
    /// cannot be trusted.
    idle_since: Option<Instant>,
    /// Hook-derived: a background shell (a dev server claude started) is still
    /// running, and would die with `claude`. A hard veto on sleeping.
    running_shells: bool,
    /// Hook-derived: a [Subagent] is still running. Stopping `claude` now would
    /// kill its in-flight orchestration, so this is a hard veto on sleeping —
    /// the main session reads Idle during subagent work (its events are
    /// filtered by the [Main session lock]), so without this it would sleep.
    running_subagents: bool,
}

impl Entry {
    /// Whether nothing is left worth remembering, so the row can be dropped.
    fn is_empty(&self) -> bool {
        self.phase.is_none()
            && self.idle_since.is_none()
            && !self.running_shells
            && !self.running_subagents
    }
}

/// The stop lifecycle, carrying the data each stage actually needs.
#[derive(Debug)]
enum Phase {
    Stopping {
        claude_id: String,
        since: Instant,
    },
    Asleep {
        claude_id: String,
        /// When the current run of failed wakes began, if one has.
        failing_since: Option<Instant>,
    },
    /// A wake claim is held: exactly one caller got the id from
    /// [`SleepLedger::begin_wake`], typed the resume, and is waiting for a
    /// `claude` to appear before declaring the session awake. Not a public
    /// [`SleepState`] — externally the session still reads as stopped (Asleep or
    /// Stuck per `stuck`, so the moon stays) until the resume is confirmed.
    Waking {
        claude_id: String,
        /// Carried through from Asleep so the retry window accrues across
        /// claims, not per claim.
        failing_since: Option<Instant>,
        /// The claim was taken from Stuck, so a failure returns there without
        /// re-reporting the transition.
        stuck: bool,
        /// When the resume was typed, so the confirm window is measured from it.
        typed_at: Instant,
    },
    Stuck {
        claude_id: String,
    },
}

/// Every session's place in the [Sleeping session] lifecycle, in one map behind
/// one lock.
///
/// This used to be four parallel maps on the app state — an idle clock, a
/// pending-stop map, a sleeping map and a background-shell map — so every
/// caller had to know which map, keyed how, mutated in what order. Worse, the
/// pending → sleeping promotion took two locks, so a session closing between
/// them resurrected a sleeping entry for a session that no longer existed.
///
/// One map makes each transition indivisible by construction, gives every
/// phase a name, and reduces teardown to a single [`SleepLedger::forget`].
#[derive(Debug, Default)]
pub struct SleepLedger {
    entries: HashMap<String, Entry>,
}

impl SleepLedger {
    /// Where `session_id` sits right now.
    #[must_use]
    pub fn state(&self, session_id: &str) -> SleepState {
        match self.entries.get(session_id).and_then(|e| e.phase.as_ref()) {
            None => SleepState::Awake,
            Some(Phase::Stopping { .. }) => SleepState::Stopping,
            Some(Phase::Asleep { .. } | Phase::Waking { stuck: false, .. }) => SleepState::Asleep,
            Some(Phase::Stuck { .. } | Phase::Waking { stuck: true, .. }) => SleepState::Stuck,
        }
    }

    /// The frontend wire phase, which — unlike [`SleepLedger::state`] — surfaces
    /// an in-flight wake as its own `"waking"` value so the row can show a
    /// spinner instead of a static moon while the resume is confirmed. Every
    /// other phase defers to [`SleepState::wire_name`], so the vocabulary stays
    /// one home (`"asleep"` / `"stuck"` / `"awake"`) plus this overlay.
    #[must_use]
    pub fn wire_phase(&self, session_id: &str) -> &'static str {
        match self.entries.get(session_id).and_then(|e| e.phase.as_ref()) {
            Some(Phase::Waking { .. }) => "waking",
            _ => self.state(session_id).wire_name(),
        }
    }

    /// Whether the session is stopped and therefore wakeable — asleep, or
    /// asleep and stuck. Stuck sessions keep being retried, so they answer yes.
    #[must_use]
    pub fn is_sleeping(&self, session_id: &str) -> bool {
        matches!(
            self.state(session_id),
            SleepState::Asleep | SleepState::Stuck
        )
    }

    /// Whether the session is already somewhere in the stop lifecycle, and so
    /// must not be considered as a fresh sleep candidate.
    #[must_use]
    pub fn is_settling_or_asleep(&self, session_id: &str) -> bool {
        self.state(session_id) != SleepState::Awake
    }

    /// The [Claude session id] a stopped session would resume with.
    #[must_use]
    pub fn claude_id(&self, session_id: &str) -> Option<&str> {
        match self.entries.get(session_id)?.phase.as_ref()? {
            Phase::Stopping { claude_id, .. }
            | Phase::Asleep { claude_id, .. }
            | Phase::Waking { claude_id, .. }
            | Phase::Stuck { claude_id } => Some(claude_id.as_str()),
        }
    }

    /// Re-enter a session directly into the stopped lifecycle at launch, from
    /// a persisted mark — `Stuck` if `stuck`, else `Asleep`. Returns whether it
    /// was applied: a session already in the ledger (a live phase reconstructed
    /// this run) keeps its live phase and is left untouched, so restoring can
    /// never stomp fresher truth.
    ///
    /// Restores straight to a confirmed-stopped phase (never `Stopping`): the
    /// persisted mark is only ever written once a stop was confirmed, and after
    /// a restart the shell is already back at its prompt, so there is nothing
    /// left to confirm.
    pub fn restore(&mut self, session_id: String, claude_id: String, stuck: bool) -> bool {
        if self.entries.contains_key(&session_id) {
            return false;
        }
        let phase = if stuck {
            Phase::Stuck { claude_id }
        } else {
            Phase::Asleep {
                claude_id,
                failing_since: None,
            }
        };
        self.entries.insert(
            session_id,
            Entry {
                phase: Some(phase),
                ..Entry::default()
            },
        );
        true
    }

    /// Every stopped session and its state (`Asleep` or `Stuck`), for
    /// persisting the marks and seeding the frontend at launch. Excludes
    /// `Stopping` — a stop not yet confirmed must not be written as sleeping.
    #[must_use]
    pub fn sleeping_sessions(&self) -> Vec<(String, SleepState)> {
        self.entries
            .keys()
            .filter_map(|id| {
                let state = self.state(id);
                matches!(state, SleepState::Asleep | SleepState::Stuck).then(|| (id.clone(), state))
            })
            .collect()
    }

    /// Every session waiting for its stop to be confirmed.
    #[must_use]
    pub fn stopping_ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, entry)| matches!(entry.phase, Some(Phase::Stopping { .. })))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Record whether the session's status is currently idle. The clock starts
    /// when idleness is first observed and is cleared by any activity; staying
    /// idle never restarts it.
    pub fn note_idle(&mut self, session_id: &str, idle: bool, now: Instant) {
        if idle {
            self.entry_mut(session_id).idle_since.get_or_insert(now);
            return;
        }
        if let Some(entry) = self.entries.get_mut(session_id) {
            entry.idle_since = None;
            if entry.is_empty() {
                self.entries.remove(session_id);
            }
        }
    }

    /// How long the session has sat idle, or `None` while it is active (or its
    /// idleness has not been observed yet).
    #[must_use]
    pub fn idle_secs(&self, session_id: &str, now: Instant) -> Option<u64> {
        let since = self.entries.get(session_id)?.idle_since?;
        Some(now.saturating_duration_since(since).as_secs())
    }

    /// Mirror the hook-derived "a background shell is still running" veto.
    pub fn note_running_shells(&mut self, session_id: &str, running: bool) {
        if running {
            self.entry_mut(session_id).running_shells = true;
            return;
        }
        if let Some(entry) = self.entries.get_mut(session_id) {
            entry.running_shells = false;
            if entry.is_empty() {
                self.entries.remove(session_id);
            }
        }
    }

    /// Mirror the hook-derived "a [Subagent] is still running" veto.
    pub fn note_running_subagents(&mut self, session_id: &str, running: bool) {
        if running {
            self.entry_mut(session_id).running_subagents = true;
            return;
        }
        if let Some(entry) = self.entries.get_mut(session_id) {
            entry.running_subagents = false;
            if entry.is_empty() {
                self.entries.remove(session_id);
            }
        }
    }

    /// Whether a [Subagent] is still running for this session.
    #[must_use]
    pub fn has_running_subagents(&self, session_id: &str) -> bool {
        self.entries
            .get(session_id)
            .is_some_and(|entry| entry.running_subagents)
    }

    /// Whether a background shell is still running for this session.
    #[must_use]
    pub fn has_running_shells(&self, session_id: &str) -> bool {
        self.entries
            .get(session_id)
            .is_some_and(|entry| entry.running_shells)
    }

    /// Record that this session's `claude` has just been signalled.
    pub fn begin_stop(&mut self, session_id: String, claude_id: String, now: Instant) {
        self.entries.entry(session_id).or_default().phase = Some(Phase::Stopping {
            claude_id,
            since: now,
        });
    }

    /// Feed one observation of the session's terminal, and get back whatever
    /// the lifecycle did about it.
    ///
    /// Only a session already `Stopping` can transition here: an entry the
    /// caller forgot in between is gone, and confirming it back into existence
    /// is exactly the race this type removes.
    pub fn observe(
        &mut self,
        session_id: &str,
        foreground: PtyForeground,
        now: Instant,
    ) -> Option<SleepTransition> {
        let entry = self.entries.get_mut(session_id)?;
        let Some(Phase::Stopping { claude_id, since }) = entry.phase.as_ref() else {
            return None;
        };
        match foreground {
            // The shell is back at its prompt: the stop took, and the wake path
            // is now safe. This is one map write, so nothing can interleave.
            PtyForeground::ShellPrompt => {
                entry.phase = Some(Phase::Asleep {
                    claude_id: claude_id.clone(),
                    failing_since: None,
                });
                Some(SleepTransition::Confirmed)
            }
            // The whole tree is gone (closed mid-stop).
            PtyForeground::NoDaemon => {
                self.clear_phase(session_id);
                Some(SleepTransition::Vanished)
            }
            // claude is still up. Give it the window, then give up.
            PtyForeground::Claude | PtyForeground::Unknown => {
                if now.saturating_duration_since(*since).as_secs() > STOP_CONFIRM_MAX_SECS {
                    self.clear_phase(session_id);
                    Some(SleepTransition::Abandoned)
                } else {
                    None
                }
            }
        }
    }

    /// Claim the right to wake this session, atomically: hands back the
    /// [Claude session id] to resume with, and marks the wake as in flight so
    /// a concurrent second caller gets `None` instead of typing a duplicate
    /// `claude --resume` into the same shell. Only a stopped session (Asleep
    /// or Stuck — both keep being retried) hands out a claim.
    ///
    /// Every claim is settled by [`SleepLedger::observe_wake`] (a `claude`
    /// appeared, or the confirm window lapsed) or, if the resume could not even
    /// be typed, [`SleepLedger::note_wake_failed`] — otherwise the session stays
    /// in `Waking` and unwakeable. `now` stamps the confirm window's start.
    pub fn begin_wake(&mut self, session_id: &str, now: Instant) -> Option<String> {
        let entry = self.entries.get_mut(session_id)?;
        let (claude_id, failing_since, stuck) = match entry.phase.as_ref()? {
            Phase::Asleep {
                claude_id,
                failing_since,
            } => (claude_id.clone(), *failing_since, false),
            Phase::Stuck { claude_id } => (claude_id.clone(), None, true),
            // Not typable (Stopping), or another wake already holds the claim.
            Phase::Stopping { .. } | Phase::Waking { .. } => return None,
        };
        entry.phase = Some(Phase::Waking {
            claude_id: claude_id.clone(),
            failing_since,
            stuck,
            typed_at: now,
        });
        Some(claude_id)
    }

    /// Every session with a typed wake awaiting confirmation, for the confirm
    /// pass to observe.
    #[must_use]
    pub fn waking_ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, entry)| matches!(entry.phase, Some(Phase::Waking { .. })))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Observe a session whose resume was typed, and confirm or fail it — the
    /// wake-side mirror of [`SleepLedger::observe`]. A typed resume is not proof
    /// it took: only a `claude` seen back in the foreground confirms the wake.
    ///
    /// - `Claude`: confirmed — the session is awake ([`SleepTransition::Woke`]).
    /// - `ShellPrompt` past [`WAKE_CONFIRM_MAX_SECS`]: the resume was typed into
    ///   a ready shell and no `claude` ever appeared, so it failed for real (a
    ///   purged id → "No conversation found", or an immediate error). Retyping
    ///   the identical command would just fail again, so this goes straight to
    ///   `Stuck` ([`SleepTransition::Stuck`]) — one doomed resume, not a loop.
    /// - `NoDaemon`: the tree is gone ([`SleepTransition::Vanished`]).
    /// - otherwise (still within the window, or an unreadable foreground): keep
    ///   waiting.
    pub fn observe_wake(
        &mut self,
        session_id: &str,
        foreground: PtyForeground,
        now: Instant,
    ) -> Option<SleepTransition> {
        let entry = self.entries.get_mut(session_id)?;
        let Some(Phase::Waking { typed_at, .. }) = entry.phase.as_ref() else {
            return None;
        };
        match foreground {
            PtyForeground::Claude => {
                self.note_woke(session_id, now);
                Some(SleepTransition::Woke)
            }
            PtyForeground::NoDaemon => {
                self.clear_phase(session_id);
                Some(SleepTransition::Vanished)
            }
            PtyForeground::ShellPrompt => {
                let elapsed = now.saturating_duration_since(*typed_at).as_secs();
                if elapsed <= WAKE_CONFIRM_MAX_SECS {
                    None // claude may still be starting up.
                } else {
                    self.mark_wake_stuck(session_id)
                }
            }
            // claude may have handed the terminal to a child while starting;
            // wait rather than judge the resume failed.
            PtyForeground::Unknown => None,
        }
    }

    /// A typed resume that never brought `claude` up: give up to `Stuck` now.
    /// Retyping the identical command into the same shell would just fail the
    /// same way, so this is a one-shot verdict, not a retry.
    fn mark_wake_stuck(&mut self, session_id: &str) -> Option<SleepTransition> {
        let entry = self.entries.get_mut(session_id)?;
        let Some(Phase::Waking { claude_id, .. }) = entry.phase.as_ref() else {
            return None;
        };
        let claude_id = claude_id.clone();
        entry.phase = Some(Phase::Stuck { claude_id });
        Some(SleepTransition::Stuck)
    }

    /// Report that a claimed wake attempt did not land, rolling the claim back
    /// so a later pass can retry. Returns [`SleepTransition::Stuck`] the moment
    /// the retry window is exhausted — once only, so the caller can surface it
    /// without repeating itself.
    pub fn note_wake_failed(&mut self, session_id: &str, now: Instant) -> Option<SleepTransition> {
        let entry = self.entries.get_mut(session_id)?;
        let Some(Phase::Waking {
            claude_id,
            failing_since,
            stuck,
            ..
        }) = entry.phase.as_mut()
        else {
            return None; // No claim in flight: nothing to settle.
        };
        if *stuck {
            // Already reported; return to Stuck without repeating it.
            entry.phase = Some(Phase::Stuck {
                claude_id: claude_id.clone(),
            });
            return None;
        }
        let started = *failing_since.get_or_insert(now);
        if now.saturating_duration_since(started).as_secs() <= WAKE_RETRY_MAX_SECS {
            let phase = Phase::Asleep {
                claude_id: claude_id.clone(),
                failing_since: Some(started),
            };
            entry.phase = Some(phase);
            return None;
        }
        entry.phase = Some(Phase::Stuck {
            claude_id: claude_id.clone(),
        });
        Some(SleepTransition::Stuck)
    }

    /// Reconcile a stopped session against a live observation: if a `claude` is
    /// back in its terminal foreground, the session is awake again — the user
    /// resumed it themselves (the [`SleepState::Stuck`] UI tells them to), or a
    /// wake landed. Returns whether it cleared the stop.
    ///
    /// Without this the ledger only ever leaves the stopped states via the wake
    /// path, so a manually-resumed `Stuck` session would sit red-moon-marked on
    /// a perfectly healthy `claude` forever, and the focused-wake retry would
    /// churn `begin_wake`/`note_wake_failed` against it every pass.
    pub fn note_resumed(
        &mut self,
        session_id: &str,
        foreground: PtyForeground,
        now: Instant,
    ) -> bool {
        if foreground == PtyForeground::Claude
            && matches!(
                self.state(session_id),
                SleepState::Asleep | SleepState::Stuck
            )
        {
            self.note_woke(session_id, now);
            return true;
        }
        false
    }

    /// Record that the session is awake again — the resume was typed.
    ///
    /// Restarts the idle clock. `claude --resume` submits no prompt, so the
    /// session's status stays Idle after waking; keeping the old clock would
    /// make it instantly re-sleepable and thrash it between sleep and wake
    /// every time the user looked away.
    pub fn note_woke(&mut self, session_id: &str, now: Instant) {
        let entry = self.entry_mut(session_id);
        entry.phase = None;
        entry.idle_since = Some(now);
    }

    /// Drop every trace of a session. The single call `close_session` needs.
    pub fn forget(&mut self, session_id: &str) {
        self.entries.remove(session_id);
    }

    fn entry_mut(&mut self, session_id: &str) -> &mut Entry {
        // `entry` needs an owned key; only allocate when the row is new.
        if !self.entries.contains_key(session_id) {
            self.entries
                .insert(session_id.to_string(), Entry::default());
        }
        self.entries
            .get_mut(session_id)
            .expect("just inserted if absent")
    }

    /// Return the session to Awake, dropping the row if nothing else is left.
    fn clear_phase(&mut self, session_id: &str) {
        if let Some(entry) = self.entries.get_mut(session_id) {
            entry.phase = None;
            if entry.is_empty() {
                self.entries.remove(session_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate() -> SleepCandidate<'static> {
        SleepCandidate {
            foreground: PtyForeground::Claude,
            idle_secs: Some(4 * 3600),
            focused: false,
            has_running_shells: false,
            has_running_subagents: false,
            claude_id: Some("1bd1a9d0-b063-4d26-9233-7fb896735b67"),
        }
    }

    #[test]
    fn a_long_idle_unfocused_claude_session_sleeps() {
        assert!(should_sleep(&AutoSleep::default(), &candidate()));
    }

    #[test]
    fn sleeping_now_waives_only_the_idle_threshold() {
        // "Sleep idle sessions now" is the user asking for memory back. It must
        // work with auto-sleep switched off and however briefly a session has
        // been idle — and must still refuse everything that protects work.
        let now = AutoSleep::NOW;
        let just_idle = SleepCandidate {
            idle_secs: Some(0),
            ..candidate()
        };
        assert!(should_sleep(&now, &just_idle));
        assert!(!should_sleep(&AutoSleep::default(), &just_idle));

        let mid_turn = SleepCandidate {
            idle_secs: None,
            ..candidate()
        };
        assert!(!should_sleep(&now, &mid_turn), "never a session mid-turn");
        let watched = SleepCandidate {
            focused: true,
            ..candidate()
        };
        assert!(!should_sleep(&now, &watched), "never the one on screen");
        let serving = SleepCandidate {
            has_running_shells: true,
            ..candidate()
        };
        assert!(!should_sleep(&now, &serving), "never a running dev server");
    }

    #[test]
    fn every_gate_vetoes_alone() {
        let policy = AutoSleep::default();
        assert!(!should_sleep(
            &AutoSleep {
                enabled: false,
                ..policy
            },
            &candidate()
        ));
        assert!(!should_sleep(
            &policy,
            &SleepCandidate {
                foreground: PtyForeground::ShellPrompt,
                ..candidate()
            }
        ));
        assert!(!should_sleep(
            &policy,
            &SleepCandidate {
                foreground: PtyForeground::Unknown,
                ..candidate()
            }
        ));
        assert!(!should_sleep(
            &policy,
            &SleepCandidate {
                idle_secs: Some(policy.after_secs - 1),
                ..candidate()
            }
        ));
        assert!(!should_sleep(
            &policy,
            &SleepCandidate {
                idle_secs: None,
                ..candidate()
            }
        ));
        assert!(!should_sleep(
            &policy,
            &SleepCandidate {
                focused: true,
                ..candidate()
            }
        ));
        assert!(!should_sleep(
            &policy,
            &SleepCandidate {
                has_running_shells: true,
                ..candidate()
            }
        ));
        // A running subagent vetoes sleep — the main session reads Idle while
        // the subagent works, so without this gate its claude would be stopped
        // mid-orchestration.
        assert!(!should_sleep(
            &policy,
            &SleepCandidate {
                has_running_subagents: true,
                ..candidate()
            }
        ));
        assert!(!should_sleep(
            &policy,
            &SleepCandidate {
                claude_id: None,
                ..candidate()
            }
        ));
    }

    #[test]
    fn only_uuid_shaped_claude_ids_are_typed() {
        assert!(is_safe_claude_id("1bd1a9d0-b063-4d26-9233-7fb896735b67"));
        assert!(is_safe_claude_id("abc_123"));
        assert!(!is_safe_claude_id(""));
        assert!(!is_safe_claude_id("x; rm -rf /"));
        assert!(!is_safe_claude_id("a".repeat(65).as_str()));
        // Charset-legal but flag-shaped: a leading dash would tokenize as a
        // separate `claude` flag, not the resume value. A prompt-injected
        // session could plant this via a hook event's session_id.
        assert!(!is_safe_claude_id("--dangerously-skip-permissions"));
        assert!(!is_safe_claude_id("-h"));
        assert!(!is_safe_claude_id("--resume"));
        // A dash inside the id is fine — only a leading one is a flag.
        assert!(is_safe_claude_id("abc-def"));
        let candidate = SleepCandidate {
            claude_id: Some("$(evil)"),
            ..candidate()
        };
        assert!(!should_sleep(&AutoSleep::default(), &candidate));
    }

    #[test]
    fn sleep_states_map_to_stable_wire_and_persist_vocabularies() {
        // The frontend union and the persisted mark both read these strings;
        // pin them so a rename or a new variant can't silently drift either.
        assert_eq!(SleepState::Awake.wire_name(), "awake");
        assert_eq!(SleepState::Stopping.wire_name(), "awake");
        assert_eq!(SleepState::Asleep.wire_name(), "asleep");
        assert_eq!(SleepState::Stuck.wire_name(), "stuck");

        assert_eq!(SleepState::Awake.persist_mark(), None);
        assert_eq!(
            SleepState::Stopping.persist_mark(),
            None,
            "unconfirmed stop"
        );
        assert_eq!(SleepState::Asleep.persist_mark(), Some("asleep"));
        assert_eq!(SleepState::Stuck.persist_mark(), Some("stuck"));

        assert_eq!(
            SleepState::from_persist_mark("asleep"),
            Some(SleepState::Asleep)
        );
        assert_eq!(
            SleepState::from_persist_mark("stuck"),
            Some(SleepState::Stuck)
        );
        assert_eq!(SleepState::from_persist_mark("awake"), None);
        assert_eq!(SleepState::from_persist_mark("garbage"), None);
    }

    #[test]
    fn is_quiescent_ignores_the_claude_id_so_the_cheap_pre_gate_holds() {
        // sleep_pass calls is_quiescent with claude_id: None as the cheap gate
        // before the per-session store read. If the id gate ever folded back
        // in here, every session would fail the pre-gate and auto-sleep would
        // silently stop — yet every should_sleep test (all with a valid id)
        // would still pass. Pin the split directly.
        let policy = AutoSleep::default();
        let no_id = SleepCandidate {
            claude_id: None,
            ..candidate()
        };
        assert!(is_quiescent(&policy, &no_id), "quiescence ignores the id");
        assert!(
            !should_sleep(&policy, &no_id),
            "but sleeping still requires one"
        );
    }

    #[test]
    fn resume_is_typed_only_into_a_shell_at_its_prompt() {
        assert!(can_type_resume(PtyForeground::ShellPrompt));
        assert!(!can_type_resume(PtyForeground::Claude));
        assert!(!can_type_resume(PtyForeground::Unknown));
        assert!(!can_type_resume(PtyForeground::NoDaemon));
    }

    mod ledger {
        use std::time::Duration;

        use super::*;

        const CLAUDE_ID: &str = "1bd1a9d0-b063-4d26-9233-7fb896735b67";

        fn at(base: Instant, secs: u64) -> Instant {
            base + Duration::from_secs(secs)
        }

        #[test]
        fn an_untracked_session_is_awake_and_has_no_idle_clock() {
            let ledger = SleepLedger::default();
            assert_eq!(ledger.state("s1"), SleepState::Awake);
            assert_eq!(ledger.idle_secs("s1", Instant::now()), None);
            assert_eq!(ledger.claude_id("s1"), None);
            assert!(!ledger.has_running_shells("s1"));
        }

        #[test]
        fn the_idle_clock_starts_when_idleness_is_first_seen_and_resets_on_activity() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();

            ledger.note_idle("s1", false, t0);
            assert_eq!(ledger.idle_secs("s1", at(t0, 10)), None, "active: no clock");

            ledger.note_idle("s1", true, t0);
            assert_eq!(ledger.idle_secs("s1", at(t0, 90)), Some(90));
            // Staying idle must not restart the clock.
            ledger.note_idle("s1", true, at(t0, 90));
            assert_eq!(ledger.idle_secs("s1", at(t0, 120)), Some(120));

            ledger.note_idle("s1", false, at(t0, 121));
            assert_eq!(ledger.idle_secs("s1", at(t0, 200)), None, "activity resets");
        }

        #[test]
        fn a_stop_confirms_only_once_the_shell_is_seen_at_its_prompt() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            assert_eq!(ledger.state("s1"), SleepState::Stopping);

            // claude is still dying: no transition, still Stopping.
            assert_eq!(ledger.observe("s1", PtyForeground::Claude, at(t0, 5)), None);
            assert_eq!(ledger.state("s1"), SleepState::Stopping);

            assert_eq!(
                ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 6)),
                Some(SleepTransition::Confirmed)
            );
            assert_eq!(ledger.state("s1"), SleepState::Asleep);
            assert_eq!(ledger.claude_id("s1"), Some(CLAUDE_ID));
        }

        #[test]
        fn confirming_and_sleeping_are_one_indivisible_step() {
            // The bug this type exists to make impossible: the old code removed
            // from `pending_sleep` and inserted into `sleeping` under two
            // separate locks, so a close landing between them resurrected a
            // sleeping entry for a session that no longer existed.
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.forget("s1");
            assert_eq!(
                ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1)),
                None,
                "a forgotten session cannot be confirmed back into existence"
            );
            assert_eq!(ledger.state("s1"), SleepState::Awake);
        }

        #[test]
        fn a_stop_claude_ignored_is_abandoned_after_the_timeout() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);

            let just_inside = at(t0, STOP_CONFIRM_MAX_SECS);
            assert_eq!(
                ledger.observe("s1", PtyForeground::Claude, just_inside),
                None
            );

            let past = at(t0, STOP_CONFIRM_MAX_SECS + 1);
            assert_eq!(
                ledger.observe("s1", PtyForeground::Claude, past),
                Some(SleepTransition::Abandoned)
            );
            assert_eq!(ledger.state("s1"), SleepState::Awake);
        }

        #[test]
        fn observing_unknown_waits_then_abandons_but_never_confirms() {
            // Unknown is grouped with Claude (wait, then abandon), never with
            // ShellPrompt. Confirmation is what licenses typing into the
            // terminal, so an Unknown foreground must never Confirm a stop.
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            assert_eq!(
                ledger.observe("s1", PtyForeground::Unknown, at(t0, STOP_CONFIRM_MAX_SECS)),
                None,
                "inside the window: keep waiting"
            );
            assert_eq!(ledger.state("s1"), SleepState::Stopping);
            assert_eq!(
                ledger.observe(
                    "s1",
                    PtyForeground::Unknown,
                    at(t0, STOP_CONFIRM_MAX_SECS + 1)
                ),
                Some(SleepTransition::Abandoned),
                "past the window: abandon, never confirm"
            );
            assert_eq!(ledger.state("s1"), SleepState::Awake);
        }

        #[test]
        fn a_stopped_session_seen_with_a_live_claude_wakes_itself() {
            // The user manually resumes a Stuck session: claude is back in the
            // foreground, so the ledger must clear the stop rather than keep the
            // red moon and churn wake retries against a healthy claude.
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));
            ledger.begin_wake("s1", Instant::now());
            ledger.note_wake_failed("s1", at(t0, 2));
            ledger.begin_wake("s1", Instant::now());
            ledger.note_wake_failed("s1", at(t0, 2 + WAKE_RETRY_MAX_SECS + 1));
            assert_eq!(ledger.state("s1"), SleepState::Stuck);

            assert!(ledger.note_resumed("s1", PtyForeground::Claude, at(t0, 200)));
            assert_eq!(ledger.state("s1"), SleepState::Awake);
            assert_eq!(ledger.claude_id("s1"), None);

            // Only a live claude counts, and only for a stopped session.
            let mut asleep = SleepLedger::default();
            asleep.begin_stop("s2".to_string(), CLAUDE_ID.to_string(), t0);
            asleep.observe("s2", PtyForeground::ShellPrompt, at(t0, 1));
            assert!(!asleep.note_resumed("s2", PtyForeground::ShellPrompt, at(t0, 5)));
            assert_eq!(asleep.state("s2"), SleepState::Asleep, "still asleep");
            assert!(!asleep.note_resumed("s3", PtyForeground::Claude, at(t0, 5)));
        }

        #[test]
        fn a_tree_that_vanished_mid_stop_is_dropped_silently() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            assert_eq!(
                ledger.observe("s1", PtyForeground::NoDaemon, at(t0, 1)),
                Some(SleepTransition::Vanished)
            );
            assert_eq!(ledger.state("s1"), SleepState::Awake);
        }

        #[test]
        fn a_wake_that_keeps_failing_becomes_stuck_rather_than_a_silent_moon() {
            // The row must not sit moon-marked forever with only stderr to say
            // why; after the retry window the session is reported as stuck.
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));

            ledger.begin_wake("s1", Instant::now());
            assert_eq!(ledger.note_wake_failed("s1", at(t0, 2)), None);
            assert_eq!(ledger.state("s1"), SleepState::Asleep, "still retrying");

            let past = at(t0, 2 + WAKE_RETRY_MAX_SECS + 1);
            ledger.begin_wake("s1", Instant::now());
            assert_eq!(
                ledger.note_wake_failed("s1", past),
                Some(SleepTransition::Stuck)
            );
            assert_eq!(ledger.state("s1"), SleepState::Stuck);
            // A stuck session still knows how to be resumed.
            assert_eq!(ledger.claude_id("s1"), Some(CLAUDE_ID));
        }

        #[test]
        fn a_successful_wake_clears_the_entry_including_a_stuck_one() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));
            ledger.begin_wake("s1", Instant::now());
            ledger.note_wake_failed("s1", at(t0, 2));
            ledger.begin_wake("s1", Instant::now());
            ledger.note_wake_failed("s1", at(t0, 2 + WAKE_RETRY_MAX_SECS + 1));
            assert_eq!(ledger.state("s1"), SleepState::Stuck);

            ledger.note_woke("s1", at(t0, 3));
            assert_eq!(ledger.state("s1"), SleepState::Awake);
            assert_eq!(ledger.claude_id("s1"), None);
        }

        #[test]
        fn waking_restarts_the_idle_clock_so_the_session_is_not_re_slept() {
            // Without this, a woken session keeps the idle clock it had when it
            // was slept. `claude --resume` fires no prompt, so the status stays
            // Idle — the very next pass sees "idle for hours, claude in the
            // foreground, not focused" and sleeps it again the moment the user
            // looks away. Focus/blur thrash, forever.
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.note_idle("s1", true, t0);

            let slept_at = at(t0, 4 * 3600);
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), slept_at);
            ledger.observe("s1", PtyForeground::ShellPrompt, slept_at);
            assert_eq!(ledger.state("s1"), SleepState::Asleep);

            let woke_at = at(t0, 5 * 3600);
            ledger.note_woke("s1", woke_at);

            assert_eq!(ledger.state("s1"), SleepState::Awake);
            assert_eq!(
                ledger.idle_secs("s1", at(t0, 5 * 3600 + 30)),
                Some(30),
                "the clock restarts at the wake, not at the original idleness"
            );
        }

        #[test]
        fn a_stuck_session_keeps_being_retried_and_can_recover() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));
            ledger.begin_wake("s1", Instant::now());
            ledger.note_wake_failed("s1", at(t0, 2));
            ledger.begin_wake("s1", Instant::now());
            ledger.note_wake_failed("s1", at(t0, 2 + WAKE_RETRY_MAX_SECS + 1));
            assert_eq!(ledger.state("s1"), SleepState::Stuck);
            // Stuck is a report, not a giving-up: the id is still resumable and
            // reports as sleeping so the wake path keeps trying.
            assert!(ledger.is_sleeping("s1"));
            ledger.begin_wake("s1", Instant::now());
            assert_eq!(
                ledger.note_wake_failed("s1", at(t0, 9999)),
                None,
                "already stuck: no repeated transition"
            );
        }

        #[test]
        fn a_persisted_mark_restores_into_the_lifecycle_at_launch() {
            // A [Sleeping session] must survive an app restart: the daemon and
            // the stopped shell are still there, so losing the ledger entry
            // would silently drop the moon and the wake-on-focus affordance.
            let mut ledger = SleepLedger::default();
            assert!(ledger.restore("s1".to_string(), CLAUDE_ID.to_string(), false));
            assert_eq!(ledger.state("s1"), SleepState::Asleep);
            assert_eq!(ledger.claude_id("s1"), Some(CLAUDE_ID));
            assert_eq!(
                ledger.begin_wake("s1", Instant::now()),
                Some(CLAUDE_ID.to_string())
            );

            let mut stuck = SleepLedger::default();
            assert!(stuck.restore("s2".to_string(), CLAUDE_ID.to_string(), true));
            assert_eq!(stuck.state("s2"), SleepState::Stuck);
        }

        #[test]
        fn a_restore_never_stomps_a_live_lifecycle() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            assert!(
                !ledger.restore("s1".to_string(), "other".to_string(), false),
                "a session already in the lifecycle keeps its live phase"
            );
            assert_eq!(ledger.state("s1"), SleepState::Stopping);
            assert_eq!(ledger.claude_id("s1"), Some(CLAUDE_ID));
        }

        #[test]
        fn the_stopped_sessions_are_listed_for_seeding_the_frontend() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.restore("asleep".to_string(), CLAUDE_ID.to_string(), false);
            ledger.restore("stuck".to_string(), CLAUDE_ID.to_string(), true);
            ledger.begin_stop("stopping".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.note_idle("awake", true, t0);

            let mut listed = ledger.sleeping_sessions();
            listed.sort_by(|a, b| a.0.cmp(&b.0));
            assert_eq!(
                listed,
                vec![
                    ("asleep".to_string(), SleepState::Asleep),
                    ("stuck".to_string(), SleepState::Stuck),
                ]
            );
        }

        #[test]
        fn wire_phase_surfaces_an_in_flight_wake_as_waking() {
            // The row shows a spinner while a wake is in flight, so the ledger
            // must expose Waking distinctly even though `state()` still reports
            // it as Asleep/Stuck for the wake machinery.
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            assert_eq!(ledger.wire_phase("s1"), "awake");
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            assert_eq!(
                ledger.wire_phase("s1"),
                "awake",
                "stopping still looks awake"
            );
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));
            assert_eq!(ledger.wire_phase("s1"), "asleep");

            ledger.begin_wake("s1", at(t0, 2));
            assert_eq!(
                ledger.wire_phase("s1"),
                "waking",
                "spinner while confirming"
            );
            assert_eq!(
                ledger.state("s1"),
                SleepState::Asleep,
                "but still asleep to the machinery"
            );
            ledger.observe_wake("s1", PtyForeground::Claude, at(t0, 3));
            assert_eq!(ledger.wire_phase("s1"), "awake");
        }

        #[test]
        fn a_typed_wake_confirms_only_once_a_live_claude_is_seen() {
            // Wake mirrors stop: typing the resume is not proof it took. The
            // session stays Waking (still reads asleep, moon on) until a pass
            // observes claude back in the foreground.
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));

            assert_eq!(
                ledger.begin_wake("s1", at(t0, 2)),
                Some(CLAUDE_ID.to_string())
            );
            assert_eq!(
                ledger.state("s1"),
                SleepState::Asleep,
                "waking still reads asleep"
            );
            assert_eq!(ledger.waking_ids(), vec!["s1".to_string()]);

            // claude not up yet: keep waiting, no transition.
            assert_eq!(
                ledger.observe_wake("s1", PtyForeground::Unknown, at(t0, 3)),
                None
            );
            assert_eq!(ledger.state("s1"), SleepState::Asleep);

            // claude is back: confirmed awake, mark cleared.
            assert_eq!(
                ledger.observe_wake("s1", PtyForeground::Claude, at(t0, 5)),
                Some(SleepTransition::Woke)
            );
            assert_eq!(ledger.state("s1"), SleepState::Awake);
            assert_eq!(ledger.claude_id("s1"), None);
            assert_eq!(ledger.waking_ids(), [] as [String; 0]);
        }

        #[test]
        fn a_typed_wake_that_never_brings_claude_up_gives_up_to_stuck_in_one_shot() {
            // The shell sits back at its prompt with no claude past the confirm
            // window: the resume was typed into a ready shell and failed for
            // real (bad id → "No conversation found"). Retyping it would fail
            // the same way, so it goes straight to Stuck — no retry loop that
            // spams the terminal with a doomed `claude --resume`.
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));

            ledger.begin_wake("s1", at(t0, 2));
            // Within the confirm window, a bare prompt is not yet a failure —
            // claude may still be coming up.
            assert_eq!(
                ledger.observe_wake(
                    "s1",
                    PtyForeground::ShellPrompt,
                    at(t0, 2 + WAKE_CONFIRM_MAX_SECS)
                ),
                None
            );
            assert_eq!(ledger.state("s1"), SleepState::Asleep, "still waking");
            // Past the window, one confirmed failure is enough: straight to Stuck.
            assert_eq!(
                ledger.observe_wake(
                    "s1",
                    PtyForeground::ShellPrompt,
                    at(t0, 2 + WAKE_CONFIRM_MAX_SECS + 1)
                ),
                Some(SleepTransition::Stuck)
            );
            assert_eq!(ledger.state("s1"), SleepState::Stuck);
            assert!(ledger.waking_ids().is_empty(), "claim released");
        }

        #[test]
        fn a_tree_that_vanished_mid_wake_is_dropped() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));
            ledger.begin_wake("s1", at(t0, 2));
            assert_eq!(
                ledger.observe_wake("s1", PtyForeground::NoDaemon, at(t0, 3)),
                Some(SleepTransition::Vanished)
            );
            assert_eq!(ledger.state("s1"), SleepState::Awake);
        }

        #[test]
        fn a_wake_in_flight_cannot_be_claimed_twice() {
            // Two wake paths run concurrently — the focus command and the
            // ticker's retry. Both used to read "is sleeping" and then type
            // `claude --resume`, so both could type it; the second line landed
            // inside the freshly resumed claude as a prompt. The claim makes
            // the race impossible: exactly one caller gets the id.
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));

            assert_eq!(
                ledger.begin_wake("s1", Instant::now()),
                Some(CLAUDE_ID.to_string())
            );
            assert_eq!(
                ledger.begin_wake("s1", Instant::now()),
                None,
                "already claimed"
            );
            // The claimed session still reads as stopped everywhere else.
            assert!(ledger.is_sleeping("s1"));
            assert!(ledger.is_settling_or_asleep("s1"));
            assert_eq!(ledger.state("s1"), SleepState::Asleep);
        }

        #[test]
        fn only_a_stopped_session_hands_out_a_wake_claim() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            assert_eq!(
                ledger.begin_wake("s1", Instant::now()),
                None,
                "awake: nothing to wake"
            );
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            assert_eq!(
                ledger.begin_wake("s1", Instant::now()),
                None,
                "stopping: not typable yet"
            );
        }

        #[test]
        fn a_failed_claim_rolls_back_and_still_ages_into_stuck() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));

            assert!(ledger.begin_wake("s1", Instant::now()).is_some());
            assert_eq!(ledger.note_wake_failed("s1", at(t0, 2)), None);
            assert_eq!(ledger.state("s1"), SleepState::Asleep, "rolled back");

            // The failure window accrues across claims, not per claim.
            assert!(
                ledger.begin_wake("s1", Instant::now()).is_some(),
                "retryable after rollback"
            );
            assert_eq!(
                ledger.note_wake_failed("s1", at(t0, 2 + WAKE_RETRY_MAX_SECS + 1)),
                Some(SleepTransition::Stuck)
            );
            assert_eq!(ledger.state("s1"), SleepState::Stuck);
        }

        #[test]
        fn a_stuck_session_claim_that_fails_stays_stuck_without_re_reporting() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));
            ledger.begin_wake("s1", Instant::now());
            ledger.note_wake_failed("s1", at(t0, 2));
            ledger.begin_wake("s1", Instant::now());
            ledger.note_wake_failed("s1", at(t0, 2 + WAKE_RETRY_MAX_SECS + 1));
            assert_eq!(ledger.state("s1"), SleepState::Stuck);

            // Stuck keeps being retried; a failed retry must not fire a second
            // Stuck report, and a successful one recovers fully.
            assert_eq!(
                ledger.begin_wake("s1", Instant::now()),
                Some(CLAUDE_ID.to_string())
            );
            assert_eq!(ledger.note_wake_failed("s1", at(t0, 9999)), None);
            assert_eq!(ledger.state("s1"), SleepState::Stuck);

            assert!(ledger.begin_wake("s1", Instant::now()).is_some());
            ledger.note_woke("s1", at(t0, 10_000));
            assert_eq!(ledger.state("s1"), SleepState::Awake);
        }

        #[test]
        fn a_session_forgotten_mid_wake_cannot_be_revived_by_the_outcome() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));
            ledger.begin_wake("s1", Instant::now());

            ledger.forget("s1");

            assert_eq!(ledger.note_wake_failed("s1", at(t0, 2)), None);
            assert_eq!(ledger.state("s1"), SleepState::Awake);
        }

        #[test]
        fn running_background_shells_are_tracked_and_forgotten_with_the_session() {
            let mut ledger = SleepLedger::default();
            ledger.note_running_shells("s1", true);
            assert!(ledger.has_running_shells("s1"));
            ledger.note_running_shells("s1", false);
            assert!(!ledger.has_running_shells("s1"));

            ledger.note_running_shells("s1", true);
            ledger.forget("s1");
            assert!(
                !ledger.has_running_shells("s1"),
                "one forget clears every trace of the session"
            );
        }

        #[test]
        fn running_subagents_are_tracked_independently_of_shells() {
            let mut ledger = SleepLedger::default();
            ledger.note_running_subagents("s1", true);
            assert!(ledger.has_running_subagents("s1"));
            assert!(
                !ledger.has_running_shells("s1"),
                "the two vetoes are independent"
            );
            ledger.note_running_subagents("s1", false);
            assert!(!ledger.has_running_subagents("s1"));

            // Clearing one veto must not drop a row the other still holds.
            ledger.note_running_shells("s1", true);
            ledger.note_running_subagents("s1", true);
            ledger.note_running_subagents("s1", false);
            assert!(
                ledger.has_running_shells("s1"),
                "the shell veto survives clearing the subagent one"
            );

            ledger.note_running_subagents("s1", true);
            ledger.forget("s1");
            assert!(!ledger.has_running_subagents("s1"));
        }

        #[test]
        fn forget_clears_the_idle_clock_and_the_phase_together() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.note_idle("s1", true, t0);
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.note_running_shells("s1", true);

            ledger.forget("s1");

            assert_eq!(ledger.state("s1"), SleepState::Awake);
            assert_eq!(ledger.idle_secs("s1", at(t0, 500)), None);
            assert_eq!(ledger.claude_id("s1"), None);
            assert!(!ledger.has_running_shells("s1"));
        }

        #[test]
        fn a_session_already_in_the_ledger_is_not_a_sleep_candidate_again() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            assert!(ledger.is_settling_or_asleep("s1"));
            ledger.observe("s1", PtyForeground::ShellPrompt, at(t0, 1));
            assert!(ledger.is_settling_or_asleep("s1"));
            ledger.note_woke("s1", at(t0, 3));
            assert!(!ledger.is_settling_or_asleep("s1"));
        }

        #[test]
        fn stopping_sessions_are_listed_for_the_confirm_pass() {
            let t0 = Instant::now();
            let mut ledger = SleepLedger::default();
            ledger.begin_stop("s1".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.begin_stop("s2".to_string(), CLAUDE_ID.to_string(), t0);
            ledger.observe("s2", PtyForeground::ShellPrompt, at(t0, 1));
            ledger.note_idle("s3", true, t0);

            let mut stopping = ledger.stopping_ids();
            stopping.sort();
            assert_eq!(stopping, vec!["s1".to_string()]);
        }
    }
}
