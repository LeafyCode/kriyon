import { darkChrome } from "./base.ts";
import type { Theme } from "./types.ts";

/** Design option 3c — the original Kriyon teal, cooled and desaturated. */
export const teal: Theme = {
  id: "teal",
  label: "Teal",
  appearance: "dark",
  colors: {
    ...darkChrome,
    accent: "#2BA391",
    accentBright: "#3FC2AE",
    accentHover: "#34B4A1",
    accentInk: "#52C7B4",
    // The plane colour, not white: white on this teal is only 2.9:1.
    onAccent: "#0d1017",
  },
};
