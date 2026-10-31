import type {
  DiffTotals,
  FileChange,
  FileDiff,
  SessionDiff,
} from "../types.ts";
import {
  type ChangesState,
  computeTotalsFromFiles,
  type EditState,
  type FileTreeTab,
  type SessionChanges,
  type SessionChangesUi,
  visibleFiles,
} from "./changes.ts";

/**
 * The [Changes view model]: the single resolved answer for "what should the
 * Code Changes View render for this session right now".
 *
 * `ChangesView` used to ask that question thirteen times — one narrow store
 * selector per fact, plus seven derivations inlined into the component — which
 * meant the rules relating those facts (a filter that only bites on one tab,
 * an empty state that must not contradict the budget notice, a header whose
 * totals must describe exactly the files below it) lived in the render body
 * and could only be tested by mounting the whole subtree. They live here now,
 * pure, and the component reads one value.
 */

/**
 * What the diff column is actually showing. Deliberately *one* answer rather
 * than the five overlapping booleans the render body used to juggle: exactly
 * one of these is true at a time, which is what makes "the empty state must
 * never print under the budget notice" a fact the type can hold instead of a
 * comment.
 *
 * Six, not the five the spec sketched: `"error"` is the state a session in a
 * non-git directory sits in — the *first* fetch failed, so there is no diff to
 * fall back to and no loading notice either (the banner above the column
 * already says what happened). Collapsing it into `"loading"` would print
 * "Loading changes…" forever under an error that will never resolve itself.
 *
 * Mounting is a separate question from showing: `DiffFeed` and `FileViewer`
 * stay mounted and display-toggled across a flip (the pane keep-alive rule),
 * so {@link ChangesViewModel.feedMounted} and a non-`undefined`
 * {@link ChangesViewModel.selectedFile} can both be true while `pane` names
 * only one of them.
 */
export type ChangesPane =
  | "budget"
  | "empty"
  | "error"
  | "feed"
  | "loading"
  | "viewer";

/** Everything the [Changes view model] is derived from. Flat and
 * store-shape-independent on purpose: {@link computeChangesView} is then a
 * plain function of its arguments, and {@link changesView} is the only thing
 * that has to know where each field lives in the store. */
export interface ChangesViewInput {
  /** The session's working directory — what `FileViewer`'s `readFile`
   * resolves a path against, and one half of {@link cwdRelativePath}. */
  cwd: string;
  /** The cwd-relative path currently dirty in this session's open [File
   * editor], or `null`/absent when nothing is. */
  dirtyPath: string | null | undefined;
  /** Path → [File draft] stashed when a dirty pane was unmounted. */
  drafts: Record<string, EditState> | undefined;
  entry: SessionChanges | undefined;
  /** The *stored* "My edits only" flag — see
   * {@link ChangesViewModel.editsFilterActive} for whether it actually bites. */
  myEditsOnly: boolean;
  pendingJump: string | undefined;
  /** This session's cached [Repo toplevel], or `""` when none resolved yet. */
  repoToplevel: string;
  selectedFile: string | undefined;
  tab: FileTreeTab;
  /** This session's [Touched files], relativized — see
   * `sessionTouchedRelative` in `state/sessions.ts`. */
  touchedRelative: Set<string>;
}

