/**
 * Per-project identity colors. Eight muted hues tuned for the dark chrome —
 * similar saturation and lightness so no project shouts, all clearly apart
 * from the teal accent (which stays reserved for selection/running).
 */
export const PROJECT_PALETTE = [
  "#7fb3e6", // blue
  "#a293e8", // violet
  "#e096c8", // pink
  "#e8a06a", // orange
  "#d9c06a", // gold
  "#8fce9a", // green
  "#6ec6c9", // cyan
  "#c9a2e8", // lavender
] as const;

/** Human names per palette hue — spoken UI (aria) must not read hex codes. */
export const PROJECT_PALETTE_NAMES: Record<
  (typeof PROJECT_PALETTE)[number],
  string
> = {
  "#7fb3e6": "blue",
  "#a293e8": "violet",
  "#e096c8": "pink",
  "#e8a06a": "orange",
  "#d9c06a": "gold",
  "#8fce9a": "green",
  "#6ec6c9": "cyan",
  "#c9a2e8": "lavender",
};

/** djb2-style rolling hash — cheap, stable across sessions and platforms. */
function hash(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 33 + id.charCodeAt(i)) % 4_294_967_296;
  }
  return h;
}

/**
 * The identity color for a project: its explicit color when set, otherwise a
 * palette hue picked deterministically from its id, so a project keeps its
 * color forever without persisting an assignment.
 */
export function projectColor(project: {
  color: string | null;
  id: string;
}): string {
  return (
    project.color ?? PROJECT_PALETTE[hash(project.id) % PROJECT_PALETTE.length]
  );
}
