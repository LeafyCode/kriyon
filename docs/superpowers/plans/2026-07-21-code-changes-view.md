# Code Changes View — research & plan

**Date:** 2026-07-21 · **Status:** planning (research session, no code yet)
**Request:** "See the code Claude changed, like in Cursor. Browse files like a real editor."
**Design reference:** design mockups (not in this repo), variants 1a full-screen view, 1b slide-over panel.

---

## 1. What the research says

### Common pitfalls in agent review UIs

Reported by users of existing agent review tools:

1. **Cumulative-only diffs**: one view of everything since the chat started, so agent changes and the user's own git changes can't be told apart.
2. **Accepted changes vanish mid-review**, losing the map of what was approved.
3. **Editor-wide lag** from accumulated diff data.
4. **The review surface silently fails**, so edits land with no review step.
5. **Incomplete diffs**: some edits never show up for review.
6. **A separate checkpoint store that loses data** on restore.
7. **Stale diffs** that drift from the real state.
8. **Forced inline diff decoration** while just reading code.

**Meta-lesson: nearly every complaint is about *trust* — the review surface under-reporting, showing stale state, or destroying history — not about diff rendering.**

### Patterns worth copying

- **Zed**: one multi-buffer review tab, all changed files as excerpts, per-hunk keep/reject, keyboard next/prev. Most-praised pattern.
- **VS Code Copilot Edits**: verbs are **Keep / Undo** (not Accept/Reject) because files are already on disk — honest naming. Resolved files stay visible; auto-advance to next pending.
- **Aider**: git is the ledger — AI edits auto-committed, user's dirty state committed separately first. No parallel snapshot store, so none of the checkpoint failures above.
- **Claude Code /code-review**: severity tags (Important/Nit/Pre-existing).
- **Cline**: graduated trust (per-path auto-approve) as the answer to review fatigue.

### Demand evidence

