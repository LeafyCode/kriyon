import { Pencil } from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo } from "react";
// The per-file additions/deletions count is defined in the changes store,
// alongside the auto-collapse rule that also derives from it.
import {
  type FileTreeTab,
  fileDiffCounts,
  fileKind,
  isEditableFile,
} from "../state/changes.ts";
import { FILE_TREE_WIDTH_DEFAULT, useLayout } from "../state/layout.ts";
import { treeRow } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { FileChange, FileDiff } from "../types.ts";
import { ColumnResizeHandle } from "../ui/ColumnResizeHandle.tsx";
import { Segmented, type SegmentedOption } from "../ui/Segmented.tsx";
import { DirIcon, FileIcon } from "./fileIcon.tsx";

/** Stable empty default for the optional `dirtyPaths` prop — a fresh `new
 * Set()` per render would be a new identity every time, which is exactly
 * what this pane's memoization is built to avoid. */
const EMPTY_DIRTY_PATHS: ReadonlySet<string> = new Set();

/** A file plus its already-computed +/- counts and display bucket, so a
 * render never has to re-walk a file's hunks just to paint its row. */
interface FileTreeEntry {
  additions: number;
  deletions: number;
  file: FileDiff;
  kind: ReturnType<typeof fileKind>;
}

interface DirGroup {
  dir: string;
  files: FileTreeEntry[];
}

/**
 * Bucket files by parent directory (`""` = project root), sorted
 * alphabetically by directory path, files within a group sorted
 * alphabetically too — each paired with its `fileDiffCounts` result so the
 * (potentially expensive, whole-hunk-walking) count is computed exactly
 * once per file here rather than again during render. Renders as a flat
 * list of directory groups under a single implicit section — there is no
 * "This session" / "Other changes" attribution grouping; that would need
 * `touchedFiles`' absolute paths reconciled against a diff's repo-relative
 * ones, which nothing in this pane does today.
 */
function groupByDirectory(files: FileDiff[]): DirGroup[] {
  const byDir = new Map<string, FileTreeEntry[]>();
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : file.path.slice(0, slash);
    const entry: FileTreeEntry = {
      ...fileDiffCounts(file),
      file,
      kind: fileKind(file),
    };
    const bucket = byDir.get(dir);
    if (bucket) {
      bucket.push(entry);
    } else {
      byDir.set(dir, [entry]);
    }
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, groupFiles]) => ({
      dir,
      files: [...groupFiles].sort((a, b) =>
        a.file.path.localeCompare(b.file.path)
      ),
    }));
}

/** The part of a file's path shown in its row: just the basename within its
 * own directory group (the group header already carries the directory). A
 * renamed file (whether or not it also carries edits — git's `-M` emits both
 * shapes) shows `old → new` instead, since its old path has no entry of its
 * own anywhere in the changeset; only the old *basename* is used, because
 * this column is narrow and the row's `title` carries both full paths. */
function displayName(file: FileDiff, dir: string): string {
  const name = dir ? file.path.slice(dir.length + 1) : file.path;
  const oldPath = file.status === "renamed" ? file.oldPath : null;
  if (!oldPath) {
    return name;
  }
  return `${oldPath.slice(oldPath.lastIndexOf("/") + 1)} → ${name}`;
}

/** The row's hover title: the full `old → new` pair for a rename (whose old
 * path the row itself can only show a basename of), the full path otherwise
 * — the name above is truncated by the column's fixed width either way. */
function rowTitle(file: FileDiff): string {
  const oldPath = file.status === "renamed" ? file.oldPath : null;
  return oldPath ? `${oldPath} → ${file.path}` : file.path;
}

/** The column: user-resizable (its width lives in the layout), and not a
 * scroller itself — each tab scrolls its own list, so there is never a
 * scrollbar inside a scrollbar. */
function rootStyle(width: number): CSSProperties {
  return {
    borderRight: `1px solid ${tokens.color.line.soft}`,
    display: "flex",
    flex: "none",
    flexDirection: "column",
    fontFamily: tokens.font.sans,
    minHeight: 0,
    position: "relative",
    width: `${width}px`,
  };
}

/** The tree column's own 46px header, on the app-wide header rhythm, holding
 * nothing but the two tabs. */
const tabsRowStyle: CSSProperties = {
  alignItems: "center",
  borderBottom: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flex: "none",
  height: "46px",
  padding: `0 ${tokens.space.sm}`,
};

/**
 * The tree column's two tabs, on the shared `Segmented` primitive so they
 * keep its keyboard contract and test ids.
 */
const TREE_TABS = [
  { label: "Changes", testId: "file-tree-tab-changes", value: "changes" },
  { label: "All files", testId: "file-tree-tab-all", value: "all" },
] as const satisfies readonly SegmentedOption<FileTreeTab>[];

/** The Changes tab's scrolling list. */
const listStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "6px 4px",
};

