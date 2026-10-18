/**
 * The project color-picker popover — an Anchored-menu adapter on the project
 * header, beside the SortMenu. Owns the swatch grid and the "Automatic"
 * reset; the caller owns open state and the anchor.
 */
import type { CSSProperties } from "react";
import { useSessions } from "../state/sessions.ts";
import {
  PROJECT_PALETTE,
  PROJECT_PALETTE_NAMES,
} from "../theme/projectColor.ts";
import { tokens } from "../theme/tokens.ts";
import type { ProjectRow } from "../types.ts";
import { anchoredMenuSurfaceStyle } from "../ui/AnchoredMenu.tsx";

const surfaceStyle: CSSProperties = {
  ...anchoredMenuSurfaceStyle,
  gap: "8px",
  padding: "9px",
};

const swatchRowStyle: CSSProperties = {
  display: "flex",
  gap: "6px",
};

function swatchStyle(color: string, selected: boolean): CSSProperties {
  return {
    background: color,
    border: selected
      ? `2px solid ${tokens.color.ink.bright}`
      : `1px solid ${tokens.color.line.strong}`,
    borderRadius: tokens.radius.md,
    cursor: "pointer",
    flex: "none",
    height: "18px",
    padding: 0,
    width: "18px",
  };
}

const autoColorStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  fontFamily: tokens.font.sans,
  fontSize: "11.5px",
  padding: "4px 6px",
  textAlign: "left",
};

interface PaletteMenuProps {
  /** Dismiss the popover — called after a choice commits. */
  onClose: () => void;
  project: ProjectRow;
}

export function PaletteMenu({ onClose, project }: PaletteMenuProps) {
  return (
    <div role="menu" style={surfaceStyle}>
      <div role="none" style={swatchRowStyle}>
        {PROJECT_PALETTE.map((color) => (
          <button
            aria-checked={project.color === color}
            aria-label={`Set color ${PROJECT_PALETTE_NAMES[color]}`}
            data-testid={`swatch-${color}`}
            key={color}
            onClick={() => {
              useSessions.getState().setProjectColor(project.id, color);
              onClose();
            }}
            role="menuitemradio"
            style={swatchStyle(color, project.color === color)}
            type="button"
          />
        ))}
      </div>
      <button
        aria-label="Automatic color"
        className="kr-hover-surface"
        onClick={() => {
          useSessions.getState().setProjectColor(project.id, null);
          onClose();
        }}
        role="menuitem"
        style={autoColorStyle}
        type="button"
      >
        Automatic
      </button>
    </div>
  );
}
