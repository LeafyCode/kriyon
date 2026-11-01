import { blue } from "./blue.ts";
import { catppuccinLatte } from "./catppuccinLatte.ts";
import { catppuccinMocha } from "./catppuccinMocha.ts";
import { dracula } from "./dracula.ts";
import { graphite } from "./graphite.ts";
import { gruvboxDark } from "./gruvboxDark.ts";
import { indigo } from "./indigo.ts";
import { nord } from "./nord.ts";
import { oneDark } from "./oneDark.ts";
import { rosePine } from "./rosePine.ts";
import { solarizedLight } from "./solarizedLight.ts";
import { steel } from "./steel.ts";
import { steelLight } from "./steelLight.ts";
import { teal } from "./teal.ts";
import { tokyoNight } from "./tokyoNight.ts";
import type { Theme } from "./types.ts";

export type { TerminalPalette, Theme, ThemeColors } from "./types.ts";

/** Kriyon's own themes: the Steel family, then its light side. */
export const KRIYON_THEMES: readonly Theme[] = [
  steel,
  steelLight,
  indigo,
  blue,
  teal,
  graphite,
];

/** Well-known community palettes, alphabetically. */
export const COMMUNITY_THEMES: readonly Theme[] = [
  catppuccinMocha,
  catppuccinLatte,
  dracula,
  gruvboxDark,
  nord,
  oneDark,
  rosePine,
  solarizedLight,
  tokyoNight,
];

/** Every shipped theme, in switcher display order: Kriyon's own, then the
 *  community palettes. */
export const THEMES: readonly Theme[] = [...KRIYON_THEMES, ...COMMUNITY_THEMES];

export const DEFAULT_THEME_ID = steel.id;

/**
 * Resolve a persisted theme id to a theme, falling back to the default so a
 * stale or unknown id (e.g. from a newer build) can never break startup.
 *
 * Note what this does *not* do: someone who explicitly picked Indigo keeps
 * Indigo when the default moves to Steel, because their id still resolves.
 * Only an absent or unrecognised id lands on the new default.
 */
export function themeById(id: string | undefined): Theme {
  return THEMES.find((theme) => theme.id === id) ?? steel;
}
