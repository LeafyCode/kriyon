# Prompt Library — Design

Date: 2026-07-03
Status: Approved

## What it is

A personal, global library of saved prompts, summoned with **⌘⇧P** from anywhere in the
app: type to filter, Enter **inserts into the composer (never sends)**, Esc dismisses.
Save/favourite/tag/edit happen in the same surface. Two interop verbs bridge to Claude
Code's own system: *promote to slash command* (writes `.claude/commands/<name>.md`) and
*import from commands* (solves the empty-library cold start).

Positioning: Paste's summon–search–insert loop plus Raycast's placeholder model, layered
over the slash commands Claude Code already has — never competing with them. The library
is the GUI over the user's existing command files plus the lighter-weight paste layer
they lack.

## Research grounding (why these choices)

Evidence-ranked capabilities from prior-art research (Paste, Raycast, Alfred, espanso,
VS Code snippets, Copilot prompt files, Cursor forum, Claude Code issues #4209/#31155,
Ask HN 42325485):

1. Keyboard-summoned picker with fuzzy filter → insert into the focused session's input,
   unsent (the #1 explicit ask across seven Cursor forum threads).
2. Placeholders filled at insert time (Raycast `{argument}` model).
3. Flat collections + tags — every loved tool avoids folder trees.
4. Global library visible in every session (top Claude Code scoping complaint).
5. Interop with `.claude/commands/` — users' existing prompt library *is* those files.
6. Capture from usage ("save what I just sent"), not authoring in forms.

Feature graveyard (deliberately excluded): folder hierarchies, in-app versioning UI,
keyword auto-expansion, prompt marketplaces, metadata forms at save time.

## Scope decisions

- **Global library, tags for categorization. No boards, no folders.** A project name can
  be a tag; tags cover categorization.
- **Insert into the composer draft, never `writeStdin` directly, never auto-send.**
  Matches the "never inject keystrokes" rule and the universal insert-then-edit ask.
- **Placeholders in v1, minimal set:** `{name}` named arguments (inline fill fields in
  the picker, Tab between, Enter inserts resolved text) and `{clipboard}` (resolves
  silently). No date math, no modifiers, no keyword expansion.
- **Capture from usage:** a "Save last prompt…" verb pre-fills the editor from the most
  recent prompt sent in the active session; title defaults from its first line.
- **Skipped (YAGNI):** starter gallery, versioning UI, team sharing, ⌘1–9 quick-insert,
  per-project overlay libraries. All have clean later paths.

## Domain terms (add to CONTEXT.md before naming code)

- **Saved prompt** (`SavedPrompt`) — one reusable prompt in the library: title, body,
  tags, favourite, use count, last-used. *Avoid:* snippet, template.
- **Prompt picker** — the ⌘⇧P overlay: search → highlight (preview) → fill placeholders
  → insert into the composer draft. *Avoid:* prompt palette (ambiguous with Command
  palette).
- **Placeholder** — a `{name}` slot in a Saved prompt's body, filled inline at insert
  time; `{clipboard}` resolves from the pasteboard.
- **Promote** — writing a Saved prompt as a `.claude/commands/<name>.md` file so it
  becomes a real slash command. One-way, explicit.
- **Composer draft** — the per-session unsent text in the composer, lifted to a shared
  store so the Prompt picker can insert into it. *Avoid:* pending prompt (that's the
  already-sent optimistic echo).

## Data & backend

New SQLite table in `src-tauri/src/store.rs` via the existing idempotent `init_schema`:

```sql
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  favourite INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_ms INTEGER,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
)
```

- `PromptRow` struct (`#[serde(rename_all = "camelCase")]`), mirroring `SessionRow`.
- Store helpers: `upsert_prompt`, `list_prompts`, `delete_prompt`, `record_prompt_use`.
- Tauri commands of the same names in `commands.rs` (typed args, `Result<_, String>`),
  registered in `lib.rs`, thin bindings in `src/ipc/bridge.ts`, `SavedPrompt` type in
  `src/types.ts`.
- `promote_prompt_to_command(scope, name, body)` and `import_commands(scope)`:
  - `scope` is `global` (`~/.claude/commands/`) or a project id resolving to
    `<project>/.claude/commands/`.
  - `name` is validated (slug charset) and the final path is contained under the
    commands dir (the IPC trust-boundary rule).
  - Import parses frontmatter `description` when present; unknown content degrades
    gracefully — never hard-errors. Import reports per-file skips, never fails the
    batch.

## Frontend

- **`src/state/promptLibrary.ts`** — new zustand store: `prompts`, hydrated at boot
  (extend `persistence.ts` `hydrate()`); writes go through explicit bridge calls per
  action (save/edit/delete/use). Exposed on `window.__kriyon` via `qaHook.ts`.
- **Shared composer draft (the one new seam):** lift `PromptBar`'s local `useState`
  draft into a per-session `drafts: Record<SessionId, string>` slice so the picker can
  insert at the caret and focus the composer. `PromptBar` becomes a consumer; send
  behavior unchanged (including the 80 ms `\r` split).
- **`src/prompts/PromptPicker.tsx`** — overlay copying `CommandPalette`'s structure and
  `SpawnDialog`'s panel styles (theme tokens only):
  - pre-focused search; filter over title/body/tags; ↑↓ + Enter; Esc closes.
  - default order: favourites first, then frecency (use_count + recency).
  - right-side preview of the highlighted prompt, placeholders highlighted.
  - row actions: ⌘F favourite, ⌘E edit, ⌘⌫ delete (confirm).
  - selecting a prompt with placeholders swaps the search bar for argument fields
    (Tab between, Enter inserts resolved text). `{clipboard}` resolves silently.
- **`src/prompts/PromptEditor.tsx`** — small dialog: title + multiline plain-text body +
  tags. No other metadata.
- **`src/prompts/placeholders.ts`** — pure functions: parse placeholders from a body,
  resolve them with provided values (unit-testable without UI).
- **`ui.ts`:** `promptPickerOpen` joins the mutual-exclusivity group (palette / spawn /
  needs-you / picker — opening one closes the rest). ⌘⇧P global hotkey follows the
  palette's own-listener pattern.
- **Palette verbs** in `buildItems`: "Insert prompt…", "Save last prompt…".

## Error handling

Backend failures surface via the existing Toast. Promote refuses to overwrite an
existing command file unless confirmed. Import/promote path-containment failures are
hard errors (trust boundary); malformed command files are per-file skips.

## Testing

TDD throughout (failing test first):

- Rust: store round-trip tests (upsert/list/delete/use-count), promote/import
  path-containment and slug-validation tests, frontmatter-tolerant import tests.
- Frontend: placeholder parse/resolve unit tests; draft-store insert behavior;
  picker filtering/ordering/keyboard tests; editor save flow; mutual-exclusivity
  in `ui.ts`; component tests mirroring `SpawnDialog`'s.
- `pnpm check` green before every commit.
