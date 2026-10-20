# Prompt Library — Management & Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the prompt library a visible, browsable/manageable **Prompts** nav tab with clickable row actions on both the tab and the ⌘⇧P picker, fix `{clipboard}` inserting empty, and fix unreliable ⌘⇧P.

**Architecture:** One `promptLibrary` store already backs the picker; the new `PromptsView` tab and the picker both read it and share one presentational `PromptRowActions` cluster. Clipboard reads move from `navigator.clipboard` (rejects in the packaged WKWebView) to a Rust `read_clipboard` command via `arboard`. ⌘⇧P reliability is fixed at the xterm key-handler layer so app-reserved chords propagate to the existing `window` listeners.

**Tech Stack:** React 19 + Zustand + TypeScript (Vitest/jsdom/@testing-library), Tauri v2 + Rust (`arboard`), theme tokens in `src/theme/tokens.ts`.

## Global Constraints

- **Shared checkout** `/Users/dev/Projects/kriyon`, branch **`feat/session-lifecycle`**. It holds unrelated WIP from other live sessions. **Stage named files only — never `git add -u`/`-A`.** Never touch `crates/kriyon-ptyd/*`, `src/terminal/*` (except the one ⌘⇧P handler in Task 10), `PRODUCT.md`, `public/fonts/`.
- **TDD**: failing test first → watch it fail → minimal implementation → green. `pnpm check` green before every commit.
- **Never hand-format.** Run `pnpm fix` before committing. Rust: clippy pedantic (`-D warnings`).
- **Theme tokens only** (`src/theme/tokens.ts`) — no hardcoded colors/spacing.
- **Conventional commits**, small and frequent. `--no-verify`/force-push are hook-blocked.
- Domain terms already in `CONTEXT.md`: **Prompt library view** (`PromptsView`), **Prompt row actions** (`PromptRowActions`).
- Verify single frontend file: `pnpm exec vitest run <path>`. Rust: `cd src-tauri && cargo test <name>`.

## File structure

- **Modify** `src/state/promptLibrary.ts` — add `filterPrompts` + `EMPTY_LIBRARY_COPY` (shared by both surfaces).
- **Modify** `src/prompts/PromptPicker.tsx` — use shared helpers; clipboard via bridge; render `PromptRowActions`; add legend.
- **Create** `src/prompts/PromptRowActions.tsx` (+ test) — shared presentational action cluster.
- **Create** `src/prompts/PromptsView.tsx` (+ test) — the Prompts tab.
- **Modify** `src/state/sessions.ts` — add `"prompts"` to `layout.view` union + `setView` sig.
- **Modify** `src/layout/Shell.tsx` — 4th nav segment + `view === "prompts"` render branch.
- **Modify** `src/ipc/bridge.ts` — `readClipboard()` binding.
- **Modify** `src-tauri/src/commands.rs` + `src-tauri/src/lib.rs` + `src-tauri/Cargo.toml` — `read_clipboard` command via `arboard`.
- **Modify** `src/terminal/Terminal.tsx` + **create** `src/terminal/reservedChords.ts` (+ test) — ⌘⇧P reliability fix.

---

### Task 1: Shared `filterPrompts` + `EMPTY_LIBRARY_COPY`

The picker filters with an inline predicate (`PromptPicker.tsx:327-333`) and owns a local `EMPTY_LIBRARY_COPY` (`:18`). Extract both so `PromptsView` reuses one implementation. No behavior change.

**Files:**
- Modify: `src/state/promptLibrary.ts` (add exports after `orderPrompts`, line 153)
- Test: `src/state/promptLibrary.test.ts`
- Modify: `src/prompts/PromptPicker.tsx:18`, `:325-333` (consume the shared helpers)

**Interfaces:**
- Produces: `filterPrompts(prompts: SavedPrompt[], query: string): SavedPrompt[]` — case-insensitive substring match over `` `${title} ${tags.join(" ")} ${body}` ``; empty/whitespace query returns the input unchanged. `EMPTY_LIBRARY_COPY: string`.

- [ ] **Step 1: Write the failing test** — append to `src/state/promptLibrary.test.ts`:

```ts
import { EMPTY_LIBRARY_COPY, filterPrompts } from "./promptLibrary.ts";

function p(over: Partial<SavedPrompt>): SavedPrompt {
  return {
    body: "", createdMs: 1, favourite: false, id: "x", lastUsedMs: null,
    tags: [], title: "", updatedMs: 1, useCount: 0, ...over,
  };
}

test("filterPrompts matches title, tags, and body case-insensitively", () => {
  const list = [
    p({ id: "a", title: "Refactor plan" }),
    p({ id: "b", title: "Other", tags: ["review"] }),
    p({ id: "c", title: "Third", body: "deep REVIEW notes" }),
  ];
  expect(filterPrompts(list, "review").map((x) => x.id)).toEqual(["b", "c"]);
  expect(filterPrompts(list, "REFACTOR").map((x) => x.id)).toEqual(["a"]);
});

test("filterPrompts returns all prompts for an empty query", () => {
  const list = [p({ id: "a" }), p({ id: "b" })];
  expect(filterPrompts(list, "   ")).toHaveLength(2);
});

test("EMPTY_LIBRARY_COPY is the shared save/import affordance copy", () => {
  expect(EMPTY_LIBRARY_COPY).toContain("No saved prompts yet");
});
```

Ensure `SavedPrompt` is imported at the top of the test file (`import type { SavedPrompt } from "../types.ts";`) if not already present.

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm exec vitest run src/state/promptLibrary.test.ts`
Expected: FAIL — `filterPrompts`/`EMPTY_LIBRARY_COPY` not exported.

- [ ] **Step 3: Implement** — append to `src/state/promptLibrary.ts` after `orderPrompts` (line 153):

```ts
/** The empty-library affordance copy, shared by both surfaces. */
export const EMPTY_LIBRARY_COPY =
  'No saved prompts yet — use "Save last prompt…" or import your /commands from the palette.';

