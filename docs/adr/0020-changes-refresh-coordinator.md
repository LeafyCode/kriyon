# ADR 0020 — One module owns when the Changes view re-runs its diff

**Status:** accepted · 2026-08-30

## Context

"How many `git` runs does a burst of edits cost, and when does the diff land?" is the
question the [Changes view] lives or dies by — too eager and Kriyon spawns git on every
keystroke of a `MultiEdit`, too lazy and the view lies about the working tree. Until now
that question had six owners:

| Where | What it decided |
|---|---|
| `state/sessions.ts` | the `RefreshReason` vocabulary, the 500ms live-edit debounce and its fire-time re-checks, the [Working-tree budget] refusal gate, base + [Session baseline] resolution, the memoized default-branch lookup, the [Repo toplevel] cache, [Working-tree watch] registration and release, the baseline-landed catch-up |
| `state/changes.ts` | in-flight + trailing coalescing, and `doRefresh`'s degrade ladder |
| `state/backendListeners.ts` | the watch event's entry point |
| `changes/ChangesView.tsx` | the mount / became-active / manual triggers |
| `changes/useFileEditorSession.ts` | the save trigger, plus its own staleness revalidator |
| `changes/FileBrowserTree.tsx` | a second, independently written copy of that revalidator |

Every piece was individually tested and individually correct. The cost was that no single
place answered the question, so each new trigger had to re-derive the gating rules from
scratch — which is how the [Working-tree budget]'s suppression (ADR 0017) came to be
written twice, in the debounce's fire path *and* in `requestRefresh`, to keep an armed
timer from sailing past a refusal that landed while it was pending.

## Decision

**`src/state/changesRefresh.ts` — the [Changes refresh coordinator] — owns refresh
policy, and nothing else does.**

It sits above the two stores it drives: it reads and writes both, and neither owns any
part of the policy. What moved into it:

- `RefreshReason` and `requestRefresh(sessionId, reason)` — the single entry point, so
  the debounce-vs-immediate decision is made once. `live-edit` debounces 500ms; every
  other reason refreshes now.
- The debounce itself, including the re-check at *fire* time (not only at arm time) of
  both the active-session bound and the budget gate.
- The [Working-tree budget] refusal gate, suppressing exactly `fs-change` and `live-edit`
  — the two the filesystem can fire indefinitely — and only off a refusal a *successful*
  refresh observed.
- `refreshSessionChanges`: base resolution (a [Worktree] session's default branch,
  memoized per project root), `baselineOid` thread-through, and the `onBaselineInvalid`
  callback that clears a pruned baseline (ADR 0015).
- The [Repo toplevel] cache, the [Working-tree watch]'s registration and its event entry
  point, and the release of both on session close.

`requestRefresh`'s signature is unchanged, and its call sites now import it from the
coordinator rather than through a re-export, so `sessions.ts` really sheds the
responsibility instead of fronting it.

**The fetch itself stays in `state/changes.ts`.** `doRefresh` and the in-flight/trailing
coalescing write that store's own `bySession` data; they decide how *one* `refresh` call
behaves, not when one happens. Moving them would have put `changes.ts` in a second import
cycle (below) and split its writer across two files for no policy gain. The coordinator is
now that store's only production caller, which is the boundary that matters.

> **Superseded — see the addendum below.** The epoch turned out to be the thing that
> settled it: publishing `refreshEpoch` from the coordinator while `changes.ts` stamped
> `fetchedAt` would have split an interface's name from its owner. The fetch moved.

**`sessionTouchedRelative` stays in `sessions.ts`.** It reads `touchedFiles` (written by
`applyActivity`) and `repoToplevel`, and is called through `useSessions(...)` so a touch
re-renders its consumers. It is a session-state projection that happens to need a path the
coordinator caches — not refresh policy.

### The import cycle, and why it is accepted

Two session-store actions must trigger a refresh from *inside* themselves —
`applyActivity` (a completed mutating tool) and `setBaseline` (a baseline landing for the
first time) — and `removeSession` must release what the coordinator holds. So the sessions
store calls into the coordinator, and the coordinator reads the sessions store. That is a
cycle, and Biome's `lint/suspicious/noImportCycles` (an error in this repo, via Ultracite)
rejects it.

