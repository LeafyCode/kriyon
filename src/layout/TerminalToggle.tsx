import { SquareTerminal } from "lucide-react";
import type { CSSProperties } from "react";
import { useLayout } from "../state/layout.ts";
import { useTerminals } from "../state/terminals.ts";
import { iconButton } from "../theme/recipes.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";

const toggleBase: CSSProperties = {
  ...iconButton(),
  gap: "5px",
  padding: "0 7px",
  width: "auto",
};

function countStyle(busy: boolean): CSSProperties {
  return {
    // Running takes the canonical green (matches the running status dot);
    // idle-but-open stays accent, so the two states read differently at a
    // glance.
    background: busy ? tokens.color.status.runningSoft : accentAlpha(0.16),
    borderRadius: tokens.radius.pill,
    color: busy ? tokens.color.status.runningInk : tokens.color.accentBright,
    fontFamily: tokens.font.mono,
    fontSize: "10px",
    lineHeight: "15px",
    minWidth: "15px",
    padding: "0 4px",
    textAlign: "center",
  };
}

/**
 * Toggles the {@link TerminalDock} and doubles as the live indicator: the mark
 * and count chip take a pulse while any Project terminal has a foreground
 * process running.
 *
 * Lives at the right end of the session header's tab row — where the canvas
 * puts its `Structured | Raw` control — since the title bar that used to host
 * it is gone (ADR-0023).
 */
export function TerminalToggle() {
  const dockOpen = useLayout((state) => state.layout.terminalDockOpen);
  const toggleDock = useLayout((state) => state.toggleTerminalDock);
  const paneCount = useTerminals((state) => state.livePaneCount());
  const busy = useTerminals((state) => state.hasBusyPanes());

  return (
    <button
      aria-label="Toggle terminals"
      className="kr-hover-surface"
      onClick={toggleDock}
      style={
        dockOpen
          ? {
              ...toggleBase,
              background: tokens.color.surface.s3,
              color: tokens.color.ink.bright,
            }
          : toggleBase
      }
      title={busy ? "Terminals — process running" : "Terminals"}
      type="button"
    >
      <span
        className={busy ? "kr-term-pulse" : undefined}
        style={{
          alignItems: "center",
          color: busy ? tokens.color.status.runningInk : "inherit",
          display: "flex",
          transition: `color ${tokens.motion.hover}`,
        }}
      >
        <SquareTerminal size={14} strokeWidth={1.75} />
      </span>
      {paneCount > 0 ? (
        <span
          className={busy ? "kr-term-pulse" : undefined}
          style={countStyle(busy)}
        >
          {paneCount}
        </span>
      ) : null}
    </button>
  );
}
