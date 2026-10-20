import type { CSSProperties } from "react";
import { button, card } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

const overlayStyle: CSSProperties = {
  alignItems: "center",
  animation: "kr-fade-up 0.2s ease both",
  backdropFilter: tokens.blur.overlay,
  backgroundColor: tokens.color.chrome.window,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.md,
  inset: 0,
  justifyContent: "center",
  position: "absolute",
  WebkitBackdropFilter: tokens.blur.overlay,
  zIndex: tokens.z.sticky,
};

const cardStyle: CSSProperties = {
  ...card(),
  alignItems: "center",
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
  maxWidth: "360px",
  padding: `${tokens.space.xl} ${tokens.space.lg}`,
  textAlign: "center",
};

const glyphStyle: CSSProperties = {
  color: tokens.color.status.error,
  fontSize: "20px",
  lineHeight: 1,
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontFamily: tokens.font.sans,
  fontSize: "14px",
  fontWeight: 700,
};

const bodyStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  lineHeight: 1.4,
};

const actionsStyle: CSSProperties = {
  display: "flex",
  gap: tokens.space.sm,
  marginTop: tokens.space.sm,
};

const primaryButtonStyle: CSSProperties = button("primary");

const secondaryButtonStyle: CSSProperties = button("secondary");

/**
 * Covers a session's content when a `claude --resume` failed because the
 * conversation expired (detected by `sessionHost`'s resume watchdog). Offers a
 * one-tap **Start fresh** in the same terminal, or **Dismiss** to leave the shell
 * as-is. The caller renders this only while the session's `resumeFailed` flag is
 * set; both actions clear it.
 */
export function SessionResumeFailedOverlay({
  onStartFresh,
  onDismiss,
}: {
  onStartFresh: () => void;
  onDismiss: () => void;
}) {
  return (
    <div data-testid="session-resume-failed-overlay" style={overlayStyle}>
      <div style={cardStyle}>
        <span style={glyphStyle}>⚠</span>
        <span style={titleStyle}>Couldn't resume this session</span>
        <span style={bodyStyle}>
          The Claude conversation has expired. Start a fresh session in this
          terminal?
        </span>
        <div style={actionsStyle}>
          <button
            className="kr-hover-accent"
            onClick={onStartFresh}
            style={primaryButtonStyle}
            type="button"
          >
            Start fresh
          </button>
          <button
            className="kr-hover-surface"
            onClick={onDismiss}
            style={secondaryButtonStyle}
            type="button"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
