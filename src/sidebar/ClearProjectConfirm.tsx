/**
 * The "close every session in this project" confirm, and the clear it commits.
 * A {@link ConfirmDialog} adapter rather than a step inside the header's ⋯
 * popover: a block of confirm copy hanging off that trigger landed in the
 * middle of a 278px rail, covering the projects below it.
 */
import { useSessions } from "../state/sessions.ts";
import type { ProjectRow } from "../types.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { showToast } from "../ui/Toast.tsx";

/** "1 session" / "3 sessions" — the confirm and its toast agree on wording. */
function sessionLabel(count: number): string {
  return `${count} session${count === 1 ? "" : "s"}`;
}

/**
 * Ids of every session in a project, archived ones included — what a clear
 * closes, and what its confirm counts. Archived sessions go too: they are
 * exactly what would otherwise leave an empty group on the rail. Read live
 * rather than subscribed, so a session that arrives between the ask and the
 * confirm is still cleared.
 */
export function projectSessionIds(projectId: string): string[] {
  return Object.values(useSessions.getState().sessions)
    .filter((session) => session.projectId === projectId)
    .map((session) => session.id);
}

interface ClearProjectConfirmProps {
  /** Dismiss without closing anything. */
  onCancel: () => void;
  /** The per-session close the row's own control uses — pty torn down,
   *  persisted row dropped, store entry removed. */
  onCloseSession: (id: string) => void;
  project: ProjectRow;
  /** The exact sessions the clear was asked about, snapshotted at the ask.
   *  Null means no confirm is up. Ids rather than a count because the count
   *  is a promise: the dialog names a number, and the commit must close that
   *  set — not whatever the project holds by the time the button is pressed.
   *  A session can still arrive underneath an open modal (⌘K registers a bare
   *  window listener and can spawn one), and it never appeared in any
   *  confirm, so it survives. */
  sessionIds: string[] | null;
}

export function ClearProjectConfirm({
  onCancel,
  onCloseSession,
  project,
  sessionIds,
}: ClearProjectConfirmProps) {
  if (sessionIds === null) {
    return null;
  }
  const commit = () => {
    onCancel();
    // Intersected with what is still open: a session closed elsewhere while
    // the dialog was up must not be closed a second time. The toast counts
    // what actually went, so it stays true either way.
    const live = new Set(projectSessionIds(project.id));
    const closing = sessionIds.filter((id) => live.has(id));
    for (const id of closing) {
      onCloseSession(id);
    }
    showToast(`Closed ${sessionLabel(closing.length)} in ${project.name}`);
  };
  return (
    <ConfirmDialog
      backdropTestId="clear-project-backdrop"
      body={`Their terminals stop and ${project.name} leaves the sidebar. Worktree folders and their branches are kept, and Claude's own transcripts stay on disk — they list under History again when you next open this project.`}
      confirmLabel={`Close ${sessionLabel(sessionIds.length)}`}
      confirmTestId={`confirm-clear-project-${project.id}`}
      label={`Keep the sessions in ${project.name}`}
      onCancel={onCancel}
      onConfirm={commit}
      title={`Close ${sessionLabel(sessionIds.length)} in ${project.name}?`}
    />
  );
}