/**
 * Case-insensitive substring filter over title, tags, and body. A blank query
 * returns the input unchanged. Ordering is the caller's job (see orderPrompts).
 */
export function filterPrompts(
  prompts: SavedPrompt[],
  query: string
): SavedPrompt[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return prompts;
  }
  return prompts.filter((p) =>
    `${p.title} ${p.tags.join(" ")} ${p.body}`.toLowerCase().includes(needle)
  );
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm exec vitest run src/state/promptLibrary.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor the picker to consume them (no behavior change).**

In `src/prompts/PromptPicker.tsx`:
- Delete the local `EMPTY_LIBRARY_COPY` const (lines 18-19).
- Update the import from `../state/promptLibrary.ts` (line 4) to:
  ```ts
  import {
    EMPTY_LIBRARY_COPY,
    filterPrompts,
    orderPrompts,
    usePromptLibrary,
  } from "../state/promptLibrary.ts";
  ```
- Replace the inline filter (lines 325-333) with:
  ```ts
  const ordered = orderPrompts(prompts);
  const filtered = filterPrompts(ordered, query);
  ```
  (Delete the now-unused `const needle = query.toLowerCase();` line.)

- [ ] **Step 6: Verify the picker suite still passes**

Run: `pnpm exec vitest run src/prompts/PromptPicker.test.tsx src/state/promptLibrary.test.ts`
Expected: PASS (behavior unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/state/promptLibrary.ts src/state/promptLibrary.test.ts src/prompts/PromptPicker.tsx
git commit -m "refactor(prompts): extract shared filterPrompts + EMPTY_LIBRARY_COPY"
```

---

### Task 2: `read_clipboard` Rust command (via `arboard`)

Replaces the frontend `navigator.clipboard.readText()`, which rejects in the packaged WKWebView, and honors the Rust-owns-OS-access rule. `arboard` is chosen over `tauri-plugin-clipboard-manager` because our command is a plain `#[tauri::command]` (no plugin JS capability JSON needed) and it gives a self-contained in-process round-trip test.

**Files:**
- Modify: `src-tauri/Cargo.toml` (deps block, ~line 37)
- Modify: `src-tauri/src/commands.rs` (add command after `record_prompt_use`, line 825; add test in the existing `mod tests`, line 1042)
- Modify: `src-tauri/src/lib.rs:171` (register in `generate_handler!`)

**Interfaces:**
- Produces: Tauri command `read_clipboard() -> Result<String, String>` (invoke name `read_clipboard`, no args).

- [ ] **Step 1: Add the dependency** — in `src-tauri/Cargo.toml`, in the `[dependencies]` block, add:

```toml
arboard = "3"
```

- [ ] **Step 2: Write the failing test** — add inside `mod tests` in `src-tauri/src/commands.rs` (the block at line 1042):

```rust
#[test]
#[ignore = "requires a real system pasteboard; run locally on macOS"]
fn read_clipboard_round_trips_a_set_value() {
    let mut cb = arboard::Clipboard::new().expect("clipboard");
    cb.set_text("kriyon-clip-probe".to_string()).expect("set");
    assert_eq!(read_clipboard().expect("read"), "kriyon-clip-probe");
}
```

- [ ] **Step 3: Run it, verify it fails to compile**

Run: `cd src-tauri && cargo test read_clipboard -- --ignored`
Expected: FAIL — `read_clipboard` not found / `arboard` unresolved.

- [ ] **Step 4: Implement** — add after `record_prompt_use` (line 825) in `src-tauri/src/commands.rs`:

```rust
/// Read the OS clipboard's plain text. The Rust core owns OS access; the
/// frontend must not call `navigator.clipboard` (it rejects in the packaged
/// WKWebView). An empty pasteboard yields "".
///
/// # Errors
/// Returns an error string if the pasteboard is unavailable or holds no text.
#[tauri::command]
pub fn read_clipboard() -> Result<String, String> {
    arboard::Clipboard::new()
        .and_then(|mut cb| cb.get_text())
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Register it** — in `src-tauri/src/lib.rs`, add to the `generate_handler!` list (after `commands::list_past_sessions`, line 171 — add a comma after it):

```rust
            commands::list_past_sessions,
            commands::read_clipboard
```

- [ ] **Step 6: Verify it compiles, lints, and the (ignored) test passes locally**

Run: `cd src-tauri && cargo test read_clipboard -- --ignored`
Expected: PASS on a Mac with a pasteboard (the `#[ignore]` keeps CI green in `cargo test`).
Run: `cd src-tauri && cargo clippy --all-targets -- -D warnings`
Expected: no warnings.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(clipboard): add read_clipboard Tauri command via arboard"
```

---

### Task 3: `readClipboard` bridge binding

The IPC contract that unblocks the frontend clipboard fix. Mirrors existing bindings (`bridge.ts:376-387`).

**Files:**
- Modify: `src/ipc/bridge.ts` (near the other prompt bindings, ~line 387)

**Interfaces:**
- Consumes: `read_clipboard` command (Task 2).
- Produces: `readClipboard(): Promise<string>`.

- [ ] **Step 1: Implement** — add after `recordPromptUse` (line 387) in `src/ipc/bridge.ts`:

```ts
/**
 * Read the OS clipboard's plain text from the Rust core (fixes `{clipboard}`:
 * `navigator.clipboard.readText()` rejects in the packaged WKWebView).
 */
export function readClipboard(): Promise<string> {
  return invoke("read_clipboard");
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS (no test — this is a one-line typed delegation; it is exercised through the picker in Task 4 with a mocked bridge).

- [ ] **Step 3: Commit**

```bash
git add src/ipc/bridge.ts
git commit -m "feat(clipboard): add readClipboard bridge binding"
```

---

### Task 4: Fix `{clipboard}` empty in the picker

`insertPrompt` (`PromptPicker.tsx:338-372`) reads the clipboard at line 353 with `navigator.clipboard.readText().catch(() => "")` — which silently swallows the WKWebView rejection. Route through `bridge.readClipboard`; on failure insert empty **and** toast.

**Files:**
- Modify: `src/prompts/PromptPicker.tsx` (imports; module doc; `insertPrompt` lines 351-354)
- Test: `src/prompts/PromptPicker.test.tsx`

**Interfaces:**
- Consumes: `readClipboard()` (Task 3), `showToast` (already imported).

- [ ] **Step 1: Write the failing tests** — the test file mocks `../ipc/bridge.ts` (lines 10-14). Add `readClipboard` to that mock and add two tests. Update the mock block to:

```ts
vi.mock("../ipc/bridge.ts", () => ({
  deletePrompt: vi.fn(() => Promise.resolve()),
  readClipboard: vi.fn(() => Promise.resolve("from-rust")),
  recordPromptUse: vi.fn(() => Promise.resolve()),
  upsertPrompt: vi.fn(() => Promise.resolve()),
}));
```

Add `import { readClipboard } from "../ipc/bridge.ts";` alongside the other imports, then append:

```ts
test("{clipboard} resolves via the Rust bridge, not navigator.clipboard", async () => {
  usePromptLibrary.setState({
    prompts: [prompt({ id: "c1", title: "Clip", body: "holds: {clipboard}" })],
  });
  useSessions.setState({ activeSessionId: "s1" });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);
  fireEvent.click(screen.getByText("Clip"));
  await waitFor(() =>
    expect(useDrafts.getState().insertRequest?.text).toBe("holds: from-rust")
  );
  expect(readClipboard).toHaveBeenCalledTimes(1);
});

test("clipboard read failure inserts empty and toasts", async () => {
  vi.mocked(readClipboard).mockRejectedValueOnce(new Error("no pasteboard"));
  usePromptLibrary.setState({
    prompts: [prompt({ id: "c2", title: "Clip2", body: "holds: {clipboard}" })],
  });
  useSessions.setState({ activeSessionId: "s1" });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);
  fireEvent.click(screen.getByText("Clip2"));
  await waitFor(() =>
    expect(useDrafts.getState().insertRequest?.text).toBe("holds: ")
  );
  expect(showToast).toHaveBeenCalledWith("Couldn't read the clipboard");
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `pnpm exec vitest run src/prompts/PromptPicker.test.tsx -t clipboard`
Expected: FAIL — still calls `navigator.clipboard`; `readClipboard` mock not called; no error toast.

- [ ] **Step 3: Implement** — in `src/prompts/PromptPicker.tsx`:

Add the bridge import near the top (after line 9):
```ts
import { readClipboard } from "../ipc/bridge.ts";
```

Update the module doc (lines 260-266) — the "never touches `../ipc/bridge.ts`" clause is no longer true; change that sentence to: `Clipboard reads go through the Rust core via bridge.readClipboard (navigator.clipboard rejects in the packaged webview); insertion still goes only through useDrafts.requestInsert.`

Replace lines 351-354 (the `needsClipboard`/`clipboardText` block) with:
```ts
const needsClipboard = prompt.body.includes(`{${CLIPBOARD_PLACEHOLDER}}`);
const clipboardText = needsClipboard
  ? readClipboard().catch(() => {
      showToast("Couldn't read the clipboard");
      return "";
    })
  : Promise.resolve("");
```

- [ ] **Step 4: Run them, verify they pass**

Run: `pnpm exec vitest run src/prompts/PromptPicker.test.tsx`
Expected: PASS (all picker tests, including the existing re-entrancy/session-change tests, stay green).

- [ ] **Step 5: Commit**

```bash
git add src/prompts/PromptPicker.tsx src/prompts/PromptPicker.test.tsx
git commit -m "fix(prompts): read {clipboard} via Rust bridge, toast on failure"
```

---

### Task 5: `PromptRowActions` presentational component

The shared visible cluster: **⤵ Insert · ★/☆ Favourite · ✎ Edit · ⌫ Delete** (delete two-click armed). No store access — pure callbacks — so it is testable in isolation and reusable by both surfaces.

**Files:**
- Create: `src/prompts/PromptRowActions.tsx`
- Test: `src/prompts/PromptRowActions.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  interface PromptRowActionsProps {
    deleteArmed: boolean;
    favourite: boolean;
    insertDisabled: boolean;
    onDelete: () => void;
    onEdit: () => void;
    onInsert: () => void;
    onToggleFavourite: () => void;
  }
  export function PromptRowActions(props: PromptRowActionsProps): JSX.Element;
  ```
  Buttons carry stable `aria-label`s: `"Insert prompt"`, `"Favourite"`/`"Unfavourite"`, `"Edit prompt"`, `"Delete prompt"`. When `deleteArmed`, the delete button's accessible name is `"Confirm delete"`.

- [ ] **Step 1: Write the failing test** — create `src/prompts/PromptRowActions.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { PromptRowActions } from "./PromptRowActions.tsx";

function setup(over: Partial<Parameters<typeof PromptRowActions>[0]> = {}) {
  const props = {
    deleteArmed: false,
    favourite: false,
    insertDisabled: false,
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onInsert: vi.fn(),
    onToggleFavourite: vi.fn(),
    ...over,
  };
  render(<PromptRowActions {...props} />);
  return props;
}

test("each button invokes its callback", () => {
  const props = setup();
  fireEvent.click(screen.getByLabelText("Insert prompt"));
  fireEvent.click(screen.getByLabelText("Favourite"));
  fireEvent.click(screen.getByLabelText("Edit prompt"));
  fireEvent.click(screen.getByLabelText("Delete prompt"));
  expect(props.onInsert).toHaveBeenCalledTimes(1);
  expect(props.onToggleFavourite).toHaveBeenCalledTimes(1);
  expect(props.onEdit).toHaveBeenCalledTimes(1);
  expect(props.onDelete).toHaveBeenCalledTimes(1);
});

test("favourite state flips the star affordance", () => {
  setup({ favourite: true });
  expect(screen.getByLabelText("Unfavourite")).toHaveTextContent("★");
});

test("armed delete shows the confirm affordance", () => {
  setup({ deleteArmed: true });
  expect(screen.getByLabelText("Confirm delete")).toBeInTheDocument();
});

test("insert is disabled when insertDisabled", () => {
  const props = setup({ insertDisabled: true });
  const btn = screen.getByLabelText("Insert prompt");
  expect(btn).toBeDisabled();
  fireEvent.click(btn);
  expect(props.onInsert).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm exec vitest run src/prompts/PromptRowActions.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — create `src/prompts/PromptRowActions.tsx`:

```tsx
import type { CSSProperties } from "react";
import { tokens } from "../theme/tokens.ts";

export interface PromptRowActionsProps {
  deleteArmed: boolean;
  favourite: boolean;
  insertDisabled: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onInsert: () => void;
  onToggleFavourite: () => void;
}

const clusterStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  gap: "2px",
};

function iconButtonStyle(opts: {
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    borderRadius: tokens.radius.sm,
    color: opts.danger
      ? tokens.color.status.error
      : opts.active
        ? tokens.color.accent
        : tokens.color.ink.dim,
    cursor: opts.disabled ? "default" : "pointer",
    fontFamily: tokens.font.sans,
    fontSize: "13px",
    lineHeight: 1,
    opacity: opts.disabled ? 0.4 : 1,
    padding: "5px 7px",
  };
}

/**
 * [Prompt row actions]: the shared visible controls on each [Saved prompt] row
 * in both the [Prompt library view] and the [Prompt picker]. Presentational —
 * every action is a callback; the parent owns the store and the armed state.
 */
export function PromptRowActions({
  deleteArmed,
  favourite,
  insertDisabled,
  onDelete,
  onEdit,
  onInsert,
  onToggleFavourite,
}: PromptRowActionsProps) {
  return (
    <div style={clusterStyle}>
      <button
        aria-label="Insert prompt"
        disabled={insertDisabled}
        onClick={onInsert}
        style={iconButtonStyle({ disabled: insertDisabled })}
        title={insertDisabled ? "Open a session to insert" : "Insert"}
        type="button"
      >
        ⤵
      </button>
      <button
        aria-label={favourite ? "Unfavourite" : "Favourite"}
        onClick={onToggleFavourite}
        style={iconButtonStyle({ active: favourite })}
        type="button"
      >
        {favourite ? "★" : "☆"}
      </button>
      <button
        aria-label="Edit prompt"
        onClick={onEdit}
        style={iconButtonStyle({})}
        type="button"
      >
        ✎
      </button>
      <button
        aria-label={deleteArmed ? "Confirm delete" : "Delete prompt"}
        onClick={onDelete}
        style={iconButtonStyle({ danger: deleteArmed })}
        title={deleteArmed ? "Click again to delete" : "Delete"}
        type="button"
      >
        {deleteArmed ? "⌫?" : "⌫"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm exec vitest run src/prompts/PromptRowActions.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/PromptRowActions.tsx src/prompts/PromptRowActions.test.tsx
git commit -m "feat(prompts): add shared PromptRowActions cluster"
```

---

### Task 6: Wire `PromptRowActions` into the picker rows + legend

Render `PromptRowActions` on every picker row (always visible), wired to the same store actions the ⌘F/⌘E/⌘⌫ handlers call. Rows become a `<div>` (an outer `<button>` cannot contain the action buttons). Add a one-line legend under the list. Keyboard handlers stay unchanged.

**Files:**
- Modify: `src/prompts/PromptPicker.tsx` (import; add row helpers; rewrite `renderPromptRows` lines 472-506; add legend + style; delegate the `*Highlighted` helpers to the row helpers)
- Test: `src/prompts/PromptPicker.test.tsx`

**Interfaces:**
- Consumes: `PromptRowActions` (Task 5).

- [ ] **Step 1: Write the failing tests** — append to `src/prompts/PromptPicker.test.tsx`:

```ts
test("picker row favourite button toggles via the store", () => {
  const toggle = vi.spyOn(usePromptLibrary.getState(), "toggleFavourite");
  usePromptLibrary.setState({ prompts: [prompt({ id: "r1", title: "Row" })] });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);
  fireEvent.click(screen.getByLabelText("Favourite"));
  expect(toggle).toHaveBeenCalledWith("r1", expect.any(Number));
});

test("picker row edit button opens the editor for that prompt", () => {
  usePromptLibrary.setState({
    prompts: [prompt({ id: "r2", title: "EditMe", body: "b" })],
  });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);
  fireEvent.click(screen.getByLabelText("Edit prompt"));
  expect(useUi.getState().promptEditorSeed?.id).toBe("r2");
});

test("picker row delete is two-click armed then removes", () => {
  const remove = vi.spyOn(usePromptLibrary.getState(), "remove");
  usePromptLibrary.setState({ prompts: [prompt({ id: "r3", title: "Del" })] });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);
  fireEvent.click(screen.getByLabelText("Delete prompt"));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText("Confirm delete"));
  expect(remove).toHaveBeenCalledWith("r3");
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `pnpm exec vitest run src/prompts/PromptPicker.test.tsx -t "picker row"`
Expected: FAIL — no action buttons rendered.

- [ ] **Step 3: Implement.** In `src/prompts/PromptPicker.tsx`:

Add the import (after the other `./` imports):
```ts
import { PromptRowActions } from "./PromptRowActions.tsx";
```

Add row-specific helpers (place next to `toggleHighlightedFavourite`, ~line 385) and delegate the highlighted variants to them (DRY):
```ts
function favouriteRow(p: SavedPrompt): void {
  usePromptLibrary.getState().toggleFavourite(p.id, Date.now());
}

function editRow(p: SavedPrompt): void {
  useUi.getState().openPromptEditor({
    body: p.body,
    id: p.id,
    tags: p.tags,
    title: p.title,
  });
}

function deleteRow(p: SavedPrompt): void {
  if (deleteArmedId === p.id) {
    usePromptLibrary.getState().remove(p.id);
    setDeleteArmedId(null);
  } else {
    setDeleteArmedId(p.id);
  }
}

function toggleHighlightedFavourite(): void {
  if (highlighted) {
    favouriteRow(highlighted);
  }
}

function editHighlighted(): void {
  if (highlighted) {
    editRow(highlighted);
  }
}

function deleteHighlighted(): void {
  if (highlighted) {
    deleteRow(highlighted);
  }
}
```
(Replace the existing `toggleHighlightedFavourite` (385-389), `editHighlighted` (391-400), and `deleteHighlighted` (410-420) bodies with the delegating versions above.)

Add a row-label button style near the other style consts (after `armedStyle`, ~line 153):
```ts
const rowLabelStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  flex: 1,
  minWidth: 0,
  padding: 0,
  textAlign: "left",
};

const legendStyle: CSSProperties = {
  borderTop: `1px solid ${tokens.color.line.soft}`,
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
  padding: "8px 14px",
};
```

Rewrite `renderPromptRows` (lines 472-506) — row is now a `<div>` holding a clickable label button plus `PromptRowActions`; drop the standalone `confirm ⌘⌫` badge (the armed delete button conveys it):
```tsx
function renderPromptRows() {
  if (prompts.length === 0) {
    return <div style={emptyStyle}>{EMPTY_LIBRARY_COPY}</div>;
  }
  if (filtered.length === 0) {
    return <div style={emptyStyle}>No matches</div>;
  }
  return filtered.map((prompt, index) => (
    <div
      data-active={index === safeHighlight ? "true" : "false"}
      key={prompt.id}
      onMouseEnter={() => moveHighlight(() => index)}
      style={rowStyle(index === safeHighlight)}
    >
      <button
        onClick={() => pickPrompt(prompt)}
        style={rowLabelStyle}
        type="button"
      >
        <span style={{ ...labelStyle, display: "block" }}>
          {prompt.favourite ? (
            <span style={{ color: tokens.color.accent }}>★ </span>
          ) : null}
          {prompt.title}
        </span>
        {prompt.tags.length > 0 ? (
          <span style={{ ...subStyle, display: "block" }}>
            {prompt.tags.join(", ")}
          </span>
        ) : null}
      </button>
      <PromptRowActions
        deleteArmed={deleteArmedId === prompt.id}
        favourite={prompt.favourite}
        insertDisabled={false}
        onDelete={() => deleteRow(prompt)}
        onEdit={() => editRow(prompt)}
        onInsert={() => pickPrompt(prompt)}
        onToggleFavourite={() => favouriteRow(prompt)}
      />
    </div>
  ));
}
```

Add the legend under the list. In the search-stage JSX (after the `prompt-picker-list` `<div>` closes, ~line 564):
```tsx
<div data-testid="prompt-picker-list" style={listStyle}>
  {renderPromptRows()}
</div>
<div style={legendStyle}>Enter insert · ⌘F favourite · ⌘E edit · ⌘⌫ delete</div>
```

- [ ] **Step 4: Run the full picker suite, verify green**

Run: `pnpm exec vitest run src/prompts/PromptPicker.test.tsx`
Expected: PASS — new row-action tests pass; existing keyboard/insert tests still pass.

Note: the existing "empty library" test asserts on the shared `EMPTY_LIBRARY_COPY` text (unchanged). If a legacy test queried the removed `confirm ⌘⌫` badge text, update it to assert `getByLabelText("Confirm delete")` instead.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/PromptPicker.tsx src/prompts/PromptPicker.test.tsx
git commit -m "feat(prompts): visible clickable row actions + legend in picker"
```

---

### Task 7: `"prompts"` value in `layout.view`

Add the routed, persisted view value. State-only change first (routing in Shell is Task 9).

**Files:**
- Modify: `src/state/sessions.ts:114` (union), `:175` (`setView` sig)
- Test: `src/state/sessions.test.ts` (if absent, create it following the store-test shape)

**Interfaces:**
- Produces: `layout.view` union includes `"prompts"`; `setView("prompts")` persists it.

- [ ] **Step 1: Write the failing test** — add to `src/state/sessions.test.ts`:

```ts
import { useSessions } from "./sessions.ts";

test("setView routes and stores the prompts view", () => {
  useSessions.getState().setView("prompts");
  expect(useSessions.getState().layout.view).toBe("prompts");
});
```

- [ ] **Step 2: Run it, verify it fails typecheck**

Run: `pnpm typecheck`
Expected: FAIL — `"prompts"` not assignable to the `view` union.

- [ ] **Step 3: Implement** — in `src/state/sessions.ts`:
- Line 114: `view: "studio" | "focus" | "command" | "prompts";`
- Line 175: `setView: (view: "studio" | "focus" | "command" | "prompts") => void;`

- [ ] **Step 4: Run test + typecheck, verify pass**

Run: `pnpm typecheck && pnpm exec vitest run src/state/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/sessions.ts src/state/sessions.test.ts
git commit -m "feat(prompts): add prompts value to layout.view"
```

---

### Task 8: `PromptsView` — the Prompts tab

The persistent home to browse/search/manage prompts. Header (title, **+ New**, **Import from /commands**), search input, list of rows (title, ★, tags, `PromptRowActions`), empty state. **Insert** writes the active session's [Composer draft] via `useDrafts.requestInsert` (never sends) and toasts `"Inserted into the session draft"`; disabled with no active session.

**Files:**
- Create: `src/prompts/PromptsView.tsx`
- Test: `src/prompts/PromptsView.test.tsx`

**Interfaces:**
- Consumes: `usePromptLibrary`, `orderPrompts`, `filterPrompts`, `EMPTY_LIBRARY_COPY`, `importPromptsFromCommands` (`state/promptLibrary.ts`); `useDrafts.requestInsert` (`state/drafts.ts`); `useSessions.activeSessionId` (`state/sessions.ts`); `useUi.openPromptEditor` (`state/ui.ts`); `PromptRowActions` (Task 5); `showToast`.
- Produces: `export function PromptsView(): JSX.Element`.

- [ ] **Step 1: Write the failing tests** — create `src/prompts/PromptsView.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  deletePrompt: vi.fn(() => Promise.resolve()),
  recordPromptUse: vi.fn(() => Promise.resolve()),
  upsertPrompt: vi.fn(() => Promise.resolve()),
}));
vi.mock("../ui/Toast.tsx", () => ({ showToast: vi.fn() }));

import { useDrafts } from "../state/drafts.ts";
import {
  importPromptsFromCommands,
  usePromptLibrary,
} from "../state/promptLibrary.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import type { SavedPrompt } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import { PromptsView } from "./PromptsView.tsx";

vi.mock("../state/promptLibrary.ts", async (orig) => {
  const actual = await orig<typeof import("../state/promptLibrary.ts")>();
  return { ...actual, importPromptsFromCommands: vi.fn(() => Promise.resolve()) };
});

function prompt(over: Partial<SavedPrompt>): SavedPrompt {
  return {
    body: "body", createdMs: 1, favourite: false, id: "p1", lastUsedMs: null,
    tags: [], title: "title", updatedMs: 1, useCount: 0, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUi.setState({ promptEditorSeed: null });
  usePromptLibrary.setState({ prompts: [] });
  useSessions.setState({ activeSessionId: null, sessions: {} });
  useDrafts.setState({ drafts: {}, insertRequest: null });
});

test("lists prompts favourites-first", () => {
  usePromptLibrary.setState({
    prompts: [
      prompt({ id: "a", title: "Alpha" }),
      prompt({ id: "b", title: "Bravo", favourite: true }),
    ],
  });
  render(<PromptsView />);
  const titles = screen.getAllByTestId("prompts-row-title").map((n) => n.textContent);
  expect(titles[0]).toContain("Bravo");
});

test("search filters by title/tags/body", () => {
  usePromptLibrary.setState({
    prompts: [prompt({ id: "a", title: "Alpha" }), prompt({ id: "b", title: "Bravo" })],
  });
  render(<PromptsView />);
  fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
    target: { value: "brav" },
  });
  expect(screen.getByText("Bravo")).toBeInTheDocument();
  expect(screen.queryByText("Alpha")).toBeNull();
});

test("insert writes the active session draft and toasts, never sends", () => {
  usePromptLibrary.setState({ prompts: [prompt({ id: "a", title: "Alpha", body: "hi" })] });
  useSessions.setState({ activeSessionId: "s1" });
  render(<PromptsView />);
  fireEvent.click(screen.getByLabelText("Insert prompt"));
  expect(useDrafts.getState().insertRequest?.text).toBe("hi");
  expect(useDrafts.getState().insertRequest?.sessionId).toBe("s1");
  expect(showToast).toHaveBeenCalledWith("Inserted into the session draft");
});

test("insert is disabled with no active session", () => {
  usePromptLibrary.setState({ prompts: [prompt({ id: "a", title: "Alpha" })] });
  render(<PromptsView />);
  expect(screen.getByLabelText("Insert prompt")).toBeDisabled();
});

test("+ New opens a blank editor", () => {
  render(<PromptsView />);
  fireEvent.click(screen.getByRole("button", { name: "New prompt" }));
  expect(useUi.getState().promptEditorSeed).not.toBeNull();
});

test("Import runs the command importer", () => {
  render(<PromptsView />);
  fireEvent.click(screen.getByRole("button", { name: "Import from /commands" }));
  expect(importPromptsFromCommands).toHaveBeenCalledTimes(1);
});

test("empty library shows the shared affordance copy", () => {
  render(<PromptsView />);
  expect(screen.getByText(/No saved prompts yet/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `pnpm exec vitest run src/prompts/PromptsView.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — create `src/prompts/PromptsView.tsx`:

```tsx
import type { CSSProperties } from "react";
import { useState } from "react";
import { useDrafts } from "../state/drafts.ts";
import {
  EMPTY_LIBRARY_COPY,
  filterPrompts,
  importPromptsFromCommands,
  orderPrompts,
  usePromptLibrary,
} from "../state/promptLibrary.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { tokens } from "../theme/tokens.ts";
import type { SavedPrompt } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import { resolvePlaceholders } from "./placeholders.ts";
import { PromptRowActions } from "./PromptRowActions.tsx";

const viewStyle: CSSProperties = {
  color: tokens.color.text,
  display: "flex",
  flex: 1,
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  minHeight: 0,
  padding: tokens.space.lg,
};

const headerStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.sm,
  marginBottom: tokens.space.md,
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  flex: 1,
  fontSize: "18px",
  fontWeight: 600,
};

const buttonStyle: CSSProperties = {
  background: tokens.color.surface.s2,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.bright,
  cursor: "pointer",
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  padding: "6px 12px",
};

const searchStyle: CSSProperties = {
  background: tokens.color.surface.s2,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.bright,
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  marginBottom: tokens.space.md,
  outline: "none",
  padding: "8px 12px",
};

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  minHeight: 0,
  overflowY: "auto",
};

const rowStyle: CSSProperties = {
  alignItems: "center",
  borderRadius: tokens.radius.md,
  display: "flex",
  gap: tokens.space.sm,
  padding: "9px 12px",
};

const rowLabelStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  flex: 1,
  fontSize: "13.5px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const tagStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
};

const emptyStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontSize: "13px",
  padding: "40px",
  textAlign: "center",
};

/**
 * [Prompt library view]: the persistent "Prompts" tab. Browse, search, and
 * manage every [Saved prompt] with the shared [Prompt row actions]. Insert
 * targets the active [Session]'s [Composer draft] (never sends); with no active
 * session the insert control is disabled. Reuses the [Prompt editor] dialog for
 * New/Edit and the existing import command.
 */
export function PromptsView() {
  const prompts = usePromptLibrary((s) => s.prompts);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const [query, setQuery] = useState("");
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);

  const rows = filterPrompts(orderPrompts(prompts), query);

  function insertRow(p: SavedPrompt): void {
    if (!activeSessionId) {
      return;
    }
    // No {placeholder} fill here — the tab inserts the raw body (the picker is
    // the fill-then-insert path). {clipboard} stays literal for the composer.
    const text = resolvePlaceholders(p.body, {}, `{clipboard}`);
    useDrafts.getState().requestInsert(activeSessionId, text);
    usePromptLibrary.getState().markUsed(p.id, Date.now());
    showToast("Inserted into the session draft");
  }

  function editRow(p: SavedPrompt): void {
    useUi.getState().openPromptEditor({
      body: p.body,
      id: p.id,
      tags: p.tags,
      title: p.title,
    });
  }

  function deleteRow(p: SavedPrompt): void {
    if (deleteArmedId === p.id) {
      usePromptLibrary.getState().remove(p.id);
      setDeleteArmedId(null);
    } else {
      setDeleteArmedId(p.id);
    }
  }

  return (
    <div data-testid="prompts-view" style={viewStyle}>
      <div style={headerStyle}>
        <span style={titleStyle}>Prompts</span>
        <button
          aria-label="New prompt"
          onClick={() => useUi.getState().openPromptEditor({})}
          style={buttonStyle}
          type="button"
        >
          + New
        </button>
        <button
          aria-label="Import from /commands"
          onClick={() => {
            importPromptsFromCommands();
          }}
          style={buttonStyle}
          type="button"
        >
          Import from /commands
        </button>
      </div>
      <input
        onChange={(event) => {
          setQuery(event.target.value);
          setDeleteArmedId(null);
        }}
        placeholder="Search prompts…"
        style={searchStyle}
        type="text"
        value={query}
      />
      {prompts.length === 0 ? (
        <div style={emptyStyle}>{EMPTY_LIBRARY_COPY}</div>
      ) : (
        <div style={listStyle}>
          {rows.map((p) => (
            <div key={p.id} style={rowStyle}>
              <span data-testid="prompts-row-title" style={rowLabelStyle}>
                {p.favourite ? (
                  <span style={{ color: tokens.color.accent }}>★ </span>
                ) : null}
                {p.title}
                {p.tags.length > 0 ? (
                  <span style={tagStyle}> · {p.tags.join(", ")}</span>
                ) : null}
              </span>
              <PromptRowActions
                deleteArmed={deleteArmedId === p.id}
                favourite={p.favourite}
                insertDisabled={!activeSessionId}
                onDelete={() => deleteRow(p)}
                onEdit={() => editRow(p)}
                onInsert={() => insertRow(p)}
                onToggleFavourite={() =>
                  usePromptLibrary.getState().toggleFavourite(p.id, Date.now())
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

Note on the `openPromptEditor({})` call: confirm the editor's seed type accepts an empty/blank seed for "New" (it reads `useUi.promptEditorSeed`; `PromptEditor.tsx:167`). If the seed type requires fields, pass `{ body: "", tags: [], title: "" }` (no `id` ⇒ new). Adjust the `+ New` test's assertion accordingly if the blank seed is represented differently.

- [ ] **Step 4: Run them, verify they pass**

Run: `pnpm exec vitest run src/prompts/PromptsView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/PromptsView.tsx src/prompts/PromptsView.test.tsx
git commit -m "feat(prompts): add Prompts library view tab"
```

---

### Task 9: Route the Prompts tab in the Shell

Add the 4th nav segment and the render branch.

**Files:**
- Modify: `src/layout/Shell.tsx` (import; `Segmented` options ~line 239-243; render branch ~line 399)

**Interfaces:**
- Consumes: `PromptsView` (Task 8); `layout.view === "prompts"` (Task 7).

- [ ] **Step 1: Implement** — in `src/layout/Shell.tsx`:

Add the import with the other view imports (near `PromptPicker`/`PromptEditor` imports):
```ts
import { PromptsView } from "../prompts/PromptsView.tsx";
```

Add the 4th `Segmented` option (after Command, line 242):
```tsx
options={[
  { label: "Studio", value: "studio" },
  { label: "Focus", value: "focus" },
  { label: "Command", value: "command" },
  { label: "Prompts", value: "prompts" },
]}
```

Add the render branch (after the `focus` branch, line 408):
```tsx
{view === "focus" ? <FocusBody>{children}</FocusBody> : null}
{view === "prompts" ? <PromptsView /> : null}
```

- [ ] **Step 2: Verify typecheck + full frontend suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. (The `Segmented` `onChange={setView}` now accepts `"prompts"` because Task 7 widened the union; `Segmented<T>` infers `T` from the options.)

- [ ] **Step 3: Real-app smoke**: launch `pnpm tauri dev`, click the **Prompts** segment, confirm the tab renders, lists prompts, and the row actions are visible. Insert into an active session's composer; confirm the toast and that nothing is sent.

- [ ] **Step 4: Commit**

```bash
git add src/layout/Shell.tsx
git commit -m "feat(prompts): route the Prompts tab in the shell nav"
```

---

### Task 10: ⌘⇧P reliability fix

**Reproduce first (systematic-debugging), with a live focused terminal** — this could not be reproduced against an unfocused/blank terminal last session. Launch `pnpm tauri dev`, click *into* a live xterm so it has focus and the cursor blinks, then press ⌘⇧P physically. If it fails to open, the leading cause is xterm's `attachCustomKeyEventHandler` (`Terminal.tsx:180-202`) returning `true` for the app-reserved chord, so xterm processes/consumes the keydown before it reaches the `window` listener in `PromptPicker.tsx:287-300`. The fix returns `false` for the app-reserved chords (⌘⇧P, ⌘K, ⌘⇧K) so they propagate.

**Files:**
- Create: `src/terminal/reservedChords.ts` (+ test) — the testable predicate.
- Modify: `src/terminal/Terminal.tsx:180-202` (return `false` for reserved chords).

**Interfaces:**
- Produces: `isReservedAppChord(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; type: string }): boolean` — true for keydown ⌘⇧P, ⌘K (no shift), ⌘⇧K.

- [ ] **Step 1: Confirm/deny the repro in the real app.** Record the observed behavior (opens / doesn't) with a live focused terminal. If it opens reliably, the cause is elsewhere (borderless window key-window status) — stop and report before changing the handler. If it fails, proceed.

- [ ] **Step 2: Write the failing test** — create `src/terminal/reservedChords.test.ts`:

```ts
import { expect, test } from "vitest";
import { isReservedAppChord } from "./reservedChords.ts";

function ev(over: Partial<Parameters<typeof isReservedAppChord>[0]>) {
  return { ctrlKey: false, key: "", metaKey: false, shiftKey: false, type: "keydown", ...over };
}

test("cmd+shift+P is reserved (prompt picker)", () => {
  expect(isReservedAppChord(ev({ key: "P", metaKey: true, shiftKey: true }))).toBe(true);
});

test("cmd+K is reserved (palette)", () => {
  expect(isReservedAppChord(ev({ key: "k", metaKey: true }))).toBe(true);
});

test("cmd+shift+K is reserved (needs-you)", () => {
  expect(isReservedAppChord(ev({ key: "K", metaKey: true, shiftKey: true }))).toBe(true);
});

test("plain typing is not reserved", () => {
  expect(isReservedAppChord(ev({ key: "p" }))).toBe(false);
  expect(isReservedAppChord(ev({ key: "a", metaKey: true }))).toBe(false);
});

test("keyup is ignored", () => {
  expect(isReservedAppChord(ev({ key: "P", metaKey: true, shiftKey: true, type: "keyup" }))).toBe(false);
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm exec vitest run src/terminal/reservedChords.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the predicate** — create `src/terminal/reservedChords.ts`:

```ts
interface ChordEvent {
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  type: string;
}

/**
 * App-reserved chords that must reach the `window` keydown listeners
 * (PromptPicker ⌘⇧P, CommandPalette ⌘K, NeedsYou ⌘⇧K) rather than be consumed
 * by a focused xterm. Terminal's custom key handler returns `false` for these
 * so they propagate.
 */
export function isReservedAppChord(event: ChordEvent): boolean {
  if (event.type !== "keydown") {
    return false;
  }
  const meta = event.metaKey || event.ctrlKey;
  if (!meta) {
    return false;
  }
  const key = event.key.toLowerCase();
  if (key === "p" && event.shiftKey) {
    return true;
  }
  if (key === "k") {
    return true;
  }
  return false;
}
```

- [ ] **Step 5: Run it, verify it passes**

Run: `pnpm exec vitest run src/terminal/reservedChords.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire it into the terminal handler** — in `src/terminal/Terminal.tsx`, add the import at the top with the other `./` imports:

```ts
import { isReservedAppChord } from "./reservedChords.ts";
```

In `attachCustomKeyEventHandler` (lines 180-202), before the final `return true;` (line 201), add:
```ts
      if (isReservedAppChord(event)) {
        return false;
      }
      return true;
```

- [ ] **Step 7: Verify + real-app confirm**

Run: `pnpm exec vitest run src/terminal/reservedChords.test.ts && pnpm typecheck`
Expected: PASS.
Then relaunch `pnpm tauri dev`, focus a live terminal, press ⌘⇧P physically → the picker opens reliably. Also confirm ⌘K (palette) and ⌘⇧K (needs-you) still open from a focused terminal, and that ordinary typing (including a lone `p` or `k`) still reaches the shell.

- [ ] **Step 8: Commit**

```bash
git add src/terminal/reservedChords.ts src/terminal/reservedChords.test.ts src/terminal/Terminal.tsx
git commit -m "fix(terminal): let app-reserved chords propagate past focused xterm"
```

---

## Final verification

- [ ] `pnpm check` green (lint, typecheck, vitest, rust fmt, rust clippy, rust test).
- [ ] Real-app end-to-end (physical clicks/keys — cliclick cannot deliver bare Esc/Enter/Tab, so verify those paths by reading handlers):
  - Prompts tab: browse, search, favourite, edit, delete (two-click), insert into an active session's composer (toast, not sent), insert disabled with no active session.
  - `{clipboard}`: copy known text, insert a `{clipboard}` prompt via the picker on a **physical** click → real pasteboard text lands; simulate a read failure path → empty insert + "Couldn't read the clipboard" toast.
  - ⌘⇧P: opens reliably with a live focused terminal.
- [ ] Clear the two throwaway QA prompts from `~/Library/Application Support/com.kriyon.app/kriyon.db` (`QA Promote Test`, the `visual plan` import) so the library is clean, or ask the user first.
- [ ] Report findings. **Do not merge without the user.**

## Self-review notes

- **Spec coverage:** Prompts tab (T7–T9), PromptRowActions on both surfaces (T5, T6, T8), `{clipboard}` fix (T2–T4), ⌘⇧P fix (T10), shared filter/order/empty-copy (T1), routing+persist (T7, T9), insert-to-draft/never-send + disabled-no-session (T8), Rust test (T2), all frontend tests (T1,4,5,6,7,8), error toast (T4). Out-of-scope items (folders, drag-reorder, bulk select, second inline editor, quick-insert numbers) are not built.
- **Parallelization (subagents, after T3's bridge contract lands):** (a) Rust = T2; (b) frontend = T1,4,5,6,7,8,9; (c) ⌘⇧P debug = T10. T5 blocks T6/T8; T7 blocks T9.
