import { darkChrome } from "./base.ts";
import type { Theme } from "./types.ts";

/** Design option 3c — the original Kriyon teal, cooled and desaturated. */
export const teal: Theme = {
  id: "teal",
  label: "Teal",
  colors: {
    ...darkChrome,
    accent: "#2BA391",
    accentBright: "#3FC2AE",
    accentHover: "#34B4A1",
    accentInk: "#52C7B4",
    onAccent: "#EAFBF7",
  },
};
