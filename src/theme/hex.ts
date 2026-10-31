const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/**
 * Parse `#rrggbb` into a `"r, g, b"` triplet for rgba() composition. Throws on
 * anything else: every caller feeds it a theme value, and a theme with a
 * malformed colour is a bug to surface, not a value to guess at.
 */
export function hexTriplet(hex: string): string {
  const match = HEX_COLOR.exec(hex);
  if (!match) {
    throw new Error(`expected a 6-digit hex color, got "${hex}"`);
  }
  const [, r, g, b] = match;
  return [r, g, b].map((channel) => Number.parseInt(channel, 16)).join(", ");
}

/** A 6-digit hex colour at `alpha`, as `rgba(r, g, b, alpha)`. */
export function hexAlpha(hex: string, alpha: number): string {
  return `rgba(${hexTriplet(hex)}, ${alpha})`;
}
