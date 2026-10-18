import { PanelLeft } from "lucide-react";
import type { CSSProperties } from "react";
import { useLayout } from "../state/layout.ts";
import { sessionWorkingDir, useSessions } from "../state/sessions.ts";
import { useRepoStatus } from "../state/useActiveSession.ts";
import { iconButton } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

/** The rail's fixed width — the Shell's collapse panel animates down to it. */
export const INSPECTOR_RAIL_WIDTH = 46;

const railStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.chrome.inspector,
  borderLeft: `1px solid ${tokens.color.line.base}`,
  display: "flex",
  flex: `0 0 ${INSPECTOR_RAIL_WIDTH}px`,
  flexDirection: "column",
  gap: "4px",
  // The first 46px are the header band the expanded rail also spends, so the
  // collapse/expand swap doesn't move every icon up the column.
  padding: "10px 0 14px",
};

const expandStyle: CSSProperties = {
  ...iconButton(),
  background: tokens.color.surface.s2,
};

const iconStyle: CSSProperties = {
  ...iconButton(),
  fontSize: "13px",
  position: "relative",
};

const badgeStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.accent,
  borderRadius: tokens.radius.pill,
  color: tokens.color.onAccent,
  display: "flex",
  fontFamily: tokens.font.mono,
  fontSize: "8.5px",
  fontWeight: 500,
  height: "14px",
  justifyContent: "center",
  minWidth: "14px",
  padding: "0 2px",
  position: "absolute",
  right: "1px",
  top: "1px",
};

/**
 * The collapsed inspector: a 46px icon rail that keeps the uncommitted-change
 * count in view (design 3e). Every control expands the inspector — the rail
 * is a reminder surface, not a second inspector.
 */
export function InspectorRail() {
  const expand = useLayout((state) => state.toggleInspectorCollapsed);
  const activeSessionId = useSessions((state) => state.activeSessionId);
  const session = useSessions((state) =>
    activeSessionId ? state.sessions[activeSessionId] : undefined
  );
  const repo = useRepoStatus(sessionWorkingDir(session));
  const dirtyCount = repo?.dirtyCount ?? 0;

  return (
    <aside data-testid="inspector-rail" style={railStyle}>
      <button
        aria-label="Expand inspector"
        className="kr-hover-surface"
        onClick={expand}
        style={expandStyle}
        title="Expand inspector"
        type="button"
      >
        <PanelLeft size={13} strokeWidth={1.75} />
      </button>
      <button
        aria-label={`Changes: ${dirtyCount}`}
        className="kr-hover-surface"
        onClick={expand}
        style={iconStyle}
        title={`${dirtyCount} uncommitted changes`}
        type="button"
      >
        ⎘
        {dirtyCount > 0 ? (
          <span data-testid="rail-change-count" style={badgeStyle}>
            {dirtyCount}
          </span>
        ) : null}
      </button>
      <button
        aria-label="Usage"
        className="kr-hover-surface"
        onClick={expand}
        style={iconStyle}
        title="Usage"
        type="button"
      >
        ◔
      </button>
      <button
        aria-label="Session details"
        className="kr-hover-surface"
        onClick={expand}
        style={iconStyle}
        title="Session details"
        type="button"
      >
        ⎇
      </button>
      <button
        aria-label="Activity"
        className="kr-hover-surface"
        onClick={expand}
        style={iconStyle}
        title="Activity"
        type="button"
      >
        ☰
      </button>
    </aside>
  );
}
