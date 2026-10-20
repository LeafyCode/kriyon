/**
 * The "Delete activity…" confirm — a {@link ConfirmDialog} adapter for the
 * session row's ⋯ menu. Forgets everything Kriyon logged for the session (its
 * [Activity log]); the session itself and Claude Code's own transcript stay.
 */
import { activityDeleteSession } from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { showToast } from "../ui/Toast.tsx";

interface DeleteActivityConfirmProps {
  onClose: () => void;
  sessionId: string;
  sessionTitle: string;
}

export function DeleteActivityConfirm({
  onClose,
  sessionId,
  sessionTitle,
}: DeleteActivityConfirmProps) {
  return (
    <ConfirmDialog
      body="Kriyon forgets what it logged for this session. The session and Claude Code's own transcript stay."
      confirmLabel="Delete activity"
      confirmTestId="confirm-delete-activity"
      label={`Keep the activity of ${sessionTitle}`}
      onCancel={onClose}
      onConfirm={() => {
        onClose();
        activityDeleteSession(sessionId)
          .then(() => showToast(`Deleted the activity of ${sessionTitle}`))
          .catch((err: unknown) =>
            showToast(
              `Couldn't delete the activity: ${failureMessage(err)}`,
              "error"
            )
          );
      }}
      title={`Delete the activity of "${sessionTitle}"?`}
    />
  );
}
