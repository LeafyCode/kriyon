import { closestCenter, DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ArrowUpDown, ChevronRight, Clock, Plus } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCommandCenter } from "../state/commandCenter.ts";
import { useLayout } from "../state/layout.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import { iconButton, sectionLabel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { ProjectRow } from "../types.ts";
import { useAnchoredMenu } from "../ui/AnchoredMenu.tsx";
import { ArchivedGroup } from "./ArchivedGroup.tsx";
import { useProjectDrag } from "./dragCommit.ts";
import { NeedsYouSection } from "./NeedsYouSection.tsx";
import { ParkedGroup } from "./ParkedGroup.tsx";
import { ProjectGroup } from "./ProjectGroup.tsx";
import { projectLabels } from "./projectLabel.ts";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { SidebarFooter } from "./SidebarFooter.tsx";
import { SidebarHeader } from "./SidebarHeader.tsx";
import { SortMenu } from "./SortMenu.tsx";
import { inactiveProjectIds, sortProjects } from "./sessionOrder.ts";

export interface SidebarProps {
  onCloseSession: (id: string) => void;
  onNewSession: () => void;
  /** Opens the About panel — rehomed from the title bar to the footer. */
  onShowAbout: () => void;
}

function containerStyle(width: number): CSSProperties {
  return {
    // Near-opaque fill, no backdrop blur: it sits on the already-frosted
    // window, so a second blur layer would cost frames for no visible gain.
    background: tokens.color.chrome.sidebar,
    borderRight: `1px solid ${tokens.color.line.base}`,
    color: tokens.color.text,
    display: "flex",
    flex: `0 0 ${width}px`,
    flexDirection: "column",
    fontFamily: tokens.font.sans,
    minHeight: 0,
    // Pin the width to its basis: without this a flex item's default
    // `min-width: auto` lets long, un-wrapped child text grow the rail past
    // its basis and spill across the window.
    minWidth: 0,
    position: "relative",
  };
}

/**
 * The `PROJECTS` heading, and the home of the two controls the filter row used
 * to carry. Sort is hover-revealed the way a project header's own actions are
 * — a section label with a row of permanent buttons on it reads as a toolbar,
 * which is the opposite of what a label is for. `+` is not: see below.
 */
const projectsLabelRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  gap: "2px",
  padding: "22px 10px 6px 18px",
};

const listStyle: CSSProperties = {
  flex: "1 1 auto",
  overflowX: "hidden",
  overflowY: "auto",
  padding: "0 8px 8px",
};

const emptyHintStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontSize: "12px",
  lineHeight: 1.5,
  padding: "14px 12px",
  textAlign: "center",
};

/**
 * The rail's "N inactive projects" fold — the whole-group twin of a project's
 * own "N older" summary, and styled as one: a quiet, chevroned disclosure that
 * only appears once a threshold has actually hidden something.
 *
 * The left pad puts this row's chevron in the same column as a project
 * header's, so the disclosure the eye tracks down the rail never steps
 * sideways: a header spends 13px on its drag grip, 2px on the header gap, and
 * 8px on the button's own padding before its chevron starts. A group's inner
 * summaries can use a 3px pad instead because they already sit inside the
 * subtree's 15px indent; this row is a peer of the groups, not a child.
 */
const inactiveSummaryStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "11.5px",
  // Matches the project header's chevron→name gap, so the label lands in the
  // project-name column too.
  gap: "7px",
  // PROJECT_GRIP_WIDTH (13px) + the header's 2px gap + the header button's 8px
  // left padding.
  padding: "5px 9px 5px 23px",
  textAlign: "left",
  width: "100%",
};

function inactiveChevronStyle(expanded: boolean): CSSProperties {
  return {
    alignItems: "center",
    color: tokens.color.ink.faint,
    display: "flex",
    flex: "none",
    transform: expanded ? "rotate(90deg)" : "none",
    transition: `transform ${tokens.motion.disclose}`,
  };
}

/**
 * The container the "N inactive projects" fold reveals into.
 *
 * Without it the revealed groups render identically to the active ones and the
 * fold appears to have changed nothing: eleven dormant projects simply join the
 * rail, and the eye has no way to tell where the active list ended. A left rail
 * plus an explicit closing stub gives the block a start and an end, and the
 * indent puts everything inside it one step below its peers.
 */
const inactiveBlockStyle: CSSProperties = {
  borderLeft: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flexDirection: "column",
  // Lands the rail under the summary row's chevron column (its 23px pad less
  // the chevron's own half-width).
  marginLeft: "12px",
  paddingLeft: "7px",
};