/** One session's resolved Code Changes View — see the module doc. */
export interface ChangesViewModel {
  /** What the [Summary bar] says the active scope is measured against —
   * the session start for AI changes, HEAD (or the base branch) for All
   * changes. */
  baselineLabel: string;
  /** The All-files tree's git marks — see {@link TreeDecorations}. Built
   * from the unfiltered `files`: that tab ignores the filter. */
  decorations: TreeDecorations;
  /** `BudgetNotice`'s input: the raw diff, budget fields and all. */
  diff: SessionDiff | null;
  /** The toplevel-relative paths of `displayFiles` rows carrying unsaved
   * edits (live or stashed) — the Changes tab's dirty dots. */
  dirtyPaths: Set<string>;
  /** {@link ChangesViewModel.files} narrowed by the "My edits only" filter —
   * the list the tree, the feed and the jump rail all render. Identical by
   * reference to `files` whenever the filter isn't biting. */
  displayFiles: FileDiff[];
  /** Whether the "My edits only" filter is in effect, as opposed to merely
   * stored. Its switch only renders on the Changes tab (`FileBrowserTree`
   * ignores the filter, so the control would do nothing on All files), and a
   * filter the user can neither see nor clear must not be silently narrowing
   * that tab either — with the filter on and every file hidden, All files
   * otherwise reads "No files touched by this session." beside a switch that
   * isn't there. The stored flag is deliberately left alone, so flipping back
   * to Changes restores the filter exactly as the user left it. */
  editsFilterActive: boolean;
  /** What the `"empty"` pane says. Two different facts wear the same empty
   * feed: nothing changed at all, versus changes exist but the filter hid
   * every one of them. */
  emptyMessage: string;
  /** The error banner's text, or `undefined` when the last fetch was fine.
   * Independent of `pane`: a failed refresh keeps the previous diff on screen
   * (`pane: "feed"`) with the banner above it. */
  error: string | undefined;
  /** Whether `DiffFeed` should be in the DOM at all. Distinct from
   * `pane === "feed"`: with the viewer showing, the feed stays mounted and
   * hidden so its virtualizer keeps its scroll position. */
  feedMounted: boolean;
  /** The diff's [Visible files] — noise-filtered, never filter-narrowed.
   * What a file-viewer lookup reads from, so toggling the filter can't hide a
   * file already open. */
  files: FileDiff[];
  /** A diff having landed (even to zero files) is distinct from a session
   * that has never fetched one. */
  loadedOnce: boolean;
  /** The stored filter flag, for the switch's own checked state. */
  myEditsOnly: boolean;
  pane: ChangesPane;
  pendingJump: string | undefined;
  selectedFile: string | undefined;
  /** The `FileDiff` behind `selectedFile`, when the open file is one of this
   * diff's files — the changed-line gutter's input. `undefined` for a file
   * opened from the All-files browser that the diff doesn't mention. */
  selectedFileDiff: FileDiff | undefined;
  /** Whether to render the "My edits only" switch — see
   * {@link ChangesViewModel.editsFilterActive} for why it is Changes-tab only,
   * and there is nothing to filter before a diff has ever loaded. */
  showEditsToggle: boolean;
  /** Whether `FileViewer` is the thing on screen — not merely whether a file
   * is selected (`selectedFile` deliberately survives a tab flip). */
  showViewer: boolean;
  tab: FileTreeTab;
  /** The totals the [Summary bar] prints: the store's whole-diff totals
   * normally, recomputed over `displayFiles` while the filter bites. The
   * invariant this field exists to hold is `totals.files ===
   * displayFiles.length` — a header claiming "12 files changed" over a feed
   * showing 3 is the discrepancy it was split across two components to
   * avoid. `null` until a diff has landed, so the bar shows its neutral
   * placeholder rather than a confident zero. */
  totals: DiffTotals | null;
}

/** `path` without a trailing slash, so `/repo` and `/repo/` compare equal
 * and joining never produces a doubled separator. */
function withoutTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** macOS firmlinks `/tmp`, `/var` and `/etc` into `/private`, so one
 * directory has two equally-real spellings — and the two operands below
 * reliably disagree about which to use: `repo_toplevel` is git's
 * `rev-parse --show-toplevel`, which canonicalizes, while the session cwd is
 * whatever raw path the project row carries. Anchored, and with the boundary
 * asserted, so `/private/variables` and `/private/mine` (ordinary
 * directories, not firmlink twins) are left alone. */
const MACOS_FIRMLINK_PREFIX = /^\/private(?=\/(?:etc|tmp|var)(?:\/|$))/;

