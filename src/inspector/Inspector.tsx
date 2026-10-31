import { PanelRight } from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { topBandRow } from "../layout/topBand.ts";
import { formatBootTime, useBootTimes } from "../state/bootTiming.ts";
import {
  computeTotalsFromFiles,
  useChanges,
  visibleFiles,
} from "../state/changes.ts";
import { homeRelative } from "../state/homeRelative.ts";
import { type InspectorTab, useLayout } from "../state/layout.ts";
import { usePlanLimitsView } from "../state/planLimits.ts";
import {
  sessionTouchedRelative,
  sessionWorkingDir,
  useSessions,
} from "../state/sessions.ts";
import {
  LIMIT_NOTE,
  sessionUsageView,
  type UsageTone,
  usageTone,
} from "../state/usage.ts";
import { useRepoView } from "../state/useActiveSession.ts";
import { iconButton, kvRow, sectionLabel } from "../theme/recipes.ts";
import { statusDotStyle, statusMeta } from "../theme/status.ts";
import { tokens } from "../theme/tokens.ts";
import type { DiffTotals, SessionStatus, UsageSnapshot } from "../types.ts";
import { CollapsibleSection } from "../ui/CollapsibleSection.tsx";
import { Segmented, type SegmentedOption } from "../ui/Segmented.tsx";
import { ActivitySection } from "./activity/ActivitySection.tsx";
import { ActivityTab } from "./activityLog/ActivityTab.tsx";
import { ChangedFilesList } from "./ChangedFilesList.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";

/** The inspector's width on its Details tab — the Shell's collapse panel
 *  animates to it. */
export const INSPECTOR_WIDTH = 280;

/** Wider on the Activity tab, where a step's title, command and flags need
 *  room side by side (the design draws it at 400). */
export const ACTIVITY_INSPECTOR_WIDTH = 380;

/** The inspector's width for the tab it shows. */
export function inspectorWidth(tab: InspectorTab): number {
  return tab === "activity" ? ACTIVITY_INSPECTOR_WIDTH : INSPECTOR_WIDTH;
}

const rootStyle: CSSProperties = {
  background: tokens.color.chrome.inspector,
  borderLeft: `1px solid ${tokens.color.line.soft}`,
  color: tokens.color.text,
  display: "flex",
  flex: 1,
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  minHeight: 0,
  overflowY: "auto",
};

const emptyBodyStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.faint,
  display: "flex",
  flex: 1,
  flexDirection: "column",
  fontSize: "12.5px",
  gap: tokens.space.sm,
  justifyContent: "center",
};

/**
 * The rail's own 46px header. "Details" is the visible name the canvas gives
 * this column; the code stays `Inspector` (see CONTEXT.md). It carries the
 * collapse button that used to live in the title bar, and — being in the
 * window's top band — it is a drag region too.
 *
 * It is the one top-band header that never carries the traffic-light inset:
 * it sits on the other side of the window and is never its top-left corner.
 */
const detailsHeaderStyle: CSSProperties = topBandRow({
  padding: "0 12px 0 18px",
});

const detailsTitleStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "13px",
  fontWeight: 500,
};

const INSPECTOR_TABS: readonly SegmentedOption<InspectorTab>[] = [
  { label: "Details", value: "details" },
  { label: "Activity", value: "activity" },
];

/** With a session the title is the tab strip; without one, just "Details". */
function DetailsHeader({
  onTab,
  tab,
}: {
  onTab?: (tab: InspectorTab) => void;
  tab?: InspectorTab;
}) {
  const collapse = useLayout((state) => state.toggleInspectorCollapsed);
  return (
    <div data-tauri-drag-region style={detailsHeaderStyle}>
      {onTab && tab ? (
        <Segmented
          ariaLabel="Details rail"
          onChange={onTab}
          options={INSPECTOR_TABS}
          value={tab}
          variant="underline"
        />
      ) : (
        <span style={detailsTitleStyle}>Details</span>
      )}
      <button
        aria-label="Collapse inspector"
        className="kr-hover-surface"
        onClick={collapse}
        style={iconButton()}
        title="Collapse inspector"
        type="button"
      >
        <PanelRight size={13} strokeWidth={1.75} />
      </button>
    </div>
  );
}

const sectionLabelStyle: CSSProperties = {
  ...sectionLabel(),
  display: "block",
  paddingBottom: "6px",
};

