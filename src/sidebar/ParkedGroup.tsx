import { ChevronRight } from "lucide-react";
import { type CSSProperties, memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCommandCenter } from "../state/commandCenter.ts";
import { effectiveSessionSort, useLayout } from "../state/layout.ts";
import { useSessions } from "../state/sessions.ts";
import { projectColor } from "../theme/projectColor.ts";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { ProjectRow } from "../types.ts";
import { EMPTY_ORDER, orderMatched } from "./sessionOrder.ts";

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

const sessionListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1px",
  padding: "2px 0 8px",
};

// Spaced like a rail row (a 28px target), but one line and muted: these are
// stopped sessions to pick from, not live ones to watch.
const sessionButtonStyle: CSSProperties = {
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

const foldNoteStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.sans,
  fontSize: "11px",
  padding: "2px 8px 0 46px",
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const ParkedProject = memo(function ParkedProject({
  nowMinute,
  project,
}: {
  nowMinute: number;
  project: ProjectRow;
}) {
  // Exactly what the project's group showed on the rail, in its order, with
  // the same folds: unparking brings that group back, so this is a preview of
  // it — not every session the project ever had. The same ordering function
  // the group uses, so the two can't disagree.
  const mode = useLayout((state) => state.layout.sidebarMode);
  const sort = useLayout((state) =>
    effectiveSessionSort(state.layout, project.id)
  );
  const manual = useLayout(
    (state) => state.layout.manualSessionOrder[project.id] ?? EMPTY_ORDER
  );
  const hideOlderThan = useLayout((state) => state.layout.hideOlderThan);
  const lastChangeMs = useCommandCenter((state) => state.lastChangeMs);
  const { collapsedDone, collapsedOld, rows } = useSessions((state) =>
    orderMatched(
      {
        appendSeq: state.appendSeq,
        sessions: state.sessions,
        statusOrigin: state.statusOrigin,
        viewed: state.viewed,
      },
      project,
      "",
      false,
      mode,
      sort,
      manual,
      {
        activeSessionId: null,
        lastChangeMs,
        now: nowMinute,
        threshold: hideOlderThan,
      }
    )
  );
  const titles = useSessions(
    useShallow((state) => rows.map((id) => state.sessions[id]?.title ?? ""))
  );
  const [open, setOpen] = useState(false);
  const count = plural(rows.length, "session");
  const folded = [
    collapsedDone.length > 0 ? `${collapsedDone.length} done` : null,
    collapsedOld.length > 0 ? `${collapsedOld.length} older` : null,
  ].filter((part): part is string => part !== null);
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
      {open ? (
        <div style={sessionListStyle}>
          {rows.map((id, index) => (
            <button
              className="kr-hover-surface"
              key={id}
              onClick={() => openParkedSession(id)}
              style={sessionButtonStyle}
              title="Unpark and open this session"
              type="button"
            >
              <span style={stoppedRingStyle} />
              <span style={sessionTitleStyle}>{titles[index]}</span>
            </button>
          ))}
          {folded.length > 0 ? (
            <span style={foldNoteStyle}>{folded.join(" · ")}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/**
 * Every [Parked project], in a collapsed-by-default section at the foot of the
 * rail (ADR-0052). Kept apart from the "N inactive projects" fold on purpose:
 * that fold is automatic and undoes itself; parking is the person's choice and
 * only they undo it. Most recently parked first.
 */
const ParkedGroup = memo(function ParkedGroup({
  nowMinute,
}: {
  /** The rail's minute tick, so the "older" fold here matches the rail's. */
  nowMinute: number;
}) {
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
