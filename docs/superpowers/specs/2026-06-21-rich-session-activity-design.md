# Rich, reliable session activity — design

Date: 2026-06-21 · Branch: `feat/session-activity`

## Problem

After the session/daemon rewrite, the right-side Inspector stopped showing
subagents and tasks. When Claude spawns parallel `Task` subagents, the activity
panels (`src/inspector/activity/{AgentsPanel,TasksPanel,ListPanel}.tsx`) stay
empty. The goal is a **rich, stable** activity view on par with Claude Code
desktop: reliable live tracking of subagents and tasks (spawn → running → done)
that always settles to idle — not best-effort.

## Root cause (investigated before design)

The activity pipeline has four boundaries; evidence at each:

| Boundary | Verdict | Evidence |
|---|---|---|
| Claude Code hook fires on tool/subagent | healthy | Headless `KRIYON_SESSION=x claude -p "spawn a Task"` writes `PreToolUse`+`PostToolUse` for `Agent` with `tool_use_id`, `subagent_type`, `session_id`. |
| Watcher → `session-activity` event | healthy | `spawn_session_watch_emits_activity_snapshots` passes. |
| Frontend wiring | healthy | `session-activity` event name matches; `applyActivity` → `state.activity[id]` → Inspector selector all key on the Kriyon session id. |
| **`claude` carries `KRIYON_SESSION`** | **broken** | The live persisted session had a `claude` transcript in its cwd but **no `events/<id>.jsonl`** → that `claude` ran without the env gate. A sibling session *did* get an events file → **intermittent**. |

The Kriyon hook is **env-gated on `KRIYON_SESSION`** (so normal `claude` usage is
untouched). `launchClaudeOnce` set that gate by typing `KRIYON_SESSION=<id> claude\r`
as a **single combined keystroke write** into the freshly-booting daemon shell —
the same unreliable pattern commit `1557e87` fixed for the PromptBar but left here.
The env prefix is intermittently dropped (paste-detection / shell still
initialising), so `claude` launches **bare**: no `KRIYON_SESSION` → the hook never
fires → no events file → the watcher has nothing to emit → empty panels. The
hooks, watcher, and frontend are all healthy; they are simply never fed.

A secondary manifestation: commit `fe53c30` ("don't relaunch claude on reattach")
means a reattached session never re-establishes the gate either, so a surviving
daemon whose `claude` has exited shows a bare shell with no activity.

## Approach

Extend the existing **hook-driven** activity core (`kriyon-core/activity.rs`).
Hooks fire live and are proven reliable; this keeps the terminal as the source of
truth and the structured view as a best-effort reconstruction. Rejected
alternatives: driving from the transcript (CC 2.1.x does not write it live — the
exact regression that forced hooks); a hooks+transcript hybrid (more moving parts,
YAGNI for v1).

Richer detail is built entirely from fields Claude Code **already sends** in the
hook payload but Kriyon currently discards.

## Section 1 — Foundation: reliable events + richer capture

### 1a. Reliability fix (the regression)

Set `KRIYON_SESSION=<id>` in the **daemon's spawn environment**, exactly as
`ZDOTDIR` is set today: insert it into the `SpawnSpec.env` map built in
`create_session` (`src-tauri/src/commands.rs`). `spawn_daemon` already forwards
`spec.env` onto the daemon process, and the daemon's `CommandBuilder` inherits the
full parent env (`crates/kriyon-ptyd/src/pty.rs`), so every `claude` launched in
that session's shell — by `launchClaudeOnce`, manually, or after a reattach —
inherits the gate.

`launchClaudeOnce` (`src/terminal/sessionHost.ts`) drops the `KRIYON_SESSION=… `
typed prefix and sends just `claude` / `claude --resume <id>`. Hook firing is then
independent of paste/timing, and the reattach hole closes with no extra code (the
surviving shell already carries the env from when it was first spawned).

`KRIYON_SESSION` is not one of the stripped Claude-identity vars
(`is_agent_identity_var`), so it is preserved.

### 1b. Capture the fields we currently drop

Extend `kriyon-hook.py` (`src-tauri/src/hooks.rs::HOOK_SCRIPT`) and the
`HookEvent` struct (`kriyon-core/src/hooks.rs`) — all new fields optional and
tolerant:

- `agent_id`, `agent_type` — attributes an internal tool to its subagent
  (absent/empty ⇒ the main agent).
- `duration_ms` — exact tool duration on `PostToolUse`.
- a tool **target** derived from `tool_input` (`file_path`, else a short command
  summary) → "Editing Foo.tsx".