/**
 * The rail's body. One scroll column with 22px between sections; the sections
 * themselves no longer draw dividing rules, because every row inside them
 * already ends in a hairline and two rule weights in a 280px column reads as
 * a table rather than a summary.
 */
const bodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "22px",
  padding: "16px 18px",
};

const monoMutedStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
};

const kvRowStyle: CSSProperties = kvRow();
const kvLastRowStyle: CSSProperties = kvRow({ last: true });

const kvLabelStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontSize: "12.5px",
};

const kvValueStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "12.5px",
  maxWidth: "62%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const monoValueStyle: CSSProperties = {
  ...kvValueStyle,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
};

/** A usage meter: a 4px sunken track with an accent fill. */
const meterTrackStyle: CSSProperties = {
  background: tokens.color.inputWell,
  borderRadius: "2px",
  height: "4px",
  marginTop: "6px",
  overflow: "hidden",
};

/** A meter's fill by how full it reads: amber from 80%, the one place this
 *  rail raises its voice, with the same waiting hue the rest of the app uses
 *  for "look here"; coral once it is full. */
const METER_FILL: Record<UsageTone, string> = {
  full: tokens.color.status.error,
  high: tokens.color.status.waiting,
  normal: tokens.color.accentBright,
};

function meterFillStyle(percent: number): CSSProperties {
  return {
    background: METER_FILL[usageTone(percent)],
    borderRadius: "2px",
    height: "100%",
    transition: `width ${tokens.motion.panel}`,
    width: `${percent}%`,
  };
}