/** The block's closing corner — a short `L` that says "the fold ends here". */
const inactiveBlockEndStyle: CSSProperties = {
  borderBottom: `1px solid ${tokens.color.line.soft}`,
  borderBottomLeftRadius: "3px",
  borderLeft: `1px solid ${tokens.color.line.soft}`,
  flex: "none",
  height: "7px",
  marginBottom: "8px",
  marginLeft: "12px",
  width: "20px",
};

/**
 * A minute-quantized clock, ticking only while `active`. Quantizing to the
 * minute means the staleness fold re-evaluates at most once a minute — enough
 * for hours/days cutoffs, cheap enough to leave the order cache mostly warm.
 * Returns 0 when inactive so an off filter never re-renders groups on a timer.
 */
function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [active]);
  return active ? Math.floor(now / 60_000) * 60_000 : 0;
}

export function Sidebar({
  onCloseSession,
  onNewSession,
  onShowAbout,
}: SidebarProps) {
  // Only projects with at least one session earn sidebar space (history keeps
  // everything reachable via each project's History and ⌘K). `calm` keeps the
  // list alphabetical; `triage` floats projects that need the user to the top.
  const mode = useLayout((state) => state.layout.sidebarMode);
  const manualProjectOrder = useLayout(
    (state) => state.layout.manualProjectOrder
  );
  const projects = useSessions(
    useShallow((state) => {
      const byProject = new Map<string, UiSession[]>();
      for (const session of Object.values(state.sessions)) {
        if (session.archivedAt !== null) {
          continue;
        }
        const bucket = byProject.get(session.projectId);
        if (bucket) {
          bucket.push(session);
        } else {
          byProject.set(session.projectId, [session]);
        }
      }
      // Archived sessions do not hold a group open: a project whose every
      // session has been archived would otherwise sit on the rail forever as
      // an empty header with a `0` count. A parked project lives in the
      // Parked section instead.
      const included = state.projects.filter(
        (project) => byProject.has(project.id) && project.parkedAt === null
      );
      return sortProjects(included, byProject, mode, manualProjectOrder);
    })
  );
  const sessionSort = useLayout((state) => state.layout.sessionSort);
  const setActiveSession = useSessions((state) => state.setActiveSession);
  const width = useLayout((state) => state.layout.sidebarWidth);
  const hideOlderThan = useLayout((state) => state.layout.hideOlderThan);
  const nowMinute = useMinuteTick(hideOlderThan !== "off");
  const sortMenu = useAnchoredMenu<HTMLDivElement>();
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const filter = query.trim().toLowerCase();
  const lastChangeMs = useCommandCenter((state) => state.lastChangeMs);
  // Whole groups the staleness threshold has emptied. A searched rail answers
  // the query, not the policy — the same `off` a filter forces on the
  // per-session "N older" fold.
  const inactiveIds = useSessions(
    useShallow((state) =>
      inactiveProjectIds(
        {
          appendSeq: state.appendSeq,
          sessions: state.sessions,
          statusOrigin: state.statusOrigin,
          viewed: state.viewed,
        },
        {
          activeSessionId: state.activeSessionId,
          lastChangeMs,
          now: nowMinute,
          threshold: filter === "" ? hideOlderThan : "off",
        }
      )
    )
  );

  // Project reorder wiring: the frozen drag order (`displayIds`) is mapped back
  // to project rows for rendering, so a triage re-rank mid-drag can't shuffle
  // the list under the pointer. A searched rail isn't a reorder surface.
  const projectDrag = useProjectDrag(projects.map((project) => project.id));
  const projectById = new Map(
    projects.map((project) => [project.id, project] as const)
  );
  const orderedProjects = projectDrag.displayIds
    .map((id) => projectById.get(id))
    .filter((project): project is ProjectRow => project !== undefined);
  // The SortableContext ids must track the projects actually rendered, not the
  // frozen drag snapshot: if a project's last session closes mid-drag it drops
  // out of `orderedProjects`, and a stale id here would leave dnd-kit tracking
  // a sortable with no DOM node.
  const inactive = new Set(inactiveIds);
  const railProjects = orderedProjects.filter(
    (project) => !inactive.has(project.id)
  );
  const inactiveProjects = orderedProjects.filter((project) =>
    inactive.has(project.id)
  );
  const orderedProjectIds = railProjects.map((project) => project.id);
  const projectsSortable = filter === "";
  // Disambiguation is a property of the whole rail, not of one group: a name
  // only needs a parent path once something else on the rail answers to it.
  // Computed over every project (not just the active ones) so revealing the
  // inactive fold cannot change what an active header says about itself.
  const labels = useMemo(() => projectLabels(projects), [projects]);
  const renderGroup = (
    project: ProjectRow,
    sortable: boolean,
    dormant = false
  ) => (
    <ProjectGroup
      dormant={dormant}
      filter={filter}
      key={project.id}
      label={labels.get(project.id) ?? { name: project.name, qualifier: null }}
      nowMinute={nowMinute}
      onCloseSession={onCloseSession}
      onSelect={(id) => {
        setActiveSession(id);
        useLayout.getState().revealSessionView();
        // Picking a session answers what the fold was opened to find — the
        // picked project rejoins the rail on its own (it now holds the active
        // session), and the fold snaps shut instead of leaving the remaining
        // dormant groups sprawled open.
        if (dormant) {
          setShowInactive(false);
        }
      }}
      project={project}
      sortable={sortable}
    />
  );

  return (
    <aside data-testid="sidebar" style={containerStyle(width)}>
      <SidebarHeader query={query} setQuery={setQuery} />
      <NeedsYouSection />
      <div className="kr-reveal-parent" style={projectsLabelRowStyle}>
        <span style={{ ...sectionLabel(), flex: 1 }}>Projects</span>
        <div
          className="kr-reveal"
          ref={sortMenu.anchorRef}
          style={{ position: "relative" }}
        >
          <button
            aria-label="Sort sessions"
            className="kr-hover-surface"
            onClick={() => sortMenu.toggle()}
            style={iconButton()}
            title="Sort sessions"
            type="button"
            {...sortMenu.triggerAria}
          >
            <ArrowUpDown size={13} strokeWidth={1.75} />
          </button>
          {sortMenu.open ? (
            <SortMenu
              current={sessionSort}
              hide={{
                current: hideOlderThan,
                onPick: (value) => {
                  useLayout.getState().setHideOlderThan(value);
                  sortMenu.close();
                },
              }}
              onFollowGlobal={null}
              onPick={(mode) => {
                useLayout.getState().setSessionSort(mode);
                sortMenu.close();
              }}
            />
          ) : null}
        </div>
        {/* Not hover-revealed, unlike the sort beside it: this is the only
            way to start a session from the rail, and the empty state directly
            below says "Press + to start one" — a + that appears on hover
            makes that sentence a dead end. */}
        <button
          aria-label="New session"
          className="kr-hover-surface"
          onClick={onNewSession}
          style={iconButton()}
          type="button"
        >
          <Plus size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div style={listStyle}>
        {projects.length === 0 ? (
          <div style={emptyHintStyle}>
            No open sessions.
            <br />
            Press + to start one.
          </div>
        ) : null}
        {railProjects.length > 0 ? (
          <DndContext
            collisionDetection={closestCenter}
            onDragCancel={projectDrag.onDragCancel}
            onDragEnd={projectDrag.onDragEnd}
            onDragStart={projectDrag.onDragStart}
            sensors={projectDrag.sensors}
          >
            <SortableContext
              items={orderedProjectIds}
              strategy={verticalListSortingStrategy}
            >
              {railProjects.map((project) =>
                renderGroup(project, projectsSortable)
              )}
            </SortableContext>
          </DndContext>
        ) : null}
        {inactiveProjects.length > 0 ? (
          <>
            <button
              aria-expanded={showInactive}
              className="kr-hover-surface"
              data-testid="inactive-projects-summary"
              onClick={() => setShowInactive((open) => !open)}
              style={inactiveSummaryStyle}
              type="button"
            >
              <span style={inactiveChevronStyle(showInactive)}>
                <ChevronRight size={11} />
              </span>
              <Clock
                size={9}
                style={{ color: tokens.color.ink.dim, flex: "none" }}
              />
              <span style={{ flex: 1 }}>
                {inactiveProjects.length} inactive{" "}
                {inactiveProjects.length === 1 ? "project" : "projects"}
              </span>
            </button>
            {/* Revealed groups sit outside the SortableContext: a project the
                threshold has hidden is not a reorder target, exactly as the
                folded-away sessions inside a group are not. */}
            {showInactive ? (
              <>
                <div data-testid="inactive-block" style={inactiveBlockStyle}>
                  {inactiveProjects.map((project) =>
                    renderGroup(project, false, true)
                  )}
                </div>
                <span style={inactiveBlockEndStyle} />
              </>
            ) : null}
          </>
        ) : null}
        <ParkedGroup />
        <ArchivedGroup />
      </div>
      <SidebarFooter onShowAbout={onShowAbout} />
      <ResizeHandle />
    </aside>
  );
}
