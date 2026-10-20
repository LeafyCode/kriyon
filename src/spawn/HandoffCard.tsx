import type { CSSProperties, ReactNode } from "react";
import { copyPath } from "../changes/copyPath.ts";
import {
  handoffSeed,
  type ReadyHandoff,
  useHandoffs,
} from "../state/handoffs.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { button, card } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

const stackStyle: CSSProperties = {
  bottom: tokens.space.xl,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
  position: "fixed",
  right: tokens.space.lg,
  width: "min(340px, 90vw)",
  zIndex: tokens.z.popover,
};

const cardStyle: CSSProperties = {
  ...card(),
  animation: "kr-pop-in 0.16s ease both",
  boxShadow: tokens.shadow.pop,
  display: "flex",
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  gap: tokens.space.sm,
  padding: tokens.space.md,
};

const headingStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "12.5px",
  fontWeight: 500,
};

const bodyStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
  lineHeight: 1.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const actionsStyle: CSSProperties = {
  display: "flex",
  gap: tokens.space.xs,
  justifyContent: "flex-end",
};

/** One [Handoff card]: Open (the Spawn dialog), Copy path, or Dismiss. */
function HandoffCard({
  handoff,
  sessionId,
  title,
}: {
  handoff: ReadyHandoff;
  sessionId: string;
  title: string;
}): ReactNode {
  const { path } = handoff;
  const dismiss = () => useHandoffs.getState().dismiss(sessionId);
  return (
    <div
      data-testid={`handoff-card-${sessionId}`}
      role="status"
      style={cardStyle}
    >
      <span style={headingStyle}>Handoff ready · {title}</span>
      <span style={bodyStyle} title={path}>
        Open in a new session?
      </span>
      <div style={actionsStyle}>
        <button
          className="kr-hover-surface"
          onClick={dismiss}
          style={button("ghost", "sm")}
          type="button"
        >
          Dismiss
        </button>
        <button
          className="kr-hover-surface"
          onClick={() => copyPath(path)}
          style={button("secondary", "sm")}
          type="button"
        >
          Copy path
        </button>
        <button
          className="kr-hover-accent"
          onClick={() => {
            dismiss();
            useUi
              .getState()
              .openSpawn(
                { predecessorId: sessionId },
                { seed: handoffSeed(handoff) }
              );
          }}
          style={button("primary", "sm")}
          type="button"
        >
          Open
        </button>
      </div>
    </div>
  );
}

/**
 * The non-blocking stack of [Handoff card]s, bottom-right, one per session
 * whose turn produced a [Handoff file]. Nothing is sent from here: Open only
 * opens the Spawn dialog, whose confirm is the user's go-ahead.
 */
export function HandoffCards(): ReactNode {
  const ready = useHandoffs((s) => s.ready);
  const sessions = useSessions((s) => s.sessions);
  const cards = Object.entries(ready).flatMap(([sessionId, handoff]) => {
    const session = sessions[sessionId];
    return session ? [{ handoff, sessionId, title: session.title }] : [];
  });
  if (cards.length === 0) {
    return null;
  }
  return (
    <div style={stackStyle}>
      {cards.map((c) => (
        <HandoffCard key={c.sessionId} {...c} />
      ))}
    </div>
  );
}
