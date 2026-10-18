# ADR 0019 — Remove the structured pane; keep the transcript pipeline headless

**Status:** accepted · 2026-08-05 · superseded by [ADR-0035](0035-structured-view-from-the-companion.md)

**Supersedes in part:** [ADR-0009](0009-converging-main-session-lock.md),
[ADR-0010](0010-two-main-session-lock-instances.md),
[ADR-0015](0015-session-baseline-changes-model.md)

## Context

Kriyon shipped a **Structured** transcript tab — the Studio pane — that
reconstructed the conversation from Claude Code's JSONL transcript and redrew it
as prompt / assistant / tool / bash / diff / code bubbles, with a Thinking
indicator, read-only question cards, an "answer in the terminal" banner, a resume
hint, a per-turn changed-files chip, and a catch-up banner.

Every one of those things sat beside a **real PTY terminal already showing the
same conversation**, correctly, live, in Claude Code's own layout. That is the
asymmetry the pane never escaped:

- **It could only ever be second-best at its own job.** The repo's own stance
  (AGENTS.md, `PRODUCT.md`, ADR-0015's rejection of touched-file gating) is that
  the terminal is the source of truth and the reconstruction is best-effort.
  A best-effort copy of a surface the user can see in full, one tab away, has no
  reading for which it is the better one.
- **Its cost was not best-effort.** Fourteen block components, a catch-up
  digest, an optimistic prompt-echo reconciliation path, a resume-hint state
  machine, and their tests — plus five store slices (`pendingPrompts`,
  `processing`, `resumeHint`, `catchUpBrief`, and the `preChangesView` layout
  field) whose only consumer was the pane.
- **It was a live liability for the freeze invariant.** Per the [DOM weight]
  rule, the number that drives the macOS WebKit stall is document size across
  every mounted pane. The structured pane put an unbounded, per-event React
  subtree next to every terminal, on the same document the [Warm pane] cap
  exists to bound.
- **Two features had already moved off it.** The [Changes view] (ADR-0015)
  answers "what did this session do" from git, not from replayed tool calls, and
  the [Needs-you section] / [Pending ask] answer "what does it want" from hook
  events. Those are the two questions the pane was actually being opened for,
  and both are now answered better elsewhere.

## Decision

**Delete the structured pane and every block, banner, and store slice that only
it used. Keep the transcript parsing pipeline, unchanged, as a headless
derivation layer.**

- `TranscriptView` becomes `"changes" | "raw"`. The header toggle is
  **Changes | Raw**; the palette command is "Toggle Changes / Raw view". A
  persisted `"studio"` degrades to `"raw"` rather than failing the layout parse.
- `preChangesView` is gone — with two values there is no third view to restore,
  so leaving Changes always returns to Raw.
- The catch-up brief is removed as a feature, not relocated. `unseenEvents` and
  `awayMs` leave `src/state/viewedMarker.ts` with it; `appendSeq` / `ms` /
  `tasksDone` stay, because the [Needs-you section] and the sidebar age fold read
  them.
- `src/studio/links.ts` moves to `src/terminal/links.ts` (clickable paths and
  URLs survive — in the terminal, which is where the output is).
  `src/studio/handoffPrompt.ts` moves to `src/spawn/handoffPrompt.ts`, and
  `completedTasks` moves into `src/state/viewedMarker.ts`.
- `layout.view` (`studio | focus | command | prompts | …`) is **unaffected**. It
  names the *shell layout* — sidebar + inspector versus the focus rail — and has
  nothing to do with the transcript pane that shared the word.

## What stays, and why

The Rust side is untouched: `transcript.rs`, `parse_studio_events_guarded`,
`StructuredEvent`, `StudioEvent`, the [Drift report], and the `watch_transcript`
command all keep running. Nothing renders their output. They are kept because
four shipped facts are derived from them and from nowhere else:

1. **Token / context / cost totals** — the transcript sum behind the
   [Usage snapshot] (see [Session usage view]).
2. **Unseen-output badges** — the monotonic `appendSeq` the [Viewed marker]
   stamps, which the [Needs-you section] and the sidebar age fold read.
3. **The Needs-you snippet** — the best-effort last-assistant-text tier a
   `waiting` session falls back to when it has no exact [Pending ask].
4. **The [Handoff prompt]** — the zero-token digest seeded into a
   [Follow-up session].

Plus the [Session title] (`ai-title`), the live [Claude session id] used by
`claude --resume`, and `progress_summary`, which shapes the [Status] line before
a hook has fired.

**The never-hard-error rule therefore still holds.** An unknown transcript line
must still degrade to `StructuredEvent::Unknown`, and the [Drift guard] must
still never throw. The blast radius changed — drift now thins four derived
numbers instead of blanking a visible pane — but a hard error would still take
down a live session's watch.

## Consequences

- **The catch-up brief, the question cards, and the optimistic prompt echo went
  with the pane.** The brief had no other host. The question cards were
  read-only and routed to the terminal to answer, so their whole value was
  "notice, then go to the terminal" — which the [Needs-you section], the
  [Needs-you overlay], and OS notifications already do, from anywhere, including
  when the app is closed. The prompt echo was solving latency in a pane that no
  longer exists; the terminal echoes a keystroke immediately by construction.
- **Kriyon has no place left to say "the conversation, but nicer."** That is the
  point, and it should stay that way. A future request to reconstruct the
  transcript for display should be read as a request to reopen this ADR, not as
  a feature.
- **The drift report is now log-only.** Nothing on screen degrades visibly when
  Claude Code's format moves, so `watch_route`'s log line is the only signal a
  bump to [Transcript schema] is due. Its wording no longer claims a view is
  degraded.
- **The headless pipeline is now load-bearing but invisible**, which is a
  testing hazard: a regression in `parse_studio_events_guarded` shows up as a
  wrong cost number or a stale unseen badge, not as a blank pane. The
  `kriyon-core` transcript tests are the guard, and they are no longer backstopped
  by anyone noticing on screen.
- **One consumer, not two, now depends on the [Main session lock] serving the
  structured view** — see the amendments on ADR-0009 and ADR-0010. The lock and
  its agreement test are unaffected: `HookActivity` still needs it for
  [Session activity], and `StatusTracker` still needs it for [Status].
- Documentation swept in the same change: `AGENTS.md`, `PRODUCT.md`,
  `CONTEXT.md`, `FEATURES.md`, `CHANGELOG.md`, and the Rust doc comments in
  `commands.rs`, `watch_route.rs`, and `watcher.rs`.

## Considered and rejected

- **Keep the pane, shrink it to a summary strip.** A smaller reconstruction is
  still a reconstruction with the same trust problem, and it would keep the
  per-event React subtree the [DOM weight] rule exists to bound.
- **Keep the catch-up brief, rehosted on the sidebar or the Inspector.** Its
  digest is genuinely zero-token and genuinely useful, but "what happened while I
  was away" is answered concretely by the [Changes view] (what changed on disk)
  and the [Needs-you section] (what wants me), both of which are live rather than
  a snapshot taken at activation. Rehosting it would have been a new surface, not
  a rescue — and this ADR is about removing surfaces.
- **Delete the transcript pipeline too.** Rejected outright: the four facts
  above have no other source. `watch_transcript` is not display plumbing; it is
  how Kriyon knows what a session costs, what it is called, and whether the user
  has seen its output.
