import { ChevronRight } from "lucide-react";
import { type CSSProperties, memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useLayout } from "../state/layout.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import { projectColor } from "../theme/projectColor.ts";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { ProjectRow } from "../types.ts";

// The same quiet, collapsed-by-default language as the Archived group: parked
// projects are deliberately out of the way until asked for.
const headerStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderTop: `1px solid ${tokens.color.line.soft}`,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "11.5px",
  gap: "6px",
  padding: "8px 8px 6px",
  width: "100%",
};

const projectRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "6px",
  padding: "4px 8px 4px 14px",
};

const expandStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  flex: 1,
  fontFamily: tokens.font.sans,
  gap: "6px",
  minWidth: 0,
  padding: 0,
  textAlign: "left",
};

const nameStyle: CSSProperties = {
  fontSize: "12.5px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const countStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  flex: "none",
  fontSize: "11px",
};

const unparkButtonStyle: CSSProperties = {
  ...button("secondary", "sm"),
  flex: "none",
  fontSize: "10.5px",
  height: "20px",
  padding: "0 8px",
};

const sessionButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "block",
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  overflow: "hidden",
  padding: "3px 8px 3px 40px",
  textAlign: "left",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  width: "100%",
};

function chevronStyle(open: boolean): CSSProperties {
  return {
    color: tokens.color.ink.faint,
    flex: "none",
    transform: open ? "rotate(90deg)" : "none",
    transition: `transform ${tokens.motion.disclose}`,
  };
}

function dotStyle(project: ProjectRow): CSSProperties {
  return {
    background: projectColor(project),
    borderRadius: "50%",
    flex: "none",
    height: "7px",
    width: "7px",
  };
}

/** Open one of a parked project's sessions. Opening unparks the project (see
 *  `setActiveSession`) and resumes the session (`claude --resume`), exactly as
 *  after an un-archive. */
function openParkedSession(sessionId: string): void {
  useSessions.getState().setActiveSession(sessionId);
  useLayout.getState().revealSessionView();
}

const ParkedProject = memo(function ParkedProject({
  project,
}: {
  project: ProjectRow;
}) {
  // Archived sessions stay archived; they rejoin the Archived group on unpark.
  const sessions = useSessions(
    useShallow((state) =>
      Object.values(state.sessions)
        .filter((s) => s.projectId === project.id && s.archivedAt === null)
        .sort((a, b) => b.createdAt - a.createdAt)
    )
  );
  const [open, setOpen] = useState(false);
  const count = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
  return (
    <div data-testid={`parked-project-${project.id}`}>
      <div style={projectRowStyle}>
        <button
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${project.name}`}
          className="kr-hover-surface"
          onClick={() => setOpen((v) => !v)}
          style={expandStyle}
          type="button"
        >
          <ChevronRight size={9} strokeWidth={2} style={chevronStyle(open)} />
          <span style={dotStyle(project)} />
          <span style={nameStyle}>{project.name}</span>
          <span style={countStyle}>{count}</span>
        </button>
        <button
          aria-label={`Unpark ${project.name}`}
          className="kr-hover-surface"
          onClick={() => useSessions.getState().unparkProject(project.id)}
          style={unparkButtonStyle}
          title="Bring it back to the sidebar. Sessions resume when you open them."
          type="button"
        >
          Unpark
        </button>
      </div>
      {open
        ? sessions.map((session: UiSession) => (
            <button
              className="kr-hover-surface"
              key={session.id}
              onClick={() => openParkedSession(session.id)}
              style={sessionButtonStyle}
              title="Unpark and open"
              type="button"
            >
              {session.title}
            </button>
          ))
        : null}
    </div>
  );
});

/**
 * Every [Parked project], in a collapsed-by-default section at the foot of the
 * rail (ADR-0052). Kept apart from the "N inactive projects" fold on purpose:
 * that fold is automatic and undoes itself; parking is the person's choice and
 * only they undo it. Most recently parked first.
 */
const ParkedGroup = memo(function ParkedGroup() {
  const parked = useSessions(
    useShallow((state) =>
      state.projects
        .filter((p) => p.parkedAt !== null)
        .sort((a, b) => (b.parkedAt ?? 0) - (a.parkedAt ?? 0))
    )
  );
  const [open, setOpen] = useState(false);
  if (parked.length === 0) {
    return null;
  }
  return (
    <div data-testid="parked-group" style={{ marginTop: tokens.space.md }}>
      <button
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={headerStyle}
        type="button"
      >
        <ChevronRight size={9} strokeWidth={2} style={chevronStyle(open)} />
        Parked ({parked.length})
      </button>
      {open
        ? parked.map((project) => (
            <ParkedProject key={project.id} project={project} />
          ))
        : null}
    </div>
  );
});

export { ParkedGroup };