/** One spelling per directory, so the prefix arithmetic in
 * {@link cwdRelativePath} compares like with like. Collapses toward the short
 * form, which makes it direction-agnostic: either operand may be the
 * canonicalized one. */
function canonicalDir(path: string): string {
  return withoutTrailingSlash(path).replace(MACOS_FIRMLINK_PREFIX, "");
}

/**
 * One diff/tree path (repo-**toplevel**-relative, because it is git's own
 * output) expressed relative to `cwd` — which is what `FileViewer`'s
 * `readFile(cwd, path)` actually resolves against.
 *
 * The two coincide for a session opened at the repo root, which is why the
 * mismatch went unnoticed: for a session whose cwd is a repo *subdirectory*,
 * "Edit" handed the viewer `app/src/a.ts` under cwd `/repo/app` and it opened
 * "path does not exist".
 *
 * String-prefix math rather than a real path library (the frontend has none,
 * and both operands come from the same Rust side — `sessionWorkingDir` and
 * `repo_toplevel`'s `git rev-parse --show-toplevel`). Three outcomes:
 *
 * - The file is inside `cwd` → the trimmed, cwd-relative path.
 * - The file is elsewhere in the repo → the honest `../…` form. The backend
 *   sandbox refuses anything that leaves `cwd` (`SandboxRoot::resolve`), so this
 *   surfaces in `FileViewer`'s existing error banner — which beats silently
 *   opening some other file, or dropping the click with no feedback.
 * - Nothing to compute (no cached toplevel yet, cwd *is* the toplevel, or
 *   the two don't share a prefix at all — e.g. a symlinked worktree path the
 *   two backends spell differently) → `path` unchanged.
 *
 * The one spelling difference that is *not* left to that last fallback is
 * macOS's `/private` firmlinks — see {@link canonicalDir}. It is not an
 * exotic case: git canonicalizes the toplevel and the session cwd doesn't,
 * so every session under `/tmp` or `/var` hit it, and the honest-looking
 * fallback quietly became "Edit opens the wrong path".
 */
export function cwdRelativePath(
  path: string,
  toplevel: string,
  cwd: string
): string {
  const root = canonicalDir(toplevel);
  const dir = canonicalDir(cwd);
  if (!root || root === dir) {
    return path;
  }
  const absolute = `${root}/${path}`;
  if (absolute.startsWith(`${dir}/`)) {
    return absolute.slice(dir.length + 1);
  }
  if (dir.startsWith(`${root}/`)) {
    const depth = dir.slice(root.length + 1).split("/").length;
    return `${"../".repeat(depth)}${path}`;
  }
  return path;
}

/**
 * The All-files tree's git marks: how each changed file changed, and which
 * folders hold a change somewhere below them — the colouring every code
 * editor's explorer gives a working tree.
 *
 * Keyed in the tree's own vocabulary (cwd-relative), not the diff's
 * (toplevel-relative). A change outside the session's folder has no row in
 * that tree, so it is dropped rather than keyed by a `../` path nothing
 * looks up.
 */
export interface TreeDecorations {
  dirs: ReadonlySet<string>;
  files: ReadonlyMap<string, FileChange>;
}

const treeDecorationsCache = new WeakMap<
  FileDiff[],
  { cwd: string; result: TreeDecorations; toplevel: string }
>();

/** {@link TreeDecorations} for `files`, memoized on the array and the two
 * paths it is translated between, so the tree re-renders only when a refresh
 * actually lands. */
export function treeDecorations(
  files: FileDiff[],
  toplevel: string,
  cwd: string
): TreeDecorations {
  const hit = treeDecorationsCache.get(files);
  if (hit && hit.cwd === cwd && hit.toplevel === toplevel) {
    return hit.result;
  }
  const marks = new Map<string, FileChange>();
  const dirs = new Set<string>();
  for (const f of files) {
    const path = cwdRelativePath(f.path, toplevel, cwd);
    if (path.startsWith("../")) {
      continue;
    }
    marks.set(path, f.status);
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const dir = path.slice(0, slash);
      if (dirs.has(dir)) {
        break;
      }
      dirs.add(dir);
      slash = dir.lastIndexOf("/");
    }
  }
  const result: TreeDecorations = { dirs, files: marks };
  treeDecorationsCache.set(files, { cwd, result, toplevel });
  return result;
}

