import { darkChrome } from "./base.ts";
import type { Theme } from "./types.ts";

/**
 * The BisBig direction's own accent, and the default (ADR-0023): a steel blue
 * at hue 225 that sits in the same family as the cool chrome rather than
 * against it.
 *
 * The canvas specifies these in `oklch(L 0.11 225)`. They are stored as hex
 * because two seams need a concrete, parseable 6-digit value: `applyTheme`
 * derives `--kr-accent-rgb` from it for `accentAlpha`, and `terminalTheme`
 * composes the xterm selection fill on a canvas that can't read a custom
 * property at all.
 */
export const steel: Theme = {
  id: "steel",
  label: "Steel",
  colors: {
    ...darkChrome,
    // oklch(0.55 0.11 225) — fills: Send, the brand tile, primary buttons.
    accent: "#007ea2",
    // oklch(0.72 0.11 225) — tab underline, active-row bar, progress fill.
    accentBright: "#49b3d8",
    // oklch(0.60 0.11 225).
    accentHover: "#138db1",
    // oklch(0.85 0.08 225) — ink on an accent tint (the breadcrumb tile).
    accentInk: "#93d9f5",
    onAccent: "#ffffff",
  },
};
