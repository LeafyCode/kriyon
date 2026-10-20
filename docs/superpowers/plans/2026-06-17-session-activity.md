# Session Activity — Subagents, Background shells, Tasks

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (or `superpowers:executing-plans`) to implement task-by-task. Steps use `- [ ]` checkboxes. **TDD is mandatory** (`skill: superpowers:test-driven-development`): write the failing test, watch it fail, then implement. Keep `pnpm check` green before every commit. Work on **`dev`** only.

**Goal:** Surface a Session's live activity — running **Subagents**, **Background shells**, and the current **Task** list — as three read-only Inspector panels, plus a count badge on the sidebar session row. All derived by replaying the transcript; nothing drives Claude.

**Read first:** `CONTEXT.md` (Subagent / Background shell / Task / Session activity), `docs/adr/0002-best-effort-background-shell-status.md`, `docs/adr/0003-ephemeral-session-activity-projection.md`.

**Decisions already locked (see ADRs + glossary):**
- **Per-session, in the Inspector** (alongside Changes/Usage/Session), not the left sidebar. Sidebar row gets a small **badge = running subagents + best-effort-live shells** (hidden when zero).
- **Core projector → snapshot.** A stateful `ActivityProjector` in `kriyon-core` ingests **raw** transcript lines and emits a `SessionActivity` snapshot. Pushed to the frontend like the existing usage snapshot; keyed by `SessionId` in the store. Frontend only renders.
- **Ephemeral.** Rebuilt by replay (the `Tailer` reads from offset 0). Never persisted to SQLite.
- **Subagent depth = parent correlation only.** Agent `tool_use` → matching `tool_result` in the *parent* transcript gives type/description, running→done, duration, final result. No child-`.jsonl` tailing in v1.
- **Background status = best-effort + honest "last polled" label.** No completion signal exists upstream (ADR 0002).
- **Read-only + click-to-reveal.** Click a finished subagent to expand its result; click a shell to show last-polled output. No kill/stop/mutate.

**Standing rule:** verify library APIs against current docs via **context7** before coding (Tauri events/channels, xterm, rusqlite not needed here, Biome/Ultracite). Versions track the v1 plan.

---

## Domain model (target types)

`crates/kriyon-core/src/activity.rs` (new):

```rust
pub struct SessionActivity {
    pub subagents: Vec<Subagent>,
    pub shells: Vec<BackgroundShell>,
    pub tasks: Vec<Task>,
}

pub struct Subagent {
    pub tool_use_id: String,      // correlation key
    pub kind: String,             // subagent_type, e.g. "Explore"
    pub description: Option<String>,
    pub state: SubagentState,     // Running | Done
    pub started_at: Option<String>, // transcript timestamp
    pub ended_at: Option<String>,
    pub result: Option<String>,   // from the matching tool_result
}
pub enum SubagentState { Running, Done }

pub struct BackgroundShell {
    pub bash_id: String,
    pub cmd: String,
    pub status: ShellStatus,      // Running | Exited(i32) | Killed | Unknown
    pub last_polled_at: Option<String>, // ts of the BashOutput/KillShell that set status
}
pub enum ShellStatus { Running, Exited(i32), Killed, Unknown }

pub struct Task {                 // unifies TodoWrite + TaskCreate/Update
    pub text: String,
    pub status: TaskStatus,       // Pending | InProgress | Completed
    pub active_form: Option<String>,
}
pub enum TaskStatus { Pending, InProgress, Completed }
```

The badge count is derived: `subagents.filter(Running).count() + shells.filter(Running).count()`.

---

## Phase 1 — `ActivityProjector` in `kriyon-core` (pure, TDD)

The heart of the feature. No Tauri, no IPC — just `raw line → snapshot`. Write fixtures from real transcript shapes (see the research notes / a captured `~/.claude/projects/.../<id>.jsonl`).

