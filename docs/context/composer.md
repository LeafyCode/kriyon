# Composer and prompts

Writing to Claude: the composer, attachments, prompt history and saved prompts.

Part of the Kriyon glossary. The index and the naming rule are in [`CONTEXT.md`](../../CONTEXT.md).

- **Attachment** (`Attachment`, `AttachmentRegistry`, `attachment.rs`) — a file, folder or image
  the user adds to a composer message: from the picker, a paste, or a drop on the window. Sent the
  way the CLI's own input takes one — an image as a bracketed paste of its path (Claude Code makes it
  `[Image #N]`), anything else as an `@` mention (ADR-0037). Its path is *admitted* by Rust before
  the UI sees it; the UI names an attachment only by an admitted path. _Avoid_: upload (nothing is
  uploaded; Claude Code reads the file).
- **Pasted image** — an image the user pasted that had no file of its own (a screenshot), saved
  owner-only under the app's data folder and kept 30 days so the [Structured view] can still show it.
- **Attachment caution** (`caution`) — the plain-words reason an [Attachment] may not reach Claude as
  meant: an image over 8000 px, or a format Claude can't view. Shown on its chip; never blocks.
- **Taken-back prompt** — a prompt the composer sent that Claude never started on before the user
  pressed Esc. The CLI puts it back in its own input; Kriyon moves it, with its [Attachment]s, back
  into the composer and clears the CLI's copy (ADR-0037).
- **Prompt history** (`prompt_history`, `recent_prompts`) — the prompts sent in a folder, newest
  first, each once: what the composer's Up/Down walks, the CLI's way (Up on the first line, Down on
  the last, and back to the draft past the newest). Read from Claude Code's own
  `~/.claude/history.jsonl`, so it holds prompts typed in the terminal and sent from the composer
  alike, long pastes put back as their text. _Avoid_: recents, prompt library (that's saved prompts).
- **Sent prompt** (`useSentPrompts`, `sentSettled`) — the prompt the composer just wrote to a
  session's terminal, shown at once in the [Structured view] with "Claude is working…" until the
  companion's own row for it is read (a few seconds later). Kept, so Esc can take it back, until it
  settles: Claude started on its turn, a [CLI dialog] it opened closed, or two minutes passed. It
  settles in whichever view is on screen. Never sent anywhere; a stand-in only.
  _Avoid_: Studio pane (the removed ADR-0019 view), conversation view.
- **Saved prompt** (`SavedPrompt`) — one reusable prompt in the user's global prompt
  library: title, body, tags, favourite flag, use count, last-used time. Persisted in
  the app's SQLite store; can be [Promote]d to a slash command. _Avoid_: snippet,
  template, prompt (ambiguous with the user's own typed input — see [Composer draft]).
- **Prompt picker** — the ⌘⇧P overlay for the prompt library: search → highlight
  (preview) → fill [Placeholder]s → insert into the [Composer draft]. Enter inserts,
  never sends; the library never writes to PTY stdin. Mutually exclusive with the
  command palette, Spawn dialog, and [Needs-you overlay]. _Avoid_: prompt palette
  (ambiguous with the command palette).
- **Placeholder** — a `{name}` slot in a [Saved prompt]'s body, filled via inline
  argument fields in the [Prompt picker] at insert time; the reserved `{clipboard}`
  resolves silently from the pasteboard. _Avoid_: variable, argument.
- **Promote** — writing a [Saved prompt] as a `.claude/commands/<name>.md` file (global
  `~/.claude/commands/` or a [Project (Workspace)]'s `.claude/commands/`) so it becomes
  a real Claude Code slash command. One-way and explicit; the inverse is the import
  verb that reads existing command files into the library. _Avoid_: export, sync.
- **Composer draft** — the per-[Session] unsent text in the composer (PromptBar), held
  in a shared store so the [Prompt picker] can insert into it. Unsent by definition: once
  it is sent it belongs to the PTY, and Kriyon keeps no echo of it. _Avoid_: draft
  buffer, input text.
- **Prompt library view** (`PromptsView`) — the persistent "Prompts" top-nav destination:
  the full-page home to browse, search, and manage every [Saved prompt] with visible
  controls. Distinct from the [Prompt picker], the transient summon-and-insert overlay.
  One `layout.view` value (the shell layout) alongside Studio / Focus / Command. _Avoid_: prompt manager,
  library page, dashboard.
- **Prompt row actions** (`PromptRowActions`) — the shared cluster of visible controls
  (insert, favourite, edit, delete) rendered on each [Saved prompt] row in both the
  [Prompt library view] and the [Prompt picker], so no action is keyboard-only. _Avoid_:
  row toolbar, action bar.
