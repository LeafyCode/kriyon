import { useEffect, useRef } from "react";
import {
  defaultBranch,
  diffSessionChanges,
  diffWorkingTree,
  repoToplevel,
  unwatchWorkingTree,
  watchWorkingTree,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import type { SessionDiff } from "../types.ts";
// This coordinator drives both stores and both trigger it back. The cycle is
// deliberate, inert (every edge is a deferred call, nothing crosses at
// module-eval time), and unavoidable without either a landmine or dependency
// injection — see the module doc below and ADR-0020. Suppressed per-import
// rather than file-wide, so a *new* cycle in this file is still a lint error;
// the suppression sits on the closing line because that is where Biome
// reports a multi-line import's diagnostic.
import {
  type ChangesState,
  computeTotals,
  EMPTY_ENTRY,
  isMissingBaselineObjectError,
  isWorkingTreeTooLargeError,
  nextViewedState,
  scopeWantsUncommitted,
  type UncommittedChanges,
  useChanges,
  // biome-ignore lint/suspicious/noImportCycles: deliberate and inert — see above.
} from "./changes.ts";
import {
  isWorktreeSession,
  sessionWorkingDir,
  type UiSession,
  useSessions,
  // biome-ignore lint/suspicious/noImportCycles: deliberate and inert — see above.
} from "./sessions.ts";

/**
 * The [Changes refresh coordinator]: the one module that answers "how many
 * `git` runs will N triggers cost, and when do they land?"
 *
 * The policy used to be spread across the sessions store, the changes store,
 * the backend listeners and three view-layer call sites, which is how that
 * question stopped having a single answer. What lives here now: the
 * per-reason debounce-vs-immediate decision, the [Working-tree budget]
 * refusal gate, the active-session bound, the base + [Session baseline]
 * resolution (with its memoized default-branch lookup), the [Repo toplevel]
 * cache, the [Working-tree watch]'s registration, entry point and release —
 * and, since the epoch had to move with them, the fetch itself: the
 * in-flight/trailing coalescing that decides how a single `refresh` call
 * behaves, the degrade ladder that turns a pruned baseline or an over-budget
 * tree into a working-tree diff, and the `fetchedAt` stamp every derived view
 * revalidates off (see {@link refreshEpoch} and {@link useRevalidateOn}).
 *
 * The changes store still *holds* that data — `bySession` is its state — and
 * `refresh` is still the action callers dispatch through. What it no longer
 * does is decide anything about the fetch.
 *
 * ### Why this module is in an import cycle with `sessions.ts`
 *
 * The coordinator sits *above* both stores: it reads and writes each, and
 * neither owns any part of the policy. But two session-store actions have to
 * trigger a refresh from inside themselves — `applyActivity` (a completed
 * mutating tool) and `setBaseline` (a baseline landing for the first time) —
 * and `removeSession` has to cancel a pending one. So the sessions store
 * calls back into the coordinator, and the coordinator reads the sessions
 * store: a cycle no arrangement of these two modules can remove without
 * either moving those triggers out to their callers (which silently breaks
 * every other caller of those actions) or injecting the store as a parameter
 * (dependency injection introduced solely to satisfy a linter). Both were
 * judged worse than the cycle; see ADR-0020.
 *
 * The cycle is inert: nothing here runs at module-evaluation time beyond
 * building its empty caches, and every edge in both directions is a call made
 * from inside a function body long after both modules have initialized. The
 * two `noImportCycles` suppressions (one per direction) mark exactly that.
 */

/**
 * `startRefresh`'s diff-source options: `baselineOid` (present) routes through
 * the session-scoped {@link diffSessionChanges} (tree-vs-tree against the
 * session's captured baseline); its absence (or `null` — pre-feature/resumed
 * sessions, or a failed capture) falls back to the legacy
 * {@link diffWorkingTree}, which `base` still parameterizes exactly as
 * before. `baselineOid` wins whenever present, regardless of `base`.
 */
export interface RefreshOptions {
  base?: string;
  baselineOid?: string | null;
  /**
   * Called when `baselineOid` was given but no longer resolves to an object
   * in the repo (I1, round-two review) — the caller's cue to stop persisting
   * a dead oid, so the *next* refresh doesn't retry it and hit the same
   * failure forever. Only invoked when this refresh actually degrades from
   * `diffSessionChanges` to `diffWorkingTree`; never called for an ordinary
   * `baselineOid: null`/`undefined` refresh (there's nothing to invalidate)
   * or for any other `diffSessionChanges` failure (a transient git error
   * isn't evidence the oid itself is bad).
   */
  onBaselineInvalid?: () => void;
}

/** How long to hold off after an edit before refreshing the Changes view —
 * long enough to coalesce a burst of `MultiEdit`/rapid `Edit` calls from the
 * same turn into one `git diff`, short enough that "live" still feels live. */
const CHANGES_REFRESH_DEBOUNCE_MS = 500;

/** Per-session pending debounce timers for {@link scheduleChangesRefresh}. */
const changesRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Every distinct reason a session's Code Changes View gets refreshed. The one
 * thing that varies by reason is *timing*: a `live-edit` (a completed tool
 * edit during a busy turn) is debounced so a burst settles to one diff;
 * every other reason refreshes immediately. */
export type RefreshReason =
  | "baseline-landed"
  | "became-active"
  | "fs-change"
  | "live-edit"
  | "manual"
  | "saved"
  | "scope";

/**
 * Resolve and cache `sessionId`'s git repo toplevel, once per distinct
 * `cwd`. A no-op if `cwd` is empty or already claimed (resolved, still in
 * flight, or already failed) for this exact cwd via
 * the sessions store's `repoToplevelCwd` — callers (`refreshSessionChanges`,
 * invoked on every mount/became-active/manual-refresh/live-edit trigger) can
 * call this unconditionally without ever spending more than one
 * `repo_toplevel` per (session, cwd) pair. The guard is claimed
 * synchronously, before the bridge call's promise settles, so several calls
 * landing back-to-back (a mount effect racing a live-edit debounce, say)
 * still only spawn one fetch. On failure the guard is deliberately left in
 * place rather than cleared: a session whose cwd will never resolve (e.g. a
 * non-git directory) would otherwise re-spawn `repo_toplevel` on every
 * live-edit debounce tick indefinitely — one extra process per refresh,
 * forever. `repoToplevel[sessionId]` simply stays unset, which
 * `sessionTouchedRelative` (`sessions.ts`) already treats as "no badges" (fails
 * safe). A cwd change still gets a fresh attempt, since the guard is keyed
 * by cwd value, not just claimed-or-not.
 */
function ensureRepoToplevel(sessionId: string, cwd: string): void {
  if (!cwd || useSessions.getState().repoToplevelCwd[sessionId] === cwd) {
    return;
  }
  useSessions.getState().setRepoToplevel(sessionId, cwd);
  repoToplevel(cwd)
    .then((toplevel) => {
      useSessions.getState().setRepoToplevel(sessionId, cwd, toplevel);
    })
    .catch(() => {
      // Best-effort: leave `repoToplevelCwd[sessionId]` claimed for `cwd`
      // (see the doc comment above) instead of retrying.
    });
  // Start (or join) this repo's [Working-tree watch] on the same guarded
  // once-per-(session, cwd) path — the one place that already knows a session
  // has settled on a directory. Deliberately a separate call from
  // `repoToplevel` above rather than reusing the root it returns: the two
  // fail independently, and a watch that can't start (fs limits, a deleted
  // directory) must not also cost the session its touched-file badges.
  watchWorkingTree(sessionId, cwd).catch(() => {
    // Best-effort: without a watch the view still refreshes on completed
    // tool calls, becoming active, and the manual button — just not on
    // changes nothing in the hook stream accounts for.
  });
}

/** Resolved default branch per project root. The value changes about as often
 * as someone renames `main`, and it was previously re-resolved (1-3 git spawns)
 * on every single refresh. Cleared by {@link forgetDefaultBranch} so a rename
 * is one action away from being picked up rather than requiring a restart. */
const defaultBranchCache = new Map<string, string>();

/** {@link defaultBranch}, memoized per project root — see
 * {@link defaultBranchCache}. A failed lookup is not cached, so a transient
 * git failure doesn't pin the session to the base-less path. */
async function cachedDefaultBranch(projectPath: string): Promise<string> {
  const hit = defaultBranchCache.get(projectPath);
  if (hit !== undefined) {
    return hit;
  }
  const resolved = await defaultBranch(projectPath);
  defaultBranchCache.set(projectPath, resolved);
  return resolved;
}

/** Drop a memoized default branch, for when the repo's branches have moved
 * under us (a rename, a fresh clone at the same path). */
export function forgetDefaultBranch(projectPath?: string): void {
  if (projectPath === undefined) {
    defaultBranchCache.clear();
    return;
  }
  defaultBranchCache.delete(projectPath);
}

/**
 * The baseline shown in the view's header — the trust anchor of the Code
 * Changes View, so it must name the exact commit being compared against.
 * `base` omitted means the diff is against `HEAD` (uncommitted changes
 * only): always "HEAD · uncommitted", regardless of any resolved sha. A
 * `base` branch name renders as `"<base> @ <shortSha>"` when the backend
 * resolved one, degrading to just the base name when it didn't.
 */
function computeBaselineLabel(
  base: string | undefined,
  baseSha: string | null | undefined
): string {
  if (!base) {
    return "HEAD · uncommitted";
  }
  return baseSha ? `${base} @ ${baseSha}` : base;
}

/**
 * The baseline label for a baseline-anchored refresh (`diffSessionChanges`,
 * not `diffWorkingTree`) — deliberately its own function rather than a
 * `"session start"` string fed through {@link computeBaselineLabel} (M3,
 * round-two review, cheap fix). The prior code rendered this as `"session
 * start @ <shortSha>"`, reusing {@link computeBaselineLabel}'s `"<ref> @
 * <shortSha>"` shape — the same shape the legacy path uses for a COMMIT sha
 * resolved from a branch name. But `diff.baseSha` here is
 * `resolve_short_sha` run on a *tree* oid (`capture_baseline`/
 * `snapshot_tree`'s output): `git show <that sha>` gives a tree listing, not
 * a commit, so the "@ <sha>" shorthand borrows commit-ref connotation this
 * sha doesn't have. Renders as `"session start · snapshot <shortSha>"`
 * instead — still names the actual anchor for anyone who wants to `git show`
 * it, just without implying it's a commit — degrading to plain "session
 * start" when no sha resolved (mirrors {@link computeBaselineLabel}'s own
 * degrade path).
 */
function computeSessionBaselineLabel(
  baseSha: string | null | undefined
): string {
  return baseSha ? `session start · snapshot ${baseSha}` : "session start";
}

/**
 * Concurrent `refresh` calls per session, so a session already mid-fetch
 * reuses the in-flight promise instead of invoking the bridge again. Cleared
 * once the fetch (and any trailing re-run it queued — see
 * {@link trailingRefresh}) settles, success or failure, so the next call
 * starts fresh.
 */
const inFlight = new Map<string, Promise<void>>();

/**
 * Per-session "run once more when the current run settles" request, holding
 * the LATEST caller's `cwd`/`options`. A refresh arriving mid-flight can't
 * just reuse the in-flight promise: that run's `snapshot_tree` (`git add -A`)
 * already ran at its start, so its result predates whatever change triggered
 * the newer request — dropping the newer request leaves the view stale with
 * nothing left to re-arm it (the live-edit debounce is 500ms and
 * `snapshot_tree` alone can take ~0.5s on a large repo, and `FileViewer`'s
 * save→refresh would resolve against pre-save content). Overwriting rather
 * than queueing is what keeps this bounded: any number of requests arriving
 * during one run coalesce into exactly one follow-up, and that follow-up can
 * only be armed by an external {@link startRefresh} call, so the chain in
 * {@link runRefreshChain} always terminates.
 */
const trailingRefresh = new Map<
  string,
  { cwd: string; options: RefreshOptions }
>();

/**
 * One session's refresh run, plus however many trailing re-runs got armed
 * while it (or a re-run) was in flight. The `inFlight`/`trailingRefresh`
 * cleanup lives here rather than in a `.finally` on the caller's side so it
 * happens in the same synchronous turn as the "is there a trailing request?"
 * check — a `.finally` callback runs a microtask later, leaving a window in
 * which a {@link startRefresh} call would see a stale `inFlight` entry and arm
 * a trailing request nobody would ever run.
 */
async function runRefreshChain(
  sessionId: string,
  cwd: string,
  options: RefreshOptions
): Promise<void> {
  let next: { cwd: string; options: RefreshOptions } | undefined = {
    cwd,
    options,
  };
  try {
    while (next) {
      // `doRefresh` routes its own failures into the store's error state and
      // never rejects, so a failed run still gets its trailing re-run.
      // biome-ignore lint/performance/noAwaitInLoops: refreshes for one session never overlap.
      await doRefresh(sessionId, next.cwd, next.options);
      next = trailingRefresh.get(sessionId);
      trailingRefresh.delete(sessionId);
    }
  } finally {
    inFlight.delete(sessionId);
    trailingRefresh.delete(sessionId);
  }
}

/**
 * One diff fetch, from `loading` to either a landed diff (stamping the
 * {@link refreshEpoch}) or an error banner over the last good data. Owns the
 * degrade ladder: a `baselineOid` that no longer resolves, and a tree over
 * the [Working-tree budget], each fall back to the same `diffWorkingTree` a
 * session that never captured a baseline uses — the difference between them
 * being whether the caller is told to drop the oid.
 *
 * Writes the changes store directly rather than through an action: this is
 * the only writer of a `bySession` entry's fetch half, and routing it through
 * the store would put the decisions back in the module this one exists to
 * take them out of.
 */
async function doRefresh(
  sessionId: string,
  cwd: string,
  options: RefreshOptions
): Promise<void> {
  useChanges.setState((s) => {
    const prev = s.bySession[sessionId] ?? EMPTY_ENTRY;
    return {
      bySession: {
        ...s.bySession,
        [sessionId]: { ...prev, status: "loading" },
      },
    };
  });

  try {
    // Whether the diff that ends up landing below actually came from the
    // session's captured baseline — starts as "yes" whenever one was given,
    // but I1 (round-two review) can flip it back to "no" mid-flight: a
    // pruned baseline object degrades this exact refresh to the same
    // `diffWorkingTree` fallback a never-captured baseline already uses, so
    // the baseline label below must reflect what actually happened, not
    // just what was asked for.
    let anchoredToBaseline = Boolean(options.baselineOid);
    let diff: SessionDiff;
    if (options.baselineOid) {
      try {
        diff = await diffSessionChanges(cwd, options.baselineOid);
      } catch (err) {
        const tooLarge = isWorkingTreeTooLargeError(err);
        if (!(tooLarge || isMissingBaselineObjectError(err))) {
          throw err;
        }
        if (!tooLarge) {
          // The baseline was pruned out from under this session (I1): tell
          // the caller to stop persisting the now-dead oid. The over-budget
          // case deliberately skips this — see
          // `isWorkingTreeTooLargeError` for why the oid is still good.
          options.onBaselineInvalid?.();
        }
        // Either way, degrade this refresh exactly like a session that never
        // captured a baseline. `diffWorkingTree` carries the same budget, so
        // an over-budget tree comes back as a reported refusal
        // (`budgetExceeded`) with its tracked changes intact, not an error.
        anchoredToBaseline = false;
        diff = await diffWorkingTree(cwd, options.base);
      }
    } else {
      diff = await diffWorkingTree(cwd, options.base);
    }
    const prev = useChanges.getState().bySession[sessionId] ?? EMPTY_ENTRY;
    const { hunkHashes, viewed } = nextViewedState(
      diff.files,
      prev.hunkHashes,
      prev.viewed
    );
    const baselineLabel = anchoredToBaseline
      ? computeSessionBaselineLabel(diff.baseSha)
      : computeBaselineLabel(options.base, diff.baseSha);
    const uncommitted = await fetchUncommitted(
      sessionId,
      cwd,
      options.base,
      anchoredToBaseline ? undefined : diff
    );
    useChanges.setState((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: {
          ...prev,
          baselineLabel,
          diff,
          error: undefined,
          fetchedAt: Date.now(),
          hunkHashes,
          status: "ready",
          totals: computeTotals(diff),
          uncommitted,
          viewed,
        },
      },
    }));
  } catch (err) {
    const prev = useChanges.getState().bySession[sessionId] ?? EMPTY_ENTRY;
    useChanges.setState((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: {
          // `fetchedAt` is deliberately excluded here — see its doc comment.
          // Everything else (`diff`, `totals`, `baselineLabel`, `hunkHashes`,
          // `viewed`) also stays as `prev` already provides: the last good
          // data stays on screen, just now flagged stale via `error`.
          ...prev,
          // `failureMessage`: never actually strips anything on this path
          // today (the two [Command failure kind]s `diffSessionChanges` can
          // produce are both intercepted above, before a rethrow could reach
          // here) — applied anyway so this banner never regresses if a fifth
          // tagged kind is ever added upstream without a matching branch here.
          error: failureMessage(err),
          status: "error",
        },
      },
    }));
  }
}

