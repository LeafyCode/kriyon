import type { CSSProperties } from "react";
import { useLayout } from "../state/layout.ts";
import {
  fullyParkedProjectIds,
  sessionWorkingDir,
  useSessions,
} from "../state/sessions.ts";
import {
  scopeProjectId,
  sessionTerminalScope,
  useTerminals,
} from "../state/terminals.ts";
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
  const byScope = useTerminals((s) => s.byScope);

  const hasTerminals = Object.keys(byScope).length > 0;
  // Once any project has terminals the dock stays mounted forever and closing
  // only hides it — unmounting would dispose every xterm (and its scrollback)
  // while the PTYs live on. Rendering nothing is only safe before first use.
  if (!(open || hasTerminals)) {
    return null;
  }

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  // Terminals belong to the folder the active session works in: its
  // [Worktree] when it has one, else the project folder. Main-folder
  // terminals never show in a worktree, nor one worktree's in another.
  const activeScope = sessionTerminalScope(activeSession);
  const cwdFor = (scope: string): string => {
    if (scope === activeScope) {
      return sessionWorkingDir(activeSession);
    }
    // A hidden scope opens nothing new until it is active again; its panes
    // keep their own cwd for split and restart.
    const projectId = scopeProjectId(scope);
    return projects.find((p) => p.id === projectId)?.path ?? "";
  };

  // Keep a workspace mounted for every scope that has terminals, plus the
  // active scope (which may not have any tabs yet). Only the active one is
  // visible; the rest are hidden-but-alive so switching sessions never tears
  // down — and blanks — a running terminal. A [Parked project]'s terminals are
  // stopped, so its workspaces unmount too: a mounted pane would start a fresh
  // shell behind the person's back.
  const parked = fullyParkedProjectIds(sessions);
  const mountedScopes = Array.from(
    new Set([...Object.keys(byScope), ...(activeScope ? [activeScope] : [])])
  ).filter((scope) => !parked.has(scopeProjectId(scope)));

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
        {activeScope === null ? (
          <TerminalWorkspace
            cwd=""
            fullHeight={fullHeight}
            onToggleFullHeight={toggleFullHeight}
            scope={null}
            visible={open}
          />
        ) : null}
        {mountedScopes.map((scope) => {
          const isActive = scope === activeScope;
          return (
            <div
              data-testid={`scope-pane-${scope}`}
              key={scope}
              style={{
                display: isActive ? "block" : "none",
                inset: 0,
                position: "absolute",
              }}
            >
              <TerminalWorkspace
                cwd={cwdFor(scope)}
                fullHeight={fullHeight}
                onToggleFullHeight={toggleFullHeight}
                scope={scope}
                visible={open && isActive}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
