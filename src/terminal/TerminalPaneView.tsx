import type { CSSProperties } from "react";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { Terminal } from "./Terminal.tsx";

const wrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
  minWidth: 0,
};

function headerStyle(active: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: active ? tokens.color.surface.s1 : "transparent",
    borderBottom: `1px solid ${tokens.color.line.base}`,
    display: "flex",
    flex: "0 0 auto",
    gap: "6px",
    height: "24px",
    padding: "0 4px 0 8px",
    transition: `background ${tokens.motion.hover}`,
  };
}

function labelStyle(active: boolean): CSSProperties {
  return {
    // Both stops are `ink.muted` or brighter: this is a path the user reads,
    // and ADR-0023's ramp affords exactly one text stop below `inkSecondary`.
    color: active ? tokens.color.ink.secondary : tokens.color.ink.muted,
    flex: 1,
    fontFamily: tokens.font.mono,
    fontSize: "11px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    transition: `color ${tokens.motion.hover}`,
    whiteSpace: "nowrap",
  };
}

const ctlStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  height: "18px",
  justifyContent: "center",
  padding: 0,
  width: "18px",
};

function SplitIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="12"
      stroke="currentColor"
      strokeWidth="1.4"
      viewBox="0 0 16 16"
      width="12"
    >
      <title>Split</title>
      <rect height="11" rx="1.5" width="13" x="1.5" y="2.5" />
      <line x1="8" x2="8" y1="2.5" y2="13.5" />
    </svg>
  );
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

const deadOverlayStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.scrim,
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  inset: 0,
  justifyContent: "center",
  position: "absolute",
  zIndex: 1,
};

const deadLabelStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.sans,
  fontSize: "13px",
};

const restartButtonStyle: CSSProperties = button("secondary");

/**
 * One Project-terminal pane: a compact header (cwd, split, close) over the
 * shared {@link Terminal}. `active` is forwarded straight to `Terminal` — it is
 * the WebGL gate, so only the visible active pane holds a WebGL context — and it
 * brightens the pane's frame so the focused split reads at a glance. Because
 * `Terminal` never calls `launchClaudeOnce`, this pane is a plain shell.
 * Focusing the terminal (a click into it) bubbles a focus event that marks this
 * the active pane. Controls stay quiet until the header is hovered.
 */
export function TerminalPaneView({
  active,
  cwd,
  dead = false,
  onClose,
  onFocus,
  onRestart,
  onSplit,
  paneId,
  showControls,
}: {
  active: boolean;
  cwd: string;
  /** The pane's shell exited underneath the app — show the restart overlay. */
  dead?: boolean;
  onClose: () => void;
  onFocus: () => void;
  /** Restart the dead pane's shell (same pane id, fresh pty). */
  onRestart?: () => void;
  onSplit: () => void;
  paneId: string;
  showControls: boolean;
}) {
  return (
    <div
      className="kr-reveal-parent"
      onFocusCapture={onFocus}
      style={{
        ...wrapStyle,
        outline: `1px solid ${
          active ? tokens.color.line.strong : "transparent"
        }`,
        outlineOffset: "-1px",
      }}
    >
      <div style={headerStyle(active)}>
        <span style={labelStyle(active)} title={cwd}>
          {basename(cwd)}
        </span>
        {showControls ? (
          <>
            <button
              aria-label="Split pane"
              className="kr-hover-surface kr-reveal"
              onClick={onSplit}
              style={ctlStyle}
              title="Split pane"
              type="button"
            >
              <SplitIcon />
            </button>
            <button
              aria-label="Close pane"
              className="kr-hover-surface kr-reveal"
              onClick={onClose}
              style={{ ...ctlStyle, fontSize: "14px" }}
              title="Close pane"
              type="button"
            >
              ×
            </button>
          </>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {dead ? (
          <div style={deadOverlayStyle}>
            <span style={deadLabelStyle}>Shell exited</span>
            <button
              aria-label="Restart shell"
              className="kr-hover-surface"
              onClick={onRestart}
              style={restartButtonStyle}
              type="button"
            >
              Restart shell
            </button>
          </div>
        ) : null}
        <Terminal
          active={active}
          cwd={cwd}
          onSplitChord={onSplit}
          scopedFocus
          sessionId={paneId}
        />
      </div>
    </div>
  );
}
