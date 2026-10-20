# Changes View — File Browser & Inspector Entry Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user see the current session's changed files in the right sidebar and click one to land on its diff, and browse/read any file in the project from the Changes view's "All files" tab.

**Architecture:** The Inspector and `ChangesView` live in sibling React subtrees, so the "jump to this file" request travels through the `changes` store (`requestJump` → `ChangesView` consumes and clears) rather than a shared ref. The All-files tab lazily lists directories through the already-shipped `list_dir` command — one call per expanded directory, never a full upfront walk — and `FileViewer` reads a single file through `read_file`, tokenizing the whole file once (correct across multi-line strings/comments) and virtualizing only the rendering.

**Tech Stack:** React 19, zustand 5, `@tanstack/react-virtual` 3.x, shiki 4.x fine-grained via the existing `src/changes/highlighter.ts` singleton, existing Rust `read_file`/`list_dir`/`openPath` commands. No new dependencies.

**Companion docs:** `2026-07-21-code-changes-view-implementation.md` (Phases 1–2, already shipped — this expands its Phase 3 Task 12) and `2026-07-21-code-changes-view.md` (research/rationale).

## Global Constraints

- Branch off the current `feat/changes-view-core`; conventional commits, small and frequent; never commit to `main`.
- `pnpm check` green before every commit. Rust commits need `PATH="$HOME/.cargo/bin:$PATH"`.
- This machine OOMs when Rust tests fork git in parallel — always `CARGO_BUILD_JOBS=1 cargo test ... -- --test-threads=1`.
- Multiple live sessions share this checkout: `git add` named files only, never `git add -u` / `-A` / `.`.
- All design values from `src/theme/tokens.ts` — no hardcoded colors. Use the shared `diffLineColors` helper for added/removed coloring.
- Frontend reaches Rust **only** through `src/ipc/bridge.ts`. No process/fs/network in components.
- shiki must stay out of the entry chunk: never add a static top-level shiki import. Only `src/changes/highlighter.ts` may import it, and only inside async functions.
- Panes are display-toggled and never unmounted (remounting blanks terminals). Any test here asserts display toggling, not mount/unmount.
- `tsc`'s lib target rejects `Array.prototype.at()` while Biome pushes toward it — avoid last-index access patterns entirely.
- Formatting/lint owned by Biome/Ultracite: run `pnpm fix`, never hand-format.
- UI copy says "Undo", never "Reject"/"Discard".
- Files >1 MB or binary: `read_file` already flags them (`truncated`, `binary`) — show a notice, never render garbage.

---

## File structure (locked decomposition)

**Frontend:**
- `src/state/changes.ts` — extend: `pendingJump` + `requestJump`/`consumeJump`; `browser` per-session state (`tab`, `expandedDirs`, `selectedFile`) + its setters.
- `src/inspector/ChangedFilesList.tsx` — NEW: the right-sidebar changed-files list. Presentational; takes files + an `onOpen(path)` callback.
- `src/inspector/Inspector.tsx` — modify: render `ChangedFilesList` inside the existing "Changes" section; wire `onOpen` to `setTranscriptView("changes")` + `requestJump`.
- `src/changes/ChangesView.tsx` — modify: consume `pendingJump`; render `FileBrowserTree` when the All-files tab is active and `FileViewer` when a file is selected.
- `src/changes/FileTreePane.tsx` — modify: enable the All-files tab, driven by store `tab` state.
- `src/changes/FileBrowserTree.tsx` — NEW: lazy `list_dir`-backed directory tree.
- `src/changes/FileViewer.tsx` — NEW: read-only file view with changed-line gutter.

Tests mirror sources: `*.test.ts(x)` beside each component (existing pattern).

---

## Task 1: jump seam in the changes store

The Inspector cannot reach `DiffFeed`'s `scrollToFile` ref handle — it is in a sibling subtree. Route the request through the store instead.

