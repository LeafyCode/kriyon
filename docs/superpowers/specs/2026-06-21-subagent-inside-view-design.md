# Subagent inside-view — design

Date: 2026-06-21 · Branch: `feat/session-activity`

## Problem

The Inspector's Agents panel now tracks subagents correctly (spawn → running →
done, with counts, a live current-tool line, and a click-to-reveal final
result). But clicking a subagent only reveals its final result text. The user
wants to **look inside a running or finished subagent** — see what it is actually
doing: its task, its reasoning, the tools it ran, and its result — the way the
main Studio view shows the top-level conversation.

## Research: what's reliably available (investigated before design)

Investigated against real on-disk data from live runs:

| Question | Finding |
|---|---|
| Does a subagent write its own transcript? | **Yes.** At `~/.claude/projects/<encoded-cwd>/<main-session-id>/subagents/agent-<agentId>.jsonl` — a full conversation: task prompt, assistant reasoning, tool calls, result. (NOT at the `transcript_path` the hook reports — that path is never written for subagents, which is why an earlier check came up empty.) Documented behavior in Claude Code `sub-agents.md`. |
| Can we correlate a subagent transcript to its panel row exactly? | **Yes, exactly.** A sidecar `agent-<agentId>.meta.json` holds `{"agentType","description","toolUseId"}`. `toolUseId` is the Agent spawn's `tool_use_id` — the panel row key. So `toolUseId → agentId` is authoritative: no type+order heuristic, and the parallel same-type caveat disappears. |
| Is the deep reasoning in the hook stream or main transcript? | **No.** Internal tool events carry only `agent_id` + the main `session_id`; the main transcript has zero `isSidechain` lines. The reasoning lives only in the dedicated subagent transcript. |
| Written live or at completion? | **Unconfirmed.** The file holds the subagent's whole run when present. The design tolerates both: re-read while expanded; the hook-driven current-tool line covers the in-flight moment regardless. |

There is no `parent_tool_use_id` in any hook payload (confirmed against the
hooks reference); the `meta.json` sidecar is the only authoritative link, and it
is sufficient.

## Approach

Read each subagent's **dedicated transcript file** and render it with Kriyon's
**existing** transcript parser and Studio block components. Clicking a subagent
row expands to a compact, in-place Studio view of that subagent's own
conversation, loaded on demand.

Rejected alternatives: a tool-timeline reconstructed only from hook events
(strictly less than the real transcript, which we now know exists); filtering
sidechain lines out of the main transcript (there are none — subagents are
separate files); streaming every subagent transcript continuously through the
activity snapshot (IPC bloat — lazy load-on-click instead).

This keeps the established split: **hooks are the live status source**
(current-tool line, running/done), the **transcript is the deep view** —
mirroring how the main session already works.

## Section 1 — Core path + correlation (kriyon-core, pure)

New pure helpers in `crates/kriyon-core` (unit-tested, no IO except the command
layer):

- Path derivation from the main transcript path Claude reports
  (`…/<cwd>/<main-session>.jsonl`):
  - `subagents_dir(main_transcript: &Path) -> Option<PathBuf>` →
    `…/<cwd>/<main-session>/subagents`.
  - `subagent_transcript_path(main_transcript, agent_id) -> Option<PathBuf>` →
    `…/subagents/agent-<agent_id>.jsonl`.
  - `subagent_meta_path(main_transcript, agent_id) -> Option<PathBuf>` →
    `…/subagents/agent-<agent_id>.meta.json`.
  Each returns `None` if the main path has no usable stem/parent (tolerant).
- `is_valid_agent_id(id: &str) -> bool` in `daemon.rs` (sibling to
  `is_valid_session_id`): non-empty, ASCII-hex only. Gates every `agent-<id>`
  path construction (trust boundary — `agent_id` crosses Rust↔JS).
- `SubagentMeta { agent_type, description, tool_use_id }` (serde camelCase) +
  `parse_subagent_meta(json: &str) -> Option<SubagentMeta>` — tolerant, `None`
  on malformed input.

## Section 2 — Exact `agentId` on each Subagent (watcher)

Today `Subagent.agentId` is bound by the type+order heuristic from internal tool
events (fuzzy for parallel same-type). Replace that with the authoritative
`meta.json` mapping:

- `ActivitySource` learns the subagents dir from the first hook event carrying a
  non-empty `transcript_path` (the same `observe_hook` that already binds the
  task-store dir from `session_id`).
