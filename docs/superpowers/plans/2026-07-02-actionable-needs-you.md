# Actionable Needs-you Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every blocked session shows *what it wants* (Pending ask) and *what it was doing*, in an enriched Needs-you rail, a ⌘⇧K Needs-you overlay, and a catch-up brief banner when refocusing a stale session.

**Architecture:** The hook script records three new ask-relevant fields (`message`, `questions`, `plan`). A new pure `ask.rs` state machine in kriyon-core folds hook events into an `Option<PendingAsk>`, carried on the existing `SessionActivity` snapshot (deduped emission for free). The frontend derives Needs-you entries (ask + context line + blocked-for) purely from stores, renders them via one shared `NeedsYouList` in both the Command center rail and a new ⌘⇧K overlay, and computes a deterministic `CatchUpBrief` from the Studio-event delta on session activation.

**Tech Stack:** Rust (kriyon-core, serde), Tauri watcher (`src-tauri/src/watcher.rs`), React + Zustand, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-02-actionable-needs-you-design.md`

## Global Constraints

- Branch: work on a typed feature branch (e.g. `feat/needs-you`), never `main`/`master`.
- TDD: write the failing test, run it, watch it fail, then implement. Every task below is ordered that way.
- All new core logic is total: tolerant parsing, no panics, unknown input is a no-op (drift-guard discipline).
- Never inject keystrokes into the PTY. "Answering" an ask = routing to the Raw view (`answerInTerminal` pattern).
- Design values come from `src/theme/tokens.ts` — no hardcoded colors/spacing.
- Formatting/lint is owned by Ultracite/Biome: run `pnpm fix` before committing frontend changes; never hand-format.
- Conventional commits, small and frequent. `pnpm check` must pass before the final commit.
- Serde conventions: structs `rename_all = "camelCase"`, enums `rename_all = "snake_case"` (match `activity.rs`).
- Frontend/Rust type mirrors: every Rust type crossing IPC has a TS mirror in `src/types.ts` with a `(mirrors Rust …)` doc comment.

---

### Task 1: Hook script + `HookEvent` carry the ask payload

The hook script (`HOOK_SCRIPT` in `src-tauri/src/hooks.rs`) records compact per-event lines; `kriyon_core::hooks::HookEvent` parses them. Neither carries the Notification `message`, the AskUserQuestion `questions`, or the ExitPlanMode `plan` today. Add all three, tolerantly.

**Files:**
- Modify: `crates/kriyon-core/src/hooks.rs` (struct `HookEvent` ~line 62, tests ~line 172)
- Modify: `src-tauri/src/hooks.rs` (`HOOK_SCRIPT` const, ~lines 106–175)

**Interfaces:**
- Produces: `HookEvent` gains `pub message: Option<String>`, `pub questions: Option<String>` (raw JSON string of the questions array), `pub plan: Option<String>` (first non-empty line, capped). `HookEvent` newly derives `Default`. Task 2 consumes these fields.

- [ ] **Step 1: Write the failing tests** — append to `mod tests` in `crates/kriyon-core/src/hooks.rs`:

```rust
#[test]
fn parses_ask_fields() {
    let line = r#"{"event":"PreToolUse","tool_name":"AskUserQuestion","tool_use_id":"toolu_5","questions":"[{\"question\":\"Which db?\"}]"}"#;
    let ev = parse_hook_line(line).expect("parses");
    assert_eq!(
        ev.questions.as_deref(),
        Some(r#"[{"question":"Which db?"}]"#)
    );

    let line = r#"{"event":"Notification","message":"Claude needs your permission to use Bash"}"#;
    let ev = parse_hook_line(line).expect("parses");
    assert_eq!(
        ev.message.as_deref(),
        Some("Claude needs your permission to use Bash")
    );

    let line = r#"{"event":"PreToolUse","tool_name":"ExitPlanMode","plan":"Ship the thing"}"#;
    let ev = parse_hook_line(line).expect("parses");
    assert_eq!(ev.plan.as_deref(), Some("Ship the thing"));
}

#[test]
fn ask_fields_default_to_none_when_absent() {
    let ev = parse_hook_line(r#"{"event":"Stop"}"#).expect("parses");
    assert_eq!(ev.message, None);
    assert_eq!(ev.questions, None);
    assert_eq!(ev.plan, None);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p kriyon-core hooks::`
Expected: FAIL — `no field 'questions' on type HookEvent` (compile error).

- [ ] **Step 3: Implement.** In `crates/kriyon-core/src/hooks.rs`:

(a) Add `Default` to the derive and the three fields at the end of the struct:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
pub struct HookEvent {
    // … existing fields unchanged …

    /// The human message on a `Notification` hook (e.g. "Claude needs your
    /// permission to use Bash"). Feeds the permission [Pending ask].
    #[serde(default)]
    pub message: Option<String>,
    /// For an `AskUserQuestion` `PreToolUse`, the raw JSON of `tool_input.questions`
    /// (capped by the hook script; dropped, not truncated, when oversized so it
    /// never arrives malformed). Parsed tolerantly in `ask.rs`.
    #[serde(default)]
    pub questions: Option<String>,
    /// For an `ExitPlanMode` `PreToolUse`, the plan's first non-empty line (capped).
    #[serde(default)]
    pub plan: Option<String>,
}
```

(b) The two tests that construct `HookEvent` literally (`parses_a_minimal_event`, `parses_event_without_optional_fields`) and the one in `summary_uses_tool_name_when_present` now fail to compile. Rewrite each literal to spell only the meaningful fields and end with `..HookEvent::default()`, e.g.:

```rust
assert_eq!(
    parse_hook_line(line),
    Some(HookEvent {
        event: "Stop".to_string(),
        session_id: Some("claude-1".to_string()),
        transcript_path: Some("/t/x.jsonl".to_string()),
        ..HookEvent::default()
    })
);
```

(c) Run `cargo build -p kriyon-core -p kriyon 2>&1 | head` and fix any other `HookEvent { … }` literal the compiler reports (e.g. in `activity.rs` tests or `src-tauri`) the same way.

- [ ] **Step 4: Update the hook script.** In `src-tauri/src/hooks.rs`, inside `HOOK_SCRIPT`, after the existing `target` block (~line 144) and before `rec = {`:

```python
# Ask payload: the Notification message, the AskUserQuestion questions (raw
# JSON, dropped when oversized so it never arrives malformed), and the plan's
# first line. Feeds the Pending-ask reconstruction in kriyon-core.
msg = data.get("message")
if isinstance(msg, str):
    if len(msg) > 300:
        msg = msg[:300] + "…"
else:
    msg = None
qs = ti.get("questions")
questions = json.dumps(qs) if isinstance(qs, list) else None
if questions is not None and len(questions) > 2000:
    questions = None
plan = ti.get("plan")
if isinstance(plan, str):
    plan = next((l for l in plan.splitlines() if l.strip()), "").strip()[:200] or None
else:
    plan = None
```

And add to the `rec` dict (after `"target": target,`):

```python
    "message": msg,
    "questions": questions,
    "plan": plan,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p kriyon-core hooks:: && cargo test -p kriyon 2>&1 | tail -3`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add crates/kriyon-core/src/hooks.rs src-tauri/src/hooks.rs
git commit -m "feat(hooks): record message/questions/plan for pending-ask reconstruction"
```

---

### Task 2: `ask.rs` — the Pending-ask state machine

**Files:**
- Create: `crates/kriyon-core/src/ask.rs`
- Modify: `crates/kriyon-core/src/lib.rs` (add `pub mod ask;` alphabetically, after `activity`)

**Interfaces:**
- Consumes: `crate::hooks::HookEvent` with Task 1's `message`/`questions`/`plan` fields.
- Produces (Task 3 + frontend rely on these exact names):

```rust
pub enum AskKind { Question, Permission, PlanApproval }        // serde snake_case
pub struct PendingAsk { kind: AskKind, text: String, asked_at: Option<String> } // serde camelCase
pub struct AskState;                                           // Default
impl AskState {
    pub fn new() -> Self;
    pub fn ingest(&mut self, ev: &HookEvent) -> bool;  // true when current() changed
    pub fn current(&self) -> Option<PendingAsk>;
}
```

- [ ] **Step 1: Write the failing tests.** Create `crates/kriyon-core/src/ask.rs` containing ONLY the test module for now (plus a `use` line), so the failure is a clean compile error:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::HookEvent;

    fn ev(event: &str) -> HookEvent {
        HookEvent {
            event: event.to_string(),
            ..HookEvent::default()
        }
    }

    fn pre(tool: &str) -> HookEvent {
        HookEvent {
            event: "PreToolUse".to_string(),
            tool_name: Some(tool.to_string()),
            tool_use_id: Some("toolu_1".to_string()),
            ts: Some("2026-07-02T10:00:00Z".to_string()),
            ..HookEvent::default()
        }
    }

    #[test]
    fn question_opens_with_extracted_text() {
        let mut state = AskState::new();
        let mut event = pre("AskUserQuestion");
        event.questions = Some(r#"[{"question":"Which db?"},{"question":"Which region?"}]"#.to_string());
        assert!(state.ingest(&event));
        let ask = state.current().expect("open ask");
        assert_eq!(ask.kind, AskKind::Question);
        assert_eq!(ask.text, "Which db? (+1 more)");
        assert_eq!(ask.asked_at.as_deref(), Some("2026-07-02T10:00:00Z"));
    }

    #[test]
    fn single_question_has_no_more_suffix() {
        let mut state = AskState::new();
        let mut event = pre("AskUserQuestion");
        event.questions = Some(r#"[{"question":"Which db?"}]"#.to_string());
        state.ingest(&event);
        assert_eq!(state.current().expect("open").text, "Which db?");
    }

    #[test]
    fn malformed_questions_degrade_to_generic_text() {
        let mut state = AskState::new();
        let mut event = pre("AskUserQuestion");
        event.questions = Some("{not json".to_string());
        state.ingest(&event);
        assert_eq!(state.current().expect("open").text, "Has a question for you");
        // Missing entirely (hook dropped an oversized payload) degrades the same way.
        let mut state = AskState::new();
        state.ingest(&pre("AskUserQuestion"));
        assert_eq!(state.current().expect("open").text, "Has a question for you");
    }

    #[test]
    fn matching_post_tool_use_clears_the_question() {
        let mut state = AskState::new();
        state.ingest(&pre("AskUserQuestion"));
        let mut post = ev("PostToolUse");
        post.tool_use_id = Some("toolu_1".to_string());
        assert!(state.ingest(&post));
        assert_eq!(state.current(), None);
    }

    #[test]
    fn unrelated_post_tool_use_keeps_the_question() {
        let mut state = AskState::new();
        state.ingest(&pre("AskUserQuestion"));
        let mut post = ev("PostToolUse");
        post.tool_use_id = Some("toolu_other".to_string());
        assert!(!state.ingest(&post));
        assert!(state.current().is_some());
    }

    #[test]
    fn plan_approval_opens_with_plan_line() {
        let mut state = AskState::new();
        let mut event = pre("ExitPlanMode");
        event.plan = Some("Ship the actionable needs-you".to_string());
        state.ingest(&event);
        let ask = state.current().expect("open");
        assert_eq!(ask.kind, AskKind::PlanApproval);
        assert_eq!(ask.text, "Approve plan: Ship the actionable needs-you");
    }

    #[test]
    fn plan_approval_without_plan_uses_generic_text() {
        let mut state = AskState::new();
        state.ingest(&pre("ExitPlanMode"));
        assert_eq!(state.current().expect("open").text, "Plan ready for review");
    }

    #[test]
    fn permission_notification_opens_a_permission_ask() {
        let mut state = AskState::new();
        let mut event = ev("Notification");
        event.message = Some("Claude needs your permission to use Bash".to_string());
        assert!(state.ingest(&event));
        let ask = state.current().expect("open");
        assert_eq!(ask.kind, AskKind::Permission);
        assert_eq!(ask.text, "Claude needs your permission to use Bash");
    }

    #[test]
    fn non_permission_notification_opens_nothing() {
        // An idle-prompt Notification is prose the snippet fallback renders better;
        // claiming it as a permission would be a confident wrong state.
        let mut state = AskState::new();
        let mut event = ev("Notification");
        event.message = Some("Claude is waiting for your input".to_string());
        assert!(!state.ingest(&event));
        assert_eq!(state.current(), None);
    }

    #[test]
    fn permission_request_event_opens_a_permission_ask() {
        let mut state = AskState::new();
        state.ingest(&ev("PermissionRequest"));
        let ask = state.current().expect("open");
        assert_eq!(ask.kind, AskKind::Permission);
        assert_eq!(ask.text, "Needs permission");
    }

    #[test]
    fn any_post_tool_use_resolves_a_permission() {
        // Sequence: PreToolUse(Bash) → permission Notification → user approves →
        // the tool runs → PostToolUse(Bash). The Post proves the prompt resolved.
        let mut state = AskState::new();
        let mut event = ev("Notification");
        event.message = Some("permission to run rm".to_string());
        state.ingest(&event);
        assert!(state.ingest(&ev("PostToolUse")));
        assert_eq!(state.current(), None);
    }

    #[test]
    fn turn_boundaries_settle_any_ask() {
        for boundary in ["UserPromptSubmit", "Stop", "SessionEnd"] {
            let mut state = AskState::new();
            state.ingest(&pre("AskUserQuestion"));
            assert!(state.ingest(&ev(boundary)), "{boundary} clears");
            assert_eq!(state.current(), None, "{boundary} cleared");
        }
    }

    #[test]
    fn newest_ask_wins() {
        let mut state = AskState::new();
        state.ingest(&pre("AskUserQuestion"));
        let mut plan = pre("ExitPlanMode");
        plan.tool_use_id = Some("toolu_2".to_string());
        state.ingest(&plan);
        assert_eq!(state.current().expect("open").kind, AskKind::PlanApproval);
    }

    #[test]
    fn unknown_events_are_a_no_op() {
        let mut state = AskState::new();
        assert!(!state.ingest(&ev("PreCompact")));
        assert!(!state.ingest(&ev("SomethingNew")));
        assert_eq!(state.current(), None);
    }

    #[test]
    fn ingest_reports_changed_only_on_change() {
        let mut state = AskState::new();
        assert!(!state.ingest(&ev("Stop")), "clearing nothing is no change");
        assert!(state.ingest(&pre("AskUserQuestion")));
        assert!(!state.ingest(&ev("PreCompact")), "no-op is no change");
    }
}
```

- [ ] **Step 2: Add `pub mod ask;` to `crates/kriyon-core/src/lib.rs`, run tests to verify they fail**

Run: `cargo test -p kriyon-core ask::`
Expected: FAIL — `cannot find struct AskState` (compile error).

- [ ] **Step 3: Implement.** Prepend to `crates/kriyon-core/src/ask.rs` (above the test module):

```rust
//! Pending ask — the concrete thing a `waiting` Session wants from the user,
//! reconstructed live from hook events. One open ask per session, newest wins;
//! cleared at every turn boundary so an ask can never outlive the turn it
//! belongs to (the settle guarantee). Tolerant: unknown or malformed input is
//! a no-op or a generic-text degradation, never an error. See CONTEXT.md
//! "Pending ask" and the 2026-07-02 actionable-needs-you spec.

use serde::{Deserialize, Serialize};

use crate::hooks::HookEvent;

/// What kind of thing the session is asking for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskKind {
    Question,
    Permission,
    PlanApproval,
}

/// The open ask: kind, one line of human text, and when it was asked
/// (the hook's ISO timestamp, driving "blocked for 12m").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAsk {
    pub kind: AskKind,
    pub text: String,
    pub asked_at: Option<String>,
}

/// Folds hook events into the session's current [`PendingAsk`].
#[derive(Debug, Default)]
pub struct AskState {
    current: Option<PendingAsk>,
    /// The tool call the current ask belongs to, so only its own
    /// `PostToolUse` closes a question/plan (permissions have none).
    tool_use_id: Option<String>,
}

impl AskState {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The open ask, if any.
    #[must_use]
    pub fn current(&self) -> Option<PendingAsk> {
        self.current.clone()
    }

    /// Fold one hook event in. Returns whether [`Self::current`] changed.
    pub fn ingest(&mut self, ev: &HookEvent) -> bool {
        let before = self.current.clone();
        match ev.event.as_str() {
            "PreToolUse" => match ev.tool_name.as_deref() {
                Some("AskUserQuestion") => {
                    self.open(AskKind::Question, question_text(ev.questions.as_deref()), ev);
                }
                Some("ExitPlanMode") => {
                    self.open(AskKind::PlanApproval, plan_text(ev.plan.as_deref()), ev);
                }
                _ => {}
            },
            "PostToolUse" => {
                let closes_own_tool =
                    self.tool_use_id.is_some() && self.tool_use_id == ev.tool_use_id;
                let resolves_permission = matches!(
                    &self.current,
                    Some(ask) if ask.kind == AskKind::Permission
                );
                if closes_own_tool || resolves_permission {
                    self.clear();
                }
            }
            // Only a permission-shaped Notification is an exact ask; an idle
            // prompt is prose the frontend's snippet fallback renders honestly.
            "Notification" => {
                if is_permission_message(ev.message.as_deref()) {
                    self.open(
                        AskKind::Permission,
                        ev.message.clone().unwrap_or_else(|| "Needs permission".to_string()),
                        ev,
                    );
                }
            }
            "PermissionRequest" => {
                self.open(
                    AskKind::Permission,
                    ev.message.clone().unwrap_or_else(|| "Needs permission".to_string()),
                    ev,
                );
            }
            "UserPromptSubmit" | "Stop" | "SessionEnd" => self.clear(),
            _ => {}
        }
        self.current != before
    }

    fn open(&mut self, kind: AskKind, text: String, ev: &HookEvent) {
        self.current = Some(PendingAsk {
            kind,
            text,
            asked_at: ev.ts.clone(),
        });
        self.tool_use_id = ev.tool_use_id.clone();
    }

    fn clear(&mut self) {
        self.current = None;
        self.tool_use_id = None;
    }
}

/// Extract the first question (plus a "+N more" suffix) from the raw questions
/// JSON. Anything unparseable degrades to generic text, never an error.
fn question_text(raw: Option<&str>) -> String {
    #[derive(Deserialize)]
    struct Entry {
        question: String,
    }
    let parsed = raw.and_then(|text| serde_json::from_str::<Vec<Entry>>(text).ok());
    match parsed {
        Some(entries) if !entries.is_empty() => {
            let first = &entries[0].question;
            if entries.len() > 1 {
                format!("{first} (+{} more)", entries.len() - 1)
            } else {
                first.clone()
            }
        }
        _ => "Has a question for you".to_string(),
    }
}

fn plan_text(plan: Option<&str>) -> String {
    match plan {
        Some(line) if !line.trim().is_empty() => format!("Approve plan: {}", line.trim()),
        _ => "Plan ready for review".to_string(),
    }
}

fn is_permission_message(message: Option<&str>) -> bool {
    message.is_some_and(|m| m.to_lowercase().contains("permission"))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p kriyon-core ask::`
Expected: PASS (14 tests). Also run `cargo clippy -p kriyon-core --all-targets -- -D warnings` and fix anything it flags.

- [ ] **Step 5: Commit**

```bash
git add crates/kriyon-core/src/ask.rs crates/kriyon-core/src/lib.rs
git commit -m "feat(core): pending-ask state machine reconstructing what a waiting session wants"
```

---

### Task 3: Carry `pendingAsk` on the activity snapshot

**Files:**
- Modify: `crates/kriyon-core/src/activity.rs` (struct `SessionActivity`, ~line 23)
- Modify: `src-tauri/src/watcher.rs` (`ActivitySource`, ~lines 246–318)

**Interfaces:**
- Consumes: `kriyon_core::ask::{AskState, PendingAsk}` from Task 2.
- Produces: `SessionActivity` gains `#[serde(default)] pub pending_ask: Option<PendingAsk>` (serialized `pendingAsk`), populated by the watcher. Emission dedupe is unchanged (snapshot serialization already diffs). Task 4's TS mirror relies on the `pendingAsk` field name.

- [ ] **Step 1: Write the failing test** — append to `mod tests` in `src-tauri/src/watcher.rs` (mirror the setup used by the existing `spawn_session_watch_emits_activity_snapshots` test; reuse its helpers for temp dirs/paths):

```rust
#[test]
fn activity_source_carries_the_pending_ask() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut source = ActivitySource::new(dir.path().to_path_buf());

    let open = kriyon_core::hooks::parse_hook_line(
        r#"{"event":"PreToolUse","tool_name":"AskUserQuestion","tool_use_id":"toolu_1","questions":"[{\"question\":\"Which db?\"}]"}"#,
    )
    .expect("parses");
    source.observe_hook(&open);
    let snap = source.snapshot().expect("changed snapshot emits");
    let ask = snap.pending_ask.expect("ask is carried");
    assert_eq!(ask.text, "Which db?");

    let close = kriyon_core::hooks::parse_hook_line(
        r#"{"event":"PostToolUse","tool_use_id":"toolu_1"}"#,
    )
    .expect("parses");
    source.observe_hook(&close);
    let snap = source.snapshot().expect("clearing the ask emits");
    assert_eq!(snap.pending_ask, None);
}
```

(If the existing tests build `ActivitySource` differently — e.g. no `tempfile` in scope — follow the file's existing test conventions for constructing it; the assertions stay the same.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p kriyon activity_source_carries_the_pending_ask`
Expected: FAIL — `no field pending_ask on SessionActivity` (compile error).

- [ ] **Step 3: Implement.**

(a) `crates/kriyon-core/src/activity.rs` — add the field (and the import at the top of the file):

```rust
use crate::ask::PendingAsk;
```

```rust
pub struct SessionActivity {
    pub main: MainAgent,
    pub subagents: Vec<Subagent>,
    pub shells: Vec<BackgroundShell>,
    pub tasks: Vec<Task>,
    /// The open [Pending ask] — what this session wants from the user right
    /// now, or `None`. Rides the activity snapshot so delivery and dedupe are
    /// shared; see CONTEXT.md "Pending ask".
    #[serde(default)]
    pub pending_ask: Option<PendingAsk>,
}
```

(b) Fix every `SessionActivity { … }` construction site the compiler reports (watcher `snapshot()`, any tests) by adding the field.

(c) `src-tauri/src/watcher.rs` — `ActivitySource` gains the ask machine:

```rust
struct ActivitySource {
    activity: HookActivity,
    /// Folds hook events into the session's open Pending ask.
    ask: kriyon_core::ask::AskState,
    // … existing fields unchanged …
}
```

In `ActivitySource::new`, initialize `ask: kriyon_core::ask::AskState::new(),`.
In `observe_hook`, after `self.activity.ingest(event);` add `self.ask.ingest(event);`.
In `snapshot()`, build the struct with `pending_ask: self.ask.current(),`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p kriyon && cargo test -p kriyon-core && cargo clippy --all-targets -- -D warnings`
Expected: PASS (all), no clippy warnings.

- [ ] **Step 5: Commit**

```bash
git add crates/kriyon-core/src/activity.rs src-tauri/src/watcher.rs
git commit -m "feat(watcher): carry the pending ask on the session-activity snapshot"
```

---

### Task 4: Frontend types + Needs-you entry builder

Pure derivation first: given standings, sessions, projects, activity, and events, build the enriched Needs-you entries.

**Files:**
- Modify: `src/types.ts` (add `PendingAsk` mirror; extend `SessionActivity`)
- Create: `src/state/needsYou.ts`
- Test: `src/state/needsYou.test.ts`

**Interfaces:**
- Consumes: `SessionStanding`, `UiSession`, `ProjectRow`, `SessionActivity`, `StudioEvent` (all existing), `contextLine` from `src/sidebar/sessionContext.ts`.
- Produces (Tasks 5–6 rely on these exact names):

```ts
// types.ts
export type PendingAskKind = "question" | "permission" | "plan_approval";
export interface PendingAsk { askedAt: string | null; kind: PendingAskKind; text: string; }
// SessionActivity gains: pendingAsk: PendingAsk | null;

// state/needsYou.ts
export type EntryAsk =
  | { tier: "exact"; kind: PendingAskKind; text: string }
  | { tier: "best_effort"; kind: "snippet"; text: string };
export interface NeedsYouEntry {
  ask: EntryAsk | null;
  blockedForMs: number;
  contextText: string | null;
  projectName: string;
  sessionId: string;
  title: string;
}
export function snippetFromEvents(events: StudioEvent[] | undefined): string | null;
export function formatDuration(ms: number): string; // "<1m" | "12m" | "1h 05m"
export function buildNeedsYouEntries(args: {
  blocked: SessionStanding[];
  sessions: Record<string, UiSession>;
  projects: ProjectRow[];
  activity: Record<string, SessionActivity>;
  events: Record<string, StudioEvent[]>;
  nowMs: number;
}): NeedsYouEntry[]; // ordered longest-blocked first
```

- [ ] **Step 1: Write the failing tests.** Create `src/state/needsYou.test.ts`:

```ts
import { expect, test } from "vitest";
import type {
  ProjectRow,
  SessionActivity,
  SessionStanding,
  StudioEvent,
} from "../types.ts";
import type { UiSession } from "./sessions.ts";
import {
  buildNeedsYouEntries,
  formatDuration,
  snippetFromEvents,
} from "./needsYou.ts";

const NOW = Date.parse("2026-07-02T10:12:00Z");

function standing(sessionId: string, lastChangeMs: number): SessionStanding {
  return {
    lastChangeMs,
    lastSeenMs: NOW,
    projectId: "p1",
    sessionId,
    state: "awaiting_input",
    worktree: null,
  };
}

function session(id: string): UiSession {
  return {
    booting: false,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    id,
    projectId: "p1",
    status: "waiting",
    summary: "Waiting for you",
    title: `Title ${id}`,
    worktreePath: null,
  };
}

function activityWith(ask: SessionActivity["pendingAsk"]): SessionActivity {
  return { main: { currentTool: null }, pendingAsk: ask, shells: [], subagents: [], tasks: [] };
}

const project: ProjectRow = { color: null, id: "p1", name: "Kriyon", path: "/repo" };

test("an exact ask is surfaced with its kind and text", () => {
  const entries = buildNeedsYouEntries({
    activity: {
      s1: activityWith({
        askedAt: "2026-07-02T10:00:00Z",
        kind: "question",
        text: "Which db?",
      }),
    },
    blocked: [standing("s1", NOW - 1000)],
    events: {},
    nowMs: NOW,
    projects: [project],
    sessions: { s1: session("s1") },
  });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.ask).toEqual({ kind: "question", text: "Which db?", tier: "exact" });
  expect(entries[0]?.projectName).toBe("Kriyon");
  // blockedFor comes from askedAt when present: 12 minutes.
  expect(entries[0]?.blockedForMs).toBe(12 * 60_000);
});

test("without an exact ask the last assistant text becomes a best-effort snippet", () => {
  const events: StudioEvent[] = [
    { id: "1:0", kind: "assistant", text: "First answer" },
    { id: "2:0", kind: "tool", meta: null, name: "Bash", target: "ls" },
    { id: "3:0", kind: "assistant", text: "Should I use worktrees?\nMore detail…" },
  ];
  const entries = buildNeedsYouEntries({
    activity: {},
    blocked: [standing("s1", NOW - 5000)],
    events: { s1: events },
    nowMs: NOW,
    projects: [project],
    sessions: { s1: session("s1") },
  });
  expect(entries[0]?.ask).toEqual({
    kind: "snippet",
    text: "Should I use worktrees?",
    tier: "best_effort",
  });
  // Falls back to lastChangeMs for the blocked duration.
  expect(entries[0]?.blockedForMs).toBe(5000);
});

test("entries order longest-blocked first", () => {
  const entries = buildNeedsYouEntries({
    activity: {},
    blocked: [standing("recent", NOW - 1000), standing("old", NOW - 60_000)],
    events: {},
    nowMs: NOW,
    projects: [project],
    sessions: { old: session("old"), recent: session("recent") },
  });
  expect(entries.map((e) => e.sessionId)).toEqual(["old", "recent"]);
});

test("an unparseable askedAt falls back to lastChangeMs", () => {
  const entries = buildNeedsYouEntries({
    activity: {
      s1: activityWith({ askedAt: "not-a-date", kind: "permission", text: "Bash" }),
    },
    blocked: [standing("s1", NOW - 2000)],
    events: {},
    nowMs: NOW,
    projects: [project],
    sessions: { s1: session("s1") },
  });
  expect(entries[0]?.blockedForMs).toBe(2000);
});

test("snippet is null with no assistant events", () => {
  expect(snippetFromEvents(undefined)).toBeNull();
  expect(snippetFromEvents([{ id: "1:0", kind: "bash", cmd: "ls", exit: 0, output: [] }])).toBeNull();
});

test("snippet truncates to 120 chars on the first line", () => {
  const long = "x".repeat(200);
  const snippet = snippetFromEvents([{ id: "1:0", kind: "assistant", text: long }]);
  expect(snippet).toHaveLength(121); // 120 + ellipsis
  expect(snippet?.endsWith("…")).toBe(true);
});

test("formatDuration buckets", () => {
  expect(formatDuration(30_000)).toBe("<1m");
  expect(formatDuration(12 * 60_000)).toBe("12m");
  expect(formatDuration(65 * 60_000)).toBe("1h 05m");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/state/needsYou.test.ts`
Expected: FAIL — cannot resolve `./needsYou.ts`.

- [ ] **Step 3: Implement.**

(a) `src/types.ts` — after the `Task` interface (~line 247), add; and add the field to `SessionActivity`:

```ts
/** What kind of thing a waiting session is asking for (mirrors Rust `AskKind`). */
export type PendingAskKind = "question" | "permission" | "plan_approval";

/**
 * The concrete thing a waiting session wants from the user right now (mirrors
 * Rust `kriyon_core::ask::PendingAsk`). Ephemeral — rides the activity snapshot.
 */
export interface PendingAsk {
  /** ISO timestamp of the hook that opened the ask; drives "blocked for 12m". */
  askedAt: string | null;
  kind: PendingAskKind;
  text: string;
}
```

```ts
export interface SessionActivity {
  main: MainAgent;
  /** The open Pending ask, or null. Exact-tier; the snippet fallback is derived. */
  pendingAsk: PendingAsk | null;
  shells: BackgroundShell[];
  subagents: Subagent[];
  tasks: Task[];
}
```

Fix the compile fallout: every place that constructs a `SessionActivity` literal in frontend tests/QA fixtures needs `pendingAsk: null` (run `pnpm typecheck` to find them).

(b) Create `src/state/needsYou.ts`:

```ts
import { contextLine } from "../sidebar/sessionContext.ts";
import type {
  PendingAskKind,
  ProjectRow,
  SessionActivity,
  SessionStanding,
  StudioEvent,
} from "../types.ts";
import type { UiSession } from "./sessions.ts";

/** Cap for the best-effort snippet drawn from the last assistant message. */
const SNIPPET_MAX = 120;

/**
 * The ask an entry renders: the exact Pending ask when the backend knows one,
 * else a best-effort snippet of the last assistant message. The tier is shown
 * honestly — exact asks get their kind's icon, snippets render quieter.
 */
export type EntryAsk =
  | { kind: PendingAskKind; text: string; tier: "exact" }
  | { kind: "snippet"; text: string; tier: "best_effort" };

/** One session's row in the Needs-you list (rail and overlay). */
export interface NeedsYouEntry {
  ask: EntryAsk | null;
  blockedForMs: number;
  contextText: string | null;
  projectName: string;
  sessionId: string;
  title: string;
}

/** First line of the last assistant message, truncated — the snippet fallback. */
export function snippetFromEvents(
  events: StudioEvent[] | undefined
): string | null {
  if (!events) {
    return null;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind === "assistant") {
      const line = event.text.split("\n", 1)[0]?.trim() ?? "";
      if (!line) {
        return null;
      }
      return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX)}…` : line;
    }
  }
  return null;
}

/** "blocked 12m" durations: <1m, Nm, then Nh MMm. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

function blockedFor(
  askedAt: string | null | undefined,
  lastChangeMs: number,
  nowMs: number
): number {
  const asked = askedAt ? Date.parse(askedAt) : Number.NaN;
  const since = Number.isNaN(asked) ? lastChangeMs : asked;
  return Math.max(0, nowMs - since);
}

/**
 * Enrich the blocked standings into renderable entries, longest-blocked first.
 * Pure: everything comes in as arguments, nothing is stored.
 */
export function buildNeedsYouEntries(args: {
  activity: Record<string, SessionActivity>;
  blocked: SessionStanding[];
  events: Record<string, StudioEvent[]>;
  nowMs: number;
  projects: ProjectRow[];
  sessions: Record<string, UiSession>;
}): NeedsYouEntry[] {
  const entries = args.blocked.map((standing) => {
    const session = args.sessions[standing.sessionId];
    const activity = args.activity[standing.sessionId];
    const pending = activity?.pendingAsk ?? null;
    const snippet = pending
      ? null
      : snippetFromEvents(args.events[standing.sessionId]);
    const ask: EntryAsk | null = pending
      ? { kind: pending.kind, text: pending.text, tier: "exact" }
      : snippet
        ? { kind: "snippet", text: snippet, tier: "best_effort" }
        : null;
    const context = session
      ? contextLine(session.status, session.summary, activity)
      : null;
    return {
      ask,
      blockedForMs: blockedFor(pending?.askedAt, standing.lastChangeMs, args.nowMs),
      contextText: context?.text ?? null,
      projectName:
        args.projects.find((p) => p.id === standing.projectId)?.name ??
        standing.projectId,
      sessionId: standing.sessionId,
      title: session?.title ?? standing.sessionId,
    };
  });
  return entries.sort((a, b) => b.blockedForMs - a.blockedForMs);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/state/needsYou.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean after fixing `SessionActivity` literal sites.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/types.ts src/state/needsYou.ts src/state/needsYou.test.ts
git add -u
git commit -m "feat(needs-you): pending-ask mirror and enriched entry builder"
```

---

### Task 5: Shared `NeedsYouList` + enriched Command-center rail

**Files:**
- Create: `src/needsYou/NeedsYouList.tsx`
- Modify: `src/commandCenter/CommandCenter.tsx` (rail block, ~lines 253–281)
- Test: `src/commandCenter/CommandCenter.test.tsx` (add cases; keep existing ones passing)

**Interfaces:**
- Consumes: `NeedsYouEntry`, `buildNeedsYouEntries`, `formatDuration` (Task 4); `statusMeta`, `tokens`.
- Produces: `<NeedsYouList entries={NeedsYouEntry[]} activeSessionId={string|null} onOpen={(id: string, exact: boolean) => void} selectedIndex={number|undefined} />`. Keeps the existing testids `needs-you-<sessionId>`; adds `needs-you-ask-<sessionId>` and `needs-you-blocked-<sessionId>`. Task 6 reuses this component.

- [ ] **Step 1: Write the failing tests** — append to `src/commandCenter/CommandCenter.test.tsx` (reuse its `makeSession`/`makeProject` helpers; the `beforeEach` store seed needs `activity: {}` already present):

```tsx
test("a rail entry shows the exact ask, blocked duration, and project", () => {
  const now = Date.now();
  useCommandCenter.setState({
    lastChangeMs: { s1: now - 5 * 60_000 },
    lastSeenMs: { s1: now, s2: now },
  });
  useSessions.setState((state) => ({
    activity: {
      ...state.activity,
      s1: {
        main: { currentTool: null },
        pendingAsk: {
          askedAt: new Date(now - 12 * 60_000).toISOString(),
          kind: "question",
          text: "Which db?",
        },
        shells: [],
        subagents: [],
        tasks: [],
      },
    },
  }));
  render(<CommandCenter />);
  expect(screen.getByTestId("needs-you-ask-s1").textContent).toContain("Which db?");
  expect(screen.getByTestId("needs-you-blocked-s1").textContent).toBe("12m");
});

test("without an exact ask the rail entry shows the assistant snippet", () => {
  const now = Date.now();
  useCommandCenter.setState({ lastSeenMs: { s1: now, s2: now } });
  useSessions.setState((state) => ({
    events: {
      ...state.events,
      s1: [{ id: "1:0", kind: "assistant", text: "Should I use worktrees?" }],
    },
  }));
  render(<CommandCenter />);
  expect(screen.getByTestId("needs-you-ask-s1").textContent).toContain(
    "Should I use worktrees?"
  );
});

test("opening an entry with an exact ask routes to the raw view", () => {
  const now = Date.now();
  useCommandCenter.setState({ lastSeenMs: { s1: now, s2: now } });
  useSessions.setState((state) => ({
    activity: {
      ...state.activity,
      s1: {
        main: { currentTool: null },
        pendingAsk: { askedAt: null, kind: "permission", text: "Bash" },
        shells: [],
        subagents: [],
        tasks: [],
      },
    },
  }));
  render(<CommandCenter />);
  fireEvent.click(screen.getByTestId("needs-you-s1"));
  const state = useSessions.getState();
  expect(state.activeSessionId).toBe("s1");
  expect(state.layout.view).toBe("studio");
  expect(state.layout.transcriptView).toBe("raw");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/commandCenter/CommandCenter.test.tsx`
Expected: the three new tests FAIL (`needs-you-ask-s1` not found); existing tests still pass.

- [ ] **Step 3: Implement.** Create `src/needsYou/NeedsYouList.tsx`:

```tsx
import type { CSSProperties } from "react";
import type { NeedsYouEntry } from "../state/needsYou.ts";
import { formatDuration } from "../state/needsYou.ts";
import { statusMeta } from "../theme/status.ts";
import { tokens } from "../theme/tokens.ts";

/** Icon glyph per ask kind — text glyphs, no icon dependency in this list. */
function askGlyph(kind: string): string {
  switch (kind) {
    case "question":
      return "?";
    case "permission":
      return "⚿";
    case "plan_approval":
      return "▤";
    default:
      return "·";
  }
}

function rowStyle(active: boolean, selected: boolean): CSSProperties {
  return {
    alignItems: "flex-start",
    background:
      selected || active ? tokens.color.surface.s2 : "transparent",
    border: "none",
    borderRadius: tokens.radius.md,
    color: tokens.color.text,
    cursor: "pointer",
    display: "flex",
    fontFamily: tokens.font.sans,
    gap: tokens.space.sm,
    padding: `${tokens.space.sm} ${tokens.space.md}`,
    textAlign: "left",
    width: "100%",
  };
}

const glyphStyle: CSSProperties = {
  color: statusMeta("waiting").color,
  flex: "none",
  fontSize: "13px",
  lineHeight: "18px",
  width: "14px",
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  display: "block",
  fontSize: "13px",
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function askStyle(tier: "exact" | "best_effort"): CSSProperties {
  return {
    color:
      tier === "exact" ? tokens.color.ink.primary : tokens.color.ink.dim,
    display: "block",
    fontSize: "12px",
    fontStyle: tier === "best_effort" ? "italic" : "normal",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

const metaStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  display: "block",
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const blockedStyle: CSSProperties = {
  color: tokens.color.ink.dim,
  flex: "none",
  fontSize: "11px",
  fontVariantNumeric: "tabular-nums",
};

/**
 * The shared Needs-you list: one enriched row per blocked session, rendered by
 * both the Command-center rail and the ⌘⇧K overlay. `onOpen` receives whether
 * the entry's ask is exact so the caller can route straight to the Raw view.
 */
export function NeedsYouList({
  activeSessionId,
  entries,
  onOpen,
  selectedIndex,
}: {
  activeSessionId: string | null;
  entries: NeedsYouEntry[];
  onOpen: (sessionId: string, exact: boolean) => void;
  selectedIndex?: number;
}) {
  return (
    <>
      {entries.map((entry, index) => (
        <button
          data-testid={`needs-you-${entry.sessionId}`}
          key={entry.sessionId}
          onClick={() => onOpen(entry.sessionId, entry.ask?.tier === "exact")}
          style={rowStyle(
            entry.sessionId === activeSessionId,
            index === selectedIndex
          )}
          type="button"
        >
          <span aria-hidden style={glyphStyle}>
            {askGlyph(entry.ask?.kind ?? "")}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={titleStyle}>{entry.title}</span>
            {entry.ask ? (
              <span
                data-testid={`needs-you-ask-${entry.sessionId}`}
                style={askStyle(entry.ask.tier)}
              >
                {entry.ask.text}
              </span>
            ) : null}
            <span style={metaStyle}>
              {entry.projectName}
              {entry.contextText ? ` · ${entry.contextText}` : ""}
            </span>
          </span>
          <span
            data-testid={`needs-you-blocked-${entry.sessionId}`}
            style={blockedStyle}
          >
            {formatDuration(entry.blockedForMs)}
          </span>
        </button>
      ))}
    </>
  );
}
```

Then in `src/commandCenter/CommandCenter.tsx`:
- Add imports: `import { NeedsYouList } from "../needsYou/NeedsYouList.tsx";`, `import { buildNeedsYouEntries } from "../state/needsYou.ts";` and pull `activity`/`events`/`setTranscriptView` from `useSessions`:

```tsx
const activity = useSessions((state) => state.activity);
const events = useSessions((state) => state.events);
const setTranscriptView = useSessions((state) => state.setTranscriptView);
```

- Replace the rail's `blocked.map(…)` block (lines ~255–275) with:

```tsx
{blocked.length > 0 ? (
  <NeedsYouList
    activeSessionId={activeSessionId}
    entries={buildNeedsYouEntries({
      activity,
      blocked,
      events,
      nowMs,
      projects,
      sessions,
    })}
    onOpen={(id, exact) => {
      openStanding(id);
      if (exact) {
        setTranscriptView("raw");
      }
    }}
  />
) : (
  <span style={emptyStateStyle}>Nothing is waiting on you right now.</span>
)}
```

Delete the now-unused `needsYouTitleStyle` / `needsYouProjectStyle` consts if nothing else references them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/commandCenter/CommandCenter.test.tsx && pnpm typecheck`
Expected: PASS (old + new).

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/needsYou/NeedsYouList.tsx src/commandCenter/CommandCenter.tsx src/commandCenter/CommandCenter.test.tsx
git commit -m "feat(needs-you): enriched rail entries via shared NeedsYouList"
```

---

### Task 6: ⌘⇧K Needs-you overlay

**Files:**
- Modify: `src/state/ui.ts` (add overlay open state)
- Create: `src/needsYou/NeedsYouOverlay.tsx`
- Modify: `src/palette/CommandPalette.tsx` (~line 208: ignore ⌘⇧K)
- Modify: `src/layout/Shell.tsx` (~line 405: mount overlay beside `<CommandPalette />`)
- Test: `src/needsYou/NeedsYouOverlay.test.tsx`

**Interfaces:**
- Consumes: `NeedsYouList` (Task 5), `buildNeedsYouEntries` (Task 4), `useUi`, `useSessions`, `useCommandCenter`.
- Produces: `useUi` gains `needsYouOpen: boolean`, `openNeedsYou()`, `closeNeedsYou()`. `<NeedsYouOverlay />` mounted globally; ⌘⇧K toggles it.

- [ ] **Step 1: Write the failing tests.** Create `src/needsYou/NeedsYouOverlay.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useCommandCenter } from "../state/commandCenter.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import type { ProjectRow } from "../types.ts";
import { NeedsYouOverlay } from "./NeedsYouOverlay.tsx";

function makeSession(id: string, status: UiSession["status"]): UiSession {
  return {
    booting: false,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "",
    id,
    projectId: "p1",
    status,
    summary: "",
    title: `Title ${id}`,
    worktreePath: null,
  };
}

const project: ProjectRow = { color: null, id: "p1", name: "Kriyon", path: "/k" };

beforeEach(() => {
  const now = Date.now();
  useUi.setState({ needsYouOpen: false, paletteOpen: false });
  useSessions.setState({
    activeSessionId: null,
    activity: {},
    events: {},
    projects: [project],
    sessions: {
      s1: makeSession("s1", "waiting"),
      s2: makeSession("s2", "waiting"),
    },
  });
  useCommandCenter.setState({
    lastChangeMs: { s1: now - 60_000, s2: now - 5000 },
    lastSeenMs: { s1: now, s2: now },
  });
});

test("cmd-shift-k opens the overlay listing blocked sessions", () => {
  render(<NeedsYouOverlay />);
  fireEvent.keyDown(window, { key: "K", metaKey: true, shiftKey: true });
  expect(screen.getByTestId("needs-you-overlay")).toBeTruthy();
  expect(screen.getByTestId("needs-you-s1")).toBeTruthy();
  expect(screen.getByTestId("needs-you-s2")).toBeTruthy();
});

test("arrow keys move the selection and enter opens the session", () => {
  useUi.setState({ needsYouOpen: true });
  render(<NeedsYouOverlay />);
  // s1 is blocked longest → first and selected by default; ↓ selects s2.
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.keyDown(window, { key: "Enter" });
  const state = useSessions.getState();
  expect(state.activeSessionId).toBe("s2");
  expect(state.layout.view).toBe("studio");
  expect(useUi.getState().needsYouOpen).toBe(false);
});

test("escape closes the overlay", () => {
  useUi.setState({ needsYouOpen: true });
  render(<NeedsYouOverlay />);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("needs-you-overlay")).toBeNull();
});

test("empty state names the calm win condition", () => {
  useSessions.setState((state) => ({
    sessions: {
      ...state.sessions,
      s1: makeSession("s1", "running"),
      s2: makeSession("s2", "running"),
    },
  }));
  useUi.setState({ needsYouOpen: true });
  render(<NeedsYouOverlay />);
  expect(screen.getByTestId("needs-you-overlay").textContent).toContain(
    "No session needs you."
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/needsYou/NeedsYouOverlay.test.tsx`
Expected: FAIL — cannot resolve `./NeedsYouOverlay.tsx`.

- [ ] **Step 3: Implement.**

(a) `src/state/ui.ts` — extend the store:

```ts
interface UiState {
  closeNeedsYou: () => void;
  closePalette: () => void;
  /** The ⌘⇧K Needs-you overlay. */
  needsYouOpen: boolean;
  openNeedsYou: () => void;
  openPalette: () => void;
  paletteOpen: boolean;
  togglePalette: () => void;
}

export const useUi = create<UiState>((set) => ({
  needsYouOpen: false,
  paletteOpen: false,
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
  openNeedsYou: () => set({ needsYouOpen: true, paletteOpen: false }),
  closeNeedsYou: () => set({ needsYouOpen: false }),
}));
```

(b) `src/palette/CommandPalette.tsx` line ~208 — the palette must not swallow ⌘⇧K:

```ts
if (
  event.key.toLowerCase() === "k" &&
  (event.metaKey || event.ctrlKey) &&
  !event.shiftKey
) {
```

(c) Create `src/needsYou/NeedsYouOverlay.tsx` (modeled on `CommandPalette`'s self-registered keydown):

```tsx
import { type CSSProperties, useEffect, useState } from "react";
import {
  buildStandings,
  needsYou,
  useCommandCenter,
} from "../state/commandCenter.ts";
import { buildNeedsYouEntries } from "../state/needsYou.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { tokens } from "../theme/tokens.ts";
import { NeedsYouList } from "./NeedsYouList.tsx";

const backdropStyle: CSSProperties = {
  alignItems: "flex-start",
  background: "rgba(0, 0, 0, 0.45)",
  display: "flex",
  inset: 0,
  justifyContent: "center",
  paddingTop: "12vh",
  position: "fixed",
  zIndex: 40,
};

const panelStyle: CSSProperties = {
  background: tokens.color.surface.s1,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.lg,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
  maxHeight: "60vh",
  overflowY: "auto",
  padding: tokens.space.md,
  width: "460px",
};

const headingStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.sans,
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.09em",
  padding: `0 ${tokens.space.md}`,
  textTransform: "uppercase",
};

const emptyStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  padding: tokens.space.md,
};

/**
 * The ⌘⇧K Needs-you overlay: the same enriched list as the Command-center rail,
 * summonable from any view. ↑↓ selects, Enter focuses the session (routing to
 * the Raw view when the ask is exact), Esc closes.
 */
export function NeedsYouOverlay() {
  const open = useUi((state) => state.needsYouOpen);
  const openNeedsYou = useUi((state) => state.openNeedsYou);
  const closeNeedsYou = useUi((state) => state.closeNeedsYou);
  const sessions = useSessions((state) => state.sessions);
  const projects = useSessions((state) => state.projects);
  const activity = useSessions((state) => state.activity);
  const events = useSessions((state) => state.events);
  const activeSessionId = useSessions((state) => state.activeSessionId);
  const setActiveSession = useSessions((state) => state.setActiveSession);
  const setView = useSessions((state) => state.setView);
  const setTranscriptView = useSessions((state) => state.setTranscriptView);
  const lastSeenMs = useCommandCenter((state) => state.lastSeenMs);
  const lastChangeMs = useCommandCenter((state) => state.lastChangeMs);
  const [selected, setSelected] = useState(0);

  const nowMs = Date.now();
  const blocked = needsYou(
    buildStandings(sessions, lastSeenMs, lastChangeMs, nowMs)
  );
  const entries = buildNeedsYouEntries({
    activity,
    blocked,
    events,
    nowMs,
    projects,
    sessions,
  });

  function openEntry(id: string, exact: boolean): void {
    setActiveSession(id);
    setView("studio");
    if (exact) {
      setTranscriptView("raw");
    }
    closeNeedsYou();
  }

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "k" &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey
      ) {
        event.preventDefault();
        setSelected(0);
        openNeedsYou();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openNeedsYou]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeNeedsYou();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((s) => Math.min(s + 1, Math.max(entries.length - 1, 0)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (event.key === "Enter") {
        const entry = entries[Math.min(selected, entries.length - 1)];
        if (entry) {
          openEntry(entry.sessionId, entry.ask?.tier === "exact");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!open) {
    return null;
  }

  return (
    <div
      data-testid="needs-you-overlay"
      onClick={closeNeedsYou}
      style={backdropStyle}
    >
      <div onClick={(event) => event.stopPropagation()} style={panelStyle}>
        <span style={headingStyle}>Needs you</span>
        {entries.length > 0 ? (
          <NeedsYouList
            activeSessionId={activeSessionId}
            entries={entries}
            onOpen={openEntry}
            selectedIndex={Math.min(selected, entries.length - 1)}
          />
        ) : (
          <span style={emptyStyle}>No session needs you.</span>
        )}
      </div>
    </div>
  );
}
```

(d) `src/layout/Shell.tsx` — import and mount next to the palette (line ~405):

```tsx
import { NeedsYouOverlay } from "../needsYou/NeedsYouOverlay.tsx";
// …
<CommandPalette />
<NeedsYouOverlay />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/needsYou/NeedsYouOverlay.test.tsx src/palette/CommandPalette.test.tsx && pnpm typecheck`
Expected: PASS — including the untouched palette tests (the shift-guard must not break ⌘K).

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/state/ui.ts src/needsYou/NeedsYouOverlay.tsx src/needsYou/NeedsYouOverlay.test.tsx src/palette/CommandPalette.tsx src/layout/Shell.tsx
git commit -m "feat(needs-you): cmd-shift-k overlay with keyboard triage"
```

---

### Task 7: Catch-up brief — pure digest + store slice

**Files:**
- Create: `src/studio/catchUpBrief.ts`
- Modify: `src/state/sessions.ts` (new fields + `setActiveSession` + `dismissCatchUpBrief`)
- Test: `src/studio/catchUpBrief.test.ts`, plus cases in `src/state/sessions.test.ts`

**Interfaces:**
- Consumes: `StudioEvent`, `SessionActivity` (existing).
- Produces (Task 8 relies on these exact names):

```ts
// studio/catchUpBrief.ts
export const AWAY_MS = 5 * 60_000;
export interface CatchUpBrief {
  commandsRun: number;
  filesEdited: string[];      // up to 3 names
  filesEditedTotal: number;
  lastAssistant: string | null;
  subagentsRan: number;
  tasksCompleted: number;
}
export function completedTasks(activity: SessionActivity | undefined): number;
export function buildCatchUpBrief(args: {
  activity: SessionActivity | undefined;
  events: StudioEvent[];
  lastViewedMs: number | undefined;
  nowMs: number;
  seenEventCount: number | undefined;
  seenTasksDone: number | undefined;
}): CatchUpBrief | null;

// state/sessions.ts additions
lastViewedMs: Record<string, number>;
viewedEventCount: Record<string, number>;
viewedTasksDone: Record<string, number>;
catchUpBrief: Record<string, CatchUpBrief | null>;
dismissCatchUpBrief: (id: string) => void;
```

- [ ] **Step 1: Write the failing tests.** Create `src/studio/catchUpBrief.test.ts`:

```ts
import { expect, test } from "vitest";
import type { SessionActivity, StudioEvent } from "../types.ts";
import { AWAY_MS, buildCatchUpBrief, completedTasks } from "./catchUpBrief.ts";

const NOW = 10 * 60_000 + AWAY_MS;

const delta: StudioEvent[] = [
  { id: "1:0", kind: "prompt", text: "go" },
  { additions: 1, deletions: 0, file: "src/a.ts", hunk: "", id: "2:0", kind: "diff", lines: [] },
  { additions: 2, deletions: 1, file: "src/b.ts", hunk: "", id: "3:0", kind: "diff", lines: [] },
  { additions: 1, deletions: 1, file: "src/a.ts", hunk: "", id: "4:0", kind: "diff", lines: [] },
  { cmd: "pnpm test", exit: 0, id: "5:0", kind: "bash", output: [] },
  { id: "6:0", kind: "tool", meta: null, name: "Agent", target: null },
  { id: "7:0", kind: "assistant", text: "All green.\nDetails…" },
];

function args(overrides: Partial<Parameters<typeof buildCatchUpBrief>[0]> = {}) {
  return {
    activity: undefined,
    events: delta,
    lastViewedMs: 0,
    nowMs: NOW,
    seenEventCount: 0,
    seenTasksDone: 0,
    ...overrides,
  };
}

test("digest counts the delta since last viewed", () => {
  const brief = buildCatchUpBrief(args());
  expect(brief).toEqual({
    commandsRun: 1,
    filesEdited: ["src/a.ts", "src/b.ts"],
    filesEditedTotal: 2,
    lastAssistant: "All green.",
    subagentsRan: 1,
    tasksCompleted: 0,
  });
});

test("only events past the seen count are digested", () => {
  const brief = buildCatchUpBrief(args({ seenEventCount: 6 }));
  expect(brief?.filesEditedTotal).toBe(0);
  expect(brief?.lastAssistant).toBe("All green.");
});

test("no brief when away for less than the threshold", () => {
  expect(buildCatchUpBrief(args({ lastViewedMs: NOW - AWAY_MS + 1 }))).toBeNull();
});

test("no brief when never viewed before", () => {
  expect(buildCatchUpBrief(args({ lastViewedMs: undefined }))).toBeNull();
});

test("no brief when nothing happened since", () => {
  expect(buildCatchUpBrief(args({ seenEventCount: delta.length }))).toBeNull();
});

test("file names cap at three with the total preserved", () => {
  const many: StudioEvent[] = ["a", "b", "c", "d"].map((f, i) => ({
    additions: 1,
    deletions: 0,
    file: `src/${f}.ts`,
    hunk: "",
    id: `${i}:0`,
    kind: "diff",
    lines: [],
  }));
  const brief = buildCatchUpBrief(args({ events: many }));
  expect(brief?.filesEdited).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  expect(brief?.filesEditedTotal).toBe(4);
});

test("tasksCompleted is the completed-count delta", () => {
  const activity: SessionActivity = {
    main: { currentTool: null },
    pendingAsk: null,
    shells: [],
    subagents: [],
    tasks: [
      { activeForm: null, status: "completed", text: "one" },
      { activeForm: null, status: "completed", text: "two" },
      { activeForm: null, status: "in_progress", text: "three" },
    ],
  };
  expect(completedTasks(activity)).toBe(2);
  const brief = buildCatchUpBrief(args({ activity, seenTasksDone: 1 }));
  expect(brief?.tasksCompleted).toBe(1);
});
```

And append to `src/state/sessions.test.ts` (mirror its existing store-reset conventions):

```ts
test("switching sessions stamps the departing session and computes the arrival's brief", () => {
  const now = Date.now();
  useSessions.setState({
    activeSessionId: "s1",
    catchUpBrief: {},
    events: {
      s2: [{ id: "1:0", kind: "assistant", text: "Waiting on you." }],
    },
    lastViewedMs: { s2: now - 6 * 60_000 },
    viewedEventCount: { s2: 0 },
    viewedTasksDone: {},
  });
  useSessions.getState().setActiveSession("s2");
  const state = useSessions.getState();
  expect(state.lastViewedMs.s1).toBeGreaterThan(0);
  expect(state.catchUpBrief.s2?.lastAssistant).toBe("Waiting on you.");
  // The arrival is now considered viewed.
  expect(state.viewedEventCount.s2).toBe(1);
});

test("dismissCatchUpBrief clears the banner", () => {
  useSessions.setState({
    catchUpBrief: {
      s1: {
        commandsRun: 0,
        filesEdited: [],
        filesEditedTotal: 0,
        lastAssistant: null,
        subagentsRan: 0,
        tasksCompleted: 0,
      },
    },
  });
  useSessions.getState().dismissCatchUpBrief("s1");
  expect(useSessions.getState().catchUpBrief.s1).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/studio/catchUpBrief.test.ts src/state/sessions.test.ts`
Expected: FAIL — cannot resolve `./catchUpBrief.ts`; sessions tests fail on missing fields.

- [ ] **Step 3: Implement.**

(a) Create `src/studio/catchUpBrief.ts`:

```ts
import type { SessionActivity, StudioEvent } from "../types.ts";

/** Away threshold before a refocus earns a catch-up brief. */
export const AWAY_MS = 5 * 60_000;

/** Names shown before collapsing into the total. */
const MAX_FILE_NAMES = 3;

/** Cap for the last-assistant line. */
const LINE_MAX = 140;

/**
 * The deterministic digest of what a session did since the user last focused
 * it. Built purely from already-parsed Studio events plus the live task list —
 * zero tokens, zero latency, never wrong. See CONTEXT.md "Catch-up brief".
 */
export interface CatchUpBrief {
  commandsRun: number;
  filesEdited: string[];
  filesEditedTotal: number;
  lastAssistant: string | null;
  subagentsRan: number;
  tasksCompleted: number;
}

/** Completed entries in the session's current task list. */
export function completedTasks(activity: SessionActivity | undefined): number {
  return activity?.tasks.filter((t) => t.status === "completed").length ?? 0;
}

function firstLine(text: string): string | null {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  if (!line) {
    return null;
  }
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line;
}

/**
 * Digest the event delta since the user last looked, or `null` when no brief
 * is due: never viewed, away under {@link AWAY_MS}, or nothing happened since.
 */
export function buildCatchUpBrief(args: {
  activity: SessionActivity | undefined;
  events: StudioEvent[];
  lastViewedMs: number | undefined;
  nowMs: number;
  seenEventCount: number | undefined;
  seenTasksDone: number | undefined;
}): CatchUpBrief | null {
  if (
    args.lastViewedMs === undefined ||
    args.nowMs - args.lastViewedMs < AWAY_MS
  ) {
    return null;
  }
  const delta = args.events.slice(args.seenEventCount ?? 0);
  if (delta.length === 0) {
    return null;
  }
  const files: string[] = [];
  let commandsRun = 0;
  let subagentsRan = 0;
  let lastAssistant: string | null = null;
  for (const event of delta) {
    if (event.kind === "diff" && !files.includes(event.file)) {
      files.push(event.file);
    } else if (event.kind === "bash") {
      commandsRun += 1;
    } else if (
      event.kind === "tool" &&
      (event.name === "Agent" || event.name === "Task")
    ) {
      subagentsRan += 1;
    } else if (event.kind === "assistant") {
      lastAssistant = firstLine(event.text) ?? lastAssistant;
    }
  }
  return {
    commandsRun,
    filesEdited: files.slice(0, MAX_FILE_NAMES),
    filesEditedTotal: files.length,
    lastAssistant,
    subagentsRan,
    tasksCompleted: Math.max(
      0,
      completedTasks(args.activity) - (args.seenTasksDone ?? 0)
    ),
  };
}
```

(b) `src/state/sessions.ts`:
- Import: `import { buildCatchUpBrief, type CatchUpBrief, completedTasks } from "../studio/catchUpBrief.ts";`
- Add to `SessionsState` (alphabetical, matching the interface style):

```ts
/** Briefs computed at activation, keyed by session; null = dismissed/none. */
catchUpBrief: Record<string, CatchUpBrief | null>;
dismissCatchUpBrief: (id: string) => void;
/** When each session was last the active one (in-memory; resets on reload). */
lastViewedMs: Record<string, number>;
/** Studio-event count at last view — the brief digests everything past it. */
viewedEventCount: Record<string, number>;
/** Completed-task count at last view — drives the brief's tasksCompleted. */
viewedTasksDone: Record<string, number>;
```

- Initial state additions: `catchUpBrief: {}, lastViewedMs: {}, viewedEventCount: {}, viewedTasksDone: {},`
- Replace `setActiveSession`:

```ts
setActiveSession: (id) =>
  set((state) => {
    if (state.activeSessionId === id) {
      return state;
    }
    const now = Date.now();
    const lastViewedMs = { ...state.lastViewedMs };
    const viewedEventCount = { ...state.viewedEventCount };
    const viewedTasksDone = { ...state.viewedTasksDone };
    const prev = state.activeSessionId;
    if (prev) {
      lastViewedMs[prev] = now;
      viewedEventCount[prev] = state.events[prev]?.length ?? 0;
      viewedTasksDone[prev] = completedTasks(state.activity[prev]);
    }
    const brief = buildCatchUpBrief({
      activity: state.activity[id],
      events: state.events[id] ?? [],
      lastViewedMs: state.lastViewedMs[id],
      nowMs: now,
      seenEventCount: state.viewedEventCount[id],
      seenTasksDone: state.viewedTasksDone[id],
    });
    // The arrival is viewed as of now; the banner persists until dismissed
    // or replaced on the next qualifying refocus.
    lastViewedMs[id] = now;
    viewedEventCount[id] = state.events[id]?.length ?? 0;
    viewedTasksDone[id] = completedTasks(state.activity[id]);
    return {
      activeSessionId: id,
      catchUpBrief: { ...state.catchUpBrief, [id]: brief },
      lastViewedMs,
      viewedEventCount,
      viewedTasksDone,
    };
  }),

dismissCatchUpBrief: (id) =>
  set((state) => ({
    catchUpBrief: { ...state.catchUpBrief, [id]: null },
  })),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/studio/catchUpBrief.test.ts src/state/sessions.test.ts && pnpm typecheck`
Expected: PASS. (Any existing test that resets the store with `useSessions.setState({...})` and full-shape assertions may need the four new empty records added — fix those, nothing else.)

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/studio/catchUpBrief.ts src/studio/catchUpBrief.test.ts src/state/sessions.ts src/state/sessions.test.ts
git commit -m "feat(studio): deterministic catch-up brief computed on session activation"
```

---

### Task 8: Catch-up banner in the Studio view

**Files:**
- Create: `src/studio/blocks/CatchUpBanner.tsx`
- Modify: `src/studio/StudioView.tsx` (mount beside `<ResumeHint sessionId={sessionId} />`, ~line 144)
- Test: `src/studio/blocks/CatchUpBanner.test.tsx`

**Interfaces:**
- Consumes: `catchUpBrief`/`dismissCatchUpBrief` from `useSessions` (Task 7), `formatDuration` not needed here (the brief has no timestamp — the digest speaks for itself), `tokens`.
- Produces: `<CatchUpBanner sessionId={string} />`, testids `catch-up-banner` and `catch-up-dismiss`.

- [ ] **Step 1: Write the failing tests.** Create `src/studio/blocks/CatchUpBanner.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useSessions } from "../../state/sessions.ts";
import { CatchUpBanner } from "./CatchUpBanner.tsx";

beforeEach(() => {
  useSessions.setState({
    catchUpBrief: {
      s1: {
        commandsRun: 2,
        filesEdited: ["src/a.ts", "src/b.ts"],
        filesEditedTotal: 5,
        lastAssistant: "All green.",
        subagentsRan: 1,
        tasksCompleted: 3,
      },
    },
  });
});

test("renders the digest while a brief is set", () => {
  render(<CatchUpBanner sessionId="s1" />);
  const banner = screen.getByTestId("catch-up-banner");
  expect(banner.textContent).toContain("While you were away");
  expect(banner.textContent).toContain("5 files");
  expect(banner.textContent).toContain("src/a.ts");
  expect(banner.textContent).toContain("2 commands");
  expect(banner.textContent).toContain("1 agent");
  expect(banner.textContent).toContain("3 tasks done");
  expect(banner.textContent).toContain("All green.");
});

test("renders nothing without a brief", () => {
  render(<CatchUpBanner sessionId="s2" />);
  expect(screen.queryByTestId("catch-up-banner")).toBeNull();
});

test("dismiss clears the brief", () => {
  render(<CatchUpBanner sessionId="s1" />);
  fireEvent.click(screen.getByTestId("catch-up-dismiss"));
  expect(screen.queryByTestId("catch-up-banner")).toBeNull();
  expect(useSessions.getState().catchUpBrief.s1).toBeNull();
});

test("singular counts read naturally", () => {
  useSessions.setState({
    catchUpBrief: {
      s1: {
        commandsRun: 1,
        filesEdited: ["src/a.ts"],
        filesEditedTotal: 1,
        lastAssistant: null,
        subagentsRan: 0,
        tasksCompleted: 0,
      },
    },
  });
  render(<CatchUpBanner sessionId="s1" />);
  const text = screen.getByTestId("catch-up-banner").textContent ?? "";
  expect(text).toContain("1 file");
  expect(text).toContain("1 command");
  expect(text).not.toContain("agent");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/studio/blocks/CatchUpBanner.test.tsx`
Expected: FAIL — cannot resolve `./CatchUpBanner.tsx`.

- [ ] **Step 3: Implement.** Create `src/studio/blocks/CatchUpBanner.tsx` (match `ResumeHint.tsx`'s visual pattern — read it first and reuse its container styling approach):

```tsx
import type { CSSProperties } from "react";
import { useSessions } from "../../state/sessions.ts";
import { tokens } from "../../theme/tokens.ts";

const containerStyle: CSSProperties = {
  alignItems: "flex-start",
  background: tokens.color.surface.s1,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.secondary,
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  gap: tokens.space.sm,
  justifyContent: "space-between",
  margin: `${tokens.space.sm} ${tokens.space.lg}`,
  padding: `${tokens.space.sm} ${tokens.space.md}`,
};

const labelStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
};

const dismissStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: tokens.color.ink.faint,
  cursor: "pointer",
  flex: "none",
  fontSize: "12px",
  padding: 0,
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The digest sentence: only the parts that happened, joined with " · ". */
function digestLine(brief: {
  commandsRun: number;
  filesEdited: string[];
  filesEditedTotal: number;
  subagentsRan: number;
  tasksCompleted: number;
}): string {
  const parts: string[] = [];
  if (brief.filesEditedTotal > 0) {
    const names = brief.filesEdited.join(", ");
    parts.push(`${plural(brief.filesEditedTotal, "file")} edited (${names}${brief.filesEditedTotal > brief.filesEdited.length ? ", …" : ""})`);
  }
  if (brief.commandsRun > 0) {
    parts.push(plural(brief.commandsRun, "command"));
  }
  if (brief.subagentsRan > 0) {
    parts.push(plural(brief.subagentsRan, "agent"));
  }
  if (brief.tasksCompleted > 0) {
    parts.push(`${plural(brief.tasksCompleted, "task")} done`);
  }
  return parts.join(" · ");
}

/**
 * The catch-up brief banner: what this session did while the user was away.
 * Deterministic, dismissible, computed once at activation (see
 * `setActiveSession`). Sits atop the Studio view like the resume hint.
 */
export function CatchUpBanner({ sessionId }: { sessionId: string }) {
  const brief = useSessions((state) => state.catchUpBrief[sessionId]);
  const dismiss = useSessions((state) => state.dismissCatchUpBrief);
  if (!brief) {
    return null;
  }
  const digest = digestLine(brief);
  return (
    <div data-testid="catch-up-banner" style={containerStyle}>
      <span style={{ minWidth: 0 }}>
        <span style={{ ...labelStyle, display: "block" }}>
          While you were away
        </span>
        {digest ? <span style={{ display: "block" }}>{digest}</span> : null}
        {brief.lastAssistant ? (
          <span style={{ color: tokens.color.ink.dim, display: "block" }}>
            {brief.lastAssistant}
          </span>
        ) : null}
      </span>
      <button
        data-testid="catch-up-dismiss"
        onClick={() => dismiss(sessionId)}
        style={dismissStyle}
        type="button"
      >
        Dismiss
      </button>
    </div>
  );
}
```

Then in `src/studio/StudioView.tsx`, import and render it directly above the resume hint (~line 144):

```tsx
import { CatchUpBanner } from "./blocks/CatchUpBanner.tsx";
// …
<CatchUpBanner sessionId={sessionId} />
<ResumeHint sessionId={sessionId} />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/studio && pnpm typecheck`
Expected: PASS (new banner tests + existing Studio tests).

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/studio/blocks/CatchUpBanner.tsx src/studio/blocks/CatchUpBanner.test.tsx src/studio/StudioView.tsx
git commit -m "feat(studio): catch-up banner shows the away digest on refocus"
```

---

### Task 9: Vocabulary, spec status, full green

**Files:**
- Modify: `CONTEXT.md` (three new terms; amend "Session activity")
- Modify: `docs/superpowers/specs/2026-07-02-actionable-needs-you-design.md` (Status → Accepted)

- [ ] **Step 1: Add the glossary terms.** In `CONTEXT.md`, insert after the "Needs-you rail" entry:

```markdown
- **Pending ask** (`PendingAsk`) — the concrete thing a `waiting` [Session] wants from the
  user: a `question` (from `AskUserQuestion`), a `permission` (from a permission prompt), or a
  `plan_approval` (from `ExitPlanMode`), with `askedAt` and one line of text. Reconstructed
  live from hook events by `AskState`; cleared at every turn boundary (the settle guarantee).
  Rides the [Session activity] snapshot. The frontend adds a `best_effort` snippet tier (last
  assistant text) for waiting sessions with no exact ask — shown honestly, never as exact.
  _Avoid_: request, prompt (ambiguous with the user's prompt).
- **Catch-up brief** (`CatchUpBrief`) — a deterministic digest of what a [Session] did since
  the user last focused it: files edited, commands run, [Task]s completed, [Subagent]s run,
  and the last assistant line. Computed at activation from already-parsed [Studio event]s
  (zero tokens); shown as a dismissible banner atop the [Studio view] after ≥5 min away.
  _Avoid_: recap, summary (ambiguous with Claude's own summaries).
- **Needs-you overlay** — the ⌘⇧K-summonable panel rendering the same enriched list as the
  [Needs-you rail], from any view. ↑↓ selects, Enter focuses the session (routing to the
  [Raw view] when the [Pending ask] is exact), Esc closes. _Avoid_: inbox, notification center.
```

And amend the "Session activity" entry's first sentence to include the ask, e.g. append: `Also carries the session's open [Pending ask].`

- [ ] **Step 2: Flip the spec status** from `Draft (awaiting review)` to `Accepted`.

- [ ] **Step 3: Full check**

Run: `pnpm check`
Expected: lint, typecheck, vitest, rustfmt, clippy, cargo test — all green. Fix anything red before committing.

- [ ] **Step 4: Commit**

```bash
git add CONTEXT.md docs/superpowers/specs/2026-07-02-actionable-needs-you-design.md
git commit -m "docs(context): pending ask, catch-up brief, needs-you overlay vocabulary"
```

- [ ] **Step 5 (manual QA, optional but recommended):** With `pnpm dev` + the `window.__kriyon` QA seam (see `src/dev/`), seed two waiting sessions — one with `pendingAsk` set via `useSessions.getState().applyActivity(...)` plus a heartbeat via `useCommandCenter` — and verify: rail shows ask text + blocked duration; ⌘⇧K opens the overlay from the Studio view; Enter routes to the Raw view; a seeded `catchUpBrief` renders and dismisses.

---

## Plan self-review (done at authoring time)

- **Spec coverage:** §4.1 lifecycle → Tasks 1–3; §4.2 brief → Tasks 7–8; §4.3 surfaces → Tasks 5–6; §4.4 degradation → Task 2 (malformed → generic text; non-permission Notification → no exact ask, snippet fallback in Task 4) and Task 4 (`unknown` standings never reach the rail since `needsYou()` filters to `awaiting_input`); §3 vocabulary → Task 9. One deliberate deviation from the spec's wording: an unparseable AskUserQuestion payload degrades to a *generic-text exact ask* ("Has a question for you") rather than snippet tier — the type is still certain knowledge, only the text is lost; this is more honest than discarding the kind.
- **Types:** `PendingAsk { kind, text, askedAt }` consistent across Rust (`asked_at`, serde camelCase) and TS; `EntryAsk` tier union only in the frontend; `SessionActivity.pendingAsk` mirrored both sides.
- **Placeholders:** none; every step carries runnable code or an exact command.
