import { PanelLeft } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useLayout } from "../state/layout.ts";
import { iconButton } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { topBandRow, trafficLightInset } from "./topBand.ts";

const rowStyle: CSSProperties = topBandRow();

const titleStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  flex: "none",
  fontSize: "13px",
  fontWeight: 500,
};

/**
 * The button that brings the sidebar back. It lives wherever the sidebar
 * isn't: every top-band header renders it while the sidebar is collapsed,
 * because there is no global title bar left to keep one permanent copy in.
 */
export function SidebarExpandButton() {
  const toggleSidebar = useLayout((state) => state.toggleSidebarCollapsed);
  return (
    <button
      aria-label="Expand sidebar"
      className="kr-hover-surface"
      onClick={toggleSidebar}
      style={iconButton()}
      title="Expand sidebar"
      type="button"
    >
      <PanelLeft size={13} strokeWidth={1.75} />
    </button>
  );
}

/**
 * The 46px header a full view (Command centre, Prompts, Settings) wears so it
 * lines up with the session column's own, and so the window can be dragged
 * from it.
 *
 * Both of those became this component's job when the title bar was deleted
 * (ADR-0023): with the sidebar collapsed, *this* header occupies the window's
 * top-left corner, so it also carries the traffic-light clearance and the way
 * back to the sidebar.
 */
export function ViewHeader({
  actions,
  testId,
  title,
}: {
  /** Right-aligned controls. */
  actions?: ReactNode;
  testId: string;
  title: string;
}) {
  const sidebarCollapsed = useLayout((state) => state.layout.sidebarCollapsed);
  return (
    <header
      data-tauri-drag-region
      data-testid={testId}
      style={{ ...rowStyle, ...trafficLightInset(sidebarCollapsed) }}
    >
      <div
        data-tauri-drag-region
        style={{ alignItems: "center", display: "flex", gap: "10px" }}
      >
        {sidebarCollapsed ? <SidebarExpandButton /> : null}
        <span style={titleStyle}>{title}</span>
      </div>
      {actions === undefined ? null : (
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flex: "none",
            gap: "8px",
          }}
        >
          {actions}
        </div>
      )}
    </header>
  );
}
