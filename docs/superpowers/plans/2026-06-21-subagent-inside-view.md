# Subagent Inside-View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user has asked that implementation use subagents.

**Goal:** Clicking a subagent row in the Inspector expands to a compact, in-place Studio view of that subagent's own conversation (task → reasoning → tools → result), loaded on demand and exactly correlated.

**Architecture:** Each subagent writes its own transcript at `…/projects/<cwd>/<main-session>/subagents/agent-<agentId>.jsonl`, with a `agent-<agentId>.meta.json` sidecar giving the exact `toolUseId → agentId` link. We derive these paths (pure core helpers), set each `Subagent.agentId` exactly from the meta sidecar in the watcher, add a lazy Tauri command that parses one subagent transcript into `StudioEvent`s with the existing parser, and render it on the frontend by reusing the Studio block components.

**Tech Stack:** Rust (`kriyon-core` pure logic + `src-tauri` shell), React + TypeScript + Zustand, Vitest, `cargo test`. Reuses `kriyon_core::transcript::parse_studio_events` and `src/studio/blocks/*`.

## Global Constraints

- `pnpm check` green before every commit (lint=ultracite, typecheck=tsc, vitest, rustfmt, clippy `-D warnings`, cargo test). Run `cargo fmt` before committing Rust.
- Conventional commits; never `--no-verify`; stay on branch `feat/session-activity` (do NOT branch).
- clippy `-D warnings`: prefer `try_from` over `as`; no `.unwrap()`/`.expect()` in command handlers.
- Formatting/JS-TS lint owned by Biome+Ultracite — run `pnpm fix`, never hand-format.
- Rust core owns IO; frontend is a thin UI via `src/ipc/bridge.ts`; design values only from `src/theme/tokens.ts`.
- **Trust boundary:** every value crossing Rust↔JS is validated. `agent_id` is validated with `is_valid_agent_id` before any path construction; `session_id` is the trusted AppState key.
- Tolerant everywhere: malformed/missing files change nothing and never panic.
- A term must exist in `CONTEXT.md` before it is a module/type name (Task 1 adds them).
- Rust structs serialize `rename_all = "camelCase"`; TS types mirror exactly.

## File Structure

- Modify: `crates/kriyon-core/src/daemon.rs` (`is_valid_agent_id`).
- Modify: `crates/kriyon-core/src/transcript.rs` (`SubagentMeta`, `parse_subagent_meta`, the three path helpers) — or a new small module `subagent.rs`; this plan uses `transcript.rs` to keep transcript-shaped helpers together.
- Modify: `CONTEXT.md` (new terms).
- Modify: `src-tauri/src/watcher.rs` (`ActivitySource`: derive subagents dir from `transcript_path`, set `Subagent.agentId` from meta; add `on_transcript_path` callback to `spawn_session_watch`/`pump` + `TranscriptSource::take_transcript_path`).
- Modify: `src-tauri/src/lib.rs` (`AppState.transcript_paths`; register `read_subagent_view`).
- Modify: `src-tauri/src/commands.rs` (`read_subagent_view`; wire `on_transcript_path`).
- Modify: `src/ipc/bridge.ts` (`readSubagentView`).
- Create: `src/studio/StudioEventList.tsx` + `StudioEventList.test.tsx`; modify `src/studio/StudioView.tsx` to use it.
- Modify: `src/inspector/activity/AgentsPanel.tsx` + `AgentsPanel.test.tsx` (deep expand).

---

## Task 1: Core path helpers, agent-id validation, meta parsing

**Files:**
- Modify: `crates/kriyon-core/src/daemon.rs` (+ tests)
- Modify: `crates/kriyon-core/src/transcript.rs` (+ tests)
- Modify: `CONTEXT.md`

**Interfaces:**
- Produces:
  - `kriyon_core::daemon::is_valid_agent_id(id: &str) -> bool` — non-empty, ASCII hex only.
  - `kriyon_core::transcript::SubagentMeta { agent_type: Option<String>, description: Option<String>, tool_use_id: Option<String> }` (serde camelCase, `Deserialize`).
  - `kriyon_core::transcript::parse_subagent_meta(json: &str) -> Option<SubagentMeta>`.
  - `kriyon_core::transcript::subagents_dir(main_transcript: &std::path::Path) -> Option<std::path::PathBuf>`
  - `subagent_transcript_path(main_transcript: &Path, agent_id: &str) -> Option<PathBuf>`
  - `subagent_meta_path(main_transcript: &Path, agent_id: &str) -> Option<PathBuf>`

- [ ] **Step 1: Add CONTEXT.md terms**

Under the Session-activity cluster in `CONTEXT.md` (after the **Settle** entry), add:

