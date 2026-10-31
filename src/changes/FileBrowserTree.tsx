import { ChevronsDownUp, FilePlus, FolderPlus, RotateCw } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createDir,
  createFile,
  deleteEntry,
  type FileEntry,
  listDir,
  openInEditor,
  renameEntry,
  revealPath,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import { EMPTY_EXPANDED_DIRS, useChanges } from "../state/changes.ts";
import { requestRefresh, useRevalidateOn } from "../state/changesRefresh.ts";
import type { TreeDecorations } from "../state/changesView.ts";
import { sessionWorkingDir, useSessions } from "../state/sessions.ts";
import { iconButton, inputBox, treeRow } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { DirEntry, FileChange } from "../types.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu.tsx";
import { showToast } from "../ui/Toast.tsx";
import { banner } from "./banner.ts";
import { copyPath } from "./copyPath.ts";
import { FileSearch } from "./FileSearch.tsx";
import { DirChevron, DirIcon, FileIcon } from "./fileIcon.tsx";

/** How far one level of nesting shifts a row: one chevron slot plus the
 * small gap after it, so a child's chevron sits just right of its parent's. */
const INDENT_PX = 14;

/** A directory's fetched children, or the message from a failed `listDir`
 * call — kept apart from "not fetched yet" (absent from the record) so a
 * directory can be told apart from "still loading" vs. "errored". */
type DirListing = DirEntry[] | { error: string };

function isError(listing: DirListing): listing is { error: string } {
  return !Array.isArray(listing);
}

/** `listDir`'s error is displayed verbatim in the row below (`Failed to
 * load: {listing.error}`), so any [Command failure kind] leader
 * `SandboxRoot::resolve` (`sandbox.rs`) may now tag it with — a directory deleted
 * between listing and expand-fetch surfaces the same `"kind:file-missing: "`
 * tag `useFileEditorSession.ts` classifies on — must be stripped here too;
 * nothing in this tree reacts to the *kind*, only the message. */
function errorMessage(err: unknown): string {
  return failureMessage(err);
}

function childPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** The last segment of a repo-relative path: the name a rename edits, and the
 * one the delete confirm names. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Where a filename's stem ends, so Rename can select it and leave the
 * extension alone (what VS Code does). A *leading* dot is part of the name
 * rather than an extension, so `.gitignore` selects whole. */
function stemEnd(name: string): number {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/** Is `dir` `ancestor` itself, or nested somewhere inside it? Both are
 * repo-relative, `/`-joined paths, so the prefix test needs the separator:
 * without it a sibling whose name merely starts the same ("src2" under
 * "src") would count as nested. */
function isWithin(dir: string, ancestor: string): boolean {
  return dir === ancestor || dir.startsWith(`${ancestor}/`);
}

/** An open naming row: one at a time, tree-wide. `renaming` carries the
 * existing name when this draft is a rename rather than a create (Task 6) —
 * the flows differ only in what commits, so they share one row. */
interface Draft {
  error?: string;
  kind: "file" | "dir";
  parentDir: string;
  renaming?: string;
}

/** A right-click's pending context menu: which directory a create should
 * land in by default (`dir`, the row's own parent) and, when the click
 * landed on a row rather than the empty area below the tree, which entry —
 * see {@link targetDirFor}. */
interface PendingMenu {
  at: { x: number; y: number };
  dir: string;
  entry?: { isDir: boolean; path: string };
}

/** A delete waiting on its confirm dialog. Carries `dir` — the listing to
 * re-fetch once the entry is gone — rather than re-deriving it from `path`,
 * so the directory the row was actually rendered under is the one refreshed. */
interface PendingDelete {
  dir: string;
  isDir: boolean;
  path: string;
}

/** The whole tab: a fixed toolbar over a scrolling list. Not a scroller
 * itself — see {@link scrollStyle}. */
const rootStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  minHeight: 0,
};

/** The explorer's title strip: the folder's name, and the four actions an
 * editor's explorer keeps there. */
const toolbarStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  gap: "2px",
  height: "30px",
  padding: "0 6px 0 12px",
};

const toolbarTitleStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: 1,
  fontSize: "11px",
  fontWeight: 500,
  letterSpacing: "0.06em",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

const toolbarButtonStyle: CSSProperties = {
  ...iconButton(),
  height: "22px",
  width: "22px",
};

/**
 * The scrolling list. A flex column only so the trailing empty area
 * (`emptyAreaStyle`) can take the leftover height as a right-click target;
 * the rows themselves sit in a plain block (`listStyle`), so they can never
 * be squeezed to fit — the bug that once drew a long tree's file rows on top
 * of each other.
 */
const scrollStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minHeight: 0,
  overflowY: "auto",
  padding: "0 4px 6px",
};

const listStyle: CSSProperties = { flex: "none" };

/** The vertical rule marking one level of nesting, drawn under the centre of
 * the parent's chevron so a deep row's folder is traceable up the column. */
const guideStyle: CSSProperties = {
  alignSelf: "stretch",
  borderLeft: `1px solid ${tokens.color.line.soft}`,
  flex: "none",
  marginLeft: `${INDENT_PX / 2}px`,
  width: `${INDENT_PX / 2}px`,
};

/** The chevron's slot. A file gets the same empty slot, so names in one
 * folder line up whether they are files or folders. */
const chevronSlotStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  justifyContent: "center",
  width: `${INDENT_PX}px`,
};

const iconSlotStyle: CSSProperties = {
  display: "flex",
  flex: "none",
  margin: "0 6px 0 2px",
};

const nameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** A gitignored entry: one ink stop quieter, still legible. */
const ignoredInk = tokens.color.ink.muted;

/** How each kind of change colours a row — the git colours every editor's
 * explorer uses. A deleted file has no row here (it is gone from disk). */
const GIT_INK: Record<FileChange, string> = {
  added: tokens.color.add,
  deleted: tokens.color.del,
  modified: tokens.color.mod,
  renamed: tokens.color.mod,
};

const GIT_LETTER: Record<FileChange, string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
};

const GIT_LABEL: Record<FileChange, string> = {
  added: "Added",
  deleted: "Deleted",
  modified: "Modified",
  renamed: "Renamed",
};

function gitLetterStyle(change: FileChange): CSSProperties {
  return {
    color: GIT_INK[change],
    flex: "none",
    fontFamily: tokens.font.mono,
    fontSize: "10.5px",
    fontWeight: 600,
    marginLeft: "6px",
    textAlign: "center",
    width: "12px",
  };
}

/** A folder holding a change somewhere below it. */
const changedDirDotStyle: CSSProperties = {
  background: tokens.color.mod,
  borderRadius: "50%",
  flex: "none",
  height: "5px",
  marginLeft: "6px",
  marginRight: "4px",
  opacity: 0.8,
  width: "5px",
};

/** The unsaved-changes dot — the same dot `FileViewer`'s header shows. */
const treeDirtyDotStyle: CSSProperties = {
  background: tokens.color.status.waiting,
  borderRadius: "50%",
  flex: "none",
  height: "6px",
  marginLeft: "6px",
  width: "6px",
};

const noteRowStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  lineHeight: "22px",
  padding: "0 8px",
};

const errorRowStyle: CSSProperties = {
  ...noteRowStyle,
  color: tokens.color.status.error,
};

