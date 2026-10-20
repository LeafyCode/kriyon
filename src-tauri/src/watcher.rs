//! Watch a Kriyon session's hook-events file and stream live status + the
//! Claude Code transcript.
//!
//! Interactive `claude` does not reliably write its `~/.claude/projects`
//! transcript while the session is live, so Kriyon drives status from Claude
//! Code *hook* events instead (see [`kriyon_core::hooks`] and `crate::hooks`).
//! A hook script appends one JSON line per lifecycle event to
//! `~/.claude/kriyon/events/<session_id>.jsonl`; this module tails that file:
//!
//! - each hook line → a status update (working / waiting / done / idle), and
//! - the `transcript_path` the hook reports → the authoritative on-disk
//!   transcript, which is then tailed with the existing parser (no cwd-encoding
//!   or path guessing). Nothing renders those events (ADR 0019); they feed
//!   token/cost usage totals, the sidebar's unseen-output badges, the Needs-you
//!   snippet, the handoff prompt, and the session title.
//!
//! A [`Tailer`] reads bytes appended since the last poll. All of this is
//! tolerant: missing files and malformed lines never panic.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kriyon_core::activity::{parse_task_file, SessionActivity, ShellWatch, Task};
use kriyon_core::hooks::{parse_hook_line, parse_usage_snapshot, HookEvent, UsageSnapshot};
use kriyon_core::projection::SessionActivityProjection;
use kriyon_core::session::SessionId;
use kriyon_core::transcript::{
    parse_line, parse_provisional_title, parse_studio_events_guarded, parse_title, DriftReport,
    StructuredEvent, StudioEvent,
};

/// Incrementally reads newline-terminated lines appended to a file. A trailing
/// line without a newline is held in `partial` until a later poll completes it.
/// The file not existing yet is not an error: a poll simply yields nothing.
pub struct Tailer {
    path: PathBuf,
    offset: u64,
    partial: String,
}

impl Tailer {
    /// Create a tailer positioned at the start of `path`.
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            partial: String::new(),
        }
    }

    /// Create a tailer positioned at the current end of `path`, so only lines
    /// appended *after* construction are read. Used for the hook-events file on
    /// a (re)subscribe: historical lines describe a process that no longer
    /// exists and must not drive live status or activity. A missing file starts
    /// at offset 0 (it behaves exactly like [`Self::new`] until written).
    #[must_use]
    pub fn at_end(path: PathBuf) -> Self {
        let offset = std::fs::metadata(&path).map_or(0, |m| m.len());
        Self {
            path,
            offset,
            partial: String::new(),
        }
    }

    /// The path this tailer is bound to.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read bytes appended since the last poll and return each complete
    /// (newline-terminated) line, in order. An incomplete trailing line is
    /// buffered until a later poll completes it.
    pub fn poll_lines(&mut self) -> Vec<String> {
        use std::io::{Read as _, Seek as _, SeekFrom};

        let Ok(mut file) = std::fs::File::open(&self.path) else {
            return Vec::new();
        };
        // Shorter than where we stopped: the file was replaced (a cleaned-up
        // [Hook spool] recreated by the next hook). Start over, or every later
        // line would be missed.
        if file.metadata().is_ok_and(|m| m.len() < self.offset) {
            self.offset = 0;
            self.partial.clear();
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }

        let mut buf = Vec::new();
        let Ok(read) = file.read_to_end(&mut buf) else {
            return Vec::new();
        };
        if read == 0 {
            return Vec::new();
        }
        self.offset += read as u64;

        // Lossy is fine: these files are UTF-8, and tolerance beats panicking.
        let chunk = String::from_utf8_lossy(&buf);
        let mut data = std::mem::take(&mut self.partial);
        data.push_str(&chunk);

        let ends_complete = data.ends_with('\n');
        let mut lines: Vec<&str> = data.split('\n').collect();
        // `split` on a string ending in `\n` leaves a trailing "" we must drop;
        // otherwise the final element is the still-incomplete partial line.
        if ends_complete {
            lines.pop();
        } else {
            self.partial = lines.pop().unwrap_or_default().to_string();
        }

        lines.into_iter().map(str::to_string).collect()
    }

    /// Read appended lines and parse each into `StructuredEvent`s, in order.
    pub fn poll(&mut self) -> Vec<StructuredEvent> {
        self.poll_lines()
            .iter()
            .flat_map(|line| parse_line(line))
            .collect()
    }
}

/// The live sources a session watch drains each pump, grouped so the pump is a
/// simple driver. Each source owns one job (poll + dedup) and is unit-testable
/// in isolation; the cross-source coupling (transcript path, task-store dir, and
/// activity ingestion all learned from hook events) is explicit via `observe_hook`.
struct Sources {
    hooks: HookSource,
    transcript: TranscriptSource,
    activity: ActivitySource,
    usage: UsageSource,
}

/// Tails the Kriyon hook-events file and parses each appended line.
struct HookSource {
    events: Tailer,
}

impl HookSource {
    fn new(path: PathBuf) -> Self {
        // Seek to EOF: a resume reopens an append-only events file that still
        // holds the previous run's lines. Those describe a process that no
        // longer exists, so they must not drive live status/activity. Only
        // events from the freshly (re)launched claude — appended after this —
        // count. The transcript tailer deliberately does NOT do this.
        Self {
            events: Tailer::at_end(path),
        }
    }

    /// Parse every hook line appended since the last poll, in order. Malformed
    /// lines are dropped (the tailer never hard-errors).
    fn poll(&mut self) -> Vec<HookEvent> {
        self.events
            .poll_lines()
            .iter()
            .filter_map(|line| parse_hook_line(line))
            .collect()
    }
}

/// Tails the Claude Code transcript that feeds Kriyon's transcript-derived data
/// (usage totals, unseen-output badges, the Needs-you snippet, the handoff
/// prompt, the session title). The path is unknown until a hook reports it, so
/// the tailer is bound lazily from the first hook event carrying a
/// `transcript_path`.
struct TranscriptSource {
    /// The transcript path each Claude session id last reported in a hook. A
    /// terminal that `/resume`s or restarts cycles through several Claude
    /// sessions, each writing its own transcript file, so the path of *every*
    /// session is remembered — [`Self::bind_to`] then follows the live main one
    /// rather than the first one seen.
    paths: HashMap<String, PathBuf>,
    /// The Claude session id the tailer is currently bound to, so a rebind is
    /// paid only when the live main session actually changes.
    bound: Option<String>,
    tailer: Option<Tailer>,
    /// Newest [Session title] (`ai-title`) seen since the last [`Self::take_title`].
    pending_title: Option<String>,
    /// Last title handed out, to suppress re-emitting an unchanged one.
    last_title: Option<String>,
    /// A label for the session's *first* user prompt, standing in until Claude
    /// writes a real `ai-title` — which it never does for a session driven
    /// purely by slash commands. Captured once per binding and then held, not
    /// consumed: a later prompt must never rename an already-labelled session.
    first_prompt_label: Option<String>,
    /// Whether a real `ai-title` has been seen on this binding. Once it has, the
    /// prompt fallback is retired: a later prompt must not demote the session.
    titled: bool,
    /// Running drift picture across the whole session, accumulated per parsed
    /// line so a creeping format change is caught, not just a single bad line.
    drift: DriftReport,
    /// Whether the degraded-view warning has already been surfaced; drift is
    /// logged once per watch, not on every poll, to avoid log spam.
    drift_reported: bool,
}

impl TranscriptSource {
    fn new() -> Self {
        Self {
            paths: HashMap::new(),
            bound: None,
            tailer: None,
            pending_title: None,
            last_title: None,
            first_prompt_label: None,
            titled: false,
            drift: DriftReport::default(),
            drift_reported: false,
        }
    }

    /// Record the transcript path this hook reports for its Claude session id.
    /// Every session's path is remembered (not just the first) so the tailer can
    /// follow the live main session across `/resume` and in-terminal restarts;
    /// the actual (re)bind is [`Self::bind_to`], driven by the same main-session
    /// lock as status and the resume id.
    fn observe_hook(&mut self, event: &HookEvent) {
        let Some(sid) = event.session_id.as_deref().filter(|s| !s.is_empty()) else {
            return;
        };
        if let Some(path) = event.transcript_path.as_deref() {
            if !path.is_empty() {
                self.paths.insert(sid.to_string(), PathBuf::from(path));
            }
        }
    }

    /// Point the tailer at `main_id`'s transcript, rebinding when the live main
    /// session changes. A no-op until that session's path has been seen in a
    /// hook (or the seeded tail). Rebinding tails the new file from offset 0 —
    /// re-reading its `ai-title` — and re-arms title emission, so the resumed
    /// session's title surfaces even when the old and new files never grow
    /// again. Only the converged main session's transcript is ever bound, so a
    /// nested subagent or one-shot `claude -p` (which reports its own path in
    /// the shared events file) never diverts the derived data or the title.
    fn bind_to(&mut self, main_id: &str) {
        if self.bound.as_deref() == Some(main_id) {
            return;
        }
        let Some(path) = self.paths.get(main_id) else {
            return;
        };
        self.tailer = Some(Tailer::new(path.clone()));
        self.bound = Some(main_id.to_string());
        self.pending_title = None;
        self.last_title = None;
        self.first_prompt_label = None;
        self.titled = false;
    }