```markdown
- **Subagent transcript** — a [Subagent]'s own conversation file, written by Claude Code at
  `~/.claude/projects/<encoded-cwd>/<main-session-id>/subagents/agent-<agentId>.jsonl` (separate from
  the main [Transcript]). Holds the subagent's task, reasoning, tool calls, and result. Parsed with the
  same tolerant transcript parser as the main view.
- **Subagent meta** (`SubagentMeta`) — the `agent-<agentId>.meta.json` sidecar beside a [Subagent
  transcript], carrying `{agentType, description, toolUseId}`. Its `toolUseId` is the authoritative link
  from a [Subagent] panel row (keyed by the Agent tool's `tool_use_id`) to its `agentId`, replacing the
  type+order heuristic. _Avoid_: agent manifest.
- **Subagent inside-view** — the in-place [Studio view] of a [Subagent transcript], shown when a
  subagent row in the Inspector is expanded. Loaded on demand via `read_subagent_view`.
- **Studio event list** (`StudioEventList`) — the store-free React component that renders a
  `StudioEvent[]` using the [Studio view] block components, shared by the main view and the
  [Subagent inside-view].
```

- [ ] **Step 2: Write the failing tests for `is_valid_agent_id`**

In `crates/kriyon-core/src/daemon.rs` `tests` module, add:

```rust
    #[test]
    fn agent_id_accepts_hex_rejects_path_chars() {
        assert!(is_valid_agent_id("a2a3ea07f2c60e4b7"));
        assert!(!is_valid_agent_id(""));
        assert!(!is_valid_agent_id("../etc"));
        assert!(!is_valid_agent_id("a2a3/b"));
        assert!(!is_valid_agent_id("xyz")); // non-hex letters
        assert!(!is_valid_agent_id("a2a3.07")); // dot
    }
```

- [ ] **Step 3: Run it, watch it fail**

Run: `cargo test -p kriyon-core agent_id_accepts_hex_rejects_path_chars`
Expected: FAIL — `is_valid_agent_id` not found.

- [ ] **Step 4: Implement `is_valid_agent_id`**

In `crates/kriyon-core/src/daemon.rs`, next to `is_valid_session_id`:

```rust
/// Whether `id` is a safe subagent id to interpolate into a filesystem path:
/// non-empty and ASCII-hex only (Claude Code's `agent-<id>` ids are hex). Stricter
/// than [`is_valid_session_id`]; gates `agent-<id>.jsonl`/`.meta.json` paths.
#[must_use]
pub fn is_valid_agent_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_hexdigit())
}
```

- [ ] **Step 5: Run it, watch it pass**

Run: `cargo test -p kriyon-core agent_id_accepts_hex_rejects_path_chars`
Expected: PASS.

- [ ] **Step 6: Write failing tests for meta parsing + path derivation**

In `crates/kriyon-core/src/transcript.rs` `tests` module, add:

```rust
    #[test]
    fn parses_subagent_meta_and_tolerates_garbage() {
        let m = parse_subagent_meta(
            r#"{"agentType":"Explore","description":"Map dirs","toolUseId":"toolu_01"}"#,
        )
        .expect("parses");
        assert_eq!(m.agent_type.as_deref(), Some("Explore"));
        assert_eq!(m.description.as_deref(), Some("Map dirs"));
        assert_eq!(m.tool_use_id.as_deref(), Some("toolu_01"));
        assert!(parse_subagent_meta("not json").is_none());
    }

    #[test]
    fn derives_subagent_paths_from_main_transcript() {
        let main = std::path::Path::new("/p/-Users-x-proj/abc-123.jsonl");
        assert_eq!(
            subagents_dir(main).unwrap(),
            std::path::Path::new("/p/-Users-x-proj/abc-123/subagents")
        );
        assert_eq!(
            subagent_transcript_path(main, "a1b2").unwrap(),
            std::path::Path::new("/p/-Users-x-proj/abc-123/subagents/agent-a1b2.jsonl")
        );
        assert_eq!(
            subagent_meta_path(main, "a1b2").unwrap(),
            std::path::Path::new("/p/-Users-x-proj/abc-123/subagents/agent-a1b2.meta.json")
        );
        // A path with no parent yields None (tolerant).
        assert!(subagents_dir(std::path::Path::new("abc.jsonl")).is_some());
        assert!(subagents_dir(std::path::Path::new("/")).is_none());
    }
```

- [ ] **Step 7: Run them, watch them fail**

Run: `cargo test -p kriyon-core derives_subagent_paths_from_main_transcript`
Expected: FAIL — items not found.

- [ ] **Step 8: Implement meta + path helpers**

In `crates/kriyon-core/src/transcript.rs` (near the top-level `pub fn`s; add `use std::path::{Path, PathBuf};` if not present):

