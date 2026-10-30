import { closestCenter, DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowUpDown,
  Check,
  ChevronRight,
  Clock,
  GitBranch,
  GripVertical,
  MoreHorizontal,
  Palette,
  Plus,
} from "lucide-react";
import { type CSSProperties, memo, useState } from "react";
import { createSessionInProject } from "../state/actions.ts";
import { useCommandCenter } from "../state/commandCenter.ts";
import {
  effectiveSessionSort,
  type SessionSort,
  type SidebarMode,
  useLayout,
} from "../state/layout.ts";
import { isWorktreeSession, useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { projectColor } from "../theme/projectColor.ts";
import { tokens } from "../theme/tokens.ts";
import type { ProjectRow } from "../types.ts";
import { useAnchoredMenu } from "../ui/AnchoredMenu.tsx";
import {
  ClearProjectConfirm,
  projectSessionIds,
} from "./ClearProjectConfirm.tsx";
import { useRowDrag } from "./dragCommit.ts";
import { EarlierSessions } from "./EarlierSessions.tsx";
import { HeaderAction } from "./HeaderAction.tsx";
import { InlineRename } from "./InlineRename.tsx";
import { PaletteMenu } from "./PaletteMenu.tsx";
import { ProjectMenu } from "./ProjectMenu.tsx";
import { compactAge } from "./pastSessionTime.ts";
import type { ProjectLabel } from "./projectLabel.ts";
import { SessionRow } from "./SessionRow.tsx";
import { SortMenu } from "./SortMenu.tsx";
import {
  EMPTY_ORDER,
  type HideInputs,
  type OrderInputs,
  orderMatched,
} from "./sessionOrder.ts";

/** The session-store slices the ordering cache reads, in one place. */
function orderInputs(
  state: ReturnType<typeof useSessions.getState>
): OrderInputs {
  return {
    appendSeq: state.appendSeq,
    sessions: state.sessions,
    statusOrigin: state.statusOrigin,
    viewed: state.viewed,
  };
}

const projectHeaderStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "2px",
  // Anchors the color-picker popover.
  position: "relative",
};

/** Width of the grip column, shared by the live handle and its filtering-mode
 *  spacer so the header content never shifts between the two. */
const PROJECT_GRIP_WIDTH = "13px";

/**
 * The header's leading drag-grip: the project group's activator control, fading
 * in on hover (`kr-reveal-cluster`) and forced visible while dragging. Because
 * only this element carries dnd-kit's `listeners`, a press anywhere else in the
 * group header — the disclosure toggle, the hover actions — never starts a
 * project drag, which also keeps it clear of each group's inner session
 * `DndContext`. `pointerEvents: auto` and `position: relative` mirror the
 * session grip so the press reaches the listeners rather than the header
 * button beneath it.
 */
function projectGripStyle(dragging: boolean): CSSProperties {
  return {
    alignItems: "center",
    color: tokens.color.ink.dim,
    cursor: "grab",
    display: "flex",
    flex: "none",
    justifyContent: "center",
    opacity: dragging ? 1 : undefined,
    pointerEvents: "auto",
    position: "relative",
    width: PROJECT_GRIP_WIDTH,
  };
}

/**
 * Layers dnd-kit's transform/drag state on the group container. Uses
 * `CSS.Translate` (not `CSS.Transform`): project groups vary widely in height,
 * and `CSS.Transform` would fold dnd-kit's `scaleX/scaleY` into the moved group
 * and skew/stretch its text mid-drag. Translate-only moves it cleanly.
 */
function sortableGroupStyle(
  sortableGroup: ReturnType<typeof useSortable>
): CSSProperties {
  return {
    marginBottom: "6px",
    transform: CSS.Translate.toString(sortableGroup.transform),
    transition: sortableGroup.transition,
    ...(sortableGroup.isDragging
      ? { opacity: 0.75, position: "relative", zIndex: tokens.z.sticky }
      : null),
  };
}

const projectRowStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.md,
  cursor: "pointer",
  display: "flex",
  flex: 1,
  fontFamily: tokens.font.sans,
  // Matches the session row's content gap, which is what keeps the header's
  // chevron+swatch column exactly as wide as a row's grip+glyph column — see
  // the leading-inset agreement test in `Sidebar.test.tsx`.
  gap: "8px",
  height: "30px",
  minWidth: 0,
  padding: "0 8px",
  textAlign: "left",
};

