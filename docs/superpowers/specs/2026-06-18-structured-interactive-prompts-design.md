# Surfacing interactive prompts in the Studio view

- **Date:** 2026-06-18
- **Branch:** `feat/session-activity` (work continues here or a new `feat/structured-prompts`)
- **Status:** Design — approved direction, pending spec review

## Problem

Kriyon hosts the real `claude` CLI in a PTY. When Claude needs the user to
answer something interactive, that prompt renders only in the **Raw view**
(the terminal). The **Studio view** (the structured reconstruction) shows
nothing, so a user working in Studio can be silently blocked — Claude is
waiting, and there is no sign of it in the structured pane.

Three concrete cases, in order of how cleanly Claude exposes them:

1. **`AskUserQuestion`** — Claude's own multiple-choice question tool.
2. **Permission prompts / generic waits** — "allow this tool?", idle notices.
3. **The resume "compress & summarize vs continue as it is" prompt** — shown
   by the CLI when resuming a session whose context is large.

## What Claude actually exposes (researched, CLI 2.1.181)

This is the constraint that shapes the whole design. Verified against current
docs and by empirical probing (forked `claude --resume`, transcript and hook
inspection):

- There is **no structured channel** for these prompts when hosting the raw
  CLI in a PTY. No CLI flag pre-answers them; `stream-json` control protocol is
  undocumented/unstable and would mean replacing the terminal entirely (it is
  how the VS Code/JetBrains extensions do it, via the SDK `canUseTool`
  callback — not viable for a terminal wrapper, and contradicts Kriyon's
  "terminal is the source of truth" premise).
- **`AskUserQuestion`** *is* recorded structurally: the assistant message in
  the **transcript** carries a `tool_use` block named `AskUserQuestion` whose
  `input.questions` holds the full `{ question, header, multiSelect, options:
  [{ label, description }] }` array. Kriyon's transcript parser already sees
  this block (it currently collapses it to a generic `Tool`).
- **Permission prompts** fire a `PermissionRequest` hook; idle waits fire a
  `Notification` hook. Both already map to `SessionStatus::waiting`
  (`crates/kriyon-core/src/hooks.rs:130`).
- **The resume prompt has no signal at all.** It is not a tool, not in the
  transcript, and fires no hook (a forked resume emitted only `SessionStart`).
  It is TUI-only by design.

## Approach

**Detect structurally where Claude gives us a signal; never inject keystrokes;
always route the user to the Raw terminal to answer.** The Studio affordance is
a best-effort convenience — exactly the role the architecture assigns the
Studio view — and the Raw terminal remains the guaranteed way to respond. Because
nothing injects input, nothing this feature does can corrupt a session.

| Prompt | Detection signal | Studio treatment |
|---|---|---|
| `AskUserQuestion` | `tool_use` block in the transcript (structured) | Rich read-only **Question** card showing the question(s) + options, with "Answer in terminal →" |
| Permission / generic wait | `PermissionRequest` / `Notification` hook → existing `waiting` status | **Awaiting-input banner** at the foot: "Claude needs your input — Answer in terminal →" |
| Resume compress/summarize | none | Dismissible **resume hint** shown after every resume until the first turn starts |

### Response mechanism (shared by all three)

Studio and Raw are mutually exclusive views toggled by
`layout.transcriptView` (`"studio" | "raw"`, `src/state/sessions.ts:39`). The
"Answer in terminal →" action:

1. calls `setTranscriptView("raw")` (`src/state/sessions.ts:279`), and
2. focuses the session's xterm instance.

No keystrokes are ever written to the PTY by this feature.

## Components

### Rust core — `crates/kriyon-core/src/transcript.rs`

- Add a `Question` structured event:
  ```rust
  StructuredEvent::Question { questions: Vec<Question> }
  // Question { header: String, question: String, multi_select: bool,
  //            options: Vec<QuestionOption> }
  // QuestionOption { label: String, description: String }
  ```
  `option.preview` and other fields are ignored (YAGNI). Serialize with
  `kind = "question"`; mirror in `kind_str()`.
