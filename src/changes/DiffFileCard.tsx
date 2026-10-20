import { Copy, Pencil } from "lucide-react";
import { type CSSProperties, memo } from "react";
// The per-file additions/deletions count and display bucket are defined in
// the changes store, alongside the auto-collapse rule that also derives
// from the counts.
import { fileDiffCounts, fileKind } from "../state/changes.ts";
import { card } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { FileDiff } from "../types.ts";
import { copyPath } from "./copyPath.ts";
import { DiffHunk } from "./DiffHunk.tsx";
import { langForPath } from "./highlighter.ts";

const cardStyle: CSSProperties = {
  ...card(),
  overflow: "hidden",
};

/** A 32px key-value-height header, flat and hairlined rather than filled: the
 * card is already one lightness step off the plane, and tinting the header
 * too made a run of cards read as a stack of title bars. */
const headerRowStyle: CSSProperties = {
  alignItems: "center",
  borderBottom: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flex: "none",
  gap: tokens.space.xs,
  height: "32px",
  padding: "0 12px",
  width: "100%",
};

// The header used to be a single full-width `<button>`. It's now a row div
// with the toggle as one flex child and the copy-path button as a sibling —
// nesting a button inside a button is invalid HTML and would swallow the
// copy click as a toggle click too.
const toggleButtonStyle: CSSProperties = {
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

const pathStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  flex: 1,
  fontFamily: tokens.font.mono,
  fontSize: "11.5px",
  minWidth: 0,
  overflow: "hidden",
  textAlign: "left",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const addCountStyle: CSSProperties = {
  color: tokens.color.add,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
};

const delCountStyle: CSSProperties = {
  color: tokens.color.del,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
};

/** A tinted badge rather than bare green type: at 10px a word of colour alone
 * is easy to miss beside the ± counts, which are the same green and the same
 * face. */
const newBadgeStyle: CSSProperties = {
  background: tokens.color.addSoft,
  borderRadius: tokens.radius.sm,
  color: tokens.color.add,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10px",
  fontWeight: 700,
  letterSpacing: "0.06em",
  padding: "1px 5px",
  textTransform: "uppercase",
};

// Neutral (non-add/del) informational tag for the binary/empty buckets —
// same badge vocabulary as `newBadgeStyle` (mono, bold, uppercase) but
// tinted with the chip surface rather than the add color, since these
// aren't a positive/negative judgment.
const kindTagStyle: CSSProperties = {
  background: tokens.color.chip,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10px",
  fontWeight: 700,
  letterSpacing: "0.06em",
  padding: "1px 6px",
  textTransform: "uppercase",
};

const copyButtonStyle: CSSProperties = {
  alignItems: "center",
  background: "none",
  border: "none",
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  flex: "none",
  padding: "3px",
};

const collapsedIndicatorStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.sans,
  fontSize: "11px",
};

// The attribution badge for a file this session's own edit tools touched
// (see `sessionTouchedRelative` in `state/sessions.ts`) — accent-tinted like
// `newBadgeStyle`'s vocabulary, but distinct wording so it's never confused
// with the git-status NEW tag: this marks *who* touched the file, not
// *what kind* of change it is, and both can be true on the same card.
const touchedBadgeStyle: CSSProperties = {
  // The *bright* accent: the fill accent is a button colour, and as 10px type
  // on the card's own fill it is barely above the background.
  color: tokens.color.accentBright,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10px",
  fontWeight: 700,
  letterSpacing: "0.04em",
};

/**
 * One file's diff: a clickable header (path, +/− counts, NEW badge for
 * added files) followed by its hunks, or a compact "collapsed" row in
 * place of the hunks when `collapsed` is true. Purely presentational —
 * collapse state and its auto-collapse default live in the caller
 * ({@link DiffFeed}, backed by the changes store).
 *
 * The header's content past the path is driven by {@link fileKind}: a
 * `binary` or `empty` file gets a tag instead of `±` counts (there's
 * nothing to count), and `content` keeps the existing counts. The
 * `oldPath → path` rename display is keyed on `file.status` instead, so a
 * rename that also carries edits (bucketed `content`, since it has a real
 * diff body) still shows where the file came from.
 *
 * `touchedBySession` (default `false`) renders a "✎ this session" badge —
 * best-effort attribution from `sessionTouchedRelative`, not an
 * authoritative signal (ADR 0015: misses Bash/`sed`/formatter edits, and is
 * cumulative/never-pruned) — so it's purely additive to the header, never a
 * substitute for the `±`/NEW/kind information above.
 */