// Quiet section header, the way Linear labels its teams: the sessions are the
// content, the project name is just a landmark. A collapsed group recedes one
// more step so the open groups carry the eye (design 5a).
function projectNameStyle(expanded: boolean): CSSProperties {
  return {
    color: expanded ? tokens.color.ink.secondary : tokens.color.ink.muted,
    flex: 1,
    fontSize: "12.5px",
    fontWeight: 500,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

/** Disclosure chevron — one icon, rotated when open (the standard motion). */
function chevronStyle(expanded: boolean): CSSProperties {
  return {
    alignItems: "center",
    color: tokens.color.ink.faint,
    display: "flex",
    flex: "none",
    transform: expanded ? "rotate(90deg)" : "none",
    transition: `transform ${tokens.motion.disclose}`,
  };
}

// The subtree under a project header: sessions and history share one indented
// container. Indentation alone carries the hierarchy (design 5a/5b) — no tree
// guide, so the rail reads as content, not chrome.
//
// This indent matches the header's leading drag-grip column (PROJECT_GRIP_WIDTH
// + the header's 2px gap): a row's own leading columns (grip slot, status
// glyph, row padding) already equal the header's chevron+swatch width, so once
// the header gained the grip, the whole subtree — session titles and the
// N-done / N-older summaries — sat one grip-column left of the project name.
// Shifting the container right by that column lands every title, and both
// fold summaries, flush under the name again.
const groupChildrenStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  // PROJECT_GRIP_WIDTH (13px) + projectHeaderStyle's 2px gap.
  paddingLeft: "15px",
};

// The header's trailing session count — quiet, machine-shaped, pinned to the
// rail's right edge. It stays *inside* the disclosure button (which is flex:1
// and, now that the actions are absolute, spans the full rail) so the count's
// own ~20px still toggles the group. Pulling it out to be a sibling put dead
// space over the header: the header div has no click handler, so a click there
// did nothing at all rather than falling through.
const projectCountStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  textAlign: "right",
};

/**
 * The "this project overrides the global sort" marker. An indicator, not a
 * button: the sort *control* lives in the hover cluster with the others, and
 * the cluster is an opaque 88px strip anchored to the right edge — anything
 * still rendered under it during hover is painted over, so an always-visible
 * button there was invisible exactly when the user reached for it.
 */
const sortOverrideMarkStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.faint,
  display: "flex",
  flex: "none",
};

/**
 * The header's hover-revealed actions (sort / palette / new-worktree / new),
 * laid over the right edge instead of sitting in flow — the same treatment
 * {@link SessionRow}'s row actions use, and for the same reason: four 22px
 * buttons that only fade their opacity still reserve 88px on every header,
 * truncating project names and stranding the session count far from the edge.
 * Absolute + a fade-to-sidebar gradient keeps them readable over the count.
 */
const headerActionsStyle: CSSProperties = {
  alignItems: "center",
  background: `linear-gradient(to right, transparent, ${tokens.color.chrome.sidebar} 35%)`,
  bottom: 0,
  display: "flex",
  gap: "2px",
  paddingLeft: "18px",
  position: "absolute",
  right: 0,
  top: 0,
};

const rollupDotStyle: CSSProperties = {
  background: tokens.color.status.waiting,
  borderRadius: "50%",
  height: "6px",
  width: "6px",
};

/** The header's "N sessions run in worktrees" count — quiet, machine-shaped. */
const worktreeCountStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.faint,
  display: "flex",
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10px",
  gap: "2px",
};

/**
 * The dimmed parent path that separates two identically named projects
 * (`Acme/` vs `review/`). Sized and toned a clear step below the name so it
 * reads as an address, not a second name, and `flex: none` so the *name* is
 * what ellipsizes when the rail narrows — losing the disambiguator would
 * defeat the whole point of showing one.
 */
const projectQualifierStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  flex: "none",
  fontSize: "10px",
  maxWidth: "45%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** A dormant project's "last touched" age — the staleness the fold implies. */
const dormantAgeStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10px",
};

