import type { ITheme } from "@xterm/xterm";
import type { Theme } from "./themes/index.ts";

const HEX_CHANNELS = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** The accent hex at a fixed alpha, resolved concretely for canvas use. */
function accentAt(theme: Theme, alpha: number): string {
  const match = HEX_CHANNELS.exec(theme.colors.accent);
  if (!match) {
    // Themes are validated to hex accents; degrade to the raw value.
    return theme.colors.accent;
  }
  const [r, g, b] = match
    .slice(1)
    .map((channel) => Number.parseInt(channel, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The xterm color theme for an app theme. xterm paints to a canvas, so it
 * needs concrete values — CSS custom properties never resolve here. ANSI
 * colors stay at xterm's defaults: the terminal is Claude Code's surface and
 * its own colors should not be re-interpreted per app theme.
 */
export function terminalTheme(theme: Theme): ITheme {
  return {
    background: theme.colors.chromeContent,
    cursor: theme.colors.accentBright,
    cursorAccent: theme.colors.chromeContent,
    foreground: theme.colors.inkPrimary,
    selectionBackground: accentAt(theme, 0.3),
  };
}
