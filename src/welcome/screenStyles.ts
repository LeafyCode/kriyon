import type { CSSProperties } from "react";
import { overlayPanel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

/**
 * The look the full-window setup screens share — the welcome screen and the
 * install screen of the [Claude CLI check]: one panel on the window colour.
 */

// The panel centres itself with auto margins, not align-items: a flex-centred
// child taller than the window overflows upward, past where it can scroll.
export const pageStyle: CSSProperties = {
  background: tokens.color.chrome.window,
  display: "flex",
  height: "100%",
  overflowY: "auto",
  padding: tokens.space.xl,
};

export const panelStyle: CSSProperties = {
  ...overlayPanel(),
  gap: tokens.space.lg,
  margin: "auto",
  maxWidth: "560px",
  padding: tokens.space.xl,
  width: "100%",
};

export const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "18px",
  fontWeight: 700,
  margin: 0,
};

export const textStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
  lineHeight: 1.55,
  margin: 0,
};

export const actionsStyle: CSSProperties = {
  display: "flex",
  gap: tokens.space.sm,
  justifyContent: "flex-end",
};

export const errorStyle: CSSProperties = {
  ...textStyle,
  color: tokens.color.status.error,
};