**Files:**
- Modify: `src/state/changes.ts`
- Test: `src/state/changes.test.ts`

**Interfaces — Produces:**
```ts
// Added to SessionChanges:
//   (none — pendingJump is a separate top-level record, so a jump request
//   never invalidates selectors watching a session's diff/totals)
interface ChangesState {
  /** sessionId → path awaiting a scroll, or undefined once consumed. */
  pendingJump: Record<string, string | undefined>;
  /** Ask the Changes view to scroll to `path` next time it renders. */
  requestJump: (sessionId: string, path: string) => void;
  /** Take and clear the pending jump for `sessionId`. */
  consumeJump: (sessionId: string) => void;
}
```

- [ ] **Step 1: Write the failing tests**

Append to `src/state/changes.test.ts`:

```ts
test("requestJump records a pending path for that session only", () => {
  useChanges.getState().requestJump("s1", "src/a.ts");

  expect(useChanges.getState().pendingJump.s1).toBe("src/a.ts");
  expect(useChanges.getState().pendingJump.s2).toBeUndefined();
});

test("consumeJump clears the pending path", () => {
  useChanges.getState().requestJump("s1", "src/a.ts");
  useChanges.getState().consumeJump("s1");

  expect(useChanges.getState().pendingJump.s1).toBeUndefined();
});

test("a later requestJump replaces an unconsumed one", () => {
  useChanges.getState().requestJump("s1", "src/a.ts");
  useChanges.getState().requestJump("s1", "src/b.ts");

  expect(useChanges.getState().pendingJump.s1).toBe("src/b.ts");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/state/changes.test.ts`
Expected: FAIL — `useChanges.getState().requestJump is not a function`.

- [ ] **Step 3: Implement**

In `src/state/changes.ts`, add to the `ChangesState` interface (with the doc comments from the Interfaces block above), add `pendingJump: {}` to the store's initial state, and add the two actions:

```ts
  requestJump: (sessionId, path) =>
    set((state) => ({
      pendingJump: { ...state.pendingJump, [sessionId]: path },
    })),
  consumeJump: (sessionId) =>
    set((state) => {
      if (state.pendingJump[sessionId] === undefined) {
        return state;
      }
      const next = { ...state.pendingJump };
      delete next[sessionId];
      return { pendingJump: next };
    }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/state/changes.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm fix && pnpm typecheck && pnpm vitest run
git add src/state/changes.ts src/state/changes.test.ts
git commit -m "feat(changes): store seam for cross-pane jump-to-file requests"
```

---

## Task 2: ChangesView consumes pending jumps

**Files:**
- Modify: `src/changes/ChangesView.tsx`
- Test: `src/changes/ChangesView.test.tsx`

**Interfaces — Consumes:** `pendingJump` / `consumeJump` (Task 1), `DiffFeedHandle.scrollToFile` (already shipped).

The effect must run after the feed has the file (a jump can arrive before the diff loads), so it depends on both the pending path and the loaded file list, and only consumes once it actually scrolls.

- [ ] **Step 1: Write the failing test**

