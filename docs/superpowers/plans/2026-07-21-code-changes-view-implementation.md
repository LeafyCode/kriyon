# Code Changes View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-session "Changes" view that shows the code Claude edited as trustworthy git-derived diffs (with syntax highlighting), plus a read-only browser for any file in the project.

**Architecture:** Git is the only source of truth for diff content — the view recomputes `git diff` from disk on open and on debounced PostToolUse hook events; hook events supply only liveness (which files, when, which turn). The view is a third `transcriptView` mode next to Studio/Raw. No accept/reject state machine and no snapshot store outside git; the only mutating action (Phase 4) is a git-backed per-file restore.

**Tech Stack:** shiki 4.x fine-grained (`@shikijs/core` + `@shikijs/engine-javascript`, lazy per-language grammars, singleton highlighter), `@tanstack/react-virtual` 3.x, Rust `similar` 3.x, hand-rolled file tree, custom `read_file` Tauri command.

**Companion docs:** research summary in `2026-07-21-code-changes-view.md` (same directory) — read it first for the "why" behind every decision here.

## Global Constraints

- Branch: work on typed branches off `dev` (e.g. `feat/changes-view-core`); never commit to `main`. Conventional commits, small and frequent.
- `pnpm check` green before every commit. Committing Rust files needs `PATH="$HOME/.cargo/bin:$PATH"` so lefthook finds cargo.
- Multiple live sessions can share this checkout: `git add` named files only, never `git add -u` / `git add .`.
- All design values from `src/theme/tokens.ts` — no hardcoded colors/spacing. Follow the suggested design in the design mockups (not in this repo; variant 1a body layout), adapted to tokens.
- Rust↔JS IPC is a trust boundary: every new command validates paths (canonicalize + component-wise prefix check against an allowed root) and returns `Result`.
- Pure logic in `crates/kriyon-core` (unit-testable without Tauri); `src-tauri` stays a thin shell. Frontend calls Rust only via `src/ipc/bridge.ts`.
- The transcript parser must never hard-error on unknown input.
- New JS deps allowed (exact): `@shikijs/core`, `@shikijs/engine-javascript`, `@shikijs/langs`, `@shikijs/themes`, `@tanstack/react-virtual`. New Rust dep allowed: `similar = "3"` (kriyon-core). Nothing else without an ADR.
- shiki: one singleton highlighter, JS engine only (never the oniguruma WASM engine), grammars dynamically imported on first use per language. Keep shiki out of the main chunk (dynamic `import()` from the changes view only).
- Highlight only what's visible: diff hunks highlight per-card; full files highlight per virtualized line range. Files >1 MB or binary: no read, show a notice. File cards >400 changed lines and lockfile/generated paths (`pnpm-lock.yaml`, `Cargo.lock`, `*.min.*`, `dist/`) render collapsed by default.
- Verbs in UI copy: "Undo", never "Reject"/"Discard". The view always shows a visible baseline label ("vs HEAD · uncommitted" / "vs main @ abc1234").
- Verify library APIs against current docs (context7) before coding against shiki/tanstack-virtual/similar.

---

## File structure (locked decomposition)