- [ ] **1.1** Add `activity.rs` with the types above; re-export from `lib.rs`. Derive `Clone, Debug, PartialEq, Serialize, Deserialize`; `#[serde(rename_all = "camelCase")]` to match the existing IPC convention (`StructuredEvent::Usage` uses camelCase). Add the tagged-enum serde the frontend will switch on.
- [ ] **1.2** `ActivityProjector::new()` + `ingest(&mut self, raw_line: &str) -> bool` (returns `true` when the snapshot changed) + `snapshot(&self) -> SessionActivity`. Tolerant like `parse_line`: malformed JSON / unknown lines are ignored, never panic.
- [ ] **1.3 Subagents.** Test-first: an assistant `tool_use` with `name` in {`"Task"`,`"Agent"`} → `Subagent{Running}` keyed by `tool_use.id`, `kind` from `input.subagent_type`/`input.type`, `description` from `input.description`. A later user `tool_result` with matching `tool_use_id` → flip to `Done`, capture `result` (text content) and `ended_at`. Cover: out-of-order lines, missing fields, two concurrent agents, an agent that never completes (stays Running).
- [ ] **1.4 Background shells.** Test-first: a `Bash` `tool_use` with `input.run_in_background == true` → record on the `bash_id` parsed from its `tool_result` ("…ID: <bash_id>"); `cmd` from `input.command`. A later `BashOutput` `tool_use(bash_id)` whose result carries an exit code → `Exited(n)` + `last_polled_at`; a `KillShell`/`TaskStop(bash_id)` → `Killed`. No signal → stays `Running`. Cover: launch with no later poll, poll with no exit yet (`Running`, bump `last_polled_at`), unknown bash_id.
- [ ] **1.5 Tasks.** Test-first: a `TodoWrite` `tool_use` **replaces** the whole list from `input.todos[] {content,status,activeForm}`. `TaskCreate`/`TaskUpdate`/`TaskDelete` **mutate** a keyed map (id from the create's `tool_result`). Latest write wins. Map `pending|in_progress|completed` → `TaskStatus`. Cover: TodoWrite then a second TodoWrite (full replace), interleaved TaskUpdate, a session using only one family.
- [ ] **1.6 Full-replay test.** Feed a whole multi-turn fixture transcript line-by-line; assert the final snapshot (agents done, one shell still Running, current task list). This is the “rebuilt on attach” guarantee from ADR 0003.

**Commit:** `feat(core): ActivityProjector reconstructs session activity from transcript`

## Phase 2 — Watcher wiring + IPC

Emit the snapshot like usage. Reuse the existing `session-usage` pattern (`watcher.rs` / `commands.rs:222`).

- [ ] **2.1** In `PumpState` add an `ActivityProjector` and `last_activity: Option<String>` (serialized snapshot, to suppress duplicate emits — mirror `last_usage`).
- [ ] **2.2** In `pump()`, when draining the **transcript** tailer, feed each **raw line** to the projector (use `poll_lines()` for the projector in addition to the existing `poll()` for `StructuredEvent`s — or refactor to one `poll_lines()` pass that fans out to both). When `ingest` reports a change, emit a `session-activity` Tauri event `{ sessionId, snapshot: SessionActivity }`.
- [ ] **2.3** Add a debounce/coalesce so a burst of lines emits at most one snapshot per pump tick (it already polls on FS events; one emit per pump is enough).
- [ ] **2.4** Rust tests for the pump path: a fixture transcript drives N `session-activity` emits with the expected final snapshot; no emit when nothing changed.

**Commit:** `feat(watcher): emit session-activity snapshots`

## Phase 3 — Frontend store + IPC bridge

- [ ] **3.1** `src/types.ts`: add `SessionActivity`, `Subagent`, `BackgroundShell`, `Task` (+ enums) mirroring the Rust serde shapes exactly.
- [ ] **3.2** `src/ipc/bridge.ts`: add `onSessionActivity(cb)` (mirror `onSessionUsage`), returning an unlisten fn.
- [ ] **3.3** `src/state/sessions.ts`: add `activity: Record<string, SessionActivity>` + `applyActivity(id, snapshot)`. Add a selector `selectBadgeCount(id)` = running subagents + running shells.
- [ ] **3.4** `src/state/activityListener.ts`: `installActivityListener()` mirroring `installUsageListener`; wire it where the others are installed.
- [ ] **3.5** Vitest: store reducer + badge selector unit tests (snapshot in → state out → badge count).

**Commit:** `feat(state): session-activity store slice + listener`

## Phase 4 — Inspector panels (read-only + click-to-reveal)

Design values from `src/theme/tokens.ts` only — no hardcoded colors/spacing. Match the existing Inspector section pattern.

- [ ] **4.1** `src/inspector/activity/AgentsPanel.tsx` — header `Agents (N running, M done)`; rows with status glyph, `kind`, description, duration; finished rows expand `result` inline on click. Empty state when none.
- [ ] **4.2** `src/inspector/activity/BackgroundPanel.tsx` — header `Background (N)`; rows with `cmd`, status + **honest "· last polled Xm ago"** label (relative time); click reveals last-polled output. Empty state.
- [ ] **4.3** `src/inspector/activity/TasksPanel.tsx` — header `Tasks (done/total)`; checklist with pending/in-progress/completed glyphs; in-progress row shows `active_form` if present. Empty state.
- [ ] **4.4** Mount the three as collapsible sections in `Inspector.tsx`, subscribed to `activity[activeSessionId]`. Collapse persists in `layout` like other inspector state if that pattern exists.
- [ ] **4.5** Vitest + React Testing Library: render each panel from a fixture snapshot; assert running/done rendering, click-to-reveal, empty states, and the relative-time label.

**Commit:** `feat(inspector): agents, background, and tasks panels`

## Phase 5 — Sidebar badge

- [ ] **5.1** In `Sidebar.tsx` session row, render the badge from `selectBadgeCount(session.id)`; hide when zero. Token/spacing from tokens.
- [ ] **5.2** Project-level rollup: if any session in a project has a badge, keep the existing attention indicator behavior consistent (don't double-signal).
- [ ] **5.3** Vitest: badge shows/hides correctly; reflects live snapshot updates.

**Commit:** `feat(sidebar): live activity badge on session rows`

## Phase 6 — Verify end-to-end

- [ ] **6.1** `pnpm check` green (types, lint, Rust fmt/clippy, all tests).
- [ ] **6.2** Manual: run a real session that (a) spawns 2 subagents, (b) launches a background shell and polls it, (c) writes a todo list. Confirm panels + badge update live, finished agents reveal results, shell shows honest staleness, and a fresh app launch **replays** the same state.
- [ ] **6.3** Tolerance check: point at an old/partial transcript and a session mid-stream — projector must never hard-error; unknown lines ignored.

**Commit:** `feat(session): live session activity (subagents, background, tasks)` (or merge per phase)

---

## Notes / edge cases for the implementer

- **Tool-name drift:** Claude renamed the subagent tool `Task` → `Agent`, and renamed the todo tool `TodoWrite` → `TaskCreate`/`TaskUpdate`. The projector keys off tool **name strings** and must handle both vocabularies — the legacy `Task` *tool* maps to **Subagent**, the new `Task*` tools map to **Task**. Don't let the naming collision leak into the types (glossary `Task` = checklist item only).
- **Done subagents accumulate:** replay surfaces every finished agent. Show running first; consider capping/collapsing the done list if it grows long (UI detail, not core).
- **`result` size:** a subagent result can be large — store it in the snapshot but render truncated with click-to-expand.
- **Don't touch the Studio path:** `parse_line` and the `StructuredEvent` stream stay exactly as they are; the projector is an additive second consumer of the same tail (ADR 0003).
