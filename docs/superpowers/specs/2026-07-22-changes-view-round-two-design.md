# Design — Code Changes View, round two (feat/changes-view-core, PR #10)

**Date:** 2026-07-22
**Branch/worktree:** `feat/changes-view-core` @ `/Users/dev/Projects/kriyon-changes-view`
**Amends:** PR #10 → `main` (does not open a new PR).
**Prior work:** `docs/superpowers/plans/2026-07-21-code-changes-view-implementation.md`, `docs/superpowers/plans/2026-07-21-changes-view-file-browser.md`.

Six improvements to the shipped-but-unmerged Changes view. Two (items 2 and 5) were researched and brainstormed with the user; the other four are mechanical. The hard constraint throughout: **fast and light on resources** — memoize derived data, bound caches, no per-open-session git-spawn storms, lazy over eager.

---

## Item 1 — Collapsible Inspector "Changes" section, stats on top

**Decision.** The Inspector `Changes` section (`src/inspector/Inspector.tsx:184-205`) keeps its aggregate stats permanently visible in a header row and makes only the **file list** collapse/expand. `CollapsePanel` (`src/ui/CollapsePanel.tsx`) does **not** fit — it is a horizontal window-edge slide with no title/chevron. We add a small, reusable **vertical** collapsible: `src/ui/CollapsibleSection.tsx` (title row + chevron + `open` boolean + children). It is generic (title, `open`, `onToggle`, `children`, `testId`) so later sections can reuse it (reuse-before-adding is satisfied by making it general, not by forcing the wrong existing component).

**Stats on top.** The header row shows, always visible: the section label, the file count, and the aggregate `+additions −deletions` from the changes-store `totals` (`computeTotals`, `src/state/changes.ts`) — today the Inspector only shows `dirtyCount`, so this genuinely surfaces the totals "at the top." The `Uncommitted N changes` / `↑ahead ↓behind` `Kv` rows and the `ChangedFilesList` live in the collapsible body.