    /// Parse every transcript line appended since the last poll into tagged
    /// [`StudioEvent`]s, recording the newest `ai-title` for [`Self::take_title`].
    /// Empty until bound.
    fn poll(&mut self) -> Vec<StudioEvent> {
        let Some(tailer) = self.tailer.as_mut() else {
            return Vec::new();
        };
        let mut events = Vec::new();
        for line in tailer.poll_lines() {
            let (parsed, report) = parse_studio_events_guarded(&line);
            self.drift.merge(&report);
            events.extend(parsed);
            if let Some(title) = parse_title(&line) {
                self.pending_title = Some(title);
                self.titled = true;
            } else if !self.titled && self.first_prompt_label.is_none() {
                self.first_prompt_label = parse_provisional_title(&line);
            }
        }
        events
    }

    /// The newest [Session title] seen since the last call, returned only when
    /// it differs from the last one handed out.
    ///
    /// Claude's own `ai-title` always wins. Until it writes one — which it never
    /// does for a session whose prompts are all slash commands — the first
    /// prompt's label stands in, so those sessions are still told apart.
    fn take_title(&mut self) -> Option<String> {
        let title = self.pending_title.take().or_else(|| {
            // Cloned, never taken: the label stays available so the last-title
            // dedupe below suppresses every repeat, instead of the next prompt
            // refilling an emptied slot and renaming the session.
            (!self.titled)
                .then(|| self.first_prompt_label.clone())
                .flatten()
        })?;
        if self.last_title.as_deref() == Some(title.as_str()) {
            return None;
        }
        self.last_title = Some(title.clone());
        Some(title)
    }

    /// The accumulated [`DriftReport`] the first time transcript drift is bad
    /// enough to thin the data derived from it (usage totals, unseen-output
    /// badges, the Needs-you snippet, the handoff prompt), then `None`
    /// thereafter. The session keeps accumulating drift, but the warning is
    /// surfaced once per watch.
    fn take_drift(&mut self) -> Option<DriftReport> {
        if self.drift_reported || !self.drift.is_degraded() {
            return None;
        }
        self.drift_reported = true;
        Some(self.drift.clone())
    }
}

/// Folds Agent/Bash hook events into the live [`SessionActivity`] (subagents +
/// background shells) and reads the on-disk task store, emitting a snapshot only
/// when it differs from the last one.
/// The command lines of the session's own process tree, taken from a sweep —
/// or `None` when the process table could not be read. Supplied by the Tauri
/// shell (the only half that may touch the OS) so the source stays testable
/// from a fixture.
type LiveShells = Box<dyn Fn() -> Option<Vec<String>> + Send>;

/// How often a session's [Background shell] claims are re-derived from a sweep.
/// The pump runs every [`POLL_INTERVAL`], which is far too often for a process
/// table read and a tree build per session; this matches the table's own cache
/// window, so a claim is retracted within about two seconds of its process
/// going away.
const SHELL_SWEEP_INTERVAL: Duration = Duration::from_secs(2);

struct ActivitySource {
    /// Folds the hook stream into the session's live activity: running subagents
    /// + background shells and the open Pending ask, coordinated in one place.
    projection: SessionActivityProjection,
    /// `~/.claude/tasks` — the task-store root; the session dir is `<root>/<id>`.
    tasks_root: PathBuf,
    /// `<tasks_root>/<claude-session-id>`, bound to the projection's *converged*
    /// main session (see [Main session lock]) and re-bound when it changes. Claude
    /// owns its id and keys the task store by it (see ADR 0003), so Kriyon learns
    /// it from the hook stream rather than assuming it equals Kriyon's launch id —
    /// and must track the live session, not a first-seen nested/ended one.
    tasks_dir: Option<PathBuf>,
    /// Claude's main session id, tracking the [Main session lock], held so it can
    /// be surfaced via [`Self::take_claude_id`] and persisted as the session's
    /// [Claude session id] for `claude --resume`. Re-emitted when it changes.
    claude_id: Option<String>,
    /// Whether [`Self::take_claude_id`] has handed out the current `claude_id`.
    /// Cleared by [`Self::sync_main_session`] when the id changes, re-arming it.
    claude_id_taken: bool,
    /// Last serialized snapshot, to suppress duplicate emits.
    last: Option<String>,
    /// The task dir and its [`tasks_signature`] when [`Self::tasks_cache`] was
    /// last read, so an unchanged dir reuses the cache instead of re-reading and
    /// re-parsing every task file each pump.
    tasks_cache_dir: Option<PathBuf>,
    tasks_gate: SignatureGate<Vec<(u64, SystemTime, u64)>>,
    /// The parsed tasks from the last read, reused while the dir is unchanged.
    tasks_cache: Vec<Task>,
    /// Keeps this session's [Background shell] claims honest. It lives here,
    /// beside the projection it corrects, so the correction happens *before*
    /// the change gate below: nothing in the hook stream ever closes a shell
    /// (ADR 0002), so a retraction is the only signal a dead dev server ever
    /// produces, and a gate it never reaches swallows it for good.
    shells: ShellWatch,
    /// Where the live command lines come from.
    live_shells: LiveShells,
    /// When the last sweep was taken, so the pump's 300 ms cadence does not
    /// become a process-table read every 300 ms.
    last_sweep: Option<Instant>,
}

impl ActivitySource {
    fn new(tasks_root: PathBuf, live_shells: LiveShells) -> Self {
        Self {
            projection: SessionActivityProjection::new(),
            tasks_root,
            tasks_dir: None,
            claude_id: None,
            claude_id_taken: false,
            last: None,
            tasks_cache_dir: None,
            tasks_gate: SignatureGate::new(),
            tasks_cache: Vec::new(),
            shells: ShellWatch::new(),
            live_shells,
            last_sweep: None,
        }
    }

    /// The session's tasks, re-reading from disk only when the task dir changed
    /// (bound to a different session) or its [`tasks_signature`] moved. Idle
    /// pumps reuse the cached parse.
    fn tasks(&mut self) -> Vec<Task> {
        let Some(dir) = self.tasks_dir.clone() else {
            return Vec::new();
        };
        let signature = tasks_signature(&dir);
        let dir_changed = self.tasks_cache_dir.as_deref() != Some(dir.as_path());
        if dir_changed || !self.tasks_gate.unchanged(&signature) {
            self.tasks_cache = read_tasks(&dir);
            self.tasks_gate.commit(signature);
            self.tasks_cache_dir = Some(dir);
        }
        self.tasks_cache.clone()
    }

    /// Ingest the hook event into the subagent/shell projection, then re-bind the
    /// task-store dir and Claude's id to the projection's *converged* main session.
    fn observe_hook(&mut self, event: &HookEvent) {
        self.projection.ingest(event);
        self.sync_main_session();
    }

    /// Start from a projection rebuilt from the recorded history, then bind to
    /// its main session.
    fn seed(&mut self, projection: SessionActivityProjection) {
        self.projection = projection;
        self.sync_main_session();
    }

    /// Anchor the projection's main session to the status-line's authoritative id
    /// (only the main interactive TUI renders one), then re-bind. Corrects a
    /// heuristic mis-lock so the persisted resume id / task dir track the real
    /// session even when no `SessionEnd` was seen.
    fn set_authoritative_main(&mut self, sid: &str) {
        self.projection.set_authoritative_main(sid);
        self.sync_main_session();
    }

    /// Bind the task-store dir and [Claude session id] to the projection's main
    /// session, re-binding when it changes. A first-seen nested one-shot or an
    /// immediately-ended session no longer sticks, so `claude --resume` targets the
    /// live session and the task store reads the right dir. When the id changes,
    /// re-arm [`Self::take_claude_id`] so the corrected id is surfaced and persisted.
    fn sync_main_session(&mut self) {
        let Some(main) = self.projection.main_session_id() else {
            return;
        };
        if self.claude_id.as_deref() == Some(main) {
            return;
        }
        self.tasks_dir = Some(self.tasks_root.join(main));
        self.claude_id = Some(main.to_string());
        self.claude_id_taken = false;
    }

    /// The live main session id the activity source has converged on — the same
    /// [Main session lock] that drives the resume id and task dir. `None` before
    /// any hook has bound it. Read (not taken) so the transcript source can bind
    /// its tailer to the same session's transcript without disarming the id.
    fn main_id(&self) -> Option<&str> {
        self.claude_id.as_deref()
    }

    /// Claude's main session id whenever it is newly known or has changed (a
    /// corrected mis-lock, or a restart in the same terminal), then `None` until it
    /// changes again — so the persisted resume id follows the live session.
    fn take_claude_id(&mut self) -> Option<String> {
        if self.claude_id_taken {
            return None;
        }
        let id = self.claude_id.clone()?;
        self.claude_id_taken = true;
        Some(id)
    }

    /// The projection's current open ask, read cheaply per-hook (no task-store
    /// read) so the notification path can see an ask opened by the same hook.
    fn current_ask(&self) -> Option<kriyon_core::ask::PendingAsk> {
        self.projection.current_ask()
    }

    /// Assemble the live snapshot (subagents/shells from hooks, tasks from the
    /// on-disk store, read each call) and return it only when it changed.
    fn snapshot(&mut self) -> Option<SessionActivity> {
        self.snapshot_at(Instant::now())
    }

    /// [`Self::snapshot`] with the clock injected, so the sweep cadence is
    /// testable without sleeping.
    fn snapshot_at(&mut self, now: Instant) -> Option<SessionActivity> {
        let tasks = self.tasks();
        let mut snapshot = self.projection.snapshot(tasks);
        self.reconcile_shells(&mut snapshot, now);
        let serialized = serde_json::to_string(&snapshot).ok()?;
        if self.last.as_deref() == Some(serialized.as_str()) {
            return None;
        }
        self.last = Some(serialized);
        Some(snapshot)
    }