/** The triage "N done" summary row that folds away read, finished sessions. */
const doneSummaryStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.md,
  // `inkMuted`, not a fainter stop: this is a label the user reads to decide
  // whether to open the fold, and `inkFaint` is below AA on the new plane.
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "11.5px",
  gap: "8px",
  // Left pad is 3px, not 9px, so the summary's label lands on the same column
  // as the session titles above it — its chevron+icon pair is wider than a
  // row's grip+glyph pair, and the difference comes out of the padding.
  padding: "5px 9px 5px 3px",
  textAlign: "left",
  width: "100%",
};

/**
 * The one row that folds away everything behind a project: its stale open
 * sessions *and* its on-disk history. They were two stacked utility rows per
 * group, which on a rail of seventeen projects cost more lines than the
 * sessions themselves. One control, one row, both halves inside it.
 */
const olderSummaryStyle: CSSProperties = doneSummaryStyle;

/** The merged row's label — the fold count leads when there is one. */
function olderHistoryLabel(olderCount: number): string {
  return olderCount > 0 ? `${olderCount} older \u00b7 history` : "History";
}

/** Spells out what the merged row's two halves actually are. */
function olderHistoryTitle(olderCount: number): string {
  const history = "earlier sessions found on disk";
  if (olderCount === 0) {
    return `Browse ${history}`;
  }
  const sessions = olderCount === 1 ? "session" : "sessions";
  return `${olderCount} stale ${sessions} hidden by your age filter, plus ${history}`;
}

function colorSquareStyle(project: ProjectRow): CSSProperties {
  return {
    background: projectColor(project),
    borderRadius: "2px",
    flex: "none",
    height: "8px",
    // Full strength on the new chrome. The half-opacity was tuned against the
    // old warm greys, where a saturated 7px square shouted; on the flat cool
    // plane it reads as a smudge instead of an identity mark.
    width: "8px",
  };
}

/**
 * dnd-kit's `attributes` include `aria-describedby`, pointing at keyboard-drag
 * instructions that don't apply to the pointer-only project grip. Drop just
 * that, keeping the role/tabIndex/roledescription that mark it a drag control.
 */
function gripAttributes(
  attributes: ReturnType<typeof useSortable>["attributes"]
): Record<string, unknown> {
  const { "aria-describedby": _describedBy, ...rest } = attributes;
  return rest;
}

/** The header's drag-grip wiring, forwarded from the group's {@link useSortable}. */
interface ProjectDragHandle {
  attributes: ReturnType<typeof useSortable>["attributes"];
  isDragging: boolean;
  listeners: ReturnType<typeof useSortable>["listeners"];
  setActivatorNodeRef: (node: HTMLElement | null) => void;
  /** Off while filtering — a searched rail isn't a reorder surface. */
  sortable: boolean;
}

interface ProjectHeaderProps {
  attention: boolean;
  collapsed: boolean;
  /** Last-activity age, shown only while the group sits in the inactive fold. */
  dormantAge: string | null;
  drag: ProjectDragHandle;
  /** Name renders one ink step brighter when the group is open/filtered. */
  expandedLook: boolean;
  /** Name plus the parent path that separates it from its same-named twins. */
  label: ProjectLabel;
  /** Ask to close every session in this project — the group owns the confirm. */
  onRequestClear: () => void;
  onToggleCollapsed: () => void;
  override: SessionSort | undefined;
  project: ProjectRow;
  sort: SessionSort;
  total: number;
  worktreeCount: number;
}

/**
 * The header's leading drag-grip: the group's activator control, or (while
 * filtering) an equal-width inert spacer. dnd-kit's `attributes` announce
 * `sortable` even when the sortable is disabled, so — like the session grip —
 * a non-reorderable header drops the attributes entirely rather than keeping a
 * disabled handle.
 */
function ProjectGrip({
  drag,
  project,
}: {
  drag: ProjectDragHandle;
  project: ProjectRow;
}) {
  if (!drag.sortable) {
    return (
      <span
        data-testid={`project-drag-handle-${project.id}`}
        style={{ flex: "none", width: PROJECT_GRIP_WIDTH }}
      />
    );
  }
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role="button" comes from the spread dnd-kit `attributes`, invisible to the linter.
    <span
      aria-label={`Reorder ${project.name}`}
      className="kr-reveal-cluster"
      data-testid={`project-drag-handle-${project.id}`}
      ref={drag.setActivatorNodeRef}
      style={projectGripStyle(drag.isDragging)}
      {...gripAttributes(drag.attributes)}
      {...drag.listeners}
    >
      <GripVertical size={12} />
    </span>
  );
}

