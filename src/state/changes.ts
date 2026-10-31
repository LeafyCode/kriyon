import { create } from "zustand";
import { commandFailure } from "../ipc/failures.ts";
import type { DiffTotals, FileDiff, SessionDiff } from "../types.ts";
// This store holds the data the [Changes refresh coordinator] fetches, and
// dispatches into it through the `refresh` action below. See
// `changesRefresh.ts`'s module doc and ADR-0020 for why that cycle is
// deliberate and inert.
// biome-ignore lint/suspicious/noImportCycles: deliberate and inert — see above.
import { type RefreshOptions, startRefresh } from "./changesRefresh.ts";

/** How a session's diff fetch is currently doing. */
export type ChangesFetchStatus = "error" | "idle" | "loading" | "ready";

/** One session's Code Changes View state. */
export interface SessionChanges {
  /** The exact comparison point, for the summary bar's tooltip:
   * `session start · snapshot ac1741c`, `HEAD · uncommitted`, `main @ 1a2b`. */
  baselineLabel: string;
  /** File path → user-toggled collapse; preserved across `refresh`. */
  collapsed: Record<string, boolean>;
  /** The same comparison in plain words, for the summary bar itself:
   * `since session start`, `vs last commit`, `vs main`. */
  comparedTo?: string;
  diff: SessionDiff | null;
  error?: string;
  /** `Date.now()` of the last *successful* fetch — `0` if one has never
   * landed. Written only by the [Changes refresh coordinator]'s `doRefresh`,
   * and read back through its `refreshEpoch`/`useRevalidateOn` (the two
   * surfaces that revalidate off it). A failed refresh deliberately
   * leaves this untouched: it drives the "updated Xs ago" staleness hint in
   * `SummaryBar` (and the freshness gate in `ChangedFilesChip`), and both
   * need it to answer "how old is what's actually on screen right now",
   * not "when did we last try". Stamping it on failure too would make a
   * failed refresh simultaneously report "just updated" (via this field)
   * and "the refresh failed" (via `error`) — two contradictory signals for
   * content that's actually still stale. */
  fetchedAt: number;
  /** File path → hash of that file's hunk content as of the last refresh
   * (see {@link hashHunks}). Carried alongside `viewed` purely to decide,
   * on the *next* refresh, whether a path's `viewed` flag survives — never
   * read for anything else. */
  hunkHashes: Record<string, string>;
  status: ChangesFetchStatus;
  totals: DiffTotals | null;
  /** The All changes scope's diff, fetched only while a scope wants it (see
   * {@link scopeWantsUncommitted}); absent until then. */
  uncommitted?: UncommittedChanges;
  /** File path → the jump rail's "already looked at" flag (Task 10). Set by
   * `markViewed` when a file's card intersects the viewport; reset by
   * `refresh` only for a path whose hunk content actually changed (compared
   * via `hunkHashes`), so a refresh that leaves a file untouched doesn't
   * wipe the user's progress through the diff. */
  viewed: Record<string, boolean>;
}

/** A session's entry before anything has been fetched for it — the `?? `
 * fallback every reader of `bySession[id]` uses, the [Changes refresh
 * coordinator]'s `doRefresh` included, so a first refresh starts from the
 * same shape a later one carries forward. */
export const EMPTY_ENTRY: SessionChanges = {
  baselineLabel: "",
  collapsed: {},
  diff: null,
  fetchedAt: 0,
  hunkHashes: {},
  status: "idle",
  totals: null,
  viewed: {},
};

/** Stable empty-object fallback: an inline `?? {}` would return a fresh
 * reference on every selector call, which zustand's `useSyncExternalStore`
 * integration sees as "always changed" and re-renders forever. */
export const EMPTY_COLLAPSED: Record<string, boolean> = {};

/** Stable empty-object fallback for `viewed`, mirroring {@link EMPTY_COLLAPSED}. */
export const EMPTY_VIEWED: Record<string, boolean> = {};

/** Stable empty-object fallback for a session's `expandedDirs` entry,
 * mirroring {@link EMPTY_COLLAPSED} — read via `expandedDirs[sessionId] ??
 * EMPTY_EXPANDED_DIRS` so an unexpanded session's tree doesn't re-render
 * forever off a fresh `?? {}`. */
export const EMPTY_EXPANDED_DIRS: Record<string, boolean> = {};

/**
 * Whether the AI changes tab keeps to the files Claude changed — on unless
 * the user turned it off. The record behind it is the [Activity log]
 * (edits, writes and the files a command changed, subagents included), so it
 * is trusted by default; the user's own edits are under All changes. See ADR
 * 0050, which supersedes ADR 0015's default-off.
 */