/**
 * The All changes scope's diff for this refresh, or `undefined` when no
 * scope on screen wants it (see {@link scopeWantsUncommitted}).
 *
 * `sameAsSession` is the session diff when that diff was itself taken
 * against `base` rather than a session snapshot — then it already *is* the
 * uncommitted diff, and a second fetch would only repeat it. A failure is
 * kept on the scope (`error`) rather than failing the refresh: the session
 * diff it rode along with is fine.
 */
async function fetchUncommitted(
  sessionId: string,
  cwd: string,
  base: string | undefined,
  sameAsSession: SessionDiff | undefined
): Promise<UncommittedChanges | undefined> {
  const tab = useChanges.getState().ui[sessionId]?.tab;
  if (!scopeWantsUncommitted(tab)) {
    return;
  }
  if (sameAsSession) {
    return {
      diff: sameAsSession,
      label: computeBaselineLabel(base, sameAsSession.baseSha),
    };
  }
  const prev = useChanges.getState().bySession[sessionId]?.uncommitted;
  try {
    const diff = await diffWorkingTree(cwd, base);
    return { diff, label: computeBaselineLabel(base, diff.baseSha) };
  } catch (err) {
    return {
      diff: prev?.diff ?? null,
      error: failureMessage(err),
      label: prev?.label ?? computeBaselineLabel(base, null),
    };
  }
}

