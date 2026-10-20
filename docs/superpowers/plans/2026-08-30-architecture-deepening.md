# Architecture Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all eight deepening candidates from the 2026-08-30 architecture review — one seam per task, behavior-preserving, with the new interfaces tested at their own level.

**Architecture:** Each task turns one shallow seam into a deep module per the spec. The binding evidence (exact line refs, the friction being removed, and the target interface) lives in the spec and the architecture review it quotes; implementers read the *current* code first — line numbers drifted as the branch moved.

**Tech Stack:** React 18 + TypeScript + zustand (frontend), Rust/Tauri v2 (backend), vitest + cargo test.

**Spec:** `docs/superpowers/specs/2026-08-30-architecture-deepening-design.md`

## Global Constraints

- Behavior-preserving refactors: every existing test keeps passing (moved tests move with their code); `pnpm fix && pnpm check` green before EVERY commit.
- TDD for every NEW seam: write the failing test against the new interface first.
- A term must land in `CONTEXT.md` in the same commit that introduces the module/type name (terms per spec: Command failure kind, Changes refresh coordinator, Changes view model, Sandbox root, File viewer notice).
- Rust-touching commits: `PATH="$HOME/.cargo/bin:$PATH" git commit …`.
- Stage NAMED files only (never `git add -u`); untracked local files must never be staged.
- Conventional commits on branch `feat/architecture-deepening` (stacked on feat/editor-hardening).
- Design tokens only from `src/theme/tokens.ts`; no CodeMirror in the entry chunk (ADR-0016) — re-verify in the final task since D5 edits `bridge.ts`.
- The review's "already deep — do not touch" list is binding: GitRun, session_diff/DiffAnchor, gitGutter's internals, onEvent, sessionUsageView, persistence validators.
- tsc lib predates `Array.prototype.at()`/`Object.hasOwn` — avoid both.
- Frontend stays IPC-only through `src/ipc/bridge.ts`; Rust↔JS boundary validates every input.

---

### Task 1: D1 — `sessionRow` projection

