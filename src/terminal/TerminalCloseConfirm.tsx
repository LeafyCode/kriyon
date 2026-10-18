import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";

export type CloseConfirmTarget = "pane" | "tab";

/** The wording for each Project-terminal surface that can close over a process. */
const COPY: Record<
  CloseConfirmTarget,
  { body: string; confirm: string; title: string }
> = {
  pane: {
    body: "This split has a process still running. Closing it will stop that process.",
    confirm: "Close & stop",
    title: "Stop the running process?",
  },
  tab: {
    body: "This terminal tab has a process still running. Closing it will stop that process.",
    confirm: "Close & stop",
    title: "Stop the running process?",
  },
};

/**
 * A modal confirmation shown when closing a Project terminal pane or tab with a
 * process still running, so a `pnpm dev` or a build isn't lost to an accidental
 * click. A {@link ConfirmDialog} adapter: `target` names what is being closed
 * and picks the copy; the panel, scrim, Escape and focus trap are shared. (The
 * whole-app quit has its own dialog — see `QuitConfirmHost`.)
 */
export function TerminalCloseConfirm({
  onCancel,
  onConfirm,
  target,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  target: CloseConfirmTarget;
}) {
  const copy = COPY[target];
  return (
    <ConfirmDialog
      body={copy.body}
      confirmLabel={copy.confirm}
      label="Cancel closing the terminal"
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={copy.title}
    />
  );
}
