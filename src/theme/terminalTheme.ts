import type { ITheme } from "@xterm/xterm";
import { hexAlpha } from "./hex.ts";
import type { Theme } from "./themes/index.ts";

/**
 * The xterm color theme for an app theme. xterm paints to a canvas, so it
 * needs concrete values — CSS custom properties never resolve here.
 *
 * ANSI colours come from the theme's own `terminal` palette when it has one
 * (every community and light theme does: xterm's default white is invisible on
 * a light plane). The Steel family has none and keeps xterm's defaults.
 */
export function terminalTheme(theme: Theme): ITheme {
  return {
    ...theme.terminal,
    background: theme.colors.chromeContent,
    cursor: theme.colors.accentBright,
    cursorAccent: theme.colors.chromeContent,
    foreground: theme.colors.inkPrimary,
    selectionBackground: hexAlpha(theme.colors.accent, 0.3),
  };
}