export function myEditsOnlyOf(ui: SessionChangesUi | undefined): boolean {
  return ui?.myEditsOnly ?? true;
}

/**
 * Which scope the Files view's left column is showing:
 * - `"changes"` — **AI changes**: what changed since the session started
 *   (the [Session diff]), with the optional "only Claude's files" filter.
 * - `"uncommitted"` — **All changes**: everything not yet committed (or, in
 *   a worktree, not yet on the default branch), whoever made it — what an
 *   editor's git panel shows.
 * - `"all"` — **Files**: the whole tree.
 */
export type FileTreeTab = "all" | "changes" | "uncommitted";

/** Whether `tab` needs the uncommitted diff: All changes lists it, and Files
 * colours the tree from it. AI changes doesn't, so a session sitting there
 * pays for one diff per refresh, not two. */
export function scopeWantsUncommitted(tab: FileTreeTab | undefined): boolean {
  return tab === "uncommitted" || tab === "all";
}

/** The All changes scope's diff — everything uncommitted — kept beside the
 * session diff rather than in place of it, so the Inspector and the header
 * count keep meaning "this session". */
export interface UncommittedChanges {
  /** Plain words, like {@link SessionChanges.comparedTo}. */
  comparedTo?: string;
  diff: SessionDiff | null;
  /** Why the last fetch failed, over whatever `diff` still holds. */
  error?: string;
  /** The summary bar's label for it, e.g. `uncommitted · vs HEAD`. */
  label: string;
}

/** A file's `(mtime, len)` signature at the moment it was last read from
 * disk — what `writeFile`'s [Save conflict guard] compares against. Adopted
 * fresh from every successful `readFile`/`writeFile` response. */
export interface Signature {
  len: number;
  mtime: number;
}

/** Which line ending the file this draft came from uses on disk. The editor
 * itself only ever holds `"\n"` — CodeMirror splits a document on
 * `/\r\n?|\n/` and keeps no `\r`, so a CRLF file cannot be represented in the
 * buffer at all — which makes this the memory of what to put back on save.
 * See {@link EditState.eol}. */
export type Eol = "crlf" | "lf";

/** A [File draft]: the editable half of a [File viewer] session, only present
 * for a faithfully-read text load (non-binary, non-truncated, non-lossy).
 * `baseline` is the last known-good on-disk content (what `draft` is diffed
 * against to compute dirty); `sig` is the signature that specific `baseline`
 * was read at, so `Save` always sends the conflict guard the read-time
 * signature, never a stale or guessed one. Lives here rather than only in the
 * `FileViewer` so an unsaved draft survives the pane being unmounted — see
 * {@link ChangesState.fileDrafts}. */
export interface EditState {
  /** LF-normalized, always — see {@link EditState.eol}. */
  baseline: string;
  /** LF-normalized, always — see {@link EditState.eol}. */
  draft: string;
  /** The line ending `baseline`/`draft` were normalized *away from*, so a
   * save can write the file back the way it was found. Without it, opening a
   * CRLF file made `draft` (LF, via CodeMirror) differ from `baseline` on
   * every single line: dirty on open with no user edit, the close guard
   * blocking, the gutter a solid stripe — and the first Save silently
   * rewriting the whole file to LF. */
  eol: Eol;
  sig: Signature;
}

/**
 * One session's Changes-view UI state — what the user has clicked, as opposed
 * to what a fetch produced ({@link SessionChanges}). Every field is optional:
 * a session's entry appears the first time something is written to it, and an
 * absent field means the default ("changes", off, nothing selected, no jump
 * pending). Grouped rather than kept as four parallel maps because these are
 * exactly the [Changes view model]'s own inputs — see {@link ChangesState}.
 */
export interface SessionChangesUi {
  /** Whether the "My edits only" filter is on for this session's Changes view
   * — a pure frontend intersection against `sessionTouchedRelative` (see
   * `state/sessions.ts`), never a fresh `git diff`. Off until toggled, so the
   * honest full diff is what a user sees first (ADR 0015 — the badge/filter
   * is best-effort attribution, not an authoritative gate). */
  myEditsOnly?: boolean;
  /** A path awaiting a scroll, or `undefined` once consumed. The Inspector
   * (right sidebar) and `ChangesView` are sibling subtrees, so a jump request
   * has to travel through the store. */
  pendingJump?: string;
  /** The repo-relative path open in `FileViewer`, or `undefined` for the diff
   * feed. Deliberately *not* cleared by `setTab`: `ChangesView` keeps
   * `FileViewer` mounted and just display-toggles it against the tab, so a
   * file left open in "All files" survives a flip to "Changes" and back
   * (draft, cursor, scroll position included) instead of being silently
   * destroyed. Only `selectFile(sessionId, undefined)` (the × button) or
   * picking a different file actually changes this. */
  selectedFile?: string;
  /** Which tab the Changes view's left column is showing (defaults to
   * "changes"). */
  tab?: FileTreeTab;
}