/**
 * Fetch `sessionId`'s diff, coalescing against whatever is already running
 * for it — the engine behind the changes store's `refresh` action, which is
 * how every production caller reaches it (see that action's doc comment for
 * why the dispatch stays on the store).
 *
 * A call landing mid-flight is not "already covered": the in-flight run's
 * snapshot predates this request, so it arms exactly one trailing re-run (see
 * {@link trailingRefresh}), and the promise handed back only resolves once
 * that follow-up has landed too.
 */
export function startRefresh(
  sessionId: string,
  cwd: string,
  options: RefreshOptions = {}
): Promise<void> {
  const existing = inFlight.get(sessionId);
  if (existing) {
    trailingRefresh.set(sessionId, { cwd, options });
    return existing;
  }
  const promise = runRefreshChain(sessionId, cwd, options);
  inFlight.set(sessionId, promise);
  return promise;
}

/**
 * Resolve and run one Changes-view refresh for a session: a worktree session
 * diffs against the repo's default branch (resolved from the *project* root,
 * since a worktree session's own cwd is the worktree, not the repo); a plain
 * session diffs against `HEAD`. Always threads `session.baselineOid` through
 * to `useChanges().refresh`, so every trigger — the live-edit debounce above,
 * and `ChangesView`'s own mount/became-active effect and manual refresh
 * button, which both call this directly rather than duplicating the
 * base-resolution logic — routes through the same baseline-scoped diff
 * whenever one has been captured. A no-op if the session has since been
 * removed (e.g. a debounced timer or an in-flight `defaultBranch` lookup
 * outliving the session's removal).
 *
 * Dispatches through the store's `refresh` action rather than calling
 * {@link startRefresh} — this module's own engine — directly: that action is
 * the one seam a caller can swap, and having one entry point that can be
 * observed beats two that cannot both be.
 *
 * Also threads an `onBaselineInvalid` callback into every `refresh` call
 * (I1, round-two review, BLOCKER): {@link doRefresh} invokes it only
 * when `session.baselineOid` turned out to be pruned, and this callback
 * clears it via `setBaseline(sessionId, null)` — both the store write and
 * the re-persist to the session row it triggers — so the *next* refresh
 * (whatever fires it: the live-edit debounce, the manual button, or the
 * next mount) starts from `baselineOid: null` and goes straight to the
 * `diffWorkingTree` fallback, instead of re-attempting the same dead oid and
 * hitting "bad object" again. See `setBaseline`'s doc comment for why this
 * clears rather than re-captures a fresh baseline.
 */