/** Stable empty list for a session with no diff yet, so "no files" is one
 * array identity rather than a fresh `[]` per call. */
const NO_FILES: FileDiff[] = [];

/**
 * [Visible files], memoized on the diff's own identity (mirroring `sumUsage`'s
 * cache in `state/usage.ts`). The identity, not just the cost, is the point:
 * `DiffFeed` treats a new `files` array as "a refresh landed" and restores the
 * virtualizer's scroll offset for it, so re-deriving the list on an unrelated
 * store write — consuming a pending jump, say — would drag the feed back to
 * where it was before the jump. A refresh and the "My edits only" filter are
 * the only two things that may hand the feed a new array, and this keeps it
 * that way. Keyed weakly, so a dropped diff's entry goes with it.
 */
const visibleFilesCache = new WeakMap<SessionDiff, FileDiff[]>();

function memoVisibleFiles(diff: SessionDiff | null | undefined): FileDiff[] {
  if (!diff) {
    return NO_FILES;
  }
  const hit = visibleFilesCache.get(diff);
  if (hit) {
    return hit;
  }
  const files = visibleFiles(diff);
  visibleFilesCache.set(diff, files);
  return files;
}

/** The "My edits only" subset of one `files` array, memoized on that array
 * plus the touched set it was intersected against — the second half of the
 * identity contract {@link visibleFilesCache} exists for, since `displayFiles`
 * (not `files`) is what `DiffFeed` actually receives. */
const filteredFilesCache = new WeakMap<
  FileDiff[],
  { result: FileDiff[]; touched: Set<string> }
>();

function memoFilteredFiles(
  files: FileDiff[],
  touched: Set<string>
): FileDiff[] {
  // Filtering nothing yields the same nothing — and short-circuiting keeps
  // the shared {@link NO_FILES} out of the cache, where several sessions
  // would otherwise evict each other's entry for it.
  if (files.length === 0) {
    return files;
  }
  const hit = filteredFilesCache.get(files);
  if (hit && hit.touched === touched) {
    return hit.result;
  }
  const result = files.filter((f) => touched.has(f.path));
  filteredFilesCache.set(files, { result, touched });
  return result;
}

/** Which rows of `displayFiles` carry unsaved edits. Diff rows are
 * toplevel-relative and both dirty sources are cwd-relative (that is the
 * vocabulary the [File editor] publishes), so the translation has to happen
 * somewhere — and this is the one place holding both `cwd` and the toplevel. */
function computeDirtyPaths(
  displayFiles: FileDiff[],
  input: ChangesViewInput
): Set<string> {
  const marked = new Set<string>();
  const { cwd, dirtyPath, drafts, repoToplevel } = input;
  if (!(dirtyPath || drafts)) {
    return marked;
  }
  for (const f of displayFiles) {
    const relative = cwdRelativePath(f.path, repoToplevel, cwd);
    if (relative === dirtyPath || drafts?.[relative]) {
      marked.add(f.path);
    }
  }
  return marked;
}

/** Which single thing the diff column shows — see {@link ChangesPane}. The
 * order is the whole rule: the viewer covers the column outright, a loaded
 * diff with files beats every notice, and an over-budget refusal answers
 * "why is this empty" better than the empty state can. */
function computePane(params: {
  hasError: boolean;
  isEmpty: boolean;
  loadedOnce: boolean;
  overBudget: boolean;
  showViewer: boolean;
}): ChangesPane {
  const { hasError, isEmpty, loadedOnce, overBudget, showViewer } = params;
  if (showViewer) {
    return "viewer";
  }
  if (loadedOnce && !isEmpty) {
    return "feed";
  }
  if (isEmpty) {
    return overBudget ? "budget" : "empty";
  }
  return hasError ? "error" : "loading";
}

