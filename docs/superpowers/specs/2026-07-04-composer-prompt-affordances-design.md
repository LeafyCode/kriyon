# Composer Prompt Affordances

Date: 2026-07-04
Status: Approved
Follows: `2026-07-04-prompt-library-management-design.md`

## Why

The prompt library is now browsable (Prompts tab) and insertable (⌘⇧P picker), but
two everyday actions are still missing from where the user actually works — the
composer:

- **You can't save what you're writing.** The only "save a prompt" path is the
  hidden ⌘K palette verb "Save last prompt…", which captures the last *sent*
  prompt from the transcript. A user who has just composed a good prompt (and not
  yet sent it) has no way to save it as a reusable [Saved prompt].
- **The library is invisible from the composer.** There is no affordance in or
  near the input to open the [Prompt picker], and the ⌘⇧P shortcut is surfaced
  only inside the ⌘K palette. A user typing a message has no cue that a prompt
  library exists or how to reach it.

## What it is

Two small controls in the composer's footer row (`PromptBar`, the left cluster
that today holds only a non-interactive "Session ▾" chip + usage text):

1. **`✦ Save prompt`** — opens the existing [Prompt editor] dialog seeded from
   the **current composer draft**, so the user adds tags / tweaks the title and
   saves. Reuses the whole existing save + tag + scope flow. Disabled when the
   draft is empty.
2. **`Prompts ⌘⇧P`** — a button that opens the [Prompt picker]
   (`openPromptPicker()`), with a ⌘⇧P keycap beside it: one-click access **and**
   it teaches the shortcut.

Both are client-only and reuse existing components. No store change, no IPC, no
backend.

## Decisions

- **Save captures the current draft.** The Save button seeds the editor with
  `{ body: draft, title: firstLine(draft, 60), tags: [] }` (no `id` ⇒ a new
  [Saved prompt]). `firstLine` = the draft's first line, trimmed to 60 chars —
  the same title heuristic the existing "Save last prompt…" verb uses. The user
  fills tags and edits the title in the editor before saving.
- **Save is disabled on an empty draft.** Enabled only when the draft has
  non-whitespace text; disabled state is dimmed with the tooltip
  "Type a message to save it as a prompt".
- **Tagging reuses the editor's existing field** (the "tags, comma, separated"
  input). No chips/autocomplete — YAGNI.
- **The library affordance is a button with a keycap** (not a bare hint). The
  keycap renders **⌘⇧P** including the shift glyph, so the displayed shortcut
  matches the real chord exactly.
- **The ⌘⇧P chord is unchanged.** Not switched to ⌘P — bare ⌘P risks colliding
  with the webview/OS Print shortcut, and ⌘⇧P is already wired + tested. The
  keycap just shows the shift so nothing is misleading.
- **The existing "Save last prompt…" palette verb stays.** It captures the last
  *sent* prompt; this feature adds the *draft* path. Both coexist.

## Frontend

### `src/ui/Kbd.tsx` (new)

A tiny presentational keycap atom — there is no shared one today; the same
keycap recipe (`rgba(255,255,255,0.07)` bg, `borderRadius: 5px`, mono, ~11px,
`ink.dim`) is copy-pasted as `kbdStyle` (Shell), `escStyle` (CommandPalette),
and the palette `sub` cap. `Kbd` renders `children` in that keycap. It is a
generic UI atom like `Segmented`/`Toast`, so it needs no CONTEXT.md term.
Signature: `Kbd({ children }: { children: ReactNode })`. Used by the new ⌘⇧P
hint. (Restyling the existing three keycap sites to adopt `Kbd` is out of
scope — `Kbd` is used going forward.)

### `src/layout/PromptBar.tsx` (modify)

- Import `useUi` for `openPromptPicker` and `openPromptEditor` (not currently
  imported).
- In the footer left cluster (currently the "Session ▾" chip + usage label), add:
  - **Save prompt** button: `disabled` when `value.trim() === ""`; on click,
    `useUi.getState().openPromptEditor({ body: value, tags: [], title: value.split("\n")[0].slice(0, 60) })`.
    `value` is the live draft PromptBar already reads from `useDrafts`.
  - **Prompts** button: on click, `useUi.getState().openPromptPicker()`; renders
    a `<Kbd>⌘⇧P</Kbd>` beside its label.
- Styling uses theme tokens only, matching the footer's existing chip styling.
  The Send button on the right is unchanged.

## Testing (TDD)

- **`Kbd`**: renders its children inside a keycap element.
- **`PromptBar`**:
  - The **Prompts** button opens the picker (`useUi.getState().promptPickerOpen`
    becomes true / `openPromptPicker` fires) and displays the ⌘⇧P keycap.
  - The **Save prompt** button seeds the editor from the current draft — after a
    non-empty draft, clicking it sets `promptEditorSeed` to
    `{ body: <draft>, title: <first line ≤60>, tags: [], id: undefined }`.
  - The **Save prompt** button is disabled when the draft is empty/whitespace and
    firing it does nothing.
- `pnpm check` green before every commit.

## Out of scope (YAGNI)

Tag chips / autocomplete; restyling the existing Shell/palette keycaps to use
`Kbd`; changing the ⌘⇧P chord to ⌘P; a composer button to insert a *specific*
prompt (the picker already handles selection); saving without opening the editor
(a one-click quick-save with no title/tags).