- In `map_tool_use` (`transcript.rs:266`), dispatch `name == "AskUserQuestion"`
  → parse `input.questions` into `Question`. **On any missing/malformed field,
  fall back to the existing generic `Tool` mapping** — never hard-error, never
  panic (honours the parser's total-function contract).
- Tests (TDD, written first): a real `AskUserQuestion` line → one `Question`
  event with the right options; a malformed `AskUserQuestion` input → `Tool`
  (not a panic, not `Unknown`); an unrelated tool is unaffected.

The `waiting` status path is unchanged — it already exists and already covers
permission/notification.

### Frontend types — `src/types.ts`

- Add `Question` + `QuestionOption` interfaces and the `{ kind: "question";
  questions: Question[] }` arm to the `StructuredEvent` union (mirrors Rust).

### Frontend — Studio view

- **`src/studio/blocks/Question.tsx`** (new): renders the question card —
  each question's `header`/`question` and its options (label + description) as
  read-only rows, plus a primary "Answer in terminal →" button wired to the
  shared response action. Styling from `src/theme/tokens.ts` only.
- **`src/studio/StudioView.tsx`**: add `question` to `renderEvent`
  (`StudioView.tsx:29`) → `<Question … />`. The card renders inline in the
  event stream like every other block (it is part of the scrollback record).
- **Awaiting-input banner**: upgrade the existing Thinking-indicator footer
  (`StudioView.tsx:138`, `src/studio/blocks/Thinking.tsx`). When
  `status === "waiting"`, the footer becomes actionable: the existing
  "Waiting for you" copy gains an "Answer in terminal →" button (shared action).
  When status leaves `waiting`, it reverts to today's behaviour.
- **Resume hint**: a small dismissible banner shown in Studio when the session
  was resumed (`claudeSessionId` present at launch) and no turn has started yet.
  Copy: "Resumed session — if Claude asks how to continue, answer in the
  terminal →". Dismissed on click, on first `running` status, or on first new
  prompt. Tracked by a per-session boolean in the store; no scraping.

### Response action — terminal focus

- Add a `setTranscriptView("raw")` call plus a focus of the active session's
  xterm. The `Terminal` component already keys off an `active` prop
  (`src/terminal/Terminal.tsx:142`); expose/relay a focus call through the
  existing `sessionHost` (the same module that owns the xterm handle) so Studio
  can request focus without reaching into the terminal directly.

## "Pending" signal for the Question card

Two independent, simple signals — no new tool_result correlation needed in v1:

- The **Question card** is part of the scrollback; it is always shown once
  parsed. Its "needs answering now" emphasis is driven by it being the latest
  meaningful event with no `assistant`/`prompt` event after it.
- The **awaiting-input banner** is driven solely by `status === "waiting"`.

If experience shows AskUserQuestion does not reliably move status to `waiting`
(it may report `running` via its `PreToolUse` hook), the refinement is to
clear the Question's pending emphasis when a later `assistant`/`prompt` event
arrives — handled in the store's `appendEvent` (`src/state/sessions.ts:233`),
not the parser. Noted as a refinement, not v1 scope.

## Non-goals (YAGNI)

- **No keystroke injection** and no auto-answering of any prompt.
- **No terminal-output scraping** — including for the resume prompt.
- **No `stream-json` / Agent-SDK migration.** Kriyon keeps hosting the raw CLI.
- **No editable answer UI in Studio.** Options render read-only; answering
  happens in the Raw terminal.
- No handling of `option.preview`, multi-question layout polish, or animations
  beyond what existing tokens give for free.

## Terminology (add to `CONTEXT.md` before coding)

- **Question** (`StructuredEvent::Question`) — a structured event reconstructed
  from an `AskUserQuestion` tool call: one or more multiple-choice questions
  Claude is asking the user.
- **Awaiting-input banner** — the actionable footer shown in the Studio view
  while a Session's `Status` is `waiting`, routing the user to the Raw view to
  respond.
- **Resume hint** — the dismissible Studio banner shown after resuming a past
  Session, pointing the user to the Raw view in case Claude asks how to
  continue.

## Testing

- **Rust (first):** transcript parser tests for `Question` mapping and the
  malformed-input fallback (above).
- **Frontend:** `Question.tsx` renders questions/options; clicking "Answer in
  terminal" sets `transcriptView` to `"raw"`; the awaiting-input banner appears
  iff `status === "waiting"`; the resume hint shows for a resumed session and
  dismisses on first turn. Follow existing `*.test.tsx` patterns
  (`src/studio/StudioView.test.tsx`).
- `pnpm check` green before every commit.

## Open / refinement items

- Confirm whether `AskUserQuestion` reports `waiting` vs `running`; pick the
  pending-emphasis signal accordingly (store-level, per above).
- Confirm xterm focus-on-active behaviour; add an explicit focus relay if
  `active` alone does not focus.