/**
 * The group's header row: disclosure + name + rollups, the four
 * {@link HeaderAction}s, and the two popovers they trigger. Owns both
 * anchored menus (the header div is their shared anchor) so the group
 * component stays about sessions, not header chrome.
 */
function ProjectHeader({
  attention,
  collapsed,
  dormantAge,
  drag,
  expandedLook,
  label,
  onRequestClear,
  onToggleCollapsed,
  override,
  project,
  sort,
  total,
  worktreeCount,
}: ProjectHeaderProps) {
  const picker = useAnchoredMenu();
  const sortMenu = useAnchoredMenu<HTMLDivElement>();
  const actionsMenu = useAnchoredMenu<HTMLDivElement>();
  const [editing, setEditing] = useState(false);
  const commitRename = (next: string) => {
    setEditing(false);
    useSessions.getState().renameProject(project.id, next);
  };
  if (editing) {
    return (
      <div className="kr-reveal-parent" style={projectHeaderStyle}>
        <ProjectGrip drag={drag} project={project} />
        <span style={{ ...projectRowStyle, cursor: "default" }}>
          <span style={{ ...chevronStyle(!collapsed), visibility: "hidden" }}>
            <ChevronRight size={9} strokeWidth={2} />
          </span>
          <span style={colorSquareStyle(project)} />
          <InlineRename
            ariaLabel={`Rename ${project.name}`}
            onCancel={() => setEditing(false)}
            onCommit={commitRename}
            style={{ fontSize: "12px", fontWeight: 500 }}
            testId={`rename-project-${project.id}`}
            value={project.name}
          />
        </span>
      </div>
    );
  }
  return (
    <div
      className="kr-reveal-parent"
      ref={(node: HTMLDivElement | null) => {
        picker.anchorRef.current = node;
        sortMenu.anchorRef.current = node;
        actionsMenu.anchorRef.current = node;
      }}
      style={projectHeaderStyle}
    >
      <ProjectGrip drag={drag} project={project} />
      <button
        aria-expanded={!collapsed}
        className="kr-hover-surface"
        data-needs-attention={attention ? "true" : "false"}
        // Double-clicking the header (dominated by its name) opens the inline
        // rename; the Rename hover action is the equivalent explicit path.
        data-testid={`project-header-${project.id}`}
        onClick={onToggleCollapsed}
        onDoubleClick={() => setEditing(true)}
        style={projectRowStyle}
        // The qualifier is the shortest thing that separates two twins; the
        // tooltip is where the whole path stays reachable.
        title={project.path}
        type="button"
      >
        <span style={chevronStyle(!collapsed)}>
          <ChevronRight size={9} strokeWidth={2} />
        </span>
        <span style={colorSquareStyle(project)} />
        <span style={projectNameStyle(expandedLook)}>{label.name}</span>
        {label.qualifier ? (
          <span
            data-testid={`project-qualifier-${project.id}`}
            style={projectQualifierStyle}
          >
            {label.qualifier}
          </span>
        ) : null}
        {dormantAge ? (
          <span
            data-testid={`dormant-age-${project.id}`}
            style={dormantAgeStyle}
          >
            {dormantAge}
          </span>
        ) : null}
        {worktreeCount > 0 ? (
          <span
            data-testid={`worktree-count-${project.id}`}
            style={worktreeCountStyle}
            title={`${worktreeCount} session${worktreeCount === 1 ? "" : "s"} in worktrees`}
          >
            <GitBranch size={9} />
            {worktreeCount}
          </span>
        ) : null}
        {attention ? (
          <span data-testid="rollup-dot" style={rollupDotStyle} />
        ) : null}
        {override ? (
          <span
            data-testid={`sort-override-${project.id}`}
            style={sortOverrideMarkStyle}
            title={`Sorted by ${override} (overrides global)`}
          >
            <ArrowUpDown size={10} />
          </span>
        ) : null}
        <span
          data-testid={`session-count-${project.id}`}
          style={projectCountStyle}
        >
          {total}
        </span>
      </button>
      <span className="kr-reveal-cluster" style={headerActionsStyle}>
        <HeaderAction
          ariaLabel={`More actions for ${project.name}`}
          onClick={() => {
            sortMenu.close();
            picker.close();
            actionsMenu.toggle();
          }}
          reveal={false}
          title="Rename or clear this project"
          triggerAria={actionsMenu.triggerAria}
        >
          <MoreHorizontal size={13} />
        </HeaderAction>
        <HeaderAction
          ariaLabel={`Sort sessions in ${project.name}`}
          onClick={() => {
            // The header popovers share one anchor — opening one must close
            // the others or they'd stack at the identical spot.
            picker.close();
            actionsMenu.close();
            sortMenu.toggle();
          }}
          reveal={false}
          title={
            override
              ? `Sorted by ${override} (overrides global)`
              : "Sort this project's sessions"
          }
          triggerAria={sortMenu.triggerAria}
        >
          <ArrowUpDown size={12} />
        </HeaderAction>
        <HeaderAction
          ariaLabel={`Change color of ${project.name}`}
          onClick={() => {
            sortMenu.close();
            actionsMenu.close();
            picker.toggle();
          }}
          reveal={false}
          triggerAria={picker.triggerAria}
        >
          <Palette size={12} />
        </HeaderAction>
        <HeaderAction
          ariaLabel={`New worktree session in ${project.name}`}
          onClick={() =>
            useUi
              .getState()
              .openSpawn({ projectId: project.id }, { worktree: true })
          }
          reveal={false}
          title="New worktree session — own copy on a new branch"
        >
          <GitBranch size={12} />
        </HeaderAction>
        <HeaderAction
          ariaLabel={`New session in ${project.name}`}
          onClick={() => createSessionInProject(project)}
          reveal={false}
          title="New session here (current branch)"
        >
          <Plus size={13} />
        </HeaderAction>
      </span>
      {sortMenu.open ? (
        <SortMenu
          current={sort}
          onFollowGlobal={() => {
            useLayout.getState().setProjectSort(project.id, null);
            sortMenu.close();
          }}
          onPick={(picked) => {
            useLayout.getState().setProjectSort(project.id, picked);
            sortMenu.close();
          }}
        />
      ) : null}
      {picker.open ? (
        <PaletteMenu onClose={() => picker.close()} project={project} />
      ) : null}
      {actionsMenu.open ? (
        <ProjectMenu
          onRename={() => {
            actionsMenu.close();
            setEditing(true);
          }}
          onRequestClear={() => {
            actionsMenu.close();
            onRequestClear();
          }}
          projectId={project.id}
        />
      ) : null}
    </div>
  );
}

