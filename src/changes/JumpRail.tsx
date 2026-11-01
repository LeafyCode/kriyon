import type { CSSProperties } from "react";
import { EMPTY_VIEWED, useChanges } from "../state/changes.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";
import type { FileDiff } from "../types.ts";

/** The rail column's fixed width ("tree | feed flex | jump rail 26px"), a
 * literal — no token in the spacing ramp lands on this exact figure. */
export const JUMP_RAIL_WIDTH = 26;

/** Each dot's diameter, plus the vertical gap between dots — small literal
 * pixel values, matching the sidebar's own status-dot sizing convention
 * (`idleDotStyle` in `sidebar/SessionRow.tsx`)
 * rather than the coarser spacing token ramp. */
const DOT_SIZE = 6;
const DOT_GAP = 6;

const rootStyle: CSSProperties = {
  alignItems: "center",
  borderLeft: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flex: `0 0 ${JUMP_RAIL_WIDTH}px`,
  flexDirection: "column",
  gap: `${DOT_GAP}px`,
  overflowY: "auto",
  padding: `${tokens.space.sm} 0`,
};

/** The halo around the active dot. A 6px circle is too small to find by
 * colour alone on a 26px rail, so "here" gets a ring as well as the accent —
 * drawn as a `box-shadow` so it costs no layout and the dots stay on their
 * even 6px rhythm. */
const ACTIVE_RING = `0 0 0 3px ${accentAlpha(0.24)}`;

/** A dot's fill: the bright accent while active (regardless of viewed —
 * "here" always wins), and otherwise two adjacent stops of the ink ramp —
 * `faint` once viewed and scrolled past, the brighter `muted` while still
 * unseen, so "still to look at" stays the more visible of the two (the same
 * "colour only where attention is wanted" logic the sidebar's status glyphs
 * already use). The two stops are deliberately distinct values, not one stop
 * at two opacities, and the unseen one clears the 3:1 floor a non-text
 * indicator owes the reader. */
function dotStyle(active: boolean, viewed: boolean): CSSProperties {
  let background: string = tokens.color.ink.muted;
  if (active) {
    background = tokens.color.accentBright;
  } else if (viewed) {
    background = tokens.color.ink.faint;
  }
  return {
    background,
    border: "none",
    borderRadius: "50%",
    boxShadow: active ? ACTIVE_RING : undefined,
    cursor: "pointer",
    flex: "none",
    height: `${DOT_SIZE}px`,
    padding: 0,
    width: `${DOT_SIZE}px`,
  };
}

/**
 * The Code Changes View's right-edge jump rail (Task 10): one dot per
 * changed file, in the same order as the feed. Clicking a dot drives the
 * exact same jump mechanism as the file tree — `onJumpToFile`, which the
 * caller (`ChangesView`) wires to `DiffFeedHandle.scrollToFile` — this
 * component owns no scrolling of its own.
 *
 * `activeFile` (the file currently intersecting the viewport, tracked by
 * `DiffFeed`'s `IntersectionObserver`) lights that one dot with the accent;
 * every other file whose card has ever intersected the viewport
 * (`bySession[sessionId].viewed`, also written by `DiffFeed`) dims instead,
 * so the rail reads as "here, already looked at, not yet looked at" at a
 * glance without this component doing any observing itself.
 *
 * `hidden` covers the one case this rail can't drive: while `FileViewer` is
 * showing over the feed, the feed itself is `display:none` (see
 * `ChangesView`'s `diffFeedWrapStyle`), so a dot's `scrollToFile` call would
 * silently do nothing. Hidden via CSS rather than unmounted, so switching
 * back to the feed doesn't lose `activeFile`/scroll-derived state.
 */
export function JumpRail({
  files,
  hidden = false,
  onJumpToFile,
  sessionId,
}: {
  files: FileDiff[];
  hidden?: boolean;
  onJumpToFile: (path: string) => void;
  sessionId: string;
}) {
  // Both scroll-derived signals come straight from the store (written by
  // `DiffFeed`), so a scroll re-renders only this rail — not the whole
  // `ChangesView` subtree the accent dot used to hang off of via props.
  const activeFile = useChanges((s) => s.activeFile[sessionId] ?? null);
  const viewedMap = useChanges(
    (s) => s.bySession[sessionId]?.viewed ?? EMPTY_VIEWED
  );

  return (
    <nav
      data-testid="jump-rail"
      style={{ ...rootStyle, display: hidden ? "none" : "flex" }}
    >
      {files.map((file) => {
        const active = file.path === activeFile;
        const viewed = Boolean(viewedMap[file.path]);
        return (
          <button
            aria-label={`Jump to ${file.path}`}
            data-active={active}
            data-testid="jump-rail-dot"
            data-viewed={viewed}
            key={file.path}
            onClick={() => onJumpToFile(file.path)}
            style={dotStyle(active, viewed)}
            title={file.path}
            type="button"
          />
        );
      })}
    </nav>
  );
}