/**
 * The Code Changes View's store: one session's fetched diff, plus the view
 * state around it.
 *
 * ### Why this is several maps and not one
 *
 * zustand compares a selector's *output*, so a write only costs a re-render
 * where some consumer's selector returns something new. What decides the
 * shape below is therefore who reads a slice **whole**, and how often it is
 * written:
 *
 * - `bySession` is read whole (by `SummaryBar`), so nothing the user merely
 *   clicks may live in it — a tab flip would repaint the header.
 * - `activeFile` is written on every card boundary the feed scrolls past. It
 *   is the one slice with a frame-rate writer, and only `JumpRail` reads it,
 *   so a scroll re-renders 26px of dots and nothing else.
 * - `ui` is the [Changes view model]'s own inputs, grouped: they are read
 *   together and memoized together, so invalidating one already invalidates
 *   that view — splitting them buys nothing.
 * - `expandedDirs` belongs to the All-files tree and is *not* a view-model
 *   input; folding it into `ui` would re-render the whole Changes view every
 *   time a directory is expanded.
 * - `dirtyFiles`/`fileDrafts` are the [File editor]'s published state under a
 *   different owner, and `FileBrowserTree` reads them without any of the
 *   rest.
 */
export interface ChangesState {
  /** sessionId → the file whose card is currently most-visible in the diff
   * feed (the jump rail's accent "you are here" dot), or `null`. Written by
   * `DiffFeed`'s IntersectionObserver, `null`/absent until the feed reports
   * one. */
  activeFile: Record<string, string | null>;
  bySession: Record<string, SessionChanges>;
  /** Close every open folder in this session's All-files tree — the
   * explorer's "Collapse folders" button. */
  collapseAllDirs: (sessionId: string) => void;
  /** Take and clear the pending jump for `sessionId`. */
  consumeJump: (sessionId: string) => void;
  /** sessionId → the repo-relative path of the file currently dirty in that
   * session's open [File editor] (`null` when nothing is), published by
   * `useFileEditorSession` so the file tree can show the unsaved-changes dot
   * without importing the hook itself. Distinct from `fileDrafts`: this is
   * the *live* editor's dirty flag (cleared on revert, save, or unmount),
   * while `fileDrafts` is what survives after the pane goes away — a tree
   * row is dirty if either says so (see `FileBrowserTree`). */
  dirtyFiles: Record<string, string | null>;
  /** Forget every per-session entry for `sessionId` — its diff, view state,
   * and UI toggles — so a closed session's data (a full `SessionDiff` with
   * all hunks) doesn't live for the rest of the app's lifetime. Called from
   * `useSessions.removeSession`; a no-op for an unknown id. */
  dropSession: (sessionId: string) => void;
  /** sessionId → repo-relative dir paths currently expanded in the All-files
   * tree. "" is the repo root. */
  expandedDirs: Record<string, Record<string, boolean>>;
  /** Open every folder above `path` (cwd-relative) so its row is on screen —
   * what an editor does when a file is opened from somewhere other than the
   * tree. A root-level path opens nothing. */
  expandToPath: (sessionId: string, path: string) => void;
  /** sessionId → path → the [File draft] stashed when that pane was unmounted
   * while dirty. Only dirty drafts are ever stashed, and only by the pane
   * going away underneath the user (the [Warm pane] LRU evicting it) — a
   * draft the user discarded through the × or the switch guard is gone
   * because they said so. Entries are consumed by {@link takeFileDraft} on
   * the next load of the same file, so this never grows into a second,
   * stale copy of the editor's state. */
  fileDrafts: Record<string, Record<string, EditState>>;
  /** Marks `path` as viewed for `sessionId` (the jump rail's IntersectionObserver
   * calls this once a file's card actually intersects the viewport). No-ops if
   * already viewed, so a repeated intersection-threshold crossing while
   * scrolling doesn't churn the store. */
  markViewed: (sessionId: string, path: string) => void;
  /** Drop every `expandedDirs[sessionId]` key at or under `path` — the entry
   * itself and anything nested inside it. A rename or delete that acts on an
   * expanded directory leaves its old key behind otherwise: nothing else
   * ever removes it, so the All-files tree's revalidation effect issues a
   * doomed `listDir` for a directory that no longer exists at that path,
   * once per landed refresh, for the rest of the session's life. Reuses the
   * same "at or under" test `FileBrowserTree`'s own `isWithin` runs, kept
   * private to this store rather than imported from the component. */
  pruneExpandedDirsUnder: (sessionId: string, path: string) => void;
  /** Fetch `sessionId`'s diff into `bySession`. The decisions behind it — the
   * coalescing, the degrade ladder, the epoch stamp — are the [Changes refresh
   * coordinator]'s (`startRefresh`); this stays a store action because a fetch
   * that writes this store's data is dispatched *through* this store, and it
   * is the one seam a caller (or a test) can swap. Production code reaches it
   * only via the coordinator's own `refreshSessionChanges`, which resolves the
   * base and baseline first. */
  refresh: (
    sessionId: string,
    cwd: string,
    options?: RefreshOptions
  ) => Promise<void>;
  /** Ask the Changes view to scroll to `path` next time it renders. */
  requestJump: (sessionId: string, path: string) => void;
  selectFile: (sessionId: string, path: string | undefined) => void;
  /** Record the diff feed's currently most-visible file for `sessionId` — see
   * {@link ChangesState.activeFile}. No-ops when unchanged so a scroll that
   * doesn't cross a card boundary never touches the store. */
  setActiveFile: (sessionId: string, path: string | null) => void;
  /** Collapse or expand every card in `paths` — the files the scope on
   * screen lists — or, without `paths`, every file in the session diff, in
   * one batch: the SummaryBar's "Collapse all"/"Expand all". A no-op when
   * there is nothing to act on. A later per-file {@link toggleCollapsed}
   * still overrides its file. */
  setAllCollapsed: (
    sessionId: string,
    collapsed: boolean,
    paths?: readonly string[]
  ) => void;
  /** Publish `sessionId`'s live dirty path — see {@link ChangesState.dirtyFiles}. */
  setDirtyFile: (sessionId: string, path: string | null) => void;
  setTab: (sessionId: string, tab: FileTreeTab) => void;
  /** Keep `draft` for `path` until the file is next loaded — see
   * {@link ChangesState.fileDrafts}. */
  stashFileDraft: (sessionId: string, path: string, draft: EditState) => void;
  /** Take and clear the stashed [File draft] for `path`, or `undefined` when
   * there isn't one. Consuming rather than peeking is what keeps the stash
   * from outliving the load it belongs to. */
  takeFileDraft: (sessionId: string, path: string) => EditState | undefined;
  toggleCollapsed: (sessionId: string, path: string) => void;
  toggleDir: (sessionId: string, dir: string) => void;
  /** Flip `sessionId`'s "My edits only" filter — see
   * {@link SessionChangesUi.myEditsOnly}. */
  toggleMyEditsOnly: (sessionId: string) => void;
  /** sessionId → the Changes view's own UI state — see
   * {@link SessionChangesUi}. */
  ui: Record<string, SessionChangesUi>;
}