/** Coarse "Nm ago" / "Nh ago" relative label. */
function startedLabel(createdAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

/** The Changes section's always-visible header summary: a noise-filtered,
 * baseline-relative aggregate over exactly the files listed below it — the
 * store's `totals` with "My edits only" off, and totals recomputed over the
 * filtered subset with it on (I5), never a mix of the two. `repo.dirtyCount`
 * is a different number — a raw, unfiltered working-tree count — and must
 * never substitute for it here (see Task 11 review history). Returns `null`
 * while totals haven't loaded yet; the caller renders a neutral placeholder. */
function changesSummaryLabel(
  totals: DiffTotals | null | undefined
): string | null {
  if (!totals) {
    return null;
  }
  const fileWord = totals.files === 1 ? "file" : "files";
  return `${totals.files} ${fileWord} +${totals.additions} −${totals.deletions}`;
}

function Kv({
  label,
  last,
  mono,
  title,
  value,
}: {
  label: string;
  /** Drops the bottom hairline — a trailing rule reads as "more follows". */
  last?: boolean;
  mono?: boolean;
  /** Hover text for a value the 280px column has to truncate. */
  title?: string;
  value: ReactNode;
}) {
  return (
    <div style={last ? kvLastRowStyle : kvRowStyle}>
      <span style={kvLabelStyle}>{label}</span>
      <span style={mono ? monoValueStyle : kvValueStyle} title={title}>
        {value}
      </span>
    </div>
  );
}

/** The Session section's status row: the same dot and ink the sidebar and the
 *  header pill read, so three surfaces cannot disagree about one session. */
function StatusValue({ status }: { status: SessionStatus }) {
  const meta = statusMeta(status);
  return (
    <span
      style={{
        alignItems: "center",
        color: meta.ink,
        display: "inline-flex",
        gap: "6px",
      }}
    >
      <span style={statusDotStyle(status, 6)} />
      {meta.label}
    </span>
  );
}

/** One labelled meter row: the label, a mono reading, then the bar. */
function UsageMeter({
  label,
  percent,
  reading,
  testId,
  title,
}: {
  label: string;
  percent: number | null;
  reading: string;
  testId: string;
  /** Hover text saying where the figure comes from. */
  title?: string;
}) {
  return (
    <div data-testid={testId} style={{ marginTop: "10px" }} title={title}>
      <div style={{ ...kvRowStyle, border: "none", height: "auto" }}>
        <span style={kvLabelStyle}>{label}</span>
        <span style={monoMutedStyle}>{reading}</span>
      </div>
      <div style={meterTrackStyle}>
        <div style={meterFillStyle(percent ?? 0)} />
      </div>
    </div>
  );
}

/**
 * The Usage section: the context window as Claude reads it, and the
 * account's [Plan limits]. Every figure is one Claude reported exactly; what
 * it hasn't reported shows "—" or is left out (ADR-0038).
 */
function UsageSection({ live }: { live: UsageSnapshot | undefined }) {
  const limits = usePlanLimitsView();
  const view = sessionUsageView(live);
  return (
    <>
      <UsageMeter
        label="Context window"
        percent={view.ctxPct}
        reading={view.reading}
        testId="usage-context"
      />
      {limits.windows.map((limit) => (
        <UsageMeter
          key={limit.id}
          label={limit.label}
          percent={limit.percent}
          reading={`${limit.percent}% · resets ${limit.resets}`}
          testId={`usage-${limit.id}`}
          title={LIMIT_NOTE}
        />
      ))}
      {limits.pace ? (
        <div
          data-testid="usage-pace"
          style={paceStyle}
          title="From how fast Claude's own figure rose over the last hour"
        >
          {limits.pace.text}
        </div>
      ) : null}
    </>
  );
}

const paceStyle: CSSProperties = {
  color: tokens.color.status.waitingInk,
  fontSize: "11.5px",
  lineHeight: 1.4,
  marginTop: tokens.space.sm,
};

export function Inspector() {
  const activeSessionId = useSessions((state) => state.activeSessionId);
  const session = useSessions((state) =>
    activeSessionId ? state.sessions[activeSessionId] : undefined
  );
  const live = useSessions((state) =>
    activeSessionId ? state.usage[activeSessionId] : undefined
  );
  const activity = useSessions((state) =>
    activeSessionId ? state.activity[activeSessionId] : undefined
  );
  const bootMs = useBootTimes((state) =>
    activeSessionId ? state.ms[activeSessionId] : undefined
  );
  const projectPath = useSessions((state) =>
    session
      ? (state.projects.find((p) => p.id === session.projectId)?.path ?? null)
      : null
  );
  const repoPath = sessionWorkingDir(session);
  const { missing: repoMissing, status: repo } = useRepoView(repoPath);
  const diff = useChanges(
    (state) => state.bySession[activeSessionId ?? ""]?.diff
  );
  const totals = useChanges(
    (state) => state.bySession[activeSessionId ?? ""]?.totals
  );
  // Memoized on `diff` (a fresh object only on refresh) so this sidebar,
  // which re-renders on every unrelated Inspector state change (usage
  // ticks, activity events), doesn't re-filter the file list every time —
  // see `ChangesView`'s matching comment on its own `visibleFiles` call.
  const changedFiles = useMemo(() => visibleFiles(diff), [diff]);
  // "My edits only" is session-keyed store state shared with `ChangesView`,
  // and this sidebar is on screen at the same time as that view's
  // `SummaryBar` — so it has to describe the same population the centre does
  // (I5: totals follow the filter), or the two contradict each other in one
  // glance. Read through the same exported helpers `ChangesView` uses rather
  // than re-deriving the touched set here; `sessionTouchedRelative` returns a
  // stable `Set` until `touchedFiles`/`repoToplevel` actually change, so
  // subscribing through `useSessions` re-renders exactly then and never on an
  // unrelated store update (see its doc comment in `state/sessions.ts`).
  // A scalar selector, deliberately: the flag shares one `ui` entry with the
  // Changes view's tab and selection (see `ChangesState`), and zustand
  // compares a selector's output — so a tab flip over there re-renders
  // nothing here.
  // Only when the user turned it on explicitly: the Inspector lists the
  // whole session for review, so the Files view's on-by-default AI scope
  // (`myEditsOnlyOf`) doesn't narrow it.
  const myEditsOnly = useChanges(
    (state) => state.ui[activeSessionId ?? ""]?.myEditsOnly === true
  );
  const touchedRelative = useSessions(() =>
    sessionTouchedRelative(activeSessionId ?? "")
  );
  const displayFiles = useMemo(() => {
    if (!myEditsOnly) {
      return changedFiles;
    }
    return changedFiles.filter((f) => touchedRelative.has(f.path));
  }, [changedFiles, myEditsOnly, touchedRelative]);
  // Falls back to the store's unfiltered `totals` with the filter off, and
  // stays `null` until a diff has actually landed — recomputing over an empty
  // `displayFiles` before then would print a confident "0 files +0 −0" where
  // the header's neutral "…" placeholder belongs.
  const displayTotals = useMemo(
    () =>
      myEditsOnly && totals ? computeTotalsFromFiles(displayFiles) : totals,
    [displayFiles, myEditsOnly, totals]
  );
  const setTranscriptView = useLayout((state) => state.setTranscriptView);
  const requestJump = useChanges((state) => state.requestJump);
  const inspectorChangesOpen = useLayout(
    (state) => state.layout.inspectorChangesOpen
  );
  const setInspectorChangesOpen = useLayout(
    (state) => state.setInspectorChangesOpen
  );
  const tab = useLayout((state) => state.inspectorTab);
  const setTab = useLayout((state) => state.setInspectorTab);

  if (!session) {
    return (
      <aside data-testid="inspector" style={rootStyle}>
        <DetailsHeader />
        <div style={emptyBodyStyle}>
          <span>No active session</span>
          <span>—</span>
        </div>
      </aside>
    );
  }

  const openInChanges = (path: string) => {
    setTranscriptView("changes");
    requestJump(session.id, path);
  };

  if (tab === "activity") {
    return (
      <aside data-testid="inspector" style={rootStyle}>
        <DetailsHeader onTab={setTab} tab={tab} />
        <ActivityTab onOpenInChanges={openInChanges} sessionId={session.id} />
      </aside>
    );
  }

  return (
    <aside data-testid="inspector" style={rootStyle}>
      <DetailsHeader onTab={setTab} tab={tab} />
      <div style={bodyStyle}>
        {/* Session first: the canvas leads with what this session *is*, then
            what it changed, then what it cost. The old order opened on the
            diff, which is the one thing the Changes view already answers in
            full. */}
        <section>
          <span style={sectionLabelStyle}>Session</span>
          <Kv label="Status" value={<StatusValue status={session.status} />} />
          <Kv label="Branch" mono value={repo ? repo.branch : "—"} />
          <Kv label="Started" value={startedLabel(session.createdAt)} />
          <Kv
            label="Start time"
            mono
            title="How long claude took to start or resume in this session, last time"
            value={formatBootTime(bootMs)}
          />
          <Kv
            label="Directory"
            last
            mono
            title={repoPath || undefined}
            value={repoPath ? homeRelative(repoPath) : "—"}
          />
        </section>

        <section>
          <CollapsibleSection
            headerRight={
              <span
                data-testid="changes-header-stat"
                style={monoMutedStyle}
                // The stat and the Uncommitted row below it are deliberately
                // different numbers — this session's diff against its
                // baseline, versus the whole working tree — and side by side
                // they read as a contradiction when a file was already dirty
                // before the session began.
                title="What this session changed, against the baseline it started from"
              >
                {/* A file count beside "Not a git repository" is a number
                    about a thing that doesn't exist. */}
                {repo === null
                  ? "—"
                  : (changesSummaryLabel(displayTotals) ?? "…")}
              </span>
            }
            onToggle={setInspectorChangesOpen}
            open={inspectorChangesOpen}
            testId="inspector-changes-section"
            title="Changes"
          >
            {/* This pair of lines describes the *working tree* (raw `git
                status`), not the baseline-relative changed-files list below it
                — `diff_session_changes` is tree-vs-tree, so a session that has
                committed its edits keeps them in the list while `git status`
                reports nothing outstanding. The clean branch therefore says
                "No uncommitted changes" (matching the "Uncommitted" row it
                stands in for) rather than "Working tree clean", which read as
                a claim about the populated list directly underneath it. */}
            {repo && repo.dirtyCount > 0 ? (
              <>
                <Kv label="Uncommitted" value={`${repo.dirtyCount} changes`} />
                <Kv
                  label="Sync"
                  last
                  mono
                  value={`↑${repo.ahead} ↓${repo.behind}`}
                />
              </>
            ) : (
              <span
                style={{ color: tokens.color.ink.muted, fontSize: "12.5px" }}
              >
                {repoMissing
                  ? "Not a git repository"
                  : "No uncommitted changes"}
              </span>
            )}
            <ChangedFilesList files={displayFiles} onOpen={openInChanges} />
          </CollapsibleSection>
        </section>

        <section>
          <span style={sectionLabelStyle}>Usage</span>
          <UsageSection live={live} />
        </section>

        {session.worktreePath && projectPath && repo?.branch ? (
          <ReviewPanel
            branch={repo.branch}
            repoRoot={projectPath}
            worktreePath={session.worktreePath}
          />
        ) : null}
      </div>
      <ActivitySection
        activity={
          activity ?? {
            main: { currentTool: null },
            pendingAsk: null,
            shells: [],
            subagents: [],
            tasks: [],
          }
        }
      />
    </aside>
  );
}
