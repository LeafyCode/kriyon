# Prompt Library — Management & Discoverability

Date: 2026-07-04
Status: Approved
Follows: `2026-07-03-prompt-library-design.md` (the v1 keyboard-only library)

## Why

Live QA of the shipped v1 surfaced a discoverability gap and one functional bug:

- The library is reachable **only** via the ⌘⇧P picker and ⌘K palette verbs. There is no
  visible entry point, no persistent list, and no way to browse or manage prompts. A user
  who doesn't know the hotkey cannot find their prompts at all.
- In the picker, **favourite / edit / delete are keyboard-only** (⌘F / ⌘E / ⌘⌫). There is
  no on-screen cue that these actions exist, and mouse users are stuck.
- **`{clipboard}` resolves to empty.** The picker reads the pasteboard with
  `navigator.clipboard.readText()`, which rejects in the packaged WKWebView; the
  `.catch(() => "")` swallows it, so `{clipboard}` silently inserts nothing. This also
  violates the architecture rule that the Rust core owns all OS access.
- **⌘⇧P is reported as intermittently not opening the picker.** To be reproduced and
  root-caused (candidate: xterm consumes the chord while the terminal is focused; or the
  borderless window loses key-window status).

## What it is

A persistent **Prompt library view** — a new **Prompts** top-nav destination (4th item
after Studio / Focus / Command) that lists every [Saved prompt] with visible, clickable
management controls. The ⌘⇧P [Prompt picker] stays as the fast "summon → insert
mid-session" launcher; both surfaces read the one `promptLibrary` store and share the same
row-action controls. Plus the two bug fixes above.

Positioning: the tab is the **home** (browse + manage), the picker is the **quick
launcher** (insert without leaving Studio) — the Raycast pattern of a launcher plus a
manage page.

## Scope decisions

- **New `"prompts"` value in `layout.view`** (`src/state/sessions.ts`), routed in
  `Shell.tsx` like the other views. Persisted, so a restart can reopen the tab.
- **Every action is a visible clickable control** on both surfaces: insert, favourite
  (toggle), edit, delete. Keyboard shortcuts continue to work on top; nothing becomes
  shortcut-only.
- **Reuse, don't rebuild.** The tab reuses the existing `PromptEditor` dialog for
  New / Edit / Promote / Delete, the existing import command, `placeholders`, the
  `promptLibrary` store, and the `drafts` store. One new shared component
  (`PromptRowActions`) is justified by its two callers (tab + picker).
- **Insert from the tab targets the active [Session]'s [Composer draft]** (never sends),
  and toasts "Inserted into the session draft". With no active session the insert control
  is disabled with a tooltip ("Open a session to insert").
- **Clipboard read moves to Rust.** A `read_clipboard` Tauri command replaces
  `navigator.clipboard.readText()`.

## Domain terms (add to CONTEXT.md before naming code)

- **Prompt library view** (`PromptsView`) — the persistent "Prompts" tab: the full-page
  home to browse, search, and manage every [Saved prompt]. Distinct from the [Prompt
  picker] (the transient summon-and-insert overlay). One `layout.view` value.
  *Avoid:* prompt manager, library page, dashboard.
- **Prompt row actions** (`PromptRowActions`) — the shared cluster of visible controls
  (insert, favourite, edit, delete) rendered on each [Saved prompt] row in both the
  [Prompt library view] and the [Prompt picker]. *Avoid:* row toolbar, action bar.

## Frontend

### Prompt library view — `src/prompts/PromptsView.tsx`