It is accepted, with one line-scoped `biome-ignore` per import direction (not a
file-level `biome-ignore-all`) and an explanation in each module's header. The cycle is
inert: nothing crosses at module-evaluation time (both
modules build only empty caches and a `create()` call), and every edge in both directions
is a call made from inside a function body long after both modules have initialized. Both
evaluation orders were checked.

## Consequences

- `sessions.ts` drops ~360 lines and its Changes-related bridge calls; it now imports
  `upsertSession` alone. `sessions.test.ts` sheds four of its five bridge mocks and stubs
  the coordinator instead — the honest unit boundary, since the store hands it three calls
  and nothing more.
- A new trigger is one `requestRefresh(id, reason)` call plus, if its timing differs, one
  branch in one function. It cannot accidentally bypass the budget gate or the
  active-session bound.
- `changesRefresh.test.ts` characterizes the policy as a matrix — per-reason timing, the
  gate applying to exactly two reasons, trailing coalescing, and `fetchedAt` advancing only
  on success — written against the pre-move code and watched passing there first, so it
  pins behavior rather than describing the new shape.
- Type-only imports are exempt from `noImportCycles`, which is worth knowing before
  reaching for a suppression: a cycle that carries only types needs neither.

## Alternatives rejected

- **Compose the three triggers at the seams that already exist.** This is the strongest
  alternative, and not a strawman: the repo already composes multi-store operations at
  named seams, so each trigger has an idiomatic home — `applyActivity` at
  `backendListeners.ts:38`'s `onSessionActivity` handler, `setBaseline` in `actions.ts`'s
  `captureBaseline(cwd).then(oid => setBaseline(id, oid))` chain (L136-138), and
  `removeSession` in `App.tsx`'s `handleCloseSession` (L53-57), which already sequences
  `disposeSession` → `deleteSession` → `removeSession`. Fully acyclic. Rejected on three
  counts, in increasing order of weight:

  1. **The activity trigger cannot be composed correctly from outside.** It fires on a
     *transition* — `completedMutatingMainTool(prev, next)` / `aSubagentJustCompleted(prev,
     next)` — computed inside `applyActivity`'s `set` updater against the `prev` that
     update is actually replacing. A listener-side version has to read `activity[id]`
     first and call second, which is both a second store read and a gap: any other
     `applyActivity` for the same id landing between them silently changes the answer. It
     also means exporting two predicates that exist only to serve that one updater.
  2. **`setBaseline` has two production callers, not one** — `actions.ts:138` and this
     module's own `onBaselineInvalid` (`changesRefresh.ts:199`, clearing a pruned oid).
     Composing at `actions.ts` covers one of them, so "a baseline landing for the first
     time triggers a catch-up" stops being a property of the write and becomes a
     convention two call sites must each remember. That the second caller is *this file*
     is not reassurance — it is the demonstration that the set of callers is already
     growing.
  3. **`forgetSessionRefresh` is not a refresh at all — it is resource release**, and that
     is the argument that actually decides this. It drops a refcounted OS-level `notify`
     watch (plus a pending timer). RAII-style teardown belongs inside the action that owns
     the removal, for the same reason a destructor is not left to the caller: a leaked
     watch refcount is a different *bug class* from a missed refresh. A missed refresh is
     visible (the diff is stale, the manual button fixes it) and self-correcting on the
     next trigger; a watch that never releases is invisible, unbounded, accumulates one
     `notify` watcher per closed session for the app's lifetime, and no UI surface would
     ever show it. Moving that out to `handleCloseSession` buys acyclicity by making the
     riskiest of the three calls the easiest one to forget.
