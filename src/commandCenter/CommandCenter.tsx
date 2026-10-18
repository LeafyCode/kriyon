import type { CSSProperties } from "react";
import { ViewHeader } from "../layout/ViewHeader.tsx";
import { NeedsYouList } from "../needsYou/NeedsYouList.tsx";
import { useLayout } from "../state/layout.ts";
import { useSessions } from "../state/sessions.ts";
import { useNeedsYouView } from "../state/useNeedsYouView.ts";
import { row30, sectionLabel } from "../theme/recipes.ts";
import { statusMeta } from "../theme/status.ts";
import { tokens } from "../theme/tokens.ts";
import type {
  NotifyPreference,
  SessionStanding,
  StandingState,
} from "../types.ts";
import { Segmented } from "../ui/Segmented.tsx";

interface StateMeta {
  color: string;
  label: string;
}

/**
 * The dot color and label for a standing. Concrete states reuse {@link statusMeta}
 * so the palette stays in one place; `unknown` is rendered distinctly with the
 * faint ink ramp and never collapsed into `idle`.
 */
function standingMeta(state: StandingState): StateMeta {
  switch (state) {
    case "running":
      return { color: statusMeta("running").color, label: "Running" };
    case "awaiting_input":
      return {
        color: statusMeta("waiting").color,
        label: "Awaiting input",
      };
    case "changed":
      return { color: statusMeta("done").color, label: "Changed" };
    case "idle":
      return { color: statusMeta("idle").color, label: "Idle" };
    default:
      return { color: tokens.color.ink.faint, label: "Unknown" };
  }
}

const NOTIFY_OPTIONS: { label: string; value: NotifyPreference }[] = [
  { label: "All", value: "all" },
  { label: "Only blocked", value: "only_blocked" },
  { label: "Off", value: "none" },
];

const containerStyle: CSSProperties = {
  background: tokens.color.chrome.window,
  color: tokens.color.text,
  display: "flex",
  // The shell is a row since ADR-0023, so this view is a flex child of it:
  // `height: 100%` covers the cross axis, and `flex: 1` the main one. Without
  // the grow the view sizes to max-content and stops at its widest row.
  flex: 1,
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  height: "100%",
  minHeight: 0,
  minWidth: 0,
  overflowY: "auto",
};

const sectionLabelStyle: CSSProperties = sectionLabel();

const railStyle: CSSProperties = {
  borderBottom: `1px solid ${tokens.color.line.base}`,
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  padding: "20px 24px",
};

const emptyStateStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
};

const bodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "22px",
  padding: "20px 24px",
};

const groupNameStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "12.5px",
  fontWeight: 500,
  marginBottom: "6px",
};

/** A standing: the 30px list row on the 32px key-value rhythm. */
function standingRowStyle(active: boolean): CSSProperties {
  return {
    ...row30({ active }),
    border: "none",
    cursor: "pointer",
    gap: tokens.space.sm,
    height: "32px",
    textAlign: "left",
    width: "100%",
  };
}

function dotStyle(color: string): CSSProperties {
  return {
    background: color,
    borderRadius: "50%",
    flex: "none",
    height: "6px",
    width: "6px",
  };
}

const standingTitleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const stateLabelStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontSize: "11px",
};

/** One clickable standing row: dot, session title, and its (testable) state. */
function StandingRow({
  standing,
  title,
  active,
  onOpen,
}: {
  active: boolean;
  onOpen: (id: string) => void;
  standing: SessionStanding;
  title: string;
}) {
  const meta = standingMeta(standing.state);
  return (
    <button
      className="kr-hover-surface"
      data-testid={`standing-${standing.sessionId}`}
      onClick={() => onOpen(standing.sessionId)}
      style={standingRowStyle(active)}
      type="button"
    >
      <span style={dotStyle(meta.color)} />
      <span style={standingTitleStyle}>{title}</span>
      <span
        data-testid={`standing-state-${standing.sessionId}`}
        style={stateLabelStyle}
      >
        {meta.label}
      </span>
    </button>
  );
}

/**
 * The command center: a cross-project overview of every session's standing,
 * with a "Needs you" rail for sessions blocked on input. Derives everything from
 * the session store and watcher liveness via the pure {@link buildStandings}
 * helpers, recomputed on a light interval so staleness advances with no events.
 */
export function CommandCenter() {
  const sessions = useSessions((state) => state.sessions);
  const activeSessionId = useSessions((state) => state.activeSessionId);
  const setActiveSession = useSessions((state) => state.setActiveSession);
  const showSessionView = useLayout((state) => state.showSessionView);
  const setTranscriptView = useLayout((state) => state.setTranscriptView);
  const notifyPreference = useLayout((state) => state.layout.notifyPreference);
  const setNotifyPreference = useLayout((state) => state.setNotifyPreference);
  const { blocked, groups, entries } = useNeedsYouView();

  function openStanding(id: string): void {
    setActiveSession(id);
    showSessionView();
  }

  return (
    <div data-testid="command-center" style={containerStyle}>
      <ViewHeader
        actions={
          <Segmented
            ariaLabel="Notifications"
            onChange={setNotifyPreference}
            options={NOTIFY_OPTIONS}
            value={notifyPreference}
          />
        }
        testId="command-center-header"
        title="Command center"
      />

      <div data-testid="needs-you" style={railStyle}>
        <span style={sectionLabelStyle}>Needs you</span>
        {blocked.length > 0 ? (
          <NeedsYouList
            activeSessionId={activeSessionId}
            entries={entries}
            onOpen={(id, exact) => {
              openStanding(id);
              if (exact) {
                // The prompt is answered in the terminal: a detour, not a
                // change of the user's preferred view.
                setTranscriptView("raw", false);
              }
            }}
          />
        ) : (
          <span style={emptyStateStyle}>
            Nothing is waiting on you right now.
          </span>
        )}
      </div>

      <div style={bodyStyle}>
        {groups.map((group) => (
          <div
            data-testid={`standing-group-${group.project.id}`}
            key={group.project.id}
          >
            <div style={groupNameStyle}>{group.project.name}</div>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "1px" }}
            >
              {group.standings.map((standing) => (
                <StandingRow
                  active={standing.sessionId === activeSessionId}
                  key={standing.sessionId}
                  onOpen={openStanding}
                  standing={standing}
                  title={
                    sessions[standing.sessionId]?.title ?? standing.sessionId
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