    /// Re-derive the snapshot's [Background shell] claims from a sweep, at most
    /// once per [`SHELL_SWEEP_INTERVAL`].
    ///
    /// A session with no claims sweeps nothing — there is nothing to verify —
    /// but still tells the watch the pass happened, so a command backgrounded
    /// later is judged as newborn rather than as replayed history. When the
    /// sweep is not yet due the watch is told nothing at all, which is what an
    /// unreadable table already means to it: change nothing, spend no sighting.
    fn reconcile_shells(&mut self, snapshot: &mut SessionActivity, now: Instant) {
        if snapshot.shells.is_empty() {
            self.shells.reconcile(&mut snapshot.shells, None);
            return;
        }
        let due = self
            .last_sweep
            .is_none_or(|last| now.duration_since(last) >= SHELL_SWEEP_INTERVAL);
        let live = if due {
            self.last_sweep = Some(now);
            (self.live_shells)()
        } else {
            None
        };
        self.shells.reconcile(&mut snapshot.shells, live.as_deref());
    }
}

/// A file's `(modified-time, length)` — a cheap change signal that lets a source
/// skip re-reading a file that is untouched since it last read it. `None` when
/// the file can't be stat'd (e.g. it does not exist yet).
fn file_signature(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// Store-and-compare change detector for a polled file/dir source. Deliberately
/// splits "did it change?" ([`unchanged`](Self::unchanged)) from "remember it"
/// ([`commit`](Self::commit)): a source must commit its signature only AFTER the
/// read it gates *succeeds*, or a transient read failure records content that was
/// never ingested and a later settle at the same signature is skipped forever.
/// Keeping the two steps apart makes that ordering structural rather than a rule
/// each source has to re-remember.
struct SignatureGate<S> {
    last: Option<S>,
}

impl<S: PartialEq> SignatureGate<S> {
    fn new() -> Self {
        Self { last: None }
    }

    /// True when `sig` matches the last committed signature — nothing changed, so
    /// the (expensive) read can be skipped. Never mutates.
    fn unchanged(&self, sig: &S) -> bool {
        self.last.as_ref() == Some(sig)
    }

    /// Record the signature of a just-completed successful read.
    fn commit(&mut self, sig: S) {
        self.last = Some(sig);
    }
}

/// Reads the whole usage-snapshot file (rewritten each statusLine tick) and
/// parses it, emitting only when the raw text changed.
struct UsageSource {
    file: PathBuf,
    /// Last raw usage-snapshot text, to suppress duplicate emits.
    last: Option<String>,
    /// Skips re-reading an untouched file by its `(mtime, len)`. The usage file
    /// is rewritten wholesale each statusLine tick; on the fine-grained mtime of
    /// the target (`~/.claude`, APFS) any rewrite bumps the signature, so an idle
    /// session's file is not rewritten and every 300ms pump avoids a disk read.
    /// (On a coarse-mtime volume a same-length rewrite inside one mtime tick
    /// could be missed — a deliberate trade-off, not a correctness guarantee.)
    gate: SignatureGate<(SystemTime, u64)>,
}

impl UsageSource {
    fn new(file: PathBuf) -> Self {
        Self {
            file,
            last: None,
            gate: SignatureGate::new(),
        }
    }

    fn poll(&mut self) -> Option<UsageSnapshot> {
        // Skip the read when the file is provably unchanged since last time.
        let signature = file_signature(&self.file);
        if let Some(sig) = &signature {
            if self.gate.unchanged(sig) {
                return None;
            }
        }
        // Read BEFORE committing the signature (see SignatureGate): a transient
        // read failure must not mark the file as seen.
        let text = std::fs::read_to_string(&self.file).ok()?;
        if let Some(sig) = signature {
            self.gate.commit(sig);
        }
        if self.last.as_deref() == Some(text.as_str()) {
            return None;
        }
        let snapshot = parse_usage_snapshot(&text);
        self.last = Some(text);
        snapshot
    }
}

/// A cheap fingerprint of a task dir: per-file `(id, mtime, len)`, sorted by id.
/// It changes on any add, remove, or in-place edit of a task file (a plain dir
/// mtime would miss in-place edits, since editing a file's contents does not
/// touch its parent directory's mtime). Reading it costs a `read_dir` + a stat
/// per file — no file contents, no JSON parse — so it gates the expensive
/// [`read_tasks`] on the pump's hot path. Missing dir yields an empty sig.
fn tasks_signature(dir: &Path) -> Vec<(u64, SystemTime, u64)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut sig: Vec<(u64, SystemTime, u64)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let id: u64 = e.path().file_stem()?.to_str()?.parse().ok()?;
            let meta = e.metadata().ok()?;
            Some((id, meta.modified().ok()?, meta.len()))
        })
        .collect();
    sig.sort_by_key(|(id, _, _)| *id);
    sig
}

/// Read a Claude Code task store (`tasks/<session-id>/<n>.json`) into the task
/// list, ordered by numeric id. Missing dir or files yield an empty list.
fn read_tasks(dir: &Path) -> Vec<Task> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(u64, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| {
            let id: u64 = p.file_stem()?.to_str()?.parse().ok()?;
            Some((id, p))
        })
        .collect();
    files.sort_by_key(|(id, _)| *id);
    files
        .iter()
        .filter_map(|(_, p)| std::fs::read_to_string(p).ok())
        .filter_map(|text| parse_task_file(&text))
        .collect()
}

/// Drain every source once and dispatch what each produced. Hook lines are
/// pulled first so the transcript + activity sources can bind from them; then
/// the transcript is drained, then the activity and usage
/// snapshots (each emitted only when changed).
/// One thing a session watch surfaces to its consumer. Collapsing the watch's
/// seven separate callbacks into a single `Fn(WatchSignal)` keeps the source
/// decomposition (which signal comes from which source) private to the pump,
/// instead of leaking it to every caller as a seven-parameter interface.
///
/// A transient dispatch message: built, handed to one sink, matched, dropped —
/// never stored in a collection, so the size disparity the `large_enum_variant`
/// lint guards against does not apply (boxing would only add a per-signal heap
/// allocation on the transcript path).
#[allow(clippy::large_enum_variant)]
pub enum WatchSignal {
    /// A hook event (drives fused status), carrying the open [Pending ask]
    /// as of this event. Ask and status ride one signal so a Waiting
    /// notification triggered by the event can always name its ask — there is
    /// no emit-ordering contract for a consumer to uphold (the old separate
    /// `Ask` variant relied on being dispatched first, an invariant that lived
    /// in the pump and was load-bearing two modules away).
    Status {
        event: HookEvent,
        ask: Option<kriyon_core::ask::PendingAsk>,
    },
    /// A parsed transcript event. Nothing renders it (ADR 0019): it carries the
    /// final token usage and the material behind the unseen-output badges, the
    /// Needs-you snippet, and the handoff prompt.
    Transcript(StudioEvent),
    /// A live usage snapshot from the statusLine wrapper.
    Usage(UsageSnapshot),
    /// A reconstructed session-activity snapshot.
    Activity(SessionActivity),
    /// The session title (`ai-title`), when it changed.
    Title(String),
    /// Claude Code's own session id, learned once from the hooks.
    ClaudeId(String),
    /// A drift report, once, when the transcript format degraded the view.
    Drift(DriftReport),
}

fn pump<F>(sources: &mut Sources, on_signal: &F)
where
    F: Fn(WatchSignal),
{
    for event in sources.hooks.poll() {
        sources.transcript.observe_hook(&event);
        sources.activity.observe_hook(&event);
        let ask = sources.activity.current_ask();
        on_signal(WatchSignal::Status { event, ask });
    }
    // Claude's id is learned from the hooks above; surface it once so it can be
    // persisted for `claude --resume` on a later launch.
    if let Some(claude_id) = sources.activity.take_claude_id() {
        on_signal(WatchSignal::ClaudeId(claude_id));
    }
    // Point the transcript tailer at the *live* main session's file. `/resume`
    // and in-terminal restarts switch Claude's session id (and its transcript),
    // and the `ai-title` lives in that new file — so the title and everything
    // derived from the transcript must follow the same session status and the
    // resume id already converge on
    // (`ActivitySource::main_id`), not the first transcript the watch ever saw.
    if let Some(main) = sources.activity.main_id() {
        sources.transcript.bind_to(main);
    }
    // The transcript still feeds the derived data per line. (It is no longer the
    // activity source: Claude Code >=2.1 stops writing it live — activity comes
    // from the hook + task-store sources above; see ADR 0003.)
    for event in sources.transcript.poll() {
        on_signal(WatchSignal::Transcript(event));
    }
    // The transcript also carries the session title (`ai-title`), updated as the
    // session evolves; emit it only when it changed.
    if let Some(title) = sources.transcript.take_title() {
        on_signal(WatchSignal::Title(title));
    }
    // If the transcript format drifted far enough that the structured view is
    // degraded, surface it once so it can be logged instead of silently breaking.
    if let Some(report) = sources.transcript.take_drift() {
        on_signal(WatchSignal::Drift(report));
    }
    if let Some(snapshot) = sources.activity.snapshot() {
        on_signal(WatchSignal::Activity(snapshot));
    }
    if let Some(snapshot) = sources.usage.poll() {
        // The status-line reports the main interactive session's id (a one-shot
        // `claude -p` renders none) — authoritative. Anchor the activity source's
        // main-session lock to it so the resume id / task dir track the live
        // session; the corrected id surfaces via `take_claude_id` next pump.
        // Same accessor the status path uses, so the two locks can't diverge.
        if let Some(sid) = snapshot.authoritative_main_id() {
            sources.activity.set_authoritative_main(sid);
        }
        on_signal(WatchSignal::Usage(snapshot));
    }
}