**Persistence.** Collapsed state is a UI preference that should survive reload → persist it in the **layout store** (`src/state/layout.ts` + `persistence.ts`), a single global boolean `inspectorChangesOpen` (default open). Global, not per-session: a section-open preference is not session data. (Explicit choice; noted so review doesn't re-litigate it.)

---

## Item 2 — Session-scoped changes via a start-of-session git baseline

**Problem.** Today the Inspector/sidebar list is the whole working-tree diff (`diff_working_tree` anchored at `merge-base(base, HEAD)`), so two non-worktree sessions on the same branch see identical lists. The only per-session signal, `touchedFiles`, holds **absolute** tool-edit paths, is cumulative, and misses Bash/`sed`/formatter edits.

**Research verdict (Cline/Roo, Aider, Warp, Cursor, Claude Code, Zed).** Every mature tool anchors the authoritative "what changed" view on a **git baseline diff** and uses tool-edit records only as an attribution *label*. Cline's exact "show only this task's changes despite unrelated working-tree dirt" is a **task-start baseline commit** diffed against the tree — not a touched-file filter. No mature tool uses "tools-touched ∩ diff" as the file-set gate, precisely because it misses shell edits and can't self-correct reverts. Claude Code's own `/diff` is authoritative `git diff` + a non-authoritative per-turn (tool-record) lens.

**Decision — adopt the baseline model, `touchedFiles` becomes a badge.**

### Baseline capture (hook-free, pollution-free)
At session start we snapshot the working tree into a **dangling git tree object** and store its oid on the session. Mechanism: a temp-index `write-tree`, which moves no refs/HEAD/index, writes to no branch, and **fires no lefthook/commitlint hooks** (critical given the GIT_DIR incident + guard-git setup):

```
GIT_INDEX_FILE=<tempfile> git -C <repo> add -A     # respects .gitignore; captures tracked + untracked
GIT_INDEX_FILE=<tempfile> git -C <repo> write-tree # -> tree oid
```

- New Rust helper `snapshot_tree(repo_path) -> Result<String, String>` in `git_cmd.rs`, routed through `output_with_retry` (clears `GIT_DIR`/`GIT_WORK_TREE`, EAGAIN/ENOMEM retry) **plus** a fresh `GIT_INDEX_FILE` tempfile it removes afterward. Reused for both baseline and current-tree capture.
- New command `capture_baseline(cwd) -> Result<String,String>`: `validate_cwd` (trust boundary) → `snapshot_tree`. `reject_flag_like` guard like the sibling git commands.

### Session-scoped diff
- New command `diff_session_changes(cwd, baselineOid) -> SessionDiff`: `validate_cwd`, capture the **current** tree via `snapshot_tree`, then `git diff -M <baselineOid> <currentTreeOid>` → `parse_diff`. Tree-vs-tree handles tracked **and** untracked uniformly on both sides, so it correctly (a) catches Bash/`sed` edits, (b) self-corrects reverts (net-zero → absent), (c) excludes pre-session dirt (baked into the baseline), (d) needs **no** separate untracked-porcelain append. `base_sha` = short baseline oid.
- The existing `diff_working_tree` (merge-base + untracked append) is **left untouched** as the fallback path — isolating new logic, keeping the reviewed pipeline intact.

### Persistence & lifecycle
- Add nullable `baseline_oid TEXT` column via `migrate_column("sessions","baseline_oid","TEXT")` (`store.rs` pattern). Thread through Rust `SessionRow`, `upsert_session`, TS `SessionRow` (`types.ts`), `bridge.upsertSession`, and the `createSession` row builder (`actions.ts`).
- Captured **once**, shortly after `createSession`: fire `captureBaseline(cwd)` async, then `upsertSession` with the oid (or a dedicated `setBaseline` action). The sub-second window before it resolves falls back to merge-base. Persisted → survives app restart / resume.
- **Pre-feature / resumed-old sessions** have `baseline_oid = null` → frontend uses `diff_working_tree` (today's behavior). Honest degradation; new sessions get the precise view.

### Frontend selection (changes store)
`refresh(sessionId, cwd, base?)` chooses: `baselineOid ? diff_session_changes(cwd, baselineOid) : diffWorkingTree(cwd, base)`. Everything downstream (list, totals, jump rail, SummaryBar) is unchanged — it consumes `SessionDiff` either way.

### Attribution overlay (the multi-session answer)
When multiple sessions share one checkout, the baseline scopes each to "changes since I joined" but still over-attributes another session's concurrent edits. `touchedFiles` is the only per-actor signal, so we layer it as a **badge**, mirroring Claude Code's authoritative-git + per-turn split:

- Relativize `touchedFiles` (absolute) against the repo top-level (`git rev-parse --show-toplevel`, computed **once per session** and cached — not per render) to match repo-relative diff paths. Mind worktree sessions (cwd = worktree).
- Each changed file gets a `✎ this session` badge when its path ∈ relativized `touchedFiles`; otherwise it reads as changed-by-another-session/command/you.
- A cheap **"My edits only"** toggle filters the list to the badged set — a pure frontend intersection, **no extra git spawn**. Default is **off** (show all changes since start, badged), per the user's choice.

**Resource note.** Per new session: one `capture_baseline` + one `show-toplevel` spawn. Per view open/refresh (debounced, gated to the on-screen session): one current-tree snapshot + one diff. No continuous polling, no per-open-session storm.

---

## Item 3 — Session click returns to the prior (Structured/Raw) view

**Decision.** `transcriptView` (`layout.ts`, global `"studio"|"changes"|"raw"`) gains a remembered `preChangesView` (`"studio"|"raw"`, default `"studio"`). `setTranscriptView` records `preChangesView = <old view>` whenever it transitions *into* `"changes"` from a non-changes view (covers both entry points: `Inspector.tsx:202` and `ChangedFilesChip.tsx:136`). A new `leaveChangesView()` action sets `transcriptView = preChangesView` **only if** currently `"changes"`.

**Wiring.** The sidebar select path (`SessionRow.onSelect` → `setActiveSession`) also calls `leaveChangesView()`. Since `SessionRow` shouldn't reach into the layout store, wire it at the `Sidebar`/`ProjectGroup` seam where `onSelect={setActiveSession}` is composed: `onSelect={(id) => { setActiveSession(id); leaveChangesView(); }}`. Global (not per-session) — simplest, and a returning-view preference isn't session data. `preChangesView` is session-ephemeral (not persisted; on cold start `transcriptView` already restores from persistence).

---

## Item 4 — Bug: Changes panel shows files with 0 changes

**Root cause.** `parse_diff` yields `FileDiff { hunks: [] }` for binary files, header-only/mode changes, and pure renames; `untracked_as_diff` yields no hunks for empty files. `fileDiffCounts` then reports `+0 −0`, rendered as a noise card/row. `FileDiff` has **no binary flag** today (`git.rs:47-52`; the `Binary files … differ` line is silently skipped).

**Decision — make counts honest by kind, at the parser boundary.**
- Add `binary: bool` to `FileDiff` (Rust + TS `types.ts`); `parse_diff` sets it on the `Binary files a/… and b/… differ` line. One regression test asserts the flag.
- Classify each zero-hunk entry:
  - **Binary** (add/modify/delete) → render distinctly with a `binary` chip, **no** `±` counts. Real change, kept.
  - **Pure rename** (no content change) → render as `old → new`, no counts. Real change, kept. (This also delivers the item-6 rename affordance; `old_path` already carried.)
  - **Empty new / deleted file** → render as `new (empty)` / `deleted (empty)`. Real change, kept.
  - **True noise** (zero-hunk, non-binary, Modified, not a rename/add/delete) → **filtered out** of the list, feed, jump rail, and totals.
- Fix once at the shared derivation in `src/state/changes.ts` so every consumer (Inspector list, sidebar, `SummaryBar` totals, jump rail) counts identically. `computeTotals` counts binary/rename/empty as **1 changed file, 0 lines** (not `+0` line noise).

---

## Item 5 — Editable files in "All files" tab (new write-file command + CodeMirror 6)

Highest-risk item: writing to disk from a frontend-supplied path across the Rust↔JS trust boundary.

### Write command (Rust)
`write_file(cwd, path, content, expectedMtime, expectedLen) -> FileWriteResult { mtime, len }` in `file_cmd.rs`:
1. `validate_cwd(store, cwd)` — same known-root allowlist as `read_file`/`list_dir`.
2. `resolve_within(cwd_canonical, path)` — canonicalizes, requires the path to **already exist** (we only edit files shown in the browser, so no new-file/parent-dir path — simplest safe reuse), rejects escape via component-wise `path_within_roots`.
3. **Refuse**: anything under `.git/`; a currently-binary file (NUL sniff of on-disk bytes); `content` > `MAX_READ_BYTES` (1 MiB, mirroring the read cap); a file whose read returned `truncated` (we never hold the whole file, so we must not save it).
4. **Conflict guard**: compute `file_signature(path) -> (mtime, len)` (reuse `watcher::file_signature`); if it ≠ `(expectedMtime, expectedLen)` → `Err("file changed on disk")`. Per the user: **refuse + warn**, never clobber.
5. **Atomic write**: temp file in the same directory, then rename over the target (no partial writes). Return the new `(mtime, len)`.
6. Register in the Tauri handler list; add `bridge.writeFile(...)` wrapper (no `hasTauri()` guard — mutation runs only in-app).
- `read_file`/`FileContent` gains `mtime: u64` so the frontend obtains `(mtime, len=size)` at read to pass back on save.

### Editor (frontend)
- **CodeMirror 6, raw `@codemirror/*` modules, lazy-loaded** behind a dynamic `import()` (same discipline as shiki; must stay out of the entry chunk — verified by the existing dist-assets check). Monaco is rejected (multi-MB + workers that fail under Tauri CSP). `@shikijs/codemirror` **does not exist**; the 0.x community bridges are rejected (unmaintained, upstream-discouraged).
- Packages (current): core `@codemirror/state` `@codemirror/view` `@codemirror/language` `@codemirror/commands`; grammars lazy per language on first edit: `@codemirror/lang-javascript` (JS/TS/JSX/TSX), `-python`, `-rust`, `-json`, `-css`, `-html`, `-markdown`; **TOML** via `@codemirror/legacy-modes` (`StreamLanguage`, no first-party grammar) — recorded in an ADR.
- **Theme**: `EditorView.theme()` binding chrome to `var(--kr-*)`; `HighlightStyle` tag→color from the same `src/theme/tokens.ts` palette the shiki theme derives from (one palette, two consumers). The read-only Changes view keeps shiki; the editor uses CM grammars — they never load together for the same view.
- **UX** in `FileViewer.tsx` (All-files tab): when a text file is selected it is editable in CM6. Explicit **Save** button + **dirty** indicator + **Revert**; never autosave. Dirty-close guard: switching file/tab or closing with unsaved edits prompts. On a `"file changed on disk"` error, a banner offers **Reload**. Binary/truncated/ignored-under-`.git` files stay read-only with the existing notice.

---

## Item 6 — Further cheap improvements (proposed; final selection at planning)

Each must earn its keep and stay cheap. Shortlist, ranked:

1. **Rename affordance** — show `old → new` for renamed files. **Included** (falls out of item 4's kind-aware rendering; `old_path` already present). Cheapest.
2. **Per-file Undo** — `restore_file(cwd, path, baselineOid)` (git restore the file to the session baseline) behind a typed confirm popover, labelled **"Undo"** never "Reject" (Phase 4 Task 15). Now that a baseline oid exists (item 2), this is a natural, honest per-file revert. **Proposed** — medium cost; include if budget allows.
3. **Copy path** — a one-click copy of the repo-relative path on each file row/header. **Proposed** — trivial.
4. **Keyboard nav** — `j`/`k` move file selection, `Enter` opens/jumps. **Proposed** — small, big ergonomics win.
5. **"View in conversation"** — link a file card to the Studio event that changed it (Phase 3 Task 13). **Deferred** — needs event↔file mapping; more than cheap.

Recommend shipping 1 + 3 for sure, 4 if cheap, 2 as a stretch; defer 5.

---

## Cross-cutting

- **TDD per task**, `pnpm check` green before each commit, tokens-only styling, conventional commits, stage named files only, Rust commits via `PATH="$HOME/.cargo/bin:$PATH"`, Rust tests `CARGO_BUILD_JOBS=1 -- --test-threads=1`, push with `RUST_TEST_THREADS=1 CARGO_BUILD_JOBS=1`.
- **Security pass** on the `write_file` command (item 5) and the new git commands (item 2) — a dedicated review (`agent-skills:security-auditor`) before merge.
- **New types cross the IPC boundary**: `baseline_oid`, `FileDiff.binary`, `FileContent.mtime`, `FileWriteResult` — validate every input; keep Rust the sole owner of process/fs.
- **ADRs**: (a) session baseline model + why baseline over touched-file intersection; (b) CodeMirror 6 over Monaco/shiki-bridge, incl. the TOML legacy-mode.
- **QA** via `pnpm dev` + `window.__kriyon` seam (screencapture blocked); a final isolated smoke build for the human-visible check (live hook-driven refresh + baseline correctness need a real Tauri run).

## Testing strategy

- **Rust**: `snapshot_tree`/`capture_baseline` (tracked+untracked captured, gitignore respected, no refs/HEAD/index moved, no hooks fired, GIT_DIR ignored); `diff_session_changes` (catches Bash-style edits, self-corrects reverts, excludes pre-session dirt, renames); `parse_diff` binary flag; `write_file` (escape rejection, `.git` refusal, binary/oversize/truncated refusal, conflict-signature refusal, atomic replace, roundtrip).
- **Frontend**: `CollapsibleSection` open/persist; changes-store source selection (baseline vs fallback) + touched-files relativization + "my edits only" filter + zero-change filtering/`computeTotals`; `leaveChangesView` restore across both entry points and on session select; `FileViewer` edit→save→dirty→conflict-banner flow with a mocked bridge. Keep panes display-toggled (never unmount).

## Out of scope

Per-turn (vs whole-session) diff toggle (Phase 4 Task 16); compressing the jump rail for 100+ files; "view in conversation" linking; making `touchedFiles` capture Bash targets (not derivable from the hook).