- **A registration seam** (a leaf module the coordinator installs a trigger callback into).
  Acyclic — and the repo does have precedent: `App.tsx:205-211` installs six `install*()`
  seams from one effect, and `installPersistence` has precisely the failure mode this
  design would introduce (forget the call and writes silently stop). `setBaseline`'s own
  comment (`sessions.ts:836-839`) records having been bitten by it, and its explicit
  `upsertSession` re-persist exists *because* of it. So the objection cannot be "the repo
  doesn't do this". It is that the failure mode is worse here, in three ways. The
  persistence miss is **loud and bounded**: nothing survives a restart, which any boot
  reproduces. A missing refresh trigger is **quiet and partial** — the mount and manual
  paths call `requestRefresh` directly and keep working, so only the live triggers die and
  the view merely looks a little laggy. Second, the existing six seams all wrap a
  *lifecycle* — they subscribe to a backend stream and return a stop function. A plain
  function call has none, so this invents one purely to satisfy a linter. Third, all six
  run **inbound** (backend stream → store); this would be **outbound** (store → policy),
  inverting the direction the pattern establishes. And note the precedent's own lesson:
  `setBaseline` answered the fragility by adding a redundant direct write — the repo's
  response to this pattern was to route around it.
- **Inject the sessions store into the coordinator** (a factory taking the store, with a
  type-only import for its shape). Acyclic and safe, but it introduces dependency
  injection for exactly one caller to satisfy a linter, and the instance would have to live
  in `sessions.ts` — which puts the facade back where the extraction was trying to remove
  it.
- **Leave the policy where it was.** The six-owner split is what this ADR exists to end,
  and the duplicated budget gate is the evidence it was already costing something.

## Known limits

- ~~**The coordinator is not covered by `noImportCycles` any more.** A file-level
  suppression hides *future* cycles through these two modules as well as the deliberate
  one.~~ Resolved by Task 5 (commit `880e171`): every suppression is line-scoped to its
  own import, not file-wide, so `noImportCycles` still catches a *new* cycle through
  `sessions.ts`, `changes.ts`, or `changesRefresh.ts` — only the three deliberate edges
  named above are suppressed. A third module joining the cycle would still be flagged at
  its own end, so detection is reduced, not lost.
- ~~**`refreshEpoch` was not added, and could not honestly be.**~~ Resolved by the
  addendum below: the coalescer, `doRefresh` and the epoch moved together, and
  `refreshEpoch` is now a selector read by `useRevalidateOn` in the module that stamps it.
  (The original limit: its only intended consumers read `fetchedAt` through a
  `useChanges(...)` *hook* selector, which a non-reactive getter cannot serve — and more
  importantly `changes.ts` still advanced the epoch, so the coordinator did not own the
  value it would be publishing.)

## Addendum, 2026-08-30 — the fetch and the epoch moved too

`refreshEpoch` is the interface the two revalidating surfaces need, and an interface whose
name lives in one module while another module writes its value is the split this ADR
exists to end. So the rest of the fetch followed it into `changesRefresh.ts`:
`inFlight`/`trailingRefresh`/`runRefreshChain` (the coalescer), `doRefresh` (the degrade
ladder, the `loading`/`ready`/`error` transitions, and the `fetchedAt` stamp), the two
baseline-label helpers, and `RefreshOptions`. `changes.ts` keeps the data (`bySession`),
the pure diff helpers, and the two [Command failure kind] predicates the ladder reads.

Two consequences worth naming:

- **`refresh` stays a store action**, one line, forwarding to the coordinator's
  `startRefresh`. A fetch that writes this store's data is dispatched *through* this
  store, and that action is the seam a caller — or a test — can swap; the coordinator's
  own `refreshSessionChanges` dispatches through it for exactly that reason. The
  round-trip (coordinator → store action → coordinator) is the price of keeping one
  swappable seam instead of two entry points.
- **A second import cycle, `changes.ts` ↔ `changesRefresh.ts`**, handled the same way as
  the first: one line-scoped `biome-ignore` per import direction, each pointing here. It
  is inert on the
  same terms — `changes.ts` reads `startRefresh` lazily inside the action body, and
  nothing in either module dereferences the other at module-evaluation time. `madge` now
  reports three cycles rather than one, but they are the same three modules seen from
  three angles (`changes ↔ changesRefresh`, `changesRefresh ↔ sessions`, and
  `changes → changesRefresh → sessions → changes`), and every end already carries the
  suppression. A fourth module joining would still be flagged at its own end.

The same pass gave the sessions store a `setRepoToplevel(id, cwd, toplevel?)` action, so
the coordinator's [Repo toplevel] cache is written through the store that owns it instead
of a bare `setState` reaching into someone else's state. The cycle is unaffected — the
coordinator already called into that store.
