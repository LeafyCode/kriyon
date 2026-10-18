import type { CSSProperties } from "react";
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

// Travelling light-band over the label — the same "thinking" shimmer used in the
// session panes, so the loading state reads as part of the same family.
const labelStyle: CSSProperties = {
  WebkitBackgroundClip: "text",
  animation: "kr-shimmer 2.2s linear infinite",
  backgroundClip: "text",
  backgroundImage: `linear-gradient(90deg, ${tokens.color.ink.dim} 0%, ${tokens.color.ink.bright} 50%, ${tokens.color.ink.dim} 100%)`,
  backgroundPosition: "200% center",
  backgroundSize: "200% auto",
  color: "transparent",
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
