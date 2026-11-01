import { ChevronRight } from "lucide-react";
import { type CSSProperties, memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useLayout } from "../state/layout.ts";
import { isParked, useSessions } from "../state/sessions.ts";
import { plural } from "../state/stopCost.ts";
import { projectColor } from "../theme/projectColor.ts";
import { tokens } from "../theme/tokens.ts";
import type { ProjectRow } from "../types.ts";
import {
  footSectionHeaderStyle,
  restoreButtonStyle,
} from "./ArchivedGroup.tsx";
import { useOrderedSessions } from "./useOrderedSessions.ts";

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

const sessionListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1px",
  padding: "2px 0 8px",
};

// Spaced like a rail row (a 28px target), but one line and muted: these are
// stopped sessions to pick from, not live ones to watch.
/** Each nesting level indents a nested session under its lead, as on the rail. */
const NEST_INDENT_PX = 14;

function sessionButtonStyle(depth: number): CSSProperties {
  return {
    ...sessionButtonBase,
    paddingLeft: `${30 + depth * NEST_INDENT_PX}px`,
  };
}

const sessionButtonBase: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  gap: "8px",
  lineHeight: 1.4,
  minHeight: "28px",
  padding: "4px 8px 4px 30px",
  textAlign: "left",
  width: "100%",
};

const sessionTitleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// The stopped ring the rail draws for an idle session, so a parked row reads
// as the same session it was on the rail.
const stoppedRingStyle: CSSProperties = {
  border: `1.5px solid ${tokens.color.ink.faint}`,
  borderRadius: "50%",
  flex: "none",
  height: "8px",
  width: "8px",
};

const foldToggleStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.faint,
  cursor: "pointer",
  fontFamily: tokens.font.sans,
  fontSize: "11px",
  padding: "4px 8px 2px 46px",
  textAlign: "left",
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

/** Open one parked session. Opening brings back only it (and its leads, if
 *  nested — see `setActiveSession`) and resumes it (`claude --resume`); the
 *  rest of the project stays parked. */
function openParkedSession(sessionId: string): void {
  useSessions.getState().setActiveSession(sessionId);
  useLayout.getState().revealSessionView();
}

const ParkedProject = memo(function ParkedProject({
  nowMinute,
  project,
}: {
  nowMinute: number;
  project: ProjectRow;
}) {
  // The project's parked sessions, ordered, folded and nested by the same
  // hook its rail group uses, so this previews exactly the rows unparking
  // brings back.
  const { collapsedDone, collapsedOld, nestDepth, rows } = useOrderedSessions(
    project,
    { nowMinute, parked: true }
  );
  const [open, setOpen] = useState(false);
  // The folded ones ("N done", "N older") stay a click away, as on the rail:
  // a parked session must always be reachable from here.
  const [showFolded, setShowFolded] = useState(false);
  const folded = [...collapsedDone, ...collapsedOld];
  const shown = showFolded ? [...rows, ...folded] : rows;
  const titles = useSessions(
    useShallow((state) => shown.map((id) => state.sessions[id]?.title ?? ""))
  );
  // Counts everything Unpark brings back, folded or not.
  const count = plural(rows.length + folded.length, "session");
  const foldLabel = [
    collapsedDone.length > 0 ? `${collapsedDone.length} done` : null,
    collapsedOld.length > 0 ? `${collapsedOld.length} older` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const foldToggleText = showFolded ? "Show fewer" : foldLabel;
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
          style={restoreButtonStyle}
          title="Bring every parked session back. Each resumes when you open it."
          type="button"
        >
          Unpark
        </button>
      </div>
      {open ? (
        <div style={sessionListStyle}>
          {shown.map((id, index) => (
            <button
              className="kr-hover-surface"
              key={id}
              onClick={() => openParkedSession(id)}
              style={sessionButtonStyle(nestDepth[id] ?? 0)}
              title="Bring back and open only this session"
              type="button"
            >
              <span style={stoppedRingStyle} />
              <span style={sessionTitleStyle}>{titles[index]}</span>
            </button>
          ))}
          {folded.length > 0 ? (
            <button
              aria-expanded={showFolded}
              className="kr-hover-surface"
              onClick={() => setShowFolded((v) => !v)}
              style={foldToggleStyle}
              type="button"
            >
              {foldToggleText}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/**
 * Every project with parked sessions, in a collapsed-by-default section at the
 * foot of the rail (ADR-0052). Kept apart from the "N inactive projects" fold on purpose:
 * that fold is automatic and undoes itself; parking is the person's choice and
 * only they undo it. Most recently parked first.
 */
const ParkedGroup = memo(function ParkedGroup({
  nowMinute,
}: {
  /** The rail's minute tick, so the "older" fold here matches the rail's. */
  nowMinute: number;
}) {
  // Projects with a parked session, most recently parked first. A project
  // can sit here and on the rail at once: opening one parked session brings
  // back only that one.
  const parked = useSessions(
    useShallow((state) => {
      const newestPark = new Map<string, number>();
      for (const session of Object.values(state.sessions)) {
        if (isParked(session)) {
          newestPark.set(
            session.projectId,
            Math.max(
              newestPark.get(session.projectId) ?? 0,
              session.parkedAt ?? 0
            )
          );
        }
      }
      return state.projects
        .filter((p) => newestPark.has(p.id))
        .sort(
          (a, b) => (newestPark.get(b.id) ?? 0) - (newestPark.get(a.id) ?? 0)
        );
    })
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
        style={footSectionHeaderStyle}
        type="button"
      >
        <ChevronRight size={9} strokeWidth={2} style={chevronStyle(open)} />
        Parked ({parked.length})
      </button>
      {open
        ? parked.map((project) => (
            <ParkedProject
              key={project.id}
              nowMinute={nowMinute}
              project={project}
            />
          ))
        : null}
    </div>
  );
});

export { ParkedGroup };
