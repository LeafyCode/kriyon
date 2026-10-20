# Editor Hardening & Quick-Edit Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Changes-view file editor fully reliable and add the quick-edit table stakes: find/replace, multi-cursor, git gutter, visible dirty state, and an edit path from the diff feed.

**Architecture:** All editor config stays in `src/changes/CodeEditor.tsx` behind its lazy `loadCore()` dynamic-import pattern (ADR 0016: CodeMirror never in the entry chunk). The state machine stays in `useFileEditorSession.ts`. Git-gutter diffing is a new pure module `src/changes/gitGutter.ts` fed by a new sandboxed Rust command `read_baseline` (HEAD blob text). Colors come only from `src/theme/tokens.ts`.

**Tech Stack:** React 18 + CodeMirror 6 (`@codemirror/*`), new deps `@codemirror/search`, `@codemirror/autocomplete` (close-brackets only), `@codemirror/merge` (`presentableDiff` only). Rust: existing `run_git`/`GitRun` plumbing in `src-tauri/src/git_cmd.rs`.

**Spec:** `docs/superpowers/specs/2026-08-29-editor-hardening-design.md`

## Global Constraints

- TDD: failing test first, watch it fail, implement, watch it pass, commit.
- `pnpm fix` before committing frontend changes (Ultracite owns formatting); never hand-format.
- `pnpm check` must pass before every commit. Run at minimum the touched test files (`pnpm vitest run src/changes/<file>.test.tsx`) per step, and the full check before each commit.
- Commits that touch `.rs` files need `PATH="$HOME/.cargo/bin:$PATH" git commit …` (lefthook rust hooks need cargo).
- Stage named files only (`git add <paths>`), never `git add -u` — the checkout may be shared with other live sessions.
- Conventional commits on branch `feat/editor-hardening`.
- Design values only from `src/theme/tokens.ts` (`themed()` → `--kr-*` vars); new color keys go into `src/theme/themes/types.ts` + `src/theme/themes/base.ts` (`darkChrome` is shared by all themes) and are auto-published by `applyTheme`.
- tsc `lib` predates `Array.prototype.at()`/`Object.hasOwn` — avoid both (Biome will also fight you; use index math).
- `CodeEditor.tsx` may only reach `@codemirror/*`/`@lezer/*`/`./gitGutter.ts` via dynamic `import()` inside effects — never top-level static imports (`gitGutter.ts` itself MAY import statically; it is only ever loaded lazily).
- The Rust↔JS boundary: every new command validates `cwd` via `validate_cwd` and the path via `resolve_within` + `refuse_dot_git` (see `src-tauri/src/file_cmd.rs:162-220` for the canonical order); errors are plain `String` (ADR 0006).
- `CodeEditor.test.tsx` mocks every `@codemirror/*` module with marker-object fakes (see its header comment). New extensions are tested by extending those fakes, not by loading real CodeMirror in jsdom. `useFileEditorSession.test.ts` mocks `../ipc/bridge.ts` — new bridge functions must be added to those `vi.mock` factories.

---

### Task 1: Fix false "changed on disk" after your own save

**Files:**
- Modify: `src/changes/useFileEditorSession.ts` (`save()`, ~line 352-399)
- Test: `src/changes/useFileEditorSession.test.ts`

**Interfaces:**
- Consumes: existing `loadedSigRef` (`useLoadedFile`), `writeFile` result `{ len, mtime }`.
- Produces: no API change; `loadedSigRef.current` now tracks the post-save signature.

- [ ] **Step 1: Write the failing test**

In `useFileEditorSession.test.ts` (crib the store-seeding shape from the existing revalidation tests in the same file — they drive the effect by bumping `bySession[id].fetchedAt`):

```ts
it("does not flag staleOnDisk when revalidation lands after its own save", async () => {
  mockedReadFile.mockResolvedValue(content({ content: "old", mtime: 111, size: 3 }));
  mockedWriteFile.mockResolvedValue({ len: 3, mtime: 222 });

  const { result } = renderHook(() =>
    useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
  );
  await waitFor(() => expect(result.current.edit).not.toBeNull());

  // Arm the revalidation effect (its first fetchedAt observation is a no-op).
  seedFetchedAt("s1", 1); // use the same helper/inline setState shape the existing revalidation tests use
  setDraft(result.current.setEdit, "new");
  act(() => result.current.save());
  await waitFor(() => expect(result.current.dirty).toBe(false));

  // User keeps typing after the save resolved.
  setDraft(result.current.setEdit, "newer");

  // The save's requestRefresh lands: revalidation re-reads the file and sees
  // exactly the signature the save just wrote.
  mockedReadFile.mockResolvedValue(content({ content: "new", mtime: 222, size: 3 }));
  seedFetchedAt("s1", 2);

  // Give the revalidation read a tick to settle, then: no stale banner.
  await waitFor(() => expect(mockedReadFile).toHaveBeenCalledTimes(2));
  expect(result.current.staleOnDisk).toBe(false);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm vitest run src/changes/useFileEditorSession.test.ts -t "after its own save"`
Expected: FAIL — `staleOnDisk` is `true` (revalidation compared against the pre-save `{mtime:111, len:3}`).

- [ ] **Step 3: Implement**

In `save()`'s `.then`, after the staleness guard, alongside the `setEdit` merge:

```ts
loadedSigRef.current = { len: result.len, mtime: result.mtime };
```

- [ ] **Step 4: Run the file's full suite** — `pnpm vitest run src/changes/useFileEditorSession.test.ts` — all pass.

- [ ] **Step 5: Commit**

