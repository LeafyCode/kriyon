# Composer Prompt Affordances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two controls to the composer footer — **Save prompt** (save the current draft as a [Saved prompt]) and **Prompts ⌘⇧P** (open the picker, showing the shortcut).

**Architecture:** Both are client-only and reuse the existing `PromptEditor` (seeded from the live `useDrafts` draft) and `PromptPicker` (`openPromptPicker`). A new tiny `Kbd` keycap atom surfaces the shortcut. No store change, no IPC, no backend.

**Tech Stack:** React 19 + Zustand + TypeScript (Vitest/jsdom/@testing-library), theme tokens in `src/theme/tokens.ts`.

## Global Constraints

- **Shared checkout** `/Users/dev/Projects/kriyon`, branch **`feat/session-lifecycle`**. Stage named files only — never `git add -u`/`-A`. Never touch other sessions' WIP (`crates/kriyon-ptyd/*`, unrelated `src/terminal/*`, `PRODUCT.md`, `public/fonts/`, `.gstack/`).
- **TDD**: failing test first → watch it fail → minimal implementation → green. `pnpm check`'s frontend portion green before every commit.
- **Never hand-format.** Run `pnpm exec ultracite fix <files>` before committing; lint with `pnpm exec ultracite check <files>`.
- **Theme tokens only** (`src/theme/tokens.ts`) — no hardcoded colors/spacing.
- **Conventional commits, lowercase subject** (commitlint rejects Upper/Sentence-case subjects — e.g. no "TDD"/"Kbd" as the first word capitalized mid-subject is fine, but keep the subject lowercase). Small and frequent. `--no-verify`/force-push are hook-blocked.
- **Shortcut display:** the keycap shows **⌘⇧P** including the shift glyph. The ⌘⇧P chord itself is unchanged.
- **Save seeds from the current draft:** `{ body: draft, title: draft.split("\n")[0].slice(0, 60), tags: [] }`, no `id`.
- Verify one frontend file: `pnpm exec vitest run <path>`.

## File structure

- **Create** `src/ui/Kbd.tsx` (+ test) — shared keycap atom.
- **Modify** `src/layout/PromptBar.tsx` — add the two footer buttons; import `useUi` + `Kbd`.
- **Modify** `src/layout/PromptBar.test.tsx` — import `useUi`, reset it in `beforeEach`, add the new tests.

---

### Task 1: `Kbd` keycap atom

There is no shared keycap component today (the recipe is copy-pasted as `kbdStyle` in Shell and `escStyle` in CommandPalette). Add one; the composer's ⌘⇧P hint uses it.

**Files:**
- Create: `src/ui/Kbd.tsx`
- Test: `src/ui/Kbd.test.tsx`

**Interfaces:**
- Produces: `Kbd({ children }: { children: ReactNode })` — renders `children` inside a styled `<kbd>` element.

- [ ] **Step 1: Write the failing test** — create `src/ui/Kbd.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Kbd } from "./Kbd.tsx";

test("renders its children inside a kbd element", () => {
  render(<Kbd>⌘⇧P</Kbd>);
  const cap = screen.getByText("⌘⇧P");
  expect(cap.tagName).toBe("KBD");
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm exec vitest run src/ui/Kbd.test.tsx`
Expected: FAIL — module `./Kbd.tsx` does not exist.

- [ ] **Step 3: Implement** — create `src/ui/Kbd.tsx`:

```tsx
import type { CSSProperties, ReactNode } from "react";
import { tokens } from "../theme/tokens.ts";

const kbdStyle: CSSProperties = {
  background: "rgba(255, 255, 255, 0.07)",
  borderRadius: "5px",
  color: tokens.color.ink.dim,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  padding: "2px 6px",
};

/** A keycap chip for surfacing a keyboard shortcut, e.g. `<Kbd>⌘⇧P</Kbd>`. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd style={kbdStyle}>{children}</kbd>;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm exec vitest run src/ui/Kbd.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec ultracite fix src/ui/Kbd.tsx src/ui/Kbd.test.tsx
git add src/ui/Kbd.tsx src/ui/Kbd.test.tsx
git commit -m "feat(ui): add shared Kbd keycap atom"
```