```rust
/// The `agent-<id>.meta.json` sidecar beside a subagent transcript. Its
/// `tool_use_id` authoritatively links a subagent panel row (keyed by the Agent
/// tool's `tool_use_id`) to the subagent's `agent_id`. See `CONTEXT.md`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMeta {
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
}

/// Parse a `agent-<id>.meta.json` body. `None` on malformed input (tolerant).
#[must_use]
pub fn parse_subagent_meta(json: &str) -> Option<SubagentMeta> {
    serde_json::from_str::<SubagentMeta>(json.trim()).ok()
}

/// The `subagents/` dir beside a main transcript: `<dir>/<stem>/subagents`.
/// `None` if `main_transcript` has no file stem.
#[must_use]
pub fn subagents_dir(main_transcript: &Path) -> Option<PathBuf> {
    let stem = main_transcript.file_stem()?;
    let parent = main_transcript.parent().unwrap_or_else(|| Path::new(""));
    Some(parent.join(stem).join("subagents"))
}

/// Path to a subagent's transcript: `…/subagents/agent-<agent_id>.jsonl`.
#[must_use]
pub fn subagent_transcript_path(main_transcript: &Path, agent_id: &str) -> Option<PathBuf> {
    Some(subagents_dir(main_transcript)?.join(format!("agent-{agent_id}.jsonl")))
}

/// Path to a subagent's meta sidecar: `…/subagents/agent-<agent_id>.meta.json`.
#[must_use]
pub fn subagent_meta_path(main_transcript: &Path, agent_id: &str) -> Option<PathBuf> {
    Some(subagents_dir(main_transcript)?.join(format!("agent-{agent_id}.meta.json")))
}
```

Note: `subagents_dir(Path::new("/"))` → `file_stem()` is `None` → `None`, satisfying the test.

- [ ] **Step 9: Run all the new core tests**

Run: `cargo test -p kriyon-core parses_subagent_meta_and_tolerates_garbage derives_subagent_paths_from_main_transcript agent_id_accepts_hex_rejects_path_chars`
Expected: PASS.

- [ ] **Step 10: Gate + commit**

Run: `cargo fmt && pnpm check`
Expected: GREEN.

```bash
git add CONTEXT.md crates/kriyon-core/src/daemon.rs crates/kriyon-core/src/transcript.rs docs/superpowers/specs/2026-06-21-subagent-inside-view-design.md docs/superpowers/plans/2026-06-21-subagent-inside-view.md
git commit -m "feat(core): subagent transcript paths, meta, and id validation"
```

---

## Task 2: Exact `Subagent.agentId` from the meta sidecar (watcher)

**Files:**
- Modify: `src-tauri/src/watcher.rs` (`ActivitySource` + tests)

**Interfaces:**
- Consumes: `subagents_dir`, `subagent` path helpers, `parse_subagent_meta` (Task 1).
- Produces: each emitted `Subagent.agentId` is set exactly from `agent-*.meta.json` (matched by `tool_use_id`), when the sidecar exists. The internal-tool-event binding remains a fallback.

- [ ] **Step 1: Write a failing watcher test**