```bash
pnpm fix && pnpm check
git add src/changes/useFileEditorSession.ts src/changes/useFileEditorSession.test.ts
git commit -m "fix(editor): track the post-save signature so revalidation stops crying wolf"
```

---

### Task 2: Fix the stale-document seed race in CodeEditor

**Files:**
- Modify: `src/changes/CodeEditor.tsx` (mount effect, ~line 522-640)
- Test: `src/changes/CodeEditor.test.tsx`

**Interfaces:**
- Consumes: existing mount effect + `lastEmittedRef`.
- Produces: new `valueRef` (written every render) that Tasks 3 and 10 also rely on being present.

- [ ] **Step 1: Write the failing test**

The fakes resolve their import promises asynchronously, so a `rerender` issued synchronously after `render` lands while the core "chunk" is still loading — exactly the race:

```ts
it("seeds the editor with the latest value, not the mount-time one", async () => {
  const { rerender } = render(
    <CodeEditor language="plain" onChange={vi.fn()} value="stale" />
  );
  rerender(<CodeEditor language="plain" onChange={vi.fn()} value="fresh" />);
  await waitFor(() => expect(lastView).not.toBeNull());
  expect(lastView?.state.doc.toString()).toBe("fresh");
});
```

(`lastView` is the test file's existing "most recently constructed EditorView" ref; the fake `EditorState.create` already records `doc`.)

- [ ] **Step 2: Run it, verify it fails** — doc is `"stale"`.

- [ ] **Step 3: Implement**

Add next to `onChangeRef`/`onSaveRef`:

```ts
const valueRef = useRef(value);
valueRef.current = value;
```

and seed from it at creation time instead of the mount closure:

```ts
const editorState = state.EditorState.create({
  doc: valueRef.current,
  extensions,
});
```

(The `[value]` sync effect early-returns while `viewRef.current` is null; reading `valueRef` at creation closes that window. No other change.)

- [ ] **Step 4: Run** `pnpm vitest run src/changes/CodeEditor.test.tsx` — all pass.

- [ ] **Step 5: Commit** — `git add src/changes/CodeEditor.tsx src/changes/CodeEditor.test.tsx`, message `fix(editor): seed CodeMirror from the latest value, not the mount-time closure` (run `pnpm fix && pnpm check` first; same for every commit below, not repeated again).

---

### Task 3: External value sync must not enter undo history or nuke the selection

**Files:**
- Modify: `src/changes/CodeEditor.tsx` (mount effect + `[value]` sync effect ~line 642-662)
- Test: `src/changes/CodeEditor.test.tsx`

**Interfaces:**
- Consumes: `valueRef` from Task 2; `CoreModules` (add `coreRef`).
- Produces: `coreRef: MutableRefObject<CoreModules | null>` — Task 10 reuses it.

- [ ] **Step 1: Extend the fakes.** In `CodeEditor.test.tsx`'s fake `@codemirror/state` module add:

```ts
Transaction: {
  addToHistory: { of: (value: boolean) => ({ kind: "addToHistory", value }) },
},
```

and make the fake `EditorView.dispatch` record its argument (it likely already records; if not, push specs into a `dispatched: unknown[]` array on the fake view).

- [ ] **Step 2: Write the failing test**

```ts
it("applies external value changes outside the undo history, preserving the selection", async () => {
  const { rerender } = render(
    <CodeEditor language="plain" onChange={vi.fn()} value="abc" />
  );
  await waitFor(() => expect(lastView).not.toBeNull());

  rerender(<CodeEditor language="plain" onChange={vi.fn()} value="xyz" />);

  const spec = lastView?.dispatched[0] as {
    annotations?: { kind: string; value: boolean };
    selection?: { anchor: number };
  };
  expect(spec.annotations).toEqual({ kind: "addToHistory", value: false });
  expect(spec.selection?.anchor).toBeLessThanOrEqual(3);
});
```

(The fake view needs a minimal `state.selection.main.head` — give the fake a `selection: { main: { anchor: 0, head: 0 } }` on its state object.)

- [ ] **Step 3: Run it, verify it fails** — plain `{changes}` spec, no annotation.

- [ ] **Step 4: Implement**

In the mount effect, stash the core modules: `coreRef.current = core;` (declare `const coreRef = useRef<CoreModules | null>(null);` beside `viewRef`; null it in cleanup). Rewrite the sync dispatch:

```ts
const core = coreRef.current;
const head = Math.min(view.state.selection.main.head, value.length);
view.dispatch({
  changes: { from: 0, insert: value, to: current.length },
  ...(core
    ? {
        annotations: core.state.Transaction.addToHistory.of(false),
        selection: { anchor: head },
      }
    : {}),
});
```

- [ ] **Step 5: Run the file suite, then commit** — `fix(editor): keep external reloads out of undo history and off the user's caret`.

---

### Task 4: Deleted-file dead end gets a banner and a way out

**Files:**
- Modify: `src/changes/useFileEditorSession.ts` (revalidation catch ~line 323-327; hook return)
- Modify: `src/changes/FileViewer.tsx` (new banner)
- Test: `src/changes/useFileEditorSession.test.ts`, `src/changes/FileViewer.test.tsx`

**Interfaces:**
- Produces: `missingOnDisk: boolean` on both `useLoadedFile`'s and `useFileEditorSession`'s return objects.

- [ ] **Step 1: Failing hook tests**

```ts
it("flags missingOnDisk when revalidation can no longer read the file", async () => {
  mockedReadFile.mockResolvedValue(content({ content: "hello" }));
  const { result } = renderHook(() =>
    useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
  );
  await waitFor(() => expect(result.current.edit).not.toBeNull());
  seedFetchedAt("s1", 1);

  mockedReadFile.mockRejectedValue(new Error("path does not exist"));
  seedFetchedAt("s1", 2);

  await waitFor(() => expect(result.current.missingOnDisk).toBe(true));
  // the buffer is untouched
  expect(result.current.edit?.draft).toBe("hello");
});

it("clears missingOnDisk when a later revalidation succeeds", async () => {
  // …same setup through the rejection, then:
  mockedReadFile.mockResolvedValue(content({ content: "hello", mtime: 333 }));
  seedFetchedAt("s1", 3);
  await waitFor(() => expect(result.current.missingOnDisk).toBe(false));
});
```

- [ ] **Step 2: Verify both fail** (`missingOnDisk` is undefined).

- [ ] **Step 3: Implement in `useLoadedFile`**

```ts
const [missingOnDisk, setMissingOnDisk] = useState(false);
```

- Revalidation `.catch`: guard on `sameTarget(targetRef.current, revalidatedFor)`, then `setMissingOnDisk(true)` (replace the swallow-only comment; keep swallowing — no error state).
- Revalidation success path, fetch effect reset, and `applyLoaded`: `setMissingOnDisk(false)`.
- Do NOT add `missingOnDisk` to the revalidation skip-conditions — each refresh retries, so a transient failure self-heals.
- Return it from `useLoadedFile` and `useFileEditorSession`.

- [ ] **Step 4: Failing FileViewer test** — render with the hook driven to `missingOnDisk` (drive via the same read-reject route), assert `file-viewer-missing-notice` exists and its Close button calls through to the close guard.

- [ ] **Step 5: Implement the banner in `FileViewer.tsx`** (after the stale banner):

```tsx
{missingOnDisk ? (
  <div data-testid="file-viewer-missing-notice" style={guardBannerStyle}>
    <span style={bannerMessageStyle}>
      This file can no longer be read from disk (deleted or moved).
      {dirty ? " Your unsaved edits are kept." : ""}
    </span>
    <button onClick={guard.closeClick} style={actionButtonStyle} type="button">
      Close
    </button>
  </div>
) : null}
```

- [ ] **Step 6: Run both suites, commit** — `fix(editor): surface a deleted open file instead of showing ghost content`.

---

### Task 5: Pin the conflict-error message across the IPC boundary

**Files:**
- Modify: `src/changes/useFileEditorSession.ts` (~line 40-49), `src-tauri/src/file_cmd.rs` (conflict error ~line 561-565)
- Test: `src/changes/useFileEditorSession.test.ts`, `src-tauri/src/file_cmd.rs` tests module

**Interfaces:**
- Produces: `export const CONFLICT_ERROR_MESSAGE` (TS), `const WRITE_CONFLICT_ERROR: &str` (Rust).

- [ ] **Step 1: Failing TS test**

```ts
import { CONFLICT_ERROR_MESSAGE } from "./useFileEditorSession.ts";

it("pins the Rust write-conflict wording", () => {
  // Must be byte-identical to file_cmd.rs's WRITE_CONFLICT_ERROR.
  expect(CONFLICT_ERROR_MESSAGE).toBe("file changed on disk since it was opened");
});
```

(First read `file_cmd.rs` around line 561 and copy the *actual* literal — if it differs from the above, use the real one in both the test and the constant.)

- [ ] **Step 2: Implement TS side**

```ts
/** Byte-identical to `WRITE_CONFLICT_ERROR` in src-tauri/src/file_cmd.rs —
 * the Reload button lives or dies on this match; both sides pin it with a
 * test. */
export const CONFLICT_ERROR_MESSAGE = "file changed on disk since it was opened";

function isConflictError(message: string): boolean {
  return message.toLowerCase().includes(CONFLICT_ERROR_MESSAGE);
}
```

- [ ] **Step 3: Rust side** — extract the inline literal into a module-level `const WRITE_CONFLICT_ERROR: &str`, use it at the conflict return, add a test:

```rust
#[test]
fn write_conflict_error_wording_is_pinned_for_the_frontend() {
    // src/changes/useFileEditorSession.ts CONFLICT_ERROR_MESSAGE must be
    // byte-identical; its test pins the same literal.
    assert_eq!(WRITE_CONFLICT_ERROR, "file changed on disk since it was opened");
}
```

- [ ] **Step 4: Run** `pnpm vitest run src/changes/useFileEditorSession.test.ts` and `cargo test -p kriyon --manifest-path src-tauri/Cargo.toml file_cmd` (or the repo's usual `cargo test` invocation) — pass.

- [ ] **Step 5: Commit** (remember `PATH="$HOME/.cargo/bin:$PATH"`) — `fix(editor): pin the conflict-error wording on both sides of the IPC seam`.

---

### Task 6: Guard against the blank hidden-mount editor

**Files:**
- Modify: `src/changes/CodeEditor.tsx` (mount effect)
- Test: `src/changes/CodeEditor.test.tsx`

**Interfaces:** none new (internal ResizeObserver).

- [ ] **Step 1: Failing test** — swap the global ResizeObserver stub for a recording one inside this test:

```ts
it("requests a measure when the container is resized or becomes visible", async () => {
  const observed: Element[] = [];
  class RecordingRO {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(el: Element) { observed.push(el); }
    disconnect() { /* recorded via spy below if needed */ }
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", RecordingRO);
  render(<CodeEditor language="plain" onChange={vi.fn()} value="x" />);
  await waitFor(() => expect(lastView).not.toBeNull());
  expect(observed).toContain(screen.getByTestId("code-editor"));
  vi.unstubAllGlobals();
});
```

Also assert `lastView.requestMeasure` (add a `vi.fn()` `requestMeasure` to the fake view) is called when the recorded callback fires.

- [ ] **Step 2: Verify it fails.**

- [ ] **Step 3: Implement** — in the mount `.then`, after `viewRef.current = new view.EditorView(…)`:

```ts
// The pane can be display:none when this mounts (ChangesView keeps the
// viewer alive across tab flips). A view created at zero size renders
// blank until CodeMirror happens to re-measure; nudge it explicitly
// whenever the container's size changes (including 0 → visible).
if (typeof ResizeObserver !== "undefined") {
  resizeObserver = new ResizeObserver(() => {
    viewRef.current?.requestMeasure();
  });
  resizeObserver.observe(containerRef.current);
}
```

with `let resizeObserver: ResizeObserver | undefined;` at the effect top and `resizeObserver?.disconnect();` in the cleanup.

- [ ] **Step 4: Run the suite, commit** — `fix(editor): re-measure CodeMirror when its container resizes or becomes visible`.

---

### Task 7: Find/replace, ⌘D, multi-cursor, auto-close brackets, selection matches

**Files:**
- Modify: `package.json` (deps), `src/changes/CodeEditor.tsx` (CoreModules, loadCore, extensions, theme)
- Test: `src/changes/CodeEditor.test.tsx`

**Interfaces:**
- Consumes: nothing new upstream.
- Produces: `CoreModules` gains `search: typeof import("@codemirror/search")` and `autocomplete: typeof import("@codemirror/autocomplete")` — Task 10's loader order must match.

- [ ] **Step 1: Add deps**

Run: `pnpm add @codemirror/search @codemirror/autocomplete`
(Exact versions land in the lockfile; both are first-party Marijn packages.)

- [ ] **Step 2: Failing test** — add fake modules in `CodeEditor.test.tsx` mirroring the existing fake pattern:

```ts
vi.mock("@codemirror/search", () => ({
  search: (config?: unknown) => ({ kind: "search", value: config }),
  searchKeymap: [{ key: "Mod-f", kind: "searchKeymapBinding" }],
  highlightSelectionMatches: () => ({ kind: "highlightSelectionMatches" }),
}));
vi.mock("@codemirror/autocomplete", () => ({
  closeBrackets: () => ({ kind: "closeBrackets" }),
  closeBracketsKeymap: [{ key: "Backspace", kind: "closeBracketsBinding" }],
}));
```

(Also extend the fake `@codemirror/state` with `allowMultipleSelections: { of: (v: boolean) => ({ kind: "allowMultipleSelections", value: v }) }` on `EditorState`, and the fake `@codemirror/view` with `rectangularSelection: () => ({ kind: "rectangularSelection" })`.)

Then, using the existing `flattenExtensions(lastView.state.extensions)` helper:

```ts
it("mounts search, close-brackets, selection-match and multi-cursor support", async () => {
  render(<CodeEditor language="plain" onChange={vi.fn()} value="x" />);
  await waitFor(() => expect(lastView).not.toBeNull());
  const kinds = flattenExtensions(lastView?.state.extensions).map((e) => e.kind);
  for (const kind of [
    "search",
    "highlightSelectionMatches",
    "closeBrackets",
    "allowMultipleSelections",
    "rectangularSelection",
  ]) {
    expect(kinds).toContain(kind);
  }
});
```

Plus a keymap-order test: flatten the keymap extensions and assert a `closeBracketsBinding` appears before the default keymap's entries and a `searchKeymapBinding` is present.

- [ ] **Step 3: Verify it fails.**

- [ ] **Step 4: Implement**

- `CoreModules` + `loadCore`: add the two imports to the `Promise.all` (keep the destructure order matched — this is the classic loadCore bug; the array and the destructure must line up).
- Extensions (inside the existing array):

```ts
view.keymap.of([
  ...autocomplete.closeBracketsKeymap,
  ...commands.defaultKeymap,
  ...search.searchKeymap,
  ...commands.historyKeymap,
  commands.indentWithTab,
]),
// replaces the existing defaultKeymap/historyKeymap keymap.of — one keymap, correct precedence
autocomplete.closeBrackets(),
search.search({ top: true }),
search.highlightSelectionMatches(),
state.EditorState.allowMultipleSelections.of(true),
view.rectangularSelection(),
```

(The Mod-s keymap stays first and separate. `searchKeymap` ships Mod-f/Mod-g/Alt-Mod-f and **Mod-d → selectNextOccurrence**.)

- Theme additions in `buildEditorTheme` (all values via `tokens`):

```ts
".cm-panels": {
  backgroundColor: color.surface.s1,
  border: "none",
  color: color.text,
  fontFamily: font.sans,
},
".cm-panels.cm-panels-top": { borderBottom: `1px solid ${color.line.soft}` },
".cm-panel.cm-search": { fontSize: "11.5px", padding: "6px 8px" },
".cm-panel.cm-search input": {
  background: color.codeWell,
  border: `1px solid ${color.line.base}`,
  borderRadius: tokens.radius.sm,
  color: color.text,
  outline: "none",
},
".cm-panel.cm-search button": {
  background: color.surface.s1,
  border: `1px solid ${color.line.base}`,
  borderRadius: tokens.radius.sm,
  color: color.ink.secondary,
  cursor: "pointer",
},
".cm-panel.cm-search label": { color: color.ink.secondary },
".cm-searchMatch": { backgroundColor: color.surface.s2 },
".cm-searchMatch-selected": { backgroundColor: color.surface.s3 ?? color.surface.s2 },
".cm-selectionMatch": { backgroundColor: color.surface.s2 },
```

(Check what surface steps exist in `tokens.ts` — if there is no `s3`, use an accent-tinted value only if a `accentAlpha`-style helper already exists; otherwise stay on `s2`. Never hardcode a color.)

- [ ] **Step 5: Run suite + `pnpm check`, commit** — `feat(editor): find/replace, select-next-occurrence, multi-cursor, close-brackets`.

---

### Task 8: Rust `read_baseline` command (HEAD blob text)

**Files:**
- Modify: `src-tauri/src/git_cmd.rs` (new command + tests), `src-tauri/src/file_cmd.rs` (make `resolve_within`, `refuse_dot_git`, `MAX_READ_BYTES` `pub(crate)`), `src-tauri/src/lib.rs` (register command), `src/ipc/bridge.ts` (wrapper)
- Test: `git_cmd.rs` tests module (temp-repo pattern already used by `capture_baseline` tests)

**Interfaces:**
- Produces (Rust):

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineContent {
    pub tracked: bool,
    pub content: Option<String>,
}
```

- Produces (TS, in `bridge.ts`):

```ts
export interface BaselineContent {
  tracked: boolean;
  content: string | null;
}
export function readBaseline(cwd: string, path: string): Promise<BaselineContent> {
  return invoke("read_baseline", { cwd, path });
}
```

- [ ] **Step 1: Failing Rust tests** (mirror the existing temp-repo + store-state test helpers in `git_cmd.rs`/`file_cmd.rs`; test the sync core, not the `#[tauri::command]`):

```rust
#[test]
fn read_baseline_returns_the_head_version_not_the_working_tree() { /* init repo, commit "old", write "new" to disk, assert content == Some("old") */ }
#[test]
fn read_baseline_reports_untracked_files() { /* file on disk, never committed → tracked: false, content: None */ }
#[test]
fn read_baseline_refuses_paths_outside_the_root() { /* "../escape" → Err */ }
#[test]
fn read_baseline_refuses_dot_git() { /* ".git/config" → Err */ }
#[test]
fn read_baseline_drops_binary_blobs() { /* commit bytes with NUL → tracked: true, content: None */ }
#[test]
fn read_baseline_drops_oversized_blobs() { /* > MAX_READ_BYTES committed → tracked: true, content: None */ }
```

- [ ] **Step 2: Verify they fail to compile/run.**

- [ ] **Step 3: Implement** (in `git_cmd.rs`, near the other cwd-based commands):

```rust
/// The HEAD version of one working-tree file, for the editor's git gutter.
/// Sandboxed exactly like `file_cmd::read_file` (same root validation, same
/// `.git` refusal); `content: None` (with `tracked: true`) means the blob is
/// too large, binary, or not UTF-8 — the gutter silently stays off.
fn read_baseline_sync(cwd_canonical: &Path, path: &str) -> Result<BaselineContent, String> {
    let resolved = crate::file_cmd::resolve_within(cwd_canonical, path)?;
    crate::file_cmd::refuse_dot_git(cwd_canonical, path, &resolved)?; // match the real signature at file_cmd.rs:147
    let cwd = cwd_canonical.to_string_lossy();
    let spec = format!("HEAD:./{path}");
    if run_git(&cwd, &["cat-file", "-e", &spec]).is_err() {
        return Ok(BaselineContent { tracked: false, content: None });
    }
    let size: u64 = run_git(&cwd, &["cat-file", "-s", &spec])?
        .trim()
        .parse()
        .map_err(|_| "unexpected git cat-file -s output".to_string())?;
    if size > crate::file_cmd::MAX_READ_BYTES {
        return Ok(BaselineContent { tracked: true, content: None });
    }
    let bytes = GitRun::new(&cwd).args(&["cat-file", "blob", &spec]).bytes()?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Ok(BaselineContent { tracked: true, content: None });
    }
    Ok(BaselineContent {
        tracked: true,
        content: String::from_utf8(bytes).ok(),
    })
}

#[tauri::command(async)]
pub fn read_baseline(
    store: tauri::State<'_, crate::store::Store>,
    cwd: String,
    path: String,
) -> Result<BaselineContent, String> {
    // match the exact state/validate shape of read_file in file_cmd.rs:244-249
    let cwd_canonical = validate_cwd(store_state, Path::new(&cwd))?;
    read_baseline_sync(&cwd_canonical, &path)
}
```

Adjust helper signatures/visibility to what `file_cmd.rs` actually has (`pub(crate) fn resolve_within`, `pub(crate) fn refuse_dot_git`, `pub(crate) const MAX_READ_BYTES`) and copy the exact `tauri::State` plumbing `read_file` uses. Register `read_baseline` in the `invoke_handler` list in `lib.rs`. Add the `bridge.ts` wrapper.

- [ ] **Step 4: Run** the repo's Rust tests + clippy (`pnpm check` covers both) — pass.

- [ ] **Step 5: Commit** (with cargo PATH) — `feat(git): read_baseline command returns the HEAD blob for the editor gutter`.

---

### Task 9: `gitGutter.ts` — pure diff-to-lines mapping + gutter extension

**Files:**
- Create: `src/changes/gitGutter.ts`
- Modify: `package.json` (dep)
- Test: `src/changes/gitGutter.test.ts` (new; real `@codemirror/*` imports are fine here — vitest/node, not the jsdom fake seam)

**Interfaces:**
- Produces:

```ts
export interface LineChanges {
  added: Set<number>;    // 1-based line numbers in the current doc
  modified: Set<number>;
  deleted: Set<number>;  // line numbers a deletion sits at (marker rendered on that line)
}
export function computeLineChanges(baseline: string, current: string): LineChanges;
export function gitGutter(baseline: string): Extension; // full extension incl. gutter + 200ms debounced recompute
export const GIT_GUTTER_DEBOUNCE_MS = 200;
```

- [ ] **Step 1: Add dep** — `pnpm add @codemirror/merge`.

- [ ] **Step 2: Failing pure-function tests**

```ts
import { describe, expect, it } from "vitest";
import { computeLineChanges } from "./gitGutter.ts";

describe("computeLineChanges", () => {
  it("returns nothing for identical docs", () => {
    const r = computeLineChanges("a\nb\n", "a\nb\n");
    expect(r.added.size + r.modified.size + r.deleted.size).toBe(0);
  });
  it("marks a changed line as modified", () => {
    const r = computeLineChanges("a\nb\nc", "a\nX\nc");
    expect([...r.modified]).toEqual([2]);
    expect(r.added.size).toBe(0);
  });
  it("marks inserted lines as added", () => {
    const r = computeLineChanges("a\nc", "a\nb\nc");
    expect(r.added.has(2)).toBe(true);
  });
  it("marks a removal on the line it collapsed onto", () => {
    const r = computeLineChanges("a\nb\nc", "a\nc");
    expect(r.deleted.size).toBe(1);
  });
  it("treats an empty baseline as all-added (untracked file)", () => {
    const r = computeLineChanges("", "a\nb");
    expect(r.added.has(1)).toBe(true);
    expect(r.added.has(2)).toBe(true);
  });
});
```

- [ ] **Step 3: Verify they fail** (module doesn't exist).

- [ ] **Step 4: Implement**

```ts
import { presentableDiff } from "@codemirror/merge";
import { Text } from "@codemirror/state";

export function computeLineChanges(baseline: string, current: string): LineChanges {
  const added = new Set<number>();
  const modified = new Set<number>();
  const deleted = new Set<number>();
  const doc = Text.of(current.split("\n"));
  for (const change of presentableDiff(baseline, current)) {
    if (change.fromB === change.toB) {
      deleted.add(doc.lineAt(Math.min(change.fromB, doc.length)).number);
      continue;
    }
    const bucket = change.fromA === change.toA ? added : modified;
    const from = doc.lineAt(Math.min(change.fromB, doc.length)).number;
    const to = doc.lineAt(Math.min(Math.max(change.toB - 1, change.fromB), doc.length)).number;
    for (let line = from; line <= to; line += 1) {
      bucket.add(line);
    }
  }
  return { added, modified, deleted };
}
```

Then the extension: a `GutterMarker` subclass whose `elementClass` is `cm-gitMarker cm-gitAdded|cm-gitModified|cm-gitDeleted`; a `StateField<RangeSet<GutterMarker>>` updated by a private `setMarks` StateEffect; a `ViewPlugin` that on `docChanged` debounces `GIT_GUTTER_DEBOUNCE_MS` (setTimeout, cleared in `destroy()`) then computes `computeLineChanges(baseline, view.state.doc.toString())`, builds a `RangeSetBuilder` of markers at each line's `from`, and dispatches `setMarks`; and `gutter({ class: "cm-gitGutter", markers: (view) => view.state.field(marksField) })`. Initial field value: computed synchronously from the initial doc. Follow the official gutter example shapes (`gutter`, `GutterMarker` from `@codemirror/view`). Add a test that `gitGutter("x")` returns a truthy extension array (smoke; behavior is covered by the pure function + Task 10's wiring test).

- [ ] **Step 5: Run** `pnpm vitest run src/changes/gitGutter.test.ts` — pass. Commit — `feat(editor): pure git-gutter line mapping over @codemirror/merge`.

---

### Task 10: Wire the gutter — baseline fetch, CodeEditor prop, `mod` token

**Files:**
- Modify: `src/changes/useFileEditorSession.ts` (baseline fetch), `src/changes/FileViewer.tsx` (prop), `src/changes/CodeEditor.tsx` (prop + compartment + theme), `src/theme/themes/types.ts`, `src/theme/themes/base.ts`, `src/theme/tokens.ts`
- Test: `src/changes/useFileEditorSession.test.ts`, `src/changes/CodeEditor.test.tsx`, `src/changes/FileViewer.test.tsx`

**Interfaces:**
- Consumes: `readBaseline` (Task 8), `gitGutter` (Task 9), `coreRef` (Task 3).
- Produces: `CodeEditorProps.baseline?: string` (`undefined` = gutter off; `""` = untracked → all added); `useFileEditorSession` returns `baseline: string | undefined`.

- [ ] **Step 1: `mod` token.** `src/theme/themes/types.ts`: add `mod: string;` beside `del`. `src/theme/themes/base.ts` (`darkChrome`): `mod: "#7FB4E6",` (VSCode-family blue; sits between `add` green and `del` red). `src/theme/tokens.ts`: `mod: themed("mod"),` beside `del`. Run `pnpm vitest run src/theme` — if `themes.test.ts` asserts key coverage, it now passes/updates trivially.

- [ ] **Step 2: Failing hook test** — add `readBaseline: vi.fn()` to the bridge `vi.mock` factory first:

```ts
it("fetches the git baseline for the open file and survives fetch failure", async () => {
  mockedReadFile.mockResolvedValue(content({ content: "now" }));
  mockedReadBaseline.mockResolvedValue({ content: "was", tracked: true });
  const { result } = renderHook(() =>
    useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
  );
  await waitFor(() => expect(result.current.baseline).toBe("was"));
});
// untracked → ""
// content: null (binary/oversized) → undefined
// rejected promise → undefined, and state.status still "loaded"
```

- [ ] **Step 3: Implement the fetch** in `useLoadedFile`: a `baseline` state; in the fetch effect and the revalidation success path, fire `readBaseline(target.cwd, target.path)` alongside (not blocking) the content read:

```ts
readBaseline(fetchedFor.cwd, fetchedFor.path)
  .then((b) => {
    if (cancelled /* or !sameTarget(...) in the revalidation */) return;
    setBaseline(b.tracked ? (b.content ?? undefined) : "");
  })
  .catch(() => {
    /* gutter is a decoration; never an error state */
  });
```

Semantics (must match Task 10's CodeEditor prop): `tracked: false → ""` (untracked, all lines added); `tracked: true, content: null → undefined` (gutter off). Reset to `undefined` at the top of the fetch effect. Return `baseline` from both hooks.

- [ ] **Step 4: Failing CodeEditor test** — fake `./gitGutter.ts` in the fake-module block: `vi.mock("./gitGutter.ts", () => ({ gitGutter: (b: string) => ({ kind: "gitGutter", value: b }) }))`. Assert: with `baseline="was"` the flattened extensions contain `{kind: "gitGutter", value: "was"}`; with `baseline` undefined they don't; and a `baseline` prop change dispatches a compartment `reconfigure` carrying the new value.

- [ ] **Step 5: Implement in `CodeEditor.tsx`**

- Prop: `baseline?: string;` + `const baselineRef = useRef(baseline); baselineRef.current = baseline;`
- `CoreModules` gains `gitGutter: typeof import("./gitGutter.ts")` — add `import("./gitGutter.ts")` to `loadCore`'s `Promise.all` (destructure order!). This keeps merge/gutter code out of the entry chunk with zero extra latency states.
- Mount: `const gutterCompartment = new state.Compartment();` stored in a ref like the readOnly one; extension entry:

```ts
gutterCompartment.of(
  baselineRef.current === undefined ? [] : gitGutterMod.gitGutter(baselineRef.current)
),
```

- New effect keyed `[baseline]`, mirroring the readOnly-compartment effect: reconfigure to `[]` or `gitGutter(baseline)` via `coreRef.current`.
- Theme additions in `buildEditorTheme`:

```ts
".cm-gitGutter": { width: "3px" },
".cm-gitMarker": { height: "100%" },
".cm-gitAdded": { background: color.add },
".cm-gitModified": { background: color.mod },
".cm-gitDeleted": {
  background: color.del,
  height: "2px",
  marginTop: "auto",
},
```

(Tune visually later in Task 13's polish pass; structure now.)

- [ ] **Step 6: FileViewer** — pass `baseline={baseline}` to `<CodeEditor>`; add a `FileViewer.test.tsx` assertion that the baseline reaches the editor (existing tests already spy on CodeEditor props or render the fake — follow whichever pattern the file uses).

- [ ] **Step 7: Run all three suites + `pnpm check`, commit** — `feat(editor): VSCode-style git gutter fed by the HEAD baseline`.

---

### Task 11: Dirty state visible in the file tree

**Files:**
- Modify: `src/state/changes.ts` (state + action), `src/changes/useFileEditorSession.ts` (publish), `src/changes/FileBrowserTree.tsx` (dot)
- Test: `src/state/changes.test.ts` (if present — else the hook test), `src/changes/useFileEditorSession.test.ts`, `src/changes/FileBrowserTree.test.tsx`

**Interfaces:**
- Produces: `ChangesState.dirtyFiles: Record<string, string | null>` (sessionId → currently-dirty open path) + `setDirtyFile(sessionId: string, path: string | null): void`.

- [ ] **Step 1: Failing store/hook tests**

```ts
it("publishes the dirty path to the store and clears it on revert", async () => {
  mockedReadFile.mockResolvedValue(content({ content: "hello" }));
  const { result } = renderHook(() =>
    useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
  );
  await waitFor(() => expect(result.current.edit).not.toBeNull());
  setDraft(result.current.setEdit, "hell");
  await waitFor(() =>
    expect(useChanges.getState().dirtyFiles.s1).toBe("a.ts")
  );
  act(() => result.current.revert());
  await waitFor(() => expect(useChanges.getState().dirtyFiles.s1).toBeNull());
});
```

- [ ] **Step 2: Implement** — store: `dirtyFiles: {}` initial, `setDirtyFile` setter, and clear the session's entry in `dropSession` next to `fileDrafts`. Hook (in `useFileEditorSession`, after `dirty` is computed):

```ts
useEffect(() => {
  if (!sessionId) {
    return;
  }
  useChanges.getState().setDirtyFile(sessionId, dirty ? target.path : null);
}, [dirty, sessionId, target.path]);
useEffect(
  () => () => {
    if (sessionId) {
      useChanges.getState().setDirtyFile(sessionId, null);
    }
  },
  [sessionId]
);
```

(Unmount clears the live flag; a stashed draft is still visible via `fileDrafts` below.)

- [ ] **Step 3: Failing tree test** — seed `useChanges.setState({ dirtyFiles: { s1: "src/a.ts" }, fileDrafts: { s1: { "src/b.ts": draft } } })`, render `FileBrowserTree`, expand to the rows, assert both rows contain `data-testid="tree-dirty-dot"` and a clean row doesn't.

- [ ] **Step 4: Implement the dot** in the file-row render (`FileBrowserTree.tsx` ~line 358-372):

```tsx
{isDirty ? (
  <span
    aria-label="Unsaved changes"
    data-testid="tree-dirty-dot"
    style={treeDirtyDotStyle}
  />
) : null}
```

with `isDirty = dirtyPath === path || Boolean(drafts?.[path])` from two narrow store subscriptions (`s.dirtyFiles[sessionId]`, `s.fileDrafts[sessionId]`), and:

```ts
const treeDirtyDotStyle: CSSProperties = {
  background: tokens.color.status.waiting,
  borderRadius: "50%",
  flex: "none",
  height: "6px",
  marginLeft: "auto",
  width: "6px",
};
```

- [ ] **Step 5: Run suites + check, commit** — `feat(editor): show unsaved-changes dots in the file tree`.

---

### Task 12: Edit from the diff feed

**Files:**
- Modify: `src/changes/DiffFileCard.tsx` (edit button), `src/changes/DiffFeed.tsx` (thread prop), `src/changes/ChangesView.tsx` (handler), `src/changes/FileTreePane.tsx` (row affordance)
- Test: `src/changes/DiffFileCard.test.tsx`, `src/changes/ChangesView.test.tsx`

**Interfaces:**
- Produces: `DiffFileCard` prop `onEdit?: () => void`; `DiffFeed` prop `onEditFile?: (path: string) => void`; `FileTreePane` prop `onEditFile?: (path: string) => void`.

- [ ] **Step 1: Failing card test** — render `DiffFileCard` with `onEdit`, click the button labeled "Edit file", assert it fired (and that it does NOT toggle the card's collapse — the toggle is a sibling button).

- [ ] **Step 2: Implement the button** — next to the existing Copy button in the header row, same visual family:

```tsx
import { Copy, Pencil } from "lucide-react";
// …
{onEdit ? (
  <button
    aria-label="Edit file"
    onClick={onEdit}
    style={copyButtonStyle /* reuse the Copy button's style constant */}
    title="Edit this file"
    type="button"
  >
    <Pencil size={13} />
  </button>
) : null}
```

- [ ] **Step 3: Failing ChangesView test** — render with a diff containing `src/a.ts`, click its card's "Edit file", assert the viewer opens on `src/a.ts` (the store's `selectedFile` for the session is set AND the tab flipped to `"all"` — find the exact tab action name in `state/changes.ts`; `computeShowViewer` at `ChangesView.tsx:69-74` requires `tab === "all"`).

- [ ] **Step 4: Wire it** — in `ChangesView`, pass to `DiffFeed`:

```ts
onEditFile={(path) => {
  const store = useChanges.getState();
  store.selectFile(sessionId, path);
  store.setTab(sessionId, "all"); // use the real tab-setter name
}}
```

`DiffFeed` forwards `onEdit={() => onEditFile?.(file.path)}` per card. A dirty open file is already protected: `selectFile` on a different path routes through `useTarget`'s pending-switch guard.

- [ ] **Step 5: FileTreePane rows** — the Changes-tab rows currently call `onJumpToFile`; add a small pencil button on the row (visible on hover via the row's existing hover pattern, or always-visible if the rows have no hover machinery — match local style), calling the same `onEditFile`. Add one test in the pane/view suite.

- [ ] **Step 6: Run suites + check, commit** — `feat(changes): edit a file straight from its diff card`.

---

### Task 13: Tokenize the editor's remaining hardcoded colors

**Files:**
- Modify: `src/theme/themes/types.ts`, `src/theme/themes/base.ts`, `src/theme/tokens.ts`, `src/changes/CodeEditor.tsx`
- Test: existing theme tests (`src/theme/themes/themes.test.ts`) + `CodeEditor.test.tsx` compiles

**Interfaces:**
- Produces: `ThemeColors.editorActiveLine`, `.editorIndentGuide`, `.editorIndentGuideActive`; `tokens.color.editorActiveLine` etc.

- [ ] **Step 1:** Add the three keys to `types.ts`; values in `base.ts`'s `darkChrome` (current literals, unchanged look):

```ts
editorActiveLine: "rgba(255, 255, 255, 0.030)",
editorIndentGuide: "rgba(255, 255, 255, 0.07)",
editorIndentGuideActive: "rgba(255, 255, 255, 0.16)",
```

`tokens.ts`: `editorActiveLine: themed("editorActiveLine"),` (+ the other two).

- [ ] **Step 2:** `CodeEditor.tsx`: `.cm-activeLine` background → `color.editorActiveLine`; `indentationMarkers` colors → `{ activeDark: color.editorIndentGuideActive, dark: color.editorIndentGuide }`.

**Note:** the `indentationMarkers` package may require literal color strings at configure time rather than `var()` refs — verify it renders (it draws via CSS custom properties internally, so `var(--kr-…)` strings should pass through; if it computes on them, keep the literals in `base.ts` and read them via `getComputedStyle` — flag in review if so).

- [ ] **Step 3:** Run `pnpm vitest run src/theme src/changes/CodeEditor.test.tsx` + `pnpm check`, commit — `refactor(editor): editor active-line and indent-guide colors come from tokens`.

---

### Task 14: Final verification + PR

**Files:** none new.

- [ ] **Step 1:** Full `pnpm check` (types, lint, frontend + Rust tests, clippy) — green.
- [ ] **Step 2:** ADR 0016 entry-chunk invariant: `pnpm build`, then verify the entry chunk stayed CodeMirror-free:

```bash
rg -l "codemirror|@codemirror|presentableDiff" dist/assets/main-*.js && echo "FAIL: editor leaked into entry chunk" || echo "entry chunk clean"
```

- [ ] **Step 3:** Update `docs/adr/0016-codemirror-editor.md` with a short addendum: search/close-brackets/multi-cursor/git-gutter added 2026-08-29, same lazy-chunk discipline, `@codemirror/merge` used for `presentableDiff` only.
- [ ] **Step 4:** Push and open the PR to `main`:

```bash
git push -u origin feat/editor-hardening
gh pr create --title "feat(editor): hardening + quick-edit table stakes" --body "…summary of P1 fixes / P2 features / P3 polish, spec + plan links…"
```
