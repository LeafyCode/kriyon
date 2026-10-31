import { darkChrome } from "./base.ts";
import type { Theme } from "./types.ts";

/** Design option 3b — brighter cool blue, classic dev-tool energy. */
export const blue: Theme = {
  id: "blue",
  label: "Cool blue",
  appearance: "dark",
  colors: {
    ...darkChrome,
    accent: "#3D7BF5",
    accentBright: "#5D93F8",
    accentHover: "#4E88F7",
    accentInk: "#82ABF9",
    onAccent: "#EFF5FF",
  },
};
