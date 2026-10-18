# Editor hardening & quick-edit polish — design

**Date:** 2026-08-29
**Status:** Approved (scope P1+P2+P3, full)
**Relates to:** ADR 0016 (CodeMirror editor), ADR 0017 (working-tree budget), spec 2026-07-22 (changes view round two)

## Goal

Make the file editor in the Changes view fully reliable, fast, and pleasant for
*quick edits* — the "fix this line while Claude works" flow. Claude-first: this is
not a full IDE. Target the basics a VSCode/Cursor user's fingers expect, nothing more.

Explicitly out of scope (over-engineering for a quick-edit pane): autocompletion,
lint, code folding, minimap, multi-file tabs, autosave (ADR 0016 forbids it),
format-on-save, `@uiw/react-codemirror`, third-party git-gutter packages.

## Phase 1 — Reliability (bug fixes, all found by code study)

1. **Stale-doc race.** `CodeEditor`'s mount effect closes over `value` at mount
   time; the sync effect early-returns while `viewRef.current` is null. Any
   `value` change landing during the async `loadCore()`/grammar window is lost —
   editor shows stale content until remount. Fix: track latest `value` in a ref;
   after `EditorView` creation, reconcile if it moved.
2. **False "changed on disk" after own save.** `save()` updates `edit.sig` but
   never `loadedSigRef`; the post-save `requestRefresh` triggers revalidation
   against the *pre-save* signature → spurious stale banner when the user typed
   during save. Fix: update `loadedSigRef.current` in the save `.then`.
3. **External reload pollutes undo + kills selection/scroll.** The value-sync
   dispatch is an ordinary transaction: after a clean auto-reload, ⌘Z restores
   pre-Claude content and marks dirty. Fix: dispatch with
   `addToHistory.of(false)`, map/preserve selection (clamped), keep scroll.
4. **Deleted-file dead end.** Open file deleted on disk → revalidation swallows
   the read error, viewer shows ghost content; save fails with a non-conflict
   error and no recovery. Fix: detect missing-file on revalidate → banner
   "File was deleted on disk" with Close (and Keep-draft if dirty); save error
   path gains the same affordance.
5. **Conflict-error string coupling.** `isConflictError` string-matches
   `"changed on disk"` against Rust's error with no shared constant or
   cross-boundary test. Fix: shared constant on the TS side + Rust test pinning
   the exact message + TS test asserting the match.
6. **Blank-editor guard.** `FileViewer` (and the CM view) can mount inside
   `display:none` (Changes tab active). CM6 created at zero size depends on
   ResizeObserver recovery — classic blank-until-click. Fix: defer `EditorView`
   creation until the container is visible/measured (`requestMeasure` on
   visibility flip; test via the existing display-toggle machinery).

## Phase 2 — Table-stakes editor features

### 2a. Curated setup additions (config-only)

Per current CodeMirror guidance, no `basicSetup`; extend the hand-rolled list:

- `@codemirror/search` (new dep): `search()` panel + `searchKeymap` — ⌘F find,
  ⌘G next, ⌥⌘F replace, **⌘D `selectNextOccurrence`** (VSCode muscle memory).
  Panel restyled via the editor theme (`.cm-panels`, `.cm-searchMatch`, inputs,
  buttons) from `tokens.ts` — no custom React panel.
- `highlightSelectionMatches()` from the same package.
- `closeBrackets()` + `closeBracketsKeymap` from `@codemirror/autocomplete`'s
  close-brackets module (ships inside `@codemirror/autocomplete`; import only
  the closebrackets entry — no completion UI).
- Multi-cursor: `EditorState.allowMultipleSelections.of(true)` +
  `rectangularSelection()` (Alt-drag) — `drawSelection()` is already mounted.

### 2b. Git gutter (the one real build)

VSCode-style change markers vs HEAD in the editor gutter.

