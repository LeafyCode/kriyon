/**
 * The "park this project?" confirm, shown only when parking would stop work in
 * flight: a session mid-turn or starting up, a background command, or a busy
 * terminal. A {@link ConfirmDialog} adapter, like {@link ClearProjectConfirm}.
 */
import { type ParkCost, parkProjectAndStop } from "../state/actions.ts";
import { plural } from "../state/stopCost.ts";
import type { ProjectRow } from "../types.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";

/** "2 sessions are working and 1 terminal is running a command" — what the
 *  park would interrupt, in one plain line. */
export function parkInterrupts(cost: ParkCost): string {
  const parts: string[] = [];
  const busySessions = cost.working + cost.starting;
  if (busySessions > 0) {
    parts.push(
      `${plural(busySessions, "session")} ${busySessions === 1 ? "is" : "are"} working`
    );
  }
  if (cost.commands.length > 0) {
    parts.push(
      `${plural(cost.commands.length, "background command")} ${cost.commands.length === 1 ? "is" : "are"} running`
    );
  }
  if (cost.busyTerminals > 0) {
    parts.push(
      `${plural(cost.busyTerminals, "terminal")} ${cost.busyTerminals === 1 ? "is" : "are"} running a command`
    );
  }
  return parts.join(" and ");
}

interface ParkProjectConfirmProps {
  /** What the park would stop, worked out at the ask. Null: no confirm up. */
  cost: ParkCost | null;
  onCancel: () => void;
  project: ProjectRow;
}

export function ParkProjectConfirm({
  cost,
  onCancel,
  project,
}: ParkProjectConfirmProps) {
  if (cost === null) {
    return null;
  }
  return (
    <ConfirmDialog
      backdropTestId="park-project-backdrop"
      body={`${parkInterrupts(cost)}. Parking stops them. Conversations, worktrees and terminal tabs are kept — unpark ${project.name} to pick up where you left off.`}
      confirmLabel="Park and stop"
      confirmTestId={`confirm-park-project-${project.id}`}
      details={cost.commands}
      label={`Keep ${project.name} running`}
      onCancel={onCancel}
      onConfirm={() => {
        onCancel();
        parkProjectAndStop(project.id);
      }}
      title={`Park ${project.name}?`}
    />
  );
}