/**
 * The inline naming row's `<input>` — the shared `inputBox` well, shrunk to
 * sit flush inside a tree row and wearing an accent border, which is the
 * only thing that tells it apart from the plain rows above and below it.
 *
 * `display: "block"` because `inputBox` deliberately sets none, and without
 * it this one would collapse to the `<input>`'s intrinsic size instead of
 * taking the `flex: 1` the row hands it.
 */
const draftInputStyle: CSSProperties = {
  ...inputBox(),
  border: `1px solid ${tokens.color.accent}`,
  color: tokens.color.ink.primary,
  display: "block",
  flex: 1,
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  height: "20px",
  minWidth: 0,
  outline: "none",
  padding: "0 5px",
};

const draftErrorStyle: CSSProperties = {
  color: tokens.color.status.error,
  fontFamily: tokens.font.sans,
  fontSize: "11px",
  padding: "1px 0 3px",
};

/** The unsaved-edits refusal: the view's shared error banner, plus the reset
 * a clickable one needs. A button rather than a `<div>` because the message
 * has to be dismissible by whoever is looking at it — the only other thing
 * that clears it is opening another menu. */
const refusalStyle: CSSProperties = {
  ...banner("error"),
  cursor: "pointer",
  flex: "none",
  textAlign: "left",
};

/** The empty area below the tree — a drop target for the tree-wide "New
 * File"/"New Folder" root-level context menu, and enough of it to right-click
 * comfortably once the tree itself is short. */
const emptyAreaStyle: CSSProperties = { flex: 1, minHeight: "24px" };

/** A note row's indent (loading, error, a draft's error) — level with the
 * names of the rows around it. */
function indentStyle(depth: number): CSSProperties {
  return { paddingLeft: `${8 + INDENT_PX * (depth + 1)}px` };
}

/** One vertical rule per ancestor level. */
function Guides({ depth }: { depth: number }) {
  return Array.from({ length: depth }, (_, level) => (
    // Guides are positional, one per ancestor level, with no identity of
    // their own.
    // biome-ignore lint/suspicious/noArrayIndexKey: positional nesting level.
    <span key={level} style={guideStyle} />
  ));
}

/** The repo-relative folder a path sits in (`""` for the root). */
function parentDir(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Arrow-key movement through the tree's rows, the way every editor's
 * explorer does it: up/down walk the visible rows, right opens a folder (or
 * steps into an open one), left closes an open folder (or steps out to the
 * one above). Reads the rows off the DOM, which is exactly the visible order
 * — nothing to keep in sync with the render.
 *
 * Returns whether the key was handled, so the caller can stop the page
 * scrolling under it.
 */
function moveInTree(
  event: KeyboardEvent<HTMLElement>,
  isExpanded: (path: string) => boolean,
  toggle: (path: string) => void
): boolean {
  const row = event.target as HTMLElement;
  const path = row.dataset.rowPath;
  if (path === undefined) {
    return false;
  }
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("[data-row-path]")
  );
  const at = rows.indexOf(row);
  const isDir = row.dataset.rowDir === "true";
  const focusPath = (target: string) =>
    rows.find((r) => r.dataset.rowPath === target)?.focus();
  switch (event.key) {
    case "ArrowDown":
      rows[at + 1]?.focus();
      return true;
    case "ArrowUp":
      rows[at - 1]?.focus();
      return true;
    case "Home":
      rows[0]?.focus();
      return true;
    case "End": {
      // A reverse lookup rather than `.at(-1)`: the TS lib is ES2020.
      const [last] = [...rows].reverse();
      last?.focus();
      return true;
    }
    case "ArrowRight":
      if (isDir && !isExpanded(path)) {
        toggle(path);
      } else if (
        isDir &&
        rows[at + 1]?.dataset.rowPath?.startsWith(`${path}/`)
      ) {
        rows[at + 1].focus();
      }
      return true;
    case "ArrowLeft":
      if (isDir && isExpanded(path)) {
        toggle(path);
      } else if (parentDir(path) !== "") {
        focusPath(parentDir(path));
      }
      return true;
    default:
      return false;
  }
}

/** No changes to mark — the default for a caller with no diff to hand. */
const NO_DECORATIONS: TreeDecorations = { dirs: new Set(), files: new Map() };

/** The last segment of the session folder: the explorer's title. */
const TRAILING_SLASHES = /\/+$/;