/** File cards past this many changed (added + removed) lines render
 * collapsed by default (Global Constraints: big-diff review fatigue). */
const AUTO_COLLAPSE_LINE_THRESHOLD = 400;

const LOCKFILE_NAMES = new Set(["pnpm-lock.yaml", "Cargo.lock"]);

/** Lockfile / generated paths that render collapsed by default, alongside
 * the line-count threshold. Mirrors the plan's Global Constraints list. */
function isAutoCollapsedPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (LOCKFILE_NAMES.has(name)) {
    return true;
  }
  if (name.includes(".min.")) {
    return true;
  }
  return path === "dist" || path.startsWith("dist/") || path.includes("/dist/");
}

/** Additions/deletions across every hunk in a file — drives the file card's
 * header pill and the auto-collapse default below. */
export function fileDiffCounts(file: FileDiff): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "added") {
        additions += 1;
      } else if (line.kind === "removed") {
        deletions += 1;
      }
    }
  }
  return { additions, deletions };
}

/** A file's collapse default when the user hasn't toggled it explicitly. */
export function defaultCollapsed(file: FileDiff): boolean {
  if (isAutoCollapsedPath(file.path)) {
    return true;
  }
  const { additions, deletions } = fileDiffCounts(file);
  return additions + deletions > AUTO_COLLAPSE_LINE_THRESHOLD;
}