Append to `src/changes/ChangesView.test.tsx` (follow the file's existing setup helpers, including its jsdom `offsetHeight`/`scrollHeight`/`clientHeight`/`scrollTo` stubs):

```tsx
test("a pending jump scrolls the feed to that file and is then cleared", async () => {
  seedReadySession("s1", [fileDiff("src/a.ts"), fileDiff("src/zz.ts")]);
  renderChangesView("s1");

  act(() => {
    useChanges.getState().requestJump("s1", "src/zz.ts");
  });

  await waitFor(() => {
    expect(document.getElementById(diffCardId("src/zz.ts"))).not.toBeNull();
  });
  expect(useChanges.getState().pendingJump.s1).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/changes/ChangesView.test.tsx`
Expected: FAIL — the card for `src/zz.ts` never renders (nothing consumes the request).

- [ ] **Step 3: Implement**

In `src/changes/ChangesView.tsx`, alongside the existing `diffFeedRef`:

```tsx
  const pendingJump = useChanges((state) => state.pendingJump[sessionId]);
  const consumeJump = useChanges((state) => state.consumeJump);

  useEffect(() => {
    if (pendingJump === undefined) {
      return;
    }
    // A jump can arrive before the diff has loaded; wait for the file to
    // exist in the feed rather than dropping the request.
    if (!files.some((file) => file.path === pendingJump)) {
      return;
    }
    diffFeedRef.current?.scrollToFile(pendingJump);
    consumeJump(sessionId);
  }, [pendingJump, files, consumeJump, sessionId]);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/changes/ChangesView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm fix && pnpm typecheck && pnpm vitest run
git add src/changes/ChangesView.tsx src/changes/ChangesView.test.tsx
git commit -m "feat(changes): scroll to a file when another pane requests it"
```

---

## Task 3: changed-files list in the right sidebar

Today the Inspector's "Changes" section shows only aggregate counts from `git status` (`repo.dirtyCount`, ahead/behind). Add the actual file list beneath them, sourced from the `changes` store the Changes view already populates.

**Files:**
- Create: `src/inspector/ChangedFilesList.tsx`
- Create: `src/inspector/ChangedFilesList.test.tsx`
- Modify: `src/inspector/Inspector.tsx`
- Test: `src/inspector/Inspector.test.tsx`

**Interfaces — Produces:**
```tsx
export function ChangedFilesList(props: {
  files: FileDiff[];
  onOpen: (path: string) => void;
}): JSX.Element;
```
Renders one row per file: the basename (full path as `title`), its `+N −M` counts via `fileDiffCounts`, and a `NEW` badge when `status === "added"`. Rows are `<button type="button">` so they are keyboard reachable. Renders nothing when `files` is empty — the section's existing "Working tree clean" / "Not a git repository" text already covers that case.

**Interfaces — Consumes:** `fileDiffCounts` and `requestJump` from `src/state/changes.ts`, `setTranscriptView` from `src/state/layout.ts`.

- [ ] **Step 1: Write the failing component test**

Create `src/inspector/ChangedFilesList.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { FileDiff } from "../types.ts";
import { ChangedFilesList } from "./ChangedFilesList.tsx";

function file(path: string, status: FileDiff["status"] = "modified"): FileDiff {
  return {
    hunks: [
      {
        header: "@@ -1,1 +1,2 @@",
        lines: [
          { kind: "context", text: "keep" },
          { kind: "added", text: "new" },
        ],
      },
    ],
    oldPath: null,
    path,
    status,
  };
}

test("lists each changed file with its counts", () => {
  render(<ChangedFilesList files={[file("src/a.ts")]} onOpen={() => undefined} />);

  expect(screen.getByText("a.ts")).toBeTruthy();
  expect(screen.getByText("+1")).toBeTruthy();
  expect(screen.getByText("−0")).toBeTruthy();
});

test("marks an added file as NEW", () => {
  render(
    <ChangedFilesList files={[file("src/new.ts", "added")]} onOpen={() => undefined} />
  );

  expect(screen.getByText("NEW")).toBeTruthy();
});

test("clicking a row reports the full path", () => {
  const onOpen = vi.fn();
  render(<ChangedFilesList files={[file("src/deep/a.ts")]} onOpen={onOpen} />);

  fireEvent.click(screen.getByText("a.ts"));

  expect(onOpen).toHaveBeenCalledWith("src/deep/a.ts");
});

test("renders nothing when there are no changed files", () => {
  const { container } = render(
    <ChangedFilesList files={[]} onOpen={() => undefined} />
  );

  expect(container.firstChild).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/inspector/ChangedFilesList.test.tsx`
Expected: FAIL — cannot resolve `./ChangedFilesList.tsx`.

- [ ] **Step 3: Implement `ChangedFilesList`**

Create `src/inspector/ChangedFilesList.tsx`. Take every colour from `tokens` (`tokens.color.add` / `tokens.color.del` for the counts, `tokens.color.ink.*` for text, `tokens.color.surface.hover` for the row hover) and mirror the row density of the existing Inspector `Kv` rows. Return `null` when `files.length === 0`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/inspector/ChangedFilesList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing wiring test**

Append to `src/inspector/Inspector.test.tsx`:

```tsx
test("clicking a changed file opens the Changes view and asks it to jump", () => {
  seedSessionWithDiff("s1", ["src/a.ts"]);
  renderInspector("s1");

  fireEvent.click(screen.getByText("a.ts"));

  expect(useLayout.getState().layout.transcriptView).toBe("changes");
  expect(useChanges.getState().pendingJump.s1).toBe("src/a.ts");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run src/inspector/Inspector.test.tsx`
Expected: FAIL — no row labelled `a.ts` is rendered.

- [ ] **Step 7: Wire it into the Inspector**

In `src/inspector/Inspector.tsx`, inside the existing "Changes" `<section>`, after the `Kv` rows, read the session's diff from the changes store and render the list:

```tsx
  const changedFiles = useChanges(
    (state) => state.bySession[activeSessionId ?? ""]?.diff?.files
  );
```

```tsx
        <ChangedFilesList
          files={changedFiles ?? []}
          onOpen={(path) => {
            setTranscriptView("changes");
            requestJump(session.id, path);
          }}
        />
```

Keep the existing count/`Kv`/empty-state markup exactly as it is — this adds to the section, it does not replace it.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run src/inspector/Inspector.test.tsx src/inspector/ChangedFilesList.test.tsx`
Expected: PASS.

- [ ] **Step 9: Verify and commit**

```bash
pnpm fix && pnpm typecheck && pnpm vitest run
git add src/inspector/ChangedFilesList.tsx src/inspector/ChangedFilesList.test.tsx src/inspector/Inspector.tsx src/inspector/Inspector.test.tsx
git commit -m "feat(inspector): list the session's changed files and jump to their diffs"
```

---

## Task 4: browser state in the changes store

**Files:**
- Modify: `src/state/changes.ts`
- Test: `src/state/changes.test.ts`

**Interfaces — Produces:**
```ts
/** Which tab the Changes view's left column is showing. */
export type FileTreeTab = "all" | "changes";

interface ChangesState {
  /** sessionId → left-column tab (defaults to "changes"). */
  tab: Record<string, FileTreeTab>;
  setTab: (sessionId: string, tab: FileTreeTab) => void;
  /** sessionId → repo-relative dir paths currently expanded in the All-files
   * tree. "" is the repo root. */
  expandedDirs: Record<string, Record<string, boolean>>;
  toggleDir: (sessionId: string, dir: string) => void;
  /** sessionId → repo-relative path open in FileViewer, or undefined for the
   * diff feed. Cleared when the tab goes back to "changes". */
  selectedFile: Record<string, string | undefined>;
  selectFile: (sessionId: string, path: string | undefined) => void;
}
```

- [ ] **Step 1: Write the failing tests**

Append to `src/state/changes.test.ts`:

```ts
test("the tab defaults to changes and can be switched per session", () => {
  expect(useChanges.getState().tab.s1).toBeUndefined();

  useChanges.getState().setTab("s1", "all");

  expect(useChanges.getState().tab.s1).toBe("all");
  expect(useChanges.getState().tab.s2).toBeUndefined();
});

test("switching back to the changes tab clears the selected file", () => {
  useChanges.getState().setTab("s1", "all");
  useChanges.getState().selectFile("s1", "src/a.ts");

  useChanges.getState().setTab("s1", "changes");

  expect(useChanges.getState().selectedFile.s1).toBeUndefined();
});

test("toggleDir expands then collapses a directory", () => {
  useChanges.getState().toggleDir("s1", "src");
  expect(useChanges.getState().expandedDirs.s1?.src).toBe(true);

  useChanges.getState().toggleDir("s1", "src");
  expect(useChanges.getState().expandedDirs.s1?.src).toBe(false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/state/changes.test.ts`
Expected: FAIL — `setTab is not a function`.

- [ ] **Step 3: Implement**

Add the three records to the store's initial state (`tab: {}`, `expandedDirs: {}`, `selectedFile: {}`) and the three actions. `setTab` must clear `selectedFile[sessionId]` when switching to `"changes"`, so returning to the diff feed never leaves a stale file open.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run src/state/changes.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm fix && pnpm typecheck && pnpm vitest run
git add src/state/changes.ts src/state/changes.test.ts
git commit -m "feat(changes): per-session file-browser tab and selection state"
```

---

## Task 5: lazy directory tree (All-files tab)

**Files:**
- Create: `src/changes/FileBrowserTree.tsx`
- Create: `src/changes/FileBrowserTree.test.tsx`

**Interfaces — Consumes:** `listDir` from `src/ipc/bridge.ts`; `expandedDirs`/`toggleDir`/`selectedFile`/`selectFile` (Task 4).

**Interfaces — Produces:**
```tsx
export function FileBrowserTree(props: {
  sessionId: string;
  cwd: string;
}): JSX.Element;
```

Behaviour: fetches the repo root (`""`) on mount, and each directory's entries the first time it is expanded — one `list_dir` per directory, never a recursive walk. Entries render dirs-first (the Rust side already sorts). Gitignored entries render dimmed. A failed `list_dir` for a directory renders an inline error row for that directory only and never throws. Clicking a file calls `selectFile`; clicking a directory calls `toggleDir`.

- [ ] **Step 1: Write the failing tests**

Create `src/changes/FileBrowserTree.test.tsx`, mocking the bridge the way the existing store/component tests do:

```tsx
vi.mock("../ipc/bridge.ts", () => ({ listDir: vi.fn() }));
```

Tests to write:
1. `"lists the repo root on mount"` — `listDir` resolves `[{name: "src", isDir: true, ignored: false}, {name: "README.md", isDir: false, ignored: false}]`; assert both rows render and `listDir` was called with `(cwd, "")`.
2. `"expanding a directory fetches only that directory"` — click `src`; assert `listDir` was called with `(cwd, "src")` and that the total call count is 2 (root + src), proving it is not a recursive walk.
3. `"collapsing and re-expanding does not refetch"` — click `src` three times; assert `listDir` was called exactly twice.
4. `"a gitignored entry is dimmed"` — an entry with `ignored: true` renders with `data-ignored="true"`.
5. `"clicking a file selects it"` — click `README.md`; assert `useChanges.getState().selectedFile.s1 === "README.md"`.
6. `"a failed listing shows an inline error and does not throw"` — `listDir` rejects for `"src"`; assert an error row appears and the root rows are still present.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/changes/FileBrowserTree.test.tsx`
Expected: FAIL — cannot resolve `./FileBrowserTree.tsx`.

- [ ] **Step 3: Implement**

Create `src/changes/FileBrowserTree.tsx`. Hold fetched listings in component state keyed by directory path (`Record<string, DirEntry[] | { error: string }>`); fetch a directory only when it is expanded and not already fetched. Guard every `await` with a cancelled flag so a session switch cannot set state after unmount. Indent by depth using `tokens.space`; dim ignored rows with `tokens.color.ink.faint` and mark them `data-ignored="true"`. Rows are `<button type="button">`.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run src/changes/FileBrowserTree.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm fix && pnpm typecheck && pnpm vitest run
git add src/changes/FileBrowserTree.tsx src/changes/FileBrowserTree.test.tsx
git commit -m "feat(changes): lazy directory tree for the all-files tab"
```

---

## Task 6: read-only FileViewer

**Files:**
- Create: `src/changes/FileViewer.tsx`
- Create: `src/changes/FileViewer.test.tsx`

**Interfaces — Consumes:** `readFile` and `openPath` from `src/ipc/bridge.ts`; `highlightLines`/`langForPath` from `src/changes/highlighter.ts`; the session's `SessionDiff` for gutter markers.

**Interfaces — Produces:**
```tsx
export function FileViewer(props: {
  cwd: string;
  path: string;
  /** The file's diff in the current changeset, if it has one — drives the
   * changed-line gutter markers. */
  fileDiff?: FileDiff;
  onClose: () => void;
}): JSX.Element;
```

**Deviation from the parent plan, deliberate:** the parent plan said "per-visible-range highlighting". Tokenizing only the visible slice produces *wrong* colours whenever a multi-line string, template literal, or block comment starts above the window. This tokenizes the whole file once (memoized per path+content) and virtualizes only the *rendering* of the already-tokenized lines — correct and still bounded, since `read_file` caps content at 1 MB. Files over `MAX_HIGHLIGHT_LINES = 10_000` skip highlighting and render as plain text.

Behaviour:
- `binary: true` → notice row "Binary file — not shown", no content.
- `truncated: true` → render what came back plus a notice that the file was truncated at 1 MB.
- A `readFile` rejection → inline error, never a throw.
- Changed-line gutter: lines added in `fileDiff` get an added-colour gutter mark, using `diffLineColors`. Derive the new-side line numbers by walking each hunk from its `@@` header, exactly as `DiffHunk` does.
- An "Open in editor" button calling `openPath(cwd, path)`.

- [ ] **Step 1: Write the failing tests**

Create `src/changes/FileViewer.test.tsx`, mocking `../ipc/bridge.ts` (`readFile`, `openPath`) and stubbing jsdom measurement as `ChangesView.test.tsx` does. Tests:
1. `"renders the file's lines"` — content `"a\nb\nc"` → three line rows.
2. `"shows a notice for a binary file"` — `{binary: true, content: "", size: 900, truncated: false}` → "Binary file" notice, no line rows.
3. `"shows a notice for a truncated file"` — `truncated: true` → truncation notice AND the returned lines.
4. `"marks changed lines in the gutter"` — a `fileDiff` whose hunk adds line 2 → the row for line 2 carries `data-changed="true"` and line 1 does not.
5. `"surfaces a read failure without throwing"` — `readFile` rejects → error row rendered.
6. `"opens the file in the editor"` — click "Open in editor" → `openPath` called with `(cwd, path)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/changes/FileViewer.test.tsx`
Expected: FAIL — cannot resolve `./FileViewer.tsx`.

- [ ] **Step 3: Implement**

Create `src/changes/FileViewer.tsx`. Fetch on mount and whenever `path` changes, guarded by a cancelled flag. Highlight via `highlightLines(content, langForPath(path))` inside an effect, falling back to plain lines on failure (the highlighter already degrades rather than throwing — do not add a second guard that hides real errors). Virtualize rows with `useVirtualizer`, `overscan: 8`. Every colour from `tokens`.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run src/changes/FileViewer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm fix && pnpm typecheck && pnpm vitest run
git add src/changes/FileViewer.tsx src/changes/FileViewer.test.tsx
git commit -m "feat(changes): read-only file viewer with changed-line gutter"
```

---

## Task 7: enable the All-files tab and wire it together

**Files:**
- Modify: `src/changes/FileTreePane.tsx`
- Modify: `src/changes/ChangesView.tsx`
- Test: `src/changes/FileTreePane.test.tsx`, `src/changes/ChangesView.test.tsx`

**Interfaces — Consumes:** everything above.

`FileTreePane` gains `tab` and `onTabChange` props; the "All files" button loses `disabled` and its `title="coming soon"`. `ChangesView` renders `FileBrowserTree` in the left column when `tab === "all"`, and replaces the diff feed with `FileViewer` when `selectedFile` is set — while keeping `DiffFeed` mounted and display-toggled, per the keep-alive rule.

- [ ] **Step 1: Write the failing tests**

In `src/changes/FileTreePane.test.tsx`:

```tsx
test("the all-files tab is enabled and reports the switch", () => {
  const onTabChange = vi.fn();
  render(<FileTreePane files={[]} onJumpToFile={() => undefined} onTabChange={onTabChange} tab="changes" />);

  const allTab = screen.getByTestId("file-tree-tab-all");
  expect(allTab.hasAttribute("disabled")).toBe(false);

  fireEvent.click(allTab);

  expect(onTabChange).toHaveBeenCalledWith("all");
});
```

In `src/changes/ChangesView.test.tsx`:

```tsx
test("selecting a file in the all-files tab shows the viewer and keeps the feed mounted", async () => {
  seedReadySession("s1", [fileDiff("src/a.ts")]);
  renderChangesView("s1");

  act(() => {
    useChanges.getState().setTab("s1", "all");
    useChanges.getState().selectFile("s1", "src/a.ts");
  });

  await waitFor(() => {
    expect(screen.getByTestId("file-viewer")).toBeTruthy();
  });
  // Kept mounted, not unmounted — the project's pane keep-alive rule.
  expect(screen.getByTestId("diff-feed")).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/changes/FileTreePane.test.tsx src/changes/ChangesView.test.tsx`
Expected: FAIL — the All-files tab is still `disabled`; no `file-viewer` testid exists.

- [ ] **Step 3: Implement**

Enable the tab in `FileTreePane` (drive `activeTabStyle`/`disabledTabStyle` from the `tab` prop, drop `disabled` and the "coming soon" title). In `ChangesView`, read `tab`/`selectedFile` from the store, render `FileBrowserTree` or the changed-file list in the left column accordingly, and display-toggle `FileViewer` against `DiffFeed` rather than unmounting either.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run src/changes/FileTreePane.test.tsx src/changes/ChangesView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full verification and commit**

```bash
pnpm fix && pnpm typecheck && pnpm vitest run && pnpm build
# Confirm shiki is still out of the entry chunk (grep -a — plain grep
# silently skips these minified chunks and reports a false absence):
grep -ac "textmate\|onigLib" dist/assets/main-*.js   # expect 0
git add src/changes/FileTreePane.tsx src/changes/FileTreePane.test.tsx src/changes/ChangesView.tsx src/changes/ChangesView.test.tsx
git commit -m "feat(changes): enable the all-files tab with the read-only file viewer"
```

---

## Exit criteria

- The right sidebar lists the current session's changed files with counts and NEW badges; clicking one switches to the Changes view and scrolls to that file's diff card.
- The All-files tab browses the project lazily (one `list_dir` per expanded directory), dims gitignored entries, and opens any file read-only with syntax highlighting and changed-line gutter markers.
- Binary and truncated files show a notice instead of garbage; a failed listing or read shows an inline error and never breaks the view.
- `pnpm check` green; shiki still absent from the entry chunk; the diff feed and terminal panes are still display-toggled, never unmounted.

## Self-review notes (already applied)

- The Inspector→feed jump goes through the store, not a ref: they are sibling subtrees, and a ref cannot cross that boundary.
- `pendingJump` is a top-level record rather than a field on `SessionChanges`, so requesting a jump does not invalidate selectors watching a session's diff.
- Whole-file tokenization replaces the parent plan's per-visible-range highlighting, because slice-tokenizing miscolours multi-line strings and block comments; bounded by `read_file`'s existing 1 MB cap plus a line-count ceiling.
- `setTab("changes")` clears `selectedFile` so returning to the feed cannot leave a stale viewer open.
- Task 7 asserts the feed stays mounted, honouring the pane keep-alive rule.