Rendered by `Shell.tsx` when `layout.view === "prompts"`. Structure (theme tokens only,
mirroring `CommandCenter`'s panel styling):

- **Header row:** title "Prompts" + primary actions **[+ New]** (opens `PromptEditor` with
  no seed) and **[Import from /commands]** (invokes the existing import command; toasts
  counts).
- **Search input:** filters over title / tags / body (reuse the picker's filter predicate;
  extract it to `placeholders.ts` or a small `filterPrompts` helper so both surfaces share
  one implementation).
- **List:** all prompts, ordered favourites-first then frecency (reuse `orderPrompts`).
  Each row shows the title, a favourite ★, tag chips, and a `PromptRowActions` cluster.
- **Empty state:** reuse `EMPTY_LIBRARY_COPY`.
- **Selection/preview:** optional right-hand preview of the highlighted prompt with
  accent-highlighted [Placeholder]s (reuse `PreviewPane`). MVP may show the body inline per
  row instead; preview pane is nice-to-have, not required.

### Shared row actions — `src/prompts/PromptRowActions.tsx`

A small presentational component: **⤵ Insert · ★/☆ Favourite · ✎ Edit · ⌫ Delete**
(delete is two-click armed, reusing the existing `deleteArmedId` convention). Props are
callbacks (`onInsert`, `onToggleFavourite`, `onEdit`, `onDelete`) plus `favourite` and
`insertDisabled`. Used by both `PromptsView` rows and `PromptPicker` rows. No store access
inside — the parent wires the callbacks, keeping it testable in isolation.

### Picker enhancements — `src/prompts/PromptPicker.tsx`

- Render `PromptRowActions` on each row (always visible), wired to the same store actions
  the ⌘F/⌘E/⌘⌫ handlers already call. Keyboard handlers stay.
- Add a one-line hint/legend under the list (e.g. "Enter insert · ⌘F favourite · ⌘E edit").

### View routing & state

- Add `"prompts"` to the `layout.view` union and `setView`'s type in `sessions.ts`; add the
  nav item in `Shell.tsx`'s segmented control and the `view === "prompts"` branch.

## Data & backend

### `read_clipboard` command (fixes `{clipboard}` empty)

- New Tauri command `read_clipboard() -> Result<String, String>` in `src-tauri/src/commands.rs`,
  reading the pasteboard via the Tauri clipboard-manager plugin (or `arboard`), registered
  in `lib.rs`, with a thin binding in `src/ipc/bridge.ts`.
- `PromptPicker.insertPrompt` awaits `bridge.readClipboard()` instead of
  `navigator.clipboard.readText()` when the body needs `{clipboard}`. On error it inserts
  with an empty `{clipboard}` **and** shows a toast ("Couldn't read the clipboard") — no
  silent failure. The existing re-entrancy guard and active-session check are preserved.
- No new table; no schema change.

## ⌘⇧P reliability (bug)

Reproduce first (systematic-debugging) with a live, focused terminal, then fix the actual
cause. Leading candidate: xterm's `attachCustomKeyEventHandler` (`Terminal.tsx`) returns
`true` for the app's reserved chords, so xterm may consume/curry them while focused. Fix by
returning `false` from that handler for the app-reserved chords (⌘⇧P, ⌘K, ⌘⇧K) so they
propagate to the existing `window` keydown listeners. If the cause is instead the
borderless window's key-window status, address at the window/focus layer. Add a regression
test at whatever layer the root cause lives.

## Error handling

Backend failures surface via the existing Toast. Import already reports per-file skips and
never fails the batch. Clipboard read failure degrades to empty **with** a toast. The
`PromptsView` is wrapped in the shell's existing `ErrorBoundary` ("This view crashed.").

## Testing (TDD throughout)

- **Rust:** `read_clipboard` round-trips a set value (guarded/mocked where the CI has no
  pasteboard).
- **Frontend:**
  - `PromptsView`: renders all prompts favourites-first; search filters title/tags/body;
    each row action fires the right store call; **Insert** writes the active session's
    draft and never sends; insert disabled with no active session; **+New** opens a blank
    editor; **Import** runs; empty-library copy.
  - `PromptRowActions`: each button invokes its callback; delete is two-click armed;
    favourite reflects state.
  - `PromptPicker`: row actions now clickable and wired; keyboard shortcuts still work;
    `{clipboard}` resolves via the mocked `bridge.readClipboard` (and toasts on error).
  - `ui.ts` / `sessions.ts`: `"prompts"` view routes and persists.
- **Real-app verify** (per the QA harness): ⌘⇧P opens the picker with a live focused
  terminal; `{clipboard}` inserts real pasteboard text on a physical click; the Prompts
  tab lists, favourites, edits, deletes, and inserts.
- `pnpm check` green before every commit.

## Out of scope (YAGNI)

Folder hierarchies, drag-reorder, bulk select, per-project overlay libraries, in-app
versioning, a second inline editor (the dialog is reused), and quick-insert number
shortcuts. All have clean later paths.