/**
 * A file's effective collapsed state: an explicit user toggle (`collapsed`,
 * keyed by path) wins; anything the user hasn't touched falls back to
 * {@link defaultCollapsed}. This is the single source of truth every
 * consumer — the feed, and (once built) the file tree, jump rail, and
 * summary bar — should read through, and the value `toggleCollapsed` flips
 * against. Reading `collapsed[path]` directly is a trap: it's `undefined`
 * for every file the user hasn't clicked, and `!undefined === true` silently
 * "collapses" an already-collapsed file on its first click.
 */
export function selectCollapsed(
  collapsed: Record<string, boolean>,
  file: FileDiff
): boolean {
  return collapsed[file.path] ?? defaultCollapsed(file);
}

/**
 * Whether a diff row can offer to open this file in the [File editor] — the
 * one rule both surfaces that show an "Edit file" affordance (`DiffFeed`'s
 * cards and `FileTreePane`'s rows) ask, so the two can't drift.
 *
 * Two files can't be:
 *
 * - `deleted` — the diff still lists it (that *is* the change), but there is
 *   nothing on disk to open; `read_file` refuses a path that isn't there, so
 *   the pencil's only possible outcome was the viewer's error banner. Nor is
 *   "recreate it" the missing feature: `write_file` cannot create files by
 *   design (ADR-0016).
 * - `binary` — the viewer opens it read-only by construction (see
 *   `FileContent.binary`), so the edit affordance promises something the
 *   destination refuses.
 */
export function isEditableFile(file: FileDiff): boolean {
  return file.status !== "deleted" && !file.binary;
}

/**
 * A file's display bucket, for surfaces that render binary/rename/empty
 * files distinctly from a normal ± content diff (Task 9 consumes this
 * directly). Deliberately doesn't have a "noise" case of its own: a
 * zero-hunk, non-binary `modified` file is real 0-change noise (git reports
 * it — e.g. a mode-only change our line-level diff can't show — but there's
 * nothing to render), and `isNoiseFile`/`visibleFiles` below filter it out
 * before anything calls this, so noise itself falls through to the
 * `"content"` default rather than needing a fifth bucket no caller should
 * ever see.
 */
export function fileKind(
  file: FileDiff
): "binary" | "content" | "empty" | "rename" {
  if (file.binary) {
    return "binary";
  }
  if (file.status === "renamed" && file.hunks.length === 0) {
    return "rename";
  }
  if (
    file.hunks.length === 0 &&
    (file.status === "added" || file.status === "deleted")
  ) {
    return "empty";
  }
  return "content";
}

/**
 * True noise: a `modified` file with no hunks and no binary marker. Git can
 * report a file as changed (e.g. a mode-only bit flip, or a path our
 * line-level parser didn't produce hunks for) with nothing to actually show
 * — that's the `+0 −0` card this task exists to remove. Binary, rename, and
 * newly-added/deleted-and-empty files are also zero-hunk but are *real*
 * changes (see {@link fileKind}), so they're excluded from this check and
 * stay visible.
 */
function isNoiseFile(file: FileDiff): boolean {
  return !file.binary && file.status === "modified" && file.hunks.length === 0;
}

/**
 * `diff.files`, minus true zero-change noise (see {@link isNoiseFile}) — the
 * single filtered list every Changes-view surface (the Inspector's sidebar
 * list, `DiffFeed`, the jump rail, and the file tree) should render from, so
 * a file's visibility and the header's file count never disagree. Accepts
 * `null`/`undefined` so call sites can pass `entry?.diff` straight through
 * without an extra guard.
 */
export function visibleFiles(diff: SessionDiff | null | undefined): FileDiff[] {
  if (!diff) {
    return [];
  }
  return diff.files.filter((file) => !isNoiseFile(file));
}

/**
 * Sum additions/deletions across every hunk of `files`, client-side (see
 * task brief). Reuses {@link fileDiffCounts} per file rather than
 * re-walking hunks with separate logic — binary/rename/empty files
 * naturally contribute 0 lines here since they have no hunks, satisfying
 * "count as 1 file / 0 lines" without a special case. Takes a plain
 * `FileDiff[]` (not a `SessionDiff`) so a caller that already has a
 * filtered file list — `SummaryBar`, computing totals over the "My edits
 * only" subset for I5 (round-two review) — can total exactly what's on
 * screen without constructing a fake `SessionDiff` to feed {@link computeTotals}.
 */
export function computeTotalsFromFiles(files: FileDiff[]): DiffTotals {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    const counts = fileDiffCounts(file);
    additions += counts.additions;
    deletions += counts.deletions;
  }
  return { additions, deletions, files: files.length };
}