/**
 * A project's single "N older \u00b7 history" disclosure: the open sessions the
 * staleness filter folded away, and the past sessions still on disk.
 *
 * These were two stacked utility rows on every group, which on a rail of
 * seventeen projects cost more lines than the sessions themselves. Merging them
 * is honest — both answer "what else is behind this project?" — and folding
 * them behind one control halves the rail's chrome. {@link EarlierSessions}
 * stays mounted while shut so its loaded page and paging limit survive a
 * collapse; it renders nothing when closed.
 */
function OlderAndHistory({
  collapsedOld,
  mode,
  onCloseSession,
  onSelect,
  project,
}: {
  collapsedOld: string[];
  mode: SidebarMode;
  onCloseSession: (id: string) => void;
  onSelect: (id: string) => void;
  project: ProjectRow;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-expanded={open}
        className="kr-hover-surface"
        data-testid={`older-summary-${project.id}`}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        style={olderSummaryStyle}
        title={olderHistoryTitle(collapsedOld.length)}
        type="button"
      >
        <span style={chevronStyle(open)}>
          <ChevronRight size={11} />
        </span>
        <Clock
          size={11}
          style={{ color: tokens.color.ink.muted, flex: "none" }}
        />
        <span style={{ flex: 1 }}>
          {olderHistoryLabel(collapsedOld.length)}
        </span>
      </button>
      {open
        ? collapsedOld.map((sessionId) => (
            <SessionRow
              key={sessionId}
              mode={mode}
              onCloseSession={onCloseSession}
              onSelect={onSelect}
              sessionId={sessionId}
              sortable={false}
            />
          ))
        : null}
      <EarlierSessions
        open={open}
        projectId={project.id}
        projectPath={project.path}
      />
    </>
  );
}