In `src-tauri/src/watcher.rs` `tests` module, add (it constructs a meta sidecar on disk and asserts the snapshot's `agentId` is set exactly — including two parallel same-type subagents):

```rust
    #[test]
    fn activity_source_sets_agent_id_from_meta_sidecar() {
        use kriyon_core::activity::SubagentState;
        let root = tempfile::tempdir().expect("tempdir");
        // Main transcript at <root>/proj/main-1.jsonl → subagents at <...>/main-1/subagents.
        let proj = root.path().join("proj");
        let sub_dir = proj.join("main-1").join("subagents");
        fs::create_dir_all(&sub_dir).expect("mkdir subagents");
        fs::write(
            sub_dir.join("agent-aaa1.meta.json"),
            r#"{"agentType":"Explore","description":"first","toolUseId":"t1"}"#,
        )
        .expect("meta1");
        fs::write(
            sub_dir.join("agent-bbb2.meta.json"),
            r#"{"agentType":"Explore","description":"second","toolUseId":"t2"}"#,
        )
        .expect("meta2");

        let mut src = ActivitySource::new(root.path().join("tasks"));
        let main_transcript = proj.join("main-1.jsonl");
        // Two parallel same-type Agent spawns; each event carries the main transcript path.
        for (tuid, sub) in [("t1", "Explore"), ("t2", "Explore")] {
            src.observe_hook(&HookEvent {
                session_id: Some("claude-1".to_string()),
                transcript_path: Some(main_transcript.display().to_string()),
                tool_name: Some("Agent".to_string()),
                tool_use_id: Some(tuid.to_string()),
                subagent_type: Some(sub.to_string()),
                ..hook("PreToolUse")
            });
        }
        let snap = src.snapshot().expect("snapshot");
        let by_tuid = |t: &str| {
            snap.subagents
                .iter()
                .find(|s| s.tool_use_id == t)
                .and_then(|s| s.agent_id.clone())
        };
        assert_eq!(by_tuid("t1").as_deref(), Some("aaa1"), "exact correlation");
        assert_eq!(by_tuid("t2").as_deref(), Some("bbb2"), "no same-type swap");
        assert_eq!(snap.subagents[0].state, SubagentState::Running);
    }
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cargo test -p kriyon-app activity_source_sets_agent_id_from_meta_sidecar` (if `-p kriyon-app` errors, run `cargo test activity_source_sets_agent_id_from_meta_sidecar`)
Expected: FAIL — `agentId` is `None` (meta not consulted).

- [ ] **Step 3: Teach `ActivitySource` the subagents dir + meta overlay**

In `src-tauri/src/watcher.rs`, add to the `ActivitySource` struct a field for the subagents dir, bound lazily:

```rust
    /// `<main-transcript-dir>/<main-stem>/subagents`, bound lazily from the first
    /// hook event carrying a non-empty `transcript_path`. Source of the exact
    /// `tool_use_id → agent_id` overlay (the meta sidecars).
    subagents_dir: Option<PathBuf>,
```

Initialize it `None` in `ActivitySource::new`.

In `ActivitySource::observe_hook`, after the existing `tasks_dir` binding block, bind the subagents dir:

```rust
        if self.subagents_dir.is_none() {
            if let Some(tp) = event.transcript_path.as_deref() {
                if !tp.is_empty() {
                    self.subagents_dir =
                        kriyon_core::transcript::subagents_dir(Path::new(tp));
                }
            }
        }
```

In `ActivitySource::snapshot`, after building `subagents: self.activity.subagents()`, overlay exact agent ids from the meta sidecars before serializing. Replace the snapshot construction with:

```rust
        let mut subagents = self.activity.subagents();
        if let Some(dir) = self.subagents_dir.as_deref() {
            apply_meta_agent_ids(dir, &mut subagents);
        }
        let snapshot = SessionActivity {
            main: self.activity.main(),
            subagents,
            shells: self.activity.shells(),
            tasks: self.tasks_dir.as_deref().map_or_else(Vec::new, read_tasks),
        };
```

Add the free function near `read_tasks`:

```rust
/// Overlay each subagent's exact `agent_id` from its `agent-*.meta.json` sidecar
/// (matched by `tool_use_id`). Missing dir/files leave the heuristic value in
/// place. Tolerant: unreadable/malformed sidecars are skipped.
fn apply_meta_agent_ids(dir: &Path, subagents: &mut [kriyon_core::activity::Subagent]) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut by_tool_use: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for path in entries.flatten().map(|e| e.path()) {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        // agent-<id>.meta.json
        let Some(id) = name
            .strip_prefix("agent-")
            .and_then(|s| s.strip_suffix(".meta.json"))
        else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(meta) = kriyon_core::transcript::parse_subagent_meta(&text) {
            if let Some(tuid) = meta.tool_use_id {
                by_tool_use.insert(tuid, id.to_string());
            }
        }
    }
    for sub in subagents.iter_mut() {
        if let Some(agent_id) = by_tool_use.get(&sub.tool_use_id) {
            sub.agent_id = Some(agent_id.clone());
        }
    }
}
```

Ensure `PathBuf`/`Path` are in scope (they are, via the file's `use std::path::{Path, PathBuf};`).

- [ ] **Step 4: Run it, watch it pass**

Run: `cargo test activity_source_sets_agent_id_from_meta_sidecar`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

Run: `cargo fmt && pnpm check`
Expected: GREEN.

```bash
git add src-tauri/src/watcher.rs
git commit -m "feat(watcher): correlate subagent agentId exactly via the meta sidecar"
```

---

## Task 3: `read_subagent_view` command + per-session transcript path

**Files:**
- Modify: `src-tauri/src/watcher.rs` (`TranscriptSource::take_transcript_path`; `on_transcript_path` param on `spawn_session_watch` + `pump`)
- Modify: `src-tauri/src/lib.rs` (`AppState.transcript_paths`; register command)
- Modify: `src-tauri/src/commands.rs` (`read_subagent_view`; wire `on_transcript_path`)

**Interfaces:**
- Consumes: `is_valid_agent_id`, `subagent_transcript_path`, `parse_studio_events` (Task 1).
- Produces: `read_subagent_view(session_id: String, agent_id: String) -> Result<Vec<StudioEvent>, String>` (Tauri command). Returns `Ok(vec![])` when the transcript path is unknown or the file is missing; errors only on an invalid `agent_id`.

- [ ] **Step 1: Add `take_transcript_path` to `TranscriptSource`**

In `src-tauri/src/watcher.rs`, `TranscriptSource` already binds its tailer from the first hook's `transcript_path`. Add fields to surface that path once:

```rust
    /// The main transcript path, surfaced once via [`Self::take_transcript_path`]
    /// so the app can resolve the subagents dir for `read_subagent_view`.
    transcript_path: Option<String>,
    transcript_path_taken: bool,
```

Initialize both in `TranscriptSource::new` (`transcript_path: None`, `transcript_path_taken: false`). In `observe_hook`, where it binds the tailer from `path`, also record it:

```rust
        if let Some(path) = event.transcript_path.as_deref() {
            if !path.is_empty() {
                self.tailer = Some(Tailer::new(PathBuf::from(path)));
                self.transcript_path = Some(path.to_string());
            }
        }
```

Add the accessor (next to `take_title`):

```rust
    /// The main transcript path the first time it is known, then `None`.
    fn take_transcript_path(&mut self) -> Option<String> {
        if self.transcript_path_taken {
            return None;
        }
        let p = self.transcript_path.clone()?;
        self.transcript_path_taken = true;
        Some(p)
    }
```

- [ ] **Step 2: Add the `on_transcript_path` callback to `pump` and `spawn_session_watch`**

In `pump` (mirror the `on_claude_id` block), add a generic param `Tp: Fn(String)` and, after the `on_claude_id` surface block, add:

```rust
    if let Some(path) = sources.transcript.take_transcript_path() {
        on_transcript_path(path);
    }
```

Add `on_transcript_path: &Tp` to `pump`'s parameter list and `Tp: Fn(String)` to its bounds. In `spawn_session_watch`, add the param `on_transcript_path: Tp` with bound `Tp: Fn(String) + Send + 'static`, pass `&on_transcript_path` into the `pump(...)` call inside `pump_once`. (The `#[allow(clippy::too_many_arguments)]` already on both functions covers the extra arg.)

- [ ] **Step 3: Update the two existing `spawn_session_watch` test call sites**

In `watcher.rs` tests, `spawn_session_watch_streams_status_transcript_and_usage` and `last_pump_millis_advances_as_the_pump_thread_runs` and `hook_source_skips_history_then_streams_live` call `spawn_session_watch` with the callback list. Add one more `|_| {}` (or a capturing closure) in the correct position (immediately after `on_claude_id`, matching the new param order) to each call. Build to confirm the arity:

Run: `cargo test spawn_session_watch_streams_status_transcript_and_usage 2>&1 | head -30`
Fix any arity mismatch by inserting the new closure argument in order.

- [ ] **Step 4: Add `transcript_paths` to `AppState`**

In `src-tauri/src/lib.rs`, add to the `AppState` struct:

```rust
    /// Per-session main transcript path, learned from the watcher, used by
    /// `read_subagent_view` to resolve the subagents dir server-side.
    transcript_paths: std::sync::Mutex<std::collections::HashMap<SessionId, std::path::PathBuf>>,
```

Initialize it in the `AppState` constructor / `Default`/`new` alongside the other maps:

```rust
            transcript_paths: std::sync::Mutex::new(std::collections::HashMap::new()),
```

(Match the existing maps' lock type — if the file uses `parking_lot::Mutex` like `sessions`, use that instead of `std::sync::Mutex`. Check the existing `sessions`/`watchers` field types and mirror them exactly, including the lock import.)

- [ ] **Step 5: Wire `on_transcript_path` in `watch_transcript`**

In `src-tauri/src/commands.rs`, in `watch_transcript`, define a callback like the `on_claude_id` one (which is near `commands.rs:403`). It needs the session id and app state. Mirror however `on_claude_id` captures state/app; e.g.:

```rust
    let tp_state = state.inner().clone_for_callback(); // see note below
    let tp_id = id.clone();
    let on_transcript_path = move |path: String| {
        tp_state
            .transcript_paths
            .lock()
            .insert(tp_id.clone(), std::path::PathBuf::from(path));
    };
```

NOTE: `watch_transcript` already captures state for the other callbacks (e.g. how `on_claude_id` emits via `app`). Follow the SAME capture pattern the existing callbacks use — if they capture an `AppHandle` and use `app.state::<AppState>()` inside, do that here too rather than inventing `clone_for_callback`. The concrete requirement: inside the closure, insert `(id, PathBuf)` into `state.transcript_paths`. Then pass `on_transcript_path` to `spawn_session_watch` in the new arg position (Step 2 order).

- [ ] **Step 6: Write the command test**

In `src-tauri/src/commands.rs` (or a tests module there), add a test for the pure resolution+parse path. Since the command needs `AppState`, factor the core of the command into a free helper that takes the resolved main transcript path, so it is unit-testable without Tauri:

```rust
#[cfg(test)]
mod subagent_view_tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn reads_and_parses_a_subagent_transcript() {
        let dir = tempfile::tempdir().expect("tempdir");
        let proj = dir.path().join("proj");
        let sub = proj.join("main-1").join("subagents");
        std::fs::create_dir_all(&sub).expect("mkdir");
        let mut f = std::fs::File::create(sub.join("agent-abc1.jsonl")).expect("create");
        writeln!(
            f,
            r#"{{"type":"user","message":{{"role":"user","content":"do the thing"}}}}"#
        )
        .expect("write");
        let main = proj.join("main-1.jsonl");

        let events = subagent_view_from_main(&main, "abc1").expect("ok");
        assert!(events.iter().any(|e| matches!(
            &e.event,
            kriyon_core::transcript::StructuredEvent::Prompt { text } if text == "do the thing"
        )));

        // Missing file → empty, not an error.
        assert_eq!(subagent_view_from_main(&main, "zzzz").unwrap().len(), 0);

        // Invalid agent id → error.
        assert!(subagent_view_from_main(&main, "../x").is_err());
    }
}
```

- [ ] **Step 7: Run it, watch it fail**

Run: `cargo test reads_and_parses_a_subagent_transcript`
Expected: FAIL — `subagent_view_from_main` not found.

- [ ] **Step 8: Implement the helper + the command**

In `src-tauri/src/commands.rs`, add the testable helper and the command. (Confirm the `StudioEvent` import path; `commands.rs` likely already imports from `kriyon_core::transcript` — reuse it.)

```rust
/// Resolve `agent_id`'s transcript beside `main_transcript` and parse it into
/// `StudioEvent`s. `Ok(vec![])` if the file is absent (not written yet);
/// `Err` only for an invalid `agent_id` (trust boundary). Tolerant parse.
fn subagent_view_from_main(
    main_transcript: &std::path::Path,
    agent_id: &str,
) -> Result<Vec<kriyon_core::transcript::StudioEvent>, String> {
    if !kriyon_core::daemon::is_valid_agent_id(agent_id) {
        return Err("invalid agent id".to_string());
    }
    let Some(path) = kriyon_core::transcript::subagent_transcript_path(main_transcript, agent_id)
    else {
        return Ok(Vec::new());
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    Ok(text
        .lines()
        .flat_map(kriyon_core::transcript::parse_studio_events)
        .collect())
}

/// Parse one subagent's transcript into Studio events for the inside-view.
///
/// # Errors
/// Returns an error string if `agent_id` is not a valid subagent id. A session
/// with no known transcript path, or a not-yet-written transcript, yields an
/// empty list rather than an error.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn read_subagent_view(
    state: tauri::State<'_, AppState>,
    session_id: String,
    agent_id: String,
) -> Result<Vec<kriyon_core::transcript::StudioEvent>, String> {
    let main = state
        .transcript_paths
        .lock()
        .get(&SessionId(session_id))
        .cloned();
    let Some(main) = main else {
        // Validate the id even when we can't resolve a path, so a bad id is
        // always rejected consistently.
        return if kriyon_core::daemon::is_valid_agent_id(&agent_id) {
            Ok(Vec::new())
        } else {
            Err("invalid agent id".to_string())
        };
    };
    subagent_view_from_main(&main, &agent_id)
}
```

(If `AppState.transcript_paths` uses `parking_lot::Mutex`, `.lock()` returns the guard directly; if `std::sync::Mutex`, use `.lock().map_err(|e| e.to_string())?`. Match the field type chosen in Step 4.)

- [ ] **Step 9: Register the command**

In `src-tauri/src/lib.rs`, add `commands::read_subagent_view,` inside `tauri::generate_handler![ … ]`.

- [ ] **Step 10: Run tests, watch them pass**

Run: `cargo test reads_and_parses_a_subagent_transcript`
Expected: PASS.

- [ ] **Step 11: Gate + commit**

Run: `cargo fmt && pnpm check`
Expected: GREEN.

```bash
git add src-tauri/src/watcher.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "feat(commands): read_subagent_view returns a subagent's Studio events"
```

---

## Task 4: IPC bridge wrapper

**Files:**
- Modify: `src/ipc/bridge.ts`

**Interfaces:**
- Produces: `readSubagentView(sessionId: string, agentId: string): Promise<StudioEvent[]>`.

- [ ] **Step 1: Add the wrapper**

In `src/ipc/bridge.ts` (StudioEvent is already imported), following the `hasTauri()`-guarded pattern used by `watchTranscript`:

```ts
/**
 * Read one subagent's own transcript, parsed into Studio events, for the
 * inspector's inside-view. Resolves `[]` outside Tauri or when the subagent
 * transcript isn't on disk yet.
 */
export function readSubagentView(
  sessionId: string,
  agentId: string
): Promise<StudioEvent[]> {
  if (!hasTauri()) {
    return Promise.resolve([]);
  }
  return invoke("read_subagent_view", { sessionId, agentId });
}
```

- [ ] **Step 2: Gate + commit**

Run: `pnpm check`
Expected: GREEN (tsc compiles the new export; nothing consumes it yet).

```bash
git add src/ipc/bridge.ts
git commit -m "feat(ipc): readSubagentView bridge wrapper"
```

---

## Task 5: Extract a store-free `StudioEventList`

**Files:**
- Create: `src/studio/StudioEventList.tsx`, `src/studio/StudioEventList.test.tsx`
- Modify: `src/studio/StudioView.tsx`

**Interfaces:**
- Produces: `StudioEventList({ events }: { events: StudioEvent[] })` — renders each event via the existing block components, store-free. `StudioView` uses it for the transcript body.

- [ ] **Step 1: Write the failing test**

Create `src/studio/StudioEventList.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { StudioEvent } from "../types.ts";
import { StudioEventList } from "./StudioEventList.tsx";

test("renders prompt, assistant, and tool events from props", () => {
  const events: StudioEvent[] = [
    { id: "1:0", kind: "prompt", text: "do the thing" },
    { id: "2:0", kind: "assistant", text: "working on it" },
    { id: "2:1", kind: "tool", name: "Read", target: "foo.ts", meta: null },
  ];
  render(<StudioEventList events={events} />);
  expect(screen.getByText("do the thing")).toBeInTheDocument();
  expect(screen.getByText("working on it")).toBeInTheDocument();
  expect(screen.getByText("foo.ts")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run src/studio/StudioEventList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement by lifting `renderEvent` out of `StudioView`**

Open `src/studio/StudioView.tsx`, copy the private `renderEvent(event, key)` switch (it maps each `event.kind` to a block component) into the new file. Create `src/studio/StudioEventList.tsx`:

```tsx
import type { StudioEvent } from "../types.ts";
// Import the SAME block components StudioView uses (copy its block imports):
// Prompt, Text, Tool, Bash, Diff, Code, Question from "./blocks/…".

/** Map one StudioEvent to its block component. Lifted from StudioView so both
 *  the main view and the subagent inside-view render events identically. */
function renderEvent(event: StudioEvent, key: string) {
  // PASTE the exact switch body from StudioView.renderEvent here.
}

/** Render a StudioEvent[] using the Studio block components. Store-free. */
export function StudioEventList({ events }: { events: StudioEvent[] }) {
  return <>{events.map((event) => renderEvent(event, event.id))}</>;
}
```

(Use `event.id` as the key — it is stable and unique. Match the import paths and any wrapper element/spacing `StudioView` used around the mapped list so the visual output is unchanged.)

- [ ] **Step 4: Use it from `StudioView`**

In `src/studio/StudioView.tsx`, remove the now-duplicated private `renderEvent` and replace the place that maps `events.map(renderEvent)` with `<StudioEventList events={events} />` (import it). Keep all live-only chrome (Thinking/ResumeHint/pending prompts/AnswerInTerminal) exactly as-is — only the transcript-event mapping moves.

- [ ] **Step 5: Run tests, watch them pass**

Run: `pnpm exec vitest run src/studio/StudioEventList.test.tsx`
Expected: PASS. Then run the existing StudioView tests if any: `pnpm exec vitest run src/studio` — all green (no behavior change).

- [ ] **Step 6: Gate + commit**

Run: `pnpm check`
Expected: GREEN.

```bash
git add src/studio/StudioEventList.tsx src/studio/StudioEventList.test.tsx src/studio/StudioView.tsx
git commit -m "refactor(studio): extract store-free StudioEventList renderer"
```

---

## Task 6: Deep expand in the Agents panel

**Files:**
- Modify: `src/inspector/activity/AgentsPanel.tsx`, `src/inspector/activity/AgentsPanel.test.tsx`

**Interfaces:**
- Consumes: `readSubagentView` (Task 4), `StudioEventList` (Task 5), `useNow` (existing).
- Produces: a subagent row with an `agentId` is expandable (running or done); expanding loads and renders its inside-view, refreshing while running.

The panel needs the session id to call the command. `AgentsPanel` is rendered by `ActivitySection`/`Inspector`, which know the active session id (`useSessions((s) => s.activeSessionId)`). Thread `sessionId` down: `Inspector` → `ActivitySection` → `AgentsPanel` → `AgentRow`.

- [ ] **Step 1: Write the failing test**

In `src/inspector/activity/AgentsPanel.test.tsx`, add (mock the bridge):

```tsx
import { vi } from "vitest";
vi.mock("../../ipc/bridge.ts", () => ({
  readSubagentView: vi.fn(async () => [
    { id: "1:0", kind: "prompt", text: "map the dirs" },
    { id: "2:0", kind: "tool", name: "Read", target: "pkg.json", meta: null },
  ]),
}));

test("expanding a subagent loads and renders its inside view", async () => {
  render(
    <AgentsPanel
      sessionId="s1"
      subagents={[
        subagent({
          agentId: "aaa1",
          kind: "explorer",
          state: "done",
          result: "summary",
          toolUseId: "tu_1",
        }),
      ]}
    />
  );
  fireEvent.click(screen.getByText("explorer"));
  expect(await screen.findByText("map the dirs")).toBeInTheDocument();
  expect(await screen.findByText("pkg.json")).toBeInTheDocument();
});
```

Update the existing `AgentsPanel` test renders to pass `sessionId="s1"` (new required prop). Keep the existing `subagent(...)` factory (it already has `agentId`).

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run src/inspector/activity/AgentsPanel.test.tsx`
Expected: FAIL — inside-view text not found (and a TS error on the new `sessionId` prop until added).

- [ ] **Step 3: Implement the deep expand**

In `src/inspector/activity/AgentsPanel.tsx`:
- Add `sessionId: string` to `AgentsPanel`'s props and pass it to each `AgentRow`.
- In `AgentRow`, change `expandable` to `subagent.agentId !== null` (expandable while running or done).
- On expand, run a load via `readSubagentView(sessionId, agentId)` with a `ReviewPanel`-style phase machine (`idle | loading | loaded | error`). While `subagent.state === "running"` and expanded, re-fetch on the `useNow()` tick (already imported) and replace the events (stable ids make this idempotent). Render `<StudioEventList events={events} />` inside a compact indented well; show a quiet "Starting…"/empty line when there are no events; fall back to the existing raw `result` `<pre>` only if the load errored or returned nothing and a `result` exists.

Concretely (sketch — keep the existing glyph/body/status code):

```tsx
import { readSubagentView } from "../../ipc/bridge.ts";
import { StudioEventList } from "../../studio/StudioEventList.tsx";
import type { StudioEvent } from "../../types.ts";

const insideWellStyle: CSSProperties = {
  background: tokens.color.surface.s1,
  border: `1px solid ${tokens.color.line.soft}`,
  borderRadius: tokens.radius.md,
  marginTop: "6px",
  maxHeight: "320px",
  overflow: "auto",
  padding: tokens.space.sm,
};

function AgentRow({ sessionId, subagent }: { sessionId: string; subagent: Subagent }) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<StudioEvent[]>([]);
  const [phase, setPhase] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const now = useNow();
  const running = subagent.state === "running";
  const { agentId } = subagent;
  const expandable = agentId !== null;

  // Load on expand; while running + expanded, refresh on the shared tick.
  useEffect(() => {
    if (!(expanded && agentId)) {
      return;
    }
    let cancelled = false;
    if (phase === "idle") {
      setPhase("loading");
    }
    readSubagentView(sessionId, agentId)
      .then((ev) => {
        if (!cancelled) {
          setEvents(ev);
          setPhase("loaded");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPhase("error");
        }
      });
    return () => {
      cancelled = true;
    };
    // `now` is included so a running subagent re-fetches each second.
  }, [expanded, agentId, sessionId, running ? now : 0, phase]);

  // …existing glyph + body…
  // expanded block:
  //   {expanded ? (
  //     <div style={insideWellStyle}>
  //       {events.length > 0 ? (
  //         <StudioEventList events={events} />
  //       ) : phase === "loading" ? (
  //         <span style={statusStyle}>Loading…</span>
  //       ) : subagent.result ? (
  //         <pre style={resultStyle}>{subagent.result}</pre>
  //       ) : (
  //         <span style={statusStyle}>No detail yet</span>
  //       )}
  //     </div>
  //   ) : null}
}
```

Refine the `useEffect` deps so it does not loop (e.g. drop `phase` from deps and set `loading` only on the open transition; the implementer should ensure a single fetch per open + one per tick while running, not an infinite re-render). Keep `import { useEffect }` from React.

- [ ] **Step 4: Thread `sessionId` from the Inspector**

In `src/inspector/activity/ActivitySection.tsx`, add `sessionId: string` to its props and pass it to `<AgentsPanel sessionId={sessionId} … />`. In `src/inspector/Inspector.tsx`, pass the active session id: `<ActivitySection sessionId={session.id} activity={…} />` (the component already has `session`). Update `ActivitySection.test.tsx` to pass `sessionId="s1"`.

- [ ] **Step 5: Run tests, watch them pass**

Run: `pnpm exec vitest run src/inspector/activity/AgentsPanel.test.tsx src/inspector/activity/ActivitySection.test.tsx`
Expected: PASS.

- [ ] **Step 6: Gate + commit**

Run: `pnpm check`
Expected: GREEN.

```bash
git add src/inspector/activity/AgentsPanel.tsx src/inspector/activity/AgentsPanel.test.tsx src/inspector/activity/ActivitySection.tsx src/inspector/activity/ActivitySection.test.tsx src/inspector/Inspector.tsx
git commit -m "feat(inspector): expand a subagent into its inside Studio view"
```

- [ ] **Step 7: GUI verify (manual)**

Rebuild + restart the app. Spawn parallel subagents; expand a running one → its task/reasoning/tools stream in (or fill on completion); confirm the right subagent's content shows for parallel same-type agents (exact correlation); confirm a finished subagent expands to its full conversation + result.

---

## Self-Review

**1. Spec coverage:**
- Section 1 (core paths/meta/validation) → Task 1.
- Section 2 (exact agentId via meta) → Task 2.
- Section 3 (command + transcript path state) → Task 3 (+ bridge in Task 4).
- Section 4 (StudioEventList reuse + deep expand) → Tasks 5–6.
- Testing requirements → tests in Tasks 1,2,3,5,6.
- CONTEXT.md terms → Task 1 Step 1.

**2. Placeholder scan:** Two steps intentionally say "match the existing pattern" (AppState lock type in Task 3 Step 4/8; the watcher callback capture in Task 3 Step 5) because the exact lock type / capture idiom must be read from the file at implementation time — the research noted `sessions` uses `parking_lot::Mutex` while other state may differ. These are explicit instructions to mirror a named existing construct, not vague TODOs. Task 5 Step 3 says "paste the exact switch from StudioView.renderEvent" — the source is identified by file+symbol; reproduce it verbatim.

**3. Type consistency:** `read_subagent_view`/`readSubagentView` consistent; returns `Vec<StudioEvent>` / `StudioEvent[]`. `is_valid_agent_id`, `subagent_transcript_path`, `subagents_dir`, `parse_subagent_meta`, `SubagentMeta` used consistently across Tasks 1→2→3. `StudioEventList({ events })` consistent across Tasks 5→6. `Subagent.agentId` is the handle threaded end to end.

**4. Ambiguity:** The Task 6 `useEffect` is given as a sketch with an explicit warning to avoid a render loop (single fetch per open + one per running tick). The implementer must finalize the deps; the test in Step 1 pins the observable behavior (expand → renders events).

**Risk note:** live-vs-completion writing of subagent transcripts is unconfirmed; the design + Task 6 tolerate both (refresh while running; hook current-tool line covers in-flight). If transcripts prove non-live, the inside-view simply populates on completion — still correct.