/**
 * {@link computeTotalsFromFiles} over `diff`'s noise-filtered
 * {@link visibleFiles} — the whole-diff totals the [Changes refresh
 * coordinator]'s `doRefresh` stores on `entry.totals`, unaffected by any
 * UI-only filter (the "My edits only" toggle) a consumer might have active. See {@link computeTotalsFromFiles}'s
 * doc comment for the filtered-subset case this deliberately doesn't cover.
 */
export function computeTotals(diff: SessionDiff): DiffTotals {
  return computeTotalsFromFiles(visibleFiles(diff));
}

/** One polynomial mixing step (the same shape as Java's `String.hashCode`) —
 * cheap, deterministic, and good enough to tell "this file's hunks changed"
 * from "this file's hunks didn't", which is all {@link hashHunks} needs it
 * for; not a security hash. `Math.imul` keeps every intermediate value
 * pinned to 32-bit-int arithmetic without reaching for bitwise operators
 * (disallowed by this repo's lint config — `noBitwiseOperators`). */
function mixHash(hash: number, text: string): number {
  let h = hash;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(31, h) + text.charCodeAt(i);
  }
  return h;
}

/**
 * A fingerprint of a file's hunk content (every hunk header, plus every
 * line's kind and text) — the jump rail's `viewed` reset gate compares this
 * across a refresh so a file whose diff didn't actually change keeps its
 * viewed state, and only a genuinely different diff resets it.
 */
export function hashHunks(file: FileDiff): string {
  let hash = 17;
  for (const hunk of file.hunks) {
    hash = mixHash(hash, hunk.header);
    for (const line of hunk.lines) {
      hash = mixHash(hash, line.kind);
      hash = mixHash(hash, line.text);
    }
  }
  return Math.abs(hash).toString(36);
}

/**
 * The `hunkHashes`/`viewed` pair a refresh should store for `files`: every
 * current file's fresh hash, and `viewed` carried forward only for a path
 * whose hash is unchanged from `prevHashes` *and* was already viewed — a
 * file that's new, removed, or whose hunks actually changed starts (or
 * returns to) unviewed.
 */
export function nextViewedState(
  files: FileDiff[],
  prevHashes: Record<string, string>,
  prevViewed: Record<string, boolean>
): { hunkHashes: Record<string, string>; viewed: Record<string, boolean> } {
  const hunkHashes: Record<string, string> = {};
  const viewed: Record<string, boolean> = {};
  for (const file of files) {
    const hash = hashHunks(file);
    hunkHashes[file.path] = hash;
    if (prevViewed[file.path] && prevHashes[file.path] === hash) {
      viewed[file.path] = true;
    }
  }
  return { hunkHashes, viewed };
}

/**
 * The human-readable half of the Rust `diff_session_changes_sync`
 * (`git_cmd.rs`) error when `baseline_oid` no longer resolves to an object
 * in the repo — must match that side's `BASELINE_OBJECT_MISSING_PREFIX`
 * constant exactly; there's no shared codegen across the Rust↔JS IPC
 * boundary, so the two literals are kept in sync by hand. Both sides are
 * frozen by a contract test (B4): this one via `changes.test.ts`'s "matches
 * the exact frozen contract prefix", the Rust one via git_cmd.rs's
 * `baseline_object_missing_prefix_is_the_frozen_contract_string` — change one
 * and its pin fails, telling you to change both. Exported solely so that pin
 * can assert the exact bytes.
 *
 * No longer what {@link isMissingBaselineObjectError} classifies on — Rust
 * now wraps this text with `tagged_failure`'s `"kind:baseline-pruned: "`
 * leader, and `commandFailure` (`src/ipc/failures.ts`) reads that instead.
 * See [Command failure kind].
 */
export const BASELINE_OBJECT_MISSING_PREFIX = "baseline object missing: ";

/**
 * `true` if `err` is a `diffSessionChanges` failure of the `"baselinePruned"`
 * [Command failure kind] — the pruned-baseline case (I1, round-two review,
 * BLOCKER) the [Changes refresh coordinator]'s `doRefresh` must degrade from
 * by falling back to `diffWorkingTree`, rather than parking the same "bad object" failure on
 * every subsequent refresh forever. A `baselineOid` is a dangling tree
 * object by construction (see ADR 0015), so `git gc --prune=now`, `git
 * repack -ad`, or the default two-week `gc.pruneExpire` WILL eventually
 * collect it — this isn't a rare edge case to shrug off.
 *
 * A thin wrapper over {@link commandFailure} (ADR-0006 addendum) — kept as
 * its own named predicate rather than inlining the comparison at its one call
 * site below, so that call site reads as "is this the pruned-baseline case?"
 * rather than a bare string comparison.
 */
