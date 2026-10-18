import { blue } from "./blue.ts";
import { graphite } from "./graphite.ts";
import { indigo } from "./indigo.ts";
import { steel } from "./steel.ts";
import { teal } from "./teal.ts";
import type { Theme } from "./types.ts";

export type { Theme, ThemeColors } from "./types.ts";

/** Every shipped theme, in switcher display order. */
export const THEMES: readonly Theme[] = [steel, indigo, blue, teal, graphite];

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
