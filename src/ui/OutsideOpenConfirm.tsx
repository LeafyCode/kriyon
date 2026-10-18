import { useOutsideOpen } from "../state/outsideOpen.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** "Open a file outside this project?" — shown when a clicked link names a
 *  file Kriyon won't open on its own. */
export function OutsideOpenConfirm() {
  const request = useOutsideOpen((state) => state.request);
  const dismiss = useOutsideOpen((state) => state.dismiss);
  if (request === null) {
    return null;
  }
  return (
    <ConfirmDialog
      body={`This file isn't in any of your projects, so Kriyon doesn't open it by itself. ${
        request.reveal ? "Show it in Finder" : "Open it"
      } only if you trust it.`}
      confirmLabel={request.reveal ? "Show in Finder" : "Open anyway"}
      details={[request.path]}
      label="Cancel opening the file"
      onCancel={dismiss}
      onConfirm={() => {
        dismiss();
        request.confirm();
      }}
      title="Open a file outside your projects?"
    />
  );
}