/// The Kriyon-owned directories a session watch reads from.
pub struct WatchDirs<'a> {
    /// `~/.claude/kriyon/events` — hook-event files Kriyon's hook writes.
    pub events: &'a Path,
    /// `~/.claude/kriyon/usage` — live usage snapshots from the statusLine wrapper.
    pub usage: &'a Path,
    /// `~/.claude/tasks` — Claude Code's task store (per-session subdirectories).
    pub tasks: &'a Path,
}

/// How often the watch re-polls the bound transcript, on top of filesystem
/// notifications. Claude appends the assistant turn to the transcript without
/// firing a hook per line, and may flush it a beat *after* the `Stop` hook — so
/// a notify-only watch reads the transcript only when a hook/usage file changes
/// and goes stale mid-turn (usage totals and unseen counts would not update
/// until re-subscribed).
/// A short poll guarantees the transcript is drained promptly regardless.
const POLL_INTERVAL: Duration = Duration::from_millis(300);

/// Current wall-clock time in milliseconds since the Unix epoch. Used to stamp
/// the watch's last pump so a dead pump thread is detectable (the global ticker
/// keeps emitting heartbeats regardless, so the stamp is the real liveness).
fn now_millis() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

/// A live session watch: the `notify` watcher plus the poll thread that drives
/// pumping. Dropping it stops both — the thread observes `stop` and exits, and
/// dropping the watcher ends the filesystem subscription.
pub struct SessionWatch {
    _watcher: notify::RecommendedWatcher,
    stop: Arc<AtomicBool>,
    /// Wall-clock time (ms since epoch) of the watch's last `pump`, bumped by the
    /// poll thread. A stale value means the pump thread has stopped, even though
    /// the global heartbeat ticker keeps firing.
    last_pump: Arc<AtomicU64>,
}

impl SessionWatch {
    /// Wall-clock time (ms since epoch) of this watch's most recent pump.
    #[must_use]
    pub fn last_pump_millis(&self) -> u64 {
        self.last_pump.load(Ordering::Relaxed)
    }
}