function folderName(cwd: string): string {
  const trimmed = cwd.replace(TRAILING_SLASHES, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/**
 * The Code Changes View's "All files" tab (Task 5): a lazily-fetched
 * directory tree, one `listDir` call per directory the user actually
 * expands — never a recursive walk. Listings are held in local component
 * state keyed by repo-relative directory path (`""` is the root); the
 * store (Task 4) only tracks *which* directories are expanded and which
 * file is selected, so a session switch that remounts this component
 * re-fetches only what's still expanded, and nothing more.
 *
 * A failed listing renders an inline error for that directory only —
 * sibling and ancestor rows stay intact, and the failure never throws.
 */
export function FileBrowserTree({
  cwd,
  decorations = NO_DECORATIONS,
  sessionId,
}: {
  cwd: string;
  /** Git marks for changed files and the folders above them, keyed
   * cwd-relative — see {@link TreeDecorations}. */
  decorations?: TreeDecorations;
  sessionId: string;
}) {
  const expandedDirs = useChanges(
    (s) => s.expandedDirs[sessionId] ?? EMPTY_EXPANDED_DIRS
  );
  const toggleDir = useChanges((s) => s.toggleDir);
  const selectFile = useChanges((s) => s.selectFile);
  const pruneExpandedDirsUnder = useChanges((s) => s.pruneExpandedDirsUnder);
  const collapseAllDirs = useChanges((s) => s.collapseAllDirs);
  const expandToPath = useChanges((s) => s.expandToPath);
  // The file open in the viewer — the tree's one selected row.
  const selectedFile = useChanges((s) => s.ui[sessionId]?.selectedFile);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // A selection whose row should be scrolled into view once it is rendered —
  // its folders may still be loading when the selection lands.
  const pendingScrollRef = useRef<string | undefined>(undefined);
  // Narrow selectors — each only re-renders the tree when *this session's*
  // live dirty path or stashed drafts actually change, not on every other
  // session's edit. See `ChangesState.dirtyFiles`/`fileDrafts`.
  const dirtyPath = useChanges((s) => s.dirtyFiles[sessionId]);
  const drafts = useChanges((s) => s.fileDrafts[sessionId]);
  const [listings, setListings] = useState<Record<string, DirListing>>({});
  // The tree-wide open naming row (New File, New Folder, and Rename all share
  // it) and the pending context menu — see {@link Draft}/{@link PendingMenu}.
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [menu, setMenu] = useState<PendingMenu | undefined>(undefined);
  // The delete waiting on its confirm dialog, and the standing "that file has
  // unsaved edits" refusal — the one thing this menu says no to outright.
  const [confirming, setConfirming] = useState<PendingDelete | undefined>(
    undefined
  );
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  // Focuses the draft row's `<input>` on every `draft` change — opening one,
  // and a rejected commit adding its `error` — see `draftRow`'s doc comment
  // for why the JSX itself can't just carry `autoFocus`. Typing in the
  // (uncontrolled) input never touches `draft`, so this never re-runs mid-
  // keystroke; re-focusing an element that already has focus is a documented
  // no-op, so re-running it on the `error` update costs nothing.
  //
  // Choosing "New File" runs the item's `onSelect` (opens this draft) and
  // then `ContextMenu`'s own `onClose` (unmounts it, restoring focus to
  // whatever was focused before it opened) in one click handler — both state
  // updates land in the same commit. React flushes every unmounting
  // component's passive-effect *cleanup* across the whole commit (the menu's
  // focus restore) before any passive effect's own *setup* runs (this one),
  // so this reliably runs — and focuses — after that restore, not before it.
  useEffect(() => {
    if (draft) {
      draftInputRef.current?.focus();
    }
  }, [draft]);
  // Rename seeds the row with the existing name and selects its *stem*, so the
  // first keystroke replaces the name and keeps the extension — VS Code's own
  // behaviour, and the reason Rename is worth seeding at all rather than
  // opening blank. `setSelectionRange` on the input itself, never the document
  // Selection API: per the `webkit-input-caret-anchors-outside-field` finding,
  // reaching for the latter is what kills the caret in WKWebView.
  //
  // Keyed on the name being renamed (plus its parent directory — see below),
  // not on `draft` itself, for two reasons: a rejected rename's `error` update
  // must not re-select over what the user has since retyped, and neither must
  // an unrelated re-render. Declared after the focus effect above so it runs
  // after it — focusing an input can move its selection, so the order is
  // load-bearing.
  //
  // `renamingParentDir` has to be in this key too. Right-clicking a different
  // row to open a second `Rename…` first blurs whatever draft row is already
  // open — the new context menu steals focus to its own first item — which
  // ordinarily cancels an unchanged, uncommitted rename outright (see
  // `commitRename`'s early-exit branch below) and so re-runs this effect via
  // the intervening `undefined`. But when the first rename is already in
  // flight (Enter pressed, not yet resolved — see `commitRename`'s
  // `committingRef` guard, shared with `commitDraft`), that blur is a no-op:
  // `draft` swaps directly from the old rename to the new one with no
  // intervening `undefined`. `draftRow` still mounts a brand-new `<input>` in
  // a different directory's subtree (a real unmount/mount, not a reconciled
  // node), but `renaming` reads `"a.ts"` both times, so keyed on the name
  // alone, that "no change" read as "nothing to do" and the new input's
  // selection was left at the browser's default, never the stem.
  const renamingName = draft?.renaming;
  const renamingParentDir = draft?.parentDir;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `renamingParentDir` is a re-run trigger, not a value the body reads — see the comment above.
  useEffect(() => {
    if (renamingName === undefined) {
      return;
    }
    draftInputRef.current?.setSelectionRange(0, stemEnd(renamingName));
  }, [renamingName, renamingParentDir]);
  // Set for the duration of one create call, so a second commit attempt
  // (Enter followed by a blur before the first resolves) is a no-op instead
  // of a duplicate `createFile`/`createDir` — see `commitDraft`.
  const committingRef = useRef(false);

  // CRITICAL fix (round-1 review): nothing else clears `draft`/`menu` when
  // `cwd`/`sessionId` change. Without this, a draft opened against one
  // session survives a switch to another — same `key` (its `parentDir`
  // didn't change), so React reuses the very same `<input>` DOM node rather
  // than remounting it, and every handler on it is a fresh closure over
  // *this* render's (new) `cwd`/`sessionId`. Pressing Enter on that
  // still-focused, still-mounted row then commits into the NEW repo:
  // `createFile("/repoB", "oops.txt")` from a name typed while looking at
  // `/repoA`. The `gen` guard in `commitDraft`/`fetchDir` can't catch this on
  // its own — `gen` is captured at commit time, by which point it already
  // equals the new generation.
  // A pending *delete* is the same trap one step more destructive: the
  // dialog's "Move to Trash" closes over nothing, so a confirm left standing
  // across a switch would call `deleteEntry` with the NEW `cwd` and the OLD
  // path, trashing a file in a repository the user never looked at. The
  // refusal notice goes too — it describes an entry in the previous tree.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cwd`/`sessionId` are reset triggers, not values read in the body — the row's own handlers are what close over them.
  useEffect(() => {
    setDraft(undefined);
    setMenu(undefined);
    setConfirming(undefined);
    setRefusal(undefined);
  }, [cwd, sessionId]);

  // A file opened from anywhere (the Changes list's edit button, the
  // Inspector, the toolbar's New file) is shown in the tree the way an
  // editor's explorer follows the open file: its folders open and its row
  // scrolls into view. Only on a *change* of selection, so a folder the user
  // closes afterwards stays closed. A path outside the session folder
  // (`../…`) has no row here.
  useEffect(() => {
    if (selectedFile === undefined || selectedFile.startsWith("../")) {
      return;
    }
    expandToPath(sessionId, selectedFile);
    pendingScrollRef.current = selectedFile;
  }, [expandToPath, selectedFile, sessionId]);

  // Guards every `listDir` callback below against a genuinely stale `cwd`
  // (component unmounted, or the caller passed a new `cwd`). A generation
  // counter, not a shared boolean: the root effect below bumps `genRef` once
  // per `cwd` it runs for and each callback captures that value at call time,
  // then compares it against `genRef.current` before touching state. A
  // shared boolean can't tell "this cwd" from "some other cwd" apart — on a
  // `cwd` change React runs the old effect's cleanup and the new effect's
  // body back to back, and with one shared flag the new effect's `= false`
  // would un-cancel the OLD cwd's still-in-flight calls too, letting their
  // stale entries land in the NEW cwd's `listings`. This is also
  // deliberately NOT a per-effect-run local flag: the expansion effect below
  // re-runs on every landed listing or newly expanded directory, and a local
  // `cancelled` flag closed over each run would cancel every *other*
  // still-in-flight `listDir` call on each of those re-runs, discarding
  // completed backend work and forcing a refetch on the next run — the exact
  // multiplication bug this ref avoids.
  const genRef = useRef(0);
  // Directories with a `listDir` call currently in flight for the current
  // `cwd` — checked alongside `listings` (a call that's already landed) so a
  // re-render triggered by an unrelated expansion or a sibling listing
  // landing never re-issues a request that's already on its way.
  const inFlightRef = useRef<Set<string>>(new Set());
  // Directories a revalidation wanted to re-list but couldn't, because a call
  // for them was already in flight — see the revalidation effect below for
  // why that call's result can't be trusted as fresh. Drained by
  // {@link fetchDir}'s own completion, so exactly one trailing re-list is
  // issued no matter how many refreshes landed during the wait.
  const pendingRevalRef = useRef<Set<string>>(new Set());

  // One directory's `listDir` call, landing (or erroring) into `listings`
  // only while `gen` is still the current `cwd`'s generation. Shared by all
  // three effects below — the root fetch, the lazy expansion fetch, and the
  // revalidation fetch — so the staleness guard and the in-flight
  // bookkeeping can never be applied one way in one of them and another way
  // in the next. Merges into `listings` rather than replacing it: a sibling
  // directory's listing (or the root's own) may land in either order.
  const fetchDir = useCallback(
    function run(dir: string, gen: number) {
      // The generation check comes FIRST, before any bookkeeping — including
      // the `inFlightRef` add below. `commitRename`/`commitDelete` (Task 6)
      // deliberately call `fetchDir(dir, oldGen)` from their own stale
      // closures no matter how much later they resolve (the mutation really
      // did happen in that repo). Without this early return, that stale call
      // still marked `dir` as in-flight for whatever `cwd` is CURRENT by
      // then, and `settle`'s own `gen` check bailed before ever removing it —
      // leaving `dir` "in flight" forever: the expansion effect skips it and
      // every revalidation just parks itself in `pendingRevalRef`, which only
      // this call's own `settle` drains. See
      // "a rename that resolves after a session switch does not freeze the
      // new session's tree" in FileBrowserTree.test.tsx.
      if (genRef.current !== gen) {
        return;
      }
      inFlightRef.current.add(dir);
      const settle = (listing: DirListing) => {
        // Re-checked here too: `gen` was current when `run` started, but a
        // `cwd` change can land while THIS call is still in flight.
        if (genRef.current !== gen) {
          return;
        }
        inFlightRef.current.delete(dir);
        setListings((prev) => ({ ...prev, [dir]: listing }));
        // A revalidation that arrived while this call was in flight parked
        // itself here rather than piling a second request on top; now that
        // the pre-change snapshot has landed, honour it exactly once.
        if (pendingRevalRef.current.delete(dir)) {
          run(dir, gen);
        }
      };
      listDir(cwd, dir)
        .then(settle)
        .catch((err) => settle({ error: errorMessage(err) }));
    },
    [cwd]
  );

  // Root fetch: once per `cwd`. Resets everything (including the in-flight
  // tracking above) so a session switch never shows a stale tree or leaves a
  // previous `cwd`'s bookkeeping behind.
  useEffect(() => {
    genRef.current += 1;
    const gen = genRef.current;
    inFlightRef.current = new Set();
    pendingRevalRef.current = new Set();
    setListings({});
    fetchDir("", gen);
    // `fetchDir`'s identity changes exactly when `cwd` does, so it alone is
    // the "new cwd" trigger (listing `cwd` too is a redundant dependency).
  }, [fetchDir]);

  // Fetch every currently-expanded directory that has no listing yet and no
  // fetch already in flight (fresh expansion, or a directory re-discovered
  // after the root reset above). Directories already collapsed-then-
  // re-expanded are already in `listings` and are skipped — see the
  // laziness tests in FileBrowserTree.test.tsx for the exact call-count
  // contract. Deliberately has no cleanup that cancels these calls on
  // re-run: `genRef` (bumped only by the root effect above, once per `cwd`)
  // is the only thing that ever cancels a `listDir` call started here, so
  // expanding a second directory before the first resolves costs exactly one
  // call per directory, never a discard-and-refetch of the first.
  useEffect(() => {
    const gen = genRef.current;
    const pending = Object.keys(expandedDirs).filter(
      (dir) =>
        expandedDirs[dir] && !(dir in listings) && !inFlightRef.current.has(dir)
    );
    for (const dir of pending) {
      fetchDir(dir, gen);
    }
  }, [expandedDirs, listings, fetchDir]);

  // Revalidation: re-list what's on screen whenever a diff refresh actually
  // lands for this session. Without it this tree is a photograph — its
  // listings were reset only on a `cwd` change, and this pane is
  // display-toggled, never unmounted (see `ChangesView`), so a file Claude
  // created mid-session could never be found here and a deleted one left a
  // ghost row that opens `FileViewer`'s error state.
  //
  // Deciding *when* one has landed — a genuine bump, never the epoch already
  // sitting on the store when this lazily-mounted tab first rendered — is
  // {@link useRevalidateOn}'s job, shared with the [File editor]'s own
  // revalidation. What stays here is what a revalidation costs, which is this
  // tree's own business:
  // - Only the root and *currently expanded* directories are re-listed —
  //   the laziness contract holds, an unexpanded directory is never walked.
  //   `expandedDirs` is read off the store rather than watched reactively for
  //   exactly that reason: as a dependency, every expansion would re-run this
  //   and re-list the whole open tree.
  // - A directory whose call is still in flight when the next 500ms live-edit
  //   refresh lands is not re-issued (the `inFlightRef` check below) — the
  //   cost stays one call per open directory per landed refresh, never a
  //   pile-up. It is not simply dropped either: that in-flight call started
  //   *before* the change this refresh is reporting, so its result is a
  //   pre-change snapshot, and letting it stand left the tree stale (a file
  //   Claude just created missing, a deleted one still listed) until some
  //   unrelated later refresh happened to catch it. It parks in
  //   `pendingRevalRef` instead, and `fetchDir` re-lists it once — however
  //   many refreshes landed during the wait — the moment the in-flight call
  //   completes.
  useRevalidateOn(sessionId, () => {
    const gen = genRef.current;
    const expanded = useChanges.getState().expandedDirs[sessionId] ?? {};
    const dirs = new Set([
      "",
      ...Object.keys(expanded).filter((dir) => expanded[dir]),
    ]);
    for (const dir of dirs) {
      if (inFlightRef.current.has(dir)) {
        pendingRevalRef.current.add(dir);
      } else {
        fetchDir(dir, gen);
      }
    }
  });

  // Where a create started from a given row lands: inside a folder, or
  // beside a file. Matches VS Code, and is the only place that decision is
  // made. Rename and Delete deliberately do NOT go through it — they act on
  // `menu.entry` itself, wherever it already sits.
  function targetDirFor(
    entry: { isDir: boolean; path: string } | undefined,
    dir: string
  ): string {
    if (!entry) {
      return dir;
    }
    return entry.isDir ? entry.path : dir;
  }

  // A directory row's own click. Collapsing a folder hides everything inside
  // it, an open draft row included — but the `draft` state itself used to
  // survive, so re-expanding resurrected a naming row the user had visibly
  // walked away from: blank, and stealing focus back off whatever they were
  // doing. A collapse is a dismissal. Collapsing an *ancestor* counts too,
  // since it hides the row just as completely.
  function toggleDirRow(path: string): void {
    const collapsing = expandedDirs[path] === true;
    if (collapsing && draft !== undefined && isWithin(draft.parentDir, path)) {
      setDraft(undefined);
    }
    toggleDir(sessionId, path);
  }

  // Opens the draft row for a create, expanding its target folder first if
  // needed — the row has to be visible to be typed into. Reads
  // `expandedDirs` off the store rather than the narrowed selector above so
  // this never stales on a directory this render's selector hasn't observed
  // yet.
  function openDraft(kind: "file" | "dir", parentDir: string): void {
    if (parentDir !== "") {
      const expanded = useChanges.getState().expandedDirs[sessionId] ?? {};
      if (expanded[parentDir] !== true) {
        toggleDir(sessionId, parentDir);
      }
    }
    setDraft({ kind, parentDir });
  }

  // Commits the open draft: an empty (or all-whitespace) name quietly
  // cancels rather than asking the backend to create something unnamed. A
  // rejection (e.g. "already exists") stays open with the typed name intact
  // — see the draft row's own doc comment for why that matters more here
  // than a toast would.
  function commitDraft(name: string): void {
    // The in-flight guard, not just the `undefined` check above: without it,
    // Enter (starts a create) followed by a blur before it resolves fires a
    // second, identical `createFile`/`createDir` call — the blur's handler
    // still sees a defined, not-yet-cleared `draft`.
    if (draft === undefined || committingRef.current) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed === "") {
      setDraft(undefined);
      return;
    }
    // MINOR 7 (final review): caught here, not just left to the backend.
    // `SandboxRoot::resolve_new` already refuses a leaf containing `/` (it
    // would smuggle a parent segment past the create's own leaf rule), but
    // its refusal is `WRITE_MISSING_ERROR` — "path does not exist" — because
    // that is what the *parent half* of a multi-segment name resolves to.
    // Typing `a/b.ts` into New File reached the backend and came back with
    // that string, which does not tell the user what they actually did
    // wrong. Refusing it here, with a message that names the real problem,
    // keeps the row open with the typed text intact — same as every other
    // refusal this row shows.
    if (trimmed.includes("/")) {
      setDraft({ ...draft, error: "name must not contain a path separator" });
      return;
    }
    const path = childPath(draft.parentDir, trimmed);
    const gen = genRef.current;
    committingRef.current = true;
    const run =
      draft.kind === "file" ? createFile(cwd, path) : createDir(cwd, path);
    run
      .then(() => {
        committingRef.current = false;
        // A `cwd`/`sessionId` change already clears `draft` synchronously
        // (see the effect above), but this call's own promise keeps running
        // regardless and still closes over the OLD `sessionId`/`path` — so
        // without this check, a create that resolves after the switch would
        // still re-list the (now-irrelevant) old directory, refresh the old
        // session, and select/expand into it. `fetchDir` already guards
        // itself the same way; this just extends that guard to cover this
        // whole success branch, per round-1 review.
        if (genRef.current !== gen) {
          return;
        }
        // Only the row this create came from: a rename opened while the
        // create was in flight is a newer row, and clearing it here threw
        // away what the user had just asked for.
        setDraft((d) => (d === draft ? undefined : d));
        fetchDir(draft.parentDir, gen);
        requestRefresh(sessionId, "manual");
        if (draft.kind === "file") {
          selectFile(sessionId, path);
        } else {
          toggleDir(sessionId, path);
        }
      })
      .catch((error: unknown) => {
        committingRef.current = false;
        setDraft((d) => (d ? { ...d, error: errorMessage(error) } : d));
      });
  }

  // Does *this* session hold work the editor has not written to disk at or
  // under `path`? Both halves of the tree's dirty signal count, the same two
  // `ChangesState` documents: the live editor's dirty path and a draft
  // stashed when its pane was evicted. `isWithin` rather than equality
  // because trashing `src/` destroys the unsaved draft in `src/a.ts` exactly
  // as trashing the file itself would, and the confirm dialog says nothing
  // about unsaved work.
  function unsavedEditsHere(path: string): boolean {
    if (dirtyPath && isWithin(dirtyPath, path)) {
      return true;
    }
    return Object.keys(drafts ?? {}).some((draftPath) =>
      isWithin(draftPath, path)
    );
  }

  // Every OTHER session `useSessions` can confirm is working in this same
  // `cwd` — not just this one's own render, since this component is one tab
  // among however many sessions the user has open on the same checkout.
  // `getState()`, not a subscribed selector: this is consulted from click
  // handlers and the pre-delete guard below, never read during render.
  //
  // MINOR 3 (final review): archived sessions are excluded, matching
  // `isWorkingSession` (`src/state/sessions.ts`) — archiving does not clear
  // `dirtyFiles`/`fileDrafts`, so a leftover draft in a session the user
  // archived and can no longer see would otherwise refuse a rename/delete
  // while naming a session that isn't there to save it in.
  function otherSessionIdsSharingCwd(): string[] {
    const { sessions } = useSessions.getState();
    return Object.keys(sessions).filter(
      (id) =>
        id !== sessionId &&
        sessions[id].archivedAt === null &&
        sessionWorkingDir(sessions[id]) === cwd
    );
  }

  // Does some OTHER session sharing this checkout hold unsaved work at or
  // under `path`? This user routinely runs several Kriyon sessions against
  // one shared checkout, so a dirty file in session B is exactly as real a
  // hazard to a delete/rename in session A as A's own dirty state — the
  // folder still goes to the Trash, and B's draft is orphaned. `useSessions`
  // can tell us which sessions share `cwd`, so the scan is scoped to those
  // rather than every session in the app.
  function unsavedEditsElsewhere(path: string): boolean {
    const others = otherSessionIdsSharingCwd();
    if (others.length === 0) {
      return false;
    }
    const state = useChanges.getState();
    return others.some((id) => {
      const otherDirty = state.dirtyFiles[id];
      if (otherDirty && isWithin(otherDirty, path)) {
        return true;
      }
      const otherDrafts = state.fileDrafts[id];
      return Object.keys(otherDrafts ?? {}).some((draftPath) =>
        isWithin(draftPath, path)
      );
    });
  }

  function hasUnsavedEdits(path: string): boolean {
    return unsavedEditsHere(path) || unsavedEditsElsewhere(path);
  }

  // Opens the context menu at the pointer. Shared by all three right-click
  // surfaces (folder row, file row, empty area) so the refusal notice is
  // cleared in exactly one place: it belongs to the action that earned it, and
  // the next right-click is the user moving on.
  //
  // MINOR 6 (final review): spec §6 says right-clicking a row selects it,
  // matching a left-click's own effect — this tree's only notion of
  // "selected" is `selectedFile` (the file open in the [File viewer]), so
  // only a *file* row has anything to select. A folder row's right-click
  // still opens the menu targeting it (via `entry`, below); selecting it
  // would mean asking the viewer to open a directory as a file, which is not
  // what the spec is describing.
  function openMenu(
    event: MouseEvent<HTMLElement>,
    dir: string,
    entry?: { isDir: boolean; path: string }
  ): void {
    event.preventDefault();
    setRefusal(undefined);
    setMenu({ at: { x: event.clientX, y: event.clientY }, dir, entry });
    if (entry !== undefined && !entry.isDir) {
      selectFile(sessionId, entry.path);
    }
  }

  // MINOR 2 (final review): the companion cleanup to `pruneExpandedDirsUnder`
  // — a stale `listings[oldPath]` entry left behind by a rename/delete is
  // more than clutter. If a directory later lands at that exact same literal
  // path again (a new folder given the old name, or a rename that happens to
  // land back on it), the expansion effect's `!(dir in listings)` guard would
  // find the stale entry already sitting there and skip fetching the new
  // directory's actual contents, showing the OLD one's listing forever.
  //
  // Gen-guarded, unlike `pruneExpandedDirsUnder`: `expandedDirs` is keyed by
  // `sessionId`, so pruning it is correct no matter which session is on
  // screen by the time the caller's mutation resolves. `listings` is not
  // keyed at all — it is the single cache for whichever `cwd` is *currently*
  // mounted — so if a `cwd` change has already landed, the root effect
  // already reset it to `{}` and there is nothing here that could still be
  // stale; pruning it anyway with a since-abandoned `path` string risks
  // deleting an entry that coincidentally shares that name in the new repo.
  function pruneListingsUnder(path: string, gen: number): void {
    if (genRef.current !== gen) {
      return;
    }
    setListings((prev) => {
      let changed = false;
      const next: Record<string, DirListing> = {};
      for (const [dir, listing] of Object.entries(prev)) {
        if (isWithin(dir, path)) {
          changed = true;
        } else {
          next[dir] = listing;
        }
      }
      return changed ? next : prev;
    });
  }

  // Commits the open *rename*. Shares `committingRef` with `commitDraft` for
  // the same reason and then some: Enter fires the rename and also blurs the
  // input, and the second call would run `renameEntry` against a source path
  // that no longer exists. An unchanged or empty name closes the row rather
  // than asking the backend to rename a file to what it is already called.
  function commitRename(name: string): void {
    const renaming = draft?.renaming;
    if (
      draft === undefined ||
      renaming === undefined ||
      committingRef.current
    ) {
      return;
    }
    const { parentDir } = draft;
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === renaming) {
      setDraft(undefined);
      return;
    }
    const from = childPath(parentDir, renaming);
    const to = childPath(parentDir, trimmed);
    const gen = genRef.current;
    committingRef.current = true;
    renameEntry(cwd, from, trimmed)
      .then(() => {
        committingRef.current = false;
        // Deliberately NO `genRef.current !== gen` guard here, unlike
        // `commitDraft`'s. That guard exists to stop a create from
        // expanding/selecting a path inside a session the user has since
        // left — but a rename really did happen in THIS repo, under
        // whichever session started it, no matter which session or `cwd` is
        // on screen by the time the backend answers. `fetchDir(parentDir,
        // gen)` still passes `gen` through and stays self-guarding (it
        // no-ops into a stale `listings` otherwise); what's gone is the
        // outer check that used to also swallow `requestRefresh` and
        // `selectFile` below — both name `sessionId` explicitly, so running
        // them late is correct, not stale. Skipping them left the OLD
        // session's viewer open on a path a *later* switch's rename had
        // already moved. If you're tempted to restore this guard: don't —
        // that regression is exactly what removing it fixed.
        setDraft(undefined);
        fetchDir(parentDir, gen);
        requestRefresh(sessionId, "manual");
        // MINOR 2: the old path is gone under its old name — drop whatever
        // the tree still remembers about it, at or below `from`, before
        // anything (a later revalidation, a same-named folder created next)
        // can trip over the leftovers. `pruneExpandedDirsUnder` is keyed by
        // `sessionId` like `requestRefresh`/`selectFile` above, so it is
        // correct to run late too; `pruneListingsUnder` is its own
        // self-guarding twin of `fetchDir` for the reason its own doc comment
        // gives.
        pruneExpandedDirsUnder(sessionId, from);
        pruneListingsUnder(from, gen);
        // The viewer follows the file. `isWithin`, not equality, because
        // renaming a *folder* moves the open file just as surely — and leaves
        // the viewer on a path that no longer exists — even though the folder
        // itself was never what was open.
        const open = useChanges.getState().ui[sessionId]?.selectedFile;
        if (open !== undefined && isWithin(open, from)) {
          selectFile(sessionId, to + open.slice(from.length));
        }
      })
      .catch((error: unknown) => {
        committingRef.current = false;
        setDraft((d) => (d ? { ...d, error: errorMessage(error) } : d));
      });
  }

  // Runs the confirmed delete. No `committingRef` guard: the dialog is
  // dismissed before the call goes out, so there is no second click to guard
  // against.
  function commitDelete(): void {
    const pending = confirming;
    if (pending === undefined) {
      return;
    }
    setConfirming(undefined);
    // Re-checked, not trusted from when the menu item was clicked: the
    // confirm dialog is modal, but the window it was open for is long enough
    // for either this session or — the more likely case — another session
    // sharing this checkout to go dirty on this exact path. Cheap insurance
    // on an action `deleteEntry` cannot undo.
    if (hasUnsavedEdits(pending.path)) {
      refuse(pending, "deleting");
      return;
    }
    const gen = genRef.current;
    deleteEntry(cwd, pending.path)
      .then(() => {
        // Deliberately NO `genRef.current !== gen` guard here, unlike
        // `commitDraft`'s — see the matching comment in `commitRename`'s
        // `.then()`. The delete really did happen in THIS repo; suppressing
        // `requestRefresh`/`selectFile` below just because the user has since
        // switched sessions left the OLD session's viewer open on a path that
        // had already been trashed.
        fetchDir(pending.dir, gen);
        requestRefresh(sessionId, "manual");
        // MINOR 2: same cleanup as `commitRename`'s — see its comment above.
        pruneExpandedDirsUnder(sessionId, pending.path);
        pruneListingsUnder(pending.path, gen);
        const open = useChanges.getState().ui[sessionId]?.selectedFile;
        if (open !== undefined && isWithin(open, pending.path)) {
          selectFile(sessionId, undefined);
        }
      })
      // A destructive action that quietly fails is worse than one that fails
      // loudly — the same call, and the same toast, `DiscardFileChanges`
      // makes. Nothing changed on screen, so there is no inline row to hang
      // the message off.
      .catch((error: unknown) => showToast(errorMessage(error), "error"));
  }

  // The refusal's wording. A folder's own name is not what is dirty —
  // something inside it is — so the two cases cannot share one sentence
  // without one of them lying. And when the only reason this is refused is
  // another session's unsaved work, the message says so — this session has
  // nothing to save, so "save it before renaming" would send the user
  // looking in the wrong place.
  function refuse(entry: { isDir: boolean; path: string }, verb: string): void {
    const name = baseName(entry.path);
    if (!unsavedEditsHere(entry.path) && unsavedEditsElsewhere(entry.path)) {
      setRefusal(
        entry.isDir
          ? `${name} contains unsaved edits in another session — save them there before ${verb}.`
          : `${name} has unsaved edits in another session — save it there before ${verb}.`
      );
      return;
    }
    setRefusal(
      entry.isDir
        ? `${name} contains unsaved edits — save them before ${verb}.`
        : `${name} has unsaved edits — save it before ${verb}.`
    );
  }

  // Open/reveal failures surface the same way: the bridge treats errors as
  // strings, and nothing on screen changes when the OS call fails, so a toast
  // is the only honest outcome — exactly the delete failure's arrangement.
  function reportFailure(promise: Promise<void>): void {
    promise.catch((error: unknown) => showToast(errorMessage(error), "error"));
  }

  function menuItems(pending: PendingMenu): ContextMenuItem[] {
    const into = targetDirFor(pending.entry, pending.dir);
    const items: ContextMenuItem[] = [
      { label: "New file", onSelect: () => openDraft("file", into) },
      { label: "New folder", onSelect: () => openDraft("dir", into) },
    ];
    const { entry } = pending;
    // The empty area below the tree has no entry to act on — only the two
    // creates apply there.
    if (entry === undefined) {
      return items;
    }
    // Where the entry lives / what it's called — the block every file
    // explorer puts between the creates and the destructive pair. Open in
    // Editor is file-only: `open_in_editor`'s trust boundary only resolves
    // files, and "edit a folder" has no meaning here anyway.
    if (!entry.isDir) {
      items.push({
        label: "Open in editor",
        onSelect: () => reportFailure(openInEditor(cwd, entry.path)),
        separatorBefore: true,
      });
    }
    items.push({
      label: "Reveal in Finder",
      onSelect: () => reportFailure(revealPath(cwd, entry.path)),
      separatorBefore: entry.isDir,
    });
    items.push({
      label: "Copy path",
      onSelect: () => copyPath(`${cwd}/${entry.path}`),
    });
    items.push({
      label: "Copy relative path",
      onSelect: () => copyPath(entry.path),
    });
    const { dir } = pending;
    items.push({
      label: "Rename",
      separatorBefore: true,
      onSelect: () => {
        // Refused, not asked: throwing away an unsaved draft is a data loss
        // the user did not ask for, and Save-then-rename is one keystroke
        // away. The only place this feature says no outright.
        if (hasUnsavedEdits(entry.path)) {
          refuse(entry, "renaming");
          return;
        }
        setDraft({
          kind: entry.isDir ? "dir" : "file",
          parentDir: dir,
          renaming: baseName(entry.path),
        });
      },
    });
    items.push({
      danger: true,
      label: "Delete",
      onSelect: () => {
        if (hasUnsavedEdits(entry.path)) {
          refuse(entry, "deleting");
          return;
        }
        setConfirming({ dir, isDir: entry.isDir, path: entry.path });
      },
    });
    return items;
  }

  // The inline naming row's element(s) for `dir` at `depth` — an empty array
  // when no draft targets this directory, so every call site can simply
  // spread the result onto whatever it's already returning.
  //
  // Deliberately a plain function returning host elements (`<div>`,
  // `<input>`, always the same string `type`), never a locally-defined
  // component: a `function DraftRow() {...}` declared inside this render
  // would be a *new* function identity every time `FileBrowserTree`
  // re-renders, and React remounts a child whose element `type` changed even
  // when its `key` didn't — wiping the `<input>`'s live, uncontrolled value
  // (the typed name) on the very next unrelated re-render, e.g. a sibling
  // directory's listing landing. Host-element types don't have that problem:
  // the same `key` here keeps reconciling into the same DOM node across
  // renders, which is what lets a rejected create (`draft.error` changing)
  // keep the typed name on screen instead of blanking it.
  //
  // Called by `renderDir` at all three of its outcomes for `dir` (loading,
  // errored, landed) — never only after a landed listing's own rows. "New
  // File" on a *collapsed* folder expands it as part of opening the draft,
  // so the very next render has that folder's listing absent (`Loading…`);
  // appending the row only inside the landed-listing branch would mean it
  // never appears on that path, which is the feature's main path, not an
  // edge case.
  function draftRow(dir: string, depth: number) {
    if (draft?.parentDir !== dir) {
      return [];
    }
    // Whichever flow this row is open for. Both take the typed name, share
    // `committingRef`, and clear the draft once they are done with it.
    const commit = draft.renaming === undefined ? commitDraft : commitRename;
    return [
      // The key carries the name being renamed, so switching this row from a
      // create to a rename (or between two renames) genuinely remounts the
      // `<input>` and re-seeds its `defaultValue`. Without that the same
      // uncontrolled node is reconciled through and keeps the *previous*
      // flow's typed text — reachable whenever a create is still in flight,
      // since `commitDraft`'s in-flight guard returns without clearing the
      // draft, so the blur a right-click fires leaves the create's row open
      // and Enter would then rename the file to a name typed for something
      // else entirely. `error` is not in the key: a rejected commit must keep
      // the typed name on screen, which is the whole point of the stable node.
      <div key={`${dir}:draft:${draft.renaming ?? ""}`} style={treeRow()}>
        <Guides depth={depth} />
        <span style={chevronSlotStyle} />
        <span style={iconSlotStyle}>
          {draft.kind === "dir" ? (
            <DirIcon open={false} />
          ) : (
            <FileIcon path="" />
          )}
        </span>
        <input
          data-testid="file-browser-draft"
          defaultValue={draft.renaming ?? ""}
          onBlur={(e) => {
            // Blur-after-error is a dismissal, not a retry. Committing
            // unconditionally here meant a rejected name re-fired the
            // identical, identically-failing create on every click away —
            // and left no way to abandon the row but Escape, a keystroke
            // nothing on screen advertises.
            if (draft.error === undefined) {
              commit(e.currentTarget.value);
              return;
            }
            setDraft(undefined);
          }}
          onChange={() => {
            // A rejection belongs to the name that earned it: without this,
            // "already exists" stayed on screen under a field the user had
            // since retyped. Guarded, so an error-free keystroke — the
            // common case — never re-renders the tree; the input stays
            // uncontrolled either way, so clearing the error leaves what's
            // typed exactly where it is.
            if (draft.error !== undefined) {
              setDraft((d) =>
                d === undefined ? d : { ...d, error: undefined }
              );
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit(e.currentTarget.value);
            } else if (e.key === "Escape") {
              setDraft(undefined);
            }
          }}
          ref={draftInputRef}
          style={draftInputStyle}
        />
      </div>,
      draft.error === undefined ? null : (
        <div
          key={`${dir}:draft-error`}
          style={{ ...draftErrorStyle, ...indentStyle(depth) }}
        >
          {draft.error}
        </div>
      ),
    ];
  }

  // Scroll a pending selection's row into view once it exists. `nearest`, so
  // a row already on screen never moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `listings` is the re-run trigger — a landed folder may be the one holding the row.
  useEffect(() => {
    const target = pendingScrollRef.current;
    if (target === undefined) {
      return;
    }
    const row = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>("[data-row-path]") ?? []
    ).find((r) => r.dataset.rowPath === target);
    if (row) {
      pendingScrollRef.current = undefined;
      row.scrollIntoView?.({ block: "nearest" });
    }
  }, [listings, selectedFile]);

  // The toolbar's New file / New folder land where an editor's do: beside
  // the open file, or at the root when nothing is open.
  function toolbarTargetDir(): string {
    if (selectedFile === undefined || selectedFile.startsWith("../")) {
      return "";
    }
    return parentDir(selectedFile);
  }

  // A search result: a file opens in the viewer (the selection effect above
  // then reveals it in the tree); a folder opens in the tree and scrolls
  // into view.
  function openFromSearch(entry: FileEntry): void {
    if (!entry.isDir) {
      selectFile(sessionId, entry.path);
      return;
    }
    expandToPath(sessionId, entry.path);
    if (useChanges.getState().expandedDirs[sessionId]?.[entry.path] !== true) {
      toggleDir(sessionId, entry.path);
    }
    pendingScrollRef.current = entry.path;
  }

  // Collapsing everything hides any open naming row below the root too —
  // the same dismissal `toggleDirRow` applies to one folder.
  function collapseAll(): void {
    if (draft !== undefined && draft.parentDir !== "") {
      setDraft(undefined);
    }
    collapseAllDirs(sessionId);
  }

  // One folder row and its open subtree. Plain functions returning host
  // elements, not components, for the reason `draftRow` gives.
  function renderDirRow(entry: DirEntry, dir: string, depth: number) {
    const path = childPath(dir, entry.name);
    const expanded = expandedDirs[path] === true;
    const holdsChange = decorations.dirs.has(path);
    return (
      <div key={path}>
        <button
          aria-expanded={expanded}
          className="kr-hover-surface kr-tree-row"
          data-git={holdsChange ? "contains" : undefined}
          data-ignored={entry.ignored}
          data-row-dir="true"
          data-row-path={path}
          data-testid="file-browser-row"
          onClick={() => toggleDirRow(path)}
          onContextMenu={(e) => openMenu(e, dir, { isDir: true, path })}
          style={{
            ...treeRow(),
            ...(entry.ignored ? { color: ignoredInk } : {}),
          }}
          title={path}
          type="button"
        >
          <Guides depth={depth} />
          <span style={chevronSlotStyle}>
            <DirChevron open={expanded} />
          </span>
          <span style={iconSlotStyle}>
            <DirIcon open={expanded} />
          </span>
          <span style={nameStyle}>{entry.name}</span>
          {holdsChange ? (
            <span
              aria-label="Contains changes"
              role="img"
              style={changedDirDotStyle}
            />
          ) : null}
        </button>
        {expanded ? renderDir(path, depth + 1) : null}
      </div>
    );
  }

  function renderFileRow(entry: DirEntry, dir: string, depth: number) {
    const path = childPath(dir, entry.name);
    const isDirty = hasUnsavedEdits(path);
    const change = decorations.files.get(path);
    const selected = path === selectedFile;
    let ink: string | undefined;
    if (change) {
      ink = GIT_INK[change];
    } else if (entry.ignored) {
      ink = ignoredInk;
    }
    return (
      <button
        aria-current={selected ? "true" : undefined}
        className="kr-hover-surface kr-tree-row"
        data-git={change}
        data-ignored={entry.ignored}
        data-row-path={path}
        data-testid="file-browser-row"
        key={path}
        onClick={() => selectFile(sessionId, path)}
        onContextMenu={(e) => openMenu(e, dir, { isDir: false, path })}
        style={{ ...treeRow(selected), ...(ink ? { color: ink } : {}) }}
        title={change ? `${path} · ${GIT_LABEL[change]}` : path}
        type="button"
      >
        <Guides depth={depth} />
        {/* Files have no chevron, but keep its slot so names in one folder
            line up whether they are files or folders. */}
        <span style={chevronSlotStyle} />
        <span style={iconSlotStyle}>
          <FileIcon path={path} />
        </span>
        <span style={nameStyle}>{entry.name}</span>
        {/* An image, not a `role="status"` live region. One live region per
            row means expanding a directory announces "Unsaved changes"
            once per dirty file it reveals — the dot is a label on a row
            here, not a state change worth interrupting for. FileViewer's
            header keeps its single `role="status"` dot, which announces
            exactly one thing: the open file just became dirty. */}
        {isDirty ? (
          <span
            aria-label="Unsaved changes"
            data-testid="tree-dirty-dot"
            role="img"
            style={treeDirtyDotStyle}
          />
        ) : null}
        {change ? (
          <span aria-hidden style={gitLetterStyle(change)}>
            {GIT_LETTER[change]}
          </span>
        ) : null}
      </button>
    );
  }

  function renderDir(dir: string, depth: number) {
    const listing = listings[dir];
    // The open draft's row, appended after every one of this function's
    // outcomes below — not only the landed-listing one — so it shows
    // whether `dir`'s listing is still loading, errored, or landed. See
    // `draftRow`'s doc comment for why that matters on this feature's main
    // path.
    if (listing === undefined) {
      return [
        <div
          key={`${dir}:loading`}
          style={{ ...noteRowStyle, ...indentStyle(depth) }}
        >
          Loading…
        </div>,
        ...draftRow(dir, depth),
      ];
    }
    if (isError(listing)) {
      return [
        <div
          data-testid="file-browser-error"
          key={`${dir}:error`}
          style={{ ...errorRowStyle, ...indentStyle(depth) }}
        >
          Failed to load: {listing.error}
        </div>,
        ...draftRow(dir, depth),
      ];
    }
    // Directories first, then files, each alphabetical — the ordering every
    // file tree uses, and the one that makes a directory's children findable
    // without reading the whole listing. `listDir` returns the backend's own
    // order, which is neither.
    const sorted = [...listing].sort((a, b) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    const rows = sorted.map((entry) =>
      entry.isDir
        ? renderDirRow(entry, dir, depth)
        : renderFileRow(entry, dir, depth)
    );
    return [...rows, ...draftRow(dir, depth)];
  }

  return (
    <div data-testid="file-browser-tree" style={rootStyle}>
      <div style={toolbarStyle}>
        <span style={toolbarTitleStyle} title={cwd}>
          {folderName(cwd)}
        </span>
        <button
          aria-label="New file"
          className="kr-hover-surface"
          onClick={() => openDraft("file", toolbarTargetDir())}
          style={toolbarButtonStyle}
          title="New file"
          type="button"
        >
          <FilePlus size={14} strokeWidth={1.75} />
        </button>
        <button
          aria-label="New folder"
          className="kr-hover-surface"
          onClick={() => openDraft("dir", toolbarTargetDir())}
          style={toolbarButtonStyle}
          title="New folder"
          type="button"
        >
          <FolderPlus size={14} strokeWidth={1.75} />
        </button>
        <button
          aria-label="Refresh"
          className="kr-hover-surface"
          onClick={() => requestRefresh(sessionId, "manual")}
          style={toolbarButtonStyle}
          title="Refresh"
          type="button"
        >
          <RotateCw size={13} strokeWidth={1.75} />
        </button>
        <button
          aria-label="Collapse folders"
          className="kr-hover-surface"
          onClick={collapseAll}
          style={toolbarButtonStyle}
          title="Collapse folders"
          type="button"
        >
          <ChevronsDownUp size={14} strokeWidth={1.75} />
        </button>
      </div>
      <FileSearch cwd={cwd} decorations={decorations} onOpen={openFromSearch}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the arrow keys bubble up from the row buttons; this list is not a control of its own. */}
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: same — the rows are the controls. */}
        <div
          onKeyDown={(e) => {
            if (
              moveInTree(e, (path) => expandedDirs[path] === true, toggleDirRow)
            ) {
              e.preventDefault();
            }
          }}
          ref={scrollRef}
          style={scrollStyle}
        >
          <div style={listStyle}>{renderDir("", 0)}</div>
          {/* A drop target for the tree-wide "New File"/"New Folder" menu once
              the tree itself runs out of rows to right-click. Mouse-only by
              design, like a file explorer's blank pane: every row above already
              carries its own reachable, keyboard-operable button, and the
              toolbar carries both creates. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: passive right-click surface, not a control — see the comment above. */}
          {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: same — nothing here is reachable (or needs to be) by keyboard alone. */}
          <div
            data-testid="file-browser-empty-area"
            onContextMenu={(e) => openMenu(e, "")}
            style={emptyAreaStyle}
          />
        </div>
      </FileSearch>
      {refusal === undefined ? null : (
        <button
          data-testid="file-browser-refusal"
          onClick={() => setRefusal(undefined)}
          style={refusalStyle}
          title="Dismiss"
          type="button"
        >
          {refusal}
        </button>
      )}
      {menu ? (
        <ContextMenu
          at={menu.at}
          items={menuItems(menu)}
          label="File actions"
          onClose={() => setMenu(undefined)}
        />
      ) : null}
      {confirming ? (
        <ConfirmDialog
          backdropTestId="delete-entry-backdrop"
          body={
            confirming.isDir
              ? "The folder and everything in it moves to the Trash."
              : "The file moves to the Trash."
          }
          confirmLabel="Move to Trash"
          confirmTestId="confirm-delete-entry"
          label={`Keep ${baseName(confirming.path)}`}
          onCancel={() => setConfirming(undefined)}
          onConfirm={commitDelete}
          title={`Delete ${baseName(confirming.path)}?`}
        />
      ) : null}
    </div>
  );
}