export async function refreshSessionChanges(sessionId: string): Promise<void> {
  const state = useSessions.getState();
  const session = state.sessions[sessionId];
  if (!session) {
    return;
  }
  const cwd = sessionWorkingDir(session);
  if (!cwd) {
    return;
  }
  // Best-effort, fire-and-forget: caches this session's repo toplevel for
  // `sessionTouchedRelative` (the touched-file attribution badge/filter).
  // Never awaited — a slow or failing lookup must not hold up the diff
  // fetch below, which is the trust-anchored part of this refresh.
  ensureRepoToplevel(sessionId, cwd);
  const onBaselineInvalid = () => {
    useSessions.getState().setBaseline(sessionId, null);
  };
  // `base` is still resolved even when a `baselineOid` exists, and deliberately
  // so: the baseline diff ignores it, but the degrade paths do not. A pruned
  // baseline or an over-budget tree falls back to `diffWorkingTree(cwd, base)`,
  // and that fallback wants the merge base, not `HEAD`. What changed is that
  // the lookup is memoized per project root instead of costing 1-3 git spawns
  // on the critical path of every single refresh.
  if (isWorktreeSession(session)) {
    const projectPath = state.projects.find(
      (p) => p.id === session.projectId
    )?.path;
    if (projectPath) {
      try {
        const base = await cachedDefaultBranch(projectPath);
        await useChanges.getState().refresh(sessionId, cwd, {
          base,
          baselineOid: session.baselineOid,
          onBaselineInvalid,
        });
        return;
      } catch {
        // Fall through to a base-less refresh, same fallback ChangesView uses
        // when the default-branch lookup fails.
      }
    }
  }
  await useChanges.getState().refresh(sessionId, cwd, {
    baselineOid: session.baselineOid,
    onBaselineInvalid,
  });
}

