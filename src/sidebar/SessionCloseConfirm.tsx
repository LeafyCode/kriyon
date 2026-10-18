/**
 * The session close confirm — a {@link ConfirmDialog} adapter for the sidebar
 * row's own close button (`SessionRow`). The wording comes from
 * {@link closeConfirmFor}, which says only what actually applies: what closing
 * would stop (a turn in flight, running background commands) and what it would
 * discard (an unsent message, unsaved edits).
 */
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";

interface SessionCloseConfirmProps {
  body: string;
  confirmLabel: string;
  details: string[];
  onCancel: () => void;
  onConfirm: () => void;
  sessionTitle: string;
}

export function SessionCloseConfirm({
  body,
  confirmLabel,
  details,
  onCancel,
  onConfirm,
  sessionTitle,
}: SessionCloseConfirmProps) {
  return (
    <ConfirmDialog
      backdropTestId="session-close-backdrop"
      body={body}
      confirmLabel={confirmLabel}
      confirmTestId="confirm-close-session"
      details={details}
      label={`Keep ${sessionTitle} open`}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={`Close "${sessionTitle}"?`}
    />
  );
}