Direct feature requests on anthropics/claude-code ([#38831](https://github.com/anthropics/claude-code/issues/38831), [#33932](https://github.com/anthropics/claude-code/issues/33932), [#52179](https://github.com/anthropics/claude-code/issues/52179), [#44787](https://github.com/anthropics/claude-code/issues/44787)); a whole tool category exists to fill the gap (diffity, revdiff, Hunk), and every serious Claude Code GUI (opcode ~21k★, Conductor, Nimbalyst) ships a diff viewer as a headline feature.

---

## 2. What Kriyon already has

| Piece | Where | State |
|---|---|---|
| Unified-diff parser → `FileDiff`/`DiffHunk`/`DiffLine` | `crates/kriyon-core/src/git.rs:76` | Reusable as-is |
| `diff_worktree(path, base) → SessionDiff` command | `src-tauri/src/git_cmd.rs:166` | Worktree-scoped; generalize |
| Diff renderers | `src/inspector/ReviewPanel.tsx`, `src/studio/blocks/Diff.tsx` | Closest analogs; too small (272px inspector) |
| Per-edit transcript events (`Diff`, `Code`) | `crates/kriyon-core/src/transcript.rs:358` | Edit = naive old/new concat, no hunk context; **MultiEdit unhandled** |
| Hook events (which file, when, which turn) | `hooks.rs` `HookEvent.target` | Paths only — **no edit content** |
| Gitignore-aware file walker `list_files` | `src-tauri/src/completion_cmd.rs:582` | Ready for the file tree |
| View switching (`transcriptView`, display-toggled panes) | `src/state/layout.ts`, `src/layout/Shell.tsx` | The slot for a new view |
| Syntax highlighting | — | **None. Net-new.** |
| Read-file IPC command | — | **None. Net-new.** |

---

## 3. Core decisions

1. **Git is the ground truth for "what changed"; hook events only say *which files* and *when*.**
   Diffs are recomputed from disk via `git diff` on every open/refresh — never reconstructed from tool-call parsing. This single decision kills Cursor pain points 1, 4, 5, 7 (under-reporting, staleness, ghost diffs). Hook `PostToolUse.target` events drive liveness (badge counts, "changed 4 files" chip, refresh triggers) and attribute files to sessions/turns.

2. **Read, don't gate — the suggested design has this right.**
   The terminal is the source of truth; edits are already on disk. v1 is a review *reading* surface with no accept/reject state machine. The only mutating action (later phase) is a git-backed **"Undo file"** (`git checkout -- <file>` / restore from HEAD), using VS Code's honest verb. No parallel checkpoint store, ever (Cursor pain points 6–7).

3. **Baseline is explicit and visible.**
   - Worktree sessions: diff vs merge-base with default branch (existing `diff_worktree`).
   - Main-checkout sessions: working tree vs HEAD, with files **grouped into "this session touched" vs "other changes"** using hook targets — this handles Kriyon's shared-checkout reality (multiple sessions, user edits) instead of pretending everything is Claude's.
   - Per-turn incremental view is a later phase (needs turn-boundary snapshots), but the baseline label is in the UI from day one.

4. **Attribution and "why" come from data we uniquely have.**
   The design's "why" groups (Claude's reasoning inline between file cards) come from transcript `Assistant` text adjacent to `Diff`/`Code` events, and each file card links back to the conversation turn. No competitor grounded in a terminal agent does this.

5. **File browsing = read-only viewer, not an editor (v1).**
   "Like a real editor" means: full tree, open any file, syntax highlighting, changed-lines gutter. Actual editing stays out — an in-app editor writing while the agent writes is a conflict machine, and the OS editor is one click away (`open_path` exists). Revisit only if users ask after shipping.

6. **Highlighting: shiki**, lazy-loaded grammars for the ~10 languages `lang_from_path` already knows, themed from `src/theme/tokens.ts`. Virtualize the diff feed; collapse files >400 lines changed and lockfiles/generated files by default (Cursor pain point 3 + review-fatigue research).

---

## 4. Assessment of the suggested design

Keep (it independently matches the research):
- No approve/reject gate ("a read, not a checkpoint") ✓ decision 2
- Changed-files-first tree with "All files" tab + "12 unchanged files hidden" ✓
- "Why" reasoning blocks grouping file cards ✓ decision 4
- Session context strip + "also running" chips (multi-session orientation) ✓
- Both entry points: chat chip → panel (1b) and dedicated view (1a) ✓
- Summary bar with test-run result ("✓ ran pnpm test — 12 passed") — great trust signal, feed from Bash hook events

Improve:
- **Add a visible baseline label** ("vs main @ a1b2c3" / "uncommitted vs HEAD") — the most common confusion in other tools is *whose changes am I looking at*; the design doesn't show it.
- **Add a stale/refresh affordance** — agent keeps editing while you read; auto-refresh with a subtle "updated 2s ago" pulse rather than silently mutating scroll position.
- **Add per-file "Undo" (phase 4)** — research shows a hard core of users (Zed discussions) won't adopt a review surface with no way to reject; git-backed revert covers it without a state machine.
- **Jump rail**: keep, but make dots per *file* clickable and reflect viewed state (dim after scrolled past) — cheap "keep resolved context visible" win.
- 1b's collapsed file cards should remember expand state per file across refreshes.

---

## 5. Phased plan

### Phase 1 — Changes view core (the 80%)
- Rust: `diff_working_tree(cwd, base?) → SessionDiff` command generalizing `diff_worktree` (HEAD default, merge-base for worktrees); `read_file(cwd, path) → {content, truncated}` with `validate_cwd` sandboxing + size cap.
- Frontend: new `transcriptView: "changes"` in `layout.ts`; view toggled in `SessionHeader` next to Studio/Raw; layout = changed-files tree (reuse `FileDiff` data) + virtualized diff feed + summary bar, per design 1a's body.
- Shiki integration themed from tokens; plain-text fallback.
- Refresh: on view open, on `PostToolUse` hook events for Edit/Write/MultiEdit (debounced), manual refresh button.
- Session attribution grouping ("this session" vs "other changes") from hook targets.

### Phase 2 — Entry points + orientation
- "N files changed +x −y" chip in Studio view after each turn (data: hook targets + `git diff --numstat`) → opens the view (design 1b panel or jumps to 1a; pick one — recommend the dedicated view first, panel later if it earns its keep).
- Sidebar/session-row changed-files badge.
- Jump rail with viewed-state dots; baseline label; stale indicator + auto-refresh.

### Phase 3 — "Why" grouping + file browser
- Group file cards under adjacent assistant reasoning from transcript events; link each card to its turn in Studio view.
- "All files" tab: full tree via `list_files` (drop the query filter for browse mode), open any file read-only with highlighting; changed files get gutter markers.
- Test-run summary from Bash hook events (detect test commands + exit status).

### Phase 4 — Trust actions
- Per-file **Undo** (git restore) with confirm; disabled for files with "other changes" overlap.
- Per-turn incremental diff toggle (snapshot `git diff` output or tree hash at each Stop hook event as the turn baseline).
- Fix transcript Edit mapping while in there: real hunk context, MultiEdit support (`transcript.rs:358` area) — improves Studio blocks too.

Each phase ships independently; Phase 1 alone already gets trust right (git ground truth, no gate, no snapshot store).

### Explicitly out of scope
- In-app text editing; hunk-level accept/reject state machine; any snapshot/checkpoint store outside git; inline decoration of the terminal view.

---

## 6. Risks

- **Shared checkout, multiple sessions** (the shared-checkout reality): attribution via hook targets is best-effort — two sessions touching one file shows as both. Acceptable; the diff itself is still truthful.
- **Big diffs / generated files**: mitigated by collapse-by-default + virtualization; measure with a 100-file changeset before Phase 1 done.
- **shiki bundle size**: lazy-load; keep out of the main chunk (binary-size discipline per the perf work).