export function isMissingBaselineObjectError(err: unknown): boolean {
  return commandFailure(err) === "baselinePruned";
}

/**
 * The human-readable half of the Rust `snapshot_tree` (`git_cmd.rs`) error
 * when the [Working-tree budget]'s file ceiling is passed — must match that
 * side's `WORKING_TREE_TOO_LARGE_PREFIX` exactly, kept in sync by hand and
 * frozen by a contract test on each side, the same arrangement as
 * {@link BASELINE_OBJECT_MISSING_PREFIX}. Also no longer what
 * {@link isWorkingTreeTooLargeError} classifies on — see that constant's
 * doc comment.
 */
export const WORKING_TREE_TOO_LARGE_PREFIX = "working tree too large: ";

/**
 * `true` if `err` is `diffSessionChanges` reporting the `"overBudget"`
 * [Command failure kind]: this repo's working tree is over the
 * [Working-tree budget], so its baseline snapshot (`git add -A`) was refused
 * before it could hash gigabytes of un-ignored files.
 *
 * Degrades exactly like {@link isMissingBaselineObjectError} with one
 * deliberate difference: the session's `baselineOid` is **kept**. A pruned
 * object is gone for good, so that path clears it; this one says nothing about
 * the baseline — the object is still there, the tree is temporarily too big.
 * Clearing it would permanently downgrade the session to the HEAD diff even
 * after the user gitignores the directory responsible.
 *
 * A thin wrapper over {@link commandFailure}, mirroring
 * {@link isMissingBaselineObjectError}.
 */
export function isWorkingTreeTooLargeError(err: unknown): boolean {
  return commandFailure(err) === "overBudget";
}

/** One session's {@link SessionChangesUi} with `patch` applied — the single
 * write path for every UI-state action below, so a new entry appears the same
 * way whether it is a tab flip, a selection, a filter toggle or a jump. */
function patchUi(
  state: ChangesState,
  sessionId: string,
  patch: SessionChangesUi
): Pick<ChangesState, "ui"> {
  return {
    ui: { ...state.ui, [sessionId]: { ...state.ui[sessionId], ...patch } },
  };
}