- **Baseline:** new Rust command `read_baseline` (file_cmd.rs): given
  `(cwd, path)`, return the HEAD blob text for that path (`git show HEAD:path`
  equivalent via the existing git plumbing), same sandbox chain
  (`validate_cwd → resolve_within → refuse_dot_git`), same 1 MiB cap + UTF-8
  handling as `read_file`. Untracked / not-in-HEAD → `null` baseline (all lines
  "added"). Fetched once per file-open and re-fetched on the existing
  `fetchedAt` revalidation signal (covers commits/checkouts changing HEAD).
- **Diff:** `presentableDiff(baseline, currentDoc)` from **`@codemirror/merge`**
  (first-party, new dep) computed in JS, debounced ~200 ms after `docChanged`
  (VSCode's dirty-diff cadence). No IPC on keystrokes.
- **Render:** custom `gutter()` + `GutterMarker` in a `StateField<RangeSet>`:
  added = `color.add` bar, modified bar via a **new `color.mod` token** (blue
  family, added to every theme — no such token exists today), deleted = small
  triangle between lines. Colors exclusively from `tokens.ts`.
- **Degrade:** baseline missing/oversized/binary → no gutter, editor unaffected.

### 2c. Dirty visibility

The unsaved dot exists only in the viewer header. Add:

- Dirty dot on the open file's row in `FileBrowserTree` (live, from the same
  store state).
- Dirty dot for **stashed drafts** (`fileDrafts`) on their tree rows — today an
  evicted draft is invisible until the exact file is reopened.

## Phase 3 — Discoverability + visual polish

- **Edit from the diff feed:** an "Edit" affordance on `DiffFileCard` header
  (and the FileTreePane Changes rows) that switches to the All-files tab and
  `selectFile`s the path — closing the "I'm reviewing this diff, fix this line"
  gap. Reuses the existing dirty-guard switch flow.
- **Tokenize stragglers:** active-line wash and indentation-marker colors are
  hardcoded in `CodeEditor.tsx`; move to `tokens.ts` per the design-tokens rule.
- **Search panel + gutter theming pass** so new chrome matches the app design.

## Architecture notes

- All new editor config stays in `CodeEditor.tsx` behind the existing lazy
  `loadCore()` pattern; new packages join the dynamic-import chunk so the ADR
  0016 entry-chunk invariant holds (verify `dist/assets/main-*.js` after build).
- Git-gutter state lives in a new `src/changes/gitGutter.ts` (pure: baseline +
  doc → RangeSet; unit-testable without a view), wired in `CodeEditor.tsx`.
- `read_baseline` follows ADR 0006 string-error seam; pure logic (blob lookup)
  in `kriyon-core` where the diff plumbing already lives.
- The Rust↔JS boundary rule applies: `read_baseline` validates `cwd`/`path`
  exactly like `read_file`; never trusts frontend paths.
- Frontend stays IPC-only through `src/ipc/bridge.ts`.

## Error handling

- Baseline fetch failure → gutter silently absent (log in dev), editor fully
  functional. Never a user-facing error for a decoration.
- Deleted-file and conflict paths per P1 items 4–5.
- Search/close-brackets/multi-cursor are pure CM extensions — no new error paths.

## Testing

- TDD throughout (project rule). P1 items each get a failing test first in
  `CodeEditor.test.tsx` / `useFileEditorSession.test.ts` (jsdom + fake IPC seam,
  established pattern).
- `gitGutter.ts` pure-function tests: added/modified/deleted mapping, empty
  baseline, identical docs, debounce behavior.
- Rust: `read_baseline` sandbox tests mirroring `read_file`'s (escape, `.git`,
  cap, lossy UTF-8, not-in-HEAD).
- Cross-boundary conflict-message test (P1 item 5) on both sides.
- Full `pnpm check` green before every commit.

## Risks

- WebKit IME/caret: keep `@codemirror/view` current; no inline widgets at the
  cursor (none planned). Audit against the known "WebKit caret anchors outside
  field" landmine before shipping.
- ⌘S/⌘F must stay CM-keymap-only — a Tauri menu accelerator would swallow the
  key before the webview sees it. Do not add native accelerators for these.
- `@codemirror/merge` is used for `presentableDiff` only — no merge-view UI.
