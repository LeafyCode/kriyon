# Actionable Needs-you — pending asks + catch-up briefs

- **Status:** Accepted
- **Date:** 2026-07-02
- **Register:** design spec

## 1. Problem

A user running many Sessions across projects finds out *which* session needs them by
reading every terminal. Kriyon already answers "who is blocked" (Needs-you rail,
`NeedsYouNav`, OS notifications) but not the two questions that actually cost attention:

1. **What does it want?** A `waiting` standing doesn't say whether the session is asking
   a multiple-choice question, requesting a permission, waiting on plan approval, or just
   finished a turn with a prose question.
2. **What was it doing?** Refocusing a session after 20 minutes means re-reading
   scrollback to rebuild context.

Market research (2026-07-02) suggests these two pains are still open in the tools we
looked at: they surface *that* an agent is blocked, but we did not find one that
reconstructs *the ask* or compresses the human's context resume. Both fit Kriyon's stated purpose: the
attention layer over the real CLI.

## 2. Decisions locked during brainstorming

| Decision | Choice |
|---|---|
| Direction | Actionable inbox (over session-lifecycle verbs and review queue) |
| Surface | Both: enrich the Needs-you rail **and** a global summonable overlay (⌘⇧K) |
| Catch-up brief source | Deterministic digest from parsed events (no AI call, no tokens) |
| Ask coverage | Full set, tiered: exact (question / permission / plan approval) + best-effort snippet fallback |
| Answering | Never injected. Jumping to the Raw view is the action; the terminal stays the only input path |

## 3. Vocabulary (to be added to CONTEXT.md before implementation)

