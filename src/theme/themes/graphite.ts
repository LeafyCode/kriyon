import { darkChrome } from "./base.ts";
import type { Theme } from "./types.ts";

/** Design option 3d — no hue at all; the accent is white, ultra-restrained. */
export const graphite: Theme = {
  id: "graphite",
  label: "Graphite",
  colors: {
    ...darkChrome,
    accent: "#C8CAD0",
    accentBright: "#E6E7EB",
    accentHover: "#D9DBE1",
    accentInk: "#C8CAD0",
    onAccent: "#0d1017",
  },
};