**Files:**
- Modify: `src/state/sessions.ts` (setBaseline's 10-field `upsertSession({…})` literal, ~L1158-1171), `src/state/persistence.ts` (persist literal ~L440-457, `persistKey` ~L414-437)
- Test: `src/state/persistence.test.ts` (or the file that currently covers persist/persistKey — find it), `src/state/sessions.test.ts`

**Interfaces:**
- Produces: `export function sessionRow(session: UiSession): SessionRow` (in `sessions.ts` beside `idleSession`, or `persistence.ts` if import cycles demand — implementer's call, documented). `persistKey` derives from `sessionRow`'s output by folding its entries in a stable key order (sort keys — do NOT rely on insertion order), so a new SessionRow field automatically joins change-detection.

- [ ] Failing round-trip test first: for a fully-populated `UiSession`, `idleSession(sessionRow(s))` preserves every persisted field; and `persistKey` changes when any single `SessionRow` field changes (loop over keys, perturb one at a time).
- [ ] Implement `sessionRow`; replace all three hand-written literals with calls; `persistKey` folds the projection.
- [ ] Full suites for both files + `pnpm check`; commit `refactor(state): one sessionRow projection feeds setBaseline, persist, and persistKey`.

### Task 2: D2 — Command failure kinds + ADR-0006 addendum

**Files:**
- Create: `src/ipc/failures.ts` + `src/ipc/failures.test.ts`
- Modify: `src-tauri/src/git_cmd.rs` (baseline-pruned + over-budget error sites and their constants), `src-tauri/src/file_cmd.rs` (`WRITE_CONFLICT_ERROR`, `WRITE_MISSING_ERROR` sites), `src/state/changes.ts` (`isMissingBaselineObjectError`/`isWorkingTreeTooLargeError` call sites ~L457-510), `src/changes/useFileEditorSession.ts` (`isConflictError`/`isMissingFileError` ~L45-72), `docs/adr/0006-string-typed-ipc-error-seam.md` (addendum)
- Test: the existing pin tests on both sides (retarget, don't delete coverage)

**Interfaces:**
- Rust: `fn tagged_failure(kind: &str, message: &str) -> String` producing `"kind:<slug>: <message>"`; slugs: `baseline-pruned`, `over-budget`, `save-conflict`, `file-missing`. The four error sites adopt it; human halves keep their current wording.
- TS: `export type FailureKind = "baselinePruned" | "overBudget" | "saveConflict" | "fileMissing" | "unknown"`; `export function commandFailure(err: unknown): FailureKind`; `export function failureMessage(err: unknown): string` (leader stripped for display). The four `is*Error` helpers become thin wrappers over `commandFailure` (keep exports so call sites/tests don't churn) or call sites migrate — implementer picks the smaller diff and says so.

- [ ] Failing TS classifier tests first: each Rust leader string (copied verbatim per kind) → its kind; unleadered strings → `unknown`; `failureMessage` strips exactly one leader.
- [ ] Rust: introduce `tagged_failure`, adopt at the four sites, update the Rust pin tests to assert the full leadered strings.
- [ ] TS: classifier + migrate the four branch points; every banner/display path uses `failureMessage`.
- [ ] Cross-boundary round-trip test per kind (TS test contains the verbatim Rust output).
- [ ] ADR-0006 addendum: trigger fired ×4, leader scheme adopted, plain strings remain for non-recoverable failures.
- [ ] CONTEXT.md: add **Command failure kind**.
- [ ] `pnpm check`; commit (Rust PATH) `refactor(ipc): tagged failure kinds behind one classifier (ADR-0006 addendum)`.

### Task 3: D3 — Changes refresh coordinator (module extraction)

**Files:**
- Create: `src/state/changesRefresh.ts` + `src/state/changesRefresh.test.ts`
- Modify: `src/state/sessions.ts` (move ~L433-988: ensureRepoToplevel, applyWorkingTreeChange, sessionTouchedRelative?, cachedDefaultBranch, refreshSessionChanges, baselineJustLanded, scheduleChangesRefresh, refusedByWorkingTreeBudget, requestRefresh — read the current code; keep `sessionTouchedRelative` where its consumers argue it belongs and say so), `src/state/changes.ts` (move inFlight/trailingRefresh/runRefreshChain ~L512-572 and doRefresh's orchestration ~L574-668; the degrade-ladder branch now reads D2's `commandFailure`), `src/state/backendListeners.ts` (import site), `src/state/sessions.test.ts` (move the refresh/baseline/touched tests + their five bridge mocks into changesRefresh.test.ts)
- Create: `docs/adr/00XX-changes-refresh-coordinator.md` (next free number)

**Interfaces:**
- Produces: `requestRefresh(sessionId, reason)` (signature unchanged — re-exported or imported from the new module at existing call sites), a `refreshEpoch(sessionId)` read (may remain `bySession[id].fetchedAt` under the hood — the coordinator owns advancing it), and the policy internals listed in the spec.
- NOT in scope: `useRevalidateOn` (Task 4) and any behavior change. Every reason's debounce/gate semantics stay byte-equivalent.

- [ ] First: a characterization test in changesRefresh.test.ts pinning today's policy (per-reason: debounced vs immediate; budget gate applies to exactly the two reasons it does today; trailing coalesce) — write it against the CURRENT code's behavior via the existing public surface, watch it pass, THEN move code under it.
- [ ] Move in reviewable slices (multiple commits welcome): coalescer first, then refresh orchestration, then watch/toplevel/default-branch plumbing. `sessions.ts` keeps only session state.
- [ ] Migrate the moved tests; `sessions.test.ts` sheds the five bridge mocks.
- [ ] ADR + CONTEXT.md term **Changes refresh coordinator** in the final commit of the task.
- [ ] `pnpm check` green at every commit; task commit series prefix `refactor(state): …`.

### Task 4: D3b — `useRevalidateOn` shared revalidation hook

**Files:**
- Modify: `src/state/changesRefresh.ts` (+hook), `src/changes/useFileEditorSession.ts` (revalidation effect ~L440-530: replace the hand-rolled revalidatedAtRef/three-clause guard; the baseline throttle/request-id/staleness handling stays local and rides the callback), `src/changes/FileBrowserTree.tsx` (same protocol ~L295-313, incl. its pendingReval interplay)
- Test: `src/state/changesRefresh.test.ts`, both consumers' suites

**Interfaces:**
- Produces: `useRevalidateOn(sessionId: string | undefined, fn: () => void)` — owns: skip-first-observation, skip-unchanged-epoch, skip-epoch-0; calls `fn` on every genuine bump. Consumers own their own staleness/throttle logic inside `fn`.

- [ ] Failing hook tests first (renderHook): first observation is a no-op; bump → fn once; unchanged → none; per-session isolation.
- [ ] Migrate both consumers; their observable behavior (existing tests) unchanged.
- [ ] `pnpm check`; commit `refactor(changes): one revalidation protocol via useRevalidateOn`.

### Task 5: D4 — Changes view model

**Files:**
- Create: `src/state/changesView.ts` + `src/state/changesView.test.ts`
- Modify: `src/changes/ChangesView.tsx` (13 selectors + 7 derivations → one consumption; fold computeShowViewer/computeEditsFilterActive/summaryFilteredFiles), `src/state/changes.ts` (map consolidation where churn-safe; single-delete dropSession), dependent tests (`ChangesView.test.tsx` seedReadySession shrinks)
- Test: pure tests for every pane decision + filter combination

**Interfaces:**
- Produces: `changesView(sessionId)` returning `{ pane, files, displayFiles, totals, summaryLabel, jumpRailInputs, editsFilterActive, … }` — exact shape derived from what ChangesView.tsx consumes today (enumerate it in the task's first commit as the type).
- Constraint: selector-churn parity — scrolling must not re-render the feed more than today. Where a map must stay split for churn, it stays, with one explanatory comment replacing the eight.

- [ ] Failing pure tests first: pane selection matrix (loading/empty/budget/viewer/feed), edits-filter interaction, totals vs displayFiles consistency (the invariant the review says is comment-maintained today).
- [ ] Implement selector; migrate ChangesView; consolidate maps only where the churn constraint provably holds (memoized per-session view keyed on inputs).
- [ ] CONTEXT.md term **Changes view model**.
- [ ] `pnpm check`; commits `refactor(changes): …`.

### Task 6: D5 — bridge.ts event table

**Files:**
- Modify: `src/ipc/bridge.ts` (17 `on*` subscriber bodies ~L182-372 → one `subscribe<T>` + table)
- Test: `src/ipc/bridge.test.ts` (exhaustive table assertion: every exported `on*` wires the right event name)

- [ ] Failing test first: table-driven — each `on*` export subscribes its exact event string and no-ops without Tauri (assert via the existing hasTauri seam/mocks in that test file).
- [ ] Implement `subscribe<T>(event)`; callers unchanged.
- [ ] `pnpm check`; commit `refactor(ipc): one subscribe factory replaces 17 hand-rolled event listeners`.

### Task 7: D6 — SandboxRoot newtype (Rust)

**Files:**
- Modify: `src-tauri/src/file_cmd.rs` (SandboxRoot/SandboxedPath + the three `*_sync` + `_for` collapse), `src-tauri/src/git_cmd.rs` (read_baseline's chain adopts it; other `validated_repo_path` users only if the diff stays small — otherwise note as follow-up), `src-tauri/src/completion_cmd.rs` only if validate_cwd's signature needs a wrapper (avoid churn)
- Test: existing sandbox tests retargeted at `SandboxRoot::validate` + `resolve`; the not-a-known-root and escape/.git tests must remain meaningful (they now test the constructor).

**Interfaces:**
- Produces: `pub(crate) struct SandboxRoot(PathBuf as canonical, str-checked)` with `validate(store: &StoreState, cwd: &str) -> Result<Self, String>`; `fn resolve(&self, path: &str) -> Result<SandboxedPath, String>`; `SandboxedPath` unconstructable outside the module (no pub fields, no other constructor). `*_sync` take these types.
- Constraint: no behavior change — every existing error string byte-identical (the D2 leaders included).

- [ ] Failing compile-level assertion is the design; runtime tests first for the constructor (escape, .git, not-a-root, non-UTF-8 → the module's documented refusal).
- [ ] Implement; collapse `_for` layers; CONTEXT.md **Sandbox root**.
- [ ] `pnpm check` (clippy pedantic!); commit (Rust PATH) `refactor(rust): SandboxRoot makes the file sandbox uncallable-around`.

### Task 8: D7 — commands.rs split (Rust)

**Files:**
- Create: `src-tauri/src/store_cmd.rs`, `prompt_cmd.rs`, `settings_cmd.rs`, `window_cmd.rs`
- Modify: `src-tauri/src/commands.rs` (keeps PTY lifecycle/transcript/worktree), `src-tauri/src/lib.rs` (mod decls + generate_handler list)

- [ ] Pure moves — `git log --follow`-friendly, no signature changes; tests move with their families; module docs state each family's scope (mirror git_cmd.rs's doc style).
- [ ] `pnpm check`; commit (Rust PATH) `refactor(rust): commands.rs splits into per-family command modules`.

### Task 9: D8 — FileViewerNotice union

**Files:**
- Modify: `src/changes/useFileEditorSession.ts` (derive `notice` from the existing states; drop now-redundant return fields where FileViewer was the only consumer — check each), `src/changes/FileViewer.tsx` (one switch renders the banners; binary/truncated/lossy notices unchanged), both test files

**Interfaces:**
- Produces: `notice: FileViewerNotice` per the spec's union. Exclusivity precedence (must match today's observable behavior): closeGuard > switchGuard > missingOnDisk > saveError > staleOnDisk > none — VERIFY against current rendering order before encoding, and write the precedence test first.

- [ ] Failing tests first: precedence matrix (each pair of simultaneously-true states renders exactly today's winner).
- [ ] Implement; CONTEXT.md **File viewer notice**.
- [ ] `pnpm check`; commit `refactor(editor): FileViewerNotice union makes banner exclusivity a type`.

### Task 10: Final verification + PR

- [ ] Full `pnpm check`; `pnpm build` + ADR-0016 entry-chunk grep (bridge.ts changed).
- [ ] CONTEXT.md audit: all five new terms present, cross-linked `[Term]` style.
- [ ] Push `feat/architecture-deepening`; PR — base `main` if PR #23 has merged, else base `feat/editor-hardening` with a "stacked on #23" note. Body summarizes D1-D8 with spec/plan/ADR links.