- **Pending ask** (`PendingAsk`) — the concrete thing a `waiting` [Session] wants from
  the user: a `question` (from `AskUserQuestion`), a `permission` (from a permission
  prompt), a `plan_approval` (from `ExitPlanMode`), or a `snippet` (fallback: the last
  assistant text). Carries `askedAt` and a **tier** — `exact` for the first three,
  `best_effort` for `snippet` — shown honestly in the UI. Derived and ephemeral, never
  persisted (same rule as [Session activity], ADR 0003). _Avoid_: request, prompt
  (ambiguous with the user's prompt).
- **Catch-up brief** (`CatchUpBrief`) — a deterministic digest of what a [Session] did
  since the user last focused it: files edited (up to 3 names + total), commands run,
  [Task]s completed, [Subagent]s run, the last assistant snippet, and the current
  [Pending ask]. Computed on focus from already-parsed events; zero storage, zero
  tokens. _Avoid_: recap, summary (ambiguous with Claude's own summaries).
- **Needs-you overlay** — the ⌘⇧K-summonable panel rendering the same enriched list as
  the [Needs-you rail], reachable from any view. Keyboard-navigable; Enter focuses the
  selected [Session]. _Avoid_: inbox (glossary already reserves this avoidance),
  notification center.

## 4. Architecture

### 4.1 Pending ask derivation (kriyon-core)

New pure module (proposed `crates/kriyon-core/src/ask.rs`), same shape as `activity.rs`:
a lifecycle state machine fed by [Hook event]s, with the transcript as best-effort
fallback. Hooks are the live, authoritative source (the established architecture bet —
CC does not write the transcript reliably live).

Lifecycle:

| Signal | Effect |
|---|---|
| `PreToolUse(AskUserQuestion)` | open `question`; ask text extracted from `tool_input` (the questions JSON) |
| `PreToolUse(ExitPlanMode)` | open `plan_approval` |
| `Notification` (permission prompt) | open `permission`; text from the hook message |
| matching `PostToolUse` | clear (answered) |
| `Stop`, `SessionEnd`, next user prompt | clear — the settle guarantee: an ask can never outlive the turn it belongs to |
| session `waiting` with no open exact ask | `snippet` from the last assistant transcript event (truncated), tier `best_effort` |

One open ask per session (the newest wins; an exact ask replaces a snippet, never the
reverse). `tool_input` parsing is tolerant: any shape drift degrades the ask to
`snippet` tier — never an error (drift-guard philosophy).

Delivery: the watcher attaches the current `PendingAsk` (or none) to the existing
per-session state it already emits; the frontend store folds it into
`SessionStanding`-adjacent state. No new event channel; no persistence.

### 4.2 Catch-up brief (frontend, pure function)

- Per-session `lastFocusedAt`, tracked in the frontend session store (frontend already
  tracks the focused session via `focusSync` for notification suppression; this adds a
  timestamp on blur/switch). Not persisted; app restart starts fresh.
- `buildCatchUpBrief(events, since): CatchUpBrief` — a pure function over the session's
  already-parsed StudioEvents plus current [Session activity]: counts and names as
  defined in §3. Computed once on focus, O(events since `since`).
- Rendering: a dismissible banner atop the [Studio view] (same pattern and placement as
  [Resume hint]), shown only when `now − lastFocusedAt > 5 min` **and** at least one
  qualifying event landed since. Dismiss = gone until the next qualifying refocus.

### 4.3 Surfaces

**Needs-you list** (one shared component, two hosts):

Entry layout per [Session standing] with state `awaiting_input`:

```
[ask icon]  Ask text, one line, truncated            blocked 12m
            project · branch · what-it-was-doing line
```

- Ask icon by type (question / permission / plan / snippet); `best_effort` tier rendered
  visibly quieter (no false precision).
- "What it was doing" reuses the sidebar's existing `sessionContext` summary line.
- Ordered longest-blocked first (`askedAt` ascending; fallback `lastChangeMs`).
- Click / Enter: focus the session; when the ask is `exact`, land on the [Raw view]
  (the existing [Awaiting-input banner] affordance) so answering happens in the
  terminal. Never inject keystrokes.

**Hosts:**

1. **Needs-you rail** (Command center): entries upgrade from dot+title to the rich
   layout above. Everything else in the Command center is unchanged.
2. **Needs-you overlay**: ⌘⇧K from any view; ↑↓ to select, Enter to jump, Esc to close.
   Registered alongside the ⌘K palette; visually a sibling of it (restraint: no new
   chrome language). Empty state: "No session needs you." — the calm win condition.

Sidebar `NeedsYouNav` (count + cycle) is unchanged.

### 4.4 Degradation & staleness

- Ask reconstruction failing (unparseable `tool_input`, unknown hook shape) degrades to
  `snippet` tier or a plain waiting entry — never errors, never hides the session.
- A stale standing (`unknown` via [Standing staleness]) leaves the Needs-you list
  (which gathers only `awaiting_input` standings) — the session stays visible with
  the honest `unknown` treatment in the Command center body, never with a
  confidently wrong ask.
- The brief renders whatever events exist; zero events since focus = no banner.

## 5. Error handling

All new core logic is total: every input path (hook payloads, transcript lines,
timestamps including clock jumps) returns a value, never panics, never hard-errors —
matching `parse_studio_events_guarded` and `activity.rs`. Frontend components render
empty/absent data as absence, not error states.

## 6. Testing (TDD, per repo rules)

**kriyon-core (`ask.rs`)** — failing tests first:
- open/clear lifecycle per signal table (each row a test), including: PostToolUse clears
  only the matching ask; Stop clears everything; exact replaces snippet but not vice
  versa; newest-wins.
- tolerant `tool_input` extraction: valid AskUserQuestion payload → question text;
  malformed → `snippet` tier degradation.
- `askedAt` ordering and clock-jump tolerance.

**Frontend:**
- `buildCatchUpBrief` unit tests: counts, 3-name cap, snippet extraction, empty-delta →
  no brief, threshold gating.
- Needs-you list/overlay via the `window.__kriyon` QA seam + Playwright with fake store
  data: rich entry rendering per ask type and tier, ordering, ⌘⇧K open → ↑↓ → Enter
  focuses the right session, Esc closes, empty state.

**Integration:** one watcher-level test that a synthetic hook sequence (PreToolUse
AskUserQuestion → snapshot → PostToolUse) round-trips the ask through the emitted state.

## 7. Out of scope (explicitly)

- Answering asks from the structured view (keystroke injection stays forbidden).
- AI-generated prose briefs (`claude -p`) — the brief's layout leaves room for an
  optional prose line later, but nothing is built for it now.
- Session-lifecycle verbs (spawn/handoff/worktree bootstrap) and the cross-project
  review queue — candidate follow-on arcs from the same research.
- Mobile/remote surfaces.

## 8. Open risks

- **Permission-prompt Notification payloads** vary across CC versions; the message text
  may be generic ("Claude needs your permission to use Bash"). Acceptable: type + tool
  name is still more than today's bare `awaiting_input`. Verify payload shapes against
  the current CC version during implementation.
- **`lastFocusedAt` is in-memory only** — after an app restart every session's first
  focus shows no brief (no baseline). Acceptable for v1; persisting it is a one-column
  follow-up if it stings.
- **Snippet fallback needs the transcript** — for a `waiting` session whose transcript
  lags, the entry may briefly show no ask text. The tier system makes this honest
  rather than wrong.