function DiffFileCardImpl({
  collapsed,
  file,
  onEdit,
  onToggle,
  touchedBySession = false,
}: {
  collapsed: boolean;
  file: FileDiff;
  /** Opens this file in the editor (the All-files tab's `FileViewer`).
   * Called with `file.path`, path-taking for the same reason `onToggle` is
   * (see below): `undefined` renders no edit button at all — `DiffFeed`
   * passes one *stable* callback to every card, or `undefined` when the
   * caller didn't pass one. */
  onEdit?: (path: string) => void;
  /** Called with `file.path` on toggle. Path-taking (not a bound `() =>
   * void`) so {@link DiffFeed} can pass one *stable* callback to every card,
   * which — with this component memoized — is what keeps a scroll frame from
   * re-rendering every visible card. */
  onToggle: (path: string) => void;
  /** Whether this session's own edit tools touched `file.path` this run —
   * see `sessionTouchedRelative` in `state/sessions.ts`. */
  touchedBySession?: boolean;
}) {
  const kind = fileKind(file);
  const { additions, deletions } = fileDiffCounts(file);
  const lang = langForPath(file.path);
  // Keyed on the git status, deliberately *not* on `fileKind`: git's `-M`
  // emits `rename from`/`rename to` with hunks whenever similarity < 100%,
  // which `fileKind` buckets as "content" (correctly — the body has a real ±
  // diff to render). The old path has no deletion entry of its own anywhere
  // in the changeset, so the header is the only place it can still be seen,
  // and rename-then-edit is the common case in a coding session.
  const oldPath = file.status === "renamed" ? file.oldPath : null;

  return (
    <div data-testid="diff-file-card" style={cardStyle}>
      <div style={headerRowStyle}>
        <button
          data-testid="diff-file-header"
          onClick={() => onToggle(file.path)}
          style={toggleButtonStyle}
          type="button"
        >
          {oldPath ? (
            <span style={pathStyle}>
              {oldPath} → {file.path}
            </span>
          ) : (
            <span style={pathStyle}>{file.path}</span>
          )}
          {kind === "content" && (
            <>
              <span style={addCountStyle}>+{additions}</span>
              <span style={delCountStyle}>−{deletions}</span>
            </>
          )}
          {kind === "binary" && <span style={kindTagStyle}>binary</span>}
          {kind === "empty" && <span style={kindTagStyle}>empty</span>}
          {file.status === "added" && (
            <span data-testid="diff-file-new-badge" style={newBadgeStyle}>
              NEW
            </span>
          )}
          {touchedBySession ? (
            // No `role="note"` here: this span is a presentational child of
            // the header `<button>` above, and ARIA gives buttons
            // presentational children — any role here is stripped from the
            // a11y tree regardless, so `role="note"` only misled readers of
            // this file into thinking it did something. `role="img"` is
            // used instead of no role at all purely because a bare `<span>`
            // (implicit role `generic`) doesn't support naming at all —
            // Biome's `useAriaPropsSupportedByRole` rejects `aria-label` on
            // it outright — and `img` is this codebase's existing pattern
            // for "a short run of text+glyph naming itself" (see the ✎
            // glyph here). Since it's presentational either way once nested
            // in the button, the choice of role is otherwise moot; the
            // `aria-label` is what actually reaches assistive tech (as part
            // of the button's own accessible-name computation), so it's
            // kept.
            <span
              aria-label="Touched this session"
              data-testid="diff-file-touched-badge"
              role="img"
              style={touchedBadgeStyle}
            >
              ✎ this session
            </span>
          ) : null}
          {collapsed ? (
            <span
              data-testid="diff-file-collapsed-indicator"
              style={collapsedIndicatorStyle}
            >
              collapsed ▸
            </span>
          ) : null}
        </button>
        <button
          aria-label="Copy path"
          onClick={() => copyPath(file.path)}
          style={copyButtonStyle}
          type="button"
        >
          <Copy size={12} />
        </button>
        {onEdit ? (
          <button
            aria-label="Edit file"
            onClick={() => onEdit(file.path)}
            style={copyButtonStyle}
            title="Edit this file"
            type="button"
          >
            <Pencil size={13} />
          </button>
        ) : null}
      </div>
      {collapsed
        ? null
        : file.hunks.map((hunk, index) => (
            // Hunk headers can repeat within a file; position is the stable key.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional, append-only list with no unique key.
            <DiffHunk hunk={hunk} key={index} lang={lang} />
          ))}
    </div>
  );
}

/**
 * Memoized: the {@link DiffFeed} virtualizer re-renders on every scroll
 * frame, so a bare component would re-render (and re-walk `fileDiffCounts`)
 * for every on-screen card each frame. All five props are referentially
 * stable across a scroll — `file` keeps its identity, `collapsed`/
 * `touchedBySession` are primitives, and `onToggle`/`onEdit` are stable
 * path-taking callbacks (never a fresh `() => …` closure per card per
 * render, which would defeat this memoization) — so memo lets a card
 * re-render only when its own file's state actually changes.
 */
export const DiffFileCard = memo(DiffFileCardImpl);