impl Drop for SessionWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Watch a session's hook-events file and transcript, streaming new events as
/// they arrive. Returns the live watch — keep it alive to keep watching; drop
/// it to stop.
///
/// The hook-events file is seeked to EOF on subscribe: historical hook lines
/// from a previous run are deliberately skipped, so only hook events appended
/// *after* subscribe are delivered as status/activity updates. The transcript
/// (bound from the first live hook's `transcript_path`) is tailed from offset 0,
/// so the derived data covers the full conversation (each [`StudioEvent`]'s
/// stable id makes that replay idempotent for the consumer).
///
/// Liveness comes from two sources: the `notify` watch on the events/usage
/// directories (low-latency status the instant a hook fires) and a [`POLL_INTERVAL`]
/// timer (so transcript growth, which fires no hook, is still drained promptly).
/// Both feed one pump loop on a dedicated thread.
///
/// `live_shells` answers "what is this session's process tree running right
/// now", so the watch can retract a [Background shell] claim no process backs.
/// The pump is the only cadence that survives a quiet session, which is why the
/// question is asked here rather than downstream of the signal.
///
/// `on_signal` receives every [`WatchSignal`] the watch produces — hook status,
/// parsed transcript events, live usage snapshots, activity snapshots, the
/// title, Claude's session id, and (once) a drift report. Matching on the
/// variant is the consumer's job; the watch no longer forces a callback per
/// kind.
///
/// # Errors
/// Returns an error string if the `notify` watcher cannot be created or cannot
/// begin watching the events/usage directories.
pub fn spawn_session_watch<F>(
    dirs: &WatchDirs,
    session_id: &SessionId,
    live_shells: LiveShells,
    on_signal: F,
) -> Result<Option<SessionWatch>, String>
where
    F: Fn(WatchSignal) + Send + 'static,
{
    use notify::Watcher as _;

    std::fs::create_dir_all(dirs.events).ok();
    std::fs::create_dir_all(dirs.usage).ok();

    let events_path = dirs.events.join(format!("{}.jsonl", session_id.0));
    let mut sources = Sources {
        hooks: HookSource::new(events_path.clone()),
        transcript: TranscriptSource::new(),
        activity: ActivitySource::new(dirs.tasks.to_path_buf(), live_shells),
        usage: UsageSource::new(dirs.usage.join(format!("{}.json", session_id.0))),
    };

    // Seed the activity projection (subagents, shells, the open [Pending ask],
    // and its main-session lock) from the recorded tail. The hook tailer above
    // deliberately starts at EOF, so without this the projection would begin
    // blank and its first live `Ask` signal would clobber the status seed's
    // replayed ask with `None` while the user is still blocked. It is the same
    // replay, against the same status-line anchor, as the status seed in
    // `status_rt::seed_from_history`, so the two can't settle on different
    // main sessions.
    let history = crate::status_rt::read_seed_events(&events_path);
    for event in &history {
        sources.transcript.observe_hook(event);
    }
    let anchor = crate::status_rt::usage_anchor(&dirs.usage.join(format!("{}.json", session_id.0)));
    let replayed = kriyon_core::status::replay_history(&history, anchor.as_deref(), Instant::now());
    sources.activity.seed(replayed.projection);
    // Bind the transcript tailer to the seeded main session's file so a session
    // that is idle on subscribe (a resumed earlier session that fires no live
    // hook) still reads the `ai-title` already on disk — the events tail seeks
    // to EOF, so without this seed its title would never surface until the next
    // live hook, which for a finished session never comes.
    if let Some(main) = sources.activity.main_id() {
        sources.transcript.bind_to(main);
    }

    // The notify watch only pings this channel; the poll thread does the actual
    // pumping, so filesystem events and the timer share one consumer.
    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = tx.send(());
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(dirs.events, notify::RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    // The usage snapshot lives in a separate directory written by the
    // statusLine wrapper; watch it too so live usage updates ping the pump.
    watcher
        .watch(dirs.usage, notify::RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let last_pump = Arc::new(AtomicU64::new(now_millis()));
    let thread_last_pump = Arc::clone(&last_pump);
    std::thread::spawn(move || {
        // One supervised pump: a panic in any source must not take the whole
        // watch down (and with it every other session's liveness). Catch it,
        // log once, and let the loop self-heal on the next tick. The stamp is
        // bumped regardless so liveness reflects that the thread is still alive.
        let pump_once = |sources: &mut Sources| {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                pump(sources, &on_signal);
            }));
            if result.is_err() {
                eprintln!("kriyon: session watch pump panicked; continuing (watch self-heals)");
            }
            thread_last_pump.store(now_millis(), Ordering::Relaxed);
        };

        // Drain anything already on disk, then pump on each notify ping or, at
        // the latest, every POLL_INTERVAL (transcript growth / post-Stop flush).
        pump_once(&mut sources);
        loop {
            let _ = rx.recv_timeout(POLL_INTERVAL);
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }
            pump_once(&mut sources);
        }
    });

    Ok(Some(SessionWatch {
        _watcher: watcher,
        stop,
        last_pump,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write as _;
    use std::sync::mpsc;
    use std::time::Duration;

    fn user_line(text: &str) -> String {
        format!(r#"{{"type":"user","message":{{"role":"user","content":"{text}"}}}}"#)
    }

    fn hook(event: &str) -> HookEvent {
        HookEvent {
            event: event.to_string(),
            ..HookEvent::default()
        }
    }

    /// A [`LiveShells`] that reads no process table at all — the "unreadable
    /// table" case, which by design changes no claim. The right default for
    /// every test that is not about [Background shell] liveness.
    fn no_sweep() -> LiveShells {
        Box::new(|| None)
    }

    // --- sources ---

    #[test]
    fn signature_gate_commits_only_what_it_is_told() {
        let mut gate: SignatureGate<(u64, u64)> = SignatureGate::new();
        // Nothing committed yet: any signature is "changed".
        assert!(!gate.unchanged(&(1, 1)), "fresh gate treats all as changed");

        gate.commit((1, 1));
        assert!(gate.unchanged(&(1, 1)), "same signature is unchanged");
        assert!(!gate.unchanged(&(2, 1)), "a moved signature is changed");

        // A check never commits — the caller commits only after the read it
        // gates succeeds, so a failed read can't mask a later same signature.
        assert!(!gate.unchanged(&(2, 1)), "checking did not commit (2, 1)");
        gate.commit((2, 1));
        assert!(gate.unchanged(&(2, 1)));
    }

    #[test]
    fn tasks_signature_tracks_adds_and_in_place_edits() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(
            tasks_signature(dir.path()).is_empty(),
            "empty dir → empty signature"
        );

        let first = dir.path().join("0.json");
        fs::write(&first, r#"{"id":0,"status":"pending","content":"a"}"#).expect("write");
        let sig_one = tasks_signature(dir.path());
        assert_eq!(sig_one.len(), 1);

        // Adding a task file changes the signature.
        fs::write(
            dir.path().join("1.json"),
            r#"{"id":1,"status":"pending","content":"b"}"#,
        )
        .expect("write");
        let sig_two = tasks_signature(dir.path());
        assert_ne!(sig_one, sig_two, "an added task file changes the signature");

        // Editing a file in place (dir mtime would NOT change, but the file's
        // size/mtime does) must also change the signature.
        fs::write(&first, r#"{"id":0,"status":"completed","content":"aaa"}"#).expect("edit");
        let sig_three = tasks_signature(dir.path());
        assert_ne!(
            sig_two, sig_three,
            "an in-place task edit changes the signature"
        );
    }

    #[test]
    fn usage_source_emits_only_on_change() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("u.json");
        let mut src = UsageSource::new(path.clone());
        assert!(src.poll().is_none(), "no file yet");
        fs::write(&path, r#"{"usedPercentage":10.0}"#).expect("write");
        assert!(src.poll().is_some(), "first snapshot emits");
        assert!(src.poll().is_none(), "unchanged snapshot is suppressed");
        fs::write(&path, r#"{"usedPercentage":20.0}"#).expect("write2");
        assert!(src.poll().is_some(), "changed snapshot emits");
    }

    #[test]
    fn transcript_source_binds_from_hook_then_tails() {
        let dir = tempfile::tempdir().expect("tempdir");
        let transcript = dir.path().join("t.jsonl");
        fs::write(&transcript, format!("{}\n", user_line("hi"))).expect("write");

        let mut src = TranscriptSource::new();
        assert!(src.poll().is_empty(), "unbound source yields nothing");
        let event = HookEvent {
            session_id: Some("c1".to_string()),
            transcript_path: Some(transcript.display().to_string()),
            ..hook("Stop")
        };
        src.observe_hook(&event);
        src.bind_to("c1");
        let events = src.poll();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].event,
            StructuredEvent::Prompt {
                text: "hi".to_string()
            }
        );
    }

    #[test]
    fn transcript_source_reports_drift_once_when_format_moves() {
        // A transcript full of an unrecognized top-level type: the parser keeps
        // tolerating it (each line → Unknown) but the source must surface the
        // degraded structured view exactly once so it can be logged.
        let dir = tempfile::tempdir().expect("tempdir");
        let transcript = dir.path().join("t.jsonl");
        let lines: Vec<String> = (0..25)
            .map(|i| format!("{{\"type\":\"brand-new-{i}\",\"x\":{i}}}\n"))
            .collect();
        let body: String = lines.concat();
        fs::write(&transcript, body).expect("write");

        let mut src = TranscriptSource::new();
        src.observe_hook(&HookEvent {
            session_id: Some("c1".to_string()),
            transcript_path: Some(transcript.display().to_string()),
            ..hook("Stop")
        });
        src.bind_to("c1");
        let events = src.poll();
        assert_eq!(events.len(), 25, "every line still degrades to an event");

        let report = src.take_drift().expect("drift must be surfaced");
        assert!(report.is_degraded());
        assert_eq!(report.unknown_lines, 25);
        assert_eq!(report.total_lines, 25);
        assert!(
            src.take_drift().is_none(),
            "drift is surfaced once, not on every poll"
        );
    }

    #[test]
    fn transcript_source_reports_no_drift_for_healthy_transcript() {
        let dir = tempfile::tempdir().expect("tempdir");
        let transcript = dir.path().join("t.jsonl");
        let lines: Vec<String> = (0..25)
            .map(|i| format!("{}\n", user_line(&format!("line {i}"))))
            .collect();
        let body: String = lines.concat();
        fs::write(&transcript, body).expect("write");

        let mut src = TranscriptSource::new();
        src.observe_hook(&HookEvent {
            session_id: Some("c1".to_string()),
            transcript_path: Some(transcript.display().to_string()),
            ..hook("Stop")
        });
        src.bind_to("c1");
        let _ = src.poll();
        assert!(
            src.take_drift().is_none(),
            "a healthy transcript must not raise drift"
        );
    }

    #[test]
    fn transcript_source_extracts_changed_title() {
        let dir = tempfile::tempdir().expect("tempdir");
        let transcript = dir.path().join("t.jsonl");
        fs::write(
            &transcript,
            "{\"type\":\"ai-title\",\"aiTitle\":\"First title\",\"sessionId\":\"c1\"}\n",
        )
        .expect("write");

        let mut src = TranscriptSource::new();
        src.observe_hook(&HookEvent {
            session_id: Some("c1".to_string()),
            transcript_path: Some(transcript.display().to_string()),
            ..hook("Stop")
        });
        src.bind_to("c1");
        let _ = src.poll();
        assert_eq!(src.take_title(), Some("First title".to_string()));
        assert_eq!(src.take_title(), None, "unchanged title is not re-emitted");
    }

    /// A `user` transcript line carrying `text` as its whole prompt.
    fn prompt_line(text: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({"type": "user", "message": {"role": "user", "content": text}})
        )
    }

    #[test]
    fn transcript_source_falls_back_to_the_first_prompt_when_claude_never_titles() {
        // Claude Code writes no `ai-title` for a session driven purely by slash
        // commands, so the first prompt must stand in — otherwise every
        // `/pr-review` session shows the same placeholder in the sidebar.
        let dir = tempfile::tempdir().expect("tempdir");
        let transcript = dir.path().join("t.jsonl");
        fs::write(
            &transcript,
            prompt_line(
                "<command-message>pr-review</command-message>\n<command-name>/pr-review</command-name>\n<command-args>115</command-args>",
            ),
        )
        .expect("write");

        let mut src = TranscriptSource::new();
        src.observe_hook(&HookEvent {
            session_id: Some("c1".to_string()),
            transcript_path: Some(transcript.display().to_string()),
            ..hook("Stop")
        });
        src.bind_to("c1");
        let _ = src.poll();
        assert_eq!(src.take_title(), Some("/pr-review 115".to_string()));
        assert_eq!(src.take_title(), None, "the fallback is emitted once");
    }

    #[test]
    fn transcript_source_keeps_the_first_prompt_when_no_title_ever_arrives() {
        // The case this fallback exists for: Claude never titles the session, so
        // the label must stay the *first* prompt. Letting a later prompt through
        // would rename the row mid-session — worse than the placeholder.
        use std::io::Write as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let transcript = dir.path().join("t.jsonl");
        fs::write(&transcript, prompt_line("/pr-review 115")).expect("write");

        let mut src = TranscriptSource::new();
        src.observe_hook(&HookEvent {
            session_id: Some("c1".to_string()),
            transcript_path: Some(transcript.display().to_string()),
            ..hook("Stop")
        });
        src.bind_to("c1");
        let _ = src.poll();
        assert_eq!(src.take_title(), Some("/pr-review 115".to_string()));

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .expect("append");
        write!(file, "{}", prompt_line("yes do that")).expect("write prompt");
        let _ = src.poll();
        assert_eq!(
            src.take_title(),
            None,
            "a later prompt must not rename an untitled session"
        );
    }

    #[test]
    fn transcript_source_prefers_a_real_title_over_the_first_prompt() {
        // Both land in one drain: the prompt is earlier in the file, but the
        // `ai-title` is the session's real name and must be the one emitted.
        let dir = tempfile::tempdir().expect("tempdir");
        let transcript = dir.path().join("t.jsonl");
        fs::write(
            &transcript,
            format!(
                "{}{}",
                prompt_line("Resolve the merge conflicts."),
                "{\"type\":\"ai-title\",\"aiTitle\":\"Resolve merge conflicts\",\"sessionId\":\"c1\"}\n"
            ),
        )
        .expect("write");

        let mut src = TranscriptSource::new();
        src.observe_hook(&HookEvent {
            session_id: Some("c1".to_string()),
            transcript_path: Some(transcript.display().to_string()),
            ..hook("Stop")
        });
        src.bind_to("c1");
        let _ = src.poll();
        assert_eq!(
            src.take_title(),
            Some("Resolve merge conflicts".to_string()),
            "the real title wins over the prompt fallback"
        );
    }

    #[test]
    fn transcript_source_stops_falling_back_once_a_real_title_arrives() {
        // The fallback ships first (Claude has not titled the session yet), then
        // the real title lands. A later prompt must never demote the session
        // back to a prompt label.
        use std::io::Write as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let transcript = dir.path().join("t.jsonl");
        fs::write(&transcript, prompt_line("Review PR 12")).expect("write");

        let mut src = TranscriptSource::new();
        src.observe_hook(&HookEvent {
            session_id: Some("c1".to_string()),
            transcript_path: Some(transcript.display().to_string()),
            ..hook("Stop")
        });
        src.bind_to("c1");
        let _ = src.poll();
        assert_eq!(src.take_title(), Some("Review PR 12".to_string()));

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .expect("append");
        writeln!(
            file,
            r#"{{"type":"ai-title","aiTitle":"Review PR 12 comments","sessionId":"c1"}}"#
        )
        .expect("write title");
        let _ = src.poll();
        assert_eq!(src.take_title(), Some("Review PR 12 comments".to_string()));

        write!(file, "{}", prompt_line("and now check the tests")).expect("write prompt");
        let _ = src.poll();
        assert_eq!(
            src.take_title(),
            None,
            "a later prompt must not overwrite the real title"
        );
    }

    #[test]
    fn transcript_source_follows_the_live_main_session_on_resume() {
        // A terminal that `/resume`s (or restarts) switches Claude's session id,
        // and with it the transcript file the `ai-title` is written to. The
        // tailer must follow the live main session, not stay pinned to the first
        // one it saw — otherwise the title freezes at the pre-resume session.
        let dir = tempfile::tempdir().expect("tempdir");
        let first = dir.path().join("a.jsonl");
        let second = dir.path().join("b.jsonl");
        fs::write(
            &first,
            "{\"type\":\"ai-title\",\"aiTitle\":\"First\",\"sessionId\":\"a\"}\n",
        )
        .expect("write a");
        fs::write(
            &second,
            "{\"type\":\"ai-title\",\"aiTitle\":\"Second\",\"sessionId\":\"b\"}\n",
        )
        .expect("write b");

        let mut src = TranscriptSource::new();
        src.observe_hook(&HookEvent {
            session_id: Some("a".to_string()),
            transcript_path: Some(first.display().to_string()),
            ..hook("Stop")
        });
        src.bind_to("a");
        let _ = src.poll();
        assert_eq!(src.take_title(), Some("First".to_string()));

        // The terminal resumes into session "b": a later hook reports its new
        // transcript, and the main-session lock converges on "b".
        src.observe_hook(&HookEvent {
            session_id: Some("b".to_string()),
            transcript_path: Some(second.display().to_string()),
            ..hook("SessionStart")
        });
        src.bind_to("b");
        let _ = src.poll();
        assert_eq!(
            src.take_title(),
            Some("Second".to_string()),
            "the title must follow the resumed session's transcript"
        );
    }

    #[test]
    fn activity_source_yields_claude_id_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut src = ActivitySource::new(dir.path().join("tasks"), no_sweep());
        src.observe_hook(&HookEvent {
            session_id: Some("claude-7".to_string()),
            ..hook("SessionStart")
        });
        assert_eq!(src.take_claude_id(), Some("claude-7".to_string()));
        assert_eq!(src.take_claude_id(), None, "claude id is handed out once");
    }

    #[test]
    fn activity_source_binds_claude_id_to_the_live_session_not_a_one_shot() {
        // Regression: the resume id / task dir must not stick to a first-seen nested
        // one-shot `claude -p` (temp transcript), or `claude --resume` targets a
        // dead session next launch ("session expired") and the task store is wrong.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut src = ActivitySource::new(dir.path().join("tasks"), no_sweep());

        // A one-shot fires first — its temp transcript must not lock the main.
        src.observe_hook(&HookEvent {
            session_id: Some("one-shot".to_string()),
            transcript_path: Some("/private/var/folders/x/T/one-shot.jsonl".to_string()),
            ..hook("SessionStart")
        });
        assert_eq!(
            src.take_claude_id(),
            None,
            "a one-shot must not be persisted"
        );

        // The real interactive session then runs; its id is the one persisted.
        src.observe_hook(&HookEvent {
            session_id: Some("live".to_string()),
            transcript_path: Some("/home/.claude/projects/-proj/live.jsonl".to_string()),
            ..hook("SessionStart")
        });
        assert_eq!(src.take_claude_id(), Some("live".to_string()));
    }

    #[test]
    fn activity_source_reanchors_claude_id_to_the_authoritative_session() {
        // The status-line's authoritative id corrects a heuristic mis-lock and is
        // re-surfaced so the persisted resume id follows it.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut src = ActivitySource::new(dir.path().join("tasks"), no_sweep());
        src.observe_hook(&HookEvent {
            session_id: Some("wrong".to_string()),
            ..hook("UserPromptSubmit")
        });
        assert_eq!(src.take_claude_id(), Some("wrong".to_string()));

        src.set_authoritative_main("right");
        assert_eq!(
            src.take_claude_id(),
            Some("right".to_string()),
            "the corrected id must be re-surfaced for persistence",
        );
    }

    /// Nothing in the hook stream ever closes a [Background shell] (ADR 0002),
    /// so a dev server that dies on its own changes the projection not at all.
    /// If the sweep that re-derives the claim runs *downstream* of the
    /// change gate, it never runs again once the session goes quiet: the claim
    /// stays `Running` for good, vetoing auto-sleep and naming a dead command
    /// in every close and quit dialog — the very failure the watch exists to
    /// fix. So the sweep runs before the gate, and a retraction is itself a
    /// change worth emitting.
    #[test]
    fn a_dead_shell_is_retracted_though_no_hook_ever_fires() {
        let dir = tempfile::tempdir().expect("tempdir");
        let live = Arc::new(std::sync::Mutex::new(vec![
            "/bin/zsh -c eval 'pnpm dev' < /dev/null".to_string(),
        ]));
        let probe = Arc::clone(&live);
        let mut src = ActivitySource::new(
            dir.path().join("tasks"),
            Box::new(move || Some(probe.lock().expect("lock").clone())),
        );
        src.observe_hook(&HookEvent {
            tool_name: Some("Bash".to_string()),
            tool_use_id: Some("bash-1".to_string()),
            command: Some("pnpm dev".to_string()),
            run_in_background: Some(true),
            ..hook("PreToolUse")
        });

        let now = Instant::now();
        let first = src.snapshot_at(now).expect("the claim is a change");
        assert_eq!(
            first.shells.first().map(|s| s.status),
            Some(kriyon_core::activity::ShellStatus::Running),
            "the sweep sees it, so it is running"
        );

        // The dev server exits. No hook fires and the projection is untouched.
        live.lock().expect("lock").clear();

        let second = src
            .snapshot_at(now + SHELL_SWEEP_INTERVAL)
            .expect("the retraction is itself a change worth emitting");
        assert_ne!(
            second.shells.first().map(|s| s.status),
            Some(kriyon_core::activity::ShellStatus::Running),
            "no live process backs it any more"
        );
    }

    /// The sweep costs a process-table read and a [`ProcessTree`] build, and
    /// the pump runs every 300 ms. A session with no claims must pay neither.
    #[test]
    fn a_session_with_no_claims_never_sweeps() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sweeps = Arc::new(AtomicU64::new(0));
        let counter = Arc::clone(&sweeps);
        let mut src = ActivitySource::new(
            dir.path().join("tasks"),
            Box::new(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                Some(Vec::new())
            }),
        );
        src.observe_hook(&HookEvent {
            session_id: Some("c1".to_string()),
            tool_name: Some("Agent".to_string()),
            tool_use_id: Some("t1".to_string()),
            subagent_type: Some("Explore".to_string()),
            ..hook("PreToolUse")
        });

        let now = Instant::now();
        src.snapshot_at(now);
        src.snapshot_at(now + SHELL_SWEEP_INTERVAL);

        assert_eq!(sweeps.load(Ordering::Relaxed), 0, "nothing to verify");
    }

    #[test]
    fn activity_source_dedups_snapshots() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut src = ActivitySource::new(dir.path().join("tasks"), no_sweep());
        let pre = HookEvent {
            session_id: Some("c1".to_string()),
            tool_name: Some("Agent".to_string()),
            tool_use_id: Some("t1".to_string()),
            subagent_type: Some("Explore".to_string()),
            description: Some("map".to_string()),
            ..hook("PreToolUse")
        };
        src.observe_hook(&pre);
        assert!(src.snapshot().is_some(), "first snapshot after a subagent");
        assert!(src.snapshot().is_none(), "unchanged snapshot is suppressed");
    }

    #[test]
    fn activity_source_carries_the_pending_ask() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut src = ActivitySource::new(dir.path().join("tasks"), no_sweep());

        let open = HookEvent {
            tool_name: Some("AskUserQuestion".to_string()),
            tool_use_id: Some("toolu_1".to_string()),
            questions: Some(r#"[{"question":"Which db?"}]"#.to_string()),
            ..hook("PreToolUse")
        };
        src.observe_hook(&open);
        let snap = src.snapshot().expect("changed snapshot emits");
        let ask = snap.pending_ask.expect("ask is carried");
        assert_eq!(ask.text, "Which db?");

        let close = HookEvent {
            tool_use_id: Some("toolu_1".to_string()),
            ..hook("PostToolUse")
        };
        src.observe_hook(&close);
        let snap = src.snapshot().expect("clearing the ask emits");
        assert_eq!(snap.pending_ask, None);
    }

    /// A permission ask is opened by the very hook that also drives the Status
    /// signal which triggers the Waiting notification. The pump must mirror the
    /// ask (via `Ask`) BEFORE emitting `Status` for that hook, so the
    /// notification path can see it and name the ask instead of degrading to a
    /// generic label. Exercised at the `pump()` level (not just `ActivitySource`)
    /// because the ordering guarantee is a property of the pump loop, not of any
    /// one source.
    #[test]
    fn pump_status_signal_carries_the_ask_the_hook_opened() {
        // A permission hook's Status signal must arrive with the ask it opened
        // already on it, so a Waiting notification fired by this same event can
        // name the ask — as a type-level fact, not an emit-ordering contract.
        let dir = tempfile::tempdir().expect("tempdir");
        let events_path = dir.path().join("events.jsonl");
        let mut sources = Sources {
            hooks: HookSource::new(events_path.clone()),
            transcript: TranscriptSource::new(),
            activity: ActivitySource::new(dir.path().join("tasks"), no_sweep()),
            usage: UsageSource::new(dir.path().join("usage.json")),
        };

        // Written after HookSource::new (which seeks to EOF), mirroring how a
        // live hook line arrives after subscribe.
        fs::write(&events_path, "{\"event\":\"PermissionRequest\"}\n").expect("write hook line");

        let signals = std::cell::RefCell::new(Vec::new());
        pump(&mut sources, &|signal: WatchSignal| {
            signals.borrow_mut().push(signal);
        });
        let signals = signals.into_inner();

        assert!(
            signals.iter().any(|s| matches!(
                s,
                WatchSignal::Status { event, ask: Some(ask) }
                    if event.event == "PermissionRequest"
                        && ask.kind == kriyon_core::ask::AskKind::Permission
            )),
            "the Status signal must carry the permission ask it opened",
        );
    }

    #[test]
    fn seeded_activity_projection_keeps_a_prior_open_ask() {
        // An open permission ask is already on disk when the watch subscribes
        // (app restart while the user is blocked). The activity projection is
        // seeded from the tail, so a later live event that does NOT resolve
        // the ask must re-emit Ask(Some(permission)) — a fresh projection
        // would emit Ask(None) and clobber the seeded pending ask while the
        // user is still blocked.
        let dir = tempfile::tempdir().expect("tempdir");
        let events_dir = dir.path().join("events");
        let usage_dir = dir.path().join("usage");
        fs::create_dir_all(&events_dir).expect("mkdir events");
        let events_path = events_dir.join("sess-1.jsonl");
        fs::write(
            &events_path,
            concat!(
                r#"{"event":"UserPromptSubmit","session_id":"c1"}"#, "\n",
                r#"{"event":"Notification","session_id":"c1","message":"Claude needs your permission to use Bash"}"#, "\n",
            ),
        )
        .expect("write pre-subscribe events");

        let (ask_tx, ask_rx) = mpsc::channel::<Option<kriyon_core::ask::PendingAsk>>();
        let dirs = WatchDirs {
            events: &events_dir,
            usage: &usage_dir,
            tasks: &dir.path().join("tasks"),
        };
        let _watch = spawn_session_watch(
            &dirs,
            &SessionId("sess-1".to_string()),
            no_sweep(),
            move |signal| {
                if let WatchSignal::Status { ask, .. } = signal {
                    let _ = ask_tx.send(ask);
                }
            },
        )
        .expect("spawn ok")
        .expect("watch built");

        // A live main-agent event that does not resolve the permission
        // (PreToolUse never clears an ask; only PostToolUse/turn boundaries do).
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&events_path)
            .expect("open for append");
        writeln!(
            file,
            r#"{{"event":"PreToolUse","session_id":"c1","tool_name":"Read"}}"#
        )
        .expect("append live event");

        let ask = ask_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("an Ask signal for the live event");
        let ask = ask.expect("the seeded permission ask must survive the live event");
        assert_eq!(ask.kind, kriyon_core::ask::AskKind::Permission);
    }

    #[test]
    fn the_activity_seed_follows_the_status_line_anchor_like_the_status_seed() {
        // The tail opens with an earlier claude that died without SessionEnd
        // and the live one never spawned an agent. The status seed anchors to
        // the status line's id; the activity seed must too, or the resume id
        // and task dir bind to the corpse.
        let dir = tempfile::tempdir().expect("tempdir");
        let events_dir = dir.path().join("events");
        let usage_dir = dir.path().join("usage");
        fs::create_dir_all(&events_dir).expect("mkdir events");
        fs::create_dir_all(&usage_dir).expect("mkdir usage");
        fs::write(
            events_dir.join("sess-1.jsonl"),
            concat!(
                r#"{"event":"UserPromptSubmit","session_id":"old"}"#,
                "\n",
                r#"{"event":"UserPromptSubmit","session_id":"live"}"#,
                "\n",
                r#"{"event":"Stop","session_id":"live"}"#,
                "\n",
            ),
        )
        .expect("write pre-subscribe events");
        fs::write(usage_dir.join("sess-1.json"), r#"{"sessionId":"live"}"#)
            .expect("write usage snapshot");

        let (id_tx, id_rx) = mpsc::channel::<String>();
        let dirs = WatchDirs {
            events: &events_dir,
            usage: &usage_dir,
            tasks: &dir.path().join("tasks"),
        };
        let _watch = spawn_session_watch(
            &dirs,
            &SessionId("sess-1".to_string()),
            no_sweep(),
            move |signal| {
                if let WatchSignal::ClaudeId(id) = signal {
                    let _ = id_tx.send(id);
                }
            },
        )
        .expect("spawn ok")
        .expect("watch built");

        let first = id_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a claude id from the seed");
        assert_eq!(first, "live");
    }

    // --- Tailer ---

    #[test]
    fn tailer_emits_complete_lines_in_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        fs::write(&path, format!("{}\n{}\n", user_line("hi"), user_line("yo"))).expect("write");

        let mut tailer = Tailer::new(path);
        let events = tailer.poll();
        assert_eq!(
            events,
            vec![
                StructuredEvent::Prompt {
                    text: "hi".to_string()
                },
                StructuredEvent::Prompt {
                    text: "yo".to_string()
                },
            ]
        );
    }

    #[test]
    fn tailer_holds_partial_line_until_completed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        let full = user_line("hi");
        fs::write(&path, &full).expect("write partial");

        let mut tailer = Tailer::new(path.clone());
        assert!(
            tailer.poll().is_empty(),
            "partial line must not emit an event yet"
        );

        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open append");
        f.write_all(b"\n").expect("append newline");
        drop(f);

        let events = tailer.poll();
        assert_eq!(
            events,
            vec![StructuredEvent::Prompt {
                text: "hi".to_string()
            }]
        );
    }

    #[test]
    fn tailer_starts_over_when_its_file_is_replaced_by_a_shorter_one() {
        // A cleaned-up [Hook spool] is recreated by the next hook: the old
        // offset is past the new end, and must not silence the tailer.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        fs::write(
            &path,
            format!("{}\n{}\n", user_line("one"), user_line("two")),
        )
        .expect("write");
        let mut tailer = Tailer::at_end(path.clone());

        fs::remove_file(&path).expect("remove");
        fs::write(&path, format!("{}\n", user_line("new"))).expect("recreate");

        assert_eq!(
            tailer.poll(),
            vec![StructuredEvent::Prompt {
                text: "new".to_string()
            }]
        );
    }

    #[test]
    fn tailer_missing_file_is_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut tailer = Tailer::new(dir.path().join("nope.jsonl"));
        assert_eq!(
            tailer.poll(),
            [] as [kriyon_core::transcript::StructuredEvent; 0]
        );
    }

    #[test]
    fn tailer_exposes_its_path() {
        let path = PathBuf::from("/tmp/x.jsonl");
        let tailer = Tailer::new(path.clone());
        assert_eq!(tailer.path(), path.as_path());
    }

    #[test]
    fn at_end_reads_only_lines_appended_after_construction() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("e.jsonl");
        fs::write(&path, format!("{}\n", user_line("old"))).expect("seed history");

        let mut tailer = Tailer::at_end(path.clone());
        assert!(
            tailer.poll().is_empty(),
            "pre-existing lines must be skipped"
        );

        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open append");
        f.write_all(format!("{}\n", user_line("new")).as_bytes())
            .expect("append");
        drop(f);

        assert_eq!(
            tailer.poll(),
            vec![StructuredEvent::Prompt {
                text: "new".to_string()
            }]
        );
    }

    #[test]
    fn at_end_on_missing_file_starts_at_zero() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("missing.jsonl");
        let mut tailer = Tailer::at_end(path.clone());
        assert!(tailer.poll().is_empty(), "no file yet");
        fs::write(&path, format!("{}\n", user_line("first"))).expect("create");
        assert_eq!(
            tailer.poll(),
            vec![StructuredEvent::Prompt {
                text: "first".to_string()
            }]
        );
    }

    // --- spawn_session_watch ---

    /// The watcher must return a live handle even when no events file exists at
    /// subscribe time, then pick up hook events written afterward — driving both
    /// status (the hook event) and the structured transcript (from the
    /// `transcript_path` the hook reports).
    #[test]
    #[allow(clippy::too_many_lines)] // one integration test wiring six channels
    fn spawn_session_watch_streams_status_transcript_and_usage() {
        let root = tempfile::tempdir().expect("tempdir");
        let events_dir = root.path().join("events");
        let usage_dir = root.path().join("usage");
        let tasks_dir = root.path().join("tasks");

        // A transcript the hook will point at — under a `projects` dir so it reads
        // as a real interactive session (not a one-shot `claude -p`'s temp file),
        // which is what lets the hook's session id lock as the main agent.
        let projects = root.path().join("projects");
        fs::create_dir_all(&projects).expect("mkdir projects");
        let transcript = projects.join("session.jsonl");
        fs::write(&transcript, format!("{}\n", user_line("hi"))).expect("write transcript");

        let (status_tx, status_rx) = mpsc::channel();
        let (tx_tx, tx_rx) = mpsc::channel();
        let (usage_tx, usage_rx) = mpsc::channel();
        let (title_tx, title_rx) = mpsc::channel();
        let (cid_tx, cid_rx) = mpsc::channel();
        let dirs = WatchDirs {
            events: &events_dir,
            usage: &usage_dir,
            tasks: &tasks_dir,
        };
        let watcher = spawn_session_watch(
            &dirs,
            &SessionId("sess-1".to_string()),
            no_sweep(),
            move |signal| match signal {
                WatchSignal::Status { event, .. } => {
                    let _ = status_tx.send(event);
                }
                WatchSignal::Transcript(ev) => {
                    let _ = tx_tx.send(ev);
                }
                WatchSignal::Usage(snap) => {
                    let _ = usage_tx.send(snap);
                }
                WatchSignal::Title(title) => {
                    let _ = title_tx.send(title);
                }
                WatchSignal::ClaudeId(cid) => {
                    let _ = cid_tx.send(cid);
                }
                WatchSignal::Activity(_) | WatchSignal::Drift(_) => {}
            },
        )
        .expect("spawn ok");
        assert!(watcher.is_some(), "a live watcher must be returned");

        // The hook fires: append an event line pointing at the transcript and
        // carrying Claude's own session id. The transcript holds an ai-title.
        fs::create_dir_all(&events_dir).expect("mkdir events");
        fs::write(
            &transcript,
            format!(
                "{}\n{}\n",
                user_line("hi"),
                r#"{"type":"ai-title","aiTitle":"My session","sessionId":"claude-x"}"#
            ),
        )
        .expect("rewrite transcript with title");
        let line = format!(
            r#"{{"event":"Stop","session_id":"claude-x","transcript_path":"{}"}}"#,
            transcript.display()
        );
        fs::write(events_dir.join("sess-1.jsonl"), format!("{line}\n")).expect("write event");
        // The statusLine wrapper writes a live usage snapshot.
        fs::create_dir_all(&usage_dir).expect("mkdir usage");
        fs::write(
            usage_dir.join("sess-1.json"),
            r#"{"usedPercentage":12.5,"costUsd":0.03,"model":"Opus"}"#,
        )
        .expect("write usage");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut status = Vec::new();
        let mut events = Vec::new();
        let mut usage = Vec::new();
        let mut titles = Vec::new();
        let mut claude_ids = Vec::new();
        while std::time::Instant::now() < deadline {
            if let Ok(s) = status_rx.recv_timeout(Duration::from_millis(150)) {
                status.push(s);
            }
            while let Ok(e) = tx_rx.try_recv() {
                events.push(e);
            }
            while let Ok(u) = usage_rx.try_recv() {
                usage.push(u);
            }
            while let Ok(t) = title_rx.try_recv() {
                titles.push(t);
            }
            while let Ok(c) = cid_rx.try_recv() {
                claude_ids.push(c);
            }
            if !status.is_empty()
                && !events.is_empty()
                && !usage.is_empty()
                && !titles.is_empty()
                && !claude_ids.is_empty()
            {
                break;
            }
        }
        drop(watcher);

        assert!(
            status.iter().any(|s| s.event == "Stop"),
            "must deliver the Stop hook event, got {status:?}"
        );
        assert!(
            events.iter().any(|e| e.event
                == StructuredEvent::Prompt {
                    text: "hi".to_string()
                }),
            "must tail the transcript the hook pointed at, got {events:?}"
        );
        assert!(
            events.iter().all(|e| !e.id.is_empty()),
            "every Studio event must carry a stable id, got {events:?}"
        );
        assert!(
            usage.iter().any(|u| u.used_percentage == Some(12.5)),
            "must deliver the live usage snapshot, got {usage:?}"
        );
        assert!(
            titles.contains(&"My session".to_string()),
            "must surface the ai-title from the transcript, got {titles:?}"
        );
        assert!(
            claude_ids.contains(&"claude-x".to_string()),
            "must surface Claude's session id from the hook, got {claude_ids:?}"
        );
    }

    /// The watch must expose its own last-pump wall-clock time so a dead pump
    /// thread is detectable even while the global ticker keeps emitting
    /// heartbeats. The poll thread pumps at least once per `POLL_INTERVAL`, so
    /// after a short sleep the stamp must have advanced.
    #[test]
    fn last_pump_millis_advances_as_the_pump_thread_runs() {
        let root = tempfile::tempdir().expect("tempdir");
        let events_dir = root.path().join("events");
        let usage_dir = root.path().join("usage");
        let tasks_dir = root.path().join("tasks");
        let dirs = WatchDirs {
            events: &events_dir,
            usage: &usage_dir,
            tasks: &tasks_dir,
        };
        let watch = spawn_session_watch(
            &dirs,
            &SessionId("sess-1".to_string()),
            no_sweep(),
            |_signal| {},
        )
        .expect("spawn ok")
        .expect("a live watch");

        let first = watch.last_pump_millis();
        // POLL_INTERVAL is 300ms, so a ~400ms sleep guarantees at least one pump.
        std::thread::sleep(Duration::from_millis(400));
        let second = watch.last_pump_millis();
        // Keep the watch alive until after the second read.
        drop(watch);

        assert!(
            second >= first,
            "stamp must not go backwards: {first} -> {second}"
        );
        assert!(
            second > first,
            "the pump thread must bump the stamp: {first} -> {second}"
        );
    }

    /// On resume, the events file already holds a previous run's trailing line. The
    /// watch must NOT replay it as status (that is the stale-"working" bug); only
    /// events appended after subscribe count.
    #[test]
    fn hook_source_skips_history_then_streams_live() {
        let root = tempfile::tempdir().expect("tempdir");
        let events_dir = root.path().join("events");
        let usage_dir = root.path().join("usage");
        let tasks_dir = root.path().join("tasks");
        fs::create_dir_all(&events_dir).expect("mkdir events");

        // A previous run's trailing "Running" line, present before we subscribe.
        let events_file = events_dir.join("sess-1.jsonl");
        fs::write(&events_file, "{\"event\":\"UserPromptSubmit\"}\n").expect("seed history");

        let (status_tx, status_rx) = mpsc::channel();
        let dirs = WatchDirs {
            events: &events_dir,
            usage: &usage_dir,
            tasks: &tasks_dir,
        };
        let watcher = spawn_session_watch(
            &dirs,
            &SessionId("sess-1".to_string()),
            no_sweep(),
            move |signal| {
                if let WatchSignal::Status { event, .. } = signal {
                    let _ = status_tx.send(event);
                }
            },
        )
        .expect("spawn ok");

        // Give the initial drain a chance to (wrongly) deliver the historical line.
        std::thread::sleep(Duration::from_millis(250));
        assert!(
            status_rx.try_recv().is_err(),
            "historical hook lines must not be delivered as status"
        );

        // A live event appended after subscribe IS delivered.
        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(&events_file)
            .expect("open append");
        f.write_all(b"{\"event\":\"Stop\"}\n").expect("append live");
        drop(f);

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut got: Option<HookEvent> = None;
        while std::time::Instant::now() < deadline {
            if let Ok(ev) = status_rx.recv_timeout(Duration::from_millis(150)) {
                got = Some(ev);
                break;
            }
        }
        drop(watcher);

        assert_eq!(
            got.map(|e| e.event),
            Some("Stop".to_string()),
            "live events appended after subscribe must be delivered"
        );
    }

    /// The watcher must build `SessionActivity` from the live sources: a
    /// subagent from an `Agent` hook event, and a task from the on-disk store.
    ///
    /// Identity: Kriyon keys its own files (events/usage) by the id it launched
    /// with (`kriyon-1`), but Claude Code owns its session id (`claude-1`) and
    /// the task store is keyed by *Claude's* id. Since Kriyon no longer forces
    /// its id onto Claude (`--session-id` suppressed the live transcript — see
    /// ADR 0003), the watcher must learn Claude's id from the hook's
    /// `session_id` field to locate `tasks/<claude-id>/`.
    #[test]
    fn spawn_session_watch_emits_activity_snapshots() {
        use kriyon_core::activity::{SessionActivity, SubagentState, TaskStatus};

        let root = tempfile::tempdir().expect("tempdir");
        let events_dir = root.path().join("events");
        let usage_dir = root.path().join("usage");
        let tasks_dir = root.path().join("tasks");

        // A task in the store, keyed by Claude's id: tasks/<claude-id>/1.json.
        let session_task_dir = tasks_dir.join("claude-1");
        fs::create_dir_all(&session_task_dir).expect("mkdir task store");
        fs::write(
            session_task_dir.join("1.json"),
            r#"{"id":"1","subject":"wire ui","status":"in_progress","activeForm":"wiring ui"}"#,
        )
        .expect("write task");

        let (act_tx, act_rx) = mpsc::channel();
        let dirs = WatchDirs {
            events: &events_dir,
            usage: &usage_dir,
            tasks: &tasks_dir,
        };
        let watcher = spawn_session_watch(
            &dirs,
            &SessionId("kriyon-1".to_string()),
            no_sweep(),
            move |signal| {
                if let WatchSignal::Activity(a) = signal {
                    let _ = act_tx.send(a);
                }
            },
        )
        .expect("spawn ok");

        // The hook fires: main runs an Edit (main current tool), spawns an Agent
        // (running), then the turn Stops (settle: main tool cleared, subagent
        // forced done). Each line carries Claude's own `session_id`, which keys
        // the task store.
        fs::create_dir_all(&events_dir).expect("mkdir events");
        let edit = r#"{"event":"PreToolUse","session_id":"claude-1","tool_name":"Edit","tool_use_id":"e1","target":"a.rs"}"#;
        let spawn = r#"{"event":"PreToolUse","session_id":"claude-1","tool_name":"Agent","tool_use_id":"t1","subagent_type":"Explore","description":"map"}"#;
        let stop = r#"{"event":"Stop","session_id":"claude-1"}"#;
        fs::write(
            events_dir.join("kriyon-1.jsonl"),
            format!("{edit}\n{spawn}\n{stop}\n"),
        )
        .expect("write events");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut latest: Option<SessionActivity> = None;
        while std::time::Instant::now() < deadline {
            while let Ok(a) = act_rx.try_recv() {
                latest = Some(a);
            }
            if latest.as_ref().is_some_and(|a| {
                a.subagents
                    .first()
                    .is_some_and(|s| s.state == SubagentState::Done)
            }) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(watcher);

        let act = latest.expect("an activity snapshot must arrive");
        assert_eq!(act.subagents.len(), 1, "got {act:?}");
        // Settle on Stop forced the orphaned running subagent to Done.
        assert_eq!(act.subagents[0].state, SubagentState::Done);
        assert_eq!(act.subagents[0].kind, "Explore");
        // Stop also cleared the main agent's current tool.
        assert!(
            act.main.current_tool.is_none(),
            "settle clears main tool, got {act:?}"
        );
        // The task store is folded in too.
        assert_eq!(act.tasks.len(), 1, "got {act:?}");
        assert_eq!(act.tasks[0].text, "wire ui");
        assert_eq!(act.tasks[0].status, TaskStatus::InProgress);
    }
}