/**
 * The *refresh epoch* for `sessionId`: `Date.now()` of the last diff fetch
 * that actually landed for it, or `0` when none ever has. Stamped by
 * `doRefresh`'s success branch and withheld by its failure branch (see
 * `SessionChanges.fetchedAt` in `changes.ts`), so it is exactly "the moment the content
 * currently on screen was fetched" — which is what makes it the one signal
 * every derived view can revalidate off.
 *
 * A selector rather than a getter: its consumers need to *react* to a bump,
 * and it is read through `useChanges(...)` inside {@link useRevalidateOn}
 * below — the only place that reads it, and the only place that should.
 */
function refreshEpoch(
  state: ChangesState,
  sessionId: string | undefined
): number {
  if (!sessionId) {
    return 0;
  }
  return state.bySession[sessionId]?.fetchedAt ?? 0;
}

/**
 * Run `fn` every time a diff refresh genuinely lands for `sessionId` — the
 * one revalidation protocol, so the surfaces derived from a session's working
 * tree stay in step with the diff instead of each hand-rolling the same three
 * guards.
 *
 * `FileBrowserTree` (re-list the open directories) and `useFileEditorSession`
 * (re-read the open file, refetch the gutter baseline) had written that
 * protocol independently, down to identically-named refs — and the guards are
 * subtle enough that "identical" was luck, not design:
 *
 * - **Skip the first observation.** Both consumers mount long after the
 *   session's first diff landed (the All-files tab is lazy; a file is opened
 *   mid-session) and their own first fetch IS the fresh one. The epoch already
 *   sitting on the store is therefore a baseline to record, never a bump to
 *   act on.
 * - **Skip an unchanged epoch.** Any unrelated store write re-runs the effect;
 *   only a *new* landed fetch is a reason to re-read anything.
 * - **Skip epoch `0`.** That is "no fetch has ever succeeded" rather than a
 *   timestamp — there is nothing to be stale against yet. It also covers an
 *   absent `sessionId` (see {@link refreshEpoch}), which is the standalone
 *   [File viewer] with no session behind it.
 *
 * Switching `sessionId` re-baselines rather than firing: the new session's
 * epoch is its own first observation, and comparing it against the previous
 * session's would fire off nothing but the difference between two unrelated
 * clocks.
 *
 * What this deliberately does **not** own is what a revalidation costs. Each
 * consumer keeps its own staleness and throttling rules inside `fn` — the
 * tree's in-flight/pending-relist bookkeeping, the viewer's dirty-buffer and
 * baseline-refetch throttles — because those are about that surface's own
 * data, not about when the working tree changed. `fn` is always called
 * through the newest render's closure, so those refs read current.
 */