- Each snapshot, it reads the small `agent-*.meta.json` files in that dir into a
  `toolUseId → agentId` map and sets each `Subagent.agentId` exactly (matched by
  the subagent's `toolUseId`). The internal-tool-event binding (`bind_agent`)
  remains only as a fallback when meta is not yet on disk, so the live
  current-tool line becomes exact whenever meta exists — directly resolving the
  same-type caveat.
- This makes `agentId` the reliable handle the frontend passes to fetch the deep
  view. Snapshot dedup is unchanged (the serialized snapshot just carries a
  correct `agentId`).

## Section 3 — Lazy deep-view command (commands.rs + IPC)

- `AppState` gains `transcript_paths: Mutex<HashMap<SessionId, PathBuf>>`. The
  watcher surfaces the main `transcript_path` once via a new `on_transcript_path`
  callback (mirroring `on_claude_id`; driven by a `TranscriptSource::
  take_transcript_path()` accessor), and `watch_transcript` stores it.
- New command `read_subagent_view(session_id, agent_id) -> Result<Vec<StudioEvent>, String>`:
  1. Validate `agent_id` with `is_valid_agent_id` (reject otherwise). `session_id`
     is the trusted AppState key (lookup IS the validation).
  2. Resolve the main transcript path from `transcript_paths` for that session;
     derive `subagent_transcript_path`. If unknown/missing → `Ok(vec![])` (not an
     error): the subagent transcript may not be on disk yet.
  3. Read the file, `flat_map(parse_studio_events)` over its lines, return the
     `StudioEvent`s (same parser + stable ids as the main Studio view).
- `bridge.ts`: `readSubagentView(sessionId, agentId): Promise<StudioEvent[]>`,
  `hasTauri()`-guarded to resolve `[]` outside Tauri (matching `watchTranscript`).

## Section 4 — Frontend: reusable renderer + deep expand

- **Extract the renderer.** `renderEvent` is currently private in
  `StudioView.tsx`. Lift it into a store-free presentational component
  `StudioEventList({ events }: { events: StudioEvent[] })` under `src/studio/`,
  and have `StudioView` use it (DRY; no behavior change to the main view). The
  block components (`Prompt`/`Text`/`Tool`/`Bash`/`Diff`/`Code`/`Question`) are
  already pure and prop-driven; live-only chrome (Thinking/ResumeHint/
  AnswerInTerminal) is not part of this list.
- **Deep expand in `AgentRow`.** A subagent row is expandable whenever it has an
  `agentId` (running *or* done — you can watch progress, not just read results).
  On expand, call `readSubagentView(sessionId, agentId)` using the
  `ReviewPanel` phase pattern (`idle | loading | loaded | error`) and render the
  result with `StudioEventList` in a compact, indented well (tokens:
  `surface.s1` fill, `line.soft` border, `marginLeft` indent). While the
  subagent is still `running`, re-fetch on the shared 1s `useNow` tick and
  replace the list (stable ids make this idempotent). Empty result → a quiet
  "Starting…/No detail yet" line; fall back to the existing raw `result` text if
  the transcript isn't available.

## Error handling / tolerance

Every layer degrades, never panics: malformed `meta.json` → `None`; missing
subagents dir/file → empty events; unknown transcript lines → `Unknown` (existing
parser discipline); invalid `agent_id` → command error (rejected at the trust
boundary); transcript not yet written → empty view with the live current-tool
line still showing.

## Testing

- `kriyon-core` unit tests (TDD, failing-first): path derivation
  (`subagents_dir`/`subagent_transcript_path`/`subagent_meta_path`),
  `is_valid_agent_id` (accept hex, reject `..`/`/`/empty/non-hex),
  `parse_subagent_meta` (valid + malformed).
- Watcher test: a snapshot sets `Subagent.agentId` exactly from a `meta.json` on
  disk (incl. two parallel same-type subagents correlated correctly).
- Command test: `read_subagent_view` returns parsed `StudioEvent`s for a written
  subagent transcript, `Ok(vec![])` for a missing one, and an error for an
  invalid `agent_id`.
- Vitest: `StudioEventList` renders each event kind from props (store-free);
  `AgentRow` expand → calls the bridge → renders events → refetches while running
  (fake timers).
- `pnpm check` green before every commit.

## Out of scope (v1)

- Nested subagents that spawn their own subagents (rare; the dir is flat per
  `agent_id`, so each still renders standalone).
- A full-panel takeover (option C) — inline expand only for v1.
- Guaranteeing live mid-run updates if Claude Code flushes the subagent
  transcript only at completion (the hook current-tool line covers in-flight).
- Persisting subagent views across app restarts (re-fetched on demand).

## Terms (CONTEXT.md)

New names to add before coding: **Subagent transcript** (`agent-<id>.jsonl`),
**Subagent meta** (`SubagentMeta`, the `agent-<id>.meta.json` sidecar linking
`toolUseId`↔`agentId`), **Subagent inside-view** (the in-place Studio render of a
subagent's transcript), **`StudioEventList`** (the store-free Studio renderer).
