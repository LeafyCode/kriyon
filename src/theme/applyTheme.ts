import { hexTriplet } from "./hex.ts";
import type { Theme, ThemeColors } from "./themes/index.ts";

/** The custom-property name a theme color key publishes as (e.g. `inkBright` → `--kr-ink-bright`). */
export function cssVarName(key: keyof ThemeColors): string {
  return `--kr-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Motion durations + easing, published through the same `--kr-*` seam as colors
 * (ADR-0007). One duration/easing pair per gesture family so every
 * collapsing/expanding surface moves alike. Unlike colors these are
 * theme-INDEPENDENT constants — the same map is re-published on every
 * `applyTheme`, which is harmless on a theme switch.
 */
export const MOTION = {
  /** Panel and drawer slides (sidebars, composer, layout slides). */
  panel: "0.26s cubic-bezier(0.32, 0.72, 0, 1)",
  /** Small inline disclosures (tree groups, history, chevrons). */
  disclose: "0.18s ease",
  /** Hover / press state transitions. */
  hover: "0.14s ease",
} as const;

/**
 * Publish a theme's palette as `--kr-*` custom properties on the root
 * element. All tokens resolve through these variables, so this single call
 * restyles the entire app.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement.style;
  for (const [key, value] of Object.entries(theme.colors)) {
    root.setProperty(cssVarName(key as keyof ThemeColors), value);
  }
  // The triplet form lets accentAlpha() tint at any alpha without hex math.
  root.setProperty("--kr-accent-rgb", hexTriplet(theme.colors.accent));
  // The colour ink is made of — white on a dark theme, black on a light one.
  // CSS that needs a faint wash or a scrollbar thumb tints with this rather
  // than hard-coding white, which vanishes on a light plane.
  root.setProperty(
    "--kr-contrast-rgb",
    theme.appearance === "light" ? "0, 0, 0" : "255, 255, 255"
  );
  // Native controls, scrollbars and form fills follow this.
  root.colorScheme = theme.appearance;

  // Motion is theme-independent: publish the same constants every call so the
  // seam owns the values (harmless to re-set on a theme switch).
  root.setProperty("--kr-motion-panel", MOTION.panel);
  root.setProperty("--kr-motion-disclose", MOTION.disclose);
  root.setProperty("--kr-motion-hover", MOTION.hover);
}