export function useRevalidateOn(
  sessionId: string | undefined,
  fn: () => void
): void {
  const epoch = useChanges((s) => refreshEpoch(s, sessionId));
  // The latest `fn`, so the effect below can stay keyed on the epoch alone
  // while still calling the closure the current render built.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seenRef = useRef<{ epoch: number; sessionId?: string } | null>(null);
  useEffect(() => {
    const seen = seenRef.current;
    seenRef.current = { epoch, sessionId };
    if (
      seen === null ||
      seen.sessionId !== sessionId ||
      seen.epoch === epoch ||
      epoch === 0
    ) {
      return;
    }
    fnRef.current();
  }, [epoch, sessionId]);
}

/**
 * Whether `sessionId` is the one the user currently has open. Deliberately
 * independent of which transcript tab is showing: the Inspector's right
 * sidebar reads a session's diff unconditionally once it's the active
 * session (see `ChangesView.tsx`'s top doc comment), so a live edit needs to
 * refresh it even while Raw — not Changes — is what's on screen.
 * Bounding this to the *active* session only (not every open session) is
 * what keeps a live-edit refresh from spending a `git diff` per open
 * session; every other open session just records the touch (see
 * `applyActivity`). Shared by the schedule-time and fire-time gate checks in
 * {@link scheduleChangesRefresh} so the two can never drift apart.
 */
