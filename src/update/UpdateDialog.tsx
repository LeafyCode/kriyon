import type { CSSProperties } from "react";
import { useSessions } from "../state/sessions.ts";
import { stopCostOfAll } from "../state/stopCost.ts";
import {
  offerCopy,
  progressPercent,
  restartNote,
  useUpdates,
} from "../state/updates.ts";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { DialogPanel, dialogBodyStyle } from "../ui/ConfirmDialog.tsx";

const notesStyle: CSSProperties = {
  background: tokens.color.blockWell,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  lineHeight: 1.5,
  margin: `0 0 ${tokens.space.md}`,
  maxHeight: "220px",
  overflowY: "auto",
  padding: `${tokens.space.sm} ${tokens.space.md}`,
  whiteSpace: "pre-wrap",
};

const noteStyle: CSSProperties = {
  ...dialogBodyStyle,
  color: tokens.color.status.waiting,
};

const errorStyle: CSSProperties = {
  ...dialogBodyStyle,
  color: tokens.color.status.error,
};

const trackStyle: CSSProperties = {
  background: tokens.color.line.base,
  borderRadius: tokens.radius.md,
  height: tokens.space.xs,
  margin: `0 0 ${tokens.space.md}`,
  overflow: "hidden",
};

/** How much is downloaded: a filled bar, or a full faint one while the size is unknown. */
function ProgressBar({ percent }: { percent: number | null }) {
  const fill: CSSProperties = {
    background: tokens.color.accent,
    height: "100%",
    opacity: percent === null ? 0.4 : 1,
    width: `${percent ?? 100}%`,
  };
  return (
    <div
      aria-label="Download progress"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent ?? undefined}
      role="progressbar"
      style={trackStyle}
    >
      <div style={fill} />
    </div>
  );
}

/**
 * The update dialog: what is on offer, its release notes, and "Skip this
 * version" / "Install & restart". It also serves as the switch prompt for a
 * [Channel step-down]. The restart is a [Handover], so it warns, rather than
 * asks, about sessions mid-turn.
 */
export function UpdateDialog() {
  const open = useUpdates((state) => state.dialogOpen);
  const snapshot = useUpdates((state) => state.snapshot);
  const installing = useUpdates((state) => state.installing);
  const progress = useUpdates((state) => state.progress);
  const error = useUpdates((state) => state.error);
  const working = useSessions((state) => stopCostOfAll(state).working);
  const available = snapshot?.available;
  if (!(open && snapshot && available)) {
    return null;
  }
  const { closeDialog, install, skip } = useUpdates.getState();
  const copy = offerCopy(available, snapshot.prefs.channel, snapshot.running);
  const note = copy.confirm ? restartNote(working) : null;
  return (
    <DialogPanel
      actions={
        <>
          {copy.confirm ? (
            <button
              className="kr-hover-surface"
              disabled={installing}
              onClick={() => {
                skip().catch(() => undefined);
              }}
              style={button("secondary")}
              type="button"
            >
              Skip this version
            </button>
          ) : null}
          <button
            className="kr-hover-surface"
            disabled={installing}
            onClick={closeDialog}
            style={button("secondary")}
            type="button"
          >
            {copy.confirm ? "Later" : "OK"}
          </button>
          {copy.confirm ? (
            <button
              className="kr-hover-accent"
              data-testid="update-install"
              disabled={installing}
              onClick={() => {
                install().catch(() => undefined);
              }}
              style={button("primary")}
              type="button"
            >
              {installing ? "Installing…" : copy.confirm}
            </button>
          ) : null}
        </>
      }
      label="Close update"
      onClose={installing ? () => undefined : closeDialog}
      testId="update-dialog"
      title={copy.title}
      wide
    >
      <p style={dialogBodyStyle}>{copy.body}</p>
      {available.notes ? (
        <div data-testid="update-notes" style={notesStyle}>
          {available.notes}
        </div>
      ) : null}
      {note ? <p style={noteStyle}>{note}</p> : null}
      {installing ? <ProgressBar percent={progressPercent(progress)} /> : null}
      {error ? <p style={errorStyle}>{error}</p> : null}
    </DialogPanel>
  );
}
