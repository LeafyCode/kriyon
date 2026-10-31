import { BookMarked, Inbox, MessagesSquare } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { pickFocusSession } from "../sidebar/sessionOrder.ts";
import { useCommandCenter } from "../state/commandCenter.ts";
import { useLayout } from "../state/layout.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";
import { TOP_BAND_HEIGHT, TRAFFIC_LIGHT_CLEARANCE } from "./topBand.ts";

const RAIL_WIDTH = 64;

const railStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.chrome.rail,
  borderRight: `1px solid ${tokens.color.line.base}`,
  display: "flex",
  flex: `0 0 ${RAIL_WIDTH}px`,
  flexDirection: "column",
  gap: "8px",
  paddingBottom: "14px",
};

/**
 * The rail's own share of the traffic-light clearance. In Focus there is no
 * sidebar to carry it, so the rail's first 46px are simply empty — and a
 * drag region, since this corner is the only window handle Focus has.
 */
const clearanceStyle: CSSProperties = {
  flex: "none",
  height: `${TOP_BAND_HEIGHT}px`,
  width: "100%",
};

function tileStyle(active: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: active ? accentAlpha(0.13) : "transparent",
    border: `1px solid ${active ? accentAlpha(0.3) : tokens.color.line.base}`,
    borderRadius: tokens.radius.lg,
    color: active ? tokens.color.ink.bright : tokens.color.ink.muted,
    cursor: "pointer",
    display: "flex",
    flex: "none",
    fontFamily: tokens.font.sans,
    fontSize: "14px",
    fontWeight: 700,
    height: "36px",
    justifyContent: "center",
    width: "36px",
  };
}

const dividerStyle: CSSProperties = {
  background: tokens.color.line.base,
  flex: "none",
  height: "1px",
  margin: "2px 0",
  width: "24px",
};

function ViewTile({
  icon,
  label,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="kr-hover-surface"
      onClick={onSelect}
      style={tileStyle(false)}
      title={label}
      type="button"
    >
      {icon}
    </button>
  );
}

/**
 * The Focus view's slim project rail — the chrome left of the center column,
 * and in Focus the *only* chrome.
 *
 * Since the view switcher moved into the sidebar (ADR-0023), Focus would
 * otherwise be a one-way door: the rail's bottom cluster carries the three
 * destinations so there is always a way back out.
 */
export function FocusRail() {
  const projects = useSessions((state) => state.projects);
  const sessions = useSessions((state) => state.sessions);
  const activeSessionId = useSessions((state) => state.activeSessionId);
  const setActiveSession = useSessions((state) => state.setActiveSession);
  const setView = useLayout((state) => state.setView);
  const openPalette = useUi((state) => state.openPalette);
  const lastChangeMs = useCommandCenter((state) => state.lastChangeMs);

  const activeProjectId = activeSessionId
    ? sessions[activeSessionId]?.projectId
    : undefined;

  // The session that wants you most: waiting/running work first, then the
  // most recently active, then newest — see pickFocusSession.
  function focusSessionOf(projectId: string): string | undefined {
    const projectSessions = Object.values(sessions).filter(
      (session) =>
        session.projectId === projectId && session.archivedAt === null
    );
    return pickFocusSession(projectSessions, lastChangeMs)?.id;
  }

  return (
    <nav aria-label="Focus rail" data-testid="focus-rail" style={railStyle}>
      <div
        data-tauri-drag-region
        style={{
          ...clearanceStyle,
          minWidth: `${Math.min(RAIL_WIDTH, TRAFFIC_LIGHT_CLEARANCE)}px`,
        }}
      />
      {projects
        .filter((project) => project.parkedAt === null)
        .map((project) => {
          const first = focusSessionOf(project.id);
          return (
            <button
              className="kr-hover-surface"
              disabled={!first}
              key={project.id}
              onClick={() => first && setActiveSession(first)}
              style={tileStyle(project.id === activeProjectId)}
              title={project.name}
              type="button"
            >
              {project.name.charAt(0).toUpperCase()}
            </button>
          );
        })}
      <div style={{ flex: 1 }} />
      <ViewTile
        icon={<MessagesSquare size={15} strokeWidth={1.75} />}
        label="Sessions"
        onSelect={() => setView("studio")}
      />
      <ViewTile
        icon={<Inbox size={15} strokeWidth={1.75} />}
        label="Command center"
        onSelect={() => setView("command")}
      />
      <ViewTile
        icon={<BookMarked size={15} strokeWidth={1.75} />}
        label="Prompts"
        onSelect={() => setView("prompts")}
      />
      <span style={dividerStyle} />
      <button
        aria-label="Open command palette"
        className="kr-hover-surface"
        onClick={openPalette}
        style={{
          ...tileStyle(false),
          fontFamily: tokens.font.mono,
          fontSize: "11px",
          fontWeight: 400,
        }}
        type="button"
      >
        ⌘K
      </button>
    </nav>
  );
}