export const useChanges = create<ChangesState>((set, get) => ({
  activeFile: {},
  bySession: {},
  dirtyFiles: {},
  expandedDirs: {},
  fileDrafts: {},
  ui: {},

  consumeJump: (sessionId) =>
    set((state) => {
      if (state.ui[sessionId]?.pendingJump === undefined) {
        return state;
      }
      return patchUi(state, sessionId, { pendingJump: undefined });
    }),

  markViewed: (sessionId, path) => {
    const prev = get().bySession[sessionId] ?? EMPTY_ENTRY;
    if (prev.viewed[path]) {
      return;
    }
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: { ...prev, viewed: { ...prev.viewed, [path]: true } },
      },
    }));
  },

  collapseAllDirs: (sessionId) =>
    set((state) => ({
      expandedDirs: { ...state.expandedDirs, [sessionId]: {} },
    })),

  expandToPath: (sessionId, path) =>
    set((state) => {
      const parts = path.split("/").slice(0, -1);
      if (parts.length === 0) {
        return state;
      }
      const prev = state.expandedDirs[sessionId] ?? EMPTY_EXPANDED_DIRS;
      const next = { ...prev };
      let changed = false;
      for (let i = 1; i <= parts.length; i += 1) {
        const dir = parts.slice(0, i).join("/");
        if (next[dir] !== true) {
          next[dir] = true;
          changed = true;
        }
      }
      if (!changed) {
        return state;
      }
      return { expandedDirs: { ...state.expandedDirs, [sessionId]: next } };
    }),

  pruneExpandedDirsUnder: (sessionId, path) =>
    set((state) => {
      const prev = state.expandedDirs[sessionId];
      if (!prev) {
        return state;
      }
      const kept = Object.fromEntries(
        Object.entries(prev).filter(
          ([dir]) => dir !== path && !dir.startsWith(`${path}/`)
        )
      );
      if (Object.keys(kept).length === Object.keys(prev).length) {
        return state;
      }
      return { expandedDirs: { ...state.expandedDirs, [sessionId]: kept } };
    }),

  // Deliberately not `refresh: startRefresh`: the wrapper keeps the binding
  // read lazily, so a test that mocks the coordinator module can still
  // construct this store. `options` is forwarded as-is — `startRefresh` owns
  // the `{}` default, so defaulting it here too would be two answers to one
  // question.
  refresh: (sessionId, cwd, options) => startRefresh(sessionId, cwd, options),

  dropSession: (sessionId) =>
    set((state) => {
      const drop = <T>(map: Record<string, T>): Record<string, T> => {
        if (!(sessionId in map)) {
          return map;
        }
        const next = { ...map };
        delete next[sessionId];
        return next;
      };
      // One delete per structure — the shape above is exactly what a closed
      // session leaves behind.
      return {
        activeFile: drop(state.activeFile),
        bySession: drop(state.bySession),
        dirtyFiles: drop(state.dirtyFiles),
        expandedDirs: drop(state.expandedDirs),
        fileDrafts: drop(state.fileDrafts),
        ui: drop(state.ui),
      };
    }),

  requestJump: (sessionId, path) =>
    set((state) => patchUi(state, sessionId, { pendingJump: path })),

  selectFile: (sessionId, path) =>
    set((state) => patchUi(state, sessionId, { selectedFile: path })),

  stashFileDraft: (sessionId, path, draft) =>
    set((state) => ({
      fileDrafts: {
        ...state.fileDrafts,
        [sessionId]: { ...state.fileDrafts[sessionId], [path]: draft },
      },
    })),

  takeFileDraft: (sessionId, path) => {
    const stashed = get().fileDrafts[sessionId]?.[path];
    if (!stashed) {
      return;
    }
    set((state) => {
      const forSession = { ...state.fileDrafts[sessionId] };
      delete forSession[path];
      const next = { ...state.fileDrafts };
      if (Object.keys(forSession).length === 0) {
        delete next[sessionId];
      } else {
        next[sessionId] = forSession;
      }
      return { fileDrafts: next };
    });
    return stashed;
  },

  setActiveFile: (sessionId, path) =>
    set((state) => {
      if ((state.activeFile[sessionId] ?? null) === path) {
        return state;
      }
      return { activeFile: { ...state.activeFile, [sessionId]: path } };
    }),

  setDirtyFile: (sessionId, path) =>
    set((state) => ({
      dirtyFiles: { ...state.dirtyFiles, [sessionId]: path },
    })),

  setTab: (sessionId, tab) =>
    set((state) => patchUi(state, sessionId, { tab })),

  setAllCollapsed: (sessionId, collapsed, paths) =>
    set((s) => {
      const prev = s.bySession[sessionId];
      const targets = paths ?? (prev?.diff?.files ?? []).map((f) => f.path);
      if (!prev || targets.length === 0) {
        return s;
      }
      const nextCollapsed = { ...prev.collapsed };
      for (const path of targets) {
        nextCollapsed[path] = collapsed;
      }
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: { ...prev, collapsed: nextCollapsed },
        },
      };
    }),

  toggleCollapsed: (sessionId, path) =>
    set((s) => {
      const prev = s.bySession[sessionId] ?? EMPTY_ENTRY;
      // In production `path` almost always resolves: DiffFeed's `files`
      // prop is `ChangesView`'s `displayFiles` — `visibleFiles(bySession[id]
      // .diff)` (M8, round-two review: this used to claim it was
      // `bySession[id].diff.files` directly, which stopped being true once
      // `visibleFiles` started filtering out noise files), further narrowed
      // to the touched-by-this-session subset whenever "My edits only" is
      // on. So the file the user clicked is normally in `prev.diff.files`
      // already. The fallback below only matters for a stale click racing
      // an in-flight refresh (or a thin test fixture) — without a FileDiff
      // to run `defaultCollapsed` against, treat it as not auto-collapsed
      // so the toggle still flips to collapsed rather than silently
      // no-op'ing.
      const file = prev.diff?.files.find((f) => f.path === path);
      const effective = file
        ? selectCollapsed(prev.collapsed, file)
        : (prev.collapsed[path] ?? false);
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: {
            ...prev,
            collapsed: { ...prev.collapsed, [path]: !effective },
          },
        },
      };
    }),

  toggleDir: (sessionId, dir) =>
    set((state) => {
      const prev = state.expandedDirs[sessionId] ?? EMPTY_EXPANDED_DIRS;
      return {
        expandedDirs: {
          ...state.expandedDirs,
          [sessionId]: { ...prev, [dir]: !prev[dir] },
        },
      };
    }),

  toggleMyEditsOnly: (sessionId) =>
    set((state) =>
      patchUi(state, sessionId, {
        myEditsOnly: !myEditsOnlyOf(state.ui[sessionId]),
      })
    ),
}));