/** The [Changes view model], as a plain function of its inputs — the whole
 * decision surface, with no store and no React in it. {@link changesView} is
 * the memoized store-reading wrapper every consumer actually calls. */
export function computeChangesView(input: ChangesViewInput): ChangesViewModel {
  const { entry, myEditsOnly, selectedFile, tab } = input;
  const showViewer = tab === "all" && Boolean(selectedFile);
  const editsFilterActive = myEditsOnly && tab === "changes";
  // Both memoized on their inputs' identity rather than rebuilt per call —
  // `DiffFeed` reads a new `files` array as "a refresh landed". See
  // {@link visibleFilesCache}.
  const files = memoVisibleFiles(entry?.diff);
  const uncommitted = entry?.uncommitted;
  const uncommittedFiles = uncommitted?.diff
    ? memoVisibleFiles(uncommitted.diff)
    : undefined;
  const scope = scopeOf(input, files, uncommittedFiles, editsFilterActive);
  const { displayFiles, scopeLoaded } = scope;
  const loadedOnce = entry !== undefined && entry.diff !== null;
  const isEmpty = scopeLoaded && displayFiles.length === 0;
  return {
    baselineLabel: scope.label,
    decorations: treeDecorations(
      uncommittedFiles ?? files,
      input.repoToplevel,
      input.cwd
    ),
    diff: scope.diff,
    displayFiles,
    dirtyPaths: computeDirtyPaths(displayFiles, input),
    editsFilterActive,
    emptyMessage: scope.emptyMessage(files.length > 0 && isEmpty),
    error: scope.error,
    feedMounted: scopeLoaded && !isEmpty,
    files,
    loadedOnce,
    myEditsOnly,
    pane: computePane({
      hasError: Boolean(scope.error),
      isEmpty,
      loadedOnce: scopeLoaded,
      overBudget: Boolean(scope.diff?.budgetExceeded),
      showViewer,
    }),
    pendingJump: input.pendingJump,
    selectedFile,
    selectedFileDiff: selectedFile
      ? (files.find((f) => f.path === selectedFile) ??
        uncommittedFiles?.find((f) => f.path === selectedFile))
      : undefined,
    showEditsToggle: tab === "changes" && loadedOnce,
    showViewer,
    tab,
    totals: scope.totals,
  };
}

/** What the diff column lists for the active scope — see {@link scopeOf}. */
interface Scope {
  diff: SessionDiff | null;
  displayFiles: FileDiff[];
  emptyMessage: (hiddenByFilter: boolean) => string;
  error: string | undefined;
  label: string;
  scopeLoaded: boolean;
  totals: DiffTotals | null;
}

/**
 * The diff the active scope lists. All changes reads the uncommitted diff;
 * AI changes and Files read the session diff (Files only shows it once the
 * user goes back to a diff tab, but its pane rules are the session's). Kept
 * apart from {@link computeChangesView} so each scope's rules read on their
 * own, and the view stays within the complexity budget.
 */
