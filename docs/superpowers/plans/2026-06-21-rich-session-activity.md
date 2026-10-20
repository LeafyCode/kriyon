# Rich, Reliable Session Activity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Inspector's session-activity view reliable (subagents/tasks always appear and always settle to idle) and richer (main-agent + per-subagent current tool, live ticking timers, exact durations), driven entirely from Claude Code hook fields Kriyon already receives.

**Architecture:** The reliability fix sets `KRIYON_SESSION` in the daemon's spawn environment (like `ZDOTDIR`) so every `claude` in the shell inherits the hook gate, independent of paste timing, and reattach is covered for free. The richer view extends the existing hook-driven activity core (`kriyon-core/activity.rs`) — the terminal stays the source of truth, the structured view a best-effort reconstruction. New detail is built from hook payload fields (`agent_id`, `agent_type`, `duration_ms`, a tool `target`) that the hook currently discards.

**Tech Stack:** Rust (`kriyon-core` pure logic + `src-tauri` Tauri shell + `kriyon-ptyd` daemon), Python 3 (hook script, embedded as a Rust string const), React + TypeScript + Zustand (frontend), Vitest, `cargo test`.

## Global Constraints

- `pnpm check` must be green before every commit (`lint` = ultracite, `typecheck` = tsc, `test` = vitest, `rust:fmt`, `rust:clippy -D warnings`, `rust:test`).
- Conventional commits; never `--no-verify`; stay on branch `feat/session-activity` (do NOT branch).
- clippy `-D warnings`: prefer `try_from` over `as`; no `.unwrap()`/`.expect()` in command handlers.
- Formatting/JS-TS lint is owned by Biome + Ultracite — run `pnpm fix`, never hand-format.
- Rust core owns all IO; the frontend is a thin UI calling `src/ipc/bridge.ts`; no design literals outside `src/theme/tokens.ts`.
- A term must exist in `CONTEXT.md` before it becomes a module/type name. New terms this plan introduces: `MainAgent`, `ToolActivity`, `currentTool`, `agentId`/`agentType`, "settle".
- The parser/ingest layer must stay tolerant: an unknown/missing field changes nothing and never panics.
- Leave uncommitted (pre-existing, intentional): `PRODUCT.md`, `docs/superpowers/specs/2026-06-17-session-persistence-restore-design.md`.
- New `HookEvent` / model fields are all optional and tolerant. Rust structs serialize `rename_all = "camelCase"`; the TS types mirror them exactly.

**Already implemented — do NOT rebuild** (verify only): the Agents panel header counts (`AgentsPanel.tsx` `metaLabel` → "N running, N done"), click-to-reveal results (`AgentRow` expand), and Tasks `n/m` progress (`TasksPanel.tsx` meta). These cover three spec bullets; this plan adds only what is missing on top of them.

---

## File Structure

**Reliability fix**
- Modify: `src-tauri/src/commands.rs` (`create_session` fresh path — insert `KRIYON_SESSION` into `env`).
- Modify: `src/terminal/sessionHost.ts` (`launchClaudeOnce` — drop the typed `KRIYON_SESSION=…` prefix).

**Hook capture**
- Modify: `crates/kriyon-core/src/hooks.rs` (`HookEvent` + a parse test).
- Modify: `src-tauri/src/hooks.rs` (`HOOK_SCRIPT` Python — emit the new fields).

**Core model + lifecycle**
- Modify: `crates/kriyon-core/src/activity.rs` (`ToolActivity`, `MainAgent`, extend `Subagent`, `SessionActivity.main`, `HookActivity` lifecycle: main/subagent current tool, correlation, settle).
- Modify: `CONTEXT.md` (new terms).

**Watcher**
- Modify: `src-tauri/src/watcher.rs` (thread `main` through `ActivitySource::snapshot`; extend integration test).

**Frontend**
- Modify: `src/types.ts` (`ToolActivity`, `MainAgent`, extend `Subagent`, `SessionActivity.main`).
- Create: `src/inspector/activity/useNow.ts` + `src/inspector/activity/useNow.test.ts` (one shared 1s ticker).
- Create: `src/inspector/activity/toolLabel.ts` + `src/inspector/activity/toolLabel.test.ts` (format a `ToolActivity` and an elapsed label).
- Modify: `src/inspector/activity/AgentsPanel.tsx` + `AgentsPanel.test.tsx` (live elapsed, currentTool line, exact done-duration).
- Create: `src/inspector/activity/ActivitySection.tsx` + test (main-agent current-tool line + visible "Idle").
- Modify: `src/inspector/Inspector.tsx` (render the new section; wire activity even when empty for Idle).

---

## Task 1: Reliability fix — gate via daemon spawn env

**Files:**
- Modify: `src-tauri/src/commands.rs:201-217` (fresh-session spawn spec)
- Modify: `src/terminal/sessionHost.ts:166-169` (`launchClaudeOnce`)

**Interfaces:**
- Produces: every `claude` launched in a Kriyon session shell carries `KRIYON_SESSION=<kriyon-session-id>` in its environment, so the hook fires reliably. `launchClaudeOnce` sends a bare `claude` / `claude --resume <id>` command with no env prefix.

This task is IPC/process glue, not pure logic, so it has no new automated unit test (the downstream pipeline is already covered by `watcher.rs::spawn_session_watch_emits_activity_snapshots`). It is verified by `pnpm check` staying green plus a manual GUI check. This matches the spec, which specifies GUI verification for the reliability fix.

- [ ] **Step 1: Insert `KRIYON_SESSION` into the spawn env**

In `src-tauri/src/commands.rs`, the fresh-session path builds `let mut env = HashMap::new();` (line ~192) and inserts `ZDOTDIR` conditionally (lines ~208-211). Immediately before `let spec = SpawnSpec { cwd, shell, env };` (line ~217), add the gate. `id` is the Kriyon session id (a `String`, still owned here — it is only moved at line ~226 `SessionId(id)`):

```rust
    // Gate Kriyon's Claude Code hook on this session. Setting it in the daemon's
    // spawn env (exactly like ZDOTDIR) means every `claude` launched in this
    // shell — by launchClaudeOnce, by hand, or after a reattach — inherits the
    // gate. This replaces the old, timing-fragile typed `KRIYON_SESSION=… claude`
    // prefix. KRIYON_SESSION is not stripped by is_agent_identity_var.
    env.insert("KRIYON_SESSION".to_string(), id.clone());

    let spec = SpawnSpec { cwd, shell, env };
```

- [ ] **Step 2: Drop the typed env prefix in `launchClaudeOnce`**

In `src/terminal/sessionHost.ts`, replace the command construction (lines ~166-169) so it no longer types the env prefix (the shell already carries it):

```ts
  const resumable = claudeSessionId && SAFE_CLAUDE_ID.test(claudeSessionId);
  const command = resumable
    ? `claude --resume ${claudeSessionId}\r`
    : "claude\r";
```

- [ ] **Step 3: Update the `launchClaudeOnce` doc comment**

The doc comment (lines ~134-137) says `KRIYON_SESSION` gates the hook and is passed here. Update that paragraph to reflect the new mechanism:

```ts
 * `KRIYON_SESSION` gates Kriyon's Claude Code hook (it only records events for
 * sessions Kriyon launched). It is set in the session shell's environment by the
 * daemon spawn (see `create_session`), so every `claude` in this shell inherits
 * it — we no longer type it as a command prefix (that was timing-fragile). We
 * never pass `--session-id` (handing Claude a *fresh* id suppresses its live
 * transcript — see ADR 0003); resuming a Claude-generated id is safe and is what
 * keeps one canonical transcript per session across launches.
```

- [ ] **Step 4: Run the gate**

Run: `pnpm check`
Expected: PASS (no behavior changed for the test suite; this is glue).

- [ ] **Step 5: GUI verify (manual)**

Build/run the app. Create a fresh session, ask Claude to spawn a Task subagent. Confirm:
1. `~/.claude/kriyon/events/<kriyon-session-id>.jsonl` gains `Agent` `PreToolUse`/`PostToolUse` lines.
2. The Inspector Agents panel populates.
3. Quit and relaunch the app (reattach to the surviving daemon); the session still records events on the next subagent (the surviving shell carries the env).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src/terminal/sessionHost.ts
git commit -m "fix(session): gate the kriyon hook via the daemon spawn env"
```

---

## Task 2: Capture the dropped hook fields

**Files:**
- Modify: `crates/kriyon-core/src/hooks.rs` (`HookEvent` struct + tests; the two test `HookEvent { … }` literals in `crates/kriyon-core/src/activity.rs` and `src-tauri/src/watcher.rs` will need the new fields — handled in their own tasks where those files are edited)
- Modify: `src-tauri/src/hooks.rs` (`HOOK_SCRIPT`)

**Interfaces:**
- Produces: `HookEvent` gains `agent_id: Option<String>`, `agent_type: Option<String>`, `duration_ms: Option<u64>`, `target: Option<String>` (all `#[serde(default)]`). The hook script emits `agent_id`, `agent_type`, `duration_ms`, `target` on each line.

Note: `HookEvent` is constructed by hand in test helpers in three files (`hooks.rs`, `activity.rs`, `watcher.rs`). Adding fields to the struct breaks those literals' compilation. This task fixes the one in `hooks.rs`; the `activity.rs` helper is updated in Task 3 and the `watcher.rs` helper in Task 5 (each uses `..` spread or is rebuilt there). To keep this task's `cargo test` green on its own, also update the `activity.rs` and `watcher.rs` `HookEvent` literals to add the four new fields set to `None` (mechanical; no behavior).

- [ ] **Step 1: Write the failing parse test**

In `crates/kriyon-core/src/hooks.rs`, add to the `tests` module:

```rust
    #[test]
    fn parses_subagent_tool_event_with_enrichment_fields() {
        let line = r#"{"event":"PostToolUse","tool_name":"Edit","tool_use_id":"toolu_9","agent_id":"agent_7","agent_type":"Explore","duration_ms":1234,"target":"src/foo.tsx"}"#;
        let ev = parse_hook_line(line).expect("parses");
        assert_eq!(ev.agent_id.as_deref(), Some("agent_7"));
        assert_eq!(ev.agent_type.as_deref(), Some("Explore"));
        assert_eq!(ev.duration_ms, Some(1234));
        assert_eq!(ev.target.as_deref(), Some("src/foo.tsx"));
    }

    #[test]
    fn enrichment_fields_default_to_none_when_absent() {
        let ev = parse_hook_line(r#"{"event":"Stop"}"#).expect("parses");
        assert_eq!(ev.agent_id, None);
        assert_eq!(ev.agent_type, None);
        assert_eq!(ev.duration_ms, None);
        assert_eq!(ev.target, None);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p kriyon-core parses_subagent_tool_event_with_enrichment_fields`
Expected: FAIL — compile error: no field `agent_id` on `HookEvent`.

- [ ] **Step 3: Add the fields to `HookEvent`**

In `crates/kriyon-core/src/hooks.rs`, add to the `HookEvent` struct (after `result`, before `ts`):

```rust
    /// The subagent runtime id an internal tool event belongs to. Absent/empty
    /// means the main agent fired the tool. Used to attribute a `currentTool` to
    /// a [`crate::activity::Subagent`]; see correlation in `activity.rs`.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// The subagent type an internal tool event belongs to (e.g. `"Explore"`),
    /// matching the spawning Agent's `subagent_type`. Used for type+order
    /// correlation when an `agent_id` is first seen.
    #[serde(default)]
    pub agent_type: Option<String>,
    /// Exact tool duration in milliseconds, reported on `PostToolUse`.
    #[serde(default)]
    pub duration_ms: Option<u64>,
    /// A short human target for the tool (a file path, else a command summary),
    /// derived from `tool_input` by the hook script. Renders as "Editing Foo.tsx".
    #[serde(default)]
    pub target: Option<String>,
```

- [ ] **Step 4: Fix the existing `HookEvent` literals in `hooks.rs` tests**

Both `parses_a_minimal_event` and `parses_event_without_optional_fields` build a full `HookEvent { … }` literal. Add the four new fields set to `None` just before `ts: None,` in each:

```rust
                agent_id: None,
                agent_type: None,
                duration_ms: None,
                target: None,
```

Also update `summary_uses_tool_name_when_present` the same way (it builds a full literal).

- [ ] **Step 5: Fix the `HookEvent` literals in `activity.rs` and `watcher.rs` test helpers**