No new hook events are registered for v1: `Agent` Pre/Post + `Stop` already give
spawn / done / settle.

## Section 2 — Core data model + lifecycle

In `kriyon-core/activity.rs` (pure logic, unit-tested; serialized camelCase):

```
SessionActivity {
  main:      MainAgent          // top-level agent's in-flight tool
  subagents: [Subagent]
  shells:    [BackgroundShell]  // unchanged
  tasks:     [Task]             // unchanged
}

MainAgent { currentTool: ToolActivity? }

ToolActivity { toolName, target?, startedAt }

Subagent {
  toolUseId,        // the Agent spawn call — stable identity
  agentId?,         // runtime id, bound lazily for tool attribution
  kind, description?,
  state,            // Running | Done
  currentTool?,     // its latest in-flight tool (enrichment)
  startedAt?, endedAt?, result?
}
```

**Lifecycle rules** (fold each hook event, in order):

- `Agent` **PreToolUse** → push `Subagent{ Running, startedAt }` (instant spawn
  feedback, with `description`).
- Tool **PreToolUse** *with* `agent_id` → set that subagent's `currentTool`;
  *without* `agent_id` → set `main.currentTool`.
- Tool **PostToolUse** → clear the matching `currentTool`.
- `Agent` **PostToolUse** → subagent `Done`, `endedAt`, `result`, clear its
  `currentTool`.
- **Stop** (main turn ends) → **settle**: any still-`Running` subagent whose
  Agent-Post never arrived is forced to `Done`; clear `main.currentTool`. This is
  the "never stuck running" guarantee — the turn ending is proof nothing is still
  running.
- **SessionEnd** → clear to idle.

**Tiering for robustness.** The *core* (spawn list, states, timers, results,
settle) depends only on `Agent` Pre/Post + `Stop` — zero dependence on `agent_id`.
`currentTool` per subagent is **enrichment** layered on top, so imperfect
correlation never corrupts the core view.

## Section 3 — Correlation + frontend

### `agent_id` correlation (enrichment only)

Internal tool events carry `agent_id` + `agent_type` but no link to the spawning
`Agent` tool_use_id. Bind **by type + spawn order**: keep a per-`agent_type` queue
of un-bound Running subagents; the first time a new `agent_id` of type T appears,
bind it to the oldest un-bound subagent of type T.

- Distinct types, or sequential same-type → exact.
- Parallel **same-type** subagents → a `currentTool` may attach to the wrong
  sibling of the *same kind*. Accepted v1 limit: spawn list, counts, states, and
  results stay correct; only which identical-kind sibling shows a given tool may
  swap. Documented, not silently wrong.

### Frontend (`src/inspector/activity/*`, `Inspector.tsx`)

- **Header summary** on the Agents panel: `3 running · 2 done`.
- **Subagent row:** kind + description, state badge, **live elapsed**
  ("running 12s"), `currentTool` line ("Editing Foo.tsx"), **click-to-expand**
  result when Done.
- **Main-agent current tool:** a slim line at the top of the activity area,
  visible whenever the main agent is mid-tool.
- **Tasks:** add `n/m done` progress. **Shells:** unchanged (hooks carry no shell
  output).
- **Timers:** one shared 1s interval in the frontend ticks elapsed for all running
  rows off `startedAt`. The Rust watcher still emits **only on dedup'd change** (as
  today), so a busy session never spams IPC.
- **Idle:** when nothing is running and there are no tasks/shells, the activity
  area collapses to a quiet "Idle" line rather than vanishing — so "settled to
  idle" is a visible state.

Design values come from `src/theme/tokens.ts`; no hardcoded colors/spacing.

## Testing

- `kriyon-core` unit tests (TDD, failing-first) for every lifecycle rule: spawn,
  running, main vs subagent tool attribution, settle-on-Stop for an orphaned
  Running subagent, correlation by type+order, dedup on unchanged snapshot.
- Watcher integration test extended to assert the richer `SessionActivity`
  (`currentTool`, settle).
- Vitest for the frontend timer tick and click-to-reveal; render-from-store.
- `pnpm check` green before every commit.

## Out of scope (v1)

- Per-sibling exactness for parallel same-type subagent tool attribution.
- Background-shell live output (hooks carry none).
- Nested subagents spawning their own subagents (rare; tracked flat by `agent_id`).
- `SubagentStop` hook registration (Agent-Post + Stop already cover done/settle).

## Terms (CONTEXT.md)

New type/field names to confirm in `CONTEXT.md` before coding: `MainAgent`,
`ToolActivity`, `currentTool`, `agentId`/`agentType`, "settle".
