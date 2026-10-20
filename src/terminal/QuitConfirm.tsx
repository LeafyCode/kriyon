import { useTerminals } from "../state/terminals.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { confirmQuit, quitCopy } from "./closeOnQuit.ts";

function ignore(promise: Promise<unknown>): void {
  promise.catch(() => {
    // confirmQuit is best-effort; a failed exit leaves the app open.
  });
}

/**
 * App-level host for the quit confirmation. Rendered (empty) at the App root;
 * shows the dialog when a window close was intercepted because quitting would
 * destroy something — a turn in flight, a background command, a Project
 * terminal's process (see `handleCloseRequested`). The dialog names what is at
 * stake; the only choice it offers is whether to go through with the quit.
 * Cancelling simply returns to the app.
 */
export function QuitConfirmHost() {
  const stakes = useTerminals((s) => s.quitConfirm);
  if (!stakes) {
    return null;
  }
  const copy = quitCopy(stakes);
  return (
    <ConfirmDialog
      backdropTestId="quit-confirm-backdrop"
      body={copy.body}
      confirmLabel="Stop and quit"
      confirmTestId="quit-stop-all"
      details={copy.details}
      label="Cancel quitting"
      onCancel={() => useTerminals.getState().setQuitConfirm(null)}
      onConfirm={() => ignore(confirmQuit("stopAll"))}
      title={copy.title}
    />
  );
}
