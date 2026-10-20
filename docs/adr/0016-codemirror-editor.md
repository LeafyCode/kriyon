# ADR 0016 — CodeMirror 6, lazy-loaded and out of the entry chunk, for the editable file view

**Date:** 2026-07-22
**Status:** Accepted

## Context

The Code Changes View's "All files" tab (round-two item 5) needs a real code
editor, not a plain `<textarea>`: a product decision calls for editing that
feels like editing code — a gutter, syntax color, sane indent/undo behavior —
for the files it shows, reusing the same file list the read-only diff/file
viewer already renders. That read-only path (`FileViewer.tsx`) already
tokenizes with shiki (`highlighter.ts`), lazy-loaded so the highlighter never
lands in the app's entry chunk; the entry chunk's leanness is an invariant
this repo holds by hand, verified by grepping the built `dist` assets. Any
editor library added for item 5 has to hold that same invariant, not quietly
regress it.

## Decision

**CodeMirror 6**, imported only as raw `@codemirror/*` (+ `@lezer/highlight`)
modules behind dynamic `import()`, wrapped by hand in `src/changes/
CodeEditor.tsx` — no `@uiw/react-codemirror` or other React wrapper.

- **Lazy-load discipline, mirroring `highlighter.ts`:** every CodeMirror
  module this file needs — core (`@codemirror/state`, `-view`, `-language`,
  `-commands`, `@lezer/highlight`) and each per-language grammar
  (`@codemirror/lang-javascript` etc.) — is reached only via dynamic
  `import()` inside `CodeEditor.tsx`'s effects, never a top-level static
  import. `import type` is used freely for typing refs (`EditorView`,
  `Compartment`, `Extension`) since type-only imports are erased at compile
  time and cost nothing in the bundle. Verified the same way the shiki
  invariant already is: `pnpm build` then `grep -a codemirror dist/assets/
  index-*.js` (the entry chunk) — **absent**; CodeMirror only shows up in an
  async chunk, loaded the first time a `CodeEditor` actually mounts. `grep
  -a` matters here, not plain `grep` — without it, grep silently treats a
  minified chunk as binary and skips it, reporting a false absence even if
  CodeMirror had leaked into the entry chunk.
- **Raw CodeMirror, not a React wrapper:** a `useEffect`/ref constructs one
  `EditorView` per mount and calls `.destroy()` on unmount/language change.
  `@uiw/react-codemirror` was considered and rejected — it pulls in
  `@babel/runtime` as a peer for a thin convenience layer this component
  provides directly in ~335 lines, and hand-rolling it keeps the
  React↔CodeMirror seam auditable for the lazy-load invariant above (a
  wrapper package's own import graph isn't something this repo controls).
- **Theming from one palette, two consumers:** `EditorView.theme()` binds the
  editor's chrome (background, gutters, cursor, selection, active line) to
  the live `var(--kr-*)` custom properties `src/theme/tokens.ts` already
  publishes — the same seam every other surface in the app styles through
  (ADR 0007). A `HighlightStyle` (from `@codemirror/language`) maps Lezer
  highlighting tags (`@lezer/highlight`'s `tags`) to that *same* `tokens.ts`
  palette `highlighter.ts`'s shiki theme already derives from — keyword →
  `color.accent`, string → `color.status.done`, function name →
  `color.accentBright`, and so on, mirroring `highlighter.ts`'s scope-to-
  color map entry for entry. One palette, two consumers: shiki tokenizes the
  read-only diff/file view, CodeMirror tokenizes the same file once it's
  opened for editing — they never highlight the same view at once, but both
  must read as the same app.

## Considered and rejected

- **Monaco Editor.** Multi-megabyte, and ships Web Workers for its language
  services that fail to start under Tauri's CSP (no `blob:`/`data:` worker
  origin allowed by default) — the same category of problem the CSP-driven
  in-app terminal work already ran into with other worker-based libraries.
  Would also blow well past any reasonable entry-chunk budget even lazy-
  loaded, given its baseline size.
- **A shiki↔CodeMirror bridge**, to reuse the shiki theme/tokenizer this repo
  already has for the read-only view, instead of adding a second
  highlighting engine. Rejected on inspection: `@shikijs/codemirror` **does
  not exist** as a package. The community 0.x bridges that do exist are
  unmaintained and explicitly discouraged by CodeMirror's own docs in favor
  of CodeMirror's native Lezer-based highlighting. Reusing the *palette*
  (this ADR's `tokens.ts`-driven `HighlightStyle`) gets the visual
  consistency that bridge would have bought, without taking on an
  unmaintained dependency or a second tokenizer's runtime cost per
  keystroke.
- **A plain `<textarea>`.** Simplest possible option, and was the fallback
  going in — rejected as a product decision: editing should feel like
  editing code (gutter, syntax color, real undo/indent), not editing plain
  text.

## Consequences

- **TOML has no first-party `@codemirror/lang-toml`.** Its grammar comes
  from `@codemirror/legacy-modes` — a CodeMirror 5-era `StreamParser`
  (`@codemirror/legacy-modes/mode/toml`'s `toml`) adapted to the CM6
  `Language` interface via `StreamLanguage.define(toml)`. Stream-mode
  highlighting is coarser than Lezer's incremental parser-based grammars
  (regex/state-machine tokenization vs. a real parse tree — no bracket-
  matching or fold support from the grammar itself), but it's the only
  first-party TOML support CodeMirror 6 ships, and it's enough for the
  editor's purpose here (making TOML editable with color, not building a
  TOML-aware refactoring tool).
- **Any other language `CodeEditor` doesn't recognise** (no entry in its
  language-loader table, and not TOML) mounts as a plain, ungrammared but
  still fully editable CodeMirror instance — same "never break the view"
  contract `highlighter.ts` already holds for shiki, extended to the editor:
  an unrecognised or failed-to-load grammar degrades the editing experience,
  never blocks it.
