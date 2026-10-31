import type { CSSProperties } from "react";
import { useLayout } from "../state/layout.ts";
import { fullyParkedProjectIds, useSessions } from "../state/sessions.ts";
import { useTerminals } from "../state/terminals.ts";
import { TerminalWorkspace } from "../terminal/TerminalWorkspace.tsx";
import { tokens } from "../theme/tokens.ts";

const dragHandleStyle: CSSProperties = {
  cursor: "row-resize",
  flex: "0 0 auto",
  height: "5px",
  width: "100%",
  zIndex: tokens.z.sticky,
};

/**
 * The bottom Project-terminal dock: a fixed-height, user-resizable panel under
 * the Claude view and its composer that hosts the shared {@link TerminalWorkspace}. Closing it
 * only hides it once any terminal exists — workspaces stay mounted so running
 * terminals are never disposed. Drag the top edge to resize (height persisted,
 * clamped by the layout store).
 */
export function TerminalDock() {
  const open = useLayout((s) => s.layout.terminalDockOpen);
  const height = useLayout((s) => s.layout.terminalDockHeight);
  const fullHeight = useLayout((s) => s.layout.terminalDockFullHeight);
  const toggleFullHeight = useLayout((s) => s.toggleTerminalDockFullHeight);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const sessions = useSessions((s) => s.sessions);
  const projects = useSessions((s) => s.projects);
  const byProject = useTerminals((s) => s.byProject);

  const hasTerminals = Object.keys(byProject).length > 0;
  // Once any project has terminals the dock stays mounted forever and closing
  // only hides it — unmounting would dispose every xterm (and its scrollback)
  // while the PTYs live on. Rendering nothing is only safe before first use.
  if (!(open || hasTerminals)) {
    return null;
  }

  const activeProjectId = activeSessionId
    ? (sessions[activeSessionId]?.projectId ?? null)
    : null;
  const cwdFor = (id: string): string =>
    projects.find((p) => p.id === id)?.path ?? "";

  // Keep a workspace mounted for every project that has terminals, plus the
  // active project (which may not have any tabs yet). Only the active one is
  // visible; the rest are hidden-but-alive so switching projects never tears
  // down — and blanks — a running terminal. A [Parked project]'s terminals are
  // stopped, so its workspace unmounts too: a mounted pane would start a fresh
  // shell behind the person's back.
  const parked = fullyParkedProjectIds(sessions);
  const mountedProjectIds = Array.from(
    new Set([
      ...Object.keys(byProject),
      ...(activeProjectId ? [activeProjectId] : []),
    ])
  ).filter((id) => !parked.has(id));

  const startDrag = (event: {
    clientY: number;
    preventDefault: () => void;
  }) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = useLayout.getState().layout.terminalDockHeight;
    const onMove = (move: MouseEvent) => {
      // Dragging up (smaller clientY) grows the dock.
      useLayout
        .getState()
        .setTerminalDockHeight(startHeight + (startY - move.clientY));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      style={{
        borderTop: `1px solid ${tokens.color.line.base}`,
        display: open ? "flex" : "none",
        flex: fullHeight ? "1 1 0" : `0 0 ${height}px`,
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {fullHeight ? null : (
        <div
          aria-hidden
          data-testid="terminal-dock-resize"
          onMouseDown={startDrag}
          style={dragHandleStyle}
        />
      )}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {activeProjectId === null ? (
          <TerminalWorkspace
            cwd=""
            fullHeight={fullHeight}
            onToggleFullHeight={toggleFullHeight}
            projectId={null}
            visible={open}
          />
        ) : null}
        {mountedProjectIds.map((id) => {
          const isActiveProject = id === activeProjectId;
          return (
            <div
              data-testid={`project-pane-${id}`}
              key={id}
              style={{
                display: isActiveProject ? "block" : "none",
                inset: 0,
                position: "absolute",
              }}
            >
              <TerminalWorkspace
                cwd={cwdFor(id)}
                fullHeight={fullHeight}
                onToggleFullHeight={toggleFullHeight}
                projectId={id}
                visible={open && isActiveProject}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