/** Toggles one of this pane's two sub-panes (the "Changes" grouped list vs.
 * the "All files" tree passed in as `children`) without removing it from the
 * tree: a flex column that fills the pane while visible, `"none"` while
 * hidden. Keeping `FileBrowserTree` mounted while "Changes" is showing (and
 * vice versa) is what lets its listings cache survive a tab flip instead of
 * refetching everything on remount. */
function subPaneStyle(hidden: boolean): CSSProperties {
  return hidden
    ? { display: "none" }
    : { display: "flex", flex: 1, flexDirection: "column", minHeight: 0 };
}

/** A folder's heading in the Changes list — a quiet folder row, so the list
 * reads as the same tree the All-files tab shows, just pruned to what
 * changed. */
const dirLabelStyle: CSSProperties = {
  ...treeRow(),
  color: tokens.color.ink.muted,
  cursor: "default",
  fontSize: "12px",
  gap: "6px",
};

const dirLabelTextStyle: CSSProperties = {
  direction: "rtl",
  minWidth: 0,
  overflow: "hidden",
  textAlign: "left",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** One file's row: the jump button and the edit button side by side (a
 * button inside a button is invalid HTML and would swallow the edit click
 * as a jump click too). The row wears the hover, so the whole width lights. */
function rowWrapStyle(nested: boolean): CSSProperties {
  return {
    ...treeRow(),
    cursor: "default",
    padding: nested ? "0 4px 0 24px" : "0 4px 0 6px",
  };
}

const jumpButtonStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  display: "flex",
  flex: 1,
  font: "inherit",
  gap: "6px",
  height: "100%",
  minWidth: 0,
  padding: 0,
  textAlign: "left",
};

/** The row's edit button — quiet until wanted, like an editor's inline
 * actions. */
const editRowButtonStyle: CSSProperties = {
  alignItems: "center",
  background: "none",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.faint,
  cursor: "pointer",
  display: "flex",
  flex: "none",
  marginLeft: "2px",
  padding: "3px",
};

/** The unsaved-changes dot — the same dot the All-files tab shows. */
const treeDirtyDotStyle: CSSProperties = {
  background: tokens.color.status.waiting,
  borderRadius: "50%",
  flex: "none",
  height: "6px",
  width: "6px",
};

const fileNameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Mono, like every other count in the app: these are numbers, and in a
 * proportional face a `+9` and a `+11` don't line up down the column. */
const addCountStyle: CSSProperties = {
  color: tokens.color.add,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
};

const delCountStyle: CSSProperties = {
  color: tokens.color.del,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
};

/** How each kind of change colours a name — the All-files tab's colours, so
 * a file looks the same in both tabs. */
const GIT_INK: Record<FileChange, string> = {
  added: tokens.color.add,
  deleted: tokens.color.del,
  modified: tokens.color.mod,
  renamed: tokens.color.mod,
};

// Neutral (non-add/del) informational tag for the binary/empty buckets —
// the same vocabulary `DiffFileCard` and `ChangedFilesList` use for the same
// files, sized down for this column's rows.
const kindTagStyle: CSSProperties = {
  background: tokens.color.chip,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  flex: "none",
  fontSize: "9px",
  fontWeight: 700,
  letterSpacing: "0.06em",
  padding: "1px 5px",
  textTransform: "uppercase",
};

/**
 * The Code Changes View's left column: a directory-grouped tree of changed
 * files, each row showing its +/− counts — or, for a file with no lines to
 * count, the same binary/empty tag and `old → new` rename display the other
 * two file surfaces use (see {@link fileKind}). Clicking a row asks the caller to
 * jump the feed to that file's card — this pane owns no scrolling itself,
 * it only reports *which* file was picked (`onJumpToFile`), so the caller
 * can drive `DiffFeed`'s `scrollToFile` jump handle, the virtualizer-aware
 * mechanism it already exposes.
 *
 * There is deliberately no "N unchanged files hidden" count: the only
 * source available in Phase 1 (`listFiles`, the capped `@`-mention
 * completion listing) truncates before it finishes walking the tree, so any
 * count derived from it can be confidently wrong. An honest project-wide
 * count is backend work for a later phase.
 *
 * Which tab is active — "Changes" (this pane's own directory-grouped diff
 * list) or "All files" (Task 5's `list_dir`-backed browser) — is owned by
 * the `changes` store and passed in via `tab`/`onTabChange` rather than
 * local state, so a session switch or a jump from a sibling pane (the
 * Inspector) sees the same tab this pane shows. This pane always owns the
 * tabs row itself (so both tabs stay reachable no matter which is active).
 * Both sub-panes — this pane's own grouped list, and `children` (the
 * caller's `FileBrowserTree`) — are always rendered and merely
 * display-toggled by `tab` (see `subPaneStyle`), never swapped out via a
 * ternary: unmounting `FileBrowserTree` on every flip away from "all" would
 * drop its lazily-fetched listings cache and force a refetch of every
 * still-expanded directory on the next flip back. This pane stays free of a
 * direct dependency on that tab's implementation either way — it only ever
 * renders `children` as an opaque node.
 */
