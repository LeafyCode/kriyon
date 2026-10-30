import { CircleCheck, MessageCircleQuestion, X } from "lucide-react";
import { type CSSProperties, useMemo } from "react";
import { create } from "zustand";
import { basename } from "../state/actions.ts";
import { useChanges } from "../state/changes.ts";
import { changedFileCount } from "../state/changesView.ts";
import { useLayout } from "../state/layout.ts";
import { sessionTouchedRelative, useSessions } from "../state/sessions.ts";
import { recapHeadline, turnRecap } from "../state/turnRecap.ts";
import { useUi } from "../state/ui.ts";
import { button, iconButton } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

/** Files named on the card before the rest fold into "+N". */
const SHOWN_FILES = 4;

/** Which turn's recap each session's person closed (its prompt event id). */
const useRecapDismissals = create<{
  closed: Record<string, string>;
  close: (sessionId: string, key: string) => void;
}>((set) => ({
  close: (sessionId, key) =>
    set((state) => ({ closed: { ...state.closed, [sessionId]: key } })),
  closed: {},
}));

/**
 * The [Turn recap] card: when the active session's Claude stops, what that
 * turn did and what it needs, under the session header. Review changes opens
 * the Changes view; Follow up opens the Spawn dialog with the handoff prompt
 * filled in, the same one-click path a [Handoff card] takes. Closing it hides
 * this turn's recap only; the next turn brings its own.
 */
export function TurnRecapCard() {
  const sessionId = useSessions((state) => state.activeSessionId);
  const status = useSessions((state) =>
    sessionId ? state.sessions[sessionId]?.status : undefined
  );
  const events = useSessions((state) =>
    sessionId ? state.events[sessionId] : undefined
  );
  const activity = useSessions((state) =>
    sessionId ? state.activity[sessionId] : undefined
  );
  const closed = useRecapDismissals((state) =>
    sessionId ? state.closed[sessionId] : undefined
  );
  const view = useLayout((state) => state.layout.transcriptView);
  // The Changes tab's own count: it sees files Claude changed through the
  // shell too, which the turn's edit events miss.
  const touchedRelative = useSessions(() =>
    sessionTouchedRelative(sessionId ?? "")
  );
  const changedFiles = useChanges((state) =>
    changedFileCount(state, sessionId ?? "", touchedRelative)
  );
  const recap = useMemo(
    () => (status ? turnRecap(events, activity, status) : null),
    [events, activity, status]
  );
  if (!(sessionId && recap) || recap.key === closed || view === "changes") {
    return null;
  }
  const waiting = recap.needs !== null;
  const extra = recap.files.length - SHOWN_FILES;
  return (
    <section
      aria-label="What Claude's last turn did"
      data-testid="turn-recap"
      style={bandStyle}
    >
      {waiting ? (
        <MessageCircleQuestion
          aria-hidden
          size={15}
          style={{ ...glyphStyle, color: tokens.color.status.waiting }}
        />
      ) : (
        <CircleCheck
          aria-hidden
          size={15}
          style={{ ...glyphStyle, color: tokens.color.status.done }}
        />
      )}
      <div style={bodyStyle}>
        <span style={headlineStyle}>{recapHeadline(recap)}</span>
        {waiting ? (
          <span style={needsStyle}>Needs you: {recap.needs}</span>
        ) : null}
        {!waiting && recap.reply ? (
          <span style={replyStyle}>{recap.reply}</span>
        ) : null}
        {recap.files.length > 0 ? (
          <span style={filesStyle} title={recap.files.join("\n")}>
            {recap.files.slice(0, SHOWN_FILES).map(basename).join("  ")}
            {extra > 0 ? `  +${extra}` : ""}
          </span>
        ) : null}
      </div>
      <div style={actionsStyle}>
        {recap.files.length > 0 || changedFiles > 0 ? (
          <button
            className="kr-hover-surface"
            onClick={() => useLayout.getState().setTranscriptView("changes")}
            style={button("secondary", "sm")}
            type="button"
          >
            Review changes
          </button>
        ) : null}
        <button
          className="kr-hover-surface"
          onClick={() =>
            useUi.getState().openSpawn({ predecessorId: sessionId })
          }
          style={button("secondary", "sm")}
          title="Start a new session that picks up from this one"
          type="button"
        >
          Follow up
        </button>
        <button
          aria-label="Close the recap"
          className="kr-hover-surface"
          onClick={() =>
            useRecapDismissals.getState().close(sessionId, recap.key)
          }
          style={iconButton()}
          type="button"
        >
          <X size={13} />
        </button>
      </div>
    </section>
  );
}

const bandStyle: CSSProperties = {
  alignItems: "flex-start",
  background: tokens.color.chrome.content,
  borderBottom: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flex: "none",
  gap: tokens.space.md,
  padding: `10px ${tokens.space.xl}`,
};

const glyphStyle: CSSProperties = {
  flex: "none",
  marginTop: "1px",
};

const bodyStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: "3px",
  minWidth: 0,
};

const headlineStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "12.5px",
  fontWeight: 500,
};

const clipped: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const replyStyle: CSSProperties = {
  ...clipped,
  color: tokens.color.ink.secondary,
  fontSize: "12px",
};

const needsStyle: CSSProperties = {
  ...clipped,
  color: tokens.color.status.waitingInk,
  fontSize: "12px",
};

const filesStyle: CSSProperties = {
  ...clipped,
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  whiteSpace: "pre",
};

const actionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  gap: tokens.space.xs,
};