function sessionIsActive(sessionId: string): boolean {
  return useSessions.getState().activeSessionId === sessionId;
}

/**
 * Debounce a live refresh after a completed edit, but only for the session
 * that's actually active right now — an inactive session just records the
 * touch (see `applyActivity`) without spending a `git diff` on a session
 * nobody has selected. Re-arms on every qualifying edit, so a burst of tool
 * calls settles to one refresh 500ms after the last one.
 *
 * The gate is re-checked when the timer actually *fires*, not just when it
 * is scheduled: the user can switch the active session during the 500ms
 * window, and a stale timer must not spend a `git diff` on a session that's
 * no longer active. Both checks go through {@link sessionIsActive} so they
 * can never drift apart.
 */
function scheduleChangesRefresh(sessionId: string): void {
  if (!sessionIsActive(sessionId)) {
    return;
  }
  const existing = changesRefreshTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
  }
  changesRefreshTimers.set(
    sessionId,
    setTimeout(() => {
      changesRefreshTimers.delete(sessionId);
      if (!sessionIsActive(sessionId)) {
        return;
      }
      // Re-check at fire time, not only at arm time: a timer armed before the
      // refusal landed would otherwise sail past {@link requestRefresh}'s gate
      // and spend one more enumeration reaching the answer we already have.
      if (refusedByWorkingTreeBudget(sessionId)) {
        return;
      }
      refreshSessionChanges(sessionId).catch(() => {
        // refreshSessionChanges already routes failures into the changes
        // store's own error state; a live-refresh attempt is best-effort and
        // must never throw into the timer callback.
      });
    }, CHANGES_REFRESH_DEBOUNCE_MS)
  );
}

/**
 * Whether a *filesystem-driven* refresh for `sessionId` would only re-derive an
 * answer already known: this session's last diff was refused by the
 * [Working-tree budget].
 *
 * An over-budget repo is precisely the one whose un-ignored directory something
 * keeps writing into, so `fs-change` and `live-edit` would fire indefinitely,
 * and each fire costs another (bounded, but real) untracked enumeration to
 * reach the same refusal. The refusal cannot change until the user gitignores
 * the directory — an act that is theirs, not the filesystem's — so the
 * user-driven reasons (`manual`, `became-active`, `saved`, `baseline-landed`)
 * deliberately still refresh. That keeps recovery one button away rather than
 * requiring the session be reopened.
 */
function refusedByWorkingTreeBudget(sessionId: string): boolean {
  const entry = useChanges.getState().bySession[sessionId];
  // `status === "ready"` is load-bearing, not defensive: a failed refresh keeps
  // the previous `diff` on screen (see `doRefresh`'s catch), so reading
  // `budgetExceeded` alone would let one unrelated failure — a spawn under fork
  // pressure, a moved repo — park the suppression permanently, long after the
  // user gitignored the directory. Only a refusal this session actually
  // observed, on its most recent successful refresh, suppresses anything.
  return entry?.status === "ready" && Boolean(entry.diff?.budgetExceeded);
}

/**
 * The single entry point for refreshing a session's Code Changes View, so the
 * debounce-vs-immediate decision lives in one place instead of being split
 * between {@link scheduleChangesRefresh}'s timer and the direct
 * `refreshSessionChanges` calls the view used to make. A `live-edit` is
 * debounced (a burst of tool calls settles to one diff); every other reason
 * refreshes now. Both paths funnel into `refreshSessionChanges`, which
 * resolves the base/baseline and hands off to {@link startRefresh}'s
 * in-flight coalescing — so "how many git diffs will N triggers cost" is
 * answered here, in one place. Fire-and-forget: a refresh failure already
 * routes into the changes store's own error state.
 */
