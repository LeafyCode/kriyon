import {
  describeCommands,
  hasStopCost,
  listedCommands,
  type StopCost,
} from "../state/stopCost.ts";

/**
 * What "unsent work" a session holds when its close button is pressed: an
 * unsent composer draft, unsaved file edits in the Changes editor, or both.
 * `null` means the session is clean — it closes exactly as it always has,
 * no confirm.
 */
export type UnsentWork = "both" | "draft" | "files" | null;

/**
 * Decide {@link UnsentWork} from the two live signals a close should check:
 * the composer's draft text (`useDrafts`) and the Changes editor's dirty
 * state (`useChanges` — a currently-open dirty file, or a draft stashed
 * after its pane unmounted). Pure so the three-way branch is unit-testable
 * without mounting either store's consumers.
 */
export function unsentWorkFor(input: {
  dirtyFile: string | null | undefined;
  draft: string | undefined;
  fileDrafts: Record<string, unknown> | undefined;
}): UnsentWork {
  const hasDraft = Boolean(input.draft?.trim());
  const hasFiles =
    Boolean(input.dirtyFile) || Object.keys(input.fileDrafts ?? {}).length > 0;
  if (hasDraft && hasFiles) {
    return "both";
  }
  if (hasDraft) {
    return "draft";
  }
  if (hasFiles) {
    return "files";
  }
  return null;
}

const UNSENT_BODY: Record<Exclude<UnsentWork, null>, string> = {
  both: "It has an unsent message and unsaved file edits. Closing it now discards both.",
  draft: "It has an unsent message. Closing it now discards the draft.",
  files:
    "It has unsaved file edits in the Changes view. Closing it now discards them.",
};

/**
 * The close confirm for a session, or `null` when closing it loses nothing and
 * it should just close.
 *
 * Two different losses share the one dialog. Closing ends the session's whole
 * process tree, so the [Stop cost] — a turn in flight, background commands
 * still running — is named first, and the button says it *stops* something.
 * {@link UnsentWork} goes with the row itself. Each sentence appears only when
 * it applies, so nobody is warned about a thing they never did.
 */
export function closeConfirmFor(
  unsentWork: UnsentWork,
  stopCost: StopCost
): { body: string; confirmLabel: string; details: string[] } | null {
  const stops = hasStopCost(stopCost);
  if (!(stops || unsentWork)) {
    return null;
  }
  const lines: string[] = [];
  // One value, so the two sentences are mutually exclusive by construction —
  // a session used to be able to print both.
  if (stopCost.engagement === "running") {
    lines.push("Claude is still working. Closing stops it mid-task.");
  } else if (stopCost.engagement === "starting") {
    lines.push("Claude is still starting up. Closing stops it.");
  }
  if (unsentWork) {
    lines.push(UNSENT_BODY[unsentWork]);
  }
  // Last, so the list it introduces sits directly beneath it.
  if (stopCost.commands.length > 0) {
    lines.push(`Closing stops ${describeCommands(stopCost.commands)}:`);
  }
  return {
    body: lines.join(" "),
    confirmLabel: stops ? "Stop and close" : "Close session",
    details: listedCommands(stopCost.commands),
  };
}
