/**
 * A project header's "⋯" popover (also opened by right-clicking the header):
 * park (put the project away and stop what it runs), rename, colour, sort, and
 * the destructive clear that closes every session in the group. Colour and
 * sort open their own popovers in this one's place; they live here, not in
 * the hover row, so that row stays short enough to leave the name readable. Its own component (the session row's
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

const dividerStyle: CSSProperties = {
  border: "none",
  borderTop: `1px solid ${tokens.color.line.soft}`,
  margin: "4px 0",
};

interface ProjectMenuProps {
  /** Open the colour picker in this menu's place. */
  onColour: () => void;
  onRename: () => void;
  /** Ask to close every session in the project — opens the group's confirm. */
  onRequestClear: () => void;
  /** Ask to park the project — parks at once, or opens the group's confirm
   *  when work is in flight. */
  onRequestPark: () => void;
  /** Open the project's sort menu in this menu's place. */
  onSort: () => void;
  projectId: string;
}

interface Item {
  label: string;
  onClick: () => void;
  testId?: string;
  title?: string;
}

export function ProjectMenu({
  onColour,
  onRename,
  onRequestClear,
  onRequestPark,
  onSort,
  projectId,
}: ProjectMenuProps) {
  // Park leads: it is the action people come here for most, and the reason
  // the header's hover row could shrink to the three it shows.
  const items: Item[] = [
    {
      label: "Park project",
      onClick: onRequestPark,
      testId: `park-project-${projectId}`,
      title: "Stop its sessions and terminals and move it to Parked",
    },
    {
      label: "Rename",
      onClick: onRename,
      testId: `rename-project-menu-${projectId}`,
    },
    { label: "Colour…", onClick: onColour },
    { label: "Sort sessions…", onClick: onSort },
  ];
  return (
    <div role="menu" style={surfaceStyle}>
      {items.map((item) => (
        <button
          className="kr-hover-surface"
          data-testid={item.testId}
          key={item.label}
          onClick={item.onClick}
          role="menuitem"
          style={itemStyle}
          title={item.title}
          type="button"
        >
          {item.label}
        </button>
      ))}
      <hr style={dividerStyle} />
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