---

### Task 2: Composer "Prompts ⌘⇧P" button

Add a button to the `PromptBar` footer left cluster that opens the [Prompt picker] and shows the ⌘⇧P keycap.

**Files:**
- Modify: `src/layout/PromptBar.tsx` (imports; footer styles; footer left cluster JSX at lines 217-224)
- Test: `src/layout/PromptBar.test.tsx` (import `useUi`, reset in `beforeEach`, add test)

**Interfaces:**
- Consumes: `Kbd` (Task 1); `useUi.getState().openPromptPicker()` and `useUi(...).promptPickerOpen` (`src/state/ui.ts`).

- [ ] **Step 1: Write the failing test.** In `src/layout/PromptBar.test.tsx`, add the `useUi` import after the other store imports (line 5):

```ts
import { useUi } from "../state/ui.ts";
```

Add a `useUi` reset to the end of the `beforeEach` body (after `state.setActiveSession("s1");`, line 53):

```ts
  useUi.setState({ promptEditorSeed: null, promptPickerOpen: false });
```

Then append this test at the end of the file:

```tsx
test("the Prompts button opens the picker and shows the ⌘⇧P shortcut", () => {
  render(<PromptBar />);
  const btn = screen.getByRole("button", { name: "Open prompt library" });
  expect(btn).toHaveTextContent("⌘⇧P");
  fireEvent.click(btn);
  expect(useUi.getState().promptPickerOpen).toBe(true);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm exec vitest run src/layout/PromptBar.test.tsx -t "Prompts button"`
Expected: FAIL — no button named "Open prompt library".

- [ ] **Step 3: Implement.** In `src/layout/PromptBar.tsx`:

Add imports (after line 5, with the other `../state` / `../ui` imports):

```ts
import { useUi } from "../state/ui.ts";
import { Kbd } from "../ui/Kbd.tsx";
```

Add a footer-action button style next to the other style consts (after `metaStyle`, line 62):

```ts
const footerActionStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.dim,
  cursor: "pointer",
  display: "inline-flex",
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  gap: "6px",
  padding: "4px 7px",
};
```

In the footer left cluster (lines 218-224), add the Prompts button after the usage label. Replace the existing left-cluster `<span>` (lines 218-224) with:

```tsx
          <span style={{ alignItems: "center", display: "flex", gap: "9px" }}>
            <span style={modelChipStyle}>
              Session
              <span style={{ color: tokens.color.ink.faint }}>▾</span>
            </span>
            {usageLabel ? <span style={metaStyle}>{usageLabel}</span> : null}
            <button
              aria-label="Open prompt library"
              onClick={() => useUi.getState().openPromptPicker()}
              style={footerActionStyle}
              type="button"
            >
              Prompts
              <Kbd>⌘⇧P</Kbd>
            </button>
          </span>
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm exec vitest run src/layout/PromptBar.test.tsx`
Expected: PASS (new test + all existing PromptBar tests).

- [ ] **Step 5: Commit**

```bash
pnpm exec ultracite fix src/layout/PromptBar.tsx src/layout/PromptBar.test.tsx
git add src/layout/PromptBar.tsx src/layout/PromptBar.test.tsx
git commit -m "feat(composer): open prompt library from the composer with a ⌘⇧P hint"
```

---

### Task 3: Composer "Save prompt" button

Add a button that opens the [Prompt editor] seeded from the current draft; disabled when the draft is empty.

**Files:**
- Modify: `src/layout/PromptBar.tsx` (footer left cluster; a disabled style)
- Test: `src/layout/PromptBar.test.tsx`

**Interfaces:**
- Consumes: `useUi.getState().openPromptEditor(seed)` where `seed = { body: string; tags: string[]; title: string }` (no `id`) — `src/state/ui.ts` (`PromptEditorSeed`).

- [ ] **Step 1: Write the failing tests.** Append to `src/layout/PromptBar.test.tsx`:

```tsx
test("Save prompt seeds the editor from the current draft", () => {
  useDrafts.setState({
    drafts: { s1: "Refactor the auth module\nsecond line" },
  });
  render(<PromptBar />);
  fireEvent.click(screen.getByRole("button", { name: "Save as prompt" }));
  const seed = useUi.getState().promptEditorSeed;
  expect(seed).toEqual({
    body: "Refactor the auth module\nsecond line",
    tags: [],
    title: "Refactor the auth module",
  });
  expect(seed?.id).toBeUndefined();
});

test("Save prompt is disabled and inert when the draft is empty", () => {
  useDrafts.setState({ drafts: { s1: "   " } });
  render(<PromptBar />);
  const btn = screen.getByRole("button", { name: "Save as prompt" });
  expect(btn).toBeDisabled();
  fireEvent.click(btn);
  expect(useUi.getState().promptEditorSeed).toBeNull();
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `pnpm exec vitest run src/layout/PromptBar.test.tsx -t "Save prompt"`
Expected: FAIL — no button named "Save as prompt".

- [ ] **Step 3: Implement.** In `src/layout/PromptBar.tsx`:

Add a disabled footer-action style after `footerActionStyle` (from Task 2):

```ts
const footerActionDisabledStyle: CSSProperties = {
  ...footerActionStyle,
  color: tokens.color.ink.faint,
  cursor: "default",
  opacity: 0.5,
};
```

In the footer left cluster, add the Save button before the Prompts button (inside the same left `<span>`, right after the `usageLabel` line):

```tsx
            <button
              aria-label="Save as prompt"
              disabled={trimmed.length === 0}
              onClick={() =>
                useUi.getState().openPromptEditor({
                  body: value,
                  tags: [],
                  title: value.split("\n")[0].slice(0, 60),
                })
              }
              style={
                trimmed.length === 0
                  ? footerActionDisabledStyle
                  : footerActionStyle
              }
              title={
                trimmed.length === 0
                  ? "Type a message to save it as a prompt"
                  : "Save this message as a prompt"
              }
              type="button"
            >
              ✦ Save prompt
            </button>
```

(`trimmed` already exists in `PromptBar` — line 111: `const trimmed = value.trim();`.)

- [ ] **Step 4: Run them, verify they pass**

Run: `pnpm exec vitest run src/layout/PromptBar.test.tsx`
Expected: PASS (both new tests + all existing).

- [ ] **Step 5: Commit**

```bash
pnpm exec ultracite fix src/layout/PromptBar.tsx src/layout/PromptBar.test.tsx
git add src/layout/PromptBar.tsx src/layout/PromptBar.test.tsx
git commit -m "feat(composer): save the current draft as a prompt from the composer"
```

---

## Final verification

- [ ] `pnpm typecheck` clean; `pnpm test` green; `pnpm exec ultracite check` clean on the changed files.
- [ ] Real-browser QA (`pnpm dev` + `window.__kriyon` seam, per the prompt-library QA): with an active session, the composer footer shows **✦ Save prompt** and **Prompts ⌘⇧P**; Save is disabled with an empty draft and, with text, opens the editor pre-filled with the draft (title = first line); Prompts opens the picker.
- [ ] Report findings; do not merge without the user.

## Self-review notes

- **Spec coverage:** Save-from-draft (Task 3), Prompts button + ⌘⇧P keycap (Task 2), `Kbd` atom (Task 1), disabled-on-empty (Task 3), reuse editor/picker (Tasks 2/3), shift shown in keycap (Task 2 test asserts `⌘⇧P`), chord unchanged (no terminal/predicate edits). Out-of-scope items (tag chips, restyling existing keycaps, ⌘P chord) are not built.
- **Type consistency:** `openPromptEditor` seed shape `{ body, tags, title }` (no `id`) matches `PromptEditorSeed` (`ui.ts:4-9`); `openPromptPicker()` / `promptPickerOpen` match `ui.ts`. `Kbd`'s `children: ReactNode` matches its single call site.
- **Note for the implementer:** `useUi` is a real store (not mocked) in `PromptBar.test.tsx`; the added `beforeEach` reset keeps tests independent. The bridge mock (`writeStdin` only) is unchanged — `useUi`/`openPromptEditor` need no mock.
