import type { CSSProperties } from "react";
import { shimmerText } from "../theme/recipes.ts";
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

const glyphStyle: CSSProperties = {
  animation: "kr-pulse 1.4s ease-in-out infinite",
  color: tokens.color.accentBright,
  fontSize: "10px",
  lineHeight: 1,
};

const labelStyle: CSSProperties = {
  ...shimmerText(),
  fontFamily: tokens.font.sans,
  fontSize: "14px",
};

/**
 * Covers a session's content while the (resumed or freshly started) Claude
 * boots, until the backend's `session-ready` signal (or the App's timeout
 * fallback) clears `booting`. The caller renders this only while `booting`.
 */
export function SessionLoadingOverlay({ resuming }: { resuming: boolean }) {
  return (
    <div data-testid="session-loading-overlay" style={overlayStyle}>
      <span style={glyphStyle}>●</span>
      <span style={labelStyle}>
        {resuming ? "Resuming session…" : "Starting Claude…"}
      </span>
    </div>
  );
}