export function FileTreePane({
  children,
  dirtyPaths = EMPTY_DIRTY_PATHS,
  files,
  onEditFile,
  onJumpToFile,
  onTabChange,
  tab,
}: {
  children?: ReactNode;
  /** Paths (in this pane's own repo-toplevel-relative vocabulary) with
   * unsaved editor changes — the same dot `FileBrowserTree` shows, so a
   * dirty file is spottable from whichever tab happens to be open. The
   * caller does the translating: the store publishes the open editor's path
   * as `FileViewer` resolves it, which is cwd-relative (see `ChangesView`'s
   * `cwdRelativePath`). Defaults to empty, so a caller that doesn't pass it
   * renders no dots. */
  dirtyPaths?: ReadonlySet<string>;
  files: FileDiff[];
  /** Called with a file's path when its row's "Edit file" button is
   * clicked. Undefined renders no edit button on any row; a row whose file
   * {@link isEditableFile} rejects renders none either way. */
  onEditFile?: (path: string) => void;
  onJumpToFile: (path: string) => void;
  onTabChange: (tab: FileTreeTab) => void;
  tab: FileTreeTab;
}) {
  // Keyed only on `files`' own identity: ChangesView re-renders this pane's
  // parent on every scroll-driven `activeFile` change, but `files` itself
  // (the diff's file list) doesn't change with it — so the directory
  // grouping and each file's line-walking `fileDiffCounts` call, done once
  // here, are skipped on those re-renders instead of re-running per scroll
  // step across the whole diff.
  const groups = useMemo(() => groupByDirectory(files), [files]);
  const width = useLayout((s) => s.layout.fileTreeWidth);
  const setWidth = useLayout((s) => s.setFileTreeWidth);

  return (
    <nav data-testid="file-tree-pane" style={rootStyle(width)}>
      <div style={tabsRowStyle}>
        <Segmented
          ariaLabel="File tree"
          onChange={onTabChange}
          options={TREE_TABS}
          value={tab}
        />
      </div>
      <div
        data-testid="file-tree-pane-changes"
        style={subPaneStyle(tab !== "changes")}
      >
        <div style={listStyle}>
          {groups.map((group) => (
            <div data-testid="file-tree-dir-group" key={group.dir || "/"}>
              {group.dir ? (
                <div
                  data-testid="file-tree-dir-label"
                  style={dirLabelStyle}
                  title={group.dir}
                >
                  <DirIcon open />
                  {/* Clipped from the left, so a deep path keeps the folder
                      names nearest the files. */}
                  <span style={dirLabelTextStyle}>{group.dir}</span>
                </div>
              ) : null}
              {/* Row content past the name is driven by `fileKind`, exactly
                  as `DiffFileCard` and `ChangedFilesList` already do it: a
                  binary or empty file has no lines to count, so "+0 −0" here
                  was the same 0-change noise those two surfaces removed —
                  on the one surface that lists every file at once. */}
              {group.files.map(({ additions, deletions, file, kind }) => (
                <div
                  className="kr-hover-surface"
                  data-git={file.status}
                  data-testid="file-tree-file-row"
                  key={file.path}
                  style={rowWrapStyle(Boolean(group.dir))}
                  title={rowTitle(file)}
                >
                  <button
                    className="kr-tree-row"
                    onClick={() => onJumpToFile(file.path)}
                    style={{ ...jumpButtonStyle, color: GIT_INK[file.status] }}
                    type="button"
                  >
                    <FileIcon path={file.path} />
                    <span style={fileNameStyle}>
                      {displayName(file, group.dir)}
                    </span>
                    {kind === "content" && (
                      <>
                        <span style={addCountStyle}>+{additions}</span>
                        <span style={delCountStyle}>−{deletions}</span>
                      </>
                    )}
                    {kind === "binary" && (
                      <span style={kindTagStyle}>binary</span>
                    )}
                    {kind === "empty" && (
                      <span style={kindTagStyle}>empty</span>
                    )}
                    {/* An image, not a `role="status"` live region: one per
                        row would announce "Unsaved changes" for every dirty
                        file the list happens to contain. FileViewer's single
                        header dot is the live region. */}
                    {dirtyPaths.has(file.path) ? (
                      <span
                        aria-label="Unsaved changes"
                        data-testid="tree-dirty-dot"
                        role="img"
                        style={treeDirtyDotStyle}
                      />
                    ) : null}
                  </button>
                  {onEditFile && isEditableFile(file) ? (
                    <button
                      aria-label="Edit file"
                      className="kr-hover-surface"
                      onClick={() => onEditFile(file.path)}
                      style={editRowButtonStyle}
                      title="Edit this file"
                      type="button"
                    >
                      <Pencil size={12} />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div data-testid="file-tree-pane-all" style={subPaneStyle(tab !== "all")}>
        {children}
      </div>
      <ColumnResizeHandle
        onReset={() => setWidth(FILE_TREE_WIDTH_DEFAULT)}
        onResize={setWidth}
        testId="file-tree-resize"
        width={() => useLayout.getState().layout.fileTreeWidth}
      />
    </nav>
  );
}