export function requestRefresh(sessionId: string, reason: RefreshReason): void {
  if (
    (reason === "fs-change" || reason === "live-edit") &&
    refusedByWorkingTreeBudget(sessionId)
  ) {
    return;
  }
  if (reason === "live-edit") {
    scheduleChangesRefresh(sessionId);
    return;
  }
  refreshSessionChanges(sessionId).catch(() => {
    // Best-effort — failures surface via the changes store's own error state.
  });
}

/**
 * Re-run the [Session diff] for whichever session is looking at `repoRoot`,
 * in response to a [Working-tree watch] event.
 *
 * Bounded to the *active* session, exactly like {@link scheduleChangesRefresh}:
 * an inactive session's view is re-fetched when it becomes active, so spending
 * a `git diff` per open session on every filesystem change would buy nothing.
 * Several sessions can share one checkout (the watch is per repo), so this
 * matches on the cached [Repo toplevel] rather than assuming one session per
 * root.
 *
 * Refreshes immediately rather than through the `live-edit` debounce: the burst
 * has already been coalesced twice before it gets here — once by the Rust
 * watch's own debounce/max-wait, and again by `useChanges().refresh`'s
 * in-flight coalescing — so a third delay would only add latency to the signal
 * that exists to make this view feel live.
 */
export function applyWorkingTreeChange(repoRoot: string): void {
  const state = useSessions.getState();
  const activeId = state.activeSessionId;
  if (!activeId) {
    return;
  }
  if (state.repoToplevel[activeId] !== repoRoot) {
    return;
  }
  requestRefresh(activeId, "fs-change");
}

/**
 * Whether a `setBaseline` write is the moment a session gets its first
 * baseline — the only transition that has to trigger a catch-up refresh.
 *
 * `createSession` activates a new session before its fire-and-forget
 * `captureBaseline` resolves, so `ChangesView`'s rising-edge fetch runs while
 * `baselineOid` is still null and shows the legacy whole-working-tree diff —
 * i.e. the user's pre-existing uncommitted work, labelled "HEAD ·
 * uncommitted", as the first thing every new session's Changes view shows.
 * Nothing else re-fetches when the oid lands (that effect's deps are
 * `[isActiveSession, doRefresh]`, neither of which changes), so the fix is a
 * single refresh fired here.
 *
 * Narrow on purpose, in three ways:
 * - `previous` must exist and have had a null `baselineOid`: a hydrated or
 *   resumed session already carries its oid when `ChangesView` mounts, so
 *   re-refreshing there would just double-fetch; an unknown session isn't
 *   written at all.
 * - `oid` must be non-null: `onBaselineInvalid` clears a pruned baseline via
 *   `setBaseline(id, null)` from *inside* a refresh, and re-refreshing on
 *   that would spin.
 * - the session must have a working directory, since a refresh without one
 *   is a no-op anyway.
 */
function baselineJustLanded(
  previous: UiSession | undefined,
  oid: string | null
): boolean {
  return (
    oid !== null &&
    previous !== undefined &&
    previous.baselineOid === null &&
    sessionWorkingDir(previous) !== ""
  );
}

/**
 * Refresh `sessionId` if the `setBaseline` write it just took is the one that
 * gave it its first baseline — see {@link baselineJustLanded} for why that is
 * the only transition worth a catch-up fetch. Called by the sessions store
 * right after the write, with the session as it was *before* it.
 */
export function refreshOnBaselineLanded(
  sessionId: string,
  previous: UiSession | undefined,
  oid: string | null
): void {
  if (baselineJustLanded(previous, oid)) {
    requestRefresh(sessionId, "baseline-landed");
  }
}

/**
 * Release everything this module holds for a session that just closed: a
 * pending live-edit debounce (so a timer armed moments before it went away
 * can't fire against a session that no longer exists) and its hold on the
 * repo's [Working-tree watch]. The watch is refcounted per repo root on the
 * Rust side, so releasing only stops a watch when the last session in that
 * checkout goes away. Called from `removeSession`; a no-op for an id that
 * has neither.
 */
export function forgetSessionRefresh(sessionId: string): void {
  const pending = changesRefreshTimers.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    changesRefreshTimers.delete(sessionId);
  }
  unwatchWorkingTree(sessionId).catch(() => {
    // Best-effort teardown: a failed release leaks one watch until quit,
    // which must never be allowed to break closing a session.
  });
}