**Rust:**
- `crates/kriyon-core/src/git.rs` — extend: `untracked_as_diff(path, content) -> FileDiff`, `DiffTotals` + `SessionDiff::totals()`.
- `src-tauri/src/git_cmd.rs` — add `diff_working_tree`, later `restore_file`.
- `src-tauri/src/file_cmd.rs` — NEW: `read_file`, `list_dir` (+ path validation helpers shared with completion_cmd's `validate_cwd` pattern).
- `crates/kriyon-core/src/transcript.rs` — Phase 4: real Edit hunks via `similar`, MultiEdit support.

**Frontend (new `src/changes/` module):**
- `src/changes/ChangesView.tsx` — top-level layout (tree column | feed | jump rail | summary bar).
- `src/changes/FileTreePane.tsx` — Changes/All-files tabs; changed-first tree.
- `src/changes/DiffFeed.tsx` — virtualized feed of file cards.
- `src/changes/DiffFileCard.tsx` — header (path, +/−, NEW badge) + hunks; collapse state.
- `src/changes/DiffHunk.tsx` — line rows: old/new line numbers, sign, highlighted content.
- `src/changes/SummaryBar.tsx` — totals, baseline label, refresh/staleness.
- `src/changes/FileViewer.tsx` — Phase 3 read-only file view with changed-line gutter.
- `src/changes/highlighter.ts` — shiki singleton, lang→dynamic-import map, theme from tokens.
- `src/state/changes.ts` — zustand store: per-session `SessionDiff`, status, collapsed/viewed sets, baseline meta.
- Modify: `src/state/layout.ts` (`transcriptView` union + "changes"), `src/layout/SessionHeader.tsx` (toggle), `src/App.tsx` `SessionPane` (mount), `src/ipc/bridge.ts`, `src/types.ts`, `src/studio/StudioView.tsx` (Phase 2 chip).

Tests mirror sources: Rust `#[cfg(test)]` in the same files (existing pattern); frontend `*.test.ts(x)` beside components (existing pattern).

---

## Phase 1 — Core changes view

### Task 1: `DiffTotals` + untracked-file diff synthesis (kriyon-core)

**Files:** Modify `crates/kriyon-core/src/git.rs` (+ tests in-file).

**Interfaces — Produces:**
```rust
pub struct DiffTotals { pub files: usize, pub additions: usize, pub deletions: usize } // serde camelCase
impl SessionDiff { pub fn totals(&self) -> DiffTotals }
/// Whole-content-as-added FileDiff for an untracked file (status: Added, one hunk, all lines DiffKind::Added).
pub fn untracked_as_diff(path: &str, content: &str) -> FileDiff
```

- [ ] Write failing tests: `totals_sums_across_files_and_hunks`, `untracked_becomes_all_added_hunk` (assert path, `FileChange::Added`, line count, every line `DiffKind::Added`), `untracked_empty_file_has_no_hunks`.
- [ ] `cargo test -p kriyon-core` → FAIL (missing items).
- [ ] Implement both; keep clippy pedantic clean.
- [ ] `cargo test -p kriyon-core` → PASS.
- [ ] Commit: `feat(core): diff totals and untracked-file diff synthesis`

### Task 2: `diff_working_tree` command

**Files:** Modify `src-tauri/src/git_cmd.rs`, register in `src-tauri/src/lib.rs` (next to `diff_worktree`).

**Interfaces — Produces:**
```rust
#[tauri::command(async)]
/// base = None → "HEAD" (uncommitted view). Runs `git diff <base> --` in cwd,
/// parses with parse_diff, then appends untracked files from
/// `git status --porcelain=v1 -uall` ("??" entries; read content ≤1 MB, skip binary)
/// via untracked_as_diff. Returns SessionDiff { base, files }.
pub async fn diff_working_tree(cwd: String, base: Option<String>) -> Result<SessionDiff, String>
```
Reuses the same cwd validation and `git` spawning pattern as `diff_worktree` (git_cmd.rs:166). For worktree sessions the frontend passes the merge-base branch (existing `default_branch` command); for plain sessions it passes nothing.

- [ ] Write failing tests (tempfile git repo fixture, same pattern as existing git_cmd tests): modified tracked file appears with hunks; untracked file appears as Added; `base: None` diffs against HEAD; invalid cwd → Err.
- [ ] `cargo test` → FAIL. Implement. `cargo test` → PASS.
- [ ] Commit: `feat(tauri): diff_working_tree command with untracked-file support`

### Task 3: `read_file` + `list_dir` commands (new `file_cmd.rs`)

**Files:** Create `src-tauri/src/file_cmd.rs`; register both commands in `lib.rs`.

**Interfaces — Produces:**
```rust
pub struct FileContent { pub content: String, pub truncated: bool, pub binary: bool, pub size: u64 } // camelCase
#[tauri::command(async)]
pub async fn read_file(cwd: String, path: String) -> Result<FileContent, String>
pub struct DirEntry { pub name: String, pub is_dir: bool, pub ignored: bool }
#[tauri::command(async)]
pub async fn list_dir(cwd: String, path: String) -> Result<Vec<DirEntry>, String>
```
Security (the point of this task): join `path` to `cwd`, `fs::canonicalize`, verify the canonical result starts with canonicalized `cwd` **by path components**; reject symlink escapes, `..`, absolute inputs outside root. Cap `read_file` at 1 MB (truncate + flag). Binary sniff: NUL byte in first 8 KB → `binary: true`, empty content. `list_dir` sorts dirs-first then name, marks gitignored entries via the `ignore` crate, skips `.git`.

- [ ] Write failing tests: reads UTF-8 file; truncates >1 MB; flags binary; **rejects `../escape`, absolute path outside root, and symlink pointing outside root**; `list_dir` sorts and flags ignored.
- [ ] `cargo test` → FAIL. Implement. → PASS.
- [ ] Commit: `feat(tauri): sandboxed read_file and list_dir commands`

### Task 4: bridge + types + changes store

**Files:** Modify `src/ipc/bridge.ts`, `src/types.ts`; create `src/state/changes.ts` + `src/state/changes.test.ts`.

**Interfaces — Produces:**
```ts
// types.ts (mirror Rust, camelCase): DiffTotals, FileContent, DirEntry
// bridge.ts (follow diffWorktree wrapper pattern at bridge.ts:540):
diffWorkingTree(cwd: string, base?: string): Promise<SessionDiff>
readFile(cwd: string, path: string): Promise<FileContent>
listDir(cwd: string, path: string): Promise<DirEntry[]>
// state/changes.ts (zustand, follow sessions.ts conventions):
interface ChangesState {
  bySession: Record<string, {
    diff: SessionDiff | null; totals: DiffTotals | null;
    status: "idle" | "loading" | "ready" | "error"; error?: string;
    baselineLabel: string;            // "HEAD · uncommitted" | "main @ abc1234"
    fetchedAt: number;                // for the "updated Xs ago" stale indicator
    collapsed: Record<string, boolean>; // file path → user-toggled collapse
  }>;
  refresh(sessionId: string, cwd: string, base?: string): Promise<void>; // coalesces concurrent calls per session
  toggleCollapsed(sessionId: string, path: string): void;
}
```
`refresh` computes totals from the diff client-side and preserves `collapsed` across refreshes (design decision: expand state survives updates).

- [ ] Write failing store tests (mock bridge like existing store tests): refresh populates diff/totals/baselineLabel; concurrent refresh coalesces (bridge called once); error sets status+message; collapsed survives refresh.
- [ ] `pnpm test` → FAIL. Implement. → PASS. `pnpm fix && pnpm typecheck`.
- [ ] Commit: `feat(changes): bridge wrappers and per-session changes store`

### Task 5: highlighter singleton (shiki fine-grained)

**Files:** Create `src/changes/highlighter.ts` + `highlighter.test.ts`; `pnpm add @shikijs/core @shikijs/engine-javascript @shikijs/langs @shikijs/themes @tanstack/react-virtual`.

**Interfaces — Produces:**
```ts
// Everything lazy: nothing from shiki lands in the main chunk.
export type HighlightedLine = Array<{ text: string; color?: string }>;
export async function highlightLines(code: string, lang: string): Promise<HighlightedLine[]>;
export function langForPath(path: string): string; // ext → shiki lang id, "text" fallback (mirror lang_from_path coverage: ts tsx js rs py md json toml css html)
```
Implementation notes: `createHighlighterCore` + `createJavaScriptRegexEngine` created once in a module-level promise; grammar map of dynamic imports (`() => import("@shikijs/langs/typescript")` …); unknown/unloaded lang → plain single-span lines (never throw, never block on load failures — degrade to plain text). Theme: one custom shiki theme object built from `src/theme/tokens.ts` colors. Use `codeToTokensBase`, map to `HighlightedLine[]`.

- [ ] Write failing tests: highlights a ts snippet (spans have colors); unknown lang falls back to single plain span per line; `langForPath("x/y.tsx") === "tsx"`; repeated calls reuse the singleton (spy on core factory).
- [ ] `pnpm test` → FAIL. Implement. → PASS.
- [ ] Verify chunking: `pnpm build` and confirm shiki appears only in async chunks (check `dist/assets` filenames), not the entry chunk.
- [ ] Commit: `feat(changes): lazy shiki highlighter singleton themed from tokens`

### Task 6: diff feed components (card, hunk, feed)

**Files:** Create `src/changes/DiffFileCard.tsx`, `DiffHunk.tsx`, `DiffFeed.tsx` + tests for each.

**Interfaces — Produces:**
```ts
// DiffHunk: props { hunk: DiffHunk; lang: string }
//   rows: old-lineno | new-lineno | content; Added/Removed/Context backgrounds
//   from tokens (reuse the color mapping in studio/blocks/Diff.tsx); async
//   per-hunk highlight via highlightLines, plain text until resolved.
// DiffFileCard: props { file: FileDiff; collapsed: boolean; onToggle(): void }
//   header: mono path, +N −M (green/red), NEW badge when status Added,
//   collapsed row when collapsed (path + counts + "collapsed ▸").
//   Auto-collapse default comes from the store per Global Constraints
//   (>400 changed lines or lockfile/generated path).
// DiffFeed: props { sessionId: string; files: FileDiff[] }
//   @tanstack/react-virtual vertical list, measureElement for dynamic card
//   heights, overscan 4. Registers per-file element ids for Task 8 tree→card jumps.
```
Line numbers: derive old/new numbers by walking hunk lines from the `@@` header start positions (parse from `DiffHunk.header`; tolerate missing header → number from 1).

- [ ] Write failing component tests (@testing-library/react): hunk renders correct old/new numbering across added/removed/context; card shows counts + NEW badge; collapsed card hides hunks; feed renders cards for each file (mock virtualizer measurement as in jsdom — set `getBoundingClientRect`).
- [ ] `pnpm test` → FAIL. Implement (tokens only, no hardcoded colors). → PASS.
- [ ] Commit: `feat(changes): virtualized diff feed with highlighted hunks`

### Task 7: tree pane + summary bar + ChangesView assembly

**Files:** Create `src/changes/FileTreePane.tsx`, `SummaryBar.tsx`, `ChangesView.tsx` + tests.

**Interfaces — Produces:**
```ts
// FileTreePane (Phase 1 = Changes tab only; All-files tab button present but disabled with tooltip "coming soon"):
//   groups changed files by directory (design 1a: dir label rows + file rows
//   with +/− counts), "N unchanged files hidden" footer (from list_files count
//   minus changed), click → scroll feed to card (calls DiffFeed jump handle).
//   Files are grouped "This session" / "Other changes" when attribution is
//   available (Task 8), single flat group otherwise.
// SummaryBar: totals ("4 files changed  +59 −11"), baseline label from store,
//   manual refresh button, "updated Xs ago" text past 10s.
// ChangesView: props { sessionId: string } — reads session cwd/worktree from
//   sessions store; on mount + visibility calls changes.refresh with base =
//   defaultBranch for worktree sessions (reuse ReviewPanel's base resolution),
//   undefined otherwise. Layout: tree 236px | feed flex | (jump rail Phase 2).
```

- [ ] Write failing tests: tree groups by directory and orders changed-first; clicking a file row calls the jump handle with its path; summary bar shows totals + baseline; ChangesView triggers refresh on mount with the right base for worktree vs plain sessions (mock stores).
- [ ] `pnpm test` → FAIL. Implement. → PASS.
- [ ] Commit: `feat(changes): changes view layout with tree, feed, and summary bar`

### Task 8: mount as third view + live refresh + attribution

**Files:** Modify `src/state/layout.ts` (union + setter), `src/layout/SessionHeader.tsx` (three-way toggle Studio/Changes/Raw at :88/:130), `src/App.tsx` `SessionPane` (display-toggle `ChangesView` alongside Studio/Terminal — keep all mounted, same keep-alive pattern), plus the hook-event subscription: in the existing consolidated `onEvent` subscriber (sessions store), on PostToolUse for tools Edit/Write/MultiEdit/NotebookEdit record `touchedFiles[sessionId] add target` and, when that session's changes view is visible, debounce 500 ms → `changes.refresh`.

**Interfaces — Consumes:** everything above. **Produces:** `sessions` store gains `touchedFiles: Record<string, string[]>` (ordered, deduped) — used by FileTreePane attribution groups and Phase 2 chip.

- [ ] Write failing tests: layout store accepts `"changes"`; SessionPane shows ChangesView only when selected (others stay mounted — assert display toggling, not unmount, per terminal keep-alive rule); PostToolUse Edit event adds to `touchedFiles` and triggers debounced refresh only when view visible.
- [ ] `pnpm test` → FAIL. Implement. → PASS.
- [ ] Manual smoke: `pnpm tauri dev`, run a real session, make Claude edit files, confirm: toggle shows diffs, live refresh on edits, terminal untouched.
- [ ] Commit: `feat(changes): changes view mode with live hook-driven refresh`

**Phase 1 exit criteria:** open Changes on a session with uncommitted edits → correct highlighted diffs incl. untracked files; edits by Claude appear within ~1 s without scroll jump; `pnpm check` green; shiki absent from entry chunk; 100-file changeset scrolls at 60 fps (collapse rules working).

---

## Phase 2 — Entry points & orientation

### Task 9: "N files changed" chip in Studio view
After a turn completes (Stop hook event), if `touchedFiles` grew during that turn, StudioView appends a chip block: `"{n} files changed  +a −d  ▸"` (counts from `changes` store totals if fresh, else just file count). Click → `layout.setTranscriptView("changes")`. Files: modify `src/studio/StudioView.tsx` (+ a small `ChangedFilesChip.tsx` in `src/studio/blocks/`), tests for chip rendering + click. TDD steps as in Tasks 6–8. Commit: `feat(studio): changed-files chip linking to changes view`.

### Task 10: jump rail + viewed dots + session-row badge
- Jump rail (26px right column in ChangesView): one dot per changed file, clickable, active while its card intersects viewport (IntersectionObserver), dimmed once scrolled past (`viewed` set in changes store, reset on refresh only if the file's diff changed — compare hunk text hash).
- Sidebar session row: small `N` files-changed badge from `touchedFiles` count (respect existing row layout in `src/layout/` sidebar components; reuse badge styling patterns).
Files: create `src/changes/JumpRail.tsx`; modify sidebar row component + tests. Commit: `feat(changes): jump rail with viewed state and sidebar badge`.

### Task 11: staleness polish
"updated Xs ago" ticks in SummaryBar; when a refresh lands while the user has scrolled (not at top), preserve scroll position (virtualizer `scrollOffset` restore) and pulse the summary bar instead of jumping. Test: refresh with scrolled feed keeps offset. Commit: `feat(changes): non-disruptive refresh with staleness indicator`.

**Phase 2 exit criteria:** chip appears after edit turns and opens the view; rail navigates; refresh never steals scroll.

---

## Phase 3 — "Why" grouping & file browser

> Before starting Phase 3, re-run superpowers:writing-plans against this section to expand it to bite-sized steps (Phases 1–2 learnings will inform component APIs). The scope below is fixed; only step detail is deferred.

### Task 12: All-files tab + read-only FileViewer
Tree tab 2 lists the project via `list_dir` (lazy per-directory expansion — not a full upfront walk); clicking a file opens `FileViewer.tsx` in place of the feed: virtualized lines, per-visible-range highlighting, changed-line gutter markers (from current `SessionDiff`), "Open in editor" button (existing `openPath`). Binary/oversize → notice row. Ignored entries rendered dimmed, collapsed by default.

### Task 13: why-grouping in the feed
Group file cards under the nearest preceding Assistant text from transcript events (`StudioEvent` stream already in sessions store): map each `Diff`/`Code` event's file to its turn; feed renders reasoning blocks (design 1a "why" style) above their file-card group; ungrouped files fall into a trailing "Other changes" group. Each card header gets a "view in conversation" affordance → switches to Studio and scrolls to the event id (StudioView already keys blocks by stable event ids).

### Task 14: test-run summary in SummaryBar
From Bash hook events: detect test commands (`pnpm test`, `cargo test`, `vitest`, `pytest` prefix match) in the session's recent events; show last result chip (command + pass/fail from exit status if present in the event; omit chip when unknown). Pure detection function in `src/changes/testRuns.ts`, unit-tested.

**Phase 3 exit criteria:** browse any file with highlighting; diffs grouped under Claude's reasoning with links back to the conversation.

---

## Phase 4 — Trust actions

> Same rule: expand with writing-plans before executing.

### Task 15: per-file Undo (git restore)
Rust: `restore_file(cwd, path, base) -> Result<(), String>` — `git restore --source <base> -- <path>` (or `git clean`-style delete for untracked files **only after** an explicit typed confirmation in UI); path-validated like read_file. UI: "Undo" button on card header with confirm popover ("Restores src/foo.ts to HEAD. This discards Claude's edits to this file."); disabled with tooltip when the file was also touched by another live session (`touchedFiles` across sessions). Refresh after.

### Task 16: per-turn diff toggle
At each Stop hook event, for each file touched that turn, store its blob via `git hash-object -w` and record `(sessionId, turn, path, oid)` in the existing rusqlite store. "This turn / whole session" toggle in SummaryBar; per-turn mode diffs recorded oid vs current file (`git diff <oid> -- <path>` parsed by `parse_diff`). Git's object store is the cache — no parallel snapshot files (objects are pruned by git gc eventually; degrade gracefully to whole-session view when an oid is gone).

### Task 17: honest Edit blocks in the transcript parser
In `crates/kriyon-core/src/transcript.rs` `map_tool_use` (:358): replace the naive old/new concat for Edit with a real line diff via `similar` (`TextDiff::from_lines` → interleaved DiffLine list, correct add/del counts); handle MultiEdit (aggregate per-edit diffs into one `Diff` event); keep the never-error guarantee. This improves Studio blocks and Phase 3 grouping fidelity.

**Phase 4 exit criteria:** Undo restores exactly one file with confirm; per-turn toggle answers "what did the last message change"; MultiEdit visible in Studio.

---

## Self-review notes (already applied)

- Untracked files handled (pitfall #5, completeness) — Task 1/2.
- No unmount of terminal panes (keep-alive rule) — Task 8 asserts display-toggle.
- shiki stays out of entry chunk — Task 5 build check.
- Path traversal + symlink escape tests are mandatory, not optional — Task 3.
- Phases 3–4 are scoped-but-not-stepped by design; the executing session expands them with writing-plans when reached.
