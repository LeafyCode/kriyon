import { Copy } from "lucide-react";
import type { CSSProperties } from "react";
import { copyPath } from "../changes/copyPath.ts";
import { fileDiffCounts, fileKind } from "../state/changes.ts";
import { tokens } from "../theme/tokens.ts";
import type { FileDiff } from "../types.ts";

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  marginTop: "10px",
};

const rowStyle: CSSProperties = {
  alignItems: "center",
  borderRadius: tokens.radius.md,
  display: "flex",
  gap: tokens.space.sm,
  height: "32px",
  padding: "0 6px",
  width: "100%",
};

// The row used to be a single full-width `<button>`. It's now a wrapper div
// (still `.kr-hover-surface` for the whole-row hover tint) with the toggle
// as one flex child and the copy-path button as a sibling — nesting a
// button inside a button is invalid HTML and would fire both onClicks.
const toggleStyle: CSSProperties = {
  alignItems: "center",
  background: "none",
  border: "none",
  cursor: "pointer",
  display: "flex",
  flex: 1,
  fontFamily: tokens.font.sans,
  gap: tokens.space.sm,
  minWidth: 0,
  padding: 0,
  textAlign: "left",
};

const copyButtonStyle: CSSProperties = {
  alignItems: "center",
  background: "none",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.faint,
  cursor: "pointer",
  display: "flex",
  flex: "none",
  padding: "3px",
};

const pathStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  flex: 1,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  minWidth: 0,
  overflow: "hidden",
  textAlign: "left",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const addCountStyle: CSSProperties = {
  color: tokens.color.add,
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
};

const delCountStyle: CSSProperties = {
  color: tokens.color.del,
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
};

const newBadgeStyle: CSSProperties = {
  color: tokens.color.add,
  fontFamily: tokens.font.mono,
  fontSize: "9px",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

// Neutral (non-add/del) informational tag for the binary/empty buckets —
// same badge vocabulary as `newBadgeStyle` but tinted with the chip surface
// rather than the add color, mirroring `DiffFileCard`'s `kindTagStyle`.
const kindTagStyle: CSSProperties = {
  background: tokens.color.chip,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "9px",
  fontWeight: 700,
  letterSpacing: "0.06em",
  padding: "1px 5px",
  textTransform: "uppercase",
};

/** Basename of `path` — the row shows this (the sidebar is too narrow for a
 * full path), with the full path carried in `title`. Mirrors the same
 * slicing the changes store uses to classify auto-collapsed paths. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The active session's changed files, one row per file — basename, `+N −M`
 * counts (via {@link fileDiffCounts}), and a `NEW` badge for an added file,
 * mirroring `DiffFileCard`'s vocabulary for the same data. Purely
 * presentational: the Inspector supplies `files` (read from the changes
 * store) and `onOpen` (switches to the Changes view and requests the jump).
 * Renders nothing when there are no files — the Inspector's existing
 * "No uncommitted changes" / "Not a git repository" working-tree lines
 * already occupy that space.
 */
export function ChangedFilesList({
  files,
  onOpen,
}: {
  files: FileDiff[];
  onOpen: (path: string) => void;
}) {
  if (files.length === 0) {
    return null;
  }

  return (
    <div data-testid="changed-files-list" style={listStyle}>
      {files.map((file) => {
        const kind = fileKind(file);
        const { additions, deletions } = fileDiffCounts(file);
        // Keyed on the git status, deliberately *not* on `fileKind`: git's
        // `-M` emits a rename with hunks whenever similarity < 100%, which
        // `fileKind` buckets as "content" (correctly — that file has real ±
        // counts to show). The old path has no deletion entry of its own in
        // the changeset, so this row is the only place it survives.
        const oldPath = file.status === "renamed" ? file.oldPath : null;
        const title = oldPath ? `${oldPath} → ${file.path}` : file.path;
        return (
          <div
            className="kr-hover-surface"
            key={file.path}
            style={rowStyle}
            title={title}
          >
            <button
              onClick={() => onOpen(file.path)}
              style={toggleStyle}
              type="button"
            >
              {oldPath ? (
                <span style={pathStyle}>
                  {basename(oldPath)} → {basename(file.path)}
                </span>
              ) : (
                <span style={pathStyle}>{basename(file.path)}</span>
              )}
              {file.status === "added" && (
                <span style={newBadgeStyle}>NEW</span>
              )}
              {kind === "content" && (
                <>
                  <span style={addCountStyle}>+{additions}</span>
                  <span style={delCountStyle}>−{deletions}</span>
                </>
              )}
              {kind === "binary" && <span style={kindTagStyle}>binary</span>}
              {kind === "empty" && <span style={kindTagStyle}>empty</span>}
            </button>
            <button
              aria-label="Copy path"
              onClick={() => copyPath(file.path)}
              style={copyButtonStyle}
              type="button"
            >
              <Copy size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
