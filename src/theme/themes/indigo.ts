import { darkChrome } from "./base.ts";
import type { Theme } from "./types.ts";

/** Design option 3a — calm, product-grade indigo (the default). */
export const indigo: Theme = {
  id: "indigo",
  label: "Indigo",
  appearance: "dark",
  colors: {
    ...darkChrome,
    accent: "#5E6AD2",
    accentBright: "#7B85E0",
    accentHover: "#6E7AD8",
    accentInk: "#9BA2F0",
    onAccent: "#F2F3FF",
  },
};