function scopeOf(
  input: ChangesViewInput,
  files: FileDiff[],
  uncommittedFiles: FileDiff[] | undefined,
  editsFilterActive: boolean
): Scope {
  const { entry } = input;
  if (input.tab === "uncommitted") {
    const uncommitted = entry?.uncommitted;
    const shown = uncommittedFiles ?? NO_FILES;
    return {
      diff: uncommitted?.diff ?? null,
      displayFiles: shown,
      emptyMessage: () => "No uncommitted changes.",
      error: uncommitted?.error,
      label: uncommitted?.label ?? "",
      scopeLoaded: uncommittedFiles !== undefined,
      totals: uncommittedFiles ? computeTotalsFromFiles(shown) : null,
    };
  }
  const displayFiles = editsFilterActive
    ? memoFilteredFiles(files, input.touchedRelative)
    : files;
  const hasError = entry?.status === "error" && Boolean(entry.error);
  return {
    diff: entry?.diff ?? null,
    displayFiles,
    // "Changes exist, the filter hid every one of them" must not read as
    // "nothing changed" — the baseline-scoped message would be a lie.
    emptyMessage: (hiddenByFilter) =>
      editsFilterActive && hiddenByFilter
        ? "No files touched by this session."
        : `No changes vs ${entry?.baselineLabel}.`,
    error: hasError ? entry?.error : undefined,
    label: entry?.baselineLabel ?? "",
    scopeLoaded: entry !== undefined && entry.diff !== null,
    totals: editsFilterActive
      ? computeTotalsFromFiles(displayFiles)
      : (entry?.totals ?? null),
  };
}

/**
 * The slices of the changes store the [Changes view model] reads. A `Pick` of
 * the real state rather than a hand-copied shape, so a renamed slice is a
 * compile error here instead of a silent `undefined`.
 */
export type ChangesViewState = Pick<
  ChangesState,
  "bySession" | "dirtyFiles" | "fileDrafts" | "ui"
>;

/** The cross-store facts the view model needs that the changes store doesn't
 * hold — all three come from the sessions store, and all three are stable
 * across an unrelated render (`sessionTouchedRelative` returns the same `Set`
 * instance until it genuinely changes). */
export interface ChangesViewDeps {
  cwd: string;
  repoToplevel: string;
  touchedRelative: Set<string>;
}

/**
 * Everything {@link changesView} keys its memo on, flattened so the
 * comparison below is a field-by-field `Object.is` and nothing else. The
 * `entry` is deliberately *not* here as one reference: the diff feed writes
 * `viewed` flags into it as the user scrolls, and this view reads none of
 * them, so keying on the whole entry would re-render the view on every
 * card the user scrolls past.
 */
interface ChangesViewKey {
  baselineLabel: string | undefined;
  cwd: string;
  diff: SessionDiff | null | undefined;
  dirtyPath: string | null | undefined;
  drafts: Record<string, EditState> | undefined;
  error: string | undefined;
  repoToplevel: string;
  status: SessionChanges["status"] | undefined;
  totals: DiffTotals | null | undefined;
  touchedRelative: Set<string>;
  /** One reference for the tab, the selection, the filter and the pending
   * jump: every field of `SessionChangesUi` is an input to this view, so the
   * store keeps them in one object that changes exactly when this view has to
   * be recomputed. */
  ui: SessionChangesUi | undefined;
  uncommitted: SessionChanges["uncommitted"];
}

function sameKey(a: ChangesViewKey, b: ChangesViewKey): boolean {
  return (
    a.baselineLabel === b.baselineLabel &&
    a.cwd === b.cwd &&
    a.diff === b.diff &&
    a.dirtyPath === b.dirtyPath &&
    a.drafts === b.drafts &&
    a.error === b.error &&
    a.repoToplevel === b.repoToplevel &&
    a.status === b.status &&
    a.totals === b.totals &&
    a.touchedRelative === b.touchedRelative &&
    a.ui === b.ui &&
    a.uncommitted === b.uncommitted
  );
}

/**
 * One memo per session — the reason this selector can be read through
 * `useChanges(...)` on every store tick without re-rendering anything.
 *
 * zustand compares a selector's *output*, so returning the identical object
 * for identical inputs is what buys the churn parity: a scroll writes
 * `activeFile` and `viewed` on every card boundary crossed, none of which
 * this view reads, and each of those ticks re-runs this selector and hits the
 * cache in O(1). Keyed by session id rather than weakly, because there is no
 * single input object that outlives every recompute — {@link
 * forgetChangesView} is how an entry is released, and `ChangesView` calls it
 * on unmount so a closed session's diff isn't retained here after
 * `dropSession` drops it from the store.
 *
 * One slot per session id is also the constraint on who may call this: two
 * consumers passing *different* `deps` for the same session would evict each
 * other on every call and degrade to a permanent cache miss. `ChangesView` is
 * the only caller today, and the Inspector — which renders the same session's
 * filtered file list from its own derivations — is exactly the second one that
 * would hit this. Adding it means keying the memo by (session, consumer), or
 * agreeing on one `deps` between them; it is not a drop-in second `useChanges`
 * call. Note the arrays inside the view are safe to share either way: they are
 * memoized on their own inputs (see {@link visibleFilesCache}), not on this
 * slot.
 */