- One more dynamic-import surface for the entry-chunk audit to keep covering
  going forward: the existing shiki check gets a CodeMirror counterpart.
  **Both are manual rituals, not automated checks** — `pnpm build`, then grep
  the entry chunk for `codemirror` (and the same for shiki), run by hand.
  There is no such check in `package.json`'s scripts, in `pnpm check`, or in
  `.github/workflows/ci.yml`, so nothing fails a build or a PR if either
  library leaks into the entry chunk; the invariant holds only for as long as
  someone remembers to run the greps. Closing that gap means a build-config
  change, deliberately not taken here.

  **Find the entry chunk from `dist/index.html`, not by globbing.** This ADR
  originally named `dist/assets/index-*.js` as the entry. That is no longer
  true — the entry is emitted as `dist/assets/main-*.js`, and `index-*.js`
  now matches a dozen *async* chunks. Globbing it therefore greps the wrong
  files and reports a clean result whether or not the invariant actually
  holds, which is the worst possible outcome for a check whose whole job is
  to catch a leak:

  ```sh
  pnpm build
  ENTRY="dist/$(grep -oE 'assets/main-[A-Za-z0-9_-]+\.js' dist/index.html)"
  grep -ac codemirror "$ENTRY"   # expect 0
  grep -ac shiki "$ENTRY"        # expect 0
  ```

  `grep -a` still matters, for the reason given above. And confirm the
  libraries do appear in *some* async chunk — an absence that is really a
  build failure otherwise reads as a pass.
- `CodeEditor` on its own is read-only-vs-editable UI *chrome* only — it has
  no opinion on saving, dirty-state, or conflict handling. Task 17 supplied
  that separately and has since shipped on this branch: `FileViewer.tsx`
  mounts `CodeEditor` for a text (non-binary, non-truncated) load and saves
  through the `write_file` Tauri command, holding the read-time
  `(mtime, len)` signature its conflict guard compares against.

## Addendum, 2026-08-29 — editor hardening

The editor-hardening branch added find/replace, close-brackets, multi-cursor,
and a per-line git-status gutter to `CodeEditor.tsx`. All four land under the
exact lazy-chunk discipline above — no new exception, no new top-level
`@codemirror/*` import:

- **`@codemirror/search`** (`search()`, `searchKeymap`,
  `highlightSelectionMatches()`) and **`@codemirror/autocomplete`** — used
  here for **close-brackets only** (`closeBrackets()`,
  `closeBracketsKeymap`), not completion UI — join the same dynamic-`import()`
  batch as `@codemirror/commands`/`-language`/`-state`/`-view` inside
  `CodeEditor.tsx`'s effect. `state.EditorState.allowMultipleSelections.of(true)`
  turns on multi-cursor editing; it's a one-line config flag on the already-
  lazy `@codemirror/state`, not a new module.
- **`@codemirror/merge`** is a dependency for exactly one export,
  `presentableDiff`, consumed by `src/changes/gitGutter.ts` to turn a
  baseline/current doc pair into per-line added/removed ranges for the
  gutter's markers. **No `MergeView` or `unifiedMergeView`** — this repo has
  no side-by-side or inline merge-view UI; `@codemirror/merge` is a diffing
  library here, not a merge editor.
- **`gitGutter.ts`** is, per the constraint above, itself allowed to `import`
  `@codemirror/{state,view,merge}` statically — it is only ever reached via
  `CodeEditor.tsx`'s dynamic `import("./gitGutter.ts")`, so those imports
  still land in an async chunk, not the entry chunk.
- **Re-verified the invariant post-hardening**, same method as this ADR's
  own recipe (`pnpm build`, find the entry chunk from `dist/index.html`,
  `grep -a`): `codemirror`, `@codemirror`, and `presentableDiff` all count
  **0** in the entry chunk. The entry chunk *does* contain short property-
  name references — `.closeBrackets()`, `.search(...)`,
  `.highlightSelectionMatches()`, `.gitGutter(...)` — because that's
  `CodeEditor.tsx`'s own wiring code building its extension array from the
  awaited dynamic-import results; that's expected glue, not a leak. The
  literal package strings (`@codemirror/state`'s own runtime warning text)
  and the `presentableDiff` identifier are confirmed present only in the
  async chunks these packages were split into (e.g. `index-B5fiB6ig.js` for
  core `@codemirror/state`, `gitGutter-*.js` for the gutter module), never
  in `main-*.js`.
