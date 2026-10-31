/**
 * A project header's "⋯" popover: rename, park (put the project away and stop
 * what it runs), and the destructive clear that closes every session in the
 * group. Its own component (the session row's
 * `⋯` menu is the sibling pattern) so the header stays about chrome.
 *
 * The clear only *asks* here — the confirm itself is the group's centered
 * {@link ConfirmDialog}, not a second popover step. A block of confirm copy
 * hanging off this trigger landed in the middle of a 278px rail, on top of the
 * other projects.
 */
import type { CSSProperties } from "react";
import { tokens } from "../theme/tokens.ts";
import { anchoredMenuSurfaceStyle } from "../ui/AnchoredMenu.tsx";

/** A fixed width, not a `minWidth`: a surface sized to its own content drifts
 *  wider than the other header popovers for no reason. */
const surfaceStyle: CSSProperties = {
  ...anchoredMenuSurfaceStyle,
  padding: "4px",
  width: "186px",
};

const itemStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.primary,
  cursor: "pointer",
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  padding: "6px 8px",
  textAlign: "left",
  width: "100%",
};

const destructiveItemStyle: CSSProperties = {
  ...itemStyle,
  color: tokens.color.status.error,
};

interface ProjectMenuProps {
  onRename: () => void;
  /** Ask to close every session in the project — opens the group's confirm. */
  onRequestClear: () => void;
  /** Ask to park the project — parks at once, or opens the group's confirm
   *  when work is in flight. */
  onRequestPark: () => void;
  projectId: string;
}

export function ProjectMenu({
  onRequestClear,
  onRequestPark,
  onRename,
  projectId,
}: ProjectMenuProps) {
  return (
    <div role="menu" style={surfaceStyle}>
      <button
        className="kr-hover-surface"
        data-testid={`rename-project-menu-${projectId}`}
        onClick={onRename}
        role="menuitem"
        style={itemStyle}
        type="button"
      >
        Rename
      </button>
      <button
        className="kr-hover-surface"
        data-testid={`park-project-${projectId}`}
        onClick={onRequestPark}
        role="menuitem"
        style={itemStyle}
        title="Stop its sessions and terminals and move it to Parked"
        type="button"
      >
        Park project
      </button>
      <button
        className="kr-hover-surface"
        data-testid={`clear-project-${projectId}`}
        onClick={onRequestClear}
        role="menuitem"
        style={destructiveItemStyle}
        type="button"
      >
        Close all sessions
      </button>
    </div>
  );
}