const memo = new Map<string, { key: ChangesViewKey; view: ChangesViewModel }>();

/** Release `sessionId`'s memo — see {@link memo}. */
export function forgetChangesView(sessionId: string): void {
  memo.delete(sessionId);
}

/**
 * How many files the [Changes view] would show for `sessionId` right now —
 * the number the transcript header's **Changes** tab prints.
 *
 * It answers the same question {@link ChangesViewModel.totals}`.files` does
 * and by the same rule, because the tab sits in the same header as the
 * [Summary bar]: a tab reading "Changes 12" over a bar reading "3 files" is
 * exactly the discrepancy the view model was extracted to prevent. Reading
 * the store's whole-diff `totals` directly, as the header used to, skipped
 * that rule and contradicted the bar whenever **My edits only** bit.
 *
 * Deliberately *not* a second {@link changesView} call: that memo holds one
 * slot per session, so a second consumer passing different `deps` would evict
 * the first on every call. This needs no slot — it returns a number, which
 * zustand compares by value, and the only work it does is already memoized on
 * its own inputs ({@link visibleFilesCache}, {@link filteredFilesCache}),
 * which the view model's arrays are safe to share.
 */
export function changedFileCount(
  state: ChangesViewState,
  sessionId: string,
  touchedRelative: Set<string>
): number {
  const entry = state.bySession[sessionId];
  const ui = state.ui[sessionId];
  const editsFilterActive =
    (ui?.myEditsOnly ?? false) && (ui?.tab ?? "changes") === "changes";
  if (!editsFilterActive) {
    return entry?.totals?.files ?? 0;
  }
  const files = memoFilteredFiles(
    memoVisibleFiles(entry?.diff),
    touchedRelative
  );
  return files.length;
}

/**
 * `sessionId`'s [Changes view model], read off the changes store and memoized
 * on exactly the inputs it uses (see {@link memo}). The one call `ChangesView`
 * makes in place of thirteen selectors.
 */
export function changesView(
  state: ChangesViewState,
  sessionId: string,
  deps: ChangesViewDeps
): ChangesViewModel {
  const entry = state.bySession[sessionId];
  const ui = state.ui[sessionId];
  const input: ChangesViewInput = {
    cwd: deps.cwd,
    dirtyPath: state.dirtyFiles[sessionId],
    drafts: state.fileDrafts[sessionId],
    entry,
    myEditsOnly: ui?.myEditsOnly ?? false,
    pendingJump: ui?.pendingJump,
    repoToplevel: deps.repoToplevel,
    selectedFile: ui?.selectedFile,
    tab: ui?.tab ?? "changes",
    touchedRelative: deps.touchedRelative,
  };
  const key: ChangesViewKey = {
    baselineLabel: entry?.baselineLabel,
    cwd: input.cwd,
    diff: entry?.diff,
    dirtyPath: input.dirtyPath,
    drafts: input.drafts,
    error: entry?.error,
    repoToplevel: input.repoToplevel,
    status: entry?.status,
    totals: entry?.totals,
    touchedRelative: input.touchedRelative,
    ui,
    uncommitted: entry?.uncommitted,
  };
  const cached = memo.get(sessionId);
  if (cached && sameKey(cached.key, key)) {
    return cached.view;
  }
  const view = computeChangesView(input);
  memo.set(sessionId, { key, view });
  return view;
}
