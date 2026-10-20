import "./companionStarting.css";
import type { CSSProperties } from "react";
import { useLayout } from "../state/layout.ts";
import { button, shimmerText } from "../theme/recipes.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";
import { Mascot, mascotTileStyle, TILE_MASCOT_PX } from "./Mascot.tsx";

const stageStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: tokens.space.lg,
  justifyContent: "center",
  padding: tokens.space.xl,
  textAlign: "center",
};

const sceneStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  marginBottom: tokens.space.sm,
};

/** Unclipped, unlike the banner's: this mascot plays no tricks, and the
 *  ripples spread past the tile's edge. */
const nodeStyle: CSSProperties = {
  ...mascotTileStyle,
  position: "relative",
};

const rippleStyle: CSSProperties = {
  border: `1px solid ${accentAlpha(0.6)}`,
  borderRadius: tokens.radius.xl,
  inset: -1,
  opacity: 0,
  pointerEvents: "none",
  position: "absolute",
};

const linkStyle: CSSProperties = {
  borderTop: `1px dashed ${tokens.color.line.strong}`,
  height: 0,
  position: "relative",
  width: "112px",
};

const packetStyle: CSSProperties = {
  background: tokens.color.accentBright,
  borderRadius: tokens.radius.pill,
  boxShadow: tokens.shadow.glow,
  height: "6px",
  position: "absolute",
  top: 0,
  width: "6px",
};

/** The stand-in for Kriyon when the user turned the mascot off. */
const orbStyle: CSSProperties = {
  background: accentAlpha(0.35),
  border: `1px solid ${accentAlpha(0.7)}`,
  borderRadius: tokens.radius.pill,
  height: "22px",
  width: "22px",
};

const titleStyle: CSSProperties = {
  ...shimmerText(),
  fontSize: "14px",
  fontWeight: 500,
  margin: 0,
};

const hintStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
  lineHeight: 1.6,
  margin: 0,
  maxWidth: "360px",
};

/**
 * What the [Structured view] shows while the session's [Companion state] is
 * `starting`: Claude Code's ✻ sending light across to Kriyon's [Mascot], and
 * the one thing that can hold it up — a folder Claude Code wants trusted,
 * answered in the terminal.
 */
export function CompanionStarting() {
  const mascot = useLayout((state) => state.layout.mascot);
  const setTranscriptView = useLayout((state) => state.setTranscriptView);
  return (
    <div className="kr-starting" style={stageStyle}>
      <div aria-hidden style={sceneStyle}>
        <span style={nodeStyle}>
          <span className="kr-starting-ripple" style={rippleStyle} />
          <span className="kr-starting-ripple" style={rippleStyle} />
          {mascot === "none" ? (
            <span style={orbStyle} />
          ) : (
            <Mascot busy kind={mascot} size={TILE_MASCOT_PX} />
          )}
        </span>
        <span style={linkStyle}>
          <span className="kr-starting-packet" style={packetStyle} />
          <span className="kr-starting-packet" style={packetStyle} />
          <span className="kr-starting-packet" style={packetStyle} />
        </span>
        <span style={nodeStyle}>
          <span
            className="kr-starting-star"
            style={{
              color: tokens.color.accentBright,
              fontSize: "26px",
              lineHeight: 1,
            }}
          >
            ✻
          </span>
        </span>
      </div>
      <p role="status" style={titleStyle}>
        Starting Kriyon Companion…
      </p>
      <p style={hintStyle}>
        Waiting for Claude Code to start. If it asks whether to trust this
        folder, answer it in the terminal.
      </p>
      <button
        className="kr-focusable kr-hover-surface"
        onClick={() => setTranscriptView("raw", false)}
        style={button("secondary")}
        type="button"
      >
        Open the terminal
      </button>
    </div>
  );
}
