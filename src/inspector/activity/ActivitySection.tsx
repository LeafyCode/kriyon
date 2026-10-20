import type { CSSProperties } from "react";
import { tokens } from "../../theme/tokens.ts";
import type { SessionActivity } from "../../types.ts";
import { Section } from "../chrome.tsx";
import { AgentsPanel } from "./AgentsPanel.tsx";
import { BackgroundPanel } from "./BackgroundPanel.tsx";
import { TasksPanel } from "./TasksPanel.tsx";
import { elapsedLabel, toolLabel } from "./toolLabel.ts";
import { useNow } from "./useNow.ts";

const toolNameStyle: CSSProperties = {
  // `accentBright`, not `accent`: the mid accent is a *fill* colour on this
  // palette and reads as a bruise when set as 12.5px text.
  color: tokens.color.accentBright,
  fontSize: "12.5px",
  fontWeight: 500,
};

const toolTimeStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11px",
  marginLeft: tokens.space.sm,
};

const idleStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
};

/**
 * The Inspector's live activity area: the main agent's in-flight tool, the
 * subagent / task / background panels, and a visible "Idle" line when nothing is
 * running — so "settled to idle" is a state the user can see, not a vanished
 * section.
 *
 * A panel *appears* whenever it has anything to list — a finished subagent and
 * a ticked-off checklist are both worth reading. Whether the line above them
 * says `Working…` is a narrower question, and the answer is **work that is in
 * flight**, not lists that are non-empty. Getting that wrong put "Working…"
 * directly under a `Done` status pill, which is the Details rail contradicting
 * itself on one screen.
 *
 * Background shells are excluded from the question entirely. ADR-0002: the
 * transcript carries no completion signal for them, so a shell reads `running`
 * until Claude happens to poll it — sometimes hours after it exited. Listing
 * that with its own "last polled 9h ago" is honest; letting it claim the
 * session is working is the live truth we explicitly don't have.
 */
export function ActivitySection({ activity }: { activity: SessionActivity }) {
  const now = useNow();
  const mainTool = activity.main.currentTool;
  const hasAgents = activity.subagents.length > 0;
  const hasTasks = activity.tasks.length > 0;
  const hasShells = activity.shells.length > 0;
  const working =
    Boolean(mainTool) ||
    activity.subagents.some((agent) => agent.state === "running") ||
    activity.tasks.some((task) => task.status === "in_progress");

  return (
    <>
      <Section label="Activity">
        {mainTool ? (
          <div>
            <span style={toolNameStyle}>{toolLabel(mainTool)}</span>
            <span style={toolTimeStyle}>
              {elapsedLabel(mainTool.startedAt, now)}
            </span>
          </div>
        ) : (
          <span style={idleStyle}>{working ? "Working…" : "Idle"}</span>
        )}
      </Section>
      {hasAgents ? <AgentsPanel subagents={activity.subagents} /> : null}
      {hasTasks ? <TasksPanel tasks={activity.tasks} /> : null}
      {hasShells ? <BackgroundPanel shells={activity.shells} /> : null}
    </>
  );
}
