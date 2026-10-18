# Architecture deepening — design

**Date:** 2026-08-30
**Status:** Approved: fix all 8 candidates from the 2026-08-30 architecture review properly, without cutting corners.
**Base:** stacked on `feat/editor-hardening` (PR #23); branch `feat/architecture-deepening`
**Relates to:** ADR 0006 (string IPC errors — its stated revisit trigger has fired), ADR 0015/0017 (implemented by candidate 1), CONTEXT.md (new terms added per candidate below)

## Goal

Turn eight shallow seams into deep modules, guided by the architecture review's
evidence. Behavior is preserved everywhere except where a candidate explicitly
says otherwise; every move lands with the existing tests passing and new tests at
the new seams. The review's "already deep — do not touch" list (GitRun,
session_diff/DiffAnchor, gitGutter, onEvent, sessionUsageView, persistence
validators) is binding: those modules are not restructured.

## Candidates (all approved)

### D1 — sessionRow projection (review #5)

The `UiSession → SessionRow` 10-field projection is hand-written three times
(`sessions.ts` setBaseline literal, `persistence.ts` persist literal,
`persistence.ts` persistKey in a different order). One
`sessionRow(session: UiSession): SessionRow` becomes the single projection;
`persistKey` derives from its output (so a new field automatically joins
change-detection); `idleSession` stays as the inverse. A round-trip test
(`idleSession(sessionRow(s))` preserves every persisted field) replaces nothing
→ it's new coverage. Five frontend edit-sites-per-field become two.

### D2 — Command failure kinds (review #2) + ADR-0006 amendment

Four failure kinds the frontend already branches on (baseline-pruned,
working-tree-over-budget, save-conflict, file-missing) are hand-synced string
literals with two different matching disciplines. Replace the *matching* layer:

- Rust: recoverable-failure errors gain a machine-readable leader —
  `kind:<slug>: <human message>` (string `Result` stays; ADR-0006's transport
  is untouched). One Rust helper formats it; the four sites adopt it.
- TS: one classifier `commandFailure(err: unknown): FailureKind`
  (`"baselinePruned" | "overBudget" | "saveConflict" | "fileMissing" | "unknown"`)
  in `src/ipc/failures.ts`; the four `is*Error` call sites read through it.
  Display text = the human half (leader stripped).
- Tests: one round-trip test per kind pinning the Rust leader against the TS
  classifier (replaces the 8 spelling pins; keep the Rust constants).
- ADR-0006 gets an addendum: the revisit trigger fired ×4; the leader scheme is
  the answer; plain strings remain the rule for non-recoverable failures.
- CONTEXT.md term: **Command failure kind**.

### D3 — Changes refresh coordinator (review #1) + ADR

The refresh policy currently has six owners. New module
`src/state/changesRefresh.ts` owns:

- the `RefreshReason` vocabulary and per-reason debounce-vs-immediate policy
  (500ms debounce with fire-time gate re-check, as today)