interface ProjectGroupProps {
  /**
   * The group sits inside the rail's inactive fold. It opens collapsed —
   * independent of the persisted collapse set — and wears a staleness age, so
   * revealing eleven dormant projects costs eleven rows, not eleven subtrees.
   */
  dormant: boolean;
  /** Normalized (lowercased, trimmed) filter query; "" when not filtering. */
  filter: string;
  /** Name plus the parent path that separates it from its same-named twins. */
  label: ProjectLabel;
  /** Minute-quantized clock for the staleness fold; 0 when hiding is off. */
  nowMinute: number;
  onCloseSession: (id: string) => void;
  onSelect: (id: string) => void;
  project: ProjectRow;
  /** The group may be drag-reordered among projects — off while filtering. */
  sortable: boolean;
}

/**
 * A project's session group. Subscribes only to its own sessions' ids (order)
 * and a single "needs attention" flag, so a session's status/event tick does
 * not re-render the group — only the affected {@link SessionRow} updates.
 */
const ProjectGroup = memo(function ProjectGroup({
  dormant,
  filter,
  label,
  nowMinute,
  onCloseSession,
  onSelect,
  project,
  sortable,
}: ProjectGroupProps) {
  const sortableGroup = useSortable({ disabled: !sortable, id: project.id });
  // A query matching the project name keeps the whole group; otherwise it
  // narrows to sessions whose title matches.
  const nameMatch =
    filter !== "" && project.name.toLowerCase().includes(filter);
  const filtering = filter !== "";
  const mode = useLayout((state) => state.layout.sidebarMode);
  // A filtered rail shows every match as a row (no Done fold), so its ordering
  // stays `calm` even in triage — otherwise a searched-for finished session
  // would hide inside the summary.
  const listMode: SidebarMode = filtering ? "calm" : mode;
  const sort = useLayout((state) =>
    effectiveSessionSort(state.layout, project.id)
  );
  const manual = useLayout(
    (state) => state.layout.manualSessionOrder[project.id] ?? EMPTY_ORDER
  );
  const hideOlderThan = useLayout((state) => state.layout.hideOlderThan);
  const lastChangeMs = useCommandCenter((state) => state.lastChangeMs);
  // Filtering shows every match (no fold), same guard as drag. A dormant
  // group turns the threshold off too: its sessions are all stale by
  // definition (that is what put it in the fold), so keeping the threshold on
  // would hide every one of them behind a second "N older" fold inside the
  // fold the user just opened.
  const hide: HideInputs = {
    activeSessionId: null, // set inside the selector from live store state
    lastChangeMs,
    now: nowMinute,
    threshold: filtering || dormant ? "off" : hideOlderThan,
  };
  // One subscription for the whole ordering result: orderMatched's memo cache
  // returns the same OrderedSessions identity while its inputs are unchanged,
  // so plain equality suffices — no useShallow, and no second selector asking
  // the same question for the other half of the answer.
  const { collapsedDone, collapsedOld, nestDepth, rows } = useSessions(
    (state) =>
      orderMatched(
        orderInputs(state),
        project,
        filter,
        nameMatch,
        listMode,
        sort,
        manual,
        { ...hide, activeSessionId: state.activeSessionId }
      )
  );
  const [showDone, setShowDone] = useState(false);
  // The sessions the pending clear was asked about; null when no confirm is
  // up. The ids, not a count — see {@link ClearProjectConfirm}.
  const [clearing, setClearing] = useState<string[] | null>(null);
  const closeClearConfirm = () => setClearing(null);
  const attention = useSessions((state) =>
    Object.values(state.sessions).some(
      (session) =>
        session.projectId === project.id &&
        (session.status === "waiting" || session.status === "error") &&
        session.archivedAt === null
    )
  );
  // How many of this project's open sessions run in their own [Worktree] —
  // the header's at-a-glance "work is spread across checkouts" signal.
  const worktreeCount = useSessions(
    (state) =>
      Object.values(state.sessions).filter(
        (session) =>
          session.projectId === project.id &&
          session.archivedAt === null &&
          isWorktreeSession(session)
      ).length
  );
  const persistedCollapsed = useLayout((state) =>
    state.layout.collapsedProjectIds.includes(project.id)
  );
  const toggleProjectCollapsed = useLayout(
    (state) => state.toggleProjectCollapsed
  );
  // A dormant group's disclosure is local and starts shut: the fold above it
  // already answered "show me the dormant projects", not "show me all of their
  // sessions", and the persisted collapse set describes the active rail.
  const [dormantOpen, setDormantOpen] = useState(false);
  const collapsed = dormant ? !dormantOpen : persistedCollapsed;
  const toggleCollapsed = dormant
    ? () => setDormantOpen((open) => !open)
    : () => toggleProjectCollapsed(project.id);
  // Newest activity across the project's open sessions — `lastChangeMs` where
  // the session has produced output, its creation otherwise, exactly as the
  // staleness partition measures age.
  const lastActive = useSessions((state) => {
    let newest = 0;
    for (const session of Object.values(state.sessions)) {
      if (session.projectId !== project.id || session.archivedAt !== null) {
        continue;
      }
      newest = Math.max(newest, lastChangeMs[session.id] ?? session.createdAt);
    }
    return newest;
  });
  const dormantAge =
    dormant && lastActive > 0 ? compactAge(lastActive, Date.now()) : null;
  const override = useLayout(
    (state) => state.layout.projectSortOverrides[project.id]
  );
  const drag = useRowDrag({
    collapsedDone,
    projectId: project.id,
    projectName: project.name,
    rows,
  });

  // While filtering: no matches hides the group entirely, matches override a
  // collapsed disclosure, and history stays out of the way.
  const total = rows.length + collapsedDone.length + collapsedOld.length;
  if (filtering && total === 0) {
    return null;
  }
  const showChildren = filtering || !collapsed;

  return (
    <div
      data-testid="project-group"
      ref={sortableGroup.setNodeRef}
      style={sortableGroupStyle(sortableGroup)}
    >
      <ProjectHeader
        attention={attention}
        collapsed={collapsed}
        dormantAge={dormantAge}
        drag={{
          attributes: sortableGroup.attributes,
          isDragging: sortableGroup.isDragging,
          listeners: sortableGroup.listeners,
          setActivatorNodeRef: sortableGroup.setActivatorNodeRef,
          sortable,
        }}
        expandedLook={filtering || !collapsed}
        label={label}
        onRequestClear={() => setClearing(projectSessionIds(project.id))}
        onToggleCollapsed={toggleCollapsed}
        override={override}
        project={project}
        sort={sort}
        total={total}
        worktreeCount={worktreeCount}
      />
      {showChildren ? (
        <DndContext
          collisionDetection={closestCenter}
          onDragCancel={drag.onDragCancel}
          onDragEnd={drag.onDragEnd}
          onDragStart={drag.onDragStart}
          sensors={drag.sensors}
        >
          <div data-testid="project-children" style={groupChildrenStyle}>
            <SortableContext
              items={drag.displayRows}
              strategy={verticalListSortingStrategy}
            >
              {drag.displayRows.map((sessionId) => (
                <SessionRow
                  key={sessionId}
                  mode={mode}
                  nestDepth={nestDepth[sessionId] ?? 0}
                  onCloseSession={onCloseSession}
                  onSelect={onSelect}
                  sessionId={sessionId}
                  sortable={!filtering}
                />
              ))}
            </SortableContext>
            {collapsedDone.length > 0 ? (
              <>
                <button
                  aria-expanded={showDone}
                  className="kr-hover-surface"
                  data-testid={`done-summary-${project.id}`}
                  onClick={() => setShowDone((open) => !open)}
                  style={doneSummaryStyle}
                  type="button"
                >
                  <span style={chevronStyle(showDone)}>
                    <ChevronRight size={11} />
                  </span>
                  <Check
                    size={11}
                    style={{ color: tokens.color.ink.muted, flex: "none" }}
                  />
                  <span style={{ flex: 1 }}>{collapsedDone.length} done</span>
                </button>
                {showDone
                  ? collapsedDone.map((sessionId) => (
                      <SessionRow
                        key={sessionId}
                        mode={mode}
                        onCloseSession={onCloseSession}
                        onSelect={onSelect}
                        sessionId={sessionId}
                        sortable={false}
                      />
                    ))
                  : null}
              </>
            ) : null}
            {filtering ? null : (
              <OlderAndHistory
                collapsedOld={collapsedOld}
                mode={mode}
                onCloseSession={onCloseSession}
                onSelect={onSelect}
                project={project}
              />
            )}
          </div>
        </DndContext>
      ) : null}
      <ClearProjectConfirm
        onCancel={closeClearConfirm}
        onCloseSession={onCloseSession}
        project={project}
        sessionIds={clearing}
      />
    </div>
  );
});

export { ProjectGroup };