In `crates/kriyon-core/src/activity.rs`, the `hook(...)` helper builds a full literal — add the four fields set to `None` before `ts: None,`.
In `src-tauri/src/watcher.rs`, the `hook(...)` helper builds a full literal — add the four fields set to `None` before `ts: None,`.
(These are mechanical; behavior is unchanged. They are needed so the workspace compiles.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p kriyon-core hooks && cargo test -p kriyon-core --lib`
Expected: PASS.

- [ ] **Step 7: Emit the fields from the hook script**

In `src-tauri/src/hooks.rs`, in `HOOK_SCRIPT`, after the `result` capture block and before the `rec = {` dict, add target derivation; then add the four keys to `rec`:

```python
# A short human target for the tool: a file path, else a command summary.
target = ti.get("file_path") or ti.get("command")
if isinstance(target, str):
    if len(target) > 200:
        target = target[:200] + "…"
else:
    target = None
dur = data.get("duration_ms") or (data.get("tool_response") or {}).get("durationMs") \
    if isinstance(data.get("tool_response"), dict) else data.get("duration_ms")
```

Then inside the `rec = { … }` dict, add (after `"command": ti.get("command"),`):

```python
    # Subagent attribution + exact timing + a tool target, for the rich view.
    "agent_id": data.get("agent_id"),
    "agent_type": data.get("agent_type"),
    "duration_ms": data.get("duration_ms"),
    "target": target,
```

Keep it simple: use `data.get("duration_ms")` directly in `rec` (top-level field CC sends). Remove the speculative `dur` line above — only add `target` derivation and the four `rec` keys. The final additions are exactly:

```python
target = ti.get("file_path") or ti.get("command")
if isinstance(target, str):
    if len(target) > 200:
        target = target[:200] + "…"
else:
    target = None
```

and in `rec`:

```python
    "agent_id": data.get("agent_id"),
    "agent_type": data.get("agent_type"),
    "duration_ms": data.get("duration_ms"),
    "target": target,
```

- [ ] **Step 8: Run the gate**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add crates/kriyon-core/src/hooks.rs src-tauri/src/hooks.rs crates/kriyon-core/src/activity.rs src-tauri/src/watcher.rs
git commit -m "feat(hooks): capture agent id, type, duration, and tool target"
```

---

## Task 3: Core types + main-agent current tool

**Files:**
- Modify: `CONTEXT.md` (new terms)
- Modify: `crates/kriyon-core/src/activity.rs`

**Interfaces:**
- Produces:
  - `ToolActivity { tool_name: String, target: Option<String>, started_at: Option<String> }` (camelCase: `toolName`, `target`, `startedAt`).
  - `MainAgent { current_tool: Option<ToolActivity> }` (camelCase: `currentTool`; derives `Default`).
  - `SessionActivity` gains `main: MainAgent`.
  - `HookActivity::main(&self) -> MainAgent`.
  - `HookActivity::ingest` now also handles non-Agent/non-background-Bash tool events with **no** `agent_id` → set/clear `main.current_tool`.

- [ ] **Step 1: Add the new terms to `CONTEXT.md`**

Under the Session-activity cluster (after the **Session activity** entry), add:

```markdown
- **Main agent** (`MainAgent`) — the top-level `claude` in a [Session] (the one driving the
  conversation), as opposed to a [Subagent] it spawns. In [Session activity] it carries only its
  in-flight [Tool activity]. _Avoid_: parent agent, root agent.
- **Tool activity** (`ToolActivity`) — one tool the [Main agent] or a [Subagent] is currently
  running: a `toolName`, an optional `target` (a file path or command summary), and `startedAt`.
  Set on a tool's `PreToolUse`, cleared on its `PostToolUse`. Enrichment over the core spawn/state
  view; renders as "Editing Foo.tsx". _Avoid_: current action, running tool.
- **Current tool** (`currentTool`) — the [Tool activity] in flight for an agent right now, or none.
- **Agent id / Agent type** (`agentId` / `agentType`) — the runtime id and the type (e.g.
  `"Explore"`) Claude Code stamps on a [Subagent]'s internal tool events. Kriyon binds `agentId` to
  a [Subagent] lazily, by `agentType` + spawn order, to attribute its [Current tool]. Enrichment
  only; the spawn list, counts, states, and results never depend on it.
- **Settle** — forcing any still-`running` [Subagent] to `done` and clearing every [Current tool]
  when the [Main agent]'s turn ends (`Stop`) or the session ends (`SessionEnd`). The turn ending is
  proof nothing is still running, so [Session activity] never sticks in a false "running" state.
```

- [ ] **Step 2: Write failing tests for the types + main current tool**

In `crates/kriyon-core/src/activity.rs` `tests` module, add:

```rust
    #[test]
    fn main_tool_set_on_pre_and_cleared_on_post() {
        let mut a = HookActivity::new();
        let mut pre = hook("PreToolUse", Some("Edit"), Some("e1"));
        pre.target = Some("src/foo.tsx".to_string());
        pre.ts = Some("2026-06-21T00:00:00Z".to_string());
        assert!(a.ingest(&pre));
        let main = a.main();
        let tool = main.current_tool.expect("main has a current tool");
        assert_eq!(tool.tool_name, "Edit");
        assert_eq!(tool.target.as_deref(), Some("src/foo.tsx"));
        assert_eq!(tool.started_at.as_deref(), Some("2026-06-21T00:00:00Z"));

        assert!(a.ingest(&hook("PostToolUse", Some("Edit"), Some("e1"))));
        assert!(a.main().current_tool.is_none(), "post clears the main tool");
    }

    #[test]
    fn agent_tool_event_does_not_become_a_main_tool() {
        // Spawning a subagent must not show up as a *main* tool — it is the
        // subagent list's job. The Agent tool is handled by on_agent only.
        let mut a = HookActivity::new();
        let mut pre = hook("PreToolUse", Some("Agent"), Some("t1"));
        pre.subagent_type = Some("Explore".to_string());
        a.ingest(&pre);
        assert!(a.main().current_tool.is_none());
        assert_eq!(a.subagents().len(), 1);
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p kriyon-core main_tool_set_on_pre_and_cleared_on_post`
Expected: FAIL — no method `main`, no field `current_tool`.

- [ ] **Step 4: Add the types and extend `SessionActivity`**

In `crates/kriyon-core/src/activity.rs`, add after the `Subagent` struct:

```rust
/// The top-level agent's in-flight tool, if any. The [`MainAgent`] carries only
/// its [`ToolActivity`]; everything else about the main turn lives in
/// `SessionStatus`. See `CONTEXT.md` "Main agent".
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MainAgent {
    pub current_tool: Option<ToolActivity>,
}

/// One tool an agent (main or subagent) is running right now: a name, an optional
/// human target, and when it started. Set on `PreToolUse`, cleared on
/// `PostToolUse`. Enrichment over the core spawn/state view. See `CONTEXT.md`
/// "Tool activity".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
    pub tool_name: String,
    pub target: Option<String>,
    pub started_at: Option<String>,
}
```

Add `main` to `SessionActivity`:

```rust
pub struct SessionActivity {
    pub main: MainAgent,
    pub subagents: Vec<Subagent>,
    pub shells: Vec<BackgroundShell>,
    pub tasks: Vec<Task>,
}
```

- [ ] **Step 5: Add `main` state + accessor to `HookActivity` and route tool events**

Add a `main` field to `HookActivity`:

```rust
#[derive(Debug, Default)]
pub struct HookActivity {
    main: MainAgent,
    subagents: Vec<Subagent>,
    shells: Vec<BackgroundShell>,
}
```

Add the accessor (near `subagents()`):

```rust
    /// The main agent's in-flight tool, if any.
    #[must_use]
    pub fn main(&self) -> MainAgent {
        self.main.clone()
    }
```

Extend `ingest` to route generic tool events (Agent and background Bash keep their existing arms; a plain tool with no `agent_id` updates the main tool):

```rust
    pub fn ingest(&mut self, ev: &crate::hooks::HookEvent) -> bool {
        match ev.tool_name.as_deref() {
            Some("Agent" | "Task") => self.on_agent(ev),
            Some("Bash") if ev.run_in_background == Some(true) => self.on_background_bash(ev),
            Some(_) => self.on_tool(ev),
            None => false,
        }
    }
```

Add `on_tool` (main path only for now; the subagent path is added in Task 4):

```rust
    /// A non-Agent tool event. With no `agent_id` it belongs to the main agent:
    /// `PreToolUse` sets `main.current_tool`, `PostToolUse` clears it. (Subagent
    /// attribution by `agent_id` is layered on in Task 4.)
    fn on_tool(&mut self, ev: &crate::hooks::HookEvent) -> bool {
        let agent_id = ev.agent_id.as_deref().filter(|s| !s.is_empty());
        if agent_id.is_some() {
            return false; // subagent attribution handled in Task 4
        }
        if ev.event == "PreToolUse" {
            self.main.current_tool = Some(ToolActivity {
                tool_name: ev.tool_name.clone().unwrap_or_default(),
                target: ev.target.clone(),
                started_at: ev.ts.clone(),
            });
            true
        } else if self.main.current_tool.is_some() {
            self.main.current_tool = None;
            true
        } else {
            false
        }
    }
```

- [ ] **Step 6: Update tests broken by the new `main` field**

`snapshot_serializes_camel_case` builds a `SessionActivity { … }` literal — add `main: MainAgent::default(),` as the first field.
`background_bash_becomes_a_shell_foreground_does_not` asserts a foreground `Bash` returns `false`. It now sets `main.current_tool` and returns `true`. Update that part of the test:

```rust
        // A foreground Bash sets the main agent's current tool but adds no shell.
        let mut fg = hook("PreToolUse", Some("Bash"), Some("b2"));
        fg.command = Some("ls".to_string());
        assert!(a.ingest(&fg));
        assert_eq!(a.shells().len(), 1, "foreground bash is not a shell");
        assert!(a.main().current_tool.is_some(), "foreground bash is a main tool");
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cargo test -p kriyon-core --lib activity`
Expected: PASS.

- [ ] **Step 8: Run the gate**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add CONTEXT.md crates/kriyon-core/src/activity.rs
git commit -m "feat(activity): model the main agent's current tool"
```

---

## Task 4: Subagent current tool — correlation + settle

**Files:**
- Modify: `crates/kriyon-core/src/activity.rs`

**Interfaces:**
- Consumes: `ToolActivity`, `MainAgent`, `HookActivity` from Task 3.
- Produces:
  - `Subagent` gains `agent_id: Option<String>` (camelCase `agentId`), `current_tool: Option<ToolActivity>` (camelCase `currentTool`), `duration_ms: Option<u64>` (camelCase `durationMs`).
  - `on_tool` now attributes a tool with `agent_id` to a subagent (binding lazily by `agent_type` + spawn order).
  - `Agent` `PostToolUse` records `duration_ms` and clears the subagent's `current_tool`.
  - `ingest` handles `Stop` and `SessionEnd` → settle.

- [ ] **Step 1: Write failing tests for attribution, correlation, duration, and settle**

In `crates/kriyon-core/src/activity.rs` `tests` module, add:

```rust
    #[test]
    fn subagent_tool_attributed_by_agent_id() {
        let mut a = HookActivity::new();
        let mut spawn = hook("PreToolUse", Some("Agent"), Some("t1"));
        spawn.subagent_type = Some("Explore".to_string());
        a.ingest(&spawn);

        // The subagent's internal Edit, tagged with its runtime agent_id + type.
        let mut edit = hook("PreToolUse", Some("Edit"), Some("e1"));
        edit.agent_id = Some("agent_a".to_string());
        edit.agent_type = Some("Explore".to_string());
        edit.target = Some("a.rs".to_string());
        assert!(a.ingest(&edit));

        let sub = &a.subagents()[0];
        assert_eq!(sub.agent_id.as_deref(), Some("agent_a"));
        assert_eq!(
            sub.current_tool.as_ref().map(|t| t.tool_name.as_str()),
            Some("Edit")
        );

        // Its PostToolUse clears the subagent's current tool but not the main's.
        let mut done = hook("PostToolUse", Some("Edit"), Some("e1"));
        done.agent_id = Some("agent_a".to_string());
        assert!(a.ingest(&done));
        assert!(a.subagents()[0].current_tool.is_none());
        assert!(a.main().current_tool.is_none());
    }

    #[test]
    fn correlation_binds_by_type_then_spawn_order() {
        // Two distinct types: each tool binds to the correct subagent.
        let mut a = HookActivity::new();
        let mut s1 = hook("PreToolUse", Some("Agent"), Some("t1"));
        s1.subagent_type = Some("Explore".to_string());
        a.ingest(&s1);
        let mut s2 = hook("PreToolUse", Some("Agent"), Some("t2"));
        s2.subagent_type = Some("Plan".to_string());
        a.ingest(&s2);

        let mut t_plan = hook("PreToolUse", Some("Read"), Some("r1"));
        t_plan.agent_id = Some("agent_plan".to_string());
        t_plan.agent_type = Some("Plan".to_string());
        a.ingest(&t_plan);

        let explore = &a.subagents()[0];
        let plan = &a.subagents()[1];
        assert!(explore.current_tool.is_none(), "Explore got nothing");
        assert_eq!(
            plan.current_tool.as_ref().map(|t| t.tool_name.as_str()),
            Some("Read")
        );
        assert_eq!(plan.agent_id.as_deref(), Some("agent_plan"));
    }

    #[test]
    fn agent_post_records_duration_and_clears_current_tool() {
        let mut a = HookActivity::new();
        let mut spawn = hook("PreToolUse", Some("Agent"), Some("t1"));
        spawn.subagent_type = Some("Explore".to_string());
        a.ingest(&spawn);
        let mut tool = hook("PreToolUse", Some("Edit"), Some("e1"));
        tool.agent_id = Some("agent_a".to_string());
        tool.agent_type = Some("Explore".to_string());
        a.ingest(&tool);

        let mut post = hook("PostToolUse", Some("Agent"), Some("t1"));
        post.duration_ms = Some(4200);
        a.ingest(&post);

        let sub = &a.subagents()[0];
        assert_eq!(sub.state, SubagentState::Done);
        assert_eq!(sub.duration_ms, Some(4200));
        assert!(sub.current_tool.is_none(), "done subagent has no current tool");
    }

    #[test]
    fn stop_settles_orphaned_running_subagent_and_clears_main_tool() {
        let mut a = HookActivity::new();
        let mut spawn = hook("PreToolUse", Some("Agent"), Some("t1"));
        spawn.subagent_type = Some("Explore".to_string());
        a.ingest(&spawn);
        let mut maintool = hook("PreToolUse", Some("Bash"), Some("b1"));
        maintool.command = Some("ls".to_string());
        a.ingest(&maintool); // sets main.current_tool

        // The turn ends with no Agent PostToolUse — settle must finish it.
        let mut stop = hook("Stop", None, None);
        stop.ts = Some("2026-06-21T00:05:00Z".to_string());
        assert!(a.ingest(&stop));
        assert_eq!(a.subagents()[0].state, SubagentState::Done);
        assert_eq!(
            a.subagents()[0].ended_at.as_deref(),
            Some("2026-06-21T00:05:00Z")
        );
        assert!(a.main().current_tool.is_none());

        // Settling again with nothing running changes nothing.
        assert!(!a.ingest(&hook("Stop", None, None)));
    }

    #[test]
    fn session_end_settles_too() {
        let mut a = HookActivity::new();
        let mut spawn = hook("PreToolUse", Some("Agent"), Some("t1"));
        spawn.subagent_type = Some("Explore".to_string());
        a.ingest(&spawn);
        assert!(a.ingest(&hook("SessionEnd", None, None)));
        assert_eq!(a.subagents()[0].state, SubagentState::Done);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p kriyon-core subagent_tool_attributed_by_agent_id`
Expected: FAIL — no field `agent_id`/`current_tool`/`duration_ms` on `Subagent`.

- [ ] **Step 3: Extend the `Subagent` struct**

In `crates/kriyon-core/src/activity.rs`, add to `Subagent` (after `result`):

```rust
    /// Runtime id of this subagent, bound lazily from its first internal tool
    /// event (by `agent_type` + spawn order) so its `current_tool` can be
    /// attributed. `None` until a tool event for it is seen.
    pub agent_id: Option<String>,
    /// This subagent's in-flight tool, if any. Enrichment; cleared on its tool's
    /// `PostToolUse`, on settle, and when the subagent completes.
    pub current_tool: Option<ToolActivity>,
    /// Exact run duration in milliseconds, from the `Agent` `PostToolUse`.
    pub duration_ms: Option<u64>,
```

- [ ] **Step 4: Initialize the new fields in `on_agent`**

In `on_agent`, the `self.subagents.push(Subagent { … })` literal must set the new fields. Add `agent_id: None, current_tool: None, duration_ms: None,`. In the completion branch (the `if done && agent.state != Done` block) also set `agent.duration_ms.clone_from(&ev.duration_ms);` and `agent.current_tool = None;`:

```rust
        if let Some(agent) = self.subagents.iter_mut().find(|a| a.tool_use_id == id) {
            if done && agent.state != SubagentState::Done {
                agent.state = SubagentState::Done;
                agent.ended_at.clone_from(&ev.ts);
                agent.result.clone_from(&ev.result);
                agent.duration_ms = ev.duration_ms;
                agent.current_tool = None;
                return true;
            }
            return false;
        }
        self.subagents.push(Subagent {
            tool_use_id: id.to_string(),
            kind: ev.subagent_type.clone().unwrap_or_default(),
            description: ev.description.clone(),
            state: if done { SubagentState::Done } else { SubagentState::Running },
            started_at: if done { None } else { ev.ts.clone() },
            ended_at: if done { ev.ts.clone() } else { None },
            result: if done { ev.result.clone() } else { None },
            agent_id: None,
            current_tool: None,
            duration_ms: if done { ev.duration_ms } else { None },
        });
        true
```

- [ ] **Step 5: Add the subagent path to `on_tool` and a `bind_agent` helper**

Replace the early `return false` for `agent_id.is_some()` in `on_tool` with attribution:

```rust
    fn on_tool(&mut self, ev: &crate::hooks::HookEvent) -> bool {
        let pre = ev.event == "PreToolUse";
        match ev.agent_id.as_deref().filter(|s| !s.is_empty()) {
            Some(agent_id) => {
                let Some(idx) = self.bind_agent(agent_id, ev.agent_type.as_deref()) else {
                    return false; // no subagent to attribute to (enrichment tier)
                };
                if pre {
                    self.subagents[idx].current_tool = Some(ToolActivity {
                        tool_name: ev.tool_name.clone().unwrap_or_default(),
                        target: ev.target.clone(),
                        started_at: ev.ts.clone(),
                    });
                } else {
                    self.subagents[idx].current_tool = None;
                }
                true
            }
            None => {
                if pre {
                    self.main.current_tool = Some(ToolActivity {
                        tool_name: ev.tool_name.clone().unwrap_or_default(),
                        target: ev.target.clone(),
                        started_at: ev.ts.clone(),
                    });
                    true
                } else if self.main.current_tool.is_some() {
                    self.main.current_tool = None;
                    true
                } else {
                    false
                }
            }
        }
    }

    /// Resolve the subagent an `agent_id` belongs to, binding lazily on first
    /// sight: if already bound, return it; otherwise bind this id to the oldest
    /// still-running, un-bound subagent whose `kind` matches `agent_type`.
    /// Returns `None` when nothing matches (the tool then goes unattributed —
    /// enrichment only; the core spawn/state view is unaffected). Parallel
    /// same-type subagents are an accepted v1 limit: a tool may bind to the wrong
    /// identical-kind sibling, but counts/states/results stay correct.
    fn bind_agent(&mut self, agent_id: &str, agent_type: Option<&str>) -> Option<usize> {
        if let Some(i) = self
            .subagents
            .iter()
            .position(|s| s.agent_id.as_deref() == Some(agent_id))
        {
            return Some(i);
        }
        let kind = agent_type.unwrap_or_default();
        let i = self.subagents.iter().position(|s| {
            s.agent_id.is_none() && s.state == SubagentState::Running && s.kind == kind
        })?;
        self.subagents[i].agent_id = Some(agent_id.to_string());
        Some(i)
    }
```

- [ ] **Step 6: Handle `Stop` / `SessionEnd` in `ingest` and add `settle`**

In `ingest`, branch on the event name before the tool match:

```rust
    pub fn ingest(&mut self, ev: &crate::hooks::HookEvent) -> bool {
        match ev.event.as_str() {
            "Stop" | "SessionEnd" => return self.settle(ev),
            _ => {}
        }
        match ev.tool_name.as_deref() {
            Some("Agent" | "Task") => self.on_agent(ev),
            Some("Bash") if ev.run_in_background == Some(true) => self.on_background_bash(ev),
            Some(_) => self.on_tool(ev),
            None => false,
        }
    }

    /// The turn (or session) ended: force every still-running subagent to `Done`
    /// (the turn ending is proof nothing is still running — the "never stuck
    /// running" guarantee) and clear every in-flight tool. Returns whether
    /// anything changed, so an idle `Stop` is correctly a no-op.
    fn settle(&mut self, ev: &crate::hooks::HookEvent) -> bool {
        let mut changed = false;
        for sub in &mut self.subagents {
            if sub.state == SubagentState::Running {
                sub.state = SubagentState::Done;
                if sub.ended_at.is_none() {
                    sub.ended_at.clone_from(&ev.ts);
                }
                sub.current_tool = None;
                changed = true;
            }
        }
        if self.main.current_tool.take().is_some() {
            changed = true;
        }
        changed
    }
```

- [ ] **Step 7: Update existing tests broken by new `Subagent` fields**

`pre_tool_use_agent_starts_running_subagent` builds a full `Subagent { … }` literal — add `agent_id: None, current_tool: None, duration_ms: None,`.
`snapshot_serializes_camel_case` builds a `Subagent { … }` literal — add the same three fields.
`non_tool_events_are_ignored` asserts `!a.ingest(&hook("Stop", None, None))` with no subagents — still true (settle finds nothing → returns false). Leave it.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cargo test -p kriyon-core --lib activity`
Expected: PASS.

- [ ] **Step 9: Run the gate**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add crates/kriyon-core/src/activity.rs
git commit -m "feat(activity): attribute subagent tools and settle on stop"
```

---

## Task 5: Thread the richer snapshot through the watcher

**Files:**
- Modify: `src-tauri/src/watcher.rs` (`ActivitySource::snapshot`, integration test)

**Interfaces:**
- Consumes: `HookActivity::main()`, `SessionActivity.main` from Tasks 3-4.
- Produces: the watcher's emitted `SessionActivity` carries `main` (the main agent's current tool) and settled subagent state. Dedup-on-change is unchanged (the serialized snapshot now includes `main`).

- [ ] **Step 1: Write a failing assertion in the activity integration test**

In `src-tauri/src/watcher.rs`, in `spawn_session_watch_emits_activity_snapshots`, the events file currently writes an Agent `pre` then `post`. Change it to also fire a main-agent tool and a `Stop`, and assert `main.currentTool` is seen then cleared on settle. Replace the events-write + assertions block with:

```rust
        // The hook fires: main runs an Edit (main current tool), spawns an Agent
        // (running), then the turn Stops (settle: main tool cleared, subagent done).
        fs::create_dir_all(&events_dir).expect("mkdir events");
        let edit = r#"{"event":"PreToolUse","session_id":"claude-1","tool_name":"Edit","tool_use_id":"e1","target":"a.rs"}"#;
        let spawn = r#"{"event":"PreToolUse","session_id":"claude-1","tool_name":"Agent","tool_use_id":"t1","subagent_type":"Explore","description":"map"}"#;
        let stop = r#"{"event":"Stop","session_id":"claude-1"}"#;
        fs::write(
            events_dir.join("kriyon-1.jsonl"),
            format!("{edit}\n{spawn}\n{stop}\n"),
        )
        .expect("write events");
```

And update the loop's break condition + assertions so it waits for the settled snapshot:

```rust
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut latest: Option<SessionActivity> = None;
        while std::time::Instant::now() < deadline {
            while let Ok(a) = act_rx.try_recv() {
                latest = Some(a);
            }
            if latest
                .as_ref()
                .is_some_and(|a| a.subagents.first().is_some_and(|s| s.state == SubagentState::Done))
            {
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
        assert!(act.main.current_tool.is_none(), "settle clears main tool, got {act:?}");
        // The task store is folded in too.
        assert_eq!(act.tasks.len(), 1, "got {act:?}");
        assert_eq!(act.tasks[0].text, "wire ui");
        assert_eq!(act.tasks[0].status, TaskStatus::InProgress);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kriyon-app spawn_session_watch_emits_activity_snapshots` (or `cargo test spawn_session_watch_emits_activity_snapshots` from repo root)
Expected: FAIL — `SessionActivity` has no field `main` in `snapshot()` yet (compile error in source).

Note: confirm the `src-tauri` package name with `cargo test spawn_session_watch_emits_activity_snapshots` if `-p` errors.

- [ ] **Step 3: Add `main` to the emitted snapshot**

In `src-tauri/src/watcher.rs`, in `ActivitySource::snapshot`, add `main`:

```rust
        let snapshot = SessionActivity {
            main: self.activity.main(),
            subagents: self.activity.subagents(),
            shells: self.activity.shells(),
            tasks: self.tasks_dir.as_deref().map_or_else(Vec::new, read_tasks),
        };
```

Ensure `SubagentState` is in scope for the test (the test already imports `SubagentState` in `spawn_session_watch_emits_activity_snapshots` via `use kriyon_core::activity::{SessionActivity, SubagentState, TaskStatus};` — it does).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test spawn_session_watch_emits_activity_snapshots`
Expected: PASS.

- [ ] **Step 5: Run the gate**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/watcher.rs
git commit -m "feat(watcher): emit the main agent tool and settled activity"
```

---

## Task 6: Frontend types + shared ticker + label helpers

**Files:**
- Modify: `src/types.ts`
- Create: `src/inspector/activity/useNow.ts`, `src/inspector/activity/useNow.test.ts`
- Create: `src/inspector/activity/toolLabel.ts`, `src/inspector/activity/toolLabel.test.ts`

**Interfaces:**
- Produces:
  - TS types: `ToolActivity { toolName: string; target: string | null; startedAt: string | null }`, `MainAgent { currentTool: ToolActivity | null }`, `Subagent` gains `agentId: string | null; currentTool: ToolActivity | null; durationMs: number | null`, `SessionActivity` gains `main: MainAgent`.
  - `useNow(): number` — current epoch ms, re-rendering subscribers once per second from a single shared interval.
  - `toolLabel(tool: ToolActivity): string` — e.g. "Editing foo.tsx".
  - `elapsedLabel(fromIso: string | null, nowMs: number): string` — e.g. "12s", "1m 3s"; `"—"` when unknown.
  - `durationLabel(ms: number): string` — e.g. "1.3s", "2m 4s".

- [ ] **Step 1: Extend the activity types**

In `src/types.ts`, in the Session-activity block, add and extend:

```ts
/** One tool an agent (main or subagent) is currently running. */
export interface ToolActivity {
  toolName: string;
  target: string | null;
  startedAt: string | null;
}

/** The top-level agent's in-flight tool, if any. */
export interface MainAgent {
  currentTool: ToolActivity | null;
}
```

Extend `Subagent`:

```ts
export interface Subagent {
  agentId: string | null;
  currentTool: ToolActivity | null;
  description: string | null;
  durationMs: number | null;
  endedAt: string | null;
  kind: string;
  result: string | null;
  startedAt: string | null;
  state: SubagentState;
  toolUseId: string;
}
```

Extend `SessionActivity`:

```ts
export interface SessionActivity {
  main: MainAgent;
  shells: BackgroundShell[];
  subagents: Subagent[];
  tasks: Task[];
}
```

- [ ] **Step 2: Write the failing `useNow` test**

Create `src/inspector/activity/useNow.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useNow } from "./useNow.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("re-renders about once per second", () => {
  const { result } = renderHook(() => useNow());
  const first = result.current;
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(result.current).toBeGreaterThan(first);
});

test("two consumers share one interval and stay in sync", () => {
  const a = renderHook(() => useNow());
  const b = renderHook(() => useNow());
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(a.result.current).toBe(b.result.current);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run src/inspector/activity/useNow.test.ts`
Expected: FAIL — cannot find module `./useNow.ts`.

- [ ] **Step 4: Implement `useNow`**

Create `src/inspector/activity/useNow.ts`:

```ts
import { useEffect, useState } from "react";

/**
 * A single 1-second ticker shared by every live-elapsed consumer in the
 * Inspector, so a busy session ticks all running rows off one interval rather
 * than one timer per row. Subscribers re-render together; the interval runs only
 * while at least one consumer is mounted.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function ensureTimer(): void {
  if (timer === undefined) {
    timer = setInterval(() => {
      for (const notify of listeners) {
        notify();
      }
    }, 1000);
  }
}

/** Current epoch milliseconds, refreshed once per second. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const notify = () => setNow(Date.now());
    listeners.add(notify);
    ensureTimer();
    return () => {
      listeners.delete(notify);
      if (listeners.size === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
  return now;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run src/inspector/activity/useNow.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing `toolLabel` tests**

Create `src/inspector/activity/toolLabel.test.ts`:

```ts
import { expect, test } from "vitest";
import type { ToolActivity } from "../../types.ts";
import { durationLabel, elapsedLabel, toolLabel } from "./toolLabel.ts";

function tool(overrides: Partial<ToolActivity>): ToolActivity {
  return { startedAt: null, target: null, toolName: "Edit", ...overrides };
}

test("toolLabel maps a known verb and basenames the target", () => {
  expect(toolLabel(tool({ target: "src/foo.tsx", toolName: "Edit" }))).toBe(
    "Editing foo.tsx"
  );
  expect(toolLabel(tool({ target: "src/bar.ts", toolName: "Read" }))).toBe(
    "Reading bar.ts"
  );
});

test("toolLabel falls back to the tool name with no target", () => {
  expect(toolLabel(tool({ target: null, toolName: "Grep" }))).toBe("Grep");
});

test("elapsedLabel formats seconds and minutes from a start time", () => {
  const start = "2026-06-21T00:00:00.000Z";
  const now = Date.parse(start);
  expect(elapsedLabel(start, now + 12_000)).toBe("12s");
  expect(elapsedLabel(start, now + 63_000)).toBe("1m 3s");
  expect(elapsedLabel(null, now)).toBe("—");
});

test("durationLabel formats sub-minute and minute spans", () => {
  expect(durationLabel(1300)).toBe("1.3s");
  expect(durationLabel(124_000)).toBe("2m 4s");
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `pnpm exec vitest run src/inspector/activity/toolLabel.test.ts`
Expected: FAIL — cannot find module `./toolLabel.ts`.

- [ ] **Step 8: Implement the label helpers**

Create `src/inspector/activity/toolLabel.ts`:

```ts
import type { ToolActivity } from "../../types.ts";

/** Present-tense verb per common tool; falls back to the tool name itself. */
const VERB: Record<string, string> = {
  Bash: "Running",
  Edit: "Editing",
  Grep: "Searching",
  Read: "Reading",
  Write: "Writing",
};

/** The basename of a path-like target, else the target unchanged. */
function basename(target: string): string {
  const trimmed = target.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** "Editing foo.tsx" / "Running" — a short label for an in-flight tool. */
export function toolLabel(tool: ToolActivity): string {
  const verb = VERB[tool.toolName];
  if (!verb) {
    return tool.toolName;
  }
  return tool.target ? `${verb} ${basename(tool.target)}` : verb;
}

/** Live "12s" / "1m 3s" elapsed from an ISO start to `nowMs`; "—" if unknown. */
export function elapsedLabel(fromIso: string | null, nowMs: number): string {
  if (!fromIso) {
    return "—";
  }
  const start = Date.parse(fromIso);
  if (Number.isNaN(start)) {
    return "—";
  }
  return spanLabel(Math.max(0, Math.round((nowMs - start) / 1000)));
}

/** "1.3s" / "2m 4s" — an exact, settled duration from milliseconds. */
export function durationLabel(ms: number): string {
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return spanLabel(Math.round(ms / 1000));
}

/** Whole-second span as "Ns" under a minute, else "Nm Ns". */
function spanLabel(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}
```

- [ ] **Step 9: Run to verify it passes**

Run: `pnpm exec vitest run src/inspector/activity/toolLabel.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the gate**

Run: `pnpm check`
Expected: PASS. (No store change is needed: `applyActivity` stores the whole snapshot opaquely.)

- [ ] **Step 11: Commit**

```bash
git add src/types.ts src/inspector/activity/useNow.ts src/inspector/activity/useNow.test.ts src/inspector/activity/toolLabel.ts src/inspector/activity/toolLabel.test.ts
git commit -m "feat(inspector): add shared ticker and tool label helpers"
```

---

## Task 7: Live elapsed + current-tool line in the Agents panel

**Files:**
- Modify: `src/inspector/activity/AgentsPanel.tsx`
- Modify: `src/inspector/activity/AgentsPanel.test.tsx`

**Interfaces:**
- Consumes: `useNow`, `toolLabel`, `elapsedLabel`, `durationLabel` from Task 6; extended `Subagent` type.
- Produces: each subagent row shows live ticking elapsed while running ("running 12s"), its `currentTool` line when present ("Editing foo.tsx"), and an exact duration when done ("done in 1.3s", falling back to "done · ago").

- [ ] **Step 1: Write the failing tests**

In `src/inspector/activity/AgentsPanel.test.tsx`, extend the `subagent` factory with the new fields and add tests. Update the factory first:

```ts
function subagent(overrides: Partial<Subagent>): Subagent {
  return {
    agentId: null,
    currentTool: null,
    description: null,
    durationMs: null,
    endedAt: null,
    kind: "general-purpose",
    result: null,
    startedAt: null,
    state: "done",
    toolUseId: "tu_1",
    ...overrides,
  };
}
```

Add:

```ts
test("shows a running subagent's current tool line", () => {
  render(
    <AgentsPanel
      subagents={[
        subagent({
          currentTool: {
            startedAt: null,
            target: "src/foo.tsx",
            toolName: "Edit",
          },
          kind: "explorer",
          state: "running",
          toolUseId: "tu_1",
        }),
      ]}
    />
  );

  expect(screen.getByText("Editing foo.tsx")).toBeInTheDocument();
});

test("shows an exact duration for a done subagent", () => {
  render(
    <AgentsPanel
      subagents={[
        subagent({ durationMs: 1300, kind: "reviewer", state: "done" }),
      ]}
    />
  );

  expect(screen.getByText("done in 1.3s")).toBeInTheDocument();
});
```

(The existing tests for kind text, counts, click-to-reveal, and empty state stay as-is.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run src/inspector/activity/AgentsPanel.test.tsx`
Expected: FAIL — "Editing foo.tsx" / "done in 1.3s" not found.

- [ ] **Step 3: Implement the row enrichment**

In `src/inspector/activity/AgentsPanel.tsx`:

Add imports:

```ts
import { useNow } from "./useNow.ts";
import { durationLabel, elapsedLabel, toolLabel } from "./toolLabel.ts";
```

Add a style for the current-tool line (next to `statusStyle`):

```ts
const toolLineStyle: CSSProperties = {
  color: tokens.color.accent,
  fontSize: "11px",
};
```

Replace `statusLabel` so running uses a live `now`, and done prefers the exact duration:

```ts
/** Status line for a subagent row; live elapsed while running, exact when done. */
function statusLabel(subagent: Subagent, now: number): string {
  if (subagent.state === "running") {
    return `running ${elapsedLabel(subagent.startedAt, now)}`;
  }
  if (subagent.durationMs !== null) {
    return `done in ${durationLabel(subagent.durationMs)}`;
  }
  return subagent.endedAt ? `done · ${agoFromIso(subagent.endedAt)}` : "done";
}
```

In `AgentRow`, read the shared tick and render the current-tool line for running agents:

```ts
function AgentRow({ subagent }: { subagent: Subagent }) {
  const [expanded, setExpanded] = useState(false);
  const now = useNow();
  const running = subagent.state === "running";
  const expandable = !running && subagent.result !== null;

  const body = (
    <span style={bodyStyle}>
      <span style={kindStyle}>{subagent.kind}</span>
      {subagent.description == null ? null : (
        <span style={descStyle}>{subagent.description}</span>
      )}
      {running && subagent.currentTool ? (
        <span style={toolLineStyle}>{toolLabel(subagent.currentTool)}</span>
      ) : null}
      <span style={statusStyle}>{statusLabel(subagent, now)}</span>
    </span>
  );
  // …glyph and the rest of the function are unchanged.
```

(The `glyph`, `expandable` branch, and `return` remain unchanged.)

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run src/inspector/activity/AgentsPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the gate**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/inspector/activity/AgentsPanel.tsx src/inspector/activity/AgentsPanel.test.tsx
git commit -m "feat(inspector): live subagent timers and current-tool line"
```

---

## Task 8: Main-agent current-tool line + visible Idle

**Files:**
- Create: `src/inspector/activity/ActivitySection.tsx`, `src/inspector/activity/ActivitySection.test.tsx`
- Modify: `src/inspector/Inspector.tsx`

**Interfaces:**
- Consumes: `SessionActivity`, `MainAgent` types; `useNow`, `toolLabel`, `elapsedLabel`; `AgentsPanel`, `TasksPanel`, `BackgroundPanel`.
- Produces: an `ActivitySection` that renders the main-agent current-tool line (when mid-tool), the existing panels (only when non-empty), and a quiet "Idle" line when nothing is running and there are no subagents/tasks/shells. `Inspector` renders `<ActivitySection activity={activity} />` whenever a session is active.

- [ ] **Step 1: Write the failing tests**

Create `src/inspector/activity/ActivitySection.test.tsx`:

```ts
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { SessionActivity } from "../../types.ts";
import { ActivitySection } from "./ActivitySection.tsx";

function activity(overrides: Partial<SessionActivity>): SessionActivity {
  return {
    main: { currentTool: null },
    shells: [],
    subagents: [],
    tasks: [],
    ...overrides,
  };
}

test("shows Idle when nothing is active", () => {
  render(<ActivitySection activity={activity({})} />);
  expect(screen.getByText("Idle")).toBeInTheDocument();
});

test("shows the main agent's current tool", () => {
  render(
    <ActivitySection
      activity={activity({
        main: {
          currentTool: { startedAt: null, target: "a.ts", toolName: "Edit" },
        },
      })}
    />
  );
  expect(screen.getByText("Editing a.ts")).toBeInTheDocument();
  expect(screen.queryByText("Idle")).not.toBeInTheDocument();
});

test("renders the agents panel and hides Idle when subagents exist", () => {
  render(
    <ActivitySection
      activity={activity({
        subagents: [
          {
            agentId: null,
            currentTool: null,
            description: null,
            durationMs: null,
            endedAt: null,
            kind: "explorer",
            result: null,
            startedAt: null,
            state: "running",
            toolUseId: "tu_1",
          },
        ],
      })}
    />
  );
  expect(screen.getByText("explorer")).toBeInTheDocument();
  expect(screen.queryByText("Idle")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/inspector/activity/ActivitySection.test.tsx`
Expected: FAIL — cannot find module `./ActivitySection.tsx`.

- [ ] **Step 3: Implement `ActivitySection`**

Create `src/inspector/activity/ActivitySection.tsx`:

```tsx
import type { CSSProperties } from "react";
import { tokens } from "../../theme/tokens.ts";
import type { SessionActivity } from "../../types.ts";
import { Section } from "../chrome.tsx";
import { AgentsPanel } from "./AgentsPanel.tsx";
import { BackgroundPanel } from "./BackgroundPanel.tsx";
import { TasksPanel } from "./TasksPanel.tsx";
import { elapsedLabel, toolLabel } from "./toolLabel.ts";
import { useNow } from "./useNow.ts";

const toolNameStyle: CSSProperties = {
  color: tokens.color.accent,
  fontSize: "12.5px",
  fontWeight: 600,
};

const toolTimeStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontSize: "11px",
  marginLeft: tokens.space.sm,
};

const idleStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontSize: "12.5px",
};

/**
 * The Inspector's live activity area: the main agent's in-flight tool, the
 * subagent / task / background panels, and a visible "Idle" line when nothing is
 * running — so "settled to idle" is a state the user can see, not a vanished
 * section.
 */
export function ActivitySection({ activity }: { activity: SessionActivity }) {
  const now = useNow();
  const mainTool = activity.main.currentTool;
  const hasAgents = activity.subagents.length > 0;
  const hasTasks = activity.tasks.length > 0;
  const hasShells = activity.shells.length > 0;
  const idle = !(mainTool || hasAgents || hasTasks || hasShells);

  return (
    <>
      <Section first label="Activity">
        {mainTool ? (
          <div>
            <span style={toolNameStyle}>{toolLabel(mainTool)}</span>
            <span style={toolTimeStyle}>
              {elapsedLabel(mainTool.startedAt, now)}
            </span>
          </div>
        ) : (
          <span style={idleStyle}>{idle ? "Idle" : "Working…"}</span>
        )}
      </Section>
      {hasAgents ? <AgentsPanel subagents={activity.subagents} /> : null}
      {hasTasks ? <TasksPanel tasks={activity.tasks} /> : null}
      {hasShells ? <BackgroundPanel shells={activity.shells} /> : null}
    </>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run src/inspector/activity/ActivitySection.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire `ActivitySection` into the Inspector**

In `src/inspector/Inspector.tsx`:

Replace the three panel imports with the section:

```ts
import { ActivitySection } from "./activity/ActivitySection.tsx";
```

(Remove the now-unused `AgentsPanel`, `BackgroundPanel`, `TasksPanel` imports.)

Replace the trailing conditional panel block:

```tsx
      {activity && activity.subagents.length > 0 ? (
        <AgentsPanel subagents={activity.subagents} />
      ) : null}
      {activity && activity.tasks.length > 0 ? (
        <TasksPanel tasks={activity.tasks} />
      ) : null}
      {activity && activity.shells.length > 0 ? (
        <BackgroundPanel shells={activity.shells} />
      ) : null}
```

with a single always-rendered section (so Idle is visible). A session with no activity snapshot yet shows an empty default:

```tsx
      <ActivitySection
        activity={
          activity ?? { main: { currentTool: null }, shells: [], subagents: [], tasks: [] }
        }
      />
```

- [ ] **Step 6: Run the gate**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 7: GUI verify (manual)**

Run the app, drive a session: confirm the main-agent tool line appears mid-tool with a ticking timer, subagent rows tick and show their current tool, and the area shows "Idle" once the turn settles.

- [ ] **Step 8: Commit**

```bash
git add src/inspector/Inspector.tsx src/inspector/activity/ActivitySection.tsx src/inspector/activity/ActivitySection.test.tsx
git commit -m "feat(inspector): main-agent tool line and visible idle state"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| 1a. Reliability fix (daemon spawn env, drop typed prefix, reattach for free) | Task 1 |
| 1b. Capture `agent_id`, `agent_type`, `duration_ms`, tool `target` | Task 2 |
| 2. Core model: `MainAgent.currentTool`, `ToolActivity`, `Subagent.currentTool/agentId` | Tasks 3-4 |
| 2. Lifecycle: main vs subagent tool attribution, Agent Pre/Post, settle-on-Stop, SessionEnd | Tasks 3-4 |
| 2. Tiering (core never depends on `agent_id`) | Task 4 (`bind_agent` returns `None` → unattributed, core untouched) |
| 3. Correlation by `agent_type` + spawn order (parallel same-type = v1 limit) | Task 4 (`bind_agent`, documented) |
| 3. Frontend: header counts | already built (verified in Task notes) |
| 3. Frontend: subagent row live elapsed + currentTool + click-to-reveal | Task 7 (+ existing click-to-reveal) |
| 3. Frontend: main-agent current tool line | Task 8 |
| 3. Frontend: tasks `n/m` | already built |
| 3. Frontend: one shared 1s timer | Task 6 (`useNow`) |
| 3. Frontend: visible Idle | Task 8 |
| 3. Watcher emits richer snapshot, dedup-on-change | Task 5 |
| Testing: core unit tests per rule; watcher integration; vitest timer + render | Tasks 3-8 |
| CONTEXT.md new terms before use | Task 3 Step 1 |

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — every code step shows the code. Task 2 Step 7 was tightened to the exact final additions.

**3. Type consistency:** Rust `MainAgent.current_tool`/`ToolActivity { tool_name, target, started_at }`/`Subagent.{agent_id, current_tool, duration_ms}` ↔ TS `MainAgent.currentTool`/`ToolActivity { toolName, target, startedAt }`/`Subagent.{agentId, currentTool, durationMs}` (camelCase via serde + matching TS). `useNow(): number`, `toolLabel(ToolActivity): string`, `elapsedLabel(string|null, number): string`, `durationLabel(number): string` are used consistently across Tasks 6-8. `SessionActivity.main` added in Rust (Task 3), watcher (Task 5), and TS (Task 6) with the same shape.

**Note on Task 2 ordering:** adding fields to `HookEvent` forces updating its hand-built test literals in `hooks.rs`, `activity.rs`, and `watcher.rs` in the same commit, or the workspace won't compile. Task 2 does all three so each commit is `pnpm check`-green.