- the Working-tree-budget refusal gate
- base + Session-baseline resolution incl. the memoized default-branch lookup
- the Repo-toplevel cache + Working-tree-watch registration
- the pruned-baseline / over-budget degrade ladder (consumes D2's classifier)
- in-flight + trailing coalescing (moves from `changes.ts`)
- the epoch signal (today's `fetchedAt`) and a shared revalidation hook
  `useRevalidateOn(sessionId, fn)` that owns the three-clause staleness guard
  both leaf components currently reimplement.

Interface: `requestRefresh(sessionId, reason)` (name preserved — call sites
don't churn), `refreshEpoch(sessionId)` selector, `useRevalidateOn`.
`sessions.ts` sheds ~555 lines; `useFileEditorSession.ts` and
`FileBrowserTree.tsx` each drop their hand-rolled revalidator (the editor's
baseline-refetch throttle/request-id logic stays local — it is editor policy,
not refresh policy). Behavior-preserving; every moved piece keeps its tests
(moved alongside) and the coordinator gets its own suite. New ADR (0020 or next
free number): "Changes refresh coordinator owns refresh policy".
CONTEXT.md term: **Changes refresh coordinator**.

### D4 — Changes view model (review #3, after D3)

`changesView(sessionId)` — a memoized selector in `src/state/changesView.ts`
returning one resolved view: visible files, filtered display files, on-screen
diff totals, `pane: "feed" | "viewer" | "empty" | "loading" | "budget"`,
summary label, jump-rail inputs, edits-filter state. `ChangesView.tsx` consumes
it instead of 13 selectors + 7 inline derivations; `computeShowViewer`/
`computeEditsFilterActive`/`summaryFilteredFiles` fold in. The 13 per-session
maps consolidate onto `SessionChanges` where churn analysis allows; where the
anti-churn split must stay, it stays *inside* the store with ONE comment, and
`dropSession` becomes a single delete per structure. Test cost drops:
`changesView` is pure; `seedReadySession` shrinks. CONTEXT.md term:
**Changes view model**.

### D5 — bridge.ts event table (review #4)

One `subscribe<T>(event: string)` factory; the 17 copy-pasted `on*` subscriber
bodies become a table of one-liners; the `hasTauri()` no-op guard gets one
home (subscribe + a `command` wrapper if trivially applicable, else guards stay
at command sites). No API change for callers. Table is exhaustively tested.

### D6 — SandboxRoot newtype (review #6, Rust)

`SandboxRoot::validate(store, cwd)` is the only constructor (runs
`reject_flag_like` + `validate_cwd` + UTF-8 conversion);
`root.resolve(path) -> SandboxedPath` runs `resolve_within` + `refuse_dot_git`.
The seven `*_sync` functions take `&SandboxRoot`/`SandboxedPath` so validation
becomes uncallable-around; the `_for` test-delegation layer collapses (tests
construct a `SandboxRoot` directly). Lives beside the helpers in `file_cmd.rs`
(or a small `sandbox.rs`). All existing sandbox tests keep passing, retargeted
at the typed constructors. CONTEXT.md term: **Sandbox root** (extends the
existing File-sandbox entry).

### D7 — commands.rs split (review #7, Rust)

Placement only: `store_cmd.rs` (CRUD wrappers), `prompt_cmd.rs`,
`settings_cmd.rs` (notification/memory/sleep/sound), `window_cmd.rs`
(clipboard/window), leaving `commands.rs` as PTY session lifecycle + transcript
watching + worktree bootstrap. `generate_handler!` list updated; zero behavior
change; tests move with their families.

### D8 — FileViewerNotice union (review #8)

`useFileEditorSession` returns one
`notice: { kind: "none" | "closeGuard" | "switchGuard" | "saveError" | "staleOnDisk" | "missingOnDisk", … }`
discriminated union (payloads: `switchGuard.to`, `saveError.message/canReload`,
`missingOnDisk.dirty`); the mutual-exclusivity prose comment becomes the type.
`FileViewer` renders one switch; binary/truncated/lossy notices stay separate
(they are content states, not session notices). Return field count drops.
CONTEXT.md term: **File viewer notice**.

## Order and constraints

Sequence: D1 → D2 → D3 → D4 → D5 → D6 → D7 → D8 → final verification.
(D3 depends on D2's classifier; D4 depends on D3. D5-D8 are independent.)

- Behavior-preserving throughout: `pnpm check` green before every commit; no
  user-visible change except D2's error strings gaining a stripped leader
  (display text unchanged for users).
- TDD: new seams get failing tests first; moved code keeps its moved tests.
- Terms land in CONTEXT.md in the same commit that introduces the name.
- ADR-0006 addendum (D2) and a new coordinator ADR (D3) are part of those tasks.
- The editor's ADR-0016 entry-chunk invariant must hold at the end (D5 touches
  bridge.ts which is entry-chunk; no CodeMirror may leak).
- Stacked branch: if PR #23 merges mid-work, rebase onto main is allowed;
  otherwise the PR targets `feat/editor-hardening`.

## Risks

- D3 is a large relocation: mitigate by moving tests alongside and keeping
  `requestRefresh`'s signature; the review confirmed every moving piece is
  individually tested today.
- D4's map consolidation can regress selector churn (scroll perf): keep the
  anti-churn split where measurements/tests demand; the consolidation is
  secondary to the view model.
- D6 touches the trust boundary: sandbox tests must stay green and no
  `pub(crate)` escape hatch may allow constructing `SandboxedPath` unchecked.
