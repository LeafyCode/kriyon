# Transcript and Claude's output

How Kriyon reads what Claude writes: the transcript file, structured events and the screen.

Part of the Kriyon glossary. The index and the naming rule are in [`CONTEXT.md`](../../CONTEXT.md).

- **Studio event** (`StudioEvent`) — a [Structured event] tagged with a stable `id`
  (`<transcript-line-uuid>:<block-index>`) for idempotent delivery: re-tailing the transcript from
  the start (as `claude --resume` causes) replays the same ids, so the session's event ring dedupes
  by it instead of counting every line twice. No surface renders these — see [Transcript] for what
  they do feed. Keeps the name the Rust and TS types carry.
- **Structured view** (`StructuredView`, `structured_turns`) — a tab showing each turn
  as its prompt (with its images), a folded "What Claude did" (steps, in-between text, "Thought
  for N s") and the reply, marked when the user interrupted it. Replies go through the composer
  under it, which writes to the terminal (ADR-0037). Enabled only while the [Companion state] is `on`, because only the companion's rows are
  exact; history from before it connected is filled from the transcript (following `parentUuid`,
  never file order) and labelled "From transcript". Mounted only for the session on screen. A
  [CLI dialog] is answered in the session's own terminal, shown over it. A slash command the CLI
  runs itself (`/mcp`, `/model`) is a turn of its own: the command, then what it printed.
  A turn background work woke Claude for opens with its [Work report]s in place of a prompt.
- **Work report** (`WorkReport`) — what Claude Code tells the main agent when a piece of
  [In-flight work] finishes, fails, stops or a monitor sees something: a `user` row of
  `<task-notification>` blocks, stamped `origin.kind: task-notification`, that no person typed.
  Reduced to Claude Code's one-line summary, an outcome (`completed | failed | stopped | event |
  update`) and a monitor's event text, and shown in the [Structured view] as a quiet card with an
  outcome icon. Reports that arrive before Claude acts on the last ones share one turn. A
  [Subagent] handing back its final report (a meta `user` row stamped `origin.kind: peer`) is a
  Work report too, named by the description of the `Agent` step that launched it ("Agent "…"
  reported back"); one that only echoes Claude Code's own report for that agent is dropped.
  _Avoid_: task notification, background task.
- **Partial reply** (`PartialReply`, `structured_partial`) — Claude's reply as it streams: the
  newest snapshot of one text block of the main agent's response, posted by the companion's
  `turn.step` hook at most every 250 ms and kept by the daemon in one small file beside the
  [Bridge spool] (replaced, never appended). The [Structured view] draws it under the newest turn
  until the block's row is kept (ADR-0037). _Avoid_: delta, stream chunk (it is a whole snapshot).
- **Spinner tip** (`spinnerTip`, `screenText`) — the tip Claude Code shows under its spinner while
  it works (`  ⎿  Tip: …`), read off the session's own terminal screen and shown under the
  [Structured view]'s working line. Claude Code gives a mod no way to see it and its tips are its own
  text, so Kriyon never copies them: the screen is the one source, and a screen that doesn't match
  shows no tip. A todo list's `Next:` in the same slot is not a tip.
- **CLI dialog** (`useCliDialog`, `watchCliDialog`, `followCliDialog`, `dialogOnScreen`,
  `useDialogDetour`) — Claude Code asking for keys in its own terminal: a question, a permission, a
  plan to approve, an MCP form, or the menu a slash command opens (`/mcp`, `/model`, `/config`,
  `/resume`, `/usage`, …). Known from the screen, where each one ends in a key hint ("… · Esc to
  cancel") or, for a slash command's pane, starts with a rule of `▔` across the terminal,
  read once per beat per session however many watch it; or from a question's or plan's [Pending
  ask] (a permission's ask stays open while the approved tool runs, so it isn't used). The [Structured view]
  doesn't draw it: the session's own terminal shows over the view, in the Raw view's box, until the
  dialog closes; the user can put it aside and come back to it. The composer doesn't send while one
  is open, since its Enter would answer the dialog (ADR-0040). _Avoid_: modal, popup, prompt
  (that's the user's message).
- **Structured event** (`StructuredEvent`) — one parsed unit of the transcript model (prompt /
  assistant text / tool / bash / diff / code / question / usage). Unknown input degrades to
  `StructuredEvent::Unknown { raw }` — parsing never hard-errors. Control/UI/meta transcript lines
  (attachments, mode, titles, tool results) are dropped. **Headless**: no surface renders these
  events; they exist only to derive the facts listed under [Transcript].
- **Transcript schema** (`SUPPORTED_TRANSCRIPT_SCHEMA`) — the version of Claude Code's JSONL
  transcript format the parser is written against; a constant Kriyon bumps deliberately. Pins what
  "current" means so format movement shows up in the log — which, now that nothing renders the
  parsed events, is the only place it shows up at all.
- **Drift report** (`DriftReport`) — counts of [Structured event]s that degraded to `Unknown`
  versus the total parsed, produced alongside the events by the [Drift guard]. A high unknown ratio
  (over a minimum sample) means Claude Code's transcript drifted past the [Transcript schema]
  Kriyon understands, so the facts derived from it thin out (see [Transcript]). Logged once per
  watch, never surfaced in the UI. _Avoid_: parse error, drift count.
- **Drift guard** (`parse_studio_events_guarded`) — the wrapper around the tolerant transcript
  parser that returns the parsed [Studio event]s together with a [Drift report], so format drift is
  logged instead of silently thinning what Kriyon derives from the transcript. Never hard-errors; a
  changed line still degrades to `Unknown`.
- **Transcript** — the session's JSONL file at `~/.claude/projects/<path-with-slashes-as-dashes>/<id>.jsonl`,
  tailed into [Studio event]s. Headless since the structured pane was removed (ADR-0019): nothing
  renders the events, and they exist only to derive — the [Viewed marker]'s `appendSeq`, hence the
  sidebar's unseen-output badges and the [Needs-you section]; the best-effort snippet a `waiting` [Session] shows when it has no exact
  [Pending ask]; the [Handoff prompt]'s digest; the [Session title]; and the live [Claude session id].
- **Clean copy** — copy that rejoins soft-wrapped rows into logical lines (no mid-line breaks),
  using xterm's `isWrapped` and OSC 133 block ranges.
- **Task** — one item in a Session's checklist (Claude Code's `TodoWrite` entry, or a
  `TaskCreate`/`TaskUpdate` entry in newer builds), with text, a `TaskStatus`
  (`pending | in_progress | completed`), and an optional active-form label. The parser maps both
  tool families onto this one term. _Avoid_: todo, checklist item. NB: distinct from the legacy
  `Task` *tool* that spawns a [Subagent] — that maps to Subagent, never to a Task.
- **Event digest** — what a run of a session's [Studio event]s did: files changed (each once,
  in the order first touched), commands run and how many failed, subagents started, and the
  first line of Claude's last reply. Zero-token. The [Turn recap] and the [Handoff prompt] both
  read it (`digestEvents`), so they count the same work the same way. _Avoid_: event summary.
