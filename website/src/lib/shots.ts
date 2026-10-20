import manifest from "./shots.generated.json" with { type: "json" };

export type ShotName = keyof typeof manifest;

interface ShotSource {
  /** Intrinsic ratio of the capture — set on the `<img>` to hold CLS at 0. */
  height: number;
  /** Fallback for browsers that ignore `srcSet`; the mid rung, never the 4K. */
  src: string;
  srcSet: string;
  width: number;
}

/** Rung used as the `src` fallback, and as the film's fixed-stage source. */
const FALLBACK_WIDTH = 1280;

function nearest(widths: readonly number[], target: number): number {
  return widths.find((w) => w >= target) ?? (widths.at(-1) as number);
}

/**
 * The `<img>` attributes for one app capture.
 *
 * `sizes` has to be supplied per usage — only the caller knows how wide the
 * image lands at each breakpoint, and a wrong `sizes` is worse than none: it
 * silently picks the wrong rung on every viewport.
 */
export function shot(name: ShotName): ShotSource {
  const { widths, intrinsicWidth, intrinsicHeight } = manifest[name];
  return {
    src: `/shots/${name}-${nearest(widths, FALLBACK_WIDTH)}.webp`,
    srcSet: widths.map((w) => `/shots/${name}-${w}.webp ${w}w`).join(", "),
    width: intrinsicWidth,
    height: intrinsicHeight,
  };
}

/**
 * A single fixed-width rung, for the film — its 1920x1080 stage is a coordinate
 * system scaled by CSS, so the browser cannot pick a rung from a `sizes` hint.
 */
export function shotAt(name: ShotName, width: number): string {
  return `/shots/${name}-${nearest(manifest[name].widths, width)}.webp`;
}
