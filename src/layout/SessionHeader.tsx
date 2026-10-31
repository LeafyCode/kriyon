import { Ellipsis } from "lucide-react";
import type { CSSProperties } from "react";
import { useChanges } from "../state/changes.ts";
import { changedFileCount } from "../state/changesView.ts";
import { useLayout } from "../state/layout.ts";
import { sessionTouchedRelative, useSessions } from "../state/sessions.ts";
import { useActiveSession, useRepoStatus } from "../state/useActiveSession.ts";
import { projectColor } from "../theme/projectColor.ts";
import { iconButton, pill } from "../theme/recipes.ts";
import { statusDotStyle, statusMeta } from "../theme/status.ts";
import { tokens } from "../theme/tokens.ts";
import { Segmented } from "../ui/Segmented.tsx";
import { CompanionChip } from "./CompanionChip.tsx";
import { companionChip } from "./companionChip.ts";
import { TerminalToggle } from "./TerminalToggle.tsx";
import { topBandRow, trafficLightInset } from "./topBand.ts";
import { useCompanionStatus } from "./useCompanionStatus.ts";
import { SidebarExpandButton } from "./ViewHeader.tsx";

/** One of the header's two 46px rows. */
const rowStyle: CSSProperties = topBandRow();

const crumbStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: 1,
  gap: "10px",
  minWidth: 0,
};

const rootCrumbStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontSize: "13px",
};

const separatorStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  flex: "none",
};

const projectNameStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  flex: "none",
  fontSize: "13px",
  fontWeight: 500,
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  fontSize: "13px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const branchStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  whiteSpace: "nowrap",
};

const rightStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  gap: "8px",
};

/**
 * The project's initial on a tile of its own colour — the canvas's way of
 * naming the project without spending a whole word's width on it. The tile is
 * the project colour at ~35%, so the letter stays readable on it.
 */
function projectTileStyle(project: {
  color: string | null;
  id: string;
}): CSSProperties {
  const hue = projectColor(project);
  return {
    alignItems: "center",
    background: `color-mix(in srgb, ${hue} 35%, transparent)`,
    borderRadius: tokens.radius.sm,
    color: tokens.color.ink.primary,
    display: "flex",
    flex: "none",
    fontSize: "10px",
    fontWeight: 700,
    height: "18px",
    justifyContent: "center",
    width: "18px",
  };
}

/**
 * The session column's two-row header: a breadcrumb row and a tab row, each
 * 46px with a hairline under it.
 *
 * Both rows are `data-tauri-drag-region` — with the title bar gone
 * (ADR-0023), this band *is* how the window is dragged over most of its
 * width. And when the sidebar is collapsed, the band also inherits the
 * traffic-light clearance, because nothing else is left in that corner.
 */
export function SessionHeader() {
  const { project, repoPath, session } = useActiveSession();
  const transcriptView = useLayout((state) => state.layout.transcriptView);
  const setTranscriptView = useLayout((state) => state.setTranscriptView);
  const sidebarCollapsed = useLayout((state) => state.layout.sidebarCollapsed);
  const repo = useRepoStatus(repoPath);
  const companion = useCompanionStatus(session?.id ?? "");
  // The count on the tab has to be the number of files the tab *opens on* —
  // the session's diff against its baseline. `repo.dirtyCount` is the raw
  // working-tree count, which includes edits made before the session started:
  // sourcing the badge from it produced a "Changes 1" tab that opened on an
  // empty view, because the one dirty file was not this session's doing.
  //
  // It comes through `changedFileCount` rather than off the store's totals for
  // the second half of the same rule: this tab shares a header with the
  // [Summary bar], and reading the whole-diff count made it contradict the bar
  // whenever "My edits only" narrowed the feed beneath them both.
  const touchedRelative = useSessions(() =>
    sessionTouchedRelative(session?.id ?? "")
  );
  const changedFiles = useChanges((state) =>
    changedFileCount(state, session?.id ?? "", touchedRelative)
  );

  const bandStyle: CSSProperties = {
    flex: "none",
    ...trafficLightInset(sidebarCollapsed),
  };

  // The band renders even with no session. It used to return null, which was
  // harmless while a title bar existed; now it owns the window's drag surface
  // and — with the sidebar collapsed — the only way to bring the sidebar
  // back, so an empty app would have had neither.
  if (!session) {
    return (
      <div data-testid="main-top-band" style={bandStyle}>
        <header data-tauri-drag-region style={rowStyle}>
          <div data-tauri-drag-region style={crumbStyle}>
            {sidebarCollapsed ? <SidebarExpandButton /> : null}
            <span style={rootCrumbStyle}>Sessions</span>
          </div>
        </header>
      </div>
    );
  }

  const meta = statusMeta(session.status);

  return (
    <div data-testid="main-top-band" style={bandStyle}>
      <header data-tauri-drag-region style={rowStyle}>
        <div data-tauri-drag-region style={crumbStyle}>
          {sidebarCollapsed ? <SidebarExpandButton /> : null}
          <span style={rootCrumbStyle}>Sessions</span>
          <span style={separatorStyle}>/</span>
          {project ? (
            <>
              <span style={projectTileStyle(project)}>
                {project.name.charAt(0).toUpperCase()}
              </span>
              <span style={projectNameStyle}>{project.name}</span>
              <span style={separatorStyle}>/</span>
            </>
          ) : null}
          <span style={titleStyle}>{session.title}</span>
        </div>
        <div style={rightStyle}>
          <CompanionChip status={companion} />
          <span style={pill(session.status)}>
            <span style={statusDotStyle(session.status, 6)} />
            {meta.label}
          </span>
          {repo ? <span style={branchStyle}>⎇ {repo.branch}</span> : null}
          <button
            aria-label="Session options"
            className="kr-hover-surface"
            style={iconButton()}
            title="More"
            type="button"
          >
            <Ellipsis size={14} strokeWidth={1.75} />
          </button>
        </div>
      </header>
      <div data-tauri-drag-region style={rowStyle}>
        <Segmented
          ariaLabel="Transcript view"
          onChange={setTranscriptView}
          options={[
            {
              // Never disabled: with the companion off, the view itself says
              // so and offers to turn it on — a dead tab only said it on hover.
              label: "Structured",
              title:
                companion === null || companion.state === "on"
                  ? undefined
                  : (companionChip(companion)?.title ??
                    "Kriyon Companion is off. Open to turn it on."),
              value: "structured",
            },
            { label: "Session", value: "raw" },
            // Last, apart from the two ways of watching the session: this is
            // the project's files (changed ones and the whole tree), a place
            // you visit rather than a view a session opens in.
            { count: changedFiles, label: "Files", value: "changes" },
          ]}
          value={transcriptView}
          variant="underline"
        />
        <div style={rightStyle}>
          <TerminalToggle />
        </div>
      </div>
    </div>
  );
}
